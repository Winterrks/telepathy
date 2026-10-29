import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_ALTERNATION, type Agent, agentLabel } from './agents.ts';
import { configuredEnv, ensureDir, inboxDir, peerDir, peersDir, readJson, stateDir, writeJsonAtomic } from './paths.ts';
import { VERSION } from './version.ts';
import { type CodexTuiProc, codexTuiLaunch, codexTuiProcesses, isCodexExecCommand, processCwd } from './codex-launch.ts';
import { codexThreadLoaded } from './codex-threads.ts';
import { commandLine, isSameProcess, procStart } from './proc.ts';

export { agentLabel };

/**
 * The registry is one directory per session, `peers/<agent>-<key>/`, holding one file per writer
 * so no two processes ever write the same file. The key is the harness's own session id when the hook,
 * the tool call, or an environment variable reports one (so `claude --resume` keeps the id). A process that
 * has not reported a session id yet is still keyed by its pid:
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
  /** Where the id came from: a SessionStart hook, the `_meta` of a Codex tool call, an in-process plugin, or a Codex TUI seen in the process table before it has a thread. */
  source: 'hook' | 'meta' | 'plugin' | 'process';
  codexHome?: string;
  /** When this session was first registered: a Codex thread has no process of its own to tell. */
  startedAt?: string;
  /** Antigravity surface, from the transcript path (`app`, `cli`, or `ide`). */
  surface?: 'app' | 'cli' | 'ide';
  /** `transcript.jsonl` for this Antigravity conversation, when a hook reported it. */
  transcriptPath?: string;
  updatedAt: string;
  /**
   * When this process was first seen to be gone. Inbox files newer than this were written after the session
   * stopped and are not delivered on resume. Unset while a process is running.
   */
  exitedAt?: string;
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
  /** Stable, unique reference: `<agent>-<pid>`, or `codex-<thread id>`. */
  id: string;
  agent: Agent;
  /** The agent process: for Codex, the one hosting the thread when it last registered. */
  pid: number;
  procStart?: string;
  /** When a Codex thread was first registered (it has no process of its own whose start would say). */
  startedAt?: string;
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
  /**
   * A name the user set (`TELEPATHY_NAME` or `--name`). It replaces the generated name, so the address is
   * whatever the user chose. Unset when the session is still named from its folder or from Claude's own name.
   */
  stableName?: string;
  /** Another live process claimed this same harness session. The first claimant owns delivery. */
  duplicate?: boolean;
}

export const peerId = (agent: Agent, key: number | string) => `${agent}-${key}`;

/**
 * Codex runs many threads in one process, and OpenCode's service hosts every session. Every harness that reports
 * a durable session id is keyed by that id, not by the pid, so a resume (`claude --resume`, `codex resume`, an
 * OpenCode session that continues) is the same peer and keeps its name. A process that has not reported an id
 * yet is still keyed by its pid. A send to a session whose process is gone fails and writes nothing.
 */
export const sessionKey = (_agent: Agent, pid: number, sessionId: string | undefined): number | string =>
  sessionToken(sessionId) ?? pid;

/**
 * Filesystem-safe form of a harness session id. UUIDs, Codex thread ids, and OpenCode `ses_` ids pass through.
 * Undefined when the value is empty or too long to be a directory name.
 */
export function sessionToken(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  if (!trimmed || trimmed.length > 180) return undefined;
  const safe = trimmed.replace(/[^A-Za-z0-9_-]/g, '_');
  return /^[A-Za-z0-9]/.test(safe) ? safe : undefined;
}

/** The id of the session an agent process is running: `<agent>-<session id>` once that id is known, else `<agent>-<pid>`. */
export const sessionPeerId = (agent: Agent, pid: number, sessionId: string | undefined) =>
  peerId(agent, sessionKey(agent, pid, sessionId));

interface OwnerRecord {
  pid: number;
  procStart?: string;
  at: string;
}

interface RememberedName {
  name: string;
}

const ownersFile = (id: string) => path.join(peerDir(id), 'owners.json');
const linkFile = (agent: Agent, pid: number) => path.join(peerDir(peerId(agent, pid)), 'link.json');
const rememberedFile = (agent: Agent, sessionId: string) =>
  path.join(stateDir(), 'identities', agent, `${sessionToken(sessionId)}.json`);

