import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peerDir, peersDir, readJson, writeJsonAtomic } from './paths.ts';
import { type Agent, isSameProcess, procStart } from './proc.ts';

/**
 * The registry is one directory per agent process, `peers/<agent>-<pid>/`, holding one file per writer
 * so no two processes ever write the same file:
 *   session.json   SessionStart hook: session/thread id and cwd (documented hook input)
 *   presence.json  MCP server: proves the plugin is loaded in that session
 *   listener.json  Claude monitor: proves inbound messages will reach the model
 */
export interface SessionRecord {
  agent: Agent;
  pid: number;
  procStart?: string;
  sessionId?: string;
  cwd?: string;
  /** Where the id came from: the SessionStart hook, or the `_meta` of a Codex tool call. */
  source: 'hook' | 'meta';
  codexHome?: string;
  updatedAt: string;
}

export interface PresenceRecord {
  agent: Agent;
  pid: number;
  procStart?: string;
  serverPid: number;
  cwd?: string;
  codexHome?: string;
  startedAt: string;
}

export interface ListenerRecord {
  pid: number;
  procStart?: string;
  startedAt: string;
}

export interface Peer {
  /** Stable, unique reference: `<agent>-<pid>`. */
  id: string;
  agent: Agent;
  pid: number;
  procStart?: string;
  sessionId?: string;
  cwd?: string;
  codexHome?: string;
  /** Human-readable name (Claude session name, Codex thread name, or the cwd's folder name). */
  name: string;
  /** What agents type to reach it: `<agent>:<name-slug>`. */
  address: string;
  hasListener: boolean;
  hasServer: boolean;
  /**
   * Other names that also reach this peer. The cwd's folder name stays valid after a Codex thread gets its
   * title (or a Claude session is renamed), so an address another agent already has keeps working.
   */
  aliases?: string[];
}

export const peerId = (agent: Agent, pid: number) => `${agent}-${pid}`;
const PEER_DIR_RE = /^(claude|codex)-(\d+)$/;

export const defaultCodexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export function registerSession(
  agent: Agent,
  pid: number,
  fields: { sessionId?: string; cwd?: string; source: SessionRecord['source']; codexHome?: string },
): SessionRecord {
  const record: SessionRecord = {
    agent,
    pid,
    procStart: procStart(pid),
    ...fields,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(peerDir(peerId(agent, pid)), 'session.json'), record);
  return record;
}

export function registerPresence(agent: Agent, pid: number, fields: { cwd?: string; codexHome?: string } = {}): void {
  const record: PresenceRecord = {
    agent,
    pid,
    procStart: procStart(pid),
    serverPid: process.pid,
    ...fields,
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(peerDir(peerId(agent, pid)), 'presence.json'), record);
}

export function registerListener(agent: Agent, pid: number): void {
  const record: ListenerRecord = { pid: process.pid, procStart: procStart(process.pid), startedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(peerDir(peerId(agent, pid)), 'listener.json'), record);
}

export function readSession(id: string): SessionRecord | undefined {
  return readJson<SessionRecord>(path.join(peerDir(id), 'session.json'));
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1') // drop accents from Latin letters only (é → e, but keep ド)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
    .replace(/[-.]+$/g, '');
}

/** Best effort: Claude Code's own session name, so peers see the same name as `/list-agents`. */
function claudeSessionName(pid: number): string | undefined {
  const record = readJson<{ name?: unknown }>(path.join(claudeConfigDir(), 'sessions', `${pid}.json`));
  return typeof record?.name === 'string' && record.name ? record.name : undefined;
}

/** Best effort: the Codex thread's title from its session index. */
function codexThreadName(codexHome: string, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return undefined;
  }
  let name: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes(sessionId)) continue;
    try {
      const entry = JSON.parse(line) as { id?: string; thread_name?: string };
      if (entry.id === sessionId && entry.thread_name) name = entry.thread_name;
    } catch {
      // skip malformed lines
    }
  }
  return name;
}

function displayName(agent: Agent, pid: number, cwd: string | undefined, sessionId: string | undefined, codexHome: string) {
  const fromAgent = agent === 'claude' ? claudeSessionName(pid) : codexThreadName(codexHome, sessionId);
  return fromAgent || (cwd ? path.basename(cwd) : '') || `session-${pid}`;
}

