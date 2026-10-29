import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claimInbox, deliveryBlocked, formatAsUserTurn, type Message, withdrawEverywhere } from './core/messages.ts';
import { archiveDir, configuredEnv, ensureDir, envDurationMs, inboxDir, peersDir, readJson } from './core/paths.ts';
import { registerListener, type SessionRecord } from './core/peers.ts';

/**
 * Antigravity App sidecar. Antigravity starts it from `sidecars/telepathy-wake` and puts `agentapi` on PATH.
 * It watches App conversations (surface `app`) and wakes an idle one with
 * `agentapi send-message <conversation_id> <prompt>`. The prompt carries `telepathy-id:`, which confirm
 * looks for in `<app_data_dir>/brain/<id>/.system_generated/logs/transcript.jsonl`.
 * Registering a listener keeps the turn-boundary hooks from injecting the same inbox file.
 */

interface AppConversation {
  id: string;
  pid: number;
  conversationId: string;
}

function appConversations(): AppConversation[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(peersDir());
  } catch {
    return [];
  }
  const found: AppConversation[] = [];
  for (const name of names) {
    const session = readJson<SessionRecord>(path.join(peersDir(), name, 'session.json'));
    if (session?.agent !== 'antigravity' || session.surface !== 'app' || !session.sessionId) continue;
    found.push({ id: name, pid: session.pid, conversationId: session.sessionId });
  }
  return found;
}

/** Puts a failed send back only when the sender has not withdrawn it and its deadline has not passed. */
function restoreClaimed(peerId: string, messages: Message[]): void {
  for (const msg of messages) {
    if (deliveryBlocked(peerId, msg)) {
      withdrawEverywhere(peerId, msg.id);
      continue;
    }
    const dest = path.join(ensureDir(inboxDir(peerId)), `${msg.id}.json`);
    try {
      fs.renameSync(path.join(archiveDir(peerId), `${msg.id}.json`), dest);
    } catch {
      // the sender already moved it to withdrawn/, or another consumer took it
    }
    if (deliveryBlocked(peerId, msg)) withdrawEverywhere(peerId, msg.id);
  }
}

const SIDECAR_POLL_MS = 1_000;
const SIDECAR_BACKOFF_MAX_MS = 30_000;

/**
 * How to wake an App conversation.
 * `ANTIGRAVITY_AGENTAPI_EXE` is the language_server binary and needs the `agentapi` subcommand.
 * The wrapper named `agentapi` (`~/.gemini/antigravity/bin/agentapi` and the CLI's copy) inserts that
 * subcommand itself, so it is run as `agentapi send-message`.
 */
export function agentApiInvocation(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const exe = configuredEnv('ANTIGRAVITY_AGENTAPI_EXE', env);
  const command = exe || 'agentapi';
  const base = path.basename(command).toLowerCase();
  const wrapper = base === 'agentapi' || base === 'agentapi.exe';
  return { command, args: wrapper ? ['send-message'] : ['agentapi', 'send-message'] };
}

/** Idle poll is 1s. A failed exec waits 2s, then doubles, and stops at 30s. Success returns to 1s. */
export function nextSidecarDelayMs(previousMs: number, failed: boolean): number {
  if (!failed) return SIDECAR_POLL_MS;
  const base = Number.isFinite(previousMs) && previousMs > 0 ? previousMs : SIDECAR_POLL_MS;
  return Math.min(SIDECAR_BACKOFF_MAX_MS, Math.max(SIDECAR_POLL_MS * 2, base * 2));
}

/** One hung `agentapi` must not run forever. A message's own deadline can end it sooner. */
export function agentApiTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return envDurationMs('TELEPATHY_AGENTAPI_TIMEOUT_MS', 30_000, env);
}

function killChild(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

function agentApiSend(
  peerId: string,
  conversationId: string,
  prompt: string,
  messages: Message[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const launch = agentApiInvocation(env);
  const deadline = Math.min(Date.now() + agentApiTimeoutMs(env), ...messages.map((msg) => msg.deliverBy ?? Number.POSITIVE_INFINITY));
  return new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.args, conversationId, prompt], {
      env,
      stdio: 'ignore',
      detached: true,
    });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      resolve(ok);
    };
    const blocked = () => messages.some((msg) => deliveryBlocked(peerId, msg)) || Date.now() >= deadline;
    const watch = setInterval(() => {
      if (!blocked()) return;
      killChild(child);
      finish(false);
    }, 50);
    child.on('error', () => {
      killChild(child);
      finish(false);
    });
    child.on('exit', (code) => finish(code === 0 && !messages.some((msg) => deliveryBlocked(peerId, msg))));
  });
}

async function deliverConversation(peer: AppConversation, env: NodeJS.ProcessEnv): Promise<{ sent: number; failed: boolean }> {
  registerListener('antigravity', peer.pid, peer.id);
  const messages = claimInbox(peer.id);
  if (!messages.length) return { sent: 0, failed: false };
  const prompt = messages.map((msg) => formatAsUserTurn(msg)).join('\n\n');
  const ok = await agentApiSend(peer.id, peer.conversationId, prompt, messages, env);
  const blocked = messages.filter((msg) => deliveryBlocked(peer.id, msg));
  for (const msg of blocked) withdrawEverywhere(peer.id, msg.id);
  if (!ok) {
    restoreClaimed(peer.id, messages.filter((msg) => !deliveryBlocked(peer.id, msg)));
    return { sent: 0, failed: true };
  }
  return { sent: messages.length - blocked.length, failed: false };
}

/**
 * One pass over App inboxes. Conversations run together, so one hung `agentapi` does not hold the others.
 * `failed` is true when an exec did not deliver, so the loop can back off.
 */
export async function pollSidecar(env: NodeJS.ProcessEnv = process.env): Promise<{ sent: number; failed: boolean }> {
  const results = await Promise.all(appConversations().map((peer) => deliverConversation(peer, env)));
  return {
    sent: results.reduce((sum, result) => sum + result.sent, 0),
    failed: results.some((result) => result.failed),
  };
}

async function main(): Promise<void> {
  let delay = SIDECAR_POLL_MS;
  for (;;) {
    let failed = false;
    try {
      failed = (await pollSidecar()).failed;
    } catch {
      // a bad peer directory must not kill the sidecar; Antigravity restarts only on exit
      failed = true;
    }
    delay = nextSidecarDelayMs(delay, failed);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  void main();
}