/** Live processes that have claimed this session, oldest claimant first. The first one owns delivery. */
export function sessionOwners(id: string): OwnerRecord[] {
  const owners = readJson<OwnerRecord[]>(ownersFile(id)) ?? [];
  return owners.filter((owner) => isSameProcess(owner.pid, owner.procStart));
}

/** Records `pid` as a claimant. Returns whether this process is the one that owns delivery. */
export function claimSessionOwner(id: string, pid: number): boolean {
  const owners = sessionOwners(id);
  if (!owners.some((owner) => owner.pid === pid)) {
    owners.push({ pid, procStart: procStart(pid), at: new Date().toISOString() });
    owners.sort((a, b) => a.at.localeCompare(b.at));
    writeJsonAtomic(ownersFile(id), owners);
  }
  return owners[0]?.pid === pid;
}

/** True when this process should deliver inbound messages. A second process on the same session does not. */
export function isDeliveryOwner(id: string, pid: number): boolean {
  const owners = sessionOwners(id);
  return owners.length === 0 || owners[0]?.pid === pid;
}

/** The canonical peer id this process was linked to once its session id was known. */
export function linkedPeerId(agent: Agent, pid: number): string | undefined {
  const link = readJson<{ id?: unknown }>(linkFile(agent, pid));
  return typeof link?.id === 'string' ? link.id : undefined;
}

/**
 * Remembers `name` the first time this harness session is seen. A later call keeps the stored name, so an
 * OpenCode process can carry the name it showed while it was still keyed by pid.
 */
export function keepSessionName(agent: Agent, sessionId: string, name: string): string {
  return rememberName(agent, sessionId, name);
}

function rememberName(agent: Agent, sessionId: string, generated: string): string {
  const token = sessionToken(sessionId);
  if (!token) return generated;
  const file = rememberedFile(agent, sessionId);
  const existing = readJson<RememberedName>(file);
  if (existing?.name) return existing.name;
  writeJsonAtomic(file, { name: generated } satisfies RememberedName);
  return generated;
}

function rememberedName(agent: Agent, sessionId: string | undefined): string | undefined {
  if (!sessionId || !sessionToken(sessionId)) return undefined;
  return readJson<RememberedName>(rememberedFile(agent, sessionId))?.name;
}

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
/** A ref like `claude-4242`, a Codex thread's `codex-01a1176e-84cc-76c3-b84c-8e4da4d38c36`, or `opencode-ses_edfc…`. */
const REF_RE = new RegExp(`^(${AGENT_ALTERNATION})-(\\d+|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|ses_[A-Za-z0-9]+)$`);

export const defaultCodexHome = () => configuredEnv('CODEX_HOME') || path.join(os.homedir(), '.codex');
export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export function registerSession(
  agent: Agent,
  pid: number,
  fields: {
    sessionId?: string;
    cwd?: string;
    source: SessionRecord['source'];
    codexHome?: string;
    surface?: SessionRecord['surface'];
    transcriptPath?: string;
  },
  id = sessionPeerId(agent, pid, fields.sessionId),
): SessionRecord {
  const file = path.join(peerDir(id), 'session.json');
  const previous = readJson<SessionRecord>(file);
  const now = new Date().toISOString();
  const owner = fields.sessionId ? claimSessionOwner(id, pid) : true;
  const primary = fields.sessionId ? sessionOwners(id)[0] : undefined;
  const record: SessionRecord = {
    agent,
    pid: primary?.pid ?? pid,
    procStart: primary?.procStart ?? procStart(pid),
    ...fields,
    startedAt: (previous?.sessionId === fields.sessionId && previous?.startedAt) || now,
    updatedAt: now,
    surface: fields.surface ?? previous?.surface,
    transcriptPath: fields.transcriptPath ?? previous?.transcriptPath,
  };
  // A resume is a live process again. Mail written after the previous process exited is not in flight.
  if (previous?.exitedAt) dropInboxAfter(id, previous.exitedAt);
  writeJsonAtomic(file, record);
  if (fields.sessionId && sessionToken(fields.sessionId)) {
    const key = sessionToken(fields.sessionId) as string;
    const carried = agent === 'codex' ? carryLaunchedCodexName(fields.sessionId) : undefined;
    rememberName(agent, fields.sessionId, carried ?? displayName(agent, pid, key, fields.cwd ?? previous?.cwd));
    if (peerId(agent, pid) !== id) {
      writeJsonAtomic(linkFile(agent, pid), { id });
      if (owner) moveInbox(peerId(agent, pid), id);
    }
    adoptHeldMessages(agent, id, fields.sessionId);
  }
  return record;
}

