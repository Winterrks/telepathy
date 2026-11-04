import fs from 'node:fs';
import path from 'node:path';
import { agentLabel } from '../core/agents.ts';
import { sendMessage } from '../core/deliver.ts';
import { writeJsonAtomic } from '../core/paths.ts';
import type { Peer } from '../core/peers.ts';
import type { AgentInfo } from '../bridge/agents.ts';
import { findDevice, remoteTarget } from '../bridge/remote.ts';
import type { RemoteDevice } from '../bridge/state.ts';
import { agentsRequest, childAddress, findRemoteChild, launchRemoteAgent, type RemoteChild } from './remote.ts';
import { claimEvent, openTask, type TaskEvent } from './task.ts';
import { type AgentEntry, type AgentState, hostAlive, permissionAnswerFile, readState, transcriptFile } from './spec.ts';
import { agentAddress, findChild, launchAgent, parentOf, type StartArgs, startWaitMs, stopAgentEntry } from './tools.ts';

/**
 * The server half of start_agent as an MCP task (see src/agent/task.ts): the tasks this server answered tool calls
 * with, and the `tasks/get`, `tasks/update` and `tasks/cancel` requests Claude Code follows them with. An agent on
 * this machine is followed through its folder; one on another device through that device's bridge.
 */

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const POLL_MS = 2_000;
/** How long another device keeps a task open after this server's last poll. */
const LEASE_MS = 30_000;
/** No answer from that device for this long, and the task fails. */
const LOST_MS = 120_000;

/** The request's 2026-07-28 envelope says the client takes a task for it. */
export function clientTakesTasks(ctx: unknown): boolean {
  const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq?.envelope;
  const capabilities = envelope?.['io.modelcontextprotocol/clientCapabilities'] as { extensions?: Record<string, unknown> } | undefined;
  return !!capabilities?.extensions?.[TASKS_EXTENSION];
}

type Status = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** Where a task's agent is, and how to reach it. */
interface Source {
  label: string;
  address: () => string;
  description: string;
  createdAt: string;
  transcript: () => string;
  log: () => string;
  /** The next report or permission request, now this task's. */
  next: () => TaskEvent | undefined;
  state: () => { status?: AgentState['status']; error?: string; alive: boolean; lost?: string };
  answered: (request: string) => boolean;
  answer: (request: string, allow: boolean) => void;
  stop: () => void;
  close: () => void;
}

interface AgentTask {
  taskId: string;
  source: Source;
  status: Status;
  statusMessage: string;
  createdAt: string;
  lastUpdatedAt: string;
  result?: { content: { type: 'text'; text: string }[] };
  error?: { code: number; message: string };
  inputRequests?: Record<string, { method: string; params: unknown }>;
  /** The permission request `inputRequests` asks about. */
  request?: string;
}

const tasks = new Map<string, AgentTask>();
const terminal = (status: Status) => status === 'completed' || status === 'failed' || status === 'cancelled';
const stamp = () => new Date().toISOString();

const wire = (task: AgentTask) => ({
  taskId: task.taskId,
  status: task.status,
  statusMessage: task.statusMessage,
  createdAt: task.createdAt,
  lastUpdatedAt: task.lastUpdatedAt,
  ttlMs: null,
  pollIntervalMs: POLL_MS,
  ...(task.result ? { result: task.result } : {}),
  ...(task.error ? { error: task.error } : {}),
  ...(task.inputRequests ? { inputRequests: task.inputRequests } : {}),
});

/** A tools/call answer that hands Claude Code a task instead of a result. */
export type TaskAnswer = ReturnType<typeof wire> & { resultType: 'task' };

/** An id no task of this server has: the agent's address, then `#2`, `#3`… for its follow-ups. */
function freeId(base: string): string {
  let id = base;
  for (let n = 2; tasks.has(id); n++) id = `${base}#${n}`;
  return id;
}

function createTask(taskId: string, source: Source, statusMessage: string): AgentTask {
  const task: AgentTask = { taskId, source, status: 'working', statusMessage, createdAt: stamp(), lastUpdatedAt: stamp() };
  tasks.set(taskId, task);
  return task;
}

