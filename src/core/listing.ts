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

/**
 * One Codex session as a ListAgents row: `<name> [<ref>]  ·  <type>  ·  <status>  ·  started <time ago>`.
 * The status is left out when it can't be read.
 */
export function listAgentsRow(peer: Peer, now = Date.now()): string {
  const columns = [peerRef(peer), 'interactive'];
  if (!peer.sessionId) columns.push('not reachable yet (no thread: no prompt so far, or its telepathy hook is not approved in /hooks)');
  else {
    const status = peer.codexHome ? codexActivity(peer.codexHome, peer.sessionId) : undefined;
    if (status) columns.push(status);
  }
  const started = peer.procStart ? Date.parse(peer.procStart) : Number.NaN;
  if (!Number.isNaN(started)) columns.push(`started ${formatAgo(now - started)}`);
  return `  ${columns.join('  ·  ')}`;
}

export function describePeer(peer: Peer): string {
  const notes: string[] = [agentLabel(peer.agent)];
  if (peer.cwd) notes.push(`cwd ${peer.cwd}`);
  if (peer.agent === 'codex' && !peer.sessionId) {
    notes.push('not reachable yet: its SessionStart hook has not run (approve it with /hooks in that session)');
  }
  if (peer.agent === 'claude' && !peer.hasListener) notes.push('no listener: it reads messages only via read_messages');
  return `- ${peerRef(peer)} · ${notes.join(' · ')}`;
}

export function formatPeerList(self: Peer, peers: Peer[]): string {
  const lines = [`This session is ${peerRef(self)}.`];
  if (!peers.length) {
    lines.push(
      'No other sessions with telepathy are running. A Claude Code or Codex session appears here once it starts with the plugin installed.',
    );
    return lines.join('\n');
  }
  lines.push(`Reachable sessions (${peers.length}):`, ...peers.map(describePeer));
  lines.push('Send with send_message, using the address (e.g. "codex:name") or the [ref] when names collide.');
  return lines.join('\n');
}
