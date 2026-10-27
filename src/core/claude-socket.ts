import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { debugLog } from './debug.ts';
import { archivePending, formatAsUserTurn, pendingMessages } from './messages.ts';
import { ensureDir, inboxDir, peerDir, readJson, writeJsonAtomic } from './paths.ts';
import { claudeConfigDir, type Peer, readPeer } from './peers.ts';
import { isSameProcess, procStart } from './proc.ts';

/**
 * Claude Code's per-session inbox socket, documented at
 * https://code.claude.com/docs/en/cross-session-messaging (retrieved 27 Oct 2026).
 *
 * The session exports `CLAUDE_CODE_MESSAGING_SOCKET` to hooks and Bash (a Unix socket on macOS and Linux, a named
 * pipe on native Windows) and, since v2.1.228, `CLAUDE_CODE_MESSAGING_TOKEN`. Messaging itself needs v2.1.224 or
 * later on macOS and Linux, and v2.1.234 or later on native Windows. Bare mode binds no socket. Some builds only
 * bound one when a flag (`CLAUDE_CODE_HARBOR_KITE` / `tengu_harbor_kite`) was on; a missing path is that case, so
 * availability is the path, not the flag.
 *
 * A poster writes newline-delimited JSON. The auth line is optional on macOS and Linux and required on native
 * Windows. The message line is `{"type":"user","message":{"role":"user","content":"..."}}`. A line must finish
 * within 30 seconds, and the serialized message must stay under about 1 MiB.
 *
 * Own-child delivery: when no `crossSessionInbound` value applies, Claude delivers a post it can verify came from
 * the session's own child (a hook or Bash command are the examples; process evidence is the check, and on macOS
 * that evidence exists only while the child is still running). Telepathy's MCP server is a child of the Claude
 * session, so the watcher below posts from that process and sends the token, which is how macOS and Windows
 * verify a child when the process tree is not enough. A sender in another agent's process is not that child.
 * An explicit hold, refuse, or expiry is not delivery. The docs do not define a reply line; if one arrives with
 * type `held`, `refused`, or `expired`, it wins over the own-child rule.
 */

export const SOCKET_LINE_MAX = 1024 * 1024;

export interface ClaudeSocket {
  path: string;
  token?: string;
}

interface SocketRecord extends ClaudeSocket {
  recordedAt: string;
}

interface ListenerRecord {
  pid: number;
  procStart?: string;
  at: string;
}

export type SocketOutcome = 'delivered' | 'held' | 'refused' | 'expired' | 'unconfirmed' | 'failed';

export interface SocketPost {
  outcome: SocketOutcome;
  /** Safe to log: no token, no message text. */
  detail?: string;
}

const socketFile = (id: string) => path.join(peerDir(id), 'socket.json');
const listenerFile = (id: string) => path.join(peerDir(id), 'socket-listener.json');

export function recordClaudeSocket(id: string, env: NodeJS.ProcessEnv = process.env): ClaudeSocket | undefined {
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!socketPath) return undefined;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  const record: SocketRecord = { path: socketPath, ...(token ? { token } : {}), recordedAt: new Date().toISOString() };
  writeJsonAtomic(socketFile(id), record);
  return { path: socketPath, ...(token ? { token } : {}) };
}

export function readClaudeSocket(id: string): ClaudeSocket | undefined {
  const record = readJson<SocketRecord>(socketFile(id));
  if (!record?.path) return undefined;
  return { path: record.path, ...(record.token ? { token: record.token } : {}) };
}

/** True while the recipient's own server is posting to the socket. The monitor stays out of its way. */
export function claudeSocketArmed(id: string): boolean {
  const record = readJson<ListenerRecord>(listenerFile(id));
  return !!record && isSameProcess(record.pid, record.procStart);
}

function writeArmed(id: string): void {
  const record: ListenerRecord = { pid: process.pid, procStart: procStart(process.pid), at: new Date().toISOString() };
  writeJsonAtomic(listenerFile(id), record);
}

function clearArmed(id: string): void {
  try {
    if (readJson<ListenerRecord>(listenerFile(id))?.pid === process.pid) fs.rmSync(listenerFile(id), { force: true });
  } catch {
    // already gone
  }
}

/**
 * `crossSessionInbound` from the settings files this session can see. Any value, in any of them, means the
 * own-child exception does not apply. The full precedence (managed settings, `--settings`) is not visible here.
 */
export function crossSessionInbound(peer: Peer | undefined): 'accept' | 'hold' | 'refuse' | undefined {
  const files = [
    peer?.cwd ? path.join(peer.cwd, '.claude', 'settings.local.json') : '',
    peer?.cwd ? path.join(peer.cwd, '.claude', 'settings.json') : '',
    path.join(claudeConfigDir(), 'settings.json'),
  ].filter(Boolean);
  let found: 'accept' | 'hold' | 'refuse' | undefined;
  for (const file of files) {
    const value = readJson<{ crossSessionInbound?: unknown }>(file)?.crossSessionInbound;
    if (value === 'accept' || value === 'hold' || value === 'refuse') found = value;
  }
  return found;
}

const classify = (line: string): SocketOutcome | undefined => {
  let type = '';
  try {
    const msg = JSON.parse(line) as { type?: unknown; outcome?: unknown; status?: unknown };
    type = String(msg.type ?? msg.outcome ?? msg.status ?? '').toLowerCase();
  } catch {
    return undefined;
  }
  if (type === 'delivered') return 'delivered';
  if (type === 'held' || type === 'hold') return 'held';
  if (type === 'refused' || type === 'refuse') return 'refused';
  if (type === 'expired') return 'expired';
  return undefined;
};

