import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type Agent = 'claude' | 'codex';
export const AGENTS: readonly Agent[] = ['claude', 'codex'];

export function parseAgent(value: string | undefined): Agent {
  if (value === 'claude' || value === 'codex') return value;
  throw new Error(`--agent must be "claude" or "codex" (got ${JSON.stringify(value)})`);
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Process start time as printed by `ps -o lstart`; together with the pid it identifies one process. */
  start: string;
  comm: string;
}

let cache: { at: number; table: Map<number, ProcInfo> } | undefined;

/** One `ps` call for the whole table; cached briefly because listing peers checks many pids. */
export function processTable(maxAgeMs = 500): Map<number, ProcInfo> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.table;
  const table = new Map<number, ProcInfo>();
  let out = '';
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,ppid=,lstart=,comm='], {
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

/**
 * Finds the pid of the agent process (the `claude` or `codex` CLI) that this process belongs to.
 * MCP servers, hooks and monitors are all descendants of it, so it is the one identifier they share.
 */
export function findAgentPid(agent: Agent): number {
  const override = Number(process.env.TELEPATHY_AGENT_PID);
  if (Number.isInteger(override) && override > 0) return override;

  const table = processTable(0);
  const seen = new Set<number>();
  for (let pid = process.ppid; pid > 1 && !seen.has(pid); ) {
    seen.add(pid);
    const info = table.get(pid);
    if (!info) break;
    if (path.basename(info.comm) === agent) return pid;
    pid = info.ppid;
  }

  // Claude Code exports its own pid to hooks, monitors and Bash commands.
  const claudePid = Number(process.env.CLAUDE_PID);
  if (agent === 'claude' && Number.isInteger(claudePid) && isAlive(claudePid)) return claudePid;

  return process.ppid;
}
