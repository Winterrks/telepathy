import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { commandLines, type ProcInfo, processTable, psCommand } from './proc.ts';

/**
 * A Codex window that is already on screen, before it has a thread id telepathy can queue to.
 * `codex resume <uuid>` names the thread. Anything else interactive (`codex`, `codex resume`, `codex fork`) does not.
 */
export interface CodexTuiLaunch {
  threadId?: string;
}

export interface CodexTuiProc {
  pid: number;
  args: string;
  cwd?: string;
  start?: string;
  /** `CODEX_HOME` from this process, when it could be read. Queue and delete use it. */
  codexHome?: string;
}

/** Flags that take the next argv token. A boolean flag must not swallow the prompt or the subcommand. */
const VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '-m',
  '--model',
  '-p',
  '--profile',
  '-i',
  '--image',
  '-a',
  '--ask-for-approval',
  '--sandbox',
  '-s',
  '-C',
  '--cd',
  '--add-dir',
  '--enable',
  '--disable',
  '--remote',
  '--output-schema',
]);

/**
 * A first positional that looks like a Codex subcommand (`exec-server`, `login`, `e`) rather than a prompt.
 * Unknown subcommands are not TUIs. A denylist missed `exec-server`, which is how the ChatGPT app's helper
 * was listed as a peer.
 */
const SUBCOMMAND = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A parent launched from an app bundle (`ChatGPT.app`), not a terminal. */
const APP_BUNDLE = /\.app(?:\/|\s|$)/;

const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'bash', 'sh', 'zsh', 'env']);

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function binName(token: string): string {
  const base = token.split(/[/\\]/).pop() ?? token;
  return base.replace(/\.(js|mjs|cjs|exe)$/i, '');
}

/** Argv after the `codex` binary, when this command line is Codex and not some other process that mentions it. */
function codexArgv(command: string): string[] | undefined {
  const tokens = tokenize(command);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
  const exe = tokens[i];
  if (!exe) return undefined;
  if (binName(exe) === 'codex') return tokens.slice(i + 1);
  if (!INTERPRETERS.has(binName(exe))) return undefined;
  const script = tokens[i + 1];
  if (!script || script.startsWith('-') || binName(script) !== 'codex') return undefined;
  return tokens.slice(i + 2);
}

/**
 * The interactive Codex TUI this command line starts, or undefined when it is not one.
 * Allowed: bare `codex` (global flags only), `codex resume` (optional uuid), `codex fork`, and a prompt whose
 * first token is not subcommand-shaped. `exec-server`, `mcp-server`, `app-server`, `exec`, `queue`, `login`,
 * `cloud`, and every other subcommand are not TUIs. A one-word lowercase prompt looks like a subcommand and is
 * not listed from the process table; SessionStart lists it once the thread exists. A quoted prompt with a space
 * or a capital letter is a TUI. Only `codex resume <uuid>` yields a thread id. A bare `codex resume` is the
 * newest thread according to Codex, which this process cannot know until SessionStart, so it stays a TUI with
 * no id. `codex fork <id>` opens a new thread; the id on the command line is the parent, not this window.
 */
export function codexTuiLaunch(command: string): CodexTuiLaunch | undefined {
  const argv = codexArgv(command);
  if (!argv) return undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('-')) {
      const name = token.split('=')[0] ?? token;
      if (!token.includes('=') && VALUE_FLAGS.has(name)) i++;
      continue;
    }
    positional.push(token);
  }
  const sub = positional[0];
  if (!sub) return {};
  if (sub === 'resume') {
    const threadId = positional.slice(1).find((token) => THREAD_ID.test(token));
    return threadId ? { threadId } : {};
  }
  if (sub === 'fork') return {};
  if (SUBCOMMAND.test(sub)) return undefined;
  return {};
}

function parentIsAppBundle(parent: string | undefined): boolean {
  return !!parent && APP_BUNDLE.test(parent);
}

/** Parent command line from maps this call already loaded. No extra `ps`. */
function parentCommandOf(pid: number, table: Map<number, ProcInfo>, lines: Map<number, string>): string | undefined {
  const ppid = table.get(pid)?.ppid;
  if (!ppid) return undefined;
  const args = lines.get(ppid);
  const comm = table.get(ppid)?.comm;
  return [args, comm].filter((part) => !!part).join('\n') || undefined;
}

