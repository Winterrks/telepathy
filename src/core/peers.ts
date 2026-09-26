import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_ALTERNATION, type Agent, agentLabel } from './agents.ts';
import { ensureDir, inboxDir, peerDir, peersDir, readJson, writeJsonAtomic } from './paths.ts';
import { VERSION } from './version.ts';
import { isSameProcess, procStart } from './proc.ts';

export { agentLabel };

/**
 * The registry is one directory per agent process, `peers/<agent>-<pid>/`, holding one file per writer
 * so no two processes ever write the same file:
 *   session.json   SessionStart hook (or in-process plugin): session/thread id and cwd
 *   presence.json  MCP server (or in-process plugin): proves telepathy is loaded in that session
 *   listener.json  whatever wakes the session when a message arrives (Claude's monitor, an in-process
 *                  plugin): proves inbound messages reach the model without it asking
 */
export interface SessionRecord {
  agent: Agent;
  pid: number;
  procStart?: string;
  sessionId?: string;
  cwd?: string;
  /** Where the id came from: a SessionStart hook, the `_meta` of a Codex tool call, or an in-process plugin. */
  source: 'hook' | 'meta' | 'plugin';
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
  /** The telepathy version the server runs, so a session on an older one can be told to restart. */
  version?: string;
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
  /** Its name: Claude Code's own for a Claude session, `<folder>-<suffix>` for the others (`norma-v2-c3f`). */
  name: string;
  /** What agents type to reach it: `<agent>:<name-slug>`. */
  address: string;
  hasListener: boolean;
  hasServer: boolean;
  /** The telepathy version its server runs, when it says. */
  version?: string;
  /** Its session was registered by a hook, so the agent runs telepathy's hooks. */
  hookRan?: boolean;
  /** Its after-tool-call hook has run, so it gets messages mid-turn (Codex, where that hook needs its own approval). */
  toolHookRan?: boolean;
  /**
   * Other names that also reach this peer: the bare folder name, and for Codex its thread's title, so an address
   * written without the suffix, or one an older version handed out, keeps working.
   */
  aliases?: string[];
}

export const peerId = (agent: Agent, pid: number) => `${agent}-${pid}`;

export function markToolHook(id: string): void {
  const file = path.join(peerDir(id), 'tool-hook.json');
  if (!fs.existsSync(file)) writeJsonAtomic(file, { at: new Date().toISOString() });
}
/**
 * A peer's id and directory name: `<agent>-<key>`. Every agent is keyed by the pid of its process today;
 * the key may become a session id for agents that host many sessions in one process.
 */
const PEER_DIR_RE = new RegExp(`^(${AGENT_ALTERNATION})-([A-Za-z0-9][A-Za-z0-9_-]*)$`);
/** `codex:` at the start of an address. */
const AGENT_PREFIX_RE = new RegExp(`^(${AGENT_ALTERNATION}):`);
/** A pid ref like `codex-4242`. */
const REF_RE = new RegExp(`^(${AGENT_ALTERNATION})-\\d+$`);

export const defaultCodexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

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
  if (fields.sessionId) adoptHeldMessages(agent, pid, fields.sessionId);
  return record;
}

/** How long unread messages of a session that exited wait for the session to be resumed. */
const HOLD_MS = 60 * 60_000;

/** Whether an exited session's inbox still holds a message younger than HOLD_MS. */
function holdsUnread(id: string, now = Date.now()): boolean {
  try {
    return fs.readdirSync(inboxDir(id)).some((f) => now - fs.statSync(path.join(inboxDir(id), f)).mtimeMs < HOLD_MS);
  } catch {
    return false;
  }
}

/**
 * A resumed session (`claude --resume`, `codex resume`) runs in a new process, so it gets a new `<agent>-<pid>`
 * id. Unread messages left in the inbox of an exited process that ran the same session move to the new one.
 */
