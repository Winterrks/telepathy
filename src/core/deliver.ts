import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { agentSpec } from './agents.ts';
import { claudeSocketArmed, crossSessionInbound, flushClaudeSocket, readClaudeSocket, type SocketOutcome } from './claude-socket.ts';
import { queueIntoCodex } from './codex-queue.ts';
import {
  archiveMessage,
  formatAsUserTurn,
  MAX_MESSAGE_CHARS,
  type Message,
  newMessageId,
  partyOf,
  writeToInbox,
} from './messages.ts';
import { inboxDir, peerDir, readJson, writeJsonAtomic } from './paths.ts';
import { beginToolCall, confirmDelivery, confirmWaitEnabled, endToolCall, withdrawPending } from './confirm.ts';
import { keptPeers, listPeers, notePeerExit, type Peer, peerRef, resolvePeer, isPeerAlive } from './peers.ts';
import { peerStatus } from './status.ts';
import { notifyWake, type WakeResult } from './wake.ts';

export type SendResult =
  | { ok: true; message: Message; recipient: Peer; status: string; delivery: DeliveryReport }
  | { ok: false; error: string };

/**
 * When a rung would present the message, if it accepts.
 * `immediate` is a live injector. `mid-turn` is the next tool result. `turn-end` is Codex's queue, which
 * dispatches only after a completed or failed turn. `idle` is a wake of a session that is waiting.
 * `next-prompt` is a hook on the user's next prompt. `poll` is `read_messages`.
 */
export type DeliveryWhen = 'immediate' | 'mid-turn' | 'turn-end' | 'idle' | 'next-prompt' | 'poll';

export interface DeliveryAttempt {
  id: string;
  result: 'confirmed' | 'armed' | 'failed' | 'unsupported';
  when: DeliveryWhen;
  detail?: string;
}

/** `confirmed` is true only when a rung accepted the message and the inbox copy was claimed. */
export interface DeliveryReport {
  confirmed: boolean;
  attempts: DeliveryAttempt[];
}

