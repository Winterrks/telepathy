import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claimInbox, formatAsUserTurn, type Message } from './core/messages.ts';
import { archiveDir, ensureDir, inboxDir, peersDir, readJson } from './core/paths.ts';
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

function agentApiBin(env: NodeJS.ProcessEnv): string {
  const exe = env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
  if (exe && !/^\$\{[^}]+\}$/.test(exe)) return exe;
  return 'agentapi';
}

function agentApiSend(conversationId: string, prompt: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(agentApiBin(env), ['send-message', conversationId, prompt], { env, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** One pass over App inboxes. Returns how many messages were handed to `agentapi`. */
export async function pollSidecar(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let sent = 0;
  for (const peer of appConversations()) {
    registerListener('antigravity', peer.pid, peer.id);
    const messages = claimInbox(peer.id);
    if (!messages.length) continue;
    const prompt = messages.map((msg) => formatAsUserTurn(msg)).join('\n\n');
    const ok = await agentApiSend(peer.conversationId, prompt, env);
    if (!ok) restoreClaimed(peer.id, messages);
    else sent += messages.length;
  }
  return sent;
}

async function main(): Promise<void> {
  for (;;) {
    try {
      await pollSidecar();
    } catch {
      // a bad peer directory must not kill the sidecar; Antigravity restarts only on exit
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  void main();
}
