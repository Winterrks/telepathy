import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRollout } from './codex-activity.ts';
import { deleteFromCodexQueue } from './codex-queue.ts';
import { archiveSettled, messageMarker, type Message } from './messages.ts';
import { archiveDir, ensureDir, inboxDir, readJson, withdrawnDir } from './paths.ts';
import { claudeConfigDir, isPeerAlive, notePeerExit, type Peer, peerRef } from './peers.ts';
import { cancelWake } from './wake.ts';

/**
 * `send_message` waits until the recipient's transcript contains `telepathy-id:<message id>`.
 * A socket reply, a queue exit code, or a hook exit is not that proof. Unset, the wait is on.
 * Tests set `TELEPATHY_CONFIRM_WAIT=0` to keep the route's own status.
 */
export function confirmWaitEnabled(): boolean {
  const v = process.env.TELEPATHY_CONFIRM_WAIT;
  return v !== '0' && v !== 'false';
}

export function confirmAbortMs(): number {
  // 100s + 10s grace is 110s. Claude moves a live tool call to the background at about 120s, and the
  // return after the grace period does not wait on anything else. When a tool call has been marked,
  // that 110s is measured from the mark, so listing before the wait counts against it.
  return envMs('TELEPATHY_CONFIRM_ABORT_MS', 100_000);
}

/** Set at the start of a tool call. Unset, the 110s starts when the wait itself starts. */
let toolCallStartedAt: number | undefined;

/** Starts the confirm clock. A caller that already started it keeps that earlier time. */
export function beginToolCall(at = Date.now()): boolean {
  if (toolCallStartedAt !== undefined) return false;
  toolCallStartedAt = at;
  return true;
}

export function endToolCall(): void {
  toolCallStartedAt = undefined;
}

/**
 * Abort and grace for this wait. With a tool-call mark, both fit in the time still left before
 * `mark + abort + grace`, and `deadline` is that instant.
 */
export function confirmWindow(now = Date.now()): { abort: number; grace: number; deadline?: number } {
  const abort = confirmAbortMs();
  const grace = confirmGraceMs();
  if (toolCallStartedAt === undefined) return { abort, grace };
  const deadline = toolCallStartedAt + abort + grace;
  const left = Math.max(0, deadline - now);
  const graceMs = Math.min(grace, left);
  return { abort: left - graceMs, grace: graceMs, deadline };
}

export function confirmGraceMs(): number {
  return envMs('TELEPATHY_CONFIRM_GRACE_MS', 10_000);
}

export function confirmPollMs(): number {
  return Math.max(15, envMs('TELEPATHY_CONFIRM_POLL_MS', 200));
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const FULL_READ = 32 * 1024 * 1024;
const TAIL_READ = 4 * 1024 * 1024;

export interface TranscriptLook {
  located: boolean;
  found: boolean;
}

/** True when `marker` is in a transcript file this session is known to write. */
export function transcriptHasMarker(peer: Peer | undefined, marker: string): boolean {
  return !!peer && inspectTranscript(peer, marker).found;
}

/**
 * Searches the recipient's transcript for the marker.
 * `TELEPATHY_TRANSCRIPT_DIR`, when set, is the whole search: a directory that exists counts as located even
 * when the marker is absent. Otherwise each harness has its own files (see the design note).
 */
export function inspectTranscript(peer: Peer, marker: string): TranscriptLook {
  const override = process.env.TELEPATHY_TRANSCRIPT_DIR;
  if (override) {
    if (!fs.existsSync(override)) return { located: false, found: false };
    return { located: true, found: treeHas(override, marker, 4) };
  }
  if (peer.agent === 'claude') return claudeTranscript(peer, marker);
  if (peer.agent === 'codex') return codexTranscript(peer, marker);
  if (peer.agent === 'opencode' || peer.agent === 'kilo') return opencodeTranscript(marker);
  if (peer.agent === 'gemini') return geminiTranscript(marker);
  if (peer.agent === 'copilot' && peer.sessionId) {
    const file = path.join(os.homedir(), '.copilot', 'session-state', peer.sessionId, 'events.jsonl');
    if (!fs.existsSync(file)) return { located: false, found: false };
    return { located: true, found: fileHas(file, marker) };
  }
  return { located: false, found: false };
}

function claudeTranscript(peer: Peer, marker: string): TranscriptLook {
  if (!peer.sessionId) return { located: false, found: false };
  const projects = path.join(claudeConfigDir(), 'projects');
  const name = `${peer.sessionId}.jsonl`;
  const files = new Set<string>();
  if (peer.cwd) {
    const slug = peer.cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200);
    files.add(path.join(projects, slug, name));
  }
  // CLAUDE_CODE_PROJECT_DIR_NAME is honored when CLAUDE_CONFIG_DIR is set (Claude Code v2.1.234+).
  if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CODE_PROJECT_DIR_NAME) {
    files.add(path.join(projects, process.env.CLAUDE_CODE_PROJECT_DIR_NAME, name));
  }
  try {
    for (const dir of fs.readdirSync(projects).slice(0, 80)) {
      files.add(path.join(projects, dir, name));
    }
  } catch {
    // no projects directory
  }
  const existing = [...files].filter((file) => fs.existsSync(file));
  if (!existing.length) return { located: false, found: false };
  return { located: true, found: existing.some((file) => fileHas(file, marker)) };
}