/**
 * Records that this session's process is gone, once. A later resume uses the time to drop mail that was written
 * after the process exited. Mail written before it stays: that copy was already in flight.
 */
export function notePeerExit(id: string, at = new Date().toISOString()): void {
  const session = readSession(id);
  if (!session || session.exitedAt) return;
  writeJsonAtomic(path.join(peerDir(id), 'session.json'), { ...session, exitedAt: at });
}

/** Removes inbox files sent after `exitedAt`. Files with no `sentAt` stay. */
function dropInboxAfter(id: string, exitedAt: string): void {
  const cutoff = Date.parse(exitedAt);
  if (Number.isNaN(cutoff)) return;
  let files: string[] = [];
  try {
    files = fs.readdirSync(inboxDir(id));
  } catch {
    return;
  }
  for (const file of files) {
    const msg = readJson<{ sentAt?: string }>(path.join(inboxDir(id), file));
    const sent = Date.parse(msg?.sentAt ?? '');
    if (Number.isNaN(sent) || sent <= cutoff) continue;
    try {
      fs.rmSync(path.join(inboxDir(id), file), { force: true });
    } catch {
      // claimed by the resuming process
    }
  }
}

function moveInbox(fromId: string, toId: string): void {
  if (fromId === toId) return;
  let files: string[] = [];
  try {
    files = fs.readdirSync(inboxDir(fromId));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      fs.renameSync(path.join(inboxDir(fromId), file), path.join(ensureDir(inboxDir(toId)), file));
    } catch {
      // taken by another consumer
    }
  }
}

/** How long a pid-only directory with unread mail outlives the process. Session-keyed directories use `SESSION_KEEP_MS`. */
const HOLD_MS = 60 * 60_000;

/**
 * How long a session-keyed directory outlives the process. A resume reclaims the same id and name. Mail that was
 * already in the inbox is still there, except a send that failed, which moves its copy to `withdrawn/`. A send
 * while the process is gone writes nothing: this window is not a mailbox.
 * Codex reloads a thread into a new daemon without a hook until the next prompt, and a restarted OpenCode service
 * takes its sessions back, so the directory has to still be here when that process starts.
 */
const SESSION_KEEP_MS = 24 * 60 * 60_000;

/**
 * An OpenCode service keeps every session it ever ran, with or without a window showing it, so one counts as running
 * only while it has been used this recently.
 */
const SERVICE_SESSION_ACTIVE_MS = 12 * 60 * 60_000;

/** When a session last registered or reported a status. */
function lastActivity(id: string): number {
  const times = [readSession(id)?.updatedAt, readJson<{ at?: string }>(path.join(peerDir(id), 'status.json'))?.at];
  return Math.max(...times.map((t) => Date.parse(t ?? '')).filter((t) => !Number.isNaN(t)), 0);
}

function keepsSession(peer: Peer | undefined, now = Date.now()): boolean {
  return !!peer && isSessionKeyed(peer) && now - lastActivity(peer.id) < SESSION_KEEP_MS;
}

/** Whether an exited session's inbox still holds a message younger than HOLD_MS. */
function holdsUnread(id: string, now = Date.now()): boolean {
  try {
    return fs.readdirSync(inboxDir(id)).some((f) => now - fs.statSync(path.join(inboxDir(id), f)).mtimeMs < HOLD_MS);
  } catch {
    return false;
  }
}

/**
 * A session that used to be keyed by pid (an older telepathy) still has unread mail under that directory. A resume
 * that reports the same harness session id picks the mail up onto `<agent>-<session id>`.
 */
