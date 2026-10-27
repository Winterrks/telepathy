import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { debugLog } from './debug.ts';
import type { Message } from './messages.ts';
import { ensureDir, inboxDir, readJson, stateDir, writeJsonAtomic } from './paths.ts';
import type { Peer } from './peers.ts';

/**
 * Opt-in wake for a peer that cannot be reached by a hook or a monitor. Grok Bot is the case this is for.
 * A process on this machine POSTs a webhook, or runs a command, when a message arrives. The body is a wake,
 * not the message. The message stays in the inbox. The remote routine cannot read that inbox. A client on
 * this machine still has to, either a persistent local session or the server started with TELEPATHY_NAME.
 * Secrets are read from delivery.json only when that file is mode 600, and they are never logged.
 * One attempt, no retry. Messages for the same URL within WAKE_DEBOUNCE_MS share one POST.
 */

export interface WebhookTarget {
  url: string;
  /** Sent as `Authorization: Bearer <key>` and `X-Automation-Key: <key>` unless `authHeaders` names others. */
  key?: string;
  /** Header names that receive `key`. Default is both of the headers above. `Authorization` is sent as a Bearer token. */
  authHeaders?: string[];
  /** Extra headers. A name that matches an auth header replaces that value. */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface WakeTarget {
  webhook?: WebhookTarget;
  /** argv, not a shell string. The wake JSON is written to stdin. */
  command?: string[];
}

interface DeliveryFile {
  name?: string;
  webhook?: WebhookTarget;
  command?: string[];
  peers?: Record<string, WakeTarget>;
}

export interface WakePayload {
  id: string;
  /** Every id in this POST, oldest first. `id` is the last of these. */
  ids: string[];
  from: string;
  count: number;
  at: string;
}

export interface ProbePayload {
  event: 'probe';
}

export type WakeResult = {
  ok: boolean;
  how: 'webhook' | 'command';
  detail?: string;
  /** HTTP status, or the command's exit code. */
  status?: number;
  /** Set when the POST has not run yet. Failures land in wake.log. */
  scheduled?: boolean;
};

export interface ProbeReport {
  how: 'webhook' | 'command';
  /** Hostname, or the command's file name. Never the key, the path, or the query string. */
  target: string;
  status?: number;
  ok: boolean;
  detail?: string;
}

/** Wait after the last message in a burst before one POST. */
export const WAKE_DEBOUNCE_MS = 400;
/** A burst never waits longer than this after its first message. */
export const WAKE_DEBOUNCE_MAX_MS = 1_500;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_AUTH_HEADERS = ['Authorization', 'X-Automation-Key'];

export const deliveryConfigPath = () => path.join(stateDir(), 'delivery.json');
export const wakeLogPath = () => path.join(stateDir(), 'wake.log');

export function wakeDebounceMs(): number {
  const n = Number(process.env.TELEPATHY_WAKE_DEBOUNCE_MS);
  if (Number.isFinite(n) && n >= 0) return n;
  return WAKE_DEBOUNCE_MS;
}

export function wakeDebounceMaxMs(): number {
  const n = Number(process.env.TELEPATHY_WAKE_DEBOUNCE_MAX_MS);
  const configured = Number.isFinite(n) && n >= 0 ? n : WAKE_DEBOUNCE_MAX_MS;
  return Math.max(configured, wakeDebounceMs());
}

interface WakeItem {
  id: string;
  peerId: string;
  from: string;
  at: string;
}

interface WakeBatch {
  items: WakeItem[];
  firstAtMs: number;
  lastAtMs: number;
  webhook?: WebhookTarget;
  command?: string[];
}

const wakeDir = () => path.join(stateDir(), 'wake');
const batchPath = (key: string) => path.join(wakeDir(), `${key}.json`);

function batchKey(target: WakeTarget): string {
  const material = JSON.stringify({ url: target.webhook?.url ?? '', command: target.command ?? [] });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** Mode 600 only. A looser file is ignored and not parsed, so a world-readable secret is never loaded. */
export function readDeliveryConfig(): DeliveryFile | undefined {
  const file = deliveryConfigPath();
  let mode: number;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
  if ((mode & 0o077) !== 0) {
    debugLog('wake', `delivery.json is mode ${mode.toString(8)}, not 600; webhook config was not loaded`);
    return undefined;
  }
  return readJson<DeliveryFile>(file);
}

export function configModeProblem(): string | undefined {
  const file = deliveryConfigPath();
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) return `delivery.json is mode ${mode.toString(8)}, not 600; nothing was sent`;
    return undefined;
  } catch {
    return 'delivery.json is not configured';
  }
}

