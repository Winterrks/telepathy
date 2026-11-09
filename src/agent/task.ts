import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnesses, resolvedAcpBin } from '../cli/harnesses.ts';
import { type Agent, isAgent } from '../core/agents.ts';
import { ensureDir, envDurationMs, readJson, writeJsonAtomic } from '../core/paths.ts';
import { isAlive, isSameProcess } from '../core/proc.ts';

/**
 * start_agent and follow-ups as MCP tasks (the MCP tasks extension, protocol revision 2026-07-28), where the client
 * takes them: Claude Code's CLI. The tool call returns a task at once; Claude Code follows it with `tasks/get` as a
 * background task of its own (TaskStop cancels it), and the agent's next report is the task's result. No model
 * stands in between.
 *
 * The agent host and the server meet in `<agent dir>/task/`. While the server has a task open for the agent
 * (`open/<n>.json`, naming the server process), the host offers each report and permission request as an event file
 * and holds it; the server claims it by renaming it when Claude Code polls. With no task open, or when no poll takes
 * it in time, the host takes it back and sends it to the parent as a message, as start_agent's reports always went.
 */

/** Harnesses start_agent can run for Claude Code: every one with an ACP mode except Claude Code itself. */
export const taskHarnesses = (): Agent[] => harnesses().filter((h) => h.acp && h.agent !== 'claude').map((h) => h.agent);

/** The ones whose ACP launcher is on PATH here. */
export const installedTaskHarnesses = (): Agent[] =>
  taskHarnesses().filter((agent) => {
    const acp = harnesses().find((h) => h.agent === agent)?.acp;
    return !!acp && !!resolvedAcpBin(acp);
  });

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** A Claude agent type of that name exists: the user's or the project's agent file, or an installed plugin of that name. */
function claudeHasAgent(name: string, cwd?: string): boolean {
  const files = [path.join(claudeDir(), 'agents', `${name}.md`), ...(cwd ? [path.join(cwd, '.claude', 'agents', `${name}.md`)] : [])];
  if (files.some((file) => fs.existsSync(file))) return true;
  const [plugin] = name.split(':');
  if (plugin === name) return false;
  const installed = readJson<{ plugins?: Record<string, unknown> }>(path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  return Object.keys(installed?.plugins ?? {}).some((key) => key.split('@')[0] === plugin);
}

/**
 * Agent tool types that name another harness: `telepathy:codex`, and `codex` or `codex:<name>` when no Claude
 * agent goes by that name. The Agent tool always runs a Claude model, so these go to start_agent instead.
 */
export function harnessAgentType(type: unknown, cwd?: string): { harness: Agent; name?: string } | undefined {
  if (typeof type !== 'string') return undefined;
  const value = type.trim().toLowerCase();
  const runnable = (name: string) => (isAgent(name) && taskHarnesses().includes(name) ? name : undefined);
  const prefixed = /^telepathy:([a-z]+)$/.exec(value);
  if (prefixed) {
    const harness = runnable(prefixed[1]);
    return harness ? { harness } : undefined;
  }
  const [head, ...rest] = value.split(':');
  const harness = runnable(head === 'agy' ? 'antigravity' : head);
  if (!harness || claudeHasAgent(type.trim(), cwd)) return undefined;
  const name = rest.join(':').trim();
  return name ? { harness, name } : { harness };
}

export interface TaskEvent {
  kind: 'result' | 'permission';
  body: string;
  /** True when the turn failed with an error and produced no final message. */
  failed?: boolean;
  /** The permission request's id. */
  request?: string;
  /** Command prefixes the request uses, which the answer can allow from now on (src/agent/policy.ts). */
  prefixes?: string[];
  at: string;
}

const taskDir = (dir: string) => path.join(dir, 'task');
const eventsDir = (dir: string) => path.join(taskDir(dir), 'events');
const openDir = (dir: string) => path.join(taskDir(dir), 'open');
const PENDING = /^\d{6}\.json$/;

/** How long the host holds an event for an open task before sending it to the parent as a message. */
export const taskPickupMs = () => envDurationMs('TELEPATHY_TASK_PICKUP_MS', 30_000);

let lastSeq = -1;

/** The host offers an event. Returns its file, which a claim renames away. */
export function offerEvent(dir: string, event: Omit<TaskEvent, 'at'>): string {
  ensureDir(eventsDir(dir));
  if (lastSeq < 0) lastSeq = fs.readdirSync(eventsDir(dir)).length;
  const file = path.join(eventsDir(dir), `${String(++lastSeq).padStart(6, '0')}.json`);
  writeJsonAtomic(file, { ...event, at: new Date().toISOString() });
  return file;
}

/** The host takes an event back when no task claimed it. False when a task claimed it first. */
export function takeBack(file: string): boolean {
  try {
    fs.renameSync(file, file.replace(/\.json$/, '.sent'));
    return true;
  } catch {
    return false;
  }
}

/** The oldest event no one has claimed, now claimed by the caller. */
export function claimEvent(dir: string): TaskEvent | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(eventsDir(dir)).filter((name) => PENDING.test(name)).sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    const from = path.join(eventsDir(dir), name);
    const to = from.replace(/\.json$/, '.taken');
    try {
      fs.renameSync(from, to);
    } catch {
      continue; // the host took it back
    }
    const event = readJson<TaskEvent>(to);
    if (event) return event;
  }
  return undefined;
}

