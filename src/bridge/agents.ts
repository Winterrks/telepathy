import fs from 'node:fs';
import path from 'node:path';
import type { Party } from '../core/messages.ts';
import { ensureDir, readJson, writeJsonAtomic } from '../core/paths.ts';
import { listPeers } from '../core/peers.ts';
import { procStart } from '../core/proc.ts';
import { claimEvent, endLease, leaseTask, type TaskEvent } from '../agent/task.ts';
import {
  type AgentEntry,
  type AgentSpec,
  type AgentState,
  hostAlive,
  listAgents,
  PERMISSION_ID,
  permissionAnswerFile,
  permissionRequestFile,
  readState,
  transcriptFile,
} from '../agent/spec.ts';
import { launchAgent, openPermission, type StartArgs, stopAgentEntry } from '../agent/tools.ts';
import { bridgeDir } from './state.ts';

/**
 * `start_agent` for a session on another device: that device's request comes to this bridge on `/v1/agents`,
 * authenticated like any other, and the agent runs here as one this device's user started. Only a device this
 * device's user allowed (`telepathy bridge allow-agents <device>`) may start one: trusting a device lets it put
 * messages into sessions that are already running, not start programs.
 *
 * The agent's reports and permission requests go back to its parent over `/v1/send`. While the parent follows
 * it as an MCP task, the parent's server polls here; each poll renews the task's lease (see src/agent/task.ts)
 * and takes the next report or permission request.
 */

const allowFile = () => path.join(bridgeDir(), 'agents-allowed.json');

export type AgentsAllowed = Record<string, { name: string; at: string }>;

export const agentsAllowed = (): AgentsAllowed => readJson<AgentsAllowed>(allowFile()) ?? {};

export function setAgentsAllowed(id: string, name: string, allow: boolean): void {
  const all = agentsAllowed();
  if (allow) all[id] = { name, at: new Date().toISOString() };
  else delete all[id];
  ensureDir(bridgeDir());
  writeJsonAtomic(allowFile(), all);
}

/** What one device asks of this one about agents. `from` is the session asking, as its own device names it. */
export type AgentRequest =
  | {
      op: 'start';
      args: StartArgs;
      /** The caller's own folder, used when it exists here too. */
      cwd?: string;
      /** The caller follows it as an MCP task: open one from the start, until that task's own polls take over. */
      leaseMs?: number;
    }
  | { op: 'poll'; address: string; /** The MCP task following it: renews its lease and takes the next event. */ task?: string; leaseMs?: number; close?: boolean }
  | { op: 'answer'; address: string; request: string; allow: boolean }
  | { op: 'stop'; address: string };

/** One agent as the device that started it sees it. Paths are on this device. */
export interface AgentInfo {
  harness: AgentSpec['harness'];
  slug: string;
  address: string;
  description: string;
  cwd: string;
  createdAt: string;
  worktree?: AgentSpec['worktree'];
  transcript: string;
  log: string;
  state?: AgentState;
  alive: boolean;
  /** The permission request still waiting for an answer, if any. */
  permission?: string;
}

export type AgentReply = { ok: true; agent: AgentInfo; event?: TaskEvent; text?: string } | { ok: false; error: string };

const info = (entry: AgentEntry): AgentInfo => {
  const state = readState(entry.dir);
  return {
    harness: entry.spec.harness,
    slug: entry.spec.slug,
    address: state?.address ?? `${entry.spec.harness}:${entry.spec.slug}`,
    description: entry.spec.description,
    cwd: entry.spec.cwd,
    createdAt: entry.spec.createdAt,
    worktree: entry.spec.worktree,
    transcript: transcriptFile(entry.dir),
    log: path.join(entry.dir, 'host.log'),
    state,
    alive: hostAlive(state),
    permission: openPermission(entry.dir)?.id,
  };
};

const ownStart = procStart(process.pid);
const LEASE_MIN_MS = 5_000;
const LEASE_MAX_MS = 120_000;
const leaseFor = (ms: unknown) => Math.max(LEASE_MIN_MS, Math.min(LEASE_MAX_MS, Number(ms) || 30_000));
/** The lease a start opens for the task the caller is about to follow, named before that task has an id. */
const START_LEASE = 'start';

/**
 * One request from device `device`. `from` is the asking session as that device names it, already checked;
 * `slug` is what this device calls that device, which goes on the parent's id and address here.
 */
