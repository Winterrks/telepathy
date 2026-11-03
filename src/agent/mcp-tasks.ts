import fs from 'node:fs';
import path from 'node:path';
import { agentLabel } from '../core/agents.ts';
import { sendMessage } from '../core/deliver.ts';
import { writeJsonAtomic } from '../core/paths.ts';
import type { Peer } from '../core/peers.ts';
import { claimEvent, openTask } from './task.ts';
import { type AgentEntry, hostAlive, permissionAnswerFile, readState, transcriptFile } from './spec.ts';
import { agentAddress, findChild, launchAgent, type StartArgs, startWaitMs, stopAgentEntry } from './tools.ts';

/**
 * The server half of start_agent as an MCP task (see src/agent/task.ts): the tasks this server answered tool calls
 * with, and the `tasks/get`, `tasks/update` and `tasks/cancel` requests Claude Code follows them with.
 */

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const POLL_MS = 2_000;

/** The request's 2026-07-28 envelope says the client takes a task for it. */
export function clientTakesTasks(ctx: unknown): boolean {
  const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq?.envelope;
  const capabilities = envelope?.['io.modelcontextprotocol/clientCapabilities'] as { extensions?: Record<string, unknown> } | undefined;
  return !!capabilities?.extensions?.[TASKS_EXTENSION];
}

type Status = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

