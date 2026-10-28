import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { commandLines, processTable } from './proc.ts';

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
 * Subcommands that are not an interactive TUI. `resume` and `fork` are TUIs. `queue` and `app-server` are how
 * telepathy and the shared daemon run, and listing either would show one peer for every thread.
 */
const NON_TUI = new Set([
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'app-server',
  'app',
  'cloud',
  'sandbox',
  'apply',
  'features',
  'completion',
  'completions',
  'debug',
  'doctor',
  'update',
  'plugin',
  'help',
  'queue',
  'delete',
  'proto',
  'execpolicy',
]);

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
 * The interactive Codex TUI this command line starts, or undefined for `app-server`, `exec`, `queue`, and the rest.
 * Only `codex resume <uuid>` yields a thread id. A bare `codex resume` is the newest thread according to Codex, which
 * this process cannot know until SessionStart, so it stays a TUI with no id.
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
  if (sub && NON_TUI.has(sub)) return undefined;
  if (sub === 'resume') {
    const threadId = positional.slice(1).find((token) => THREAD_ID.test(token));
    return threadId ? { threadId } : {};
  }
  // `codex fork <id>` opens a new thread. The id on the command line is the parent, not this window.
  return {};
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

function procsFromOverride(file: string): CodexTuiProc[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    const procs: CodexTuiProc[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const rec = row as { pid?: unknown; args?: unknown; cwd?: unknown; start?: unknown };
      if (typeof rec.pid !== 'number' || typeof rec.args !== 'string' || !codexTuiLaunch(rec.args)) continue;
      procs.push({
        pid: rec.pid,
        args: rec.args,
        cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
        start: typeof rec.start === 'string' ? rec.start : undefined,
      });
    }
    return procs;
  } catch {
    return [];
  }
}

/**
 * Interactive Codex TUIs. `TELEPATHY_CODEX_PROCS` is a JSON file of `{pid, args, cwd?, start?}` and replaces the
 * process scan, so tests do not list a Codex the developer happens to have open. Unset, one `ps` supplies the
 * command lines.
 */
export function codexTuiProcesses(): CodexTuiProc[] {
  const override = process.env.TELEPATHY_CODEX_PROCS;
  if (override) return procsFromOverride(override);
  const procs: CodexTuiProc[] = [];
  const starts = processTable();
  for (const [pid, args] of commandLines()) {
    if (!codexTuiLaunch(args)) continue;
    procs.push({ pid, args, start: starts.get(pid)?.start });
  }
  return procs;
}