export async function serveAgentRequest(
  device: { id: string; slug: string; name: string },
  here: string,
  from: Party,
  request: AgentRequest,
): Promise<AgentReply> {
  if (!Object.hasOwn(agentsAllowed(), device.id)) {
    return {
      ok: false,
      error: `${here} does not let ${device.name} start agents. To allow it, run \`telepathy bridge allow-agents ${device.slug}\` on ${here}.`,
    };
  }
  const parent: Party = { ...from, id: `${from.id}@${device.slug}`, address: `${from.address}@${device.slug}` };

  if (request.op === 'start') {
    const args = request.args;
    if (!args || typeof args !== 'object' || typeof args.harness !== 'string' || typeof args.prompt !== 'string' || typeof args.description !== 'string') {
      return { ok: false, error: 'Not started: malformed request.' };
    }
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : typeof request.cwd === 'string' && isDir(request.cwd) ? request.cwd : undefined;
    if (!cwd || !isDir(cwd)) {
      const folders = [...new Set(listPeers().map((p) => p.cwd).filter((c): c is string => !!c))].slice(0, 5);
      return {
        ok: false,
        error:
          `Not started: ${cwd ? `${cwd} is not a folder on ${here}` : `${request.cwd ?? 'your folder'} is not a folder on ${here}`}. ` +
          `Pass cwd, a folder on ${here}.${folders.length ? ` Sessions there work in: ${folders.join(', ')}.` : ''}`,
      };
    }
    const launched = launchAgent({ party: parent, remote: { device: device.id, parentId: from.id } }, { ...args, cwd });
    if (!launched.ok) return { ok: false, error: launched.text };
    // A quick agent can report before the task's first poll arrives.
    if (request.leaseMs) leaseTask(launched.dir, START_LEASE, ownStart, leaseFor(request.leaseMs));
    return { ok: true, agent: info({ dir: launched.dir, spec: launched.spec }) };
  }

  const entry = findFor(device.id, from.id, (request as { address?: unknown }).address);
  if (!entry) return { ok: false, error: `No agent named "${String((request as { address?: unknown }).address)}" was started on ${here} by this session.` };

  if (request.op === 'poll') {
    if (typeof request.task === 'string' && request.task) {
      if (request.close) {
        endLease(entry.dir, request.task);
        endLease(entry.dir, START_LEASE);
        return { ok: true, agent: info(entry) };
      }
      leaseTask(entry.dir, request.task, ownStart, leaseFor(request.leaseMs));
      endLease(entry.dir, START_LEASE);
      const event = claimEvent(entry.dir);
      return { ok: true, agent: info(entry), ...(event ? { event } : {}) };
    }
    return { ok: true, agent: info(entry) };
  }

  if (request.op === 'answer') {
    if (typeof request.request !== 'string' || !PERMISSION_ID.test(request.request)) return { ok: false, error: `"${request.request}" is not a permission request id.` };
    if (!fs.existsSync(permissionRequestFile(entry.dir, request.request))) return { ok: false, error: `It has no permission request "${request.request}".` };
    const answer = permissionAnswerFile(entry.dir, request.request);
    if (fs.existsSync(answer)) return { ok: false, error: `Request "${request.request}" was already answered.` };
    if (!hostAlive(readState(entry.dir))) return { ok: false, error: 'It is no longer running.' };
    writeJsonAtomic(answer, { allow: request.allow === true, at: new Date().toISOString() });
    return { ok: true, agent: info(entry) };
  }

  if (request.op === 'stop') {
    const wasRunning = hostAlive(readState(entry.dir));
    if (wasRunning) await stopAgentEntry(entry, 12_000);
    return { ok: true, agent: info(entry), text: wasRunning ? 'stopped' : 'not running' };
  }
  return { ok: false, error: 'malformed request' };
}

function isDir(dir: string): boolean {
  try {
    return path.isAbsolute(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The newest agent that session of that device started here, by address, `harness:slug`, slug or ref. */
function findFor(device: string, parentId: string, name: unknown): AgentEntry | undefined {
  if (typeof name !== 'string' || !name) return undefined;
  const q = name.trim().toLowerCase();
  return listAgents()
    .filter((entry) => entry.spec.remote?.device === device && entry.spec.remote.parentId === parentId)
    .filter((entry) =>
      [entry.spec.slug, `${entry.spec.harness}:${entry.spec.slug}`, entry.state?.address, entry.state?.peerId].some((key) => key?.toLowerCase() === q),
    )
    .sort((a, b) => b.spec.createdAt.localeCompare(a.spec.createdAt))[0];
}
