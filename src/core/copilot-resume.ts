import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processCwd } from './codex-launch.ts';
import { configuredEnv } from './paths.ts';
import { copilotEventsFile, linkedPeerId, registerSession, sessionToken } from './peers.ts';
import { commandLine, procStart } from './proc.ts';

/**
 * A resumed plain `copilot` (`--resume=<id>`, `--resume <id>`, `--continue`) does not run sessionStart
 * until the first prompt. Until then the MCP server only has `copilot-<pid>`. These signals exist before
 * that prompt: the process argv, a `session.resume` line in `events.jsonl` newer than the process, and
 * `workspace.yaml`'s mtime. `inuse.<pid>.lock` is not a signal. An ambiguous reading claims nothing.
 */
export type CopilotResumeLook =
  | { state: 'resume'; sessionId: string }
  | { state: 'pending' }
  | { state: 'skip' };

export interface CopilotResumeInput {
  /** Full command line of the Copilot process (`ps` args). */
  argv: string;
  /** That process's working directory. */
  cwd?: string;
  /** `ps` lstart, in milliseconds. Events and workspace mtimes must be newer than this. */
  processStartMs: number;
  /** Directory that contains `session-state/` (`COPILOT_HOME`, or `~/.copilot`). */
  copilotHome: string;
}

interface SessionSnap {
  id: string;
  cwd?: string;
  name?: string;
  workspaceMtime?: number;
  resume?: { at: number; cwd?: string };
}

/** Shell words, with single and double quotes. Enough for Copilot's own argv, not a general shell. */
export function shellTokens(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

interface LaunchFlags {
  /** Set when `--resume` or `--resume=` is present, including a picker (`--resume` with no id). */
  resumeFlag: boolean;
  /** The id, unique prefix, or session name after `--resume`, when one was given. */
  resume?: string;
  continue: boolean;
  /** `--resume` and `--continue` together, or two different `--resume` values. */
  conflict: boolean;
}

/** `--resume=<id>`, `--resume <id>`, and `--continue`. Tokens after a bare `--` are not flags. */
export function copilotLaunchFlags(command: string): LaunchFlags {
  const flags: LaunchFlags = { resumeFlag: false, continue: false, conflict: false };
  const tokens = shellTokens(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (token === '--') break;
    if (token === '--continue') {
      flags.continue = true;
      continue;
    }
    let value: string | undefined;
    if (token === '--resume') {
      flags.resumeFlag = true;
      const next = tokens[i + 1];
      if (next && !next.startsWith('-')) {
        value = next;
        i++;
      }
    } else if (token.startsWith('--resume=')) {
      flags.resumeFlag = true;
      const raw = token.slice('--resume='.length);
      if (raw) value = raw;
    } else {
      continue;
    }
    if (value === undefined) continue;
    if (flags.resume !== undefined && flags.resume !== value) flags.conflict = true;
    flags.resume = value;
  }
  if (flags.resumeFlag && flags.continue) flags.conflict = true;
  return flags;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const n = Date.parse(value);
  return Number.isNaN(n) ? undefined : n;
}

function pathKeys(p: string): string[] {
  const trimmed = p.trim().replace(/[\\/]+$/, '') || p.trim();
  if (!trimmed) return [];
  const keys = new Set<string>();
  const add = (value: string) => {
    const slashed = value.replace(/\\/g, '/');
    keys.add(process.platform === 'win32' || process.platform === 'darwin' ? slashed.toLowerCase() : slashed);
  };
  add(path.resolve(trimmed));
  try {
    add(fs.realpathSync(trimmed));
  } catch {
    // The directory is not on this machine. The resolved form is still comparable.
  }
  return [...keys];
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = new Set(pathKeys(a));
  return pathKeys(b).some((key) => left.has(key));
}

/** Top-level `key: value` lines. Nested YAML is ignored; Copilot's cwd and name are top-level. */
function yamlScalars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line || /^\s/.test(line) || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[match[1]] = value;
  }
  return out;
}