function adoptHeldMessages(agent: Agent, pid: number, sessionId: string): void {
  const selfId = peerId(agent, pid);
  let names: string[];
  try {
    names = fs.readdirSync(peersDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (name === selfId || !name.startsWith(`${agent}-`)) continue;
    const old = readJson<SessionRecord>(path.join(peerDir(name), 'session.json'));
    if (old?.agent !== agent || old.sessionId !== sessionId || isSameProcess(old.pid, old.procStart)) continue;
    let files: string[] = [];
    try {
      files = fs.readdirSync(inboxDir(name));
    } catch {
      // no inbox
    }
    for (const file of files) {
      try {
        fs.renameSync(path.join(inboxDir(name), file), path.join(ensureDir(inboxDir(selfId)), file));
      } catch {
        // taken by another consumer
      }
    }
    fs.rmSync(peerDir(name), { recursive: true, force: true });
  }
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
  writeJsonAtomic(path.join(peerDir(peerId(agent, pid)), 'presence.json'), { ...record, version: VERSION });
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

/**
 * What tells apart sessions working in the same folder: the agent's first letter and two hex characters (`c3f` for a
 * Codex session). Claude Code ends its own session names with two hex characters (`norma-v2-b0`), so the two never
 * collide. From the process, so a session keeps its name for as long as it runs.
 */
export const nameSuffix = (agent: Agent, pid: number) => agent[0] + createHash('sha1').update(String(pid)).digest('hex').slice(0, 2);

/**
 * A Claude Code session goes by Claude Code's own name for it, so peers see the same name as `/list-agents`. Every
 * other session is named much like Claude Code names its own: `<folder>-<suffix>`, which says where it works.
 */
function displayName(agent: Agent, pid: number, cwd: string | undefined) {
  const folder = cwd ? slugify(path.basename(cwd)) : '';
  // A Claude session without a name of Claude Code's (before v2.1.224) goes by its folder alone.
  if (agent === 'claude') return claudeSessionName(pid) || folder || `session-${pid}`;
  return folder ? `${folder}-${nameSuffix(agent, pid)}` : `session-${pid}`;
}

/** Builds the view of one registered agent process, or undefined when nothing is registered for it. */
export function readPeer(id: string): Peer | undefined {
  const m = PEER_DIR_RE.exec(id);
  if (!m) return undefined;
  const agent = m[1] as Agent;
  const dir = peerDir(id);
  const session = readJson<SessionRecord>(path.join(dir, 'session.json'));
  const presence = readJson<PresenceRecord>(path.join(dir, 'presence.json'));
  const listener = readJson<ListenerRecord>(path.join(dir, 'listener.json'));
  if (!session && !presence) return undefined;
  const pid = session?.pid ?? presence?.pid ?? Number(m[2]);
  const cwd = session?.cwd || presence?.cwd;
  const codexHome = session?.codexHome || presence?.codexHome || defaultCodexHome();
  const name = displayName(agent, pid, cwd);
  // Other names that also reach it: the bare folder name, and a Codex thread's title (what older versions called it).
  const aliases = [cwd ? slugify(path.basename(cwd)) : '', agent === 'codex' ? slugify(codexThreadName(codexHome, session?.sessionId) ?? '') : ''];
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
    version: presence?.version,
    hookRan: session?.source === 'hook',
    toolHookRan: fs.existsSync(path.join(dir, 'tool-hook.json')),
    aliases: [...new Set(aliases)].filter((a) => a && a !== slugify(name)),
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
    const pid = peer?.pid ?? (/^\d+$/.test(m[2]) ? Number(m[2]) : undefined);
    if (pid === undefined) continue; // not registered yet
    if (!isSameProcess(pid, peer?.procStart)) {
      // The session is gone (or its pid was reused). Unread messages wait an hour for it to be resumed.
      if (!holdsUnread(name)) fs.rmSync(peerDir(name), { recursive: true, force: true });
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
  const qSlug = slugify(q.replace(AGENT_PREFIX_RE, ''));
  // Only an explicit `agent:` prefix or a ref narrows by agent: a bare "pi-server" may name any session.
  const qAgent = AGENT_PREFIX_RE.exec(q)?.[1] ?? (REF_RE.test(q) ? q.slice(0, q.lastIndexOf('-')) : undefined);
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
