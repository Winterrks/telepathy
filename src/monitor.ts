import fs from 'node:fs';
import path from 'node:path';
import { debugLog } from './core/debug.ts';
import { claimInbox, formatMonitorLine } from './core/messages.ts';
import { ensureDir, inboxDir, peerDir } from './core/paths.ts';
import { peerId, registerListener } from './core/peers.ts';
import { findAgent, isAlive, parseAgent } from './core/proc.ts';

/**
 * Claude Code plugin monitor. Claude Code runs it for the whole session and turns every stdout line into a
 * notification for Claude, starting a turn when the session is idle. It watches this session's inbox and
 * prints one line per arriving message.
 */
const argv = process.argv.slice(2);
const { agent, pid: agentPid } = findAgent(parseAgent(argv[argv.indexOf('--agent') + 1]));
const id = peerId(agent, agentPid);
const listenerFile = path.join(peerDir(id), 'listener.json');

let draining = false;
function drain(): void {
  if (draining) return;
  draining = true;
  try {
    for (const msg of claimInbox(id)) {
      process.stdout.write(formatMonitorLine(msg) + '\n');
      debugLog('monitor', `delivered ${msg.id} from ${msg.from.id}`);
    }
  } finally {
    draining = false;
  }
}

let watcher: fs.FSWatcher | undefined;
function ensureWatching(): void {
  ensureDir(inboxDir(id));
  if (!fs.existsSync(listenerFile)) registerListener(agent, agentPid);
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
    fs.rmSync(listenerFile, { force: true });
  } catch {
    // best effort
  }
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, stop);

registerListener(agent, agentPid);
ensureWatching();
debugLog('monitor', `listening for ${id}`);
drain();

// fs.watch can miss events (or the directory can be recreated), so also poll; and exit with the session.
setInterval(() => {
  if (!isAlive(agentPid)) stop();
  ensureWatching();
  drain();
}, 2000);
