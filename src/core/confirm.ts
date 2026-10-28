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
  // 105s + 10s grace stays under Claude's ~120s move of a live tool call to the background.
  return envMs('TELEPATHY_CONFIRM_ABORT_MS', 105_000);
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

async function untilMarker(peer: Peer, marker: string, budgetMs: number): Promise<'found' | 'timeout' | 'offline'> {
  const deadline = Date.now() + budgetMs;
  const step = confirmPollMs();
  for (;;) {
    if (transcriptHasMarker(peer, marker)) return 'found';
    if (!isPeerAlive(peer)) return 'offline';
    const left = deadline - Date.now();
    if (left <= 0) return 'timeout';
    await sleep(Math.min(step, left));
  }
}

/**
 * The process is gone. A copy written while it was live stays in the inbox for resume. A send that never wrote
 * one says so. Either way the tool result is a failure.
 */
function offlineInFlight(peer: Peer, messageId: string): ConfirmOutcome {
  notePeerExit(peer.id);
  cancelWake(peer.id, messageId);
  const inbox = path.join(inboxDir(peer.id), `${messageId}.json`);
  const aside = path.join(withdrawnDir(peer.id), `${messageId}.json`);
  if (!fs.existsSync(inbox) && fs.existsSync(aside)) {
    try {
      fs.renameSync(aside, path.join(ensureDir(inboxDir(peer.id)), `${messageId}.json`));
    } catch {
      // already gone
    }
  }
  const kept = fs.existsSync(inbox);
  return {
    confirmed: false,
    status: kept
      ? `Message failed: ${peerRef(peer)} is offline (session not running). A copy already in its inbox stays for when that session resumes.`
      : `Message failed: ${peerRef(peer)} is offline (session not running), so nothing was stored.`,
  };
}

export interface ConfirmOutcome {
  confirmed: boolean;
  status: string;
}

const UNRECALLABLE = /cannot be recalled/i;

/**
 * Quoted after the marker was not found. A route status that says the message was delivered is the route's
 * guess. The word belongs only on the success result, which is returned before this runs.
 */
function unconfirmedSignal(routeStatus: string): string {
  return routeStatus.replace(/Message delivered to /g, 'Unconfirmed handoff to ');
}

/** The route promised the inbox would remain. After a withdraw, that sentence is no longer true. */
function signalAfterWithdraw(routeStatus: string, withdrawn: WithdrawResult): { signal: string; noted: boolean } {
  if (withdrawn !== 'withdrawn') return { signal: routeStatus, noted: false };
  const signal = routeStatus
    .replace(
      'It stays in the inbox for the next prompt, or until the session calls read_messages.',
      'The inbox copy was withdrawn, so the next prompt will not see it.',
    )
    .replace(
      'It stays in the inbox until the session calls read_messages.',
      'The inbox copy was withdrawn, so a later read will not see it.',
    )
    .replace('The inbox copy can still be withdrawn.', 'The inbox copy was withdrawn.');
  return { signal, noted: signal !== routeStatus };
}

/**
 * Polls the transcript until the abort budget, withdraws what can still be withdrawn, then polls for the
 * grace period. The marker during either window is success. Anything else is `Message failed:`.
 */
export async function confirmDelivery(peer: Peer, message: Message, routeStatus: string): Promise<ConfirmOutcome> {
  const marker = messageMarker(message.id);
  const delivered = `Message delivered to ${peerRef(peer)}. The transcript shows ${marker}.`;
  // A held socket copy can still show up after the process looks gone, so that wait runs below.
  if (!UNRECALLABLE.test(routeStatus) && !isPeerAlive(peer)) return offlineInFlight(peer, message.id);
  const first = await untilMarker(peer, marker, confirmAbortMs());
  if (first === 'found') {
    archiveSettled(peer.id, message.id);
    return { confirmed: true, status: delivered };
  }
  if (first === 'offline') return offlineInFlight(peer, message.id);

  const stored = storedMessage(peer.id, message.id);
  const withdrawn = withdrawPending(peer.id, message.id);
  const { signal: withdrawnSignal, noted } = signalAfterWithdraw(routeStatus, withdrawn);
  const signal = unconfirmedSignal(withdrawnSignal);
  const notes: string[] = [];
  if (withdrawn === 'withdrawn' && !noted && !UNRECALLABLE.test(routeStatus)) {
    notes.push('The inbox copy was withdrawn so a later turn cannot pick it up.');
  }
  if (withdrawn === 'claimed') notes.push('The inbox copy was already claimed, which is not proof the model saw it.');

  const queueId = stored?.codexQueueId;
  const thread = stored?.codexThreadId ?? peer.sessionId;
  if (peer.agent === 'codex' && queueId && thread) {
    const removed = await deleteFromCodexQueue(thread, [queueId], peer.codexHome);
    if (!removed) notes.push('The Codex queue item could not be removed because the app-server was unreachable.');
    else if (removed.get(queueId) === false) notes.push('Codex had already taken the queue item, so it could not be removed.');
    else notes.push('The Codex queue item was removed.');
  }

  const wake = cancelWake(peer.id, message.id);
  if (/webhook|delivery command/i.test(routeStatus)) {
    notes.push(
      wake === 'cancelled'
        ? 'The pending wake was cancelled before it was sent.'
        : 'A wake that already left cannot be recalled; its body has no message text.',
    );
  }

  const second = await untilMarker(peer, marker, confirmGraceMs());
  if (second === 'found') {
    archiveSettled(peer.id, message.id);
    return { confirmed: true, status: delivered };
  }
  if (second === 'offline') return offlineInFlight(peer, message.id);

  const look = inspectTranscript(peer, marker);
  const where = look.located
    ? 'A transcript file was found and does not contain the marker, so delivery is unconfirmed.'
    : 'No transcript file was found for this session, so delivery is unconfirmed.';
  const extra = notes.length ? ` ${notes.join(' ')}` : '';
  if (UNRECALLABLE.test(routeStatus)) {
    return {
      confirmed: false,
      status: `${routeStatus} ${where}${extra}`,
    };
  }
  return {
    confirmed: false,
    status:
      `Message failed: ${peerRef(peer)} did not show ${marker} in its transcript before the wait ended. ` +
      `${where} Strongest signal: ${signal}${extra}`,
  };
}
