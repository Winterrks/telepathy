import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { debugLog } from './debug.ts';
import type { Message } from './messages.ts';
import { readJson, stateDir } from './paths.ts';
import type { Peer } from './peers.ts';

/**
 * Opt-in wake for a peer that cannot be reached by a hook or a monitor. Grok Bot is the case this is for: the bot
 * runs on another machine, and a process on this one posts a webhook (or runs a command) when a message arrives.
 * The body is a wake, not the message. The message stays in the inbox, and the receiver has to read it and treat
 * the wake as untrusted. Secrets are read from `delivery.json` only when that file is mode 600, and they are never
 * logged. One attempt, no retry. The current wrapper client uses an 8 second timeout and does not retry.
 */

export interface WebhookTarget {
  url: string;
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
  from: string;
  count: number;
  at: string;
}

export type WakeResult =
  | { ok: true; how: 'webhook' | 'command' }
  | { ok: false; how: 'webhook' | 'command'; detail: string };

const DEFAULT_TIMEOUT_MS = 8_000;

export const deliveryConfigPath = () => path.join(stateDir(), 'delivery.json');

export function wakePayload(message: Message): WakePayload {
  return { id: message.id, from: message.from.address, count: 1, at: message.sentAt };
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

const scrub = (text: string, secrets: string[]) => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out.slice(0, 200);
};

const headerSecrets = (headers: Record<string, string> | undefined) => Object.values(headers ?? {}).filter((v) => v.length >= 4);

async function postWebhook(target: WebhookTarget, payload: WakePayload): Promise<WakeResult> {
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets = headerSecrets(target.headers);
  let host = 'webhook';
  try {
    host = new URL(target.url).host || host;
  } catch {
    debugLog('wake', 'webhook url is not a URL');
    return { ok: false, how: 'webhook', detail: 'webhook url is invalid' };
  }
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...target.headers },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      debugLog('wake', `webhook ${host} HTTP ${res.status}`);
      return { ok: false, how: 'webhook', detail: `HTTP ${res.status}` };
    }
    debugLog('wake', `webhook ${host} HTTP ${res.status}`);
    return { ok: true, how: 'webhook' };
  } catch (err) {
    const detail = scrub((err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message, secrets);
    debugLog('wake', `webhook ${host} failed: ${detail}`);
    return { ok: false, how: 'webhook', detail };
  }
}

function runCommand(argv: string[], payload: WakePayload, timeoutMs: number): Promise<WakeResult> {
  const bin = argv[0];
  if (!bin) return Promise.resolve({ ok: false, how: 'command', detail: 'command is empty' });
  return new Promise((resolve) => {
    const child = spawn(bin, argv.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 200) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      debugLog('wake', `command ${path.basename(bin)} failed: ${err.message}`);
      resolve({ ok: false, how: 'command', detail: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        debugLog('wake', `command ${path.basename(bin)} exited 0`);
        resolve({ ok: true, how: 'command' });
        return;
      }
      debugLog('wake', `command ${path.basename(bin)} exited ${code ?? 'signal'}`);
      resolve({ ok: false, how: 'command', detail: stderr.trim().slice(0, 120) || `exit ${code ?? 'signal'}` });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Webhook first, then the command if the webhook is missing or the POST failed. The inbox is not claimed.
 * `detail` on failure is safe to show to the sender.
 */
export async function notifyWake(peer: Peer, message: Message): Promise<WakeResult | undefined> {
  const target = wakeForPeer(peer);
  if (!target) return undefined;
  const payload = wakePayload(message);
  if (target.webhook?.url) {
    const posted = await postWebhook(target.webhook, payload);
    if (posted.ok || !target.command?.length) return posted;
    const ran = await runCommand(target.command, payload, target.webhook.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (ran.ok) return { ok: true, how: 'command' };
    return { ok: false, how: 'webhook', detail: `${posted.detail}; command failed (${ran.detail})` };
  }
  if (target.command?.length) return runCommand(target.command, payload, DEFAULT_TIMEOUT_MS);
  return undefined;
}
