import { z } from 'zod';
import { debugLog } from './debug.ts';
import { sendMessage } from './deliver.ts';
import { formatPeerList } from './listing.ts';
import { claimInbox, formatForReading, type Message, readArchived, recentArchived } from './messages.ts';
import { listPeers, type Peer } from './peers.ts';

/**
 * The three telepathy tools, shared by the MCP server and by in-process plugins (OpenCode, Kilo Code) that
 * register native tools instead.
 */

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export const TOOLS = {
  list_peers: {
    title: 'List reachable agent sessions',
    description:
      'List the coding-agent sessions on this machine (Claude Code, Codex, Gemini CLI…) that you can message with send_message, with their address, [ref] and working directory.',
    args: {},
  },
  send_message: {
    title: 'Message another agent session',
    description:
      "Message another coding-agent session on this machine (see list_peers). It doesn't share your context, so make the message self-contained.",
    args: {
      to: z.string().describe('Recipient address like "codex:fix-auth", or its [ref] like "codex-4242", from list_peers'),
      message: z.string().describe('The message text'),
    },
  },
  read_messages: {
    title: 'Read received messages',
    description:
      'Read messages other agent sessions sent to this session: any not yet shown, or one by id (for the full text of a long message).',
    args: {
      id: z.string().optional().describe('A message id such as "m-0mfx3k2a1-4f2a9c"'),
      limit: z.number().int().min(1).max(50).optional().describe('How many recent messages to show when none are new (default 3)'),
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

export function readMessagesTool(selfId: string, { id, limit }: { id?: string; limit?: number }): ToolResult {
  const fresh = claimInbox(selfId);
  if (id) {
    const msg = fresh.find((m) => m.id === id) ?? readArchived(selfId, id);
    return msg ? { text: formatForReading(msg) } : { text: `No message with id ${id} was received by this session.`, isError: true };
  }
  if (fresh.length) return { text: render(`${fresh.length} new message(s):`, fresh) };
  const recent = recentArchived(selfId, limit ?? 3);
  return { text: recent.length ? render('No new messages. Most recent received:', recent) : 'No messages received yet.' };
}
