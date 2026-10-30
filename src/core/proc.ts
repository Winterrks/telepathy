import { execFileSync } from 'node:child_process';
import { AGENT_IDS, type Agent, agentFromEnv, isAgentProcess } from './agents.ts';

export { type Agent, parseAgent } from './agents.ts';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Process start time as printed by `ps -o lstart`; together with the pid it identifies one process. */
  start: string;
  comm: string;
}

let cache: { at: number; table: Map<number, ProcInfo> } | undefined;

/** `ps`, or `TELEPATHY_PS_BIN` when a test is counting how many times the process table is read. */
export function psCommand(): string {
  return process.env.TELEPATHY_PS_BIN || 'ps';
}

/** Drops the short-lived `ps` caches so the next listing reads the process table again. */
export function clearProcessListCache(): void {
  cache = undefined;
  argsCache = undefined;
}

/** One `ps` call for the whole table; cached briefly because listing peers checks many pids. */
export function processTable(maxAgeMs = 500): Map<number, ProcInfo> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.table;
  const table = new Map<number, ProcInfo>();
  let out = '';
  try {
    out = execFileSync(psCommand(), ['-Ao', 'pid=,ppid=,lstart=,comm='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    // Without ps we can still fall back to kill(pid, 0) liveness checks.
  }
  const re = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;
  for (const line of out.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    table.set(pid, { pid, ppid: Number(m[2]), start: m[3].replace(/\s+/g, ' '), comm: m[4].trim() });
  }
  cache = { at: Date.now(), table };
  return table;
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function procStart(pid: number): string | undefined {
  return processTable().get(pid)?.start;
}

/**
 * True when `pid` is still the same process we recorded: alive, and (when we know it)
 * started at the recorded time, so a recycled pid is not mistaken for the old session.
 */
export function isSameProcess(pid: number, recordedStart: string | undefined): boolean {
  if (!isAlive(pid)) return false;
  if (!recordedStart) return true;
  const current = processTable(0).get(pid)?.start;
  return current === undefined || current === recordedStart;
}

/** A process's full command line, when `ps` can read it. */
export const commandLine = (pid: number): string | undefined => psField(pid, 'args');

let argsCache: { at: number; table: Map<number, string> } | undefined;

/** Every process's command line from one `ps`, cached like {@link processTable}. */
export function commandLines(maxAgeMs = 500): Map<number, string> {
  if (argsCache && Date.now() - argsCache.at < maxAgeMs) return argsCache.table;
  const table = new Map<number, string>();
  let out = '';
  try {
    out = execFileSync(psCommand(), ['-Ao', 'pid=,args='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    // Without ps, launch discovery sees no Codex TUIs.
  }
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), match[2].trim());
  }
  argsCache = { at: Date.now(), table };
  return table;
}

/**
 * Whether this Claude Code process is driven over stream-json by a host app (the Claude app's Code tab, Agent SDK
 * apps). Claude Code starts plugin monitors only in interactive terminal sessions, so these never run one.
 */
export const isStreamJsonClaude = (pid: number): boolean =>
  /--input-format[=\s]+stream-json/.test(commandLine(pid) ?? '');

/** One `ps` column for one process; only needed for agents that run as node or Python scripts. */
function psField(pid: number, field: 'args' | 'ucomm'): string | undefined {
  try {
    return execFileSync(psCommand(), ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
  } catch {
    return undefined;
  }
}

function lazy<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

export interface AgentProcess {
  agent: Agent;
  pid: number;
}

/**
 * Finds the agent process (the `claude`, `codex`, `agy`… CLI) this process belongs to: the nearest
 * ancestor that is one. MCP servers, hooks and monitors are all descendants of it, so its pid is the one
 * identifier they share. The agent named on the command line only breaks ties and serves as the fallback,
 * because some agents run other agents' plugins (Qwen Code installs Claude Code plugins, for one).
 */
export function findAgent(hint: Agent): AgentProcess {
  const override = Number(process.env.TELEPATHY_AGENT_PID);
  if (Number.isInteger(override) && override > 0) return { agent: hint, pid: override };

  const candidates = [hint, ...AGENT_IDS.filter((a) => a !== hint)];
  const table = processTable(0);
  const seen = new Set<number>();
  for (let pid = process.ppid; pid > 1 && !seen.has(pid); ) {
    seen.add(pid);
    const info = table.get(pid);
    if (!info) break;
    const args = lazy(() => psField(pid, 'args'));
    const kernelName = lazy(() => psField(pid, 'ucomm'));
    const agent = candidates.find((a) => isAgentProcess(a, info.comm, args, kernelName));
    if (agent) return { agent, pid };
    pid = info.ppid;
  }

  // Claude Code exports its own pid to hooks, monitors and Bash commands.
  const claudePid = Number(process.env.CLAUDE_PID);
  if (hint === 'claude' && Number.isInteger(claudePid) && isAlive(claudePid)) return { agent: 'claude', pid: claudePid };

  return { agent: agentFromEnv() ?? hint, pid: process.ppid };
}

/** This process and every descendant, from one process table. The root is included even when `ps` missed it. */
export function descendantPids(root: number): number[] {
  if (!Number.isInteger(root) || root <= 0) return [];
  const table = processTable(0);
  const children = new Map<number, number[]>();
  for (const info of table.values()) {
    const list = children.get(info.ppid);
    if (list) list.push(info.pid);
    else children.set(info.ppid, [info.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (pid === undefined || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

/** npm's `node_modules/.bin/copilot` shim. It is not the process the plugin's server walks up to. */
export function isNpmCopilotShim(command: string): boolean {
  return /(?:^|[\s/])\.bin\/copilot(?:\.js)?(?:\s|$)/.test(command);
}

/** The plugin MCP server Copilot spawns (`server.mjs` / `hook.mjs`, or `telepathy mcp`). */
function isTelepathyMcp(command: string): boolean {
  if (!/telepathy/i.test(command)) return false;
  return /(?:server|hook)\.mjs/.test(command) || /(?:^|\s)mcp(?:\s|$)/.test(command);
}

/**
 * The Copilot process a plugin server will register, when `telepathy run` spawned npm's launcher.
 * That launcher (`node …/.bin/copilot`) is the ACP child; the real CLI is its child, and the plugin
 * server walks up to that child. Prefer the parent of the plugin server, else the deepest Copilot
 * process in the tree that is not the shim, else the pid we spawned.
 */
export function resolveCopilotPid(spawnedPid: number): number {
  if (!Number.isInteger(spawnedPid) || spawnedPid <= 0) return spawnedPid;
  const tree = descendantPids(spawnedPid);
  if (!tree.length) return spawnedPid;
  const inTree = new Set(tree);
  const table = processTable(0);
  const lines = commandLines(0);
  const lineOf = (pid: number) => lines.get(pid) ?? '';
  const depth = new Map<number, number>([[spawnedPid, 0]]);
  for (const pid of tree) {
    if (pid === spawnedPid) continue;
    const parent = table.get(pid)?.ppid;
    const parentDepth = parent === undefined ? undefined : depth.get(parent);
    if (parentDepth !== undefined) depth.set(pid, parentDepth + 1);
  }
  const looksCopilot = (pid: number) => {
    const info = table.get(pid);
    if (!info) return false;
    return isAgentProcess('copilot', info.comm, () => lineOf(pid));
  };
  const mcpPids = tree.filter((pid) => isTelepathyMcp(lineOf(pid)));
  for (const mcp of mcpPids) {
    let pid = table.get(mcp)?.ppid;
    while (pid && inTree.has(pid)) {
      if (looksCopilot(pid) && !isNpmCopilotShim(lineOf(pid))) return pid;
      pid = table.get(pid)?.ppid;
    }
    // The real CLI is often `node …/copilot/index.js`, which is not the `copilot` command name.
    // It is still the process the plugin server belongs to, as long as it is not the npm shim.
    let parent = table.get(mcp)?.ppid;
    while (parent && inTree.has(parent)) {
      if (!isNpmCopilotShim(lineOf(parent))) return parent;
      parent = table.get(parent)?.ppid;
    }
  }
  let best = spawnedPid;
  let bestDepth = -1;
  for (const pid of tree) {
    if (!looksCopilot(pid) || isNpmCopilotShim(lineOf(pid))) continue;
    const d = depth.get(pid) ?? 0;
    if (d >= bestDepth) {
      best = pid;
      bestDepth = d;
    }
  }
  return best;
}
