import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { archiveDir, ensureDir, inboxDir, readJson, writeJsonAtomic } from './paths.ts';
import { agentLabel, type Peer, peerRef } from './peers.ts';
import type { Agent } from './proc.ts';

export interface Party {
  id: string;
  agent: Agent;
  name: string;
  address: string;
}

export interface Message {
  id: string;
  from: Party;
  to: Party;
  body: string;
  sentAt: string;
}

export const MAX_MESSAGE_CHARS = 100_000;
const ARCHIVE_KEEP = 200;
const MSG_FILE_RE = /^m-[0-9a-z]+-[0-9a-f]+\.json$/;

export const partyOf = (peer: Peer): Party => ({ id: peer.id, agent: peer.agent, name: peer.name, address: peer.address });

/** Time-sortable id, so inbox order is send order. */
export function newMessageId(): string {
  return `m-${Date.now().toString(36).padStart(9, '0')}-${crypto.randomBytes(3).toString('hex')}`;
}

export function writeToInbox(msg: Message): void {
  writeJsonAtomic(path.join(inboxDir(msg.to.id), `${msg.id}.json`), msg);
}

export function archiveMessage(msg: Message): void {
  writeJsonAtomic(path.join(archiveDir(msg.to.id), `${msg.id}.json`), msg);
  pruneArchive(msg.to.id);
}

/**
 * Moves every pending inbox message to the archive and returns the ones this call moved.
 * The rename is atomic, so when two consumers race for a message exactly one of them gets it.
 */
export function claimInbox(peerId: string): Message[] {
  let files: string[];
  try {
    files = fs.readdirSync(inboxDir(peerId)).filter((f) => MSG_FILE_RE.test(f)).sort();
  } catch {
    return [];
  }
  const claimed: Message[] = [];
  for (const file of files) {
    const target = path.join(ensureDir(archiveDir(peerId)), file);
    try {
      fs.renameSync(path.join(inboxDir(peerId), file), target);
    } catch {
      continue; // another consumer claimed it first
    }
    const msg = readJson<Message>(target);
    if (msg) claimed.push(msg);
  }
  if (claimed.length) pruneArchive(peerId);
  return claimed;
}

export function pendingCount(peerId: string): number {
  try {
    return fs.readdirSync(inboxDir(peerId)).filter((f) => MSG_FILE_RE.test(f)).length;
  } catch {
    return 0;
  }
}

export function readArchived(peerId: string, id: string): Message | undefined {
  if (!/^m-[0-9a-z]+-[0-9a-f]+$/.test(id)) return undefined;
  return readJson<Message>(path.join(archiveDir(peerId), `${id}.json`));
}

export function recentArchived(peerId: string, limit: number): Message[] {
  let files: string[];
  try {
    files = fs.readdirSync(archiveDir(peerId)).filter((f) => MSG_FILE_RE.test(f)).sort();
  } catch {
    return [];
  }
  return files
    .slice(-limit)
    .map((f) => readJson<Message>(path.join(archiveDir(peerId), f)))
    .filter((m): m is Message => !!m);
}

function pruneArchive(peerId: string): void {
  try {
    const files = fs.readdirSync(archiveDir(peerId)).filter((f) => MSG_FILE_RE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) {
      fs.rmSync(path.join(archiveDir(peerId), f), { force: true });
    }
  } catch {
    // nothing to prune
  }
}

const describeSender = (from: Party) => `${agentLabel(from.agent)} session ${peerRef(from)}`;

/**
 * Text queued into a Codex thread. Codex shows queued text as a user turn, so the header says plainly
 * that another agent wrote it, mirroring how Claude Code labels cross-session messages.
 */
export function formatForCodex(msg: Message): string {
  return [
    `[telepathy] Message from ${describeSender(msg.from)}.`,
    `It was sent by another AI agent through the telepathy plugin, not typed by your user. ` +
      `To reply, call the telepathy send_message tool with to: "${msg.from.address}".`,
    '',
    msg.body,
  ].join('\n');
}

/** One stdout line for the Claude Code monitor; each line becomes one notification for Claude. */
export function formatMonitorLine(msg: Message, inlineLimit = 4000): string {
  const header =
    `[telepathy] New message ${msg.id} from ${describeSender(msg.from)}, sent by another AI agent (not your user). ` +
    `To reply, call the telepathy send_message tool with to: "${msg.from.address}".`;
  const flat = (s: string) => s.replace(/\r\n|\r|\n/g, '\\n');
  if (msg.body.length <= inlineLimit) {
    return `${header} Text (line breaks shown as \\n): ${flat(msg.body)}`;
  }
  const preview = flat(msg.body.slice(0, 1500));
  return (
    `${header} Text (first 1500 of ${msg.body.length} characters; call read_messages with id "${msg.id}" ` +
    `for the full text): ${preview}…`
  );
}

/** Full rendering for the read_messages tool. */
export function formatForReading(msg: Message): string {
  return [
    `--- ${msg.id} · from ${describeSender(msg.from)} · ${msg.sentAt}`,
    `(reply with send_message to: "${msg.from.address}")`,
    msg.body,
  ].join('\n');
}
