import fs from 'node:fs';
import path from 'node:path';
import { claudeSocketArmed } from './core/claude-socket.ts';
import { debugLog } from './core/debug.ts';
import { claimInbox, formatMonitorLine } from './core/messages.ts';
import { ensureDir, inboxDir, peerDir, readJson } from './core/paths.ts';
import { isDeliveryOwner, linkedPeerId, peerId, registerListener } from './core/peers.ts';
import { findAgent, isAlive, parseAgent } from './core/proc.ts';

/**
 * Claude Code plugin monitor. Claude Code runs it for the whole session and turns every stdout line into a
 * notification for Claude, starting a turn when the session is idle. It watches this session's inbox and
 * prints one line per arriving message. Grok's model starts the same command with its own monitor tool.
 *
 * With `--once` it is a one-shot waiter instead: it exits after printing the first message(s). Sessions where
 * plugin monitors don't run (the Claude app's Code tab) start it as a background command, whose completion wakes
 * the session, and start it again after handling the message.
 */
const argv = process.argv.slice(2);
const once = argv.includes('--once');
// The plugin manifest always starts this process. A session that exported an inbox socket does not need it,
// and a process that stays up is what makes `/exit` ask to stop background tasks. `--once` is the app waiter;
// it is not the long-running monitor Claude counts.
if (!once && process.env.CLAUDE_CODE_MESSAGING_SOCKET) {
  debugLog('monitor', 'CLAUDE_CODE_MESSAGING_SOCKET is set; exiting without registering a listener');
  process.exit(0);
}
const { agent, pid: agentPid } = findAgent(parseAgent(argv[argv.indexOf('--agent') + 1]));
let id = linkedPeerId(agent, agentPid) ?? peerId(agent, agentPid);
const listenerFile = () => path.join(peerDir(id), 'listener.json');

let draining = false;
function drain(): void {
  if (draining) return;
  // A second process on this session must not also print the inbox.
  if (!isDeliveryOwner(id, agentPid)) return;
  // The socket watcher is the delivery path while it is running. Claiming here would print a second copy.
  if (claudeSocketArmed(id)) return;
  draining = true;
  try {
    const messages = claimInbox(id);
    for (const msg of messages) debugLog('monitor', `delivered ${msg.id} from ${msg.from.id}`);
    if (!messages.length) return;
    const text = messages.map((msg) => formatMonitorLine(msg) + '\n').join('');
    // Pipes are asynchronous on macOS: exit only once the text is out.
    if (once) process.stdout.write(text, () => stop());
    else process.stdout.write(text);
  } finally {
    draining = false;
  }
}

let watcher: fs.FSWatcher | undefined;
function ensureWatching(): void {
  const linked = linkedPeerId(agent, agentPid) ?? peerId(agent, agentPid);
  if (linked !== id) {
    watcher?.close();
    watcher = undefined;
    id = linked;
  }
  if (!isDeliveryOwner(id, agentPid)) return;
  ensureDir(inboxDir(id));
  if (!fs.existsSync(listenerFile())) registerListener(agent, agentPid, id);
  if (watcher) return;
  try {
    watcher = fs.watch(inboxDir(id), () => drain());
    watcher.on('error', () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    watcher = undefined; // the interval below still polls
  }
}

function stop(): void {
  try {
    // Only this process's own registration: another listener may have taken over meanwhile.
    if (readJson<{ pid?: number }>(listenerFile())?.pid === process.pid) fs.rmSync(listenerFile(), { force: true });
  } catch {
    // best effort
  }
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, stop);

if (isDeliveryOwner(id, agentPid)) registerListener(agent, agentPid, id);
ensureWatching();
debugLog('monitor', `listening for ${id}`);
drain();

// fs.watch can miss events (or the directory can be recreated), so also poll; and exit with the session.
setInterval(() => {
  if (!isAlive(agentPid)) stop();
  ensureWatching();
  drain();
}, 2000);