function settle(task: AgentTask, status: Status, fields: Partial<AgentTask> = {}): void {
  Object.assign(task, { status, lastUpdatedAt: stamp(), inputRequests: undefined, request: undefined }, fields);
  task.source.close();
}

/** An agent on this machine: its folder has the events, the state and the answers. */
function localSource(entry: AgentEntry, taskId: string, procStart: string | undefined): Source {
  const { dir, spec } = entry;
  const close = openTask(dir, taskId, procStart);
  return {
    label: agentLabel(spec.harness),
    address: () => agentAddress(entry),
    description: spec.description,
    createdAt: spec.createdAt,
    transcript: () => transcriptFile(dir),
    log: () => path.join(dir, 'host.log'),
    next: () => claimEvent(dir),
    state: () => {
      const state = readState(dir);
      return { status: state?.status, error: state?.error, alive: hostAlive(state) };
    },
    answered: (request) => fs.existsSync(permissionAnswerFile(dir, request)),
    answer: (request, allow) => writeJsonAtomic(permissionAnswerFile(dir, request), { allow, at: stamp() }),
    stop: () => void stopAgentEntry(entry, 0),
    close,
  };
}

/**
 * An agent on another device: a poll of that device's bridge every couple of seconds keeps the task open there
 * and brings back its state and the next event. `tasks/get` answers from the last poll.
 */
function remoteSource(self: Peer, device: RemoteDevice, child: RemoteChild, taskId: string, agent?: AgentInfo): Source {
  const events: TaskEvent[] = [];
  let last = agent;
  let lastAnswer = Date.now();
  let lost: string | undefined;
  let closed = false;
  let inflight = false;
  const poll = async () => {
    if (closed || inflight) return;
    inflight = true;
    try {
      const reply = await agentsRequest(device, self, { op: 'poll', address: child.address, task: taskId, leaseMs: LEASE_MS }, 10_000);
      if (closed) return;
      if (reply.ok) {
        last = reply.agent;
        lastAnswer = Date.now();
        if (reply.event) events.push(reply.event);
      } else if (!('reached' in reply)) {
        lost = `${childAddress(child)}: ${reply.error}`;
      } else if (Date.now() - lastAnswer > LOST_MS) {
        lost = `Lost touch with ${childAddress(child)}: ${reply.error} for ${Math.round(LOST_MS / 60_000)} minutes. It stops by itself if this device stays out of its reach.`;
      }
    } finally {
      inflight = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), POLL_MS);
  timer.unref();
  const on = ` on ${device.slug}`;
  return {
    label: agentLabel(child.harness),
    address: () => childAddress(child),
    description: child.description,
    createdAt: child.createdAt,
    transcript: () => `${last?.transcript ?? 'its transcript'}${on}`,
    log: () => `${last?.log ?? 'its host.log'}${on}`,
    next: () => events.shift(),
    state: () => ({ status: last?.state?.status, error: last?.state?.error, alive: last?.alive ?? false, lost }),
    answered: (request) => !!last && last.permission !== request,
    answer: (request, allow) => {
      // The next poll shows the request answered; until then the task stays as the answer left it.
      if (last) last = { ...last, permission: undefined };
      void agentsRequest(device, self, { op: 'answer', address: child.address, request, allow });
    },
    stop: () => void agentsRequest(device, self, { op: 'stop', address: child.address }, 20_000),
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      void agentsRequest(device, self, { op: 'poll', address: child.address, task: taskId, close: true });
    },
  };
}

const ALLOW_SCHEMA = {
  type: 'object',
  properties: { allow: { type: 'boolean', title: 'Allow', description: 'Let the agent go ahead' } },
  required: ['allow'],
};

