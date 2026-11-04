import fs from 'node:fs';
import path from 'node:path';
import { agentLabel } from '../core/agents.ts';
import { partyOf } from '../core/messages.ts';
import { ensureDir, readJson, stateDir, writeJsonAtomic } from '../core/paths.ts';
import type { Peer } from '../core/peers.ts';
import type { ToolResult } from '../core/tools.ts';
import { VERSION } from '../core/version.ts';
import type { AgentInfo, AgentReply, AgentRequest } from '../bridge/agents.ts';
import { call } from '../bridge/client.ts';
import { findDevice, remoteTarget } from '../bridge/remote.ts';
import { isOnline, knownDevices, type RemoteDevice } from '../bridge/state.ts';
import { type StartArgs, startedText, startWaitMs } from './tools.ts';

/**
 * start_agent on another device: the request goes to that device's bridge (src/bridge/agents.ts), which starts
 * the agent there. Its reports come back here as messages over the bridge, or, in Claude Code's terminal, as the
 * MCP task this session's server follows by polling that bridge (src/agent/mcp-tasks.ts).
 */

/** The answer to a request, or why it got none: `reached` is false when the request never got an answer there. */
export type Answer = AgentReply | { ok: false; error: string; reached: false };

/** A device a start_agent `device` names, online and able to take the request. */
export function agentDevice(name: string): RemoteDevice | { error: string } {
  const device = findDevice(name.trim().toLowerCase());
  if (!device) {
    const known = knownDevices().filter((d) => d.trusted).map((d) => d.slug);
    return { error: `Not started: no device named "${name}". ${known.length ? `Your devices: ${known.join(', ')}.` : 'Start the telepathy bridge on both devices first.'}` };
  }
  if (!isOnline(device)) return { error: `Not started: device ${device.slug} is offline (its telepathy bridge is not answering).` };
  if (device.incompatible) return { error: `Not started: device ${device.slug} runs telepathy ${device.version ?? '?'}, which can't talk to this one (${VERSION}).` };
  return device;
}

/** One request to that device's bridge about agents, as `self`. */
export async function agentsRequest(device: RemoteDevice, self: Peer, request: AgentRequest, timeoutMs = 15_000): Promise<Answer> {
  try {
    const reply = await call<AgentReply>(device, '/v1/agents', { from: partyOf(self), ...request }, timeoutMs);
    if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') return { ok: false, error: `device ${device.slug} sent a malformed answer`, reached: false };
    return reply;
  } catch (err) {
    const message = (err as Error).message;
    // A bridge from before 0.13.0 has no /v1/agents.
    if (message === 'not found') {
      return { ok: false, error: `device ${device.slug} runs telepathy ${device.version ?? 'older than 0.13.0'}, which can't start agents for another device. Update it with \`telepathy update\` there.` };
    }
    const why = (err as Error).name === 'TimeoutError' ? 'it did not answer in time' : message;
    return { ok: false, error: `device ${device.slug} did not answer (${why})`, reached: false };
  }
}

/** An agent this device's sessions started on another device, so stop_agent, answer_permission and a reload find it. */
export interface RemoteChild {
  device: string;
  /** The agent's address there, without `@<device>`. */
  address: string;
  harness: AgentInfo['harness'];
  slug: string;
  description: string;
  parentId: string;
  createdAt: string;
}

const childrenDir = () => path.join(stateDir(), 'agents-elsewhere');
const childFile = (child: Pick<RemoteChild, 'parentId' | 'device' | 'harness' | 'slug'>) =>
  path.join(childrenDir(), `${child.parentId}--${child.device}--${child.harness}-${child.slug}.json`.replace(/[^\w.@-]/g, '_'));

export function rememberChild(self: Peer, device: RemoteDevice, agent: AgentInfo): RemoteChild {
  const child: RemoteChild = {
    device: device.id,
    address: `${agent.harness}:${agent.slug}`,
    harness: agent.harness,
    slug: agent.slug,
    description: agent.description,
    parentId: self.id,
    createdAt: agent.createdAt,
  };
  ensureDir(childrenDir());
  writeJsonAtomic(childFile(child), child);
  return child;
}

/** What this device calls the child's device now. */
export const childAddress = (child: RemoteChild) => `${child.address}@${findDevice(child.device)?.slug ?? child.device}`;

/**
 * The agent `name` names among those `self` started on other devices: `opencode:api@laptop`, or `opencode:api`
 * and `api` alone when only one matches. The newest wins.
 */
