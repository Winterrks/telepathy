import { z } from 'zod';
import { debugLog } from './debug.ts';
import { sendMessage } from './deliver.ts';
import { formatPeerList } from './listing.ts';
import { claimInbox, formatForReading, type Message, readArchived, recentArchived } from './messages.ts';
import { listPeers, type Peer } from './peers.ts';

/**
 * Telepathy tools, shared by the MCP server and by in-process plugins (OpenCode, Kilo Code) that register
 * native tools instead. `wait_for_messages` is registered only for Grok: other agents already have a host-owned
 * wake, and a blocking wait would hold their turn.
 */

/** How long wait_for_messages blocks when the caller omits timeoutMs. Stays under a 60s client cap. */
export const DEFAULT_WAIT_MS = 45_000;
/** Upper bound for timeoutMs. A host that allows a long tool call can pass anything up to this. */
export const MAX_WAIT_MS = 50 * 60_000;

/**
 * Returned, and nothing is claimed, when some other process is already the listener (Grok Build's monitor).
 * Claiming here would steal the line that monitor is about to print.
 */
export const ALREADY_LISTENING =
  "A listener is already delivering this session's messages. Leave it running; wait_for_messages would take messages that listener prints and block the turn.";

export interface ToolResult {
  text: string;
  isError?: boolean;
  /**
   * Machine-readable messages for clients that must not parse the status text. Empty means there is no message.
   * `from` is the sender's address (`claude:name`).
   */
  structured?: { messages: StoredMessage[] };
}

export interface StoredMessage {
  id: string;
  from: string;
  sentAt: string;
  body: string;
}

export const TOOLS = {
  list_peers: {
    title: 'List reachable agent sessions',
    description:
      'List the coding-agent sessions on this machine (Claude Code, Codex, Antigravity…) that you can message with send_message, with their address, [ref] and working directory.',
    args: {},
  },
  send_message: {
    title: 'Message another agent session',
    description:
      "Message another coding-agent session on this machine (see list_peers). It waits until the recipient's transcript shows the message, and it succeeds only then. It doesn't share your context, so make the message self-contained. For a session that is not Claude Code, use this tool rather than SendMessage.",
    args: {
      to: z.string().describe('Recipient address like "codex:fix-auth", or its [ref] like "codex-4242", from list_peers'),
      message: z.string().describe('The message text'),
    },
  },
  read_messages: {
    title: 'Read received messages',
    description:
      'Read messages other agent sessions sent to this session: any not yet shown, or one by id (for the full text of a long message). ' +
      'structuredContent.messages is the same messages as {id, from, sentAt, body}. An empty array means there is no message; the status text is not one.',
    args: {
      id: z.string().optional().describe('A message id such as "m-0mfx3k2a1-4f2a9c"'),
      limit: z.number().int().min(1).max(50).optional().describe('How many recent messages to show when none are new (default 3)'),
    },
  },
  wait_for_messages: {
    title: 'Wait for incoming messages',
    description:
      'Wait until another session messages this one, then return those messages (same rendering as read_messages). ' +
      `Blocks until a message arrives or timeoutMs elapses (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}). ` +
      'Grok Bot has no other wake: call this with a long timeoutMs (for example 300000) when the client allows it, handle the result, and call it again. ' +
      'A result with no messages only means this wait ended. ' +
      'Grok Build already wakes from its monitor tool: do not also call this. If a listener is already registered, the tool returns immediately and claims nothing.',
    args: {
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_MS)
        .optional()
        .describe(`How long to wait, in milliseconds. 0 returns immediately. Default ${DEFAULT_WAIT_MS}. Maximum ${MAX_WAIT_MS}.`),
    },
  },
} as const;

export function listPeersTool(self: Peer): ToolResult {
  return { text: formatPeerList(self, listPeers().filter((p) => p.id !== self.id)) };
}

export async function sendMessageTool(self: Peer, to: string, message: string): Promise<ToolResult> {
  const result = await sendMessage(self, to, message);
  debugLog('tools', result.ok ? `sent ${result.message.id} to ${result.recipient.id}` : `send failed: ${result.error}`);
  return result.ok ? { text: result.status } : { text: result.error, isError: true };
}

const render = (title: string, messages: Message[]) => [title, ...messages.map(formatForReading)].join('\n\n');

const stored = (msg: Message): StoredMessage => ({ id: msg.id, from: msg.from.address, sentAt: msg.sentAt, body: msg.body });

export function readMessagesTool(selfId: string, { id, limit }: { id?: string; limit?: number }): ToolResult {
  const fresh = claimInbox(selfId);
  if (id) {
    const msg = fresh.find((m) => m.id === id) ?? readArchived(selfId, id);
    return msg
      ? { text: formatForReading(msg), structured: { messages: [stored(msg)] } }
      : { text: `No message with id ${id} was received by this session.`, isError: true, structured: { messages: [] } };
  }
  if (fresh.length) return { text: render(`${fresh.length} new message(s):`, fresh), structured: { messages: fresh.map(stored) } };
  const recent = recentArchived(selfId, limit ?? 3);
  return {
    text: recent.length ? render('No new messages. Most recent received:', recent) : 'No messages received yet.',
    structured: { messages: recent.map(stored) },
  };
}

/** What wait_for_messages says. Messages use the same rendering as read_messages. */
export function formatWaitResult(messages: Message[], reason: 'message' | 'timeout' | 'cancelled', timeoutMs: number): ToolResult {
  if (messages.length) {
    return { text: render(`${messages.length} new message(s):`, messages), structured: { messages: messages.map(stored) } };
  }
  const text =
    reason === 'cancelled'
      ? 'Wait cancelled before a message arrived. Call wait_for_messages again to keep listening.'
      : timeoutMs <= 0
        ? 'No messages waiting. Call wait_for_messages again to keep listening.'
        : `No messages arrived within ${timeoutMs}ms. Call wait_for_messages again to keep listening.`;
  return { text, structured: { messages: [] } };
}