const scrub = (text: string, token: string | undefined) => (token && token.length >= 4 ? text.split(token).join('[redacted]') : text);

/**
 * Writes one message to the socket. Does not claim the inbox. `timeoutMs` bounds the whole connection; Claude
 * itself closes a connection that has not finished a line within 30 seconds.
 */
export function postClaudeSocket(sock: ClaudeSocket, content: string, timeoutMs = 10_000): Promise<SocketPost> {
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content } })];
  if (sock.token) lines.unshift(JSON.stringify({ type: 'auth', token: sock.token }));
  const payload = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(payload) > SOCKET_LINE_MAX) {
    return Promise.resolve({ outcome: 'failed', detail: 'message is over the 1 MiB socket cap' });
  }
  if (process.platform === 'win32' && !sock.token) {
    return Promise.resolve({ outcome: 'failed', detail: 'native Windows requires CLAUDE_CODE_MESSAGING_TOKEN' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    let reply: SocketPost | undefined;
    const socket = net.createConnection(sock.path);
    const finish = (result: SocketPost) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(replyTimer);
      socket.destroy();
      resolve({ ...result, detail: result.detail ? scrub(result.detail, sock.token) : result.detail });
    };
    const timer = setTimeout(() => finish(reply ?? { outcome: 'unconfirmed' }), timeoutMs);
    let replyTimer: ReturnType<typeof setTimeout> | undefined;
    socket.on('connect', () => {
      socket.write(payload);
      // Claude does not document a reply. A line that does arrive is honored; otherwise the caller applies the
      // own-child rule. Don't hold the sender's turn open for the 30s server deadline.
      replyTimer = setTimeout(() => finish(reply ?? { outcome: 'unconfirmed' }), 300);
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        const outcome = line.trim() ? classify(line) : undefined;
        if (!outcome) continue;
        reply = { outcome };
        finish(reply);
        return;
      }
    });
    socket.on('error', (err) => finish({ outcome: 'failed', detail: err.message }));
    socket.on('close', () => finish(reply ?? { outcome: 'unconfirmed' }));
  });
}

/**
 * Own-child rule from the docs: with no `crossSessionInbound` value, a verified child is delivered. `accept`
 * is also delivery. `hold` and `refuse` are not, and an explicit reply of held, refused, or expired is not.
 */
export function socketConfirms(post: SocketPost, inbound: 'accept' | 'hold' | 'refuse' | undefined, ownChild: boolean): boolean {
  if (post.outcome === 'held' || post.outcome === 'refused' || post.outcome === 'expired' || post.outcome === 'failed') return false;
  if (post.outcome === 'delivered') return true;
  if (!ownChild) return false;
  return inbound === undefined || inbound === 'accept';
}

let flushImpl: ((id: string) => Promise<SocketOutcome | 'idle'>) | undefined;

/** Posts pending messages from this process, which is the recipient's server. Archives a message only when confirmed. */
export async function flushClaudeSocket(id: string): Promise<SocketOutcome | 'idle'> {
  if (flushImpl) return flushImpl(id);
  return 'idle';
}

/**
 * Started by the Claude session's own MCP server. Other agents' servers must not start it: they are not the
 * session's child, and a post from them is an ordinary peer message that the default inbound rules may hold.
 * Returns a stop function.
 */
export function startClaudeSocketWatcher(id: string): () => void {
  let chain: Promise<unknown> = Promise.resolve();

  const flush = async (): Promise<SocketOutcome | 'idle'> => {
    const sock = readClaudeSocket(id) ?? recordClaudeSocket(id);
    if (!sock) {
      clearArmed(id);
      return 'idle';
    }
    writeArmed(id);
    const pending = pendingMessages(id);
    if (!pending.length) return 'idle';
    const inbound = crossSessionInbound(readPeer(id));
    if (inbound === 'refuse') {
      debugLog('claude-socket', `${id} crossSessionInbound is refuse; leaving ${pending.length} message(s) in the inbox`);
      return 'refused';
    }
    let last: SocketOutcome = 'unconfirmed';
    for (const msg of pending) {
      const post = await postClaudeSocket(sock, formatAsUserTurn(msg));
      last = post.outcome === 'unconfirmed' && socketConfirms(post, inbound, true) ? 'delivered' : post.outcome;
      debugLog('claude-socket', `${msg.id} ${last}${post.detail ? ` (${post.detail})` : ''}`);
      if (socketConfirms(post, inbound, true)) archivePending(id, msg.id);
    }
    return last;
  };

  const enqueue = (peerId: string): Promise<SocketOutcome | 'idle'> => {
    if (peerId !== id) return Promise.resolve('idle');
    const run = chain.then(flush, flush);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  flushImpl = enqueue;
  let watcher: fs.FSWatcher | undefined;
  const arm = () => {
    try {
      ensureDir(inboxDir(id));
      if (watcher) return;
      watcher = fs.watch(inboxDir(id), () => void enqueue(id));
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  };
  arm();
  const timer = setInterval(() => {
    arm();
    void enqueue(id);
  }, 1000);
  timer.unref();
  void enqueue(id);

  return () => {
    clearInterval(timer);
    watcher?.close();
    if (flushImpl) flushImpl = undefined;
    clearArmed(id);
  };
}