export function wakeForPeer(peer: Peer, config = readDeliveryConfig()): WakeTarget | undefined {
  if (!config) return undefined;
  const keys = [peer.address, peer.stableName, peer.id].filter((k): k is string => !!k);
  for (const key of keys) {
    const hit = config.peers?.[key];
    if (hit?.webhook?.url || hit?.command?.length) return hit;
  }
  if (!config.webhook?.url && !config.command?.length) return undefined;
  const name = config.name?.trim().toLowerCase();
  if (!name) return undefined;
  if (peer.stableName === name || peer.address.toLowerCase() === `${peer.agent}:${name}`) {
    return { webhook: config.webhook, command: config.command };
  }
  return undefined;
}

export function webhookHeaders(target: WebhookTarget): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = target.key?.trim();
  if (key) {
    const names = target.authHeaders?.length ? target.authHeaders : DEFAULT_AUTH_HEADERS;
    for (const name of names) {
      headers[name] = name.toLowerCase() === 'authorization' ? `Bearer ${key}` : key;
    }
  }
  for (const [name, value] of Object.entries(target.headers ?? {})) headers[name] = value;
  return headers;
}

function headerSecrets(headers: Record<string, string> | undefined): string[] {
  return Object.values(headers ?? {}).filter((v) => v.length >= 4);
}

function secretValues(target: WebhookTarget | undefined): string[] {
  const values = headerSecrets(webhookHeaders(target ?? { url: '' }));
  const key = target?.key?.trim();
  if (key && key.length >= 4) values.push(key);
  if (target?.url) {
    try {
      for (const value of new URL(target.url).searchParams.values()) {
        if (value.length >= 4) values.push(value);
      }
    } catch {
      // invalid URLs are rejected before a request
    }
  }
  return values;
}

const scrub = (text: string, secrets: string[]) => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out.slice(0, 200);
};

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'webhook';
  } catch {
    return 'webhook';
  }
}

/** Failures only. The line is time, kind, host, and status or error. No key, path, query, or message text. */
function logFailure(kind: 'webhook' | 'command', target: string, detail: string, secrets: string[], url?: string): void {
  let text = `${kind} ${target} ${detail}`;
  if (url) text = text.split(url).join(target);
  const safe = scrub(text, secrets);
  try {
    ensureDir(stateDir());
    fs.appendFileSync(wakeLogPath(), `${new Date().toISOString()} ${safe}\n`);
    fs.chmodSync(wakeLogPath(), 0o600);
  } catch {
    // a log failure must not drop the inbox copy
  }
  debugLog('wake', safe);
}

function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    while (Date.now() < until) {
      // only used when the wake lock is held by another process
    }
  }
}

function withLockSync<T>(fn: () => T): T {
  ensureDir(wakeDir());
  const lock = path.join(wakeDir(), '.lock');
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lock);
        } catch {
          // already gone
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) fs.unlinkSync(lock);
      } catch {
        // the holder removed it
      }
      if (Date.now() - start > 2_000) throw new Error('wake lock timed out');
      sleepSync(10);
    }
  }
}

function pendingItems(items: WakeItem[]): WakeItem[] {
  return items.filter((item) => {
    try {
      return fs.existsSync(path.join(inboxDir(item.peerId), `${item.id}.json`));
    } catch {
      return false;
    }
  });
}

export function wakePayload(items: WakeItem[]): WakePayload {
  const last = items[items.length - 1];
  return {
    id: last?.id ?? '',
    ids: items.map((item) => item.id),
    from: last?.from ?? '',
    count: items.length,
    at: last?.at ?? '',
  };
}

let refTimers = true;
let timer: NodeJS.Timeout | undefined;
let flushing: Promise<void> | undefined;
let flusherStarted = false;

/** The hook process exits after it prints. A running server posts the batch it left behind. */
export function unrefWakeTimers(): void {
  refTimers = false;
  timer?.unref();
}

function armTimer(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void kick();
  }, ms);
  if (!refTimers) timer.unref();
}

function scheduleFlush(): void {
  armTimer(wakeDebounceMs());
}

async function kick(): Promise<void> {
  if (flushing) {
    await flushing;
    return;
  }
  flushing = flushDue().finally(() => {
    flushing = undefined;
  });
  await flushing;
}

