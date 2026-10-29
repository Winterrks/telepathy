import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { debugLog } from './debug.ts';
import { confirmWaitEnabled, transcriptHasMarker } from './confirm.ts';
import { archivePending, formatForClaudeSocket, messageMarker, pendingMessages } from './messages.ts';
import { ensureDir, envDurationMs, inboxDir, peerDir, readJson, writeJsonAtomic } from './paths.ts';
import { claudeConfigDir, isDeliveryOwner, type Peer, readPeer, sessionOwners } from './peers.ts';
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
  /** Claude pid that owned delivery when this path was written. A duplicate window must not replace it. */
  ownerPid?: number;
}

export type InboundPolicy = 'accept' | 'hold' | 'refuse';

const INBOUND_RANK: Record<InboundPolicy, number> = { accept: 0, hold: 1, refuse: 2 };

function socketFromEnv(env: NodeJS.ProcessEnv): ClaudeSocket | undefined {
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!socketPath) return undefined;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  return { path: socketPath, ...(token ? { token } : {}) };
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

/**
 * Records the socket this Claude process exported. `ownerPid` is that Claude process. A second window on the
 * same session has its own `CLAUDE_CODE_MESSAGING_SOCKET`; writing it here would make the owner post into the
 * other window. When `ownerPid` is set and it is not the delivery owner, this does not write.
 */
export function recordClaudeSocket(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  ownerPid?: number,
): ClaudeSocket | undefined {
  const sock = socketFromEnv(env);
  if (!sock) return undefined;
  if (ownerPid !== undefined && !isDeliveryOwner(id, ownerPid)) {
    debugLog('claude-socket', `${id} pid ${ownerPid} is not the delivery owner; not recording its socket`);
    return undefined;
  }
  const record: SocketRecord = {
    ...sock,
    ...(ownerPid !== undefined ? { ownerPid } : {}),
    recordedAt: new Date().toISOString(),
  };
  writeJsonAtomic(socketFile(id), record);
  return sock;
}

export function readClaudeSocket(id: string): ClaudeSocket | undefined {
  const record = readJson<SocketRecord>(socketFile(id));
  if (!record?.path) return undefined;
  if (typeof record.ownerPid === 'number') {
    const owners = sessionOwners(id);
    if (owners.length > 0 && owners[0]?.pid !== record.ownerPid) return undefined;
  }
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

function readInbound(file: string): InboundPolicy | undefined {
  const value = readJson<{ crossSessionInbound?: unknown }>(file)?.crossSessionInbound;
  if (value === 'accept' || value === 'hold' || value === 'refuse') return value;
  return undefined;
}

/** Directory of `managed-settings.json`. `TELEPATHY_MANAGED_SETTINGS_DIR` isolates tests from the machine policy. */
function managedSettingsDir(): string {
  if (process.env.TELEPATHY_MANAGED_SETTINGS_DIR) return process.env.TELEPATHY_MANAGED_SETTINGS_DIR;
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (process.platform === 'win32') return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode');
  return '/etc/claude-code';
}

/**
 * Managed `crossSessionInbound`. `managed-settings.json` is merged first, then each `managed-settings.d/*.json`
 * in alphabetical order; a later scalar replaces an earlier one. MDM and server-managed settings are not on disk.
 * https://code.claude.com/docs/en/managed-settings (retrieved 28 Oct 2026).
 */
function managedInbound(): InboundPolicy | undefined {
  const dir = managedSettingsDir();
  let found = readInbound(path.join(dir, 'managed-settings.json'));
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(path.join(dir, 'managed-settings.d'))
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .sort();
  } catch {
    // no drop-in directory
  }
  for (const name of names) {
    const value = readInbound(path.join(dir, 'managed-settings.d', name));
    if (value) found = value;
  }
  return found;
}

