import { agentLabel, type Peer, peerRef } from './peers.ts';

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