/** Brings a task up to date with its agent: a report, a permission request, or the agent gone. */
function refresh(task: AgentTask): void {
  if (terminal(task.status)) return;
  const source = task.source;
  const { label } = source;
  if (task.status === 'input_required') {
    // Answered outside the dialog (answer_permission), or timed out on the host's side: the agent moves on.
    if (!task.request || !source.answered(task.request)) return;
    Object.assign(task, { status: 'working', inputRequests: undefined, request: undefined, lastUpdatedAt: stamp() });
  }
  const event = source.next();
  if (event?.kind === 'result') {
    const text = `${event.body}\n\n(${label} agent ${source.address()}; transcript: ${source.transcript()})`;
    settle(task, 'completed', { result: { content: [{ type: 'text', text }] }, statusMessage: `${source.address()} reported.` });
    return;
  }
  if (event?.kind === 'permission' && event.request) {
    Object.assign(task, {
      status: 'input_required',
      request: event.request,
      statusMessage: event.body,
      lastUpdatedAt: stamp(),
      inputRequests: {
        [event.request]: { method: 'elicitation/create', params: { mode: 'form', message: event.body, requestedSchema: ALLOW_SCHEMA } },
      },
    });
    return;
  }
  const state = source.state();
  if (state.lost) {
    settle(task, 'failed', { error: { code: -32000, message: state.lost } });
    return;
  }
  if (state.status === 'failed') {
    settle(task, 'failed', { error: { code: -32000, message: `${label} did not start: ${state.error ?? 'it failed to start'}`.replace(/\.$/, '') } });
    return;
  }
  if (state.status && !state.alive) {
    if (state.status === 'starting') settle(task, 'failed', { error: { code: -32000, message: `${label} did not start. See ${source.log()}` } });
    else settle(task, 'cancelled', { statusMessage: `${source.address()} has stopped. Transcript: ${source.transcript()}` });
    return;
  }
  if ((!state.status || state.status === 'starting') && Date.now() > Date.parse(source.createdAt) + startWaitMs() + 5_000) {
    source.stop();
    settle(task, 'failed', { error: { code: -32000, message: `${label} did not get ready within ${Math.round(startWaitMs() / 1000)}s. See ${source.log()}` } });
    return;
  }
  const working = state.status === 'ready' ? `${label} is working: ${source.description}` : `${label} is starting: ${source.description}`;
  if (working !== task.statusMessage) Object.assign(task, { statusMessage: working, lastUpdatedAt: stamp() });
}

type Answer = TaskAnswer | { text: string; isError: true };

/** start_agent for a client that takes tasks: the agent starts, and its first report is the task's result. */
export async function startAgentTask(self: Peer, args: StartArgs & { device?: string }, procStart: string | undefined): Promise<Answer> {
  if (args.device) {
    const launched = await launchRemoteAgent(self, args.device, args, LEASE_MS);
    if (!launched.ok) return { text: launched.text, isError: true };
    const taskId = freeId(childAddress(launched.child));
    const source = remoteSource(self, launched.device, launched.child, taskId, launched.agent);
    const task = createTask(taskId, source, `${source.label} is starting on ${launched.device.slug}: ${args.description}`);
    return { resultType: 'task', ...wire(task) };
  }
  const launched = launchAgent(parentOf(self), args);
  if (!launched.ok) return { text: launched.text, isError: true };
  const taskId = freeId(launched.address);
  const task = createTask(taskId, localSource({ dir: launched.dir, spec: launched.spec }, taskId, procStart), `${agentLabel(launched.spec.harness)} is starting: ${args.description}`);
  return { resultType: 'task', ...wire(task) };
}

/**
 * send_message to an agent this session started, from a client that takes tasks: the message is delivered as
 * send_message delivers it, and the agent's next report is the task's result. Undefined when the address is not
 * such an agent, so the caller sends it the ordinary way.
 */
export async function continueAgentTask(self: Peer, to: string, message: string, procStart: string | undefined): Promise<Answer | undefined> {
  const opened = remoteTarget(to) ? await openRemoteFollowUp(self, to) : openLocalFollowUp(self, to, procStart);
  if (!opened) return undefined;
  const { task, address } = opened;
  const sent = await sendMessage(self, address, message);
  if (!sent.ok) {
    tasks.delete(task.taskId);
    task.source.close();
    return { text: `Not delivered to ${address}: ${sent.error}`, isError: true };
  }
  return { resultType: 'task', ...wire(task) };
}

