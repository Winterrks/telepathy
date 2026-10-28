import path from 'node:path';
import type { Agent } from './agents.ts';
import { codexActivity, codexLastResponse } from './codex-activity.ts';
import { peerDir, readJson, writeJsonAtomic } from './paths.ts';
import { claudeConfigDir, type Peer } from './peers.ts';
import { commandLine, processTable } from './proc.ts';

/**
 * What a session is doing, in Claude Code's words where they exist:
 *   busy         in the middle of a turn
 *   shell        not generating, but a shell command it started is still running (Claude Code only)
 *   idle         waiting for its user to type
 *   waiting      stopped on a permission prompt: nothing moves until its user answers it
 *   interrupted  its last turn was interrupted (Codex). The queue will not start. The next prompt's hook reads the inbox.
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

/**
 * Claude Code keeps each session's status in `sessions/<pid>.json`, next to its name. `shell` means a command
 * it started is still running. The telepathy monitor is that command for an otherwise idle session, so it
 * does not count: idle is reported when every descendant command is telepathy's own monitor, server, or hook.
 */
function claudeStatus(pid: number): StatusInfo | undefined {
  const record = readJson<{ status?: unknown; statusUpdatedAt?: unknown }>(path.join(claudeConfigDir(), 'sessions', `${pid}.json`));
  if (typeof record?.status !== 'string' || !CLAUDE_STATUSES.includes(record.status)) return undefined;
  let status = record.status as PeerStatus;
  if (status === 'shell' && shellIsTelepathyMonitorOnly(descendantCommands(pid))) status = 'idle';
  return { status, at: typeof record.statusUpdatedAt === 'number' ? record.statusUpdatedAt : undefined };
}

const TELEPATHY_PROCESS = /(?:^|[\s/])(?:monitor|server|hook)\.mjs\b/;

/** `ps` and processes younger than this are not a session's own command. Claude samples `ps` for a moment. */
export function transientChildMs(): number {
  const n = Number(process.env.TELEPATHY_TRANSIENT_CHILD_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2_000;
}

/** A short-lived `ps` (or any process younger than {@link transientChildMs}) is not the session's work. */
export function ignoredShellChild(command: string, ageMs: number | undefined): boolean {
  const token = command.trim().split(/\s+/)[0] ?? '';
  const base = token.replace(/^["']|["']$/g, '').split(/[/\\]/).pop() ?? '';
  if (base === 'ps' || base === '(ps)') return true;
  // A telepathy monitor that just started is still the session's monitor. Ignoring it would leave an idle session
  // looking like `shell` for the first two seconds.
  if (TELEPATHY_PROCESS.test(command) && /--agent(?:\s|=)/.test(command)) return false;
  return ageMs !== undefined && ageMs >= 0 && ageMs < transientChildMs();
}

function processAgeMs(start: string | undefined): number | undefined {
  if (!start) return undefined;
  const at = Date.parse(start);
  if (Number.isNaN(at)) return undefined;
  return Date.now() - at;
}

/** True when the command lines are telepathy's monitor plus its own server and hooks, and nothing else. */
export function shellIsTelepathyMonitorOnly(commands: string[]): boolean {
  let monitor = false;
  for (const command of commands) {
    if (TELEPATHY_PROCESS.test(command) && /--agent(?:\s|=)/.test(command)) {
      if (/monitor\.mjs/.test(command)) monitor = true;
      continue;
    }
    return false;
  }
  return monitor;
}

function descendantCommands(rootPid: number): string[] {
  const table = processTable(0);
  const byParent = new Map<number, number[]>();
  for (const info of table.values()) {
    const kids = byParent.get(info.ppid);
    if (kids) kids.push(info.pid);
    else byParent.set(info.ppid, [info.pid]);
  }
  const commands: string[] = [];
  const stack = [...(byParent.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const info = table.get(pid);
    const args = commandLine(pid) ?? info?.comm;
    if (args && !ignoredShellChild(args, processAgeMs(info?.start))) commands.push(args);
    for (const child of byParent.get(pid) ?? []) stack.push(child);
  }
  return commands;
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
      return 'interrupted: a send fails until its user prompts it';
    case 'busy':
      return `busy${stale(info, now)}`;
    default:
      return info.status;
  }
}