interface OpenMarker {
  taskId: string;
  pid: number;
  procStart?: string;
  /** A task a session on another device follows through this device's bridge: open until its polls stop renewing it. */
  until?: number;
}

let openSeq = 0;

/** The server opens a task on an agent. Returns the call that closes it. */
export function openTask(dir: string, taskId: string, procStart: string | undefined): () => void {
  ensureDir(openDir(dir));
  // A server that went away without closing its tasks is superseded by this one.
  forgetLostTasks(dir);
  const file = path.join(openDir(dir), `${process.pid}-${++openSeq}.json`);
  writeJsonAtomic(file, { taskId, pid: process.pid, procStart } satisfies OpenMarker);
  return () => fs.rmSync(file, { force: true });
}

const leaseFile = (dir: string, taskId: string) =>
  path.join(openDir(dir), `remote-${crypto.createHash('sha256').update(taskId).digest('hex').slice(0, 16)}.json`);

/** The bridge opens, or renews, a task a session on another device follows. It lapses `ms` after the last renewal. */
export function leaseTask(dir: string, taskId: string, procStart: string | undefined, ms: number): void {
  ensureDir(openDir(dir));
  writeJsonAtomic(leaseFile(dir, taskId), { taskId, pid: process.pid, procStart, until: Date.now() + ms } satisfies OpenMarker);
}

export const endLease = (dir: string, taskId: string) => fs.rmSync(leaseFile(dir, taskId), { force: true });

function markers(dir: string): { file: string; live: boolean }[] {
  let names: string[];
  try {
    names = fs.readdirSync(openDir(dir));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(openDir(dir), name);
    const marker = readJson<OpenMarker>(file);
    if (!marker?.pid) return [];
    const lapsed = marker.until !== undefined && marker.until < Date.now();
    return [{ file, live: !lapsed && isAlive(marker.pid) && isSameProcess(marker.pid, marker.procStart) }];
  });
}

/** A task is open on this agent in a server that is still running, or under a lease that has not lapsed. */
export const taskOpen = (dir: string): boolean => markers(dir).some((m) => m.live);

/**
 * How a task follows this agent: `open`, or `lost` when the server that followed it went away without closing it
 * (a plugin reload, a crash, a lease that lapsed). Claude Code may take a lost task up again from the restarted
 * server, so the host holds an event for it as long as for an open one before sending it as a message.
 */
export function taskFollow(dir: string): 'open' | 'lost' | 'none' {
  const all = markers(dir);
  return all.some((m) => m.live) ? 'open' : all.length ? 'lost' : 'none';
}

/** Drops the markers of servers that are gone: nobody took their tasks up again. */
export function forgetLostTasks(dir: string): void {
  for (const marker of markers(dir)) if (!marker.live) fs.rmSync(marker.file, { force: true });
}

/** A reply to a permission request, as a user would put it: allow or deny. */
export function permissionWord(text: string): boolean | undefined {
  const word = text.trim().toLowerCase().replace(/^["'`]|["'`.!]$/g, '');
  if (/^(allow|allowed|yes|y|approve|approved|ok|okay|grant|granted)$/.test(word)) return true;
  if (/^(deny|denied|no|n|reject|rejected|refuse|refused|decline|declined)$/.test(word)) return false;
  return undefined;
}