/**
 * Started by a long-lived telepathy server. Hook processes write a batch and exit. This loop posts it.
 * The interval does not keep the process alive. The server's own stdin does.
 */
export function startWakeFlusher(): void {
  if (flusherStarted) return;
  flusherStarted = true;
  refTimers = true;
  ensureDir(wakeDir());
  const tick = () => {
    void kick();
  };
  setInterval(tick, 200).unref();
  try {
    const watcher = fs.watch(wakeDir(), tick);
    watcher.unref();
  } catch {
    // the interval still looks
  }
}

/** Waits out the debounce and posts anything due. Tests use this instead of sleeping. */
export async function flushPendingWakes(): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const files = listBatches();
    if (!files.length) return;
    const wait = files.reduce((min, file) => Math.min(min, dueIn(file)), Number.POSITIVE_INFINITY);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await kick();
    if (!listBatches().length) return;
    if (Date.now() - start > 10_000) return;
  }
}

function listBatches(): string[] {
  try {
    return fs
      .readdirSync(wakeDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(wakeDir(), name));
  } catch {
    return [];
  }
}

function dueIn(file: string): number {
  const batch = readJson<WakeBatch>(file);
  if (!batch) return 0;
  const due = Math.min(batch.lastAtMs + wakeDebounceMs(), batch.firstAtMs + wakeDebounceMaxMs());
  return Math.max(0, due - Date.now());
}

async function flushDue(): Promise<void> {
  for (const file of listBatches()) {
    const peek = readJson<WakeBatch>(file);
    if (!peek || dueIn(file) > 0) continue;
    let taken: WakeBatch | undefined;
    withLockSync(() => {
      const cur = readJson<WakeBatch>(file);
      if (!cur) return;
      const due = Math.min(cur.lastAtMs + wakeDebounceMs(), cur.firstAtMs + wakeDebounceMaxMs());
      if (Date.now() < due) return;
      taken = cur;
      try {
        fs.unlinkSync(file);
      } catch {
        taken = undefined;
      }
    });
    if (taken) await deliverBatch(taken);
  }
}

async function deliverBatch(batch: WakeBatch): Promise<void> {
  const items = pendingItems(batch.items);
  if (!items.length) return;
  const payload = wakePayload(items);
  const target: WakeTarget = { webhook: batch.webhook, command: batch.command };
  await deliver(target, payload);
}

async function deliver(target: WakeTarget, payload: WakePayload | ProbePayload): Promise<WakeResult> {
  if (target.webhook?.url) {
    const posted = await postWebhook(target.webhook, payload);
    if (posted.ok || !target.command?.length) return posted;
    const ran = await runCommand(target.command, payload, target.webhook.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (ran.ok) return ran;
    return { ok: false, how: 'webhook', detail: `${posted.detail}; command failed (${ran.detail})` };
  }
  if (target.command?.length) return runCommand(target.command, payload, DEFAULT_TIMEOUT_MS);
  return { ok: false, how: 'webhook', detail: 'webhook url is invalid' };
}

async function postWebhook(target: WebhookTarget, payload: WakePayload | ProbePayload): Promise<WakeResult> {
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets = secretValues(target);
  let host = 'webhook';
  try {
    host = new URL(target.url).host || host;
  } catch {
    logFailure('webhook', host, 'failed: url is invalid', secrets);
    return { ok: false, how: 'webhook', detail: 'webhook url is invalid' };
  }
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: webhookHeaders(target),
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logFailure('webhook', host, `HTTP ${res.status}`, secrets, target.url);
      return { ok: false, how: 'webhook', detail: `HTTP ${res.status}`, status: res.status };
    }
    debugLog('wake', `webhook ${host} HTTP ${res.status}`);
    return { ok: true, how: 'webhook', status: res.status };
  } catch (err) {
    const detail = scrub((err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message, secrets);
    logFailure('webhook', host, `failed: ${detail}`, secrets, target.url);
    return { ok: false, how: 'webhook', detail };
  }
}