function adoptHeldMessages(agent: Agent, selfId: string, sessionId: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(peersDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (name === selfId || !name.startsWith(`${agent}-`)) continue;
    const old = readJson<SessionRecord>(path.join(peerDir(name), 'session.json'));
    if (old?.agent !== agent || old.sessionId !== sessionId || isPeerAlive(readPeer(name))) continue;
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

export function registerPresence(
  agent: Agent,
  pid: number,
  fields: { cwd?: string; codexHome?: string } = {},
  id = peerId(agent, pid),
): void {
  const record: PresenceRecord = {
    agent,
    pid,
    procStart: procStart(pid),
    serverPid: process.pid,
    ...fields,
    startedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(peerDir(id), 'presence.json'), { ...record, version: VERSION });
}

export function registerListener(agent: Agent, pid: number, id = peerId(agent, pid)): void {
  const record: ListenerRecord = { pid: process.pid, procStart: procStart(process.pid), startedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(peerDir(id), 'listener.json'), record);
}

/**
 * The stable name for this process, from `--name` or `TELEPATHY_NAME`. Empty after slugify means unset.
 * `explicit` wins over the environment, so a server flag is not ignored when the variable is also set.
 */
export function configuredStableName(explicit?: string): string | undefined {
  const raw = explicit?.trim() || configuredEnv('TELEPATHY_NAME');
  if (!raw) return undefined;
  return slugify(raw) || undefined;
}

/**
 * Records `name` on this peer and moves unread messages off a dead peer that used the same name. A live peer
 * with the same name is left alone: that is a duplicate session, reported when peers are listed.
 */
export function registerStableName(agent: Agent, id: string, explicit?: string): void {
  const name = configuredStableName(explicit);
  if (!name) return;
  writeJsonAtomic(path.join(peerDir(id), 'identity.json'), { name, pid: process.pid, at: new Date().toISOString() });
  adoptStableInbox(agent, id, name);
}

function adoptStableInbox(agent: Agent, selfId: string, stableName: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(peersDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (name === selfId || !name.startsWith(`${agent}-`)) continue;
    const ident = readJson<{ name?: string }>(path.join(peerDir(name), 'identity.json'));
    if (ident?.name !== stableName || isPeerAlive(readPeer(name))) continue;
    let files: string[] = [];
    try {
      files = fs.readdirSync(inboxDir(name));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        fs.renameSync(path.join(inboxDir(name), file), path.join(ensureDir(inboxDir(selfId)), file));
      } catch {
        // taken by another consumer
      }
    }
  }
}

/** Another live peer using this one's configured name. */
export const sameStableName = (a: Peer, b: Peer) =>
  !!a.stableName && a.id !== b.id && a.agent === b.agent && a.stableName === b.stableName;

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
 * collide. From the session's key (its process, or its Codex thread), so a session keeps its name for as long as it runs.
 */
export const nameSuffix = (agent: Agent, key: number | string) =>
  agent[0] + createHash('sha1').update(String(key)).digest('hex').slice(0, 2);

/**
 * A Claude Code session goes by Claude Code's own name for it, so peers see the same name as `/list-agents`. Every
 * other session is named much like Claude Code names its own: `<folder>-<suffix>`, which says where it works.
 */
function displayName(agent: Agent, pid: number, key: string, cwd: string | undefined) {
  const folder = cwd ? slugify(path.basename(cwd)) : '';
  // A Claude session without a name of Claude Code's (before v2.1.224) goes by its folder alone.
  if (agent === 'claude') return claudeSessionName(pid) || folder || `session-${pid}`;
  const k = /^\d+$/.test(key) ? Number(key) : key;
  return folder ? `${folder}-${nameSuffix(agent, k)}` : `session-${key}`;
}

/** A session keyed by its id (a Codex thread, an OpenCode 2 session) rather than by the pid of the process hosting it. */
const isSessionKeyed = (peer: Pick<Peer, 'agent' | 'id' | 'sessionId'>) => {
  const token = sessionToken(peer.sessionId);
  return !!token && peer.id === peerId(peer.agent, token);
};

/** A Codex session keyed by its thread. */
const isThreadKeyed = (peer: Pick<Peer, 'agent' | 'id' | 'sessionId'>) => peer.agent === 'codex' && isSessionKeyed(peer);

/**
 * Whether the session still runs: its process for most agents; for a Codex thread, whether a Codex process still has
 * it loaded, whichever process that is by now; for an OpenCode 2 session, its service and recent use.
 */
/**
 * `telepathy run --headless` keeps the peer alive for as long as that supervisor process does, including a Codex
 * thread the writer-lock scan would call unloaded. A dead pid falls through to the harness's own check.
 */
function hostedSupervisorAlive(peer: Peer): boolean {
  const rec = readJson<{ pid?: number; procStart?: string }>(path.join(peerDir(peer.id), 'hosted.json'));
  return !!rec && typeof rec.pid === 'number' && isSameProcess(rec.pid, rec.procStart);
}

/**
 * `codex exec` is not a TUI: the allowlist rejects a subcommand-shaped first token, so the process scan never
 * lists it. Hooks still register its thread on that process. A shared daemon's writer lock is the signal for a
 * TUI thread; an exec that never took a lock is alive exactly while the exec process that registered it is.
 * `exec-server` does not count, so the ChatGPT.app helper stays offline even if a hook recorded it.
 */
function codexExecAlive(peer: Peer): boolean {
  const session = readSession(peer.id);
  if (!session || (session.source !== 'hook' && session.source !== 'meta')) return false;
  const owners = sessionOwners(peer.id);
  const pid = owners[0]?.pid ?? session.pid;
  const started = owners[0]?.procStart ?? session.procStart;
  if (!isSameProcess(pid, started)) return false;
  const args = commandLine(pid);
  return !!args && isCodexExecCommand(args);
}

export function isPeerAlive(peer: Peer | undefined, now = Date.now()): boolean {
  if (!peer) return false;
  if (hostedSupervisorAlive(peer)) return true;
  if (isThreadKeyed(peer)) {
    const loaded = codexThreadLoaded(peer.codexHome ?? defaultCodexHome(), peer.sessionId as string);
    // A lock the daemon holds is the usual signal. `codex resume <id>` is already that thread while the lock
    // file is still absent, and the TUI's command line names it. An unloaded thread with no such window stays hidden.
    if (loaded === true) return true;
    if (loaded === false) return codexTuiNamesThread(peer.sessionId as string) || codexExecAlive(peer);
  }
  if (isSessionKeyed(peer)) {
    const owner = sessionOwners(peer.id)[0];
    const pid = owner?.pid ?? peer.pid;
    const started = owner?.procStart ?? readSession(peer.id)?.procStart;
    if (!isSameProcess(pid, started)) return false;
    // OpenCode and Kilo keep every session the service ever opened. A session counts only while it is in use.
    if (peer.agent === 'opencode' || peer.agent === 'kilo') return now - lastActivity(peer.id) < SERVICE_SESSION_ACTIVE_MS;
    return true;
  }
  return isSameProcess(peer.pid, peer.procStart);
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
  const generated = displayName(agent, pid, m[2], cwd);
  const identity = readJson<{ name?: string }>(path.join(dir, 'identity.json'));
  const stable = identity?.name && slugify(identity.name) === identity.name ? identity.name : undefined;
  // The name chosen the first time this harness session was seen. A resume keeps it. TELEPATHY_NAME wins.
  const name = stable || rememberedName(agent, session?.sessionId) || generated;
  const sessionKeyed = !!session?.sessionId && m[2] === sessionToken(session.sessionId);
  // Other names that also reach it: the bare folder name, a Codex thread's title (what older versions called it),
  // and the generated suffix name while a configured name is the address.
  const aliases = [
    cwd ? slugify(path.basename(cwd)) : '',
    agent === 'codex' ? slugify(codexThreadName(codexHome, session?.sessionId) ?? '') : '',
    stable ? slugify(generated) : '',
  ];
  return {
    id,
    agent,
    pid,
    // A session keyed by its id may outlive the process that hosted it when it registered (a Codex thread), or share
    // it with many others (an OpenCode service), so that process's start says nothing about the session.
    procStart: sessionKeyed ? undefined : session?.procStart || presence?.procStart,
    startedAt: sessionKeyed ? session?.startedAt : undefined,
    sessionId: session?.sessionId,
    cwd,
    codexHome,
    name,
    address: `${agent}:${slugify(name) || id}`,
    stableName: stable,
    duplicate: sessionOwners(id).length > 1,
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
  observeLaunchedCodex();
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
    if (peer ? !isPeerAlive(peer) : !isSameProcess(pid, undefined)) {
      // The session is gone (or its pid was reused). The directory can stay so a resume reclaims the id and any
      // mail that was already in flight. It is not a mailbox for a new send.
      if (peer) notePeerExit(name);
      if (!holdsUnread(name) && !keepsSession(peer)) fs.rmSync(peerDir(name), { recursive: true, force: true });
      continue;
    }
    // A live process whose hook/server hasn't registered yet isn't reachable, but its files stay.
    if (peer) peers.push(peer);
  }
  // A Codex daemon pid that names a thread already registered by that thread is a duplicate. A pid with no thread
  // at all is hidden too, unless this process saw the interactive TUI and recorded it as `source: 'process'`
  // (no thread yet). The app-server daemon is not that TUI.
  const threads = new Set(peers.filter(isThreadKeyed).map((p) => p.sessionId));
  const ids = new Set(peers.map((p) => p.id));
  return peers.filter((p) => {
    if (p.agent === 'codex' && !isThreadKeyed(p) && !!p.sessionId && threads.has(p.sessionId)) return false;
    const link = readJson<{ id?: unknown }>(path.join(peerDir(p.id), 'link.json'));
    // The pid directory is only a pointer once the session id is known. The session directory is the peer.
    if (typeof link?.id === 'string' && link.id !== p.id && ids.has(link.id)) return false;
    return p.agent !== 'codex' || isThreadKeyed(p) || (!!p.sessionId && !threads.has(p.sessionId)) || isLaunchedCodexTui(p);
  });
}

/** A Codex TUI registered from the process table before any thread id exists. */
function isLaunchedCodexTui(peer: Peer): boolean {
  return peer.agent === 'codex' && !peer.sessionId && readSession(peer.id)?.source === 'process';
}

function launchedTuis(): { pid: number; cwd?: string; threadId?: string }[] {
  const tuis: { pid: number; cwd?: string; threadId?: string }[] = [];
  for (const proc of codexTuiProcesses()) {
    if (!isSameProcess(proc.pid, proc.start)) continue;
    const launch = codexTuiLaunch(proc.args);
    if (!launch) continue;
    tuis.push({ pid: proc.pid, cwd: proc.cwd || processCwd(proc.pid), threadId: launch.threadId });
  }
  return tuis;
}

function codexTuiNamesThread(threadId: string): boolean {
  return launchedTuis().some((tui) => tui.threadId === threadId);
}

/**
 * The pid-keyed name of the TUI whose command line names this thread, and a `link.json` so that row disappears
 * once the thread peer is live. A fresh TUI is not linked from the working directory: a hosted `codex:acpx`
 * session in the same folder is a different process.
 */
function carryLaunchedCodexName(sessionId: string): string | undefined {
  const chosen = launchedTuis().find((tui) => tui.threadId === sessionId);
  if (!chosen) return undefined;
  const threadPeer = sessionPeerId('codex', chosen.pid, sessionId);
  const pidKey = peerId('codex', chosen.pid);
  if (pidKey !== threadPeer) {
    writeJsonAtomic(linkFile('codex', chosen.pid), { id: threadPeer });
    moveInbox(pidKey, threadPeer);
  }
  const placeholder = readPeer(pidKey);
  return placeholder && !placeholder.sessionId ? placeholder.name : undefined;
}

/**
 * Registers interactive Codex TUIs that have not been through SessionStart or a tool call. The plugin MCP server
 * and the hooks start per thread, and a TUI's startup thread often has neither a hook nor a writer lock, so the
 * process table is what makes the window visible. `codex resume <uuid>` is registered as that thread immediately.
 */
function observeLaunchedCodex(): void {
  for (const proc of codexTuiProcesses()) {
    if (!isSameProcess(proc.pid, proc.start)) continue;
    const launch = codexTuiLaunch(proc.args);
    if (!launch) continue;
    const cwd = proc.cwd || processCwd(proc.pid);
    if (launch.threadId && sessionToken(launch.threadId)) {
      observeResumedCodex(proc, launch.threadId, cwd);
      continue;
    }
    observeUnpromptedCodex(proc, cwd);
  }
}

function observeResumedCodex(proc: CodexTuiProc, threadId: string, cwd: string | undefined): void {
  const id = sessionPeerId('codex', proc.pid, threadId);
  const existing = readSession(id);
  const hostAlive = !!existing && isSameProcess(existing.pid, existing.procStart);
  const home = proc.codexHome ?? existing?.codexHome ?? defaultCodexHome();
  if (!existing?.sessionId || !hostAlive || (proc.codexHome && existing.codexHome !== proc.codexHome)) {
    registerSession('codex', proc.pid, {
      sessionId: threadId,
      cwd: cwd ?? existing?.cwd,
      source: existing?.source === 'hook' || existing?.source === 'meta' ? existing.source : 'process',
      codexHome: home,
    });
  }
  if (peerId('codex', proc.pid) !== id) writeJsonAtomic(linkFile('codex', proc.pid), { id });
  linkCodexWrappers(proc, id);
}

/** The npm/node wrapper is the same window. Point its row at the native process so listPeers keeps one. */
function linkCodexWrappers(proc: CodexTuiProc, id: string): void {
  for (const wrapperPid of proc.wrapperPids ?? []) {
    const wrapperId = peerId('codex', wrapperPid);
    if (wrapperId === id) continue;
    if (!fs.existsSync(path.join(peerDir(wrapperId), 'session.json'))) continue;
    writeJsonAtomic(linkFile('codex', wrapperPid), { id });
  }
}

function observeUnpromptedCodex(proc: CodexTuiProc, cwd: string | undefined): void {
  const id = peerId('codex', proc.pid);
  const link = linkedPeerId('codex', proc.pid);
  if (link && link !== id) {
    const linked = readPeer(link);
    if (linked && isPeerAlive(linked)) return;
  }
  const existing = readSession(id);
  const home = proc.codexHome || existing?.codexHome || defaultCodexHome();
  if (
    existing?.source === 'process' &&
    existing.pid === proc.pid &&
    isSameProcess(proc.pid, existing.procStart) &&
    existing.codexHome === home &&
    (existing.cwd || !cwd)
  ) {
    linkCodexWrappers(proc, id);
    return;
  }
  registerSession('codex', proc.pid, { cwd, source: 'process', codexHome: home });
  linkCodexWrappers(proc, id);
}

/**
 * Session-keyed peers whose process has exited but whose record is still inside the keep window. `listPeers` does
 * not show them. `sendMessage` resolves the name so it can say the session is offline. It does not write an inbox.
 */
export function keptPeers(): Peer[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(peersDir());
  } catch {
    return [];
  }
  const kept: Peer[] = [];
  for (const name of names) {
    const peer = readPeer(name);
    if (!peer || !isSessionKeyed(peer) || isPeerAlive(peer) || !keepsSession(peer)) continue;
    kept.push(peer);
  }
  return kept;
}

