import { agentSpec } from './agents.ts';
import { codexActivity } from './codex-activity.ts';
import { agentLabel, type Peer, peerRef } from './peers.ts';

/** `45s ago`, `14m ago`, `10h ago`, `1d ago`: the relative times Claude Code's ListAgents shows. */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** A Codex session's busy/idle column, when its rollout log says. */
function codexStatus(peer: Peer): string | undefined {
  const status = peer.codexHome && peer.sessionId ? codexActivity(peer.codexHome, peer.sessionId) : undefined;
  return status === 'interrupted'
    ? 'idle after an interrupted turn: gets messages only after its user sends it a prompt'
    : status;
}

/** Codex needs a thread id before `codex queue` can reach it. */
const codexUnreachable = (peer: Peer) => peer.agent === 'codex' && !peer.sessionId;

/**
 * One other agent's session as a ListAgents row: `<name> [<ref>]  ·  <type>  ·  <status>  ·  started <time ago>`.
 * The status is left out when it can't be read (only Codex's can, from its thread log).
 */
export function listAgentsRow(peer: Peer, now = Date.now()): string {
  const columns = [peerRef(peer), 'interactive'];
  if (codexUnreachable(peer)) {
    columns.push('not reachable yet (no thread: no prompt so far, or its telepathy hook is not approved in /hooks)');
  } else if (peer.agent === 'codex') {
    const status = codexStatus(peer);
    if (status) columns.push(status);
  }
  const started = peer.procStart ? Date.parse(peer.procStart) : Number.NaN;
  if (!Number.isNaN(started)) columns.push(`started ${formatAgo(now - started)}`);
  return `  ${columns.join('  ·  ')}`;
}

export function describePeer(peer: Peer): string {
  const notes: string[] = [agentLabel(peer.agent)];
  if (peer.cwd) notes.push(`cwd ${peer.cwd}`);
  if (codexUnreachable(peer)) {
    notes.push('not reachable yet: its SessionStart hook has not run (approve it with /hooks in that session)');
  } else if (peer.agent === 'codex') {
    const status = codexStatus(peer);
    if (status) notes.push(status);
  } else if (!peer.hasListener) {
    notes.push(
      agentSpec(peer.agent).nextTurnHook && peer.hookRan
        ? 'sees messages at its next turn'
        : 'no listener: it reads messages only via read_messages',
    );
  }
  return `- ${peerRef(peer)} · ${notes.join(' · ')}`;
}

export function formatPeerList(self: Peer, peers: Peer[]): string {
  const lines = [`This session is ${peerRef(self)}.`];
  if (!peers.length) {
    lines.push(
      'No other sessions with telepathy are running. A session of any supported agent appears here once it starts with the plugin installed.',
    );
    return lines.join('\n');
  }
  lines.push(`Reachable sessions (${peers.length}):`, ...peers.map(describePeer));
  lines.push('Send with send_message, using the address (e.g. "codex:name") or the [ref] when names collide.');
  return lines.join('\n');
}