function runCommand(argv: string[], payload: WakePayload | ProbePayload, timeoutMs: number): Promise<WakeResult> {
  const bin = argv[0];
  const name = bin ? path.basename(bin) : 'command';
  if (!bin) {
    logFailure('command', name, 'failed: command is empty', []);
    return Promise.resolve({ ok: false, how: 'command', detail: 'command is empty' });
  }
  return new Promise((resolve) => {
    const child = spawn(bin, argv.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
    const timerId = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timerId);
      const detail = scrub(err.message, []);
      logFailure('command', name, `failed: ${detail}`, []);
      resolve({ ok: false, how: 'command', detail });
    });
    child.on('close', (code) => {
      clearTimeout(timerId);
      if (code === 0) {
        debugLog('wake', `command ${name} exited 0`);
        resolve({ ok: true, how: 'command', status: 0 });
        return;
      }
      logFailure('command', name, `exited ${code ?? 'signal'}`, []);
      resolve({ ok: false, how: 'command', detail: `exit ${code ?? 'signal'}`, status: code ?? undefined });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Appends the message to the burst for this peer's webhook or command. The POST waits out the debounce so
 * several messages share one request. The caller is not told the HTTP status. A failure is appended to wake.log.
 */
export function notifyWake(peer: Peer, message: Message): WakeResult | undefined {
  const target = wakeForPeer(peer);
  if (!target) return undefined;
  if (target.webhook?.url) {
    try {
      void new URL(target.webhook.url);
    } catch {
      return { ok: false, how: 'webhook', detail: 'webhook url is invalid' };
    }
  }
  const key = batchKey(target);
  const file = batchPath(key);
  try {
    withLockSync(() => {
      const batch = readJson<WakeBatch>(file) ?? {
        items: [],
        firstAtMs: Date.now(),
        lastAtMs: Date.now(),
        webhook: target.webhook,
        command: target.command,
      };
      if (!batch.items.some((item) => item.id === message.id)) {
        batch.items.push({ id: message.id, peerId: message.to.id, from: message.from.address, at: message.sentAt });
      }
      batch.lastAtMs = Date.now();
      batch.webhook = target.webhook;
      batch.command = target.command;
      writeJsonAtomic(file, batch);
    });
  } catch (err) {
    const detail = scrub((err as Error).message, secretValues(target.webhook));
    logFailure(target.webhook?.url ? 'webhook' : 'command', target.webhook?.url ? hostOf(target.webhook.url) : 'command', `failed: ${detail}`, secretValues(target.webhook));
    return { ok: false, how: target.webhook?.url ? 'webhook' : 'command', detail };
  }
  scheduleFlush();
  return { ok: true, how: target.webhook?.url ? 'webhook' : 'command', scheduled: true };
}

function listedTargets(config: DeliveryFile): { label: string; target: WakeTarget }[] {
  const out: { label: string; target: WakeTarget }[] = [];
  if (config.webhook?.url || config.command?.length) {
    out.push({
      label: config.name?.trim() || 'default',
      target: { webhook: config.webhook, command: config.command },
    });
  }
  for (const [key, target] of Object.entries(config.peers ?? {})) {
    if (target.webhook?.url || target.command?.length) out.push({ label: key, target });
  }
  const seen = new Set<string>();
  return out.filter((entry) => {
    const key = batchKey(entry.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchesName(label: string, config: DeliveryFile, which: string): boolean {
  const wanted = which.trim().toLowerCase();
  const name = label.trim().toLowerCase();
  if (name === wanted) return true;
  const configured = config.name?.trim().toLowerCase();
  if (!configured || name !== configured) return false;
  return wanted === configured || wanted === `grok:${configured}` || wanted.endsWith(`:${configured}`);
}

/** Sends `{"event":"probe"}` to the configured webhook or command. Does not write the inbox. */
export async function probeDelivery(which?: string): Promise<{ reports: ProbeReport[]; error?: string }> {
  const problem = configModeProblem();
  if (problem) return { reports: [], error: problem };
  const config = readDeliveryConfig();
  if (!config) return { reports: [], error: 'delivery.json is not configured' };
  let targets = listedTargets(config);
  if (which) {
    targets = targets.filter((entry) => matchesName(entry.label, config, which));
    if (!targets.length) return { reports: [], error: `no webhook or command named ${which}` };
  }
  if (!targets.length) return { reports: [], error: 'delivery.json has no webhook or command' };
  const reports: ProbeReport[] = [];
  for (const entry of targets) {
    const result = await deliver(entry.target, { event: 'probe' });
    const target = entry.target.webhook?.url ? hostOf(entry.target.webhook.url) : path.basename(entry.target.command?.[0] ?? 'command');
    reports.push({
      how: result.how,
      target,
      status: result.status,
      ok: result.ok,
      detail: result.detail ? scrub(result.detail, secretValues(entry.target.webhook)) : undefined,
    });
  }
  return { reports };
}
