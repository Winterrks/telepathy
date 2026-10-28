import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../core/agents.ts';
import { archiveSettled, formatAsUserTurn, pendingMessages } from '../core/messages.ts';
import { ensureDir, inboxDir, peerDir, peersDir, readJson, stateDir, writeJsonAtomic } from '../core/paths.ts';
import { isAlive, procStart } from '../core/proc.ts';
import {
  notePeerExit,
  readPeer,
  readSession,
  registerListener,
  registerSession,
  registerStableName,
  sessionPeerId,
  slugify,
} from '../core/peers.ts';

export interface HeadlessRecord {
  name: string;
  slug: string;
  agent: Agent;
  peerId: string;
  pid: number;
  procStart?: string;
  cwd: string;
  logFile: string;
  harnessSessionId?: string;
  startedAt: string;
}

const headlessDir = () => path.join(stateDir(), 'headless');
export const headlessRecordPath = (agent: Agent, slug: string) => path.join(headlessDir(), `${agent}-${slug}.json`);
export const headlessLogPath = (agent: Agent, slug: string) => path.join(headlessDir(), `${agent}-${slug}.log`);

export function readHeadlessRecord(agent: Agent, slug: string): HeadlessRecord | undefined {
  return readJson<HeadlessRecord>(headlessRecordPath(agent, slug));
}

export function writeHeadlessRecord(record: HeadlessRecord): void {
  writeJsonAtomic(headlessRecordPath(record.agent, record.slug), record);
}

export function listHeadlessRecords(): HeadlessRecord[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(headlessDir());
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson<HeadlessRecord>(path.join(headlessDir(), name)))
    .filter((record): record is HeadlessRecord => !!record && typeof record.pid === 'number');
}

/** Live headless peers, one line each. `telepathy ps`. */
export function formatHeadlessPs(): string {
  const live = listHeadlessRecords().filter((record) => isAlive(record.pid));
  if (!live.length) return 'No headless peers are running.';
  const lines = ['name\tagent\tpeer\tpid\tcwd\tlog'];
  for (const record of live) {
    lines.push([record.slug, record.agent, record.peerId, String(record.pid), record.cwd, record.logFile].join('\t'));
  }
  return lines.join('\n');
}

/** SIGTERM the supervisor `telepathy run --headless` recorded under this name. */
export function stopHeadless(query: string): number {
  const slug = slugify(query);
  const live = listHeadlessRecords().filter((record) => isAlive(record.pid));
  const matches = live.filter(
    (record) =>
      record.slug === slug ||
      record.name === query ||
      record.peerId === query ||
      `${record.agent}:${record.slug}` === query ||
      `${record.agent}:${record.name}` === query,
  );
  if (matches.length === 0) {
    console.error(`telepathy: no running headless peer matches ${JSON.stringify(query)}.`);
    return 1;
  }
  if (matches.length > 1) {
    console.error(`telepathy: ${query} matches ${matches.map((record) => `${record.agent}:${record.slug}`).join(', ')}. Pass agent:name.`);
    return 1;
  }
  const record = matches[0];
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (err) {
    console.error(`telepathy: could not stop ${record.agent}:${record.slug}: ${(err as Error).message}`);
    return 1;
  }
  console.log(`stopped ${record.agent}:${record.slug} (pid ${record.pid})`);
  return 0;
}

const harnessSessionFile = (peerId: string) => path.join(peerDir(peerId), 'harness-session.json');

/** The harness's own session id for this stable peer, kept across restarts. Not the telepathy id. */
export function recallHarnessSession(peerId: string): string | undefined {
  const id = readJson<{ id?: unknown }>(harnessSessionFile(peerId))?.id;
  return typeof id === 'string' && id ? id : undefined;
}

export function rememberHarnessSession(peerId: string, harnessSessionId: string): void {
  writeJsonAtomic(harnessSessionFile(peerId), { id: harnessSessionId });
}

export function writeHosted(peerId: string): void {
  writeJsonAtomic(path.join(peerDir(peerId), 'hosted.json'), {
    pid: process.pid,
    procStart: procStart(process.pid),
  });
}

