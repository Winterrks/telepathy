import crypto from 'node:crypto';
import path from 'node:path';
import { agentSpec } from './agents.ts';
import { codexActivity } from './codex-activity.ts';
import { queueIntoCodex } from './codex-queue.ts';
import { unapprovedCodexHooks } from './setup.ts';
import {
  archiveMessage,
  formatAsUserTurn,
  MAX_MESSAGE_CHARS,
  type Message,
  newMessageId,
  partyOf,
  writeToInbox,
} from './messages.ts';
import { peerDir, readJson, writeJsonAtomic } from './paths.ts';
import { agentLabel, listPeers, type Peer, peerRef, resolvePeer } from './peers.ts';

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

  if (recipient.agent === 'codex') {
    if (!recipient.sessionId) {
      return {
        ok: false,
        error:
          `${who} hasn't reported its thread id yet. In that Codex session, approve the telepathy ` +
          `SessionStart hook with /hooks (or have it call list_peers once), then retry.`,
      };
    }
    let codexQueueId: string | undefined;
    try {
      codexQueueId = await queueIntoCodex(recipient.sessionId, formatAsUserTurn(message), recipient.codexHome);
    } catch (err) {
      return { ok: false, error: `Could not deliver to ${who}: ${(err as Error).message}` };
    }
    // Also in the inbox, so read_messages can hand it over mid-turn and take it back out of Codex's queue.
    if (codexQueueId) writeToInbox({ ...message, codexQueueId, codexThreadId: recipient.sessionId });
    else archiveMessage(message);
    recordSent(self.id, recipient.id, body);
    return { ok: true, message, recipient, status: codexQueueStatus(recipient) };
  }

  writeToInbox(message);
  recordSent(self.id, recipient.id, body);
  return { ok: true, message, recipient, status: inboxStatus(recipient) };
}

/** When a queued message reaches Codex, from the state of its last turn. */
function codexQueueStatus(recipient: Peer): string {
  const ref = peerRef(recipient);
  const activity =
    recipient.codexHome && recipient.sessionId ? codexActivity(recipient.codexHome, recipient.sessionId) : undefined;
  // Which of telepathy's hooks Codex hasn't approved; undefined when that can't be told.
  const unapproved = recipient.codexHome ? unapprovedCodexHooks(recipient.codexHome) : undefined;
  if (activity === 'busy') {
    if (recipient.toolHookRan) {
      return `Message delivered to ${ref}. It's in the middle of a turn and gets it after its next tool call, or when the turn ends.`;
    }
    const why = unapproved?.includes('PostToolUse')
      ? " (telepathy's PostToolUse hook isn't approved there; its user can trust it with /hooks in that session)"
      : '';
    return `Message queued for ${ref}. It's in the middle of a turn, so the message is delivered only after that turn ends${why}.`;
  }
  if (activity === 'interrupted') {
    const withPrompt = unapproved && !unapproved.includes('UserPromptSubmit') ? ', and it gets the message with that prompt' : '';
    return (
      `Message queued for ${ref}, but Codex is holding it: its last turn was interrupted, and it doesn't start ` +
      `queued messages until its user sends that session a prompt${withPrompt}. Tell your user if it's urgent; don't resend.`
    );
  }
  return `Message queued for delivery to ${ref}.`;
}

/**
 * What happens to a message left in a session's inbox. A listener (Claude's monitor, an in-process plugin)
 * starts a turn right away; otherwise the agent's hooks may hand it over at its next turn; otherwise the
 * session sees it only when it calls read_messages.
 */
function inboxStatus(recipient: Peer): string {
  const ref = peerRef(recipient);
  if (recipient.hasListener) return `Message delivered to ${ref}.`;
  if (agentSpec(recipient.agent).nextTurnHook && recipient.hookRan) {
    return `Message stored for ${ref}. It can't be woken while idle, so it will see it at its next turn.`;
  }
  return `Message stored for ${ref}. It has no listener, so it will see it only when it calls read_messages.`;
}