function readTail(file: string, max = 256 * 1024): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return '';
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const cut = text.indexOf('\n');
    return cut === -1 ? '' : text.slice(cut + 1);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function latestResume(file: string): { at: number; cwd?: string } | undefined {
  let best: { at: number; cwd?: string } | undefined;
  for (const line of readTail(file).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.includes('session.resume')) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const body = record as Record<string, unknown>;
    const type = body.type ?? body.event ?? body.name;
    if (type !== 'session.resume') continue;
    const data = body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {};
    const context = data.context && typeof data.context === 'object' ? (data.context as Record<string, unknown>) : {};
    const cwd = typeof context.cwd === 'string' ? context.cwd : typeof data.cwd === 'string' ? data.cwd : undefined;
    const times = [body.timestamp, data.resumeTime, data.timestamp].map(parseTime).filter((n): n is number => n !== undefined);
    if (!times.length) continue;
    const at = Math.max(...times);
    if (!best || at >= best.at) best = { at, cwd };
  }
  return best;
}

function loadSessions(copilotHome: string): SessionSnap[] {
  const root = path.join(copilotHome, 'session-state');
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const sessions: SessionSnap[] = [];
  for (const name of names) {
    if (!sessionToken(name)) continue;
    const dir = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const snap: SessionSnap = { id: name };
    const workspace = path.join(dir, 'workspace.yaml');
    try {
      const wst = fs.statSync(workspace);
      snap.workspaceMtime = wst.mtimeMs;
      const fields = yamlScalars(fs.readFileSync(workspace, 'utf8'));
      if (fields.id && fields.id !== name) continue;
      if (fields.cwd) snap.cwd = fields.cwd;
      if (fields.name) snap.name = fields.name;
    } catch {
      // No workspace yet. The event log can still name the resume.
    }
    snap.resume = latestResume(path.join(dir, 'events.jsonl'));
    sessions.push(snap);
  }
  return sessions;
}

interface Confirm {
  ids: string[];
  /** A post-start event and workspace.yaml disagree about cwd or about which session. */
  conflict: boolean;
}

/** This session's own `session.resume`, newer than the process and in this cwd. A fresh session never writes one. */
function matchingResume(snap: SessionSnap | undefined, cwd: string, processStartMs: number): boolean {
  return !!snap?.resume && snap.resume.at > processStartMs && samePath(snap.resume.cwd, cwd);
}

function confirming(sessions: SessionSnap[], cwd: string, processStartMs: number): Confirm {
  const ids: string[] = [];
  let conflict = false;
  for (const snap of sessions) {
    const eventNew = !!snap.resume && snap.resume.at > processStartMs;
    const eventMatch = eventNew && samePath(snap.resume?.cwd, cwd);
    const eventOther = eventNew && !!snap.resume?.cwd && !samePath(snap.resume.cwd, cwd);
    const workspaceNew = snap.workspaceMtime !== undefined && snap.workspaceMtime > processStartMs;
    const workspaceMatch = workspaceNew && samePath(snap.cwd, cwd);
    const workspaceOther = workspaceNew && !!snap.cwd && !samePath(snap.cwd, cwd);
    if ((eventMatch && workspaceOther) || (workspaceMatch && eventOther)) {
      conflict = true;
      continue;
    }
    if (eventMatch || workspaceMatch) ids.push(snap.id);
  }
  return { ids, conflict };
}