function openLocalFollowUp(self: Peer, to: string, procStart: string | undefined): { task: AgentTask; address: string } | undefined {
  const found = findChild(self, to);
  if ('error' in found || !hostAlive(readState(found.dir)) || readState(found.dir)?.status !== 'ready') return undefined;
  const address = agentAddress(found);
  // Open before sending: a quick agent can report before the delivery confirm returns.
  const taskId = freeId(address);
  const task = createTask(taskId, localSource(found, taskId, procStart), `${agentLabel(found.spec.harness)} is working on your message`);
  return { task, address };
}

async function openRemoteFollowUp(self: Peer, to: string): Promise<{ task: AgentTask; address: string } | undefined> {
  const child = findRemoteChild(self, to);
  const device = child ? findDevice(child.device) : undefined;
  if (!child || !device) return undefined;
  const taskId = freeId(childAddress(child));
  // The lease is open on that device before the message goes, as a local task's marker is.
  const first = await agentsRequest(device, self, { op: 'poll', address: child.address, task: taskId, leaseMs: LEASE_MS }, 10_000);
  if (!first.ok || !first.agent.alive || first.agent.state?.status !== 'ready') {
    if (first.ok) void agentsRequest(device, self, { op: 'poll', address: child.address, task: taskId, close: true });
    return undefined;
  }
  const task = createTask(taskId, remoteSource(self, device, child, taskId, first.agent), `${agentLabel(child.harness)} is working on your message`);
  return { task, address: childAddress(child) };
}

export interface TaskReply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * A task this server didn't create: Claude Code keeps following its tasks when the server restarts under it
 * (`/reload-plugins`, `/mcp` reconnect). The task id names the agent, so the new server takes it up again when
 * that is an agent this session started, here or on another device.
 */
function adopt(self: Peer, taskId: string, procStart: string | undefined): AgentTask | undefined {
  const base = taskId.replace(/#\d+$/, '');
  if (remoteTarget(base)) {
    const child = findRemoteChild(self, base);
    const device = child ? findDevice(child.device) : undefined;
    if (!child || !device) return undefined;
    return createTask(taskId, remoteSource(self, device, child, taskId), `${agentLabel(child.harness)} is working: ${child.description}`);
  }
  const found = findChild(self, base);
  if ('error' in found) return undefined;
  return createTask(taskId, localSource(found, taskId, procStart), `${agentLabel(found.spec.harness)} is working: ${found.spec.description}`);
}

/** Answers `tasks/get`, `tasks/update` and `tasks/cancel`; undefined for any other method. */
export function answerTaskRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  self: () => Peer,
  procStart: string | undefined,
): TaskReply | undefined {
  if (method !== 'tasks/get' && method !== 'tasks/update' && method !== 'tasks/cancel') return undefined;
  const taskId = typeof params?.taskId === 'string' ? params.taskId : undefined;
  const task = taskId ? (tasks.get(taskId) ?? adopt(self(), taskId, procStart)) : undefined;
  if (!task) return { error: { code: -32602, message: `Unknown task ${String(params?.taskId)}` } };
  if (method === 'tasks/update') {
    const responses = (params?.inputResponses ?? {}) as Record<string, unknown>;
    for (const [key, raw] of Object.entries(responses)) {
      if (key !== task.request) continue;
      const response = ((raw as { result?: unknown })?.result ?? raw) as { action?: string; content?: { allow?: unknown } };
      const allow = response?.action === 'accept' && response.content?.allow !== false;
      task.source.answer(key, allow);
      Object.assign(task, { status: 'working', inputRequests: undefined, request: undefined, lastUpdatedAt: stamp() });
    }
    return { result: { resultType: 'complete' } };
  }
  if (method === 'tasks/cancel') {
    if (!terminal(task.status)) {
      task.source.stop();
      settle(task, 'cancelled', { statusMessage: `Stopped ${task.source.address()}.` });
    }
    return { result: { resultType: 'complete' } };
  }
  refresh(task);
  return { result: { resultType: 'complete', ...wire(task) } };
}