export function findRemoteChild(self: Peer, name: string): RemoteChild | undefined {
  let q = name.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase();
  const target = remoteTarget(q);
  const device = target ? findDevice(target.slug) : undefined;
  if (target && device) q = target.query;
  let names: string[];
  try {
    names = fs.readdirSync(childrenDir());
  } catch {
    return undefined;
  }
  return names
    .map((file) => readJson<RemoteChild>(path.join(childrenDir(), file)))
    .filter((child): child is RemoteChild => !!child && child.parentId === self.id && (!device || child.device === device.id))
    .filter((child) => [child.address, child.slug].some((key) => key.toLowerCase() === q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

const failed = (text: string): ToolResult => ({ text, isError: true });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks the device to start the agent. It answers once the host is spawned, before the agent is ready. */
export async function launchRemoteAgent(
  self: Peer,
  deviceName: string,
  args: StartArgs,
  /** Set when the caller follows it as an MCP task: the task is open there from the start. */
  leaseMs?: number,
): Promise<{ ok: true; device: RemoteDevice; agent: AgentInfo; child: RemoteChild } | { ok: false; text: string }> {
  const device = agentDevice(deviceName);
  if ('error' in device) return { ok: false, text: device.error };
  const { device: _ignored, ...rest } = args as StartArgs & { device?: string };
  const reply = await agentsRequest(device, self, { op: 'start', args: rest, cwd: self.cwd, ...(leaseMs ? { leaseMs } : {}) }, 20_000);
  if (!reply.ok) return { ok: false, text: reply.error.startsWith('Not started') ? reply.error : `Not started: ${reply.error.replace(/\.$/, '')}.` };
  return { ok: true, device, agent: reply.agent, child: rememberChild(self, device, reply.agent) };
}

/** start_agent on another device, outside an MCP task: waits until the agent there is ready. */
export async function startRemoteAgentTool(self: Peer, deviceName: string, args: StartArgs): Promise<ToolResult> {
  const launched = await launchRemoteAgent(self, deviceName, args);
  if (!launched.ok) return failed(launched.text);
  const { device, child } = launched;
  let agent = launched.agent;
  const address = childAddress(child);
  const deadline = Date.now() + startWaitMs() + 5_000;
  while (Date.now() < deadline) {
    const state = agent.state;
    if (state?.status === 'failed') return failed(`Not started: ${agentLabel(agent.harness)} ${state.error ?? 'failed to start'} on ${device.slug}.`);
    if (state?.status === 'ready' && state.peerId) {
      return {
        text: startedText(agent, state, {
          address,
          ref: `${state.peerId}@${device.slug}`,
          transcript: `${agent.transcript} on ${device.slug}`,
          on: device.slug,
        }),
      };
    }
    if (state && !agent.alive) break;
    await sleep(500);
    const reply = await agentsRequest(device, self, { op: 'poll', address: child.address });
    if (reply.ok) agent = reply.agent;
  }
  await agentsRequest(device, self, { op: 'stop', address: child.address }, 20_000);
  return failed(`Not started: ${agentLabel(agent.harness)} did not get ready on ${device.slug}. See ${agent.log} on ${device.slug}.`);
}

export async function stopRemoteAgentTool(self: Peer, child: RemoteChild): Promise<ToolResult> {
  const address = childAddress(child);
  const device = agentDevice(child.device);
  if ('error' in device) return failed(device.error.replace(/^Not started: /, `Not stopped: `));
  const reply = await agentsRequest(device, self, { op: 'stop', address: child.address }, 20_000);
  if (!reply.ok) return failed(`Not stopped: ${reply.error.replace(/\.$/, '')}.`);
  if (reply.text === 'not running') return { text: `${address} is not running.` };
  const kept = reply.agent.state?.worktreeKept && reply.agent.worktree
    ? ` Its worktree ${reply.agent.worktree.path} (branch ${reply.agent.worktree.branch}) on ${device.slug} has changes and was kept.`
    : '';
  return { text: `Stopped ${address}. Transcript: ${reply.agent.transcript} on ${device.slug}.${kept}` };
}

export async function answerRemotePermission(self: Peer, child: RemoteChild, request: string, allow: boolean): Promise<ToolResult> {
  const device = agentDevice(child.device);
  if ('error' in device) return failed(device.error.replace(/^Not started: /, ''));
  const reply = await agentsRequest(device, self, { op: 'answer', address: child.address, request, allow });
  if (!reply.ok) return failed(reply.error);
  return { text: `${allow ? 'Allowed' : 'Denied'} request ${request} for ${childAddress(child)}.` };
}