function resolveToken(token: string, sessions: SessionSnap[]): { id?: string; ambiguous: boolean } {
  const exact = sessions.filter((s) => s.id === token);
  if (exact.length === 1) return { id: exact[0].id, ambiguous: false };
  if (exact.length > 1) return { ambiguous: true };
  const folded = token.toLowerCase();
  const hits = new Set<string>();
  for (const snap of sessions) {
    if (snap.id.toLowerCase() === folded) hits.add(snap.id);
  }
  if (token.length >= 8) {
    for (const snap of sessions) {
      if (snap.id.startsWith(token) || snap.id.toLowerCase().startsWith(folded)) hits.add(snap.id);
    }
  }
  for (const snap of sessions) {
    if (snap.name?.toLowerCase() === folded) hits.add(snap.id);
  }
  if (hits.size === 1) return { id: [...hits][0], ambiguous: false };
  if (hits.size > 1) return { ambiguous: true };
  return { ambiguous: false };
}

/**
 * The resumed session id, or a reason not to bind one. `pending` means the flags say this process is
 * resuming but the event and workspace.yaml are not observable yet. `skip` means this is not a resume,
 * or the signals disagree.
 */
export function detectResumedCopilotSession(input: CopilotResumeInput): CopilotResumeLook {
  const flags = copilotLaunchFlags(input.argv);
  if (flags.conflict) return { state: 'skip' };
  if (!flags.resumeFlag && !flags.continue) return { state: 'skip' };
  if (!input.cwd || !Number.isFinite(input.processStartMs)) return { state: 'pending' };
  const sessions = loadSessions(input.copilotHome);
  const confirmed = confirming(sessions, input.cwd, input.processStartMs);
  if (confirmed.conflict) return { state: 'skip' };
  const unique = [...new Set(confirmed.ids)];
  if (flags.resume) {
    const resolved = resolveToken(flags.resume, sessions);
    if (resolved.ambiguous) return { state: 'skip' };
    if (!resolved.id) return unique.length ? { state: 'skip' } : { state: 'pending' };
    const named = sessions.find((snap) => snap.id === resolved.id);
    // A fresh `copilot` in this folder rewrites workspace.yaml and does not write session.resume.
    // That file must not crowd out the session this argv named.
    if (matchingResume(named, input.cwd, input.processStartMs)) return { state: 'resume', sessionId: resolved.id };
    if (!unique.length) return { state: 'pending' };
    if (unique.length === 1 && unique[0] === resolved.id) return { state: 'resume', sessionId: resolved.id };
    return { state: 'skip' };
  }
  // `--continue`, or `--resume` with no id (the picker). One post-start session for this cwd is that resume.
  if (unique.length === 1) return { state: 'resume', sessionId: unique[0] as string };
  if (unique.length > 1) return { state: 'skip' };
  return { state: 'pending' };
}

function copilotHome(): string {
  return configuredEnv('COPILOT_HOME') || path.join(os.homedir(), '.copilot');
}

function processStartMs(pid: number): number {
  const start = procStart(pid);
  if (!start) return Number.NaN;
  return Date.parse(start);
}

export type CopilotClaim =
  | { state: 'claimed'; sessionId: string }
  | { state: 'pending' }
  | { state: 'skip' };

/**
 * Binds this Copilot process to the resumed session id, the same binding sessionStart performs later.
 * A second call, including the hook's, keeps that id and does not add another owner. Already-linked
 * processes are left as they are.
 */
export function claimResumedCopilot(pid: number, hint?: { cwd?: string }): CopilotClaim {
  const linked = linkedPeerId('copilot', pid);
  if (linked) {
    const sessionId = linked.startsWith('copilot-') ? linked.slice('copilot-'.length) : linked;
    return { state: 'claimed', sessionId };
  }
  const look = detectResumedCopilotSession({
    argv: commandLine(pid) ?? '',
    cwd: processCwd(pid) || hint?.cwd,
    processStartMs: processStartMs(pid),
    copilotHome: copilotHome(),
  });
  if (look.state !== 'resume') return look;
  registerSession('copilot', pid, {
    sessionId: look.sessionId,
    cwd: processCwd(pid) || hint?.cwd,
    source: 'process',
    transcriptPath: copilotEventsFile(look.sessionId),
  });
  return { state: 'claimed', sessionId: look.sessionId };
}