// Loop guard. Two agents that auto-reply to each other would otherwise ping-pong forever.
const DUPLICATE_WINDOW_MS = 2 * 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_PER_RECIPIENT = 20;
/** How long a sender waits for the recipient's socket watcher to claim. A held message falls through after this. */
const SOCKET_WAIT_MS = () => {
  const n = Number(process.env.TELEPATHY_SOCKET_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
};

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

const stillPending = (peerId: string, messageId: string) => fs.existsSync(path.join(inboxDir(peerId), `${messageId}.json`));

/** Sends `body` from `self` to whatever `to` names. Used by the MCP tool and the SendMessage hook. */
export async function sendMessage(self: Peer, to: string, body: string): Promise<SendResult> {
  const ownsClock = beginToolCall();
  try {
  if (!body.trim()) return { ok: false, error: 'Message is empty.' };
  if (body.length > MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      error: `Message is ${body.length} characters; the limit is ${MAX_MESSAGE_CHARS}. Write the content to a file and send its path instead.`,
    };
  }

  const peers = listPeers().filter((p) => p.id !== self.id);
  let resolved = resolvePeer(to, peers);
  if ('error' in resolved) {
    const selfMatch = resolvePeer(to, [self]);
    if ('peer' in selfMatch) return { ok: false, error: `"${to}" is this session itself.` };
    // A session that exited in the keep window is not listed. Naming it is what makes the offline failure
    // specific. The inbox is not written.
    const offline = resolvePeer(to, keptPeers().filter((p) => p.id !== self.id));
    if ('peer' in offline) resolved = offline;
    else return { ok: false, error: resolved.error };
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

  // A launched Codex TUI has no thread until the first prompt (or `codex resume <id>`). Queueing needs a thread
  // the user is looking at. Starting one through a side app-server would not be that composer, so this fails
  // before any inbox write and does not wait out the confirm window.
  if (recipient.agent === 'codex' && !recipient.sessionId) {
    return {
      ok: false,
      error: `Message failed: ${peerRef(recipient)} has no thread yet; prompt it once.`,
    };
  }

  if (!isPeerAlive(recipient)) {
    notePeerExit(recipient.id);
    return {
      ok: false,
      error: `Message failed: ${peerRef(recipient)} is offline (session not running). Nothing was left in its inbox.`,
    };
  }

  // An interrupted Codex leaves its queue paused, including after `codex resume`, until the user prompts.
  // UserPromptSubmit is not this call, so waiting the confirm window cannot deliver. Fail before any write.
  if (recipient.agent === 'codex' && peerStatus(recipient)?.status === 'interrupted') {
    return {
      ok: false,
      error: `Message failed: ${peerRef(recipient)} is interrupted, so its queue will not run this. Nothing was left for a later prompt.`,
    };
  }

  const delivery = await routeDelivery(recipient, message);
  if (!confirmWaitEnabled()) {
    recordSent(self.id, recipient.id, body);
    return { ok: true, message, recipient, status: delivery.status, delivery: delivery.report };
  }
  const proof = await confirmDelivery(recipient, message, delivery.status);
  if (!proof.confirmed) return { ok: false, error: proof.status };
  recordSent(self.id, recipient.id, body);
  return {
    ok: true,
    message,
    recipient,
    status: proof.status,
    delivery: { ...delivery.report, confirmed: true },
  };
  } finally {
    if (ownsClock) endToolCall();
  }
}

interface Route {
  status: string;
  report: DeliveryReport;
}

/**
 * One message, one walk. A rung that confirms claims the inbox and the walk stops. A rung that only arms
 * (the queue, a hook, a webhook) leaves the inbox in place and the walk continues to a rung that covers a
 * case the first one misses. Codex's queue is the turn-end rung: it does not deliver after a tool call, and
 * it does not start after the user interrupts, so those cases are the mid-turn hook and the inbox.
 */
async function routeDelivery(recipient: Peer, message: Message): Promise<Route> {
  if (recipient.agent === 'codex') return routeCodex(recipient, message);
  return routeInbox(recipient, message);
}

async function routeCodex(recipient: Peer, message: Message): Promise<Route> {
  const activity = peerStatus(recipient)?.status;
  const attempts: DeliveryAttempt[] = [];

  // Mid-turn is the PostToolUse hook appending to the tool result. It ranks above the queue, which only
  // runs the message after the turn ends. The hook withdraws the queue item when it claims the inbox.
  if (activity === 'busy' && recipient.toolHookRan) {
    attempts.push({ id: 'codex-mid-turn', result: 'armed', when: 'mid-turn' });
  } else {
    attempts.push({ id: 'codex-mid-turn', result: 'unsupported', when: 'mid-turn' });
  }

  // Commit 9341b38: the queue stays paused after an interrupt. `sendMessage` already failed this case
  // before routing. If it is reached, write nothing: a later prompt is not this call.
  if (activity === 'interrupted') {
    attempts.push({ id: 'codex-queue', result: 'unsupported', when: 'turn-end', detail: 'paused after interrupt' });
    return {
      status: `Message failed: ${peerRef(recipient)} is interrupted, so its queue will not run this. Nothing was left for a later prompt.`,
      report: { confirmed: false, attempts },
    };
  }

  let codexQueueId: string | undefined;
  try {
    codexQueueId = await queueIntoCodex(recipient.sessionId as string, formatAsUserTurn(message), recipient.codexHome);
  } catch (err) {
    const detail = (err as Error).message;
    attempts.push({ id: 'codex-queue', result: 'failed', when: activity === 'busy' ? 'turn-end' : 'idle', detail });
    writeToInbox(message);
    attempts.push(inboxRung(recipient));
    return {
      status: `${codexHeldStatus(recipient, detail)}`,
      report: { confirmed: false, attempts },
    };
  }

  if (codexQueueId) writeToInbox({ ...message, codexQueueId, codexThreadId: recipient.sessionId });
  else archiveMessage(message);
  const when: DeliveryWhen = activity === 'busy' || activity === 'waiting' ? 'turn-end' : 'idle';
  attempts.push({ id: 'codex-queue', result: 'armed', when });
  return { status: codexQueueStatus(recipient), report: { confirmed: false, attempts } };
}

async function routeInbox(recipient: Peer, message: Message): Promise<Route> {
  const attempts: DeliveryAttempt[] = [];
  writeToInbox(message);

  // The watcher that would post lives in the recipient's server. This process's flush is 'idle' then, so a
  // hold would otherwise be described as "no listener". The setting is on disk; read it before any wait.
  const inbound = recipient.agent === 'claude' ? crossSessionInbound(recipient) : undefined;
  const inboundBlocks = inbound === 'hold' || inbound === 'refuse';

  let socketOutcome: SocketOutcome | 'idle' | 'blocked' | undefined;
  if (inboundBlocks) {
    attempts.push({
      id: 'claude-socket',
      result: 'unsupported',
      when: 'immediate',
      detail: `crossSessionInbound is ${inbound}`,
    });
  } else if (recipient.agent === 'claude' && (readClaudeSocket(recipient.id) || claudeSocketArmed(recipient.id))) {
    socketOutcome = await flushClaudeSocket(recipient.id);
    // The watcher runs in the recipient's server. This process only posted if that server is this process.
    if (socketOutcome === 'idle') await waitForSocket(recipient.id, message.id);
    if (socketOutcome !== 'blocked' && !stillPending(recipient.id, message.id)) {
      attempts.push({ id: 'claude-socket', result: 'confirmed', when: 'immediate' });
      return {
        status: `Message delivered to ${peerRef(recipient)} through Claude's inbox socket.`,
        report: { confirmed: true, attempts },
      };
    }
    if (socketOutcome === 'blocked') {
      // Nothing was written. The inbox copy is what a hook or read_messages can still withdraw.
      attempts.push({
        id: 'claude-socket',
        result: 'unsupported',
        when: 'immediate',
        detail: 'crossSessionInbound is hold or refuse',
      });
    } else if (socketOutcome === 'held') {
      // The setting was not visible before the post. Claude has the bytes; withdrawing the inbox cannot undo that.
      withdrawPending(recipient.id, message.id);
      attempts.push({ id: 'claude-socket', result: 'armed', when: 'immediate', detail: 'held' });
      return { status: claudeSocketHeldStatus(recipient), report: { confirmed: false, attempts } };
    } else {
      attempts.push({
        id: 'claude-socket',
        result: socketOutcome === 'failed' ? 'failed' : 'armed',
        when: 'immediate',
        detail: socketOutcome === 'idle' ? 'not confirmed' : socketOutcome,
      });
    }
  } else if (recipient.agent === 'claude') {
    attempts.push({ id: 'claude-socket', result: 'unsupported', when: 'immediate' });
  }

  const socketPosted = socketOutcome !== undefined && socketOutcome !== 'blocked';
  // A live listener (Claude's monitor, Grok's monitor, the OpenCode plugin) claims the inbox itself.
  // The status string is the one those sessions already show. The file stays unclaimed until that process renames it.
  // While the socket watcher is armed and actually posting, the monitor does not claim. hold and refuse do not
  // post, so the listener and the hooks remain the path.
  if (!inboundBlocks && recipient.hasListener && !socketPosted && !claudeSocketArmed(recipient.id)) {
    attempts.push({ id: 'listener', result: 'armed', when: 'immediate' });
    return { status: inboxStatus(recipient), report: { confirmed: false, attempts } };
  }
  attempts.push({
    id: 'listener',
    result: 'unsupported',
    when: 'immediate',
    detail: recipient.hasListener && socketPosted ? 'monitor stands down while the socket watcher is running' : undefined,
  });

  const wake = await notifyWake(recipient, message);
  if (wake) attempts.push(wakeAttempt(wake));

  // An unconfirmed post must not also be described as a hook delivery. A blocked post never happened, so the
  // hook rung is real.
  const socketBlockingHooks = socketPosted && (claudeSocketArmed(recipient.id) || !!readClaudeSocket(recipient.id));
  const fallbackPeer = socketBlockingHooks ? { ...recipient, hasListener: false, hookRan: false } : recipient;
  const fallback = inboxRung(fallbackPeer);
  attempts.push(fallback);
  if (inbound === 'hold' || inbound === 'refuse') {
    return { status: claudeInboundBlockedStatus(recipient, inbound), report: { confirmed: false, attempts } };
  }
  const status = wakeStatus(recipient, inboxStatus(fallbackPeer), wake);
  if (socketOutcome === 'blocked') {
    return { status: claudeInboundBlockedStatus(recipient, 'hold'), report: { confirmed: false, attempts } };
  }
  return { status, report: { confirmed: false, attempts } };
}

function wakeAttempt(wake: WakeResult): DeliveryAttempt {
  // A 2xx or a command exit is not the model seeing the message. The inbox copy is still the message.
  return {
    id: wake.how,
    result: wake.ok ? 'armed' : 'failed',
    when: 'idle',
    detail: wake.ok ? undefined : wake.detail,
  };
}

function inboxRung(recipient: Peer): DeliveryAttempt {
  if (agentSpec(recipient.agent).nextTurnHook && recipient.hookRan) {
    return { id: 'next-boundary', result: 'armed', when: 'next-prompt' };
  }
  if (recipient.agent === 'codex' && recipient.hookRan) {
    return { id: 'next-boundary', result: 'armed', when: 'next-prompt' };
  }
  return { id: 'poll', result: 'armed', when: 'poll' };
}

async function waitForSocket(peerId: string, messageId: string): Promise<void> {
  const deadline = Date.now() + SOCKET_WAIT_MS();
  while (stillPending(peerId, messageId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * `hold` or `refuse` means nothing was written to the socket. The failure text has to say that. "No listener"
 * is a different path and is what a sender reports when it never looked at the setting.
 */
function claudeInboundBlockedStatus(recipient: Peer, inbound: 'hold' | 'refuse'): string {
  const why =
    inbound === 'hold'
      ? 'that session is holding peer messages (crossSessionInbound is hold)'
      : 'that session is refusing peer messages (crossSessionInbound is refuse)';
  return `Nothing was posted to ${peerRef(recipient)}: ${why}. The inbox copy can still be withdrawn.`;
}

/**
 * A socket reply of `held` means Claude already accepted bytes we cannot withdraw. This is not `Message failed`:
 * that phrase means the message can never arrive.
 */
function claudeSocketHeldStatus(recipient: Peer): string {
  return (
    `Message not confirmed for ${peerRef(recipient)}. Claude reported the inbox-socket post as held. ` +
    'That copy cannot be recalled and may still be delivered if the hold is released. ' +
    'The inbox copy was withdrawn so a later turn does not also show it.'
  );
}

/** Said to the sender when the recipient is stopped on a permission prompt. */
const waitingNote = (ref: string, verb: string) =>
  `Message ${verb} ${ref}, but it's waiting on a permission prompt for its user, so it gets to your message only ` +
  "after its user answers. Tell your user if it's urgent; don't resend.";

/**
 * Inbox copy for a Codex message `codex queue` itself failed to accept. The confirm wait can still see a
 * hook claim it. A failure withdraws that copy; this sentence is rewritten so it does not say the copy stays.
 */
function codexHeldStatus(recipient: Peer, why: string): string {
  const ref = peerRef(recipient);
  const via = recipient.hookRan
    ? 'It stays in the inbox for the next prompt, or until the session calls read_messages.'
    : 'It stays in the inbox until the session calls read_messages.';
  return `Message stored for ${ref}. ${why} ${via}`;
}

/** When a queued message reaches Codex, from the state of its last turn. */
function codexQueueStatus(recipient: Peer): string {
  const ref = peerRef(recipient);
  const activity = peerStatus(recipient)?.status;
  if (activity === 'waiting') return waitingNote(ref, 'queued for');
  if (activity === 'busy') {
    if (recipient.toolHookRan) {
      return `Message delivered to ${ref}. It's in the middle of a turn and gets it after its next tool call, or when the turn ends.`;
    }
    return `Message queued for ${ref}. It's in the middle of a turn, so the message is delivered only after that turn ends.`;
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
  if (peerStatus(recipient)?.status === 'waiting') return waitingNote(ref, recipient.hasListener ? 'delivered to' : 'stored for');
  if (recipient.hasListener) return `Message delivered to ${ref}.`;
  if (agentSpec(recipient.agent).nextTurnHook && recipient.hookRan) {
    return `Message stored for ${ref}. It can't be woken while idle, so it will see it at its next turn.`;
  }
  return `Message stored for ${ref}. It has no listener, so it will see it only when it calls read_messages.`;
}

function wakeStatus(recipient: Peer, base: string, wake: WakeResult | undefined): string {
  if (!wake) return base;
  const ref = peerRef(recipient);
  const how = wake.how === 'webhook' ? 'webhook' : 'delivery command';
  if (!wake.ok) return `${base} The ${how} notification failed (${wake.detail}).`;
  if (wake.scheduled) {
    return (
      `A ${how} wake for ${ref} is scheduled. ${base} ` +
      `The ${how} body is a wake, not the message, and must be treated as untrusted.`
    );
  }
  return (
    `Notified ${ref} by ${how}. ${base} ` +
    `The ${how} body is a wake, not the message, and must be treated as untrusted.`
  );
}