/** Builds the view of one registered agent process, or undefined when nothing is registered for it. */
export function readPeer(id: string): Peer | undefined {
  const m = PEER_DIR_RE.exec(id);
  if (!m) return undefined;
  const agent = m[1] as Agent;
  const pid = Number(m[2]);
  const dir = peerDir(id);
  const session = readJson<SessionRecord>(path.join(dir, 'session.json'));
  const presence = readJson<PresenceRecord>(path.join(dir, 'presence.json'));
  const listener = readJson<ListenerRecord>(path.join(dir, 'listener.json'));
  if (!session && !presence) return undefined;
  const cwd = session?.cwd || presence?.cwd;
  const codexHome = session?.codexHome || presence?.codexHome || defaultCodexHome();
  const name = displayName(agent, pid, cwd, session?.sessionId, codexHome);
  const folderSlug = cwd ? slugify(path.basename(cwd)) : '';
  return {
    id,
    agent,
    pid,
    procStart: session?.procStart || presence?.procStart,
    sessionId: session?.sessionId,
    cwd,
    codexHome,
    name,
    address: `${agent}:${slugify(name) || id}`,
    hasListener: !!listener && isSameProcess(listener.pid, listener.procStart),
    hasServer: !!presence && isSameProcess(presence.serverPid, undefined),
    aliases: folderSlug && folderSlug !== slugify(name) ? [folderSlug] : [],
  };
}

/** Live peers, with registrations of exited sessions removed along the way. */
export function listPeers(): Peer[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(peersDir());
  } catch {
    return [];
  }
  const peers: Peer[] = [];
  for (const name of names.sort()) {
    const m = PEER_DIR_RE.exec(name);
    if (!m) continue;
    const peer = readPeer(name);
    if (!isSameProcess(Number(m[2]), peer?.procStart)) {
      // The session is gone (or its pid was reused); nothing can be delivered to it anymore.
      fs.rmSync(peerDir(name), { recursive: true, force: true });
      continue;
    }
    // A live process whose hook/server hasn't registered yet isn't reachable, but its files stay.
    if (peer) peers.push(peer);
  }
  return peers;
}

/** This process's own identity, even before (or without) any registration file. */
export function selfPeer(agent: Agent, pid: number): Peer {
  const id = peerId(agent, pid);
  return (
    readPeer(id) ?? {
      id,
      agent,
      pid,
      name: `session-${pid}`,
      address: `${agent}:session-${pid}`,
      hasListener: false,
      hasServer: false,
    }
  );
}

export const agentLabel = (agent: Agent) => (agent === 'claude' ? 'Claude Code' : 'Codex');

/** `codex:fix-auth [codex-4242]` — the same `name [ref]` shape Claude Code's ListAgents uses. */
export const peerRef = (peer: Pick<Peer, 'address' | 'id'>) => `${peer.address} [${peer.id}]`;

export type Resolution = { peer: Peer } | { error: string };

/**
 * Resolves what an agent typed as a recipient: a ref (`codex-4242`), an address (`codex:fix-auth`),
 * the `address [ref]` form from a listing, a bare name, or an unambiguous prefix of one.
 */
export function resolvePeer(to: string, peers: Peer[]): Resolution {
  let query = to.trim().replace(/^["'`]|["'`]$/g, '').trim();
  const bracketed = /\[([^\]]+)\]\s*$/.exec(query);
  if (bracketed) query = bracketed[1].trim();
  const q = query.toLowerCase();
  if (!q) return { error: 'Recipient is empty.' };

  const pick = (matches: Peer[], how: string): Resolution | undefined => {
    if (matches.length === 1) return { peer: matches[0] };
    if (matches.length > 1) {
      return {
        error: `"${to}" ${how} ${matches.length} sessions: ${matches.map(peerRef).join(', ')}. Use the [ref] to pick one.`,
      };
    }
    return undefined;
  };

  const slugsOf = (p: Peer) => [p.address.slice(p.agent.length + 1), ...(p.aliases ?? [])];
  const qSlug = slugify(q.replace(/^(claude|codex):/, ''));
  const qAgent = /^(claude|codex)[:-]/.exec(q)?.[1];
  const sameAgent = (p: Peer) => !qAgent || p.agent === qAgent;

  return (
    pick(peers.filter((p) => p.id === q), 'matches') ??
    pick(peers.filter((p) => p.address.toLowerCase() === q), 'matches') ??
    pick(peers.filter((p) => sameAgent(p) && (slugsOf(p).includes(qSlug) || p.name.toLowerCase() === q)), 'matches') ??
    pick(peers.filter((p) => sameAgent(p) && qSlug !== '' && slugsOf(p).some((s) => s.startsWith(qSlug))), 'is a prefix of') ?? {
      error:
        `No reachable session matches "${to}". ` +
        (peers.length ? `Reachable: ${peers.map(peerRef).join(', ')}.` : 'No other sessions with telepathy are running.'),
    }
  );
}
