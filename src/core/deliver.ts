import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  archiveMessage,
  formatForCodex,
  MAX_MESSAGE_CHARS,
  type Message,
  newMessageId,
  partyOf,
  writeToInbox,
} from './messages.ts';
import { peerDir, readJson, writeJsonAtomic } from './paths.ts';
import { agentLabel, listPeers, type Peer, peerRef, resolvePeer } from './peers.ts';

const execFileAsync = promisify(execFile);

export type SendResult =
  | { ok: true; message: Message; recipient: Peer; status: string }
  | { ok: false; error: string };

// Loop guard. Two agents that auto-reply to each other would otherwise ping-pong forever.
const DUPLICATE_WINDOW_MS = 2 * 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_PER_RECIPIENT = 20;

interface SentEntry {
  to: string;
  hash: string;
  at: number;
}

const sentLogFile = (selfId: string) => path.join(peerDir(selfId), 'sent-log.json');

function checkRate(selfId: string, toId: string, body: string): string | undefined {
  const now = Date.now();
  const log = (readJson<SentEntry[]>(sentLogFile(selfId)) ?? []).filter((e) => now - e.at < RATE_WINDOW_MS);
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  const dup = log.find((e) => e.to === toId && e.hash === hash && now - e.at < DUPLICATE_WINDOW_MS);
  if (dup) {
    return `The same message was already sent to ${toId} ${Math.round((now - dup.at) / 1000)}s ago. Don't resend; a reply will arrive as a new message.`;
  }
  if (log.filter((e) => e.to === toId).length >= RATE_MAX_PER_RECIPIENT) {
    return `Rate limit: ${RATE_MAX_PER_RECIPIENT} messages to ${toId} in the last ${RATE_WINDOW_MS / 60_000} minutes. Batch what's left into one message or wait.`;
  }
  return undefined;
}

function recordSent(selfId: string, toId: string, body: string): void {
  const now = Date.now();
  const log = (readJson<SentEntry[]>(sentLogFile(selfId)) ?? []).filter((e) => now - e.at < RATE_WINDOW_MS);
  log.push({ to: toId, hash: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16), at: now });
  writeJsonAtomic(sentLogFile(selfId), log);
}

function codexCandidates(): string[] {
  const configured = process.env.TELEPATHY_CODEX_BIN;
  if (configured) return [configured];
  // MCP servers and hooks may run with a minimal PATH, so also try the usual install locations.
  return ['codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local', 'bin', 'codex')];
}

/** Hands the text to Codex's own queue (`codex queue`), which starts a turn in the live session. */
async function queueIntoCodex(threadId: string, text: string, codexHome: string | undefined): Promise<void> {
  const args = ['queue', `--thread=${threadId}`, `--message=${text}`];
  const env = { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) };
  let lastError: unknown;
  for (const bin of codexCandidates()) {
    try {
      await execFileAsync(bin, args, { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
      return;
    } catch (err) {
      lastError = err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') break;
    }
  }
  const e = lastError as NodeJS.ErrnoException & { stderr?: string };
  if (e?.code === 'ENOENT') {
    throw new Error('The codex CLI was not found on PATH; set TELEPATHY_CODEX_BIN to its path.');
  }
  throw new Error(`codex queue failed: ${(e?.stderr || e?.message || String(e)).trim()}`);
}

/** Sends `body` from `self` to whatever `to` names. Used by the MCP tool and the SendMessage hook. */
export async function sendMessage(self: Peer, to: string, body: string): Promise<SendResult> {
  if (!body.trim()) return { ok: false, error: 'Message is empty.' };
  if (body.length > MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      error: `Message is ${body.length} characters; the limit is ${MAX_MESSAGE_CHARS}. Write the content to a file and send its path instead.`,
    };
  }

  const peers = listPeers().filter((p) => p.id !== self.id);
  const resolved = resolvePeer(to, peers);
  if ('error' in resolved) {
    const selfMatch = resolvePeer(to, [self]);
    if ('peer' in selfMatch) return { ok: false, error: `"${to}" is this session itself.` };
    return { ok: false, error: resolved.error };
  }
  const recipient = resolved.peer;

  const limited = checkRate(self.id, recipient.id, body);
  if (limited) return { ok: false, error: limited };

  const message: Message = {
    id: newMessageId(),
    from: partyOf(self),
    to: partyOf(recipient),
    body,
    sentAt: new Date().toISOString(),
  };
  const who = `${agentLabel(recipient.agent)} session ${peerRef(recipient)}`;
  const replyNote = 'A reply, if any, arrives as a new message; there is no need to wait or poll.';

  if (recipient.agent === 'codex') {
    if (!recipient.sessionId) {
      return {
        ok: false,
        error:
          `${who} hasn't reported its thread id yet. In that Codex session, approve the telepathy ` +
          `SessionStart hook with /hooks (or have it call list_peers once), then retry.`,
      };
    }
    try {
      await queueIntoCodex(recipient.sessionId, formatForCodex(message), recipient.codexHome);
    } catch (err) {
      return { ok: false, error: `Could not deliver to ${who}: ${(err as Error).message}` };
    }
    archiveMessage(message);
    recordSent(self.id, recipient.id, body);
    return {
      ok: true,
      message,
      recipient,
      status:
        `Queued ${message.id} for ${who}. Codex starts a new turn with it within about 10 seconds if that ` +
        `session is idle, or right after its current turn. ${replyNote}`,
    };
  }

  writeToInbox(message);
  recordSent(self.id, recipient.id, body);
  const status = recipient.hasListener
    ? `Delivered ${message.id} to ${who}. Claude sees it right away and starts a turn if that session is idle. ${replyNote}`
    : `Stored ${message.id} in the inbox of ${who}, but that session has no active listener (plugin monitors ` +
      `only run in interactive Claude Code sessions), so it sees the message only when it calls read_messages.`;
  return { ok: true, message, recipient, status };
}
