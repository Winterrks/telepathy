import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onPath } from '../cli/harnesses.ts';
import { archiveSettled, formatAsUserTurn, type Message, pendingMessages } from '../core/messages.ts';
import { ensureDir, envDurationMs, inboxDir, peerDir, withdrawnDir } from '../core/paths.ts';
import { notePeerExit } from '../core/peers.ts';
import { isSameProcess, procStart } from '../core/proc.ts';
import { noteTag } from '../core/tags.ts';
import { clearHosted, headlessLogPath, readHeadlessRecord, registerHostedPeer, writeHeadlessRecord } from '../headless/peer.ts';
import { type GrokBotConfig, grokbotDir, readConfig } from './config.ts';

/**
 * The Grok Bot's peer on this machine. A Grok Bot runs in xAI's cloud and can't read `~/.telepathy`, so this
 * process holds its address (`grok:<name>`) and, when messages arrive, POSTs them to the Bot's webhook-triggered
 * routine as `{"context": …}`, the body the Grok Bot app's own Run button sends. The routine's run starts with
 * the messages in hand. The POST is the submit: a 2xx is recorded as delivery, the way the ACP host records
 * `session/prompt`. The Bot replies by running `telepathy grokbot send` on this machine.
 */

/** Wait after the newest message so a burst shares one run; every POST is a full turn for the Bot. */
const debounceMs = () => envDurationMs('TELEPATHY_GROKBOT_DEBOUNCE_MS', 400);
const debounceMaxMs = () => envDurationMs('TELEPATHY_GROKBOT_DEBOUNCE_MAX_MS', 1_500);
const postTimeoutMs = () => envDurationMs('TELEPATHY_GROKBOT_TIMEOUT_MS', 20_000);
/** Retry delays after a refused POST. A message still unsent when its sender gives up is withdrawn there. */
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const MAX_BATCH = 10;
const MAX_CONTEXT_CHARS = 400_000;

export interface PostResult {
  ok: boolean;
  status?: number;
  runId?: string;
  detail?: string;
  ms: number;
}

/** One POST to the routine. The key goes in the Authorization header only, and never into a log line. */
export async function postContext(config: Pick<GrokBotConfig, 'url' | 'key'>, context: string): Promise<PostResult> {
  const start = Date.now();
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ context }),
      redirect: 'error',
      signal: AbortSignal.timeout(postTimeoutMs()),
    });
    const text = await res.text().catch(() => '');
    let body: { runUuid?: unknown; message?: unknown; error?: unknown } | undefined;
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      body = undefined;
    }
    const ms = Date.now() - start;
    if (!res.ok) {
      const said = [body?.error, body?.message].find((v): v is string => typeof v === 'string' && !!v.trim());
      const hint = res.headers.get('x-automation-failure-hint');
      const detail = [`HTTP ${res.status}`, said, hint ? `hint ${hint}` : ''].filter(Boolean).join(': ');
      return { ok: false, status: res.status, detail: scrub(detail, config.key), ms };
    }
    return { ok: true, status: res.status, runId: typeof body?.runUuid === 'string' ? body.runUuid : undefined, ms };
  } catch (err) {
    const e = err as Error;
    const detail = e.name === 'TimeoutError' ? `timed out after ${Math.round(postTimeoutMs() / 1000)}s` : e.message;
    return { ok: false, detail: scrub(detail, config.key), ms: Date.now() - start };
  }
}

const scrub = (text: string, key: string) => (key.length >= 4 ? text.split(key).join('[key]') : text).slice(0, 300);

/**
 * argv that runs a grokbot subcommand from this process: `grokbot.mjs` beside a bundled server, `grokbot-main.ts`
 * from source, or the telepathy CLI that is running now.
 */
export function grokbotArgv(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of [path.join(here, 'grokbot.mjs'), path.join(here, '..', 'grokbot-main.ts')]) {
    if (fs.existsSync(file)) return [process.execPath, ...process.execArgv, file];
  }
  return [process.execPath, ...process.execArgv, process.argv[1] ?? '', 'grokbot'];
}

/** POSIX single quotes: a remote address is validated, but this is a command line the Bot will run. */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * One host per Bot. Sessions that start together (after a reboot, every server calls ensureGrokbotHosts) race to
 * start it; two hosts would share one inbox and POST every message twice. The lock file is created exclusively.
 */
function takeLock(slug: string): (() => void) | undefined {
  const file = path.join(ensureDir(grokbotDir()), `${slug}.lock`);
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, procStart: procStart(process.pid) }), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          const held = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
          if (held.pid === process.pid) fs.rmSync(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      let held: { pid?: number; procStart?: string } = {};
      try {
        held = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof held;
      } catch {
        // Half-written by a host starting right now: it holds the lock.
        return undefined;
      }
      if (typeof held.pid === 'number' && isSameProcess(held.pid, held.procStart)) return undefined;
      fs.rmSync(file, { force: true });
    }
  }
  return undefined;
}

/** What the Bot types on this machine to reach the grokbot commands: `telepathy grokbot` when it's on PATH. */
export function cliCommand(): string {
  if (onPath('telepathy')) return 'telepathy grokbot';
  return grokbotArgv()
    .map((arg, i) => (i === grokbotArgv().length - 1 && arg === 'grokbot' ? arg : `"${arg}"`))
    .join(' ');
}