function codexTranscript(peer: Peer, marker: string): TranscriptLook {
  if (!peer.sessionId) return { located: false, found: false };
  const home = peer.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = findRollout(home, peer.sessionId);
  if (!file) return { located: false, found: false };
  return { located: true, found: fileHas(file, marker) };
}

function opencodeTranscript(marker: string): TranscriptLook {
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const db = process.env.OPENCODE_DB || path.join(xdg, 'opencode', 'opencode.db');
  const files = [db, `${db}-wal`];
  const legacy = path.join(xdg, 'opencode', 'storage');
  const existing = files.filter((file) => fs.existsSync(file));
  const inDb = existing.some((file) => fileHas(file, marker));
  if (inDb) return { located: true, found: true };
  if (fs.existsSync(legacy) && treeHas(legacy, marker, 5)) return { located: true, found: true };
  if (existing.length || fs.existsSync(legacy)) return { located: true, found: false };
  return { located: false, found: false };
}

function geminiTranscript(marker: string): TranscriptLook {
  const home = process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini');
  const tmp = path.join(home, 'tmp');
  if (!fs.existsSync(tmp)) return { located: false, found: false };
  return { located: true, found: treeHas(tmp, marker, 4) };
}

function treeHas(dir: string, marker: string, depth: number): boolean {
  if (depth < 0) return false;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (name === 'node_modules') continue;
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (treeHas(file, marker, depth - 1)) return true;
    } else if (st.isFile() && fileHas(file, marker)) return true;
  }
  return false;
}