/**
 * Effective `crossSessionInbound` from the files this process can read.
 *
 * Precedence, highest first: managed, then `--settings` (not visible here), project local, shared project, user.
 * Exception from the settings page: a stricter project or local value on the `accept < hold < refuse` ladder
 * beats managed, `--settings`, and user. A project or local value that is not stricter is ignored.
 * https://code.claude.com/docs/en/settings (retrieved 28 Oct 2026).
 */
export function crossSessionInbound(peer: Peer | undefined): InboundPolicy | undefined {
  const managed = managedInbound();
  const user = readInbound(path.join(claudeConfigDir(), 'settings.json'));
  // `--settings` sits between managed and user and is not a file we can see.
  const higher = managed ?? user;
  const project = peer?.cwd ? readInbound(path.join(peer.cwd, '.claude', 'settings.json')) : undefined;
  const local = peer?.cwd ? readInbound(path.join(peer.cwd, '.claude', 'settings.local.json')) : undefined;
  let effective = higher;
  for (const value of [project, local]) {
    if (!value) continue;
    if (higher === undefined || INBOUND_RANK[value] > INBOUND_RANK[higher]) effective = value;
  }
  return effective;
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
export function socketConfirms(post: SocketPost, inbound: InboundPolicy | undefined, ownChild: boolean): boolean {
  if (post.outcome === 'held' || post.outcome === 'refused' || post.outcome === 'expired' || post.outcome === 'failed') return false;
  if (post.outcome === 'delivered') return true;
  if (!ownChild) return false;
  return inbound === undefined || inbound === 'accept';
}

let flushImpl: ((id: string) => Promise<SocketOutcome | 'idle' | 'blocked'>) | undefined;

/**
 * Posts pending messages from this process, which is the recipient's server. Archives a message only when
 * confirmed. `blocked` means `crossSessionInbound` is hold or refuse, so nothing was written.
 */
export async function flushClaudeSocket(id: string): Promise<SocketOutcome | 'idle' | 'blocked'> {
  if (flushImpl) return flushImpl(id);
  return 'idle';
}

/**
 * After crossSessionInbound or the socket path changes, wait before posting again. Claude's own "Released"
 * can land in the transcript in that gap; a second post is what shows "(2 held)" and "Dropped a peer message".
 */
export function holdRepostDelayMs(): number {
  return envDurationMs('TELEPATHY_HOLD_REPOST_DELAY_MS', 2_000);
}

/**
 * Started by the Claude session's own MCP server. Other agents' servers must not start it: they are not the
 * session's child, and a post from them is an ordinary peer message that the default inbound rules may hold.
 * Returns a stop function.
 */
export function startClaudeSocketWatcher(id: string, ownerPid?: number): () => void {
  let chain: Promise<unknown> = Promise.resolve();

  // A held or unconfirmed post is a message Claude already has. Posting it again on the 1s tick opens another
  // "Held peer message" notice (Claude caps those at 100). Retry only when the socket path changes, the
  // crossSessionInbound value changes, or a failed connect is 10s old. A failed connect never reached Claude.
  const posted = new Map<string, { socketPath: string; inbound: string; outcome: SocketOutcome; at: number; changeKey?: string; changeAt?: number }>();
  let blockedLog: string | undefined;
  const FAILED_RETRY_MS = 10_000;

  const flush = async (): Promise<SocketOutcome | 'idle' | 'blocked'> => {
    // A duplicate window's server must not post: its socket is a different process.
    if (ownerPid !== undefined && !isDeliveryOwner(id, ownerPid)) {
      clearArmed(id);
      return 'idle';
    }
    // Tests start the watcher without an owner pid and point it at a recorded path. The owner's server passes
    // its pid and posts the socket this process inherited, which a duplicate window cannot overwrite.
    const envSock = ownerPid !== undefined ? socketFromEnv(process.env) : undefined;
    if (envSock) recordClaudeSocket(id, process.env, ownerPid);
    const sock = envSock ?? readClaudeSocket(id);
    if (!sock) {
      clearArmed(id);
      return 'idle';
    }
    writeArmed(id);
    const pending = pendingMessages(id);
    if (!pending.length) {
      posted.clear();
      return 'idle';
    }
    const inbound = crossSessionInbound(readPeer(id));
    // hold and refuse both keep the bytes where a later failure can still withdraw them. A post Claude has
    // queued as held is delivered when the user clears the hold, after the sender was already told it failed.
    if (inbound === 'hold' || inbound === 'refuse') {
      if (blockedLog !== inbound) {
        debugLog('claude-socket', `${id} crossSessionInbound is ${inbound}; not posting`);
        blockedLog = inbound;
      }
      return 'blocked';
    }
    blockedLog = undefined;
    const inboundKey = inbound ?? '';
    const pendingIds = new Set(pending.map((msg) => msg.id));
    for (const seen of posted.keys()) if (!pendingIds.has(seen)) posted.delete(seen);
    let last: SocketOutcome = 'unconfirmed';
    for (const msg of pending) {
      const prev = posted.get(msg.id);
      const marker = messageMarker(msg.id);
      if (transcriptHasMarker(readPeer(id), marker)) {
        archivePending(id, msg.id);
        posted.delete(msg.id);
        last = 'delivered';
        continue;
      }
      // A reply of held, refused, or expired means Claude already has the bytes. Posting again cannot be recalled.
      if (prev && (prev.outcome === 'held' || prev.outcome === 'refused' || prev.outcome === 'expired')) {
        last = prev.outcome;
        continue;
      }
      const settingKey = `${sock.path}\0${inboundKey}`;
      if (prev && (prev.socketPath !== sock.path || prev.inbound !== inboundKey)) {
        let changeAt = prev.changeAt ?? 0;
        if (prev.changeKey !== settingKey) {
          changeAt = Date.now();
          posted.set(msg.id, { ...prev, changeKey: settingKey, changeAt });
        }
        if (Date.now() - changeAt < holdRepostDelayMs()) {
          last = prev.outcome;
          continue;
        }
        if (transcriptHasMarker(readPeer(id), marker)) {
          archivePending(id, msg.id);
          posted.delete(msg.id);
          last = 'delivered';
          continue;
        }
      } else if (prev && prev.socketPath === sock.path && prev.inbound === inboundKey) {
        const failedWait = prev.outcome === 'failed' && Date.now() - prev.at < FAILED_RETRY_MS;
        const heldBack =
          prev.outcome === 'unconfirmed' ||
          prev.outcome === 'held' ||
          prev.outcome === 'refused' ||
          prev.outcome === 'expired' ||
          prev.outcome === 'delivered';
        if (failedWait || heldBack) {
          if (confirmWaitEnabled() && transcriptHasMarker(readPeer(id), marker)) {
            archivePending(id, msg.id);
            posted.delete(msg.id);
            last = 'delivered';
            continue;
          }
          last = prev.outcome;
          continue;
        }
      }
      const post = await postClaudeSocket(sock, formatForClaudeSocket(msg));
      const confirmed = socketConfirms(post, inbound, true);
      last = post.outcome === 'unconfirmed' && confirmed ? 'delivered' : post.outcome;
      debugLog('claude-socket', `${msg.id} ${last}${post.detail ? ` (${post.detail})` : ''}`);
      const inTranscript = confirmed && (!confirmWaitEnabled() || transcriptHasMarker(readPeer(id), marker));
      if (inTranscript) {
        archivePending(id, msg.id);
        posted.delete(msg.id);
      } else {
        posted.set(msg.id, {
          socketPath: sock.path,
          inbound: inboundKey,
          outcome: confirmed ? 'delivered' : post.outcome,
          at: Date.now(),
        });
      }
    }
    return last;
  };

  const enqueue = (peerId: string): Promise<SocketOutcome | 'idle' | 'blocked'> => {
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