export function clearHosted(peerId: string): void {
  try {
    fs.rmSync(path.join(peerDir(peerId), 'hosted.json'), { force: true });
  } catch {
    // already gone
  }
}

export interface HostedPeer {
  peerId: string;
  slug: string;
  address: string;
}

/**
 * A stable peer id from `--name` (`<agent>-h-<slug>`), or a pid-scoped id when the run is interactive and unnamed.
 * `hosted.json` is what keeps a Codex thread listed: the slug is not a writer lock.
 */
export function registerHostedPeer(agent: Agent, cwd: string, name?: string): HostedPeer {
  const slug = name ? slugify(name) || `${agent}-headless` : '';
  const sessionId = slug ? `h-${slug}` : `h-pid${process.pid}`;
  const peerId = sessionPeerId(agent, process.pid, sessionId);
  registerSession(agent, process.pid, { sessionId, cwd, source: 'plugin' });
  if (slug) registerStableName(agent, peerId, slug);
  registerListener(agent, process.pid, peerId);
  writeHosted(peerId);
  const peer = readPeer(peerId);
  return { peerId, slug: slug || sessionId, address: peer?.address ?? `${agent}:${slug || sessionId}` };
}

/** Peer id `--name` will use, before this process registers. Used to resume the harness session. */
export function namedPeerId(agent: Agent, name: string): { peerId: string; slug: string } {
  const slug = slugify(name) || `${agent}-headless`;
  return { peerId: sessionPeerId(agent, process.pid, `h-${slug}`), slug };
}

function appendTranscript(peerId: string, text: string): void {
  const file = path.join(ensureDir(peerDir(peerId)), 'delivery-transcript.jsonl');
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), text }) + '\n');
}

/**
 * Injects inbox messages one at a time. `inject` receives a check it must run immediately before the
 * irreversible submit (stdin write, turn, HTTP prompt, or `session/prompt`). The marker is written only
 * after `inject` accepts, and only if the inbox file is still there: `fail()` withdraws that file, and a
 * withdrawn send must not become a success or stay queued.
 */
/**
 * The plugin's peer, when the host did not register one of its own. A stable name matches `identity.json`.
 * A harness session id matches `session.json`. Either is the inbox the host pumps.
 */
export function pluginInboxPeerId(agent: Agent, name?: string, sessionId?: string): string | undefined {
  const slug = name ? slugify(name) : undefined;
  let names: string[] = [];
  try {
    names = fs.readdirSync(peersDir());
  } catch {
    return undefined;
  }
  let byName: string | undefined;
  let bySession: string | undefined;
  for (const id of names) {
    if (!id.startsWith(`${agent}-`)) continue;
    const session = readSession(id);
    if (session?.agent !== agent) continue;
    if (slug) {
      const ident = readJson<{ name?: string }>(path.join(peerDir(id), 'identity.json'));
      if (ident?.name === slug) byName = id;
    }
    if (sessionId && session.sessionId === sessionId) bySession = id;
  }
  return byName ?? bySession;
}

export function startInboxPump(
  peerId: string | (() => string | undefined),
  inject: (text: string, stillPending: () => boolean) => Promise<boolean>,
): () => void {
  const resolve = typeof peerId === 'function' ? peerId : () => peerId;
  const done = new Set<string>();
  let running = false;
  let lastId: string | undefined;
  const tick = async () => {
    if (running) return;
    const id = resolve();
    if (!id) return;
    lastId = id;
    running = true;
    try {
      for (const msg of pendingMessages(id)) {
        if (done.has(msg.id)) continue;
        const file = path.join(inboxDir(id), `${msg.id}.json`);
        if (!fs.existsSync(file)) {
          done.add(msg.id);
          continue;
        }
        const text = formatAsUserTurn(msg);
        const ok = await inject(text, () => fs.existsSync(file));
        if (!fs.existsSync(file)) {
          done.add(msg.id);
          continue;
        }
        if (!ok) return;
        appendTranscript(id, text);
        archiveSettled(id, msg.id);
        done.add(msg.id);
      }
    } catch {
      // the next tick tries again; a dead agent makes inject return false
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 40);
  return () => {
    clearInterval(timer);
    if (lastId) notePeerExit(lastId);
  };
}