/** `CODEX_HOME` from `/proc/<pid>/environ`. Undefined when the file cannot be read (macOS). */
function procEnvironHome(pid: number): { home?: string } | undefined {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`);
    for (const entry of raw.toString('utf8').split('\0')) {
      if (!entry.startsWith('CODEX_HOME=')) continue;
      const home = entry.slice('CODEX_HOME='.length);
      return { home: home || undefined };
    }
    return {};
  } catch {
    return undefined;
  }
}

/**
 * `CODEX_HOME` for the candidates that survived the command-line filter. One `/proc` read each, and at most
 * one `ps -E` for the pids that have no `/proc`. The result is not used to hide a TUI.
 */
function codexHomes(pids: number[]): Map<number, string> {
  const homes = new Map<number, string>();
  const missing: number[] = [];
  for (const pid of pids) {
    const fromProc = procEnvironHome(pid);
    if (!fromProc) {
      missing.push(pid);
      continue;
    }
    if (fromProc.home) homes.set(pid, fromProc.home);
  }
  if (!missing.length) return homes;
  try {
    const out = execFileSync(psCommand(), ['-ww', '-p', missing.join(','), '-E', '-o', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    });
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const home = /(?:^|\s)CODEX_HOME=(\S*)/.exec(match[2] ?? '');
      if (home?.[1]) homes.set(Number(match[1]), home[1]);
    }
  } catch {
    // Unreadable. The peer keeps the default home.
  }
  return homes;
}

/** Working directory of a live process. `/proc` on Linux; `lsof` where that link does not exist. */
export function processCwd(pid: number): string | undefined {
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (cwd) return cwd;
  } catch {
    // macOS has no /proc.
  }
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((entry) => entry.startsWith('n') && entry.length > 1);
    return line?.slice(1);
  } catch {
    return undefined;
  }
}

function acceptTui(args: string, parent: string | undefined): boolean {
  return !!codexTuiLaunch(args) && !parentIsAppBundle(parent);
}

function procsFromOverride(file: string): CodexTuiProc[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    const procs: CodexTuiProc[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const rec = row as {
        pid?: unknown;
        args?: unknown;
        cwd?: unknown;
        start?: unknown;
        parent?: unknown;
        codexHome?: unknown;
      };
      if (typeof rec.pid !== 'number' || typeof rec.args !== 'string') continue;
      const parent = typeof rec.parent === 'string' ? rec.parent : undefined;
      const codexHome = typeof rec.codexHome === 'string' && rec.codexHome ? rec.codexHome : undefined;
      if (!acceptTui(rec.args, parent)) continue;
      procs.push({
        pid: rec.pid,
        args: rec.args,
        cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
        start: typeof rec.start === 'string' ? rec.start : undefined,
        codexHome,
      });
    }
    return procs;
  } catch {
    return [];
  }
}

let liveCache: { at: number; procs: CodexTuiProc[] } | undefined;

/** Drops the short-lived TUI scan so the next listing reads the process table again. */
export function clearCodexTuiCache(): void {
  liveCache = undefined;
}

/**
 * Interactive Codex TUIs. `TELEPATHY_CODEX_PROCS` is a JSON file of `{pid, args, cwd?, start?, parent?, codexHome?}`
 * and replaces the process scan, so tests do not list a Codex the developer happens to have open. Unset, one `ps`
 * supplies every command line and one supplies the process table. Only lines that are already an allowlisted TUI
 * are checked for an app-bundle parent, and only those that remain get a `CODEX_HOME` lookup. A different
 * `CODEX_HOME` does not hide the TUI; it is recorded so queue and delete use that home. The result is reused for
 * a fraction of a second, so a tool call that lists twice does not scan twice.
 */
export function codexTuiProcesses(): CodexTuiProc[] {
  const override = process.env.TELEPATHY_CODEX_PROCS;
  if (override) return procsFromOverride(override);
  if (liveCache && Date.now() - liveCache.at < 500) return liveCache.procs;
  const lines = commandLines();
  const table = processTable();
  const candidates: { pid: number; args: string }[] = [];
  for (const [pid, args] of lines) {
    if (!codexTuiLaunch(args)) continue;
    if (parentIsAppBundle(parentCommandOf(pid, table, lines))) continue;
    candidates.push({ pid, args });
  }
  const homes = codexHomes(candidates.map((candidate) => candidate.pid));
  const procs = candidates.map((candidate) => ({
    pid: candidate.pid,
    args: candidate.args,
    start: table.get(candidate.pid)?.start,
    codexHome: homes.get(candidate.pid),
  }));
  liveCache = { at: Date.now(), procs };
  return procs;
}
