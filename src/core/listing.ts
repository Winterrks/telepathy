import { agentSpec } from './agents.ts';
import { crossSessionInbound, readClaudeSocket } from './claude-socket.ts';
import { type Peer, peerRef, sameStableName } from './peers.ts';
import { peerStatus, statusText } from './status.ts';

/** `45s ago`, `14m ago`, `10h ago`, `1d ago`: the relative times Claude Code's ListAgents shows. */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/**
 * One other agent's session as a ListAgents row: `<name> [<ref>]  ·  <type>  ·  <status>  ·  started <time ago>`, like
 * Claude Code's own rows. The status is left out when nothing reports it (see status.ts).
 */
export function listAgentsRow(peer: Peer, now = Date.now()): string {
  const columns = [peerRef(peer), 'interactive'];
  const status = statusText(peerStatus(peer), now);
  if (status) columns.push(status);
  const launch = launchHint(peer);
  if (launch) columns.push(launch);
  const started = Date.parse(peer.procStart ?? peer.startedAt ?? '');
  if (!Number.isNaN(started)) columns.push(`started ${formatAgo(now - started)}`);
  return `  ${columns.join('  ·  ')}`;
}

/**
 * How a listed session receives messages. A Claude session with an inbox socket and no hold/refuse gets them
 * as they are posted. The next-turn hint is for a session whose hooks are the path.
 */
/** A window that is up but has no harness session yet. Shown on list_peers and on ListAgents rows. */
function launchHint(peer: Peer): string | undefined {
  if ((peer.agent === 'opencode' || peer.agent === 'kilo') && !peer.sessionId) {
    return 'no session yet, sees messages at its first prompt';
  }
  if (peer.agent === 'codex' && !peer.sessionId) return 'no thread yet';
  return undefined;
}

function deliveryHint(peer: Peer): string | undefined {
  const launch = launchHint(peer);
  if (launch) return launch;
  // `telepathy run` pumps this session. The next-turn line would be wrong: the host wakes it.
  if (peer.agent === 'copilot' && peer.hasListener) return 'the host delivers messages as they arrive';
  if (peer.agent === 'codex' || peer.hasListener) return undefined;
  if (peer.agent === 'claude' && readClaudeSocket(peer.id)) {
    const inbound = crossSessionInbound(peer);
    if (inbound !== 'hold' && inbound !== 'refuse') return 'sees messages through its inbox socket';
  }
  if (agentSpec(peer.agent).nextTurnHook && peer.hookRan) return 'sees messages at its next turn';
  return 'no listener: it reads messages only via read_messages';
}

export function describePeer(peer: Peer): string {
  const notes: string[] = [];
  if (peer.cwd) notes.push(`cwd ${peer.cwd}`);
  const status = statusText(peerStatus(peer));
  if (status) notes.push(status);
  const delivery = deliveryHint(peer);
  if (delivery) notes.push(delivery);
  return [`- ${peerRef(peer)}`, ...notes].join(' · ');
}

export function formatPeerList(self: Peer, peers: Peer[]): string {
  const lines = [`This session is ${peerRef(self)}.`];
  const dupes = peers.filter((p) => sameStableName(self, p));
  if (self.stableName && dupes.length) {
    lines.push(
      `${dupes.length + 1} live sessions share the name ${self.agent}:${self.stableName}. Use the [ref] to pick one.`,
    );
  }
  if (!peers.length) {
    lines.push(
      'No other sessions with telepathy are running. A session of any supported agent appears here once it starts with the plugin installed.',
    );
    return lines.join('\n');
  }
  lines.push(
    `Reachable sessions (${peers.length}):`,
    ...peers.map((p) => {
      const shared = p.duplicate || sameStableName(self, p) || peers.some((other) => sameStableName(p, other));
      return shared ? `${describePeer(p)} · duplicate session` : describePeer(p);
    }),
  );
  lines.push('Send with send_message, using the address (e.g. "codex:name") or the [ref] when names collide.');
  return lines.join('\n');
}
