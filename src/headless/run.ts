import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../core/agents.ts';
import { isAlive, procStart } from '../core/proc.ts';
import { VERSION } from '../core/version.ts';
import { startAcpSession } from '../acp/host.ts';
import { LineRpc } from '../acp/rpc.ts';
import {
  clearHosted,
  headlessLogPath,
  namedPeerId,
  readHeadlessRecord,
  recallHarnessSession,
  registerHostedPeer,
  rememberHarnessSession,
  startInboxPump,
  writeHeadlessRecord,
  type HeadlessRecord,
} from './peer.ts';

export interface HeadlessRun {
  agent: Agent;
  /** Which control plane. `acp` uses `acpBin` / `acpArgs`; the others spawn `bin`. */
  plane: 'claude' | 'codex' | 'opencode' | 'acp' | 'antigravity';
  bin: string;
  userArgs: string[];
  acpArgs?: string[];
  cwd: string;
  name: string;
  /** Spawned process environment, including `TELEPATHY_NAME` when the plugin is the peer. */
  env?: NodeJS.ProcessEnv;
  /** The harness plugin already registers this name. Do not add a second host peer. */
  pluginPeer?: boolean;
}

interface Plane {
  child: ChildProcess;
  exited: Promise<number>;
  inject(text: string, stillPending: () => boolean): Promise<boolean>;
}

interface Memory {
  id?: string;
  changed?: () => void;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });

function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on('error', () => resolve(127));
    child.on('exit', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGINT') resolve(0);
      else resolve(code ?? 1);
    });
  });
}

function ignoreStdinErrors(child: ChildProcess): void {
  child.stdin?.on('error', () => {});
}

function threadIdOf(result: unknown): string | undefined {
  const body = result as { thread?: { id?: unknown }; threadId?: unknown; id?: unknown };
  const id = body?.thread?.id ?? body?.threadId ?? body?.id;
  return typeof id === 'string' && id ? id : undefined;
}