/** The routine's context: one note on how to answer, then each message as the user turn an agent would see. */
export function contextFor(config: Pick<GrokBotConfig, 'slug'>, messages: Message[], cli = cliCommand()): string {
  const host = os.hostname().replace(/\.local$/, '');
  const send = `${cli} send ${config.slug}`;
  const note = noteTag(
    'wake',
    `telepathy on ${host}: ${messages.length === 1 ? 'a message' : `${messages.length} messages`} for you (grok:${config.slug}). ` +
      `To answer, run on ${host}: ${send} <address> '<reply>'. \`${cli} peers ${config.slug}\` lists the sessions there. ` +
      `Replies reach that session as a new turn; don't wait or poll.`,
  );
  const turns = messages.map((msg) =>
    formatAsUserTurn(msg, `To reply, run on ${host}: ${send} ${shellQuote(msg.from.address)} '<reply>'.`),
  );
  return [note, ...turns].join('\n\n');
}

function appendTranscript(peerId: string, text: string): void {
  const file = path.join(ensureDir(peerDir(peerId)), 'delivery-transcript.jsonl');
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), text }) + '\n');
}

/** Runs until SIGTERM: `telepathy grokbot host <name>`, started detached by `telepathy grokbot start`. */
export async function runGrokbotHost(slug: string): Promise<number> {
  const initial = readConfig(slug);
  if (!initial) {
    process.stderr.write(`telepathy: no Grok Bot named ${slug} is connected (or its file is not mode 600).\n`);
    return 1;
  }
  const unlock = takeLock(slug);
  if (!unlock) {
    const previous = readHeadlessRecord('grok', slug);
    process.stderr.write(`telepathy: grok:${slug} is already running${previous ? ` (pid ${previous.pid})` : ''}.\n`);
    return 1;
  }
  const logFile = headlessLogPath('grok', slug);
  ensureDir(path.dirname(logFile));
  const log = (line: string) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // a log failure must not stop delivery
    }
  };

  const cwd = process.cwd();
  const hosted = registerHostedPeer('grok', cwd, initial.slug);
  writeHeadlessRecord({
    name: initial.name,
    slug: initial.slug,
    agent: 'grok',
    peerId: hosted.peerId,
    pid: process.pid,
    procStart: procStart(process.pid),
    cwd,
    logFile,
    startedAt: new Date().toISOString(),
  });
  const cli = cliCommand();
  log(`up as ${hosted.address} [${hosted.peerId}], posting to ${new URL(initial.url).host}`);

  const done = new Set<string>();
  let running = false;
  let failures = 0;
  let retryAt = 0;

  const tick = async () => {
    if (running || Date.now() < retryAt) return;
    running = true;
    try {
      const config = readConfig(slug);
      if (!config) {
        log('config removed; stopping');
        stop();
        return;
      }
      const pendingFile = (msg: Message) => path.join(inboxDir(hosted.peerId), `${msg.id}.json`);
      const waiting = pendingMessages(hosted.peerId).filter((msg) => !done.has(msg.id) && fs.existsSync(pendingFile(msg)));
      if (!waiting.length) return;
      const times = waiting.map((msg) => Date.parse(msg.sentAt)).filter(Number.isFinite);
      const now = Date.now();
      if (times.length && now - Math.max(...times) < debounceMs() && now - Math.min(...times) < debounceMaxMs()) return;

      const batch: Message[] = [];
      let size = 0;
      for (const msg of waiting) {
        const cost = msg.body.length + 1_000;
        if (batch.length && (batch.length >= MAX_BATCH || size + cost > MAX_CONTEXT_CHARS)) break;
        batch.push(msg);
        size += cost;
      }
      // The irreversible step is the POST. Anything withdrawn or claimed since the scan stays out of it.
      const live = batch.filter((msg) => fs.existsSync(pendingFile(msg)));
      if (!live.length) return;
      const context = contextFor(config, live, cli);
      const result = await postContext(config, context);
      if (!result.ok) {
        failures++;
        retryAt = Date.now() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
        log(`POST failed for ${live.map((m) => m.id).join(',')}: ${result.detail} (${result.ms}ms); retry in ${Math.round((retryAt - Date.now()) / 1000)}s`);
        return;
      }
      failures = 0;
      for (const msg of live) {
        done.add(msg.id);
        // The sender withdrew it while the POST was in flight: it already failed there, so it is not a delivery.
        if (fs.existsSync(path.join(withdrawnDir(hosted.peerId), `${msg.id}.json`))) continue;
        appendTranscript(hosted.peerId, formatAsUserTurn(msg));
        if (fs.existsSync(pendingFile(msg))) archiveSettled(hosted.peerId, msg.id);
      }
      log(`delivered ${live.map((m) => m.id).join(',')} in one run${result.runId ? ` ${result.runId}` : ''} (HTTP ${result.status}, ${result.ms}ms)`);
    } catch (err) {
      log(`error: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), 100);
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  function stop() {
    clearInterval(timer);
    resolveExit(0);
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    return await exited;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    clearHosted(hosted.peerId);
    notePeerExit(hosted.peerId);
    unlock();
    log('stopped');
  }
}