/**
 * The Codex threads registered by one process. A Codex that runs a single thread per process and doesn't name it in a
 * tool call's `_meta` is then still found by its process.
 */
export function codexThreadsOf(pid: number): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(peersDir());
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith('codex-') && !/^codex-\d+$/.test(name))
    .map((name) => readSession(name))
    .filter((s): s is SessionRecord => s?.agent === 'codex' && s.pid === pid && !!s.sessionId && isPeerAlive(readPeer(peerId('codex', s.sessionId))))
    .map((s) => s.sessionId as string);
}

/** This session's own identity, even before (or without) any registration file. */
export function selfPeer(agent: Agent, pid: number, id = peerId(agent, pid)): Peer {
  const key = id.slice(agent.length + 1);
  return (
    readPeer(id) ?? {
      id,
      agent,
      pid,
      name: `session-${key}`,
      address: `${agent}:session-${key}`,
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

  // Refs keep the session id's own capitals (`antigravity-convB`). The query is lowercased for the
  // other comparisons, so the id is compared on both sides. An exact id still wins when two ids
  // differ only by case.
  const byId = peers.filter((p) => p.id.toLowerCase() === q);
  const exactId = byId.filter((p) => p.id === query);
  return (
    pick(exactId.length ? exactId : byId, 'matches') ??
    pick(peers.filter((p) => p.address.toLowerCase() === q), 'matches') ??
    // `codex:` with nothing after the colon is that agent when only one of its sessions is up.
    pick(q.endsWith(':') && qAgent && qSlug === '' ? peers.filter((p) => p.agent === qAgent) : [], 'matches') ??
    pick(peers.filter((p) => sameAgent(p) && (slugsOf(p).includes(qSlug) || p.name.toLowerCase() === q)), 'matches') ??
    pick(peers.filter((p) => sameAgent(p) && qSlug !== '' && slugsOf(p).some((s) => s.startsWith(qSlug))), 'is a prefix of') ?? {
      error:
        `No reachable session matches "${to}". ` +
        (peers.length ? `Reachable: ${peers.map(peerRef).join(', ')}.` : 'No other sessions with telepathy are running.'),
    }
  );
}