function findUrl(text: string): string | undefined {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
  const match = /https?:\/\/[^\s]+/.exec(clean);
  return match?.[0].replace(/[)\].,]+$/, '');
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function idFromJson(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { id?: unknown; sessionID?: unknown; sessionId?: unknown };
    const id = body.id ?? body.sessionID ?? body.sessionId;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keeps one headless peer in the foreground until the child exits or this process is signalled.
 * `--name` reuses `<agent>-h-<slug>` and the harness session id from the last run.
 */
export async function runHeadless(options: HeadlessRun): Promise<number> {
  const { peerId, slug } = namedPeerId(options.agent, options.name);
  const previous = readHeadlessRecord(options.agent, slug);
  if (previous && isAlive(previous.pid) && previous.pid !== process.pid) {
    throw new Error(`${options.agent}:${slug} is already running (pid ${previous.pid}). Stop it with \`telepathy stop ${options.agent}:${slug}\`.`);
  }
  const memory: { id?: string; changed?: () => void } = { id: recallHarnessSession(peerId) ?? previous?.harnessSessionId };
  const logFile = headlessLogPath(options.agent, slug);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const writeLog = (text: string) => {
    log.write(text);
  };

  const plane = await openPlane(options, memory, writeLog);
  const pluginPeer = options.pluginPeer === true;
  const hosted = pluginPeer
    ? { peerId, slug, address: `${options.agent}:${slug}` }
    : registerHostedPeer(options.agent, options.cwd, options.name);
  const persist = () => {
    if (!pluginPeer && memory.id) rememberHarnessSession(hosted.peerId, memory.id);
    const record: HeadlessRecord = {
      name: options.name,
      slug,
      agent: options.agent,
      peerId: hosted.peerId,
      pid: process.pid,
      procStart: procStart(process.pid),
      cwd: options.cwd,
      logFile,
      harnessSessionId: memory.id,
      startedAt: previous?.startedAt ?? new Date().toISOString(),
    };
    writeHeadlessRecord(record);
  };
  memory.changed = persist;
  persist();
  const stopPump = pluginPeer ? () => {} : startInboxPump(hosted.peerId, (text, stillPending) => plane.inject(text, stillPending));
  let stopping = false;
  const shutdown = () => {
    stopping = true;
    if (plane.child.exitCode === null && !plane.child.killed) plane.child.kill('SIGTERM');
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stderr.write(`telepathy: headless ${hosted.address} [${hosted.peerId}] is up (pid ${process.pid}). Log: ${logFile}\n`);
  try {
    const code = await plane.exited;
    return stopping ? 0 : code;
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    stopPump();
    if (!pluginPeer) clearHosted(hosted.peerId);
    persist();
    log.end();
  }
}

async function openPlane(options: HeadlessRun, memory: Memory, writeLog: (text: string) => void): Promise<Plane> {
  if (options.plane === 'claude') return startClaude(options, memory, writeLog);
  if (options.plane === 'codex') return startCodex(options, memory, writeLog);
  if (options.plane === 'opencode') return startOpencode(options, memory, writeLog);
  if (options.plane === 'antigravity') return startAntigravity(options, memory, writeLog);
  return startAcp(options, memory, writeLog);
}

const AGY_AUTH_RE = /not logged in|login required|authentication (?:failed|required)|please run \S+ login|unauthorized|invalid api key|credentials? (?:not found|missing|expired)/i;

function conversationFlag(args: string[]): string | undefined {
  const index = args.indexOf('--conversation');
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

/**
 * Long-lived `agy --input-format stream-json --output-format stream-json`. Prompts are `user` events on stdin.
 * There is no `agy --acp`. Do not wrap `agy -p`: that is the consumer-login path the FAQ warns against.
 * `--conversation <uuid>` resumes the same conversation. A later init with a different id is a new conversation.
 */
function startAntigravity(options: HeadlessRun, memory: Memory, writeLog: (text: string) => void): Plane {
  const args: string[] = [];
  if (!options.userArgs.includes('--input-format')) args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
  const explicit = conversationFlag(options.userArgs);
  const resume = explicit ?? memory.id;
  if (resume && !explicit) args.push('--conversation', resume);
  args.push(...options.userArgs);
  const child = spawn(options.bin, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  ignoreStdinErrors(child);
  let buf = '';
  let stderr = '';
  let ready = false;
  let authFailed = false;
  const failAuth = (text: string) => {
    if (ready || authFailed || !AGY_AUTH_RE.test(text)) return;
    authFailed = true;
    if (child.exitCode === null) child.kill('SIGTERM');
  };
  const take = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const text = chunk.toString();
    writeLog(text);
    if (stream === 'stderr') {
      stderr += text;
      failAuth(stderr);
      return;
    }
    buf += text;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as {
          event?: string;
          conversation_id?: unknown;
          step_update?: { text_delta?: unknown; conversation_id?: unknown };
          result?: { conversation_id?: unknown };
        };
        const id = msg.conversation_id ?? msg.step_update?.conversation_id ?? msg.result?.conversation_id;
        if (typeof id === 'string' && id && id !== memory.id) {
          memory.id = id;
          memory.changed?.();
          ready = true;
          process.stderr.write(`telepathy: antigravity conversation ${id}\n`);
        }
        if (msg.event === 'init') ready = true;
        const delta = msg.step_update?.text_delta;
        if (typeof delta === 'string' && delta) process.stdout.write(delta);
      } catch {
        // a non-JSON log line
      }
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => take(chunk, 'stdout'));
  child.stderr?.on('data', (chunk: Buffer) => take(chunk, 'stderr'));
  return {
    child,
    exited: exitCode(child).then((code) => (authFailed ? 1 : code)),
    inject: (text, stillPending) => writeAgyTurn(child, text, stillPending),
  };
}

function writeAgyTurn(child: ChildProcess, text: string, stillPending: () => boolean): Promise<boolean> {
  if (!stillPending() || !child.stdin?.writable || child.exitCode !== null) return Promise.resolve(false);
  const line = JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
  return new Promise((resolve) => {
    if (!stillPending()) {
      resolve(false);
      return;
    }
    child.stdin?.write(line, (err) => resolve(!err && child.exitCode === null && stillPending()));
  });
}

function startClaude(options: HeadlessRun, memory: Memory, writeLog: (text: string) => void): Plane {
  const resume = memory.id;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (resume) args.push('--resume', resume);
  args.push(...options.userArgs);
  const child = spawn(options.bin, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  ignoreStdinErrors(child);
  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    writeLog(text);
    buf += text;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as { session_id?: unknown; sessionId?: unknown };
        const id = msg.session_id ?? msg.sessionId;
        if (typeof id === 'string' && id && id !== memory.id) {
          memory.id = id;
          memory.changed?.();
          process.stderr.write(`telepathy: claude session ${id}\n`);
        }
      } catch {
        // a non-JSON log line
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    writeLog(chunk.toString());
  });
  return {
    child,
    exited: exitCode(child),
    inject: (text, stillPending) => writeClaudeTurn(child, text, stillPending),
  };
}

function writeClaudeTurn(child: ChildProcess, text: string, stillPending: () => boolean): Promise<boolean> {
  if (!stillPending() || !child.stdin?.writable || child.exitCode !== null) return Promise.resolve(false);
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  return new Promise((resolve) => {
    if (!stillPending()) {
      resolve(false);
      return;
    }
    child.stdin?.write(line, (err) => {
      if (err || child.exitCode !== null) {
        resolve(false);
        return;
      }
      if (!stillPending()) {
        writeClaudeInterrupt(child);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/** Best-effort cancel for a stream-json user turn that `fail()` withdrew after the line was written. */
function writeClaudeInterrupt(child: ChildProcess): void {
  const line =
    JSON.stringify({
      type: 'control_request',
      request_id: `telepathy-interrupt-${Date.now()}`,
      request: { subtype: 'interrupt' },
    }) + '\n';
  child.stdin?.write(line, () => {});
}

async function startCodex(options: HeadlessRun, memory: Memory, writeLog: (text: string) => void): Promise<Plane> {
  const child = spawn(options.bin, ['app-server', ...options.userArgs], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  ignoreStdinErrors(child);
  child.stdout?.on('data', (chunk: Buffer) => {
    writeLog(chunk.toString());
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    writeLog(chunk.toString());
  });
  const rpc = new LineRpc(
    child,
    async (method, _params, id) => rpc.fail(id, `unexpected ${method}`),
    () => {},
  );
  try {
  await withTimeout(
    rpc.request('initialize', {
      clientInfo: { name: 'telepathy', version: VERSION },
      capabilities: { experimentalApi: true },
    }),
    15_000,
    'codex initialize',
  );
  rpc.notify('initialized');
  let result: unknown;
  if (memory.id) {
    try {
      result = await withTimeout(rpc.request('thread/resume', { threadId: memory.id, cwd: options.cwd }), 15_000, 'thread/resume');
    } catch {
      result = undefined;
    }
  }
  if (!threadIdOf(result)) {
    result = await withTimeout(rpc.request('thread/start', { cwd: options.cwd }), 15_000, 'thread/start');
  }
  const threadId = threadIdOf(result);
  if (!threadId) {
    child.kill('SIGTERM');
    throw new Error('codex app-server did not return a thread id');
  }
  memory.id = threadId;
  return {
    child,
    exited: exitCode(child),
    inject: async (text, stillPending) => {
      if (!stillPending()) return false;
      try {
        await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }] });
        if (child.exitCode !== null) return false;
        if (!stillPending()) {
          void rpc.request('turn/interrupt', { threadId }).catch(() => {});
          return false;
        }
        return true;
      } catch {
        return false;
      }
    },
  };
  } catch (err) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw err;
  }
}

async function startOpencode(options: HeadlessRun, memory: Memory, writeLog: (text: string) => void): Promise<Plane> {
  const child = spawn(options.bin, ['serve', ...options.userArgs], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  ignoreStdinErrors(child);
  let buffered = '';
  let listen = '';
  const urlReady = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${options.bin} serve did not print a listen URL`)), 15_000);
    const take = (chunk: Buffer) => {
      const text = chunk.toString();
      writeLog(text);
      buffered += text;
      const found = findUrl(buffered);
      if (!found || listen) return;
      listen = found;
      clearTimeout(timer);
      resolve(found.replace(/\/$/, ''));
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('exit', () => {
      if (!listen) {
        clearTimeout(timer);
        reject(new Error(`${options.bin} serve exited before printing a listen URL`));
      }
    });
  });
  try {
    const base = await urlReady;
    let sessionId = memory.id;
    if (sessionId && !(await sessionExists(base, sessionId))) sessionId = undefined;
    if (!sessionId) sessionId = await createSession(base);
    if (!sessionId) throw new Error(`${options.bin} serve did not return a session id`);
    memory.id = sessionId;
    return {
      child,
      exited: exitCode(child),
      inject: (text, stillPending) => promptSession(base, sessionId as string, text, stillPending),
    };
  } catch (err) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw err;
  }
}

async function sessionExists(base: string, id: string): Promise<boolean> {
  for (const path of [`/api/session/${id}`, `/session/${id}`]) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) continue;
      return res.ok;
    } catch {
      return false;
    }
  }
  return false;
}

async function createSession(base: string): Promise<string | undefined> {
  for (const path of ['/api/session', '/session']) {
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) continue;
      if (!res.ok) return undefined;
      return idFromJson(await readBody(res));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function promptSession(base: string, id: string, text: string, stillPending: () => boolean): Promise<boolean> {
  if (!stillPending()) return false;
  const body = JSON.stringify({ parts: [{ type: 'text', text }], delivery: 'steer' });
  for (const path of [`/api/session/${id}/prompt`, `/session/${id}/prompt`, `/session/${id}/message`, `/api/session/${id}/message`]) {
    if (!stillPending()) return false;
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) continue;
      return res.ok && stillPending();
    } catch {
      return false;
    }
  }
  return false;
}

async function startAcp(options: HeadlessRun, memory: Memory, writeLog: (text: string) => void): Promise<Plane> {
  const session = await startAcpSession({
    agent: options.agent,
    bin: options.bin,
    args: [...(options.acpArgs ?? []), ...options.userArgs],
    cwd: options.cwd,
    headless: true,
    resumeSessionId: memory.id,
    env: options.env,
    emit: (line) => {
      const text = line.endsWith('\n') ? line : line + '\n';
      process.stdout.write(text);
      writeLog(text);
    },
    stream: (text) => {
      process.stdout.write(text);
      writeLog(text);
    },
    trace: writeLog,
  });
  memory.id = session.sessionId;
  return { child: session.child, exited: session.exited, inject: (text, stillPending) => session.prompt(text, stillPending) };
}
