import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claimInbox, formatAsUserTurn, type Message } from './core/messages.ts';
import { archiveDir, configuredEnv, ensureDir, inboxDir, peersDir, readJson } from './core/paths.ts';
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

function restoreClaimed(peerId: string, messages: Message[]): void {
  for (const msg of messages) {
    const file = `${msg.id}.json`;
    try {
      fs.renameSync(path.join(archiveDir(peerId), file), path.join(ensureDir(inboxDir(peerId)), file));
    } catch {
      // already gone
    }
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

function agentApiSend(conversationId: string, prompt: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const launch = agentApiInvocation(env);
  return new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.args, conversationId, prompt], { env, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** One pass over App inboxes. `failed` is true when an exec did not deliver, so the loop can back off. */
export async function pollSidecar(env: NodeJS.ProcessEnv = process.env): Promise<{ sent: number; failed: boolean }> {
  let sent = 0;
  let failed = false;
  for (const peer of appConversations()) {
    registerListener('antigravity', peer.pid, peer.id);
    const messages = claimInbox(peer.id);
    if (!messages.length) continue;
    const prompt = messages.map((msg) => formatAsUserTurn(msg)).join('\n\n');
    const ok = await agentApiSend(peer.conversationId, prompt, env);
    if (!ok) {
      restoreClaimed(peer.id, messages);
      failed = true;
    } else sent += messages.length;
  }
  return { sent, failed };
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