interface AgentTask {
  taskId: string;
  entry: AgentEntry;
  status: Status;
  statusMessage: string;
  createdAt: string;
  lastUpdatedAt: string;
  result?: { content: { type: 'text'; text: string }[] };
  error?: { code: number; message: string };
  inputRequests?: Record<string, { method: string; params: unknown }>;
  /** The permission request `inputRequests` asks about. */
  request?: string;
  close: () => void;
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

function createTask(entry: AgentEntry, taskId: string, statusMessage: string, procStart: string | undefined): AgentTask {
  let id = taskId;
  for (let n = 2; tasks.has(id); n++) id = `${taskId}#${n}`;
  const task: AgentTask = {
    taskId: id,
    entry,
    status: 'working',
    statusMessage,
    createdAt: stamp(),
    lastUpdatedAt: stamp(),
    close: openTask(entry.dir, id, procStart),
  };
  tasks.set(id, task);
  return task;
}

function settle(task: AgentTask, status: Status, fields: Partial<AgentTask> = {}): void {
  Object.assign(task, { status, lastUpdatedAt: stamp(), inputRequests: undefined, request: undefined }, fields);
  task.close();
}

const ALLOW_SCHEMA = {
  type: 'object',
  properties: { allow: { type: 'boolean', title: 'Allow', description: 'Let the agent go ahead' } },
  required: ['allow'],
};

/** Brings a task up to date with its agent: a report, a permission request, or the agent gone. */
function refresh(task: AgentTask): void {
  if (terminal(task.status)) return;
  const { dir, spec } = task.entry;
  const label = agentLabel(spec.harness);
  const address = agentAddress(task.entry);
  if (task.status === 'input_required') {
    // Answered outside the dialog (answer_permission), or timed out on the host's side: the agent moves on.
    if (!task.request || !fs.existsSync(permissionAnswerFile(dir, task.request))) return;
    Object.assign(task, { status: 'working', inputRequests: undefined, request: undefined, lastUpdatedAt: stamp() });
  }
  const event = claimEvent(dir);
  if (event?.kind === 'result') {
    const text = `${event.body}\n\n(${label} agent ${address}; transcript: ${transcriptFile(dir)})`;
    settle(task, 'completed', { result: { content: [{ type: 'text', text }] }, statusMessage: `${address} reported.` });
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
  const state = readState(dir);
  if (state?.status === 'failed') {
    settle(task, 'failed', { error: { code: -32000, message: `${label} did not start: ${state.error ?? 'it failed to start'}`.replace(/\.$/, '') } });
    return;
  }
  if (state && !hostAlive(state)) {
    if (state.status === 'starting') settle(task, 'failed', { error: { code: -32000, message: `${label} did not start. See ${path.join(dir, 'host.log')}` } });
    else settle(task, 'cancelled', { statusMessage: `${address} has stopped. Transcript: ${transcriptFile(dir)}` });
    return;
  }
  if ((!state || state.status === 'starting') && Date.now() > Date.parse(spec.createdAt) + startWaitMs() + 5_000) {
    void stopAgentEntry(task.entry, 3_000);
    settle(task, 'failed', { error: { code: -32000, message: `${label} did not get ready within ${Math.round(startWaitMs() / 1000)}s. See ${path.join(dir, 'host.log')}` } });
    return;
  }
  const working = state?.status === 'ready' ? `${label} is working: ${spec.description}` : `${label} is starting: ${spec.description}`;
  if (working !== task.statusMessage) Object.assign(task, { statusMessage: working, lastUpdatedAt: stamp() });
}

/** start_agent for a client that takes tasks: the agent starts, and its first report is the task's result. */
export function startAgentTask(self: Peer, args: StartArgs, procStart: string | undefined): TaskAnswer | { text: string; isError: true } {
  const launched = launchAgent(self, args);
  if (!launched.ok) return { text: launched.text, isError: true };
  const task = createTask({ dir: launched.dir, spec: launched.spec }, launched.address, `${agentLabel(launched.spec.harness)} is starting: ${args.description}`, procStart);
  return { resultType: 'task', ...wire(task) };
}

/**
 * send_message to an agent this session started, from a client that takes tasks: the message is delivered as
 * send_message delivers it, and the agent's next report is the task's result. Undefined when the address is not
 * such an agent, so the caller sends it the ordinary way.
 */
export async function continueAgentTask(self: Peer, to: string, message: string, procStart: string | undefined): Promise<TaskAnswer | { text: string; isError: true } | undefined> {
  const found = findChild(self, to);
  if ('error' in found || !hostAlive(readState(found.dir)) || readState(found.dir)?.status !== 'ready') return undefined;
  const address = agentAddress(found);
  // Open before sending: a quick agent can report before the delivery confirm returns.
  const task = createTask(found, address, `${agentLabel(found.spec.harness)} is working on your message`, procStart);
  const sent = await sendMessage(self, address, message);
  if (!sent.ok) {
    tasks.delete(task.taskId);
    task.close();
    return { text: `Not delivered to ${address}: ${sent.error}`, isError: true };
  }
  return { resultType: 'task', ...wire(task) };
}

export interface TaskReply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * A task this server didn't create: Claude Code keeps following its tasks when the server restarts under it
 * (`/reload-plugins`, `/mcp` reconnect). The task id names the agent, so the new server takes it up again when
 * that is an agent this session started.
 */
function adopt(self: Peer, taskId: string, procStart: string | undefined): AgentTask | undefined {
  const found = findChild(self, taskId.replace(/#\d+$/, ''));
  if ('error' in found) return undefined;
  const task: AgentTask = {
    taskId,
    entry: found,
    status: 'working',
    statusMessage: `${agentLabel(found.spec.harness)} is working: ${found.spec.description}`,
    createdAt: stamp(),
    lastUpdatedAt: stamp(),
    close: openTask(found.dir, taskId, procStart),
  };
  tasks.set(taskId, task);
  return task;
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
      writeJsonAtomic(permissionAnswerFile(task.entry.dir, key), { allow, at: stamp() });
      Object.assign(task, { status: 'working', inputRequests: undefined, request: undefined, lastUpdatedAt: stamp() });
    }
    return { result: { resultType: 'complete' } };
  }
  if (method === 'tasks/cancel') {
    if (!terminal(task.status)) {
      void stopAgentEntry(task.entry, 0);
      settle(task, 'cancelled', { statusMessage: `Stopped ${agentAddress(task.entry)}.` });
    }
    return { result: { resultType: 'complete' } };
  }
  refresh(task);
  return { result: { resultType: 'complete', ...wire(task) } };
}