function fileHas(file: string, marker: string): boolean {
  let fd: number | undefined;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return false;
    fd = fs.openSync(file, 'r');
    const start = st.size <= FULL_READ ? 0 : Math.max(0, st.size - TAIL_READ);
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.includes(marker);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export type WithdrawResult = 'withdrawn' | 'claimed' | 'missing';

/** Moves an inbox file aside. A file already in `archive/` was claimed and stays there. */
export function withdrawPending(peerId: string, messageId: string): WithdrawResult {
  const src = path.join(inboxDir(peerId), `${messageId}.json`);
  const dest = path.join(ensureDir(withdrawnDir(peerId)), `${messageId}.json`);
  try {
    fs.renameSync(src, dest);
    return 'withdrawn';
  } catch {
    if (fs.existsSync(path.join(archiveDir(peerId), `${messageId}.json`))) return 'claimed';
    return 'missing';
  }
}

function storedMessage(peerId: string, messageId: string): Message | undefined {
  for (const dir of [inboxDir(peerId), archiveDir(peerId), withdrawnDir(peerId)]) {
    const msg = readJson<Message>(path.join(dir, `${messageId}.json`));
    if (msg) return msg;
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a confirm-path queue delete may block. It runs before the grace period, not after it. */
const CONFIRM_QUEUE_DELETE_MS = 2_000;

type WaitStop = { kind: 'found' } | { kind: 'offline' } | { kind: 'timeout'; located: boolean };

async function untilMarker(peer: Peer, marker: string, budgetMs: number): Promise<WaitStop> {
  const deadline = Date.now() + budgetMs;
  const step = confirmPollMs();
  let located = false;
  for (;;) {
    const look = inspectTranscript(peer, marker);
    if (look.found) return { kind: 'found' };
    located = look.located;
    if (!isPeerAlive(peer)) return { kind: 'offline' };
    const left = deadline - Date.now();
    if (left <= 0) return { kind: 'timeout', located };
    await sleep(Math.min(step, left));
  }
}

export interface ConfirmOutcome {
  confirmed: boolean;
  status: string;
}

const UNRECALLABLE = /cannot be recalled/i;

/**
 * A failed tool result must not say the copy stays, was stored, or was delivered. A held socket is the
 * exception: those bytes cannot be recalled, and that sentence is left as Claude reported it.
 */
function scrubSignal(text: string): string {
  return text
    .replace(/Message delivered to /g, 'Unconfirmed handoff to ')
    .replace(/Message stored for /g, 'Unconfirmed handoff to ')
    .replace(
      'It stays in the inbox for the next prompt, or until the session calls read_messages.',
      'The inbox copy was withdrawn, so the next prompt will not see it.',
    )
    .replace(
      'It stays in the inbox until the session calls read_messages.',
      'The inbox copy was withdrawn, so a later read will not see it.',
    )
    .replace('The inbox copy can still be withdrawn.', 'The inbox copy was withdrawn.')
    .replace(/\bstays\b/gi, 'was set aside')
    .replace(/\bstored\b/gi, 'handed off')
    .replace(/\bdelivered\b/gi, 'handed off');
}

/** Drops a sentence that repeats an earlier one, or that only restates a shorter one already said. */
function dedupeSentences(text: string): string {
  const kept: string[] = [];
  for (const part of text.split(/(?<=\.)\s+/)) {
    const sentence = part.trim();
    if (!sentence) continue;
    const body = sentence.replace(/\.+$/, '');
    const overlap = kept.findIndex((prev) => {
      const prevBody = prev.replace(/\.+$/, '');
      return prevBody === body || prevBody.startsWith(body) || body.startsWith(prevBody);
    });
    if (overlap === -1) kept.push(sentence);
    else if (body.length > kept[overlap].replace(/\.+$/, '').length) kept[overlap] = sentence;
  }
  return kept.join(' ');
}

function withoutOverlap(notes: string[], said: string): string[] {
  const bodies = said
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim().replace(/\.+$/, ''))
    .filter(Boolean);
  return notes.filter((note) => {
    const body = note.trim().replace(/\.+$/, '');
    return !bodies.some((prev) => prev === body || body.startsWith(prev) || prev.startsWith(body));
  });
}

interface Retract {
  withdrawn: WithdrawResult;
  signal: string;
  notes: string[];
}

/**
 * Every failure withdraws the inbox copy, deletes a queued Codex item, and cancels a wake that is still
 * on disk. A file already in `withdrawn/` stays there. Nothing is moved back to the inbox.
 */
async function retract(peer: Peer, messageId: string, routeStatus: string, deleteMs: number): Promise<Retract> {
  const stored = storedMessage(peer.id, messageId);
  const withdrawn = withdrawPending(peer.id, messageId);
  const signal = UNRECALLABLE.test(routeStatus) ? routeStatus : scrubSignal(routeStatus);
  const notes: string[] = [];
  const noted = signal !== routeStatus && /was withdrawn/i.test(signal);
  if (withdrawn === 'withdrawn' && !noted && !UNRECALLABLE.test(routeStatus)) {
    notes.push('The inbox copy was withdrawn so a later turn cannot pick it up.');
  }
  if (withdrawn === 'claimed') notes.push('The inbox copy was already claimed, which is not proof the model saw it.');

  const queueId = stored?.codexQueueId;
  const thread = stored?.codexThreadId ?? peer.sessionId;
  if (peer.agent === 'codex' && queueId && thread) {
    if (deleteMs <= 0) {
      notes.push('The Codex queue item could not be removed in the time left.');
    } else {
      const removed = await deleteFromCodexQueue(thread, [queueId], peer.codexHome, deleteMs);
      if (!removed) notes.push('The Codex queue item could not be removed because the app-server was unreachable.');
      else if (removed.get(queueId) === false) notes.push('Codex had already taken the queue item, so it could not be removed.');
      else notes.push('The Codex queue item was removed.');
    }
  }

  const wake = cancelWake(peer.id, messageId);
  if (/webhook|delivery command/i.test(routeStatus)) {
    notes.push(
      wake === 'cancelled'
        ? 'The pending wake was cancelled before it was sent.'
        : 'A wake that already left cannot be recalled; its body has no message text.',
    );
  }
  return { withdrawn, signal, notes };
}

function failureStatus(
  peer: Peer,
  marker: string,
  routeStatus: string,
  reason: 'offline' | 'unconfirmed',
  retracted: Retract,
  located: boolean,
): string {
  const extra = retracted.notes.length ? ` ${retracted.notes.join(' ')}` : '';
  if (UNRECALLABLE.test(routeStatus)) {
    const where = located
      ? 'A transcript file was found and does not contain the marker, so delivery is unconfirmed.'
      : 'No transcript file was found for this session, so delivery is unconfirmed.';
    return `${routeStatus} ${where}${extra}`;
  }
  if (reason === 'offline') {
    const copy =
      retracted.withdrawn === 'withdrawn'
        ? 'The inbox copy was withdrawn.'
        : 'Nothing was left in its inbox.';
    const rest = withoutOverlap(retracted.notes, copy);
    const tail = rest.length ? ` ${rest.join(' ')}` : '';
    return `Message failed: ${peerRef(peer)} is offline (session not running). ${copy}${tail}`;
  }
  const where = located
    ? 'A transcript file was found and does not contain the marker, so delivery is unconfirmed.'
    : 'No transcript file was found for this session, so delivery is unconfirmed.';
  return (
    `Message failed: ${peerRef(peer)} did not show ${marker} in its transcript before the wait ended. ` +
    `${where} Strongest signal: ${retracted.signal}${extra}`
  );
}

/**
 * Polls the transcript until the abort budget, withdraws what can still be withdrawn, then polls for the
 * grace period. The marker during either window is success. Anything else goes through `fail`, which
 * withdraws the inbox copy. The return after the grace period does not wait again.
 */
export async function confirmDelivery(peer: Peer, message: Message, routeStatus: string): Promise<ConfirmOutcome> {
  const marker = messageMarker(message.id);
  const delivered = `Message delivered to ${peerRef(peer)}. The transcript shows ${marker}.`;
  const plan = confirmWindow();
  const deleteBudget = () =>
    plan.deadline === undefined
      ? CONFIRM_QUEUE_DELETE_MS
      : Math.min(CONFIRM_QUEUE_DELETE_MS, Math.max(0, plan.deadline - Date.now()));
  let retracted: Retract | undefined;
  const fail = async (reason: 'offline' | 'unconfirmed', located = false): Promise<ConfirmOutcome> => {
    if (reason === 'offline') notePeerExit(peer.id);
    retracted ??= await retract(peer, message.id, routeStatus, deleteBudget());
    const status = failureStatus(peer, marker, routeStatus, reason, retracted, located);
    const text = UNRECALLABLE.test(routeStatus) ? status : scrubSignal(status);
    return { confirmed: false, status: dedupeSentences(text) };
  };

  // A held socket copy can still show up after the process looks gone, so that wait runs below.
  if (!UNRECALLABLE.test(routeStatus) && !isPeerAlive(peer)) return fail('offline');
  const first = await untilMarker(peer, marker, plan.abort);
  if (first.kind === 'found') {
    archiveSettled(peer.id, message.id);
    return { confirmed: true, status: delivered };
  }
  if (first.kind === 'offline') return fail('offline');

  // Withdraw before the grace period, including the queue delete, so the grace poll is the last wait.
  retracted = await retract(peer, message.id, routeStatus, deleteBudget());
  const graceMs = plan.deadline === undefined ? plan.grace : Math.max(0, plan.deadline - Date.now());
  const second = await untilMarker(peer, marker, graceMs);
  if (second.kind === 'found') {
    archiveSettled(peer.id, message.id);
    return { confirmed: true, status: delivered };
  }
  if (second.kind === 'offline') return fail('offline');
  return fail('unconfirmed', second.located);
}
