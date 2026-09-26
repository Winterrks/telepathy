import path from 'node:path';
import type { Agent } from './agents.ts';
import { codexActivity, codexLastResponse } from './codex-activity.ts';
import { peerDir, readJson, writeJsonAtomic } from './paths.ts';
import { claudeConfigDir, type Peer } from './peers.ts';

/**
 * What a session is doing, in Claude Code's words where they exist:
 *   busy         in the middle of a turn
 *   shell        not generating, but a shell command it started is still running (Claude Code only)
 *   idle         waiting for its user to type
 *   waiting      stopped on a permission prompt: nothing moves until its user answers it
 *   interrupted  its last turn was interrupted (Codex): it starts queued messages only after its user's next prompt
 */
export type PeerStatus = 'busy' | 'shell' | 'idle' | 'waiting' | 'interrupted';

export interface StatusInfo {
  status: PeerStatus;
  /** When the status was last set, if known. */
  at?: number;
  /** Set from the agent's hooks, which can miss the end of a turn (an interrupt often runs no hook). */
  fromHooks?: boolean;
}

interface StatusRecord {
  status: PeerStatus;
  at: string;
}

/**
 * Agents whose status comes from their own records or in-process events rather than from telepathy's hooks:
 * Claude Code's session file, Codex's rollout log (plus a hook for permission prompts), the OpenCode plugin.
 */
const OWN_SOURCE: readonly Agent[] = ['claude', 'codex', 'opencode', 'kilo'];

/** Whether telepathy's hooks keep this agent's busy/idle status, because nothing better reports it. */
export const statusFromHooks = (agent: Agent) => !OWN_SOURCE.includes(agent);

const statusFile = (id: string) => path.join(peerDir(id), 'status.json');

export function writeStatus(id: string, status: PeerStatus, now = Date.now()): void {
  writeJsonAtomic(statusFile(id), { status, at: new Date(now).toISOString() } satisfies StatusRecord);
}

function recorded(id: string): StatusInfo | undefined {
  const record = readJson<StatusRecord>(statusFile(id));
  const at = record ? Date.parse(record.at) : Number.NaN;
  return record && typeof record.status === 'string' && !Number.isNaN(at) ? { status: record.status, at } : undefined;
}

const CLAUDE_STATUSES: readonly string[] = ['busy', 'shell', 'idle', 'waiting'];

/** Claude Code keeps each session's status in `sessions/<pid>.json`, next to its name. Only those two fields are read. */
function claudeStatus(pid: number): StatusInfo | undefined {
  const record = readJson<{ status?: unknown; statusUpdatedAt?: unknown }>(path.join(claudeConfigDir(), 'sessions', `${pid}.json`));
  if (typeof record?.status !== 'string' || !CLAUDE_STATUSES.includes(record.status)) return undefined;
  return { status: record.status as PeerStatus, at: typeof record.statusUpdatedAt === 'number' ? record.statusUpdatedAt : undefined };
}

/**
 * Codex: busy, idle or interrupted from the last turn event in its rollout log; waiting while its PermissionRequest
 * hook has fired and Codex hasn't logged a response item since (see codexLastResponse).
 */
function codexStatus(peer: Peer): StatusInfo | undefined {
  if (!peer.codexHome || !peer.sessionId) return undefined;
  const activity = codexActivity(peer.codexHome, peer.sessionId);
  const hook = recorded(peer.id);
  if (hook?.status === 'waiting' && activity !== 'idle' && activity !== 'interrupted') {
    const lastResponse = codexLastResponse(peer.codexHome, peer.sessionId);
    if (lastResponse === undefined || lastResponse <= (hook.at ?? 0)) return hook;
  }
  return activity ? { status: activity } : undefined;
}

export function peerStatus(peer: Peer): StatusInfo | undefined {
  if (peer.agent === 'claude') return claudeStatus(peer.pid);
  if (peer.agent === 'codex') return codexStatus(peer);
  const info = recorded(peer.id);
  return info && { ...info, fromHooks: statusFromHooks(peer.agent) };
}

/**
 * A busy or waiting status from hooks with no hook activity for this long may be a turn that ended without one (an
 * interrupt often runs no hook), so it is shown as uncertain.
 */
const STALE_MS = 15 * 60_000;

const stale = (info: StatusInfo, now: number) =>
  info.fromHooks && info.at !== undefined && now - info.at > STALE_MS ? `? (no activity for ${Math.round((now - info.at) / 60_000)}m)` : '';

/** The status as a listing shows it; for Codex's interrupted state, with what it means for a message. */
export function statusText(info: StatusInfo | undefined, now = Date.now()): string | undefined {
  if (!info) return undefined;
  switch (info.status) {
    case 'waiting':
      return `waiting on a permission prompt for its user${stale(info, now)}`;
    case 'shell':
      return 'shell (not generating, but a command it started is still running)';
    case 'interrupted':
      return 'interrupted: gets messages only after its user sends it a prompt';
    case 'busy':
      return `busy${stale(info, now)}`;
    default:
      return info.status;
  }
}
