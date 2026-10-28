import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Agent } from './core/agents.ts';
import { debugLog } from './core/debug.ts';
import { trackTouchedFiles } from './core/edits.ts';
import { guideText } from './core/guide.ts';
import { claimInbox, formatForContext, pendingCount } from './core/messages.ts';
import { ensureDir, inboxDir, peerDir, peersDir } from './core/paths.ts';
import { isDeliveryOwner, isPeerAlive, keepSessionName, peerId, readPeer, readSession, registerListener, registerPresence, registerSession, selfPeer, sessionPeerId } from './core/peers.ts';
import { commandLine, processTable } from './core/proc.ts';
import { type PeerStatus, writeStatus } from './core/status.ts';
import { listPeersTool, readMessagesTool, sendMessageTool, TOOLS, type ToolResult } from './core/tools.ts';
import { startWakeFlusher } from './core/wake.ts';

startWakeFlusher();

/**
 * OpenCode and Kilo Code plugin. It runs inside the agent's own process, so it registers native tools (which, unlike
 * MCP calls, know the calling session) and wakes the session itself. Two plugin APIs share the default export:
 * `server` for OpenCode 1.x and Kilo Code (see TelepathyPlugin) and `setup` for OpenCode 2 (see setupV2).
 */

interface PromptTarget {
  sessionID: string;
  agent?: string;
  model?: unknown;
}

interface ListedSession {
  id?: string;
  parentID?: string;
  info?: { id?: string; parentID?: string };
  time?: { created?: number; updated?: number };
}

interface PluginInput {
  client: {
    session: {
      promptAsync(options: { path: { id: string }; body: { parts: { type: 'text'; text: string }[]; agent?: string; model?: unknown } }): Promise<unknown>;
      /** Present on some OpenCode builds. Used only after init returns, and only to resolve `--continue`. */
      list?(): Promise<unknown>;
      /** Creates a session when mail arrives before the TUI has one. */
      create?(body?: unknown): Promise<unknown>;
      select?(options: { sessionID?: string; path?: { id: string }; body?: { sessionID: string } }): Promise<unknown>;
    };
    tui?: {
      selectSession?(options: { sessionID?: string; body?: { sessionID: string } }): Promise<unknown>;
    };
  };
  directory?: string;
}

export interface OpenCodeLaunch {
  sessionID?: string;
  /** `--continue` / `-c`: resume the most recently updated session. */
  continueLast: boolean;
  /** `--fork` duplicates the named session, so the id on the command line is not the one now on screen. */
  fork: boolean;
}

/** Splits a `ps` args string on whitespace, keeping quoted regions together. */
export function tokenizeCommandLine(args: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i] ?? '';
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < args.length) {
      cur += args[++i] ?? '';
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const looksLikeOpenCode = (argv: readonly string[]) => argv.some((token) => /(^|[\\/])opencode(\.exe)?$/.test(token));

/** `--session`, `-s`, `--continue`, and `--fork` from one argv. `-s` and `-c` count only for an OpenCode command. */
export function opencodeLaunchFromArgv(argv: readonly string[]): OpenCodeLaunch {
  const opencode = looksLikeOpenCode(argv);
  let sessionID: string | undefined;
  let continueLast = false;
  let fork = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--fork' || arg === '--fork-session') {
      fork = true;
      continue;
    }
    if (arg === '--continue' || (opencode && arg === '-c')) {
      continueLast = true;
      continue;
    }
    if (arg === '--session' || (opencode && arg === '-s')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        sessionID = next;
        i++;
      }
      continue;
    }
    const sessionEq = /^(?:--session|-s)=(.+)$/.exec(arg);
    if (sessionEq?.[1] && (arg.startsWith('--session') || opencode)) sessionID = sessionEq[1];
  }
  return { sessionID, continueLast, fork };
}

/**
 * OpenCode 1.19 runs plugins in another process, so `--session` is on an ancestor, not on `process.argv`.
 * Walks parents until a session id or `--continue` shows up. `--session` counts on any ancestor. `-s` and
 * `-c` count only when that process's command looks like the `opencode` binary.
 */
export function opencodeLaunchFromAncestors(
  startPid = process.ppid,
  readArgs: (pid: number) => string | undefined = commandLine,
  parentOf: (pid: number) => number | undefined = (pid) => processTable(0).get(pid)?.ppid,
): OpenCodeLaunch {
  const seen = new Set<number>();
  let merged: OpenCodeLaunch = { continueLast: false, fork: false };
  for (let pid = startPid; pid > 1 && !seen.has(pid); ) {
    seen.add(pid);
    const parsed = opencodeLaunchFromArgv(tokenizeCommandLine(readArgs(pid) ?? ''));
    merged = {
      sessionID: merged.sessionID ?? parsed.sessionID,
      continueLast: merged.continueLast || parsed.continueLast,
      fork: merged.fork || parsed.fork,
    };
    if (merged.sessionID) return merged;
    const next = parentOf(pid);
    if (!next || next === pid) break;
    pid = next;
  }
  return merged;
}

/** `opencode --session ses_…` on this process's own argv. Often absent in OpenCode 1.19. */
export function opencodeSessionFromArgv(argv: readonly string[] = process.argv): string | undefined {
  const launch = opencodeLaunchFromArgv(argv);
  return launch.fork ? undefined : launch.sessionID;
}

function listedSessions(value: unknown): { id: string; parentID?: string; updated: number }[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : [];
  const out: { id: string; parentID?: string; updated: number }[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as ListedSession;
    const id = typeof rec.id === 'string' ? rec.id : typeof rec.info?.id === 'string' ? rec.info.id : undefined;
    if (!id) continue;
    const parentID =
      typeof rec.parentID === 'string' ? rec.parentID : typeof rec.info?.parentID === 'string' ? rec.info.parentID : undefined;
    const time = rec.time;
    const updated = typeof time?.updated === 'number' ? time.updated : typeof time?.created === 'number' ? time.created : 0;
    out.push({ id, parentID, updated });
  }
  return out;
}

function createdSessionID(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as { id?: unknown; data?: { id?: unknown }; info?: { id?: unknown } };
  if (typeof rec.id === 'string') return rec.id;
  if (typeof rec.data?.id === 'string') return rec.data.id;
  if (typeof rec.info?.id === 'string') return rec.info.id;
  return undefined;
}

interface BusEvent {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string; parentID?: string };
    status?: { type?: string };
    params?: { sessionID?: string };
  };
}

/** A session id carried by a session event or a TUI route/select event. */
function eventSession(event: BusEvent): { sessionID?: string; parentID?: string } {
  const p = event.properties ?? {};
  const sessionID = p.info?.id ?? p.sessionID ?? p.params?.sessionID;
  return { sessionID, parentID: p.info?.parentID };
}

/**
 * The session's status from OpenCode's events: busy or idle from the primary session, waiting while any of its
 * sessions (subagents too, since that stops the work) asks for a permission. OpenCode 1.x names the prompt event
 * `permission.asked`; earlier versions `permission.updated`.
 */
function statusOf(event: BusEvent, isPrimary: (sessionID: string) => boolean): PeerStatus | undefined {
  const sessionID = event.properties?.sessionID;
  if (event.type === 'permission.asked' || event.type === 'permission.updated') return 'waiting';
  if (event.type === 'permission.replied') return 'busy';
  if (!sessionID || !isPrimary(sessionID)) return undefined;
  if (event.type === 'session.idle') return 'idle';
  if (event.type === 'session.status') return event.properties?.status?.type === 'idle' ? 'idle' : 'busy';
  return undefined;
}

const skillsDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'skills');
const out = (r: ToolResult) => (r.isError ? `Error: ${r.text}` : r.text);

const TelepathyPlugin = async ({ client, directory }: PluginInput) => {
  const agent: Agent = /kilo/i.test(path.basename(process.execPath)) ? 'kilo' : 'opencode';
  const pid = process.pid;
  let id = peerId(agent, pid);
  registerPresence(agent, pid, { cwd: directory });
  registerListener(agent, pid, id);
  writeStatus(id, 'idle');
  debugLog('opencode', `plugin loaded for ${id} in ${directory ?? '?'}`);

  let active: PromptTarget | undefined; // the primary session the user last prompted
  const children = new Set<string>(); // subagent sessions: never the delivery target
  const busy = new Set<string>();
  let delivering = false;

  /**
   * A fresh TUI has no session until the first prompt. Mail that arrives first creates one and prompts it,
   * which is that first prompt. Returns the id, or undefined when this build has no create call.
   */
  async function openSession(): Promise<string | undefined> {
    const create = client.session.create;
    if (!create) return undefined;
    const sessionID = createdSessionID(await create({}));
    if (!sessionID) return undefined;
    bind(sessionID);
    const select = client.tui?.selectSession ?? client.session.select;
    if (select) {
      try {
        await select({ sessionID, body: { sessionID }, path: { id: sessionID } });
      } catch (err) {
        debugLog('opencode', `tui select failed: ${(err as Error).message}`);
      }
    }
    return sessionID;
  }

  /** Hands pending messages to the active session once it's idle; promptAsync then starts a turn. */
  async function deliver(): Promise<void> {
    if (delivering || !isDeliveryOwner(id, pid)) return;
    if (!active && pendingCount(id) === 0) return;
    if (active && busy.has(active.sessionID)) return;
    delivering = true;
    try {
      if (!active) {
        const sessionID = await openSession();
        if (!sessionID) return;
      }
      if (!active || busy.has(active.sessionID)) return;
      const messages = claimInbox(id);
      if (!messages.length) return;
      const target = active;
      busy.add(target.sessionID); // the prompt makes it busy; session.idle clears it
      await client.session.promptAsync({
        path: { id: target.sessionID },
        // The messages are a turn of their own here, so they need no lead-in.
        body: { parts: [{ type: 'text', text: formatForContext(messages, { lead: false }) }], agent: target.agent, model: target.model },
      });
      debugLog('opencode', `delivered ${messages.map((m) => m.id).join(', ')} to session ${target.sessionID}`);
    } catch (err) {
      // The messages stay in the archive, where read_messages shows them as the most recent received.
      if (active) busy.delete(active.sessionID);
      debugLog('opencode', `delivery failed: ${(err as Error).message}`);
    } finally {
      delivering = false;
    }
  }

  let watcher: fs.FSWatcher | undefined;
  const watch = () => {
    if (watcher) return;
    try {
      watcher = fs.watch(ensureDir(inboxDir(id)), () => void deliver());
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined; // the interval below still polls
    }
  };
  watch();
  setInterval(() => {
    watch();
    void deliver();
  }, 2000).unref();

  /**
   * Points this process at `sessionID`. The pid-era name is stored before the session-keyed name is generated,
   * so a listing does not change suffix when the ses_ id appears. Resume binds here, before the first prompt,
   * and registers the listener the old peer had.
   */
  const bind = (sessionID: string) => {
    if (!sessionID || children.has(sessionID)) return;
    const next = sessionPeerId(agent, pid, sessionID);
    if (active?.sessionID === sessionID && id === next) {
      registerListener(agent, pid, id);
      return;
    }
    if (id === peerId(agent, pid)) {
      const carried = readPeer(id)?.name;
      if (carried) keepSessionName(agent, sessionID, carried);
    }
    const previous = id;
    active = { sessionID, agent: active?.agent, model: active?.model };
    id = next;
    registerSession(agent, pid, { sessionId: sessionID, cwd: directory, source: 'plugin' });
    registerPresence(agent, pid, { cwd: directory }, id);
    registerListener(agent, pid, id);
    watcher?.close();
    watcher = undefined;
    watch();
    debugLog('opencode', `bound ${previous} to ${id}`);
  };

  // Do not await a client call here. OpenCode cannot answer until plugin init returns, and waiting deadlocks
  // the TUI. `--session` is read from this process or an ancestor. `--continue` lists after init returns and
  // binds the newest primary session. A fresh TUI has no session yet and stays on the pid until one exists.
  const own = opencodeLaunchFromArgv(process.argv);
  const inherited = opencodeLaunchFromAncestors();
  const launch: OpenCodeLaunch = {
    sessionID: own.sessionID ?? inherited.sessionID,
    continueLast: own.continueLast || inherited.continueLast,
    fork: own.fork || inherited.fork,
  };
  if (launch.sessionID && !launch.fork) bind(launch.sessionID);
  else if (launch.continueLast && !launch.fork && client.session.list) {
    const list = client.session.list.bind(client.session);
    const timer = setTimeout(() => {
      if (id !== peerId(agent, pid)) return;
      void Promise.resolve()
        .then(() => list())
        .then((value) => {
          if (id !== peerId(agent, pid)) return;
          const primary = listedSessions(value)
            .filter((row) => !row.parentID)
            .sort((a, b) => b.updated - a.updated);
          if (primary[0]) bind(primary[0].id);
        })
        .catch((err) => debugLog('opencode', `session list failed: ${(err as Error).message}`));
    }, 0);
    timer.unref();
  }

  const self = () => selfPeer(agent, pid, id);
  const toolArgs = new Map<string, unknown>(); // by call id, from before a tool runs until it has run

  return {
    /** Lets OpenCode find the using-telepathy skill. */
    config: async (config: { skills?: { paths?: string[] } | unknown[] }) => {
      if (Array.isArray(config.skills)) return;
      const skills = (config.skills ??= {}) as { paths?: string[] };
      skills.paths ??= [];
      if (!skills.paths.includes(skillsDir)) skills.paths.push(skillsDir);
    },

    'chat.message': async (input: { sessionID: string; agent?: string; model?: unknown }) => {
      if (children.has(input.sessionID)) return;
      active = { sessionID: input.sessionID, agent: input.agent, model: input.model };
      bind(input.sessionID);
    },

    event: async ({ event }: { event: BusEvent }) => {
      const p = event.properties ?? {};
      // session.created/updated, and TUI events that name the session on screen, including tui.session.select.
      // Startup `--session` does not emit one of these in OpenCode 1.19, so the ancestor command line is what
      // binds a resume. These events cover a session picked in the TUI after launch.
      if (event.type === 'session.created' || event.type === 'session.updated' || event.type.startsWith('tui.')) {
        const { sessionID, parentID } = eventSession(event);
        if (sessionID && parentID) children.add(sessionID);
        else if (sessionID) bind(sessionID);
      }
      const status = statusOf(event, (sessionID) => !children.has(sessionID) && (!active || active.sessionID === sessionID));
      if (status) writeStatus(id, status);
      if (event.type === 'session.status' && p.sessionID) {
        if (p.status?.type === 'idle') busy.delete(p.sessionID);
        else busy.add(p.sessionID);
      }
      if (event.type === 'session.idle' && p.sessionID) {
        busy.delete(p.sessionID);
        setTimeout(() => void deliver(), 0); // after OpenCode finishes going idle
      }
    },

    'tool.execute.before': async (input: { callID: string }, output: { args: unknown }) => {
      toolArgs.set(input.callID, output.args);
    },

    /** Records the files a tool edited, and adds a note to its result when it touched another session's area. */
    'tool.execute.after': async (input: { tool: string; callID: string }, output: { output?: unknown }) => {
      const args = toolArgs.get(input.callID);
      toolArgs.delete(input.callID);
      try {
        const note = trackTouchedFiles({ id, agent }, input.tool, args, directory);
        if (note && typeof output.output === 'string') output.output += `\n\n${note}`;
      } catch (err) {
        debugLog('opencode', `file tracking failed: ${(err as Error).message}`);
      }
    },

    /** OpenCode shows no MCP instructions for plugin tools, so the guide goes into the system prompt. */
    'experimental.chat.system.transform': async (_input: unknown, output: { system?: string[] }) => {
      if (Array.isArray(output.system)) output.system.push(guideText(agent));
    },

    tool: {
      telepathy_list_peers: {
        description: TOOLS.list_peers.description,
        args: TOOLS.list_peers.args,
        execute: async () => out(listPeersTool(self())),
      },
      telepathy_send_message: {
        description: TOOLS.send_message.description,
        args: TOOLS.send_message.args,
        execute: async (args: { to: string; message: string }) => out(await sendMessageTool(self(), args.to, args.message)),
      },
      telepathy_read_messages: {
        description: TOOLS.read_messages.description,
        args: TOOLS.read_messages.args,
        execute: async (args: { id?: string; limit?: number }) => out(readMessagesTool(id, args)),
      },
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------
// OpenCode 2. Its background service (`opencode serve --service`) hosts the sessions of every window and project, and
// runs `setup` once per project directory, so sessions go by their own id, `opencode-<session id>`, rather than by the
// process. Only the parts of the API this plugin uses are typed here (from @opencode/plugin 2.0).

interface V2Event {
  type: string;
  data?: {
    sessionID?: string;
    parentID?: string;
    info?: { id?: string; parentID?: string };
  };
}

type Disposable = Promise<{ dispose(): unknown }> | { dispose(): unknown } | void;

interface V2ToolResult {
  content?: string | { type: string; text?: string }[];
}

interface V2ToolEditor {
  get(id: string): unknown;
  add(tool: {
    name: string;
    description: string;
    input: unknown;
    execute: (input: unknown, context: { sessionID: string }) => Promise<V2ToolResult>;
  }): void;
}

interface V2SkillEditor {
  get(id: string): unknown;
  add(skill: { id: string; name: string; description?: string; path: string; content: string }): void;
}

interface V2Context {
  location: { directory: string };
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<V2Event> };
  session: {
    hook(name: 'prompt', fn: (event: { sessionID: string }) => unknown): Disposable;
    hook(name: 'context', fn: (event: { sessionID: string; system: { type: 'text'; text: string }[] }) => unknown): Disposable;
    prompt(input: { sessionID: string; text: string; delivery?: 'steer' | 'queue' }): Promise<unknown>;
    get(input: { sessionID: string }): Promise<unknown>;
  };
  tool: {
    transform(fn: (editor: V2ToolEditor) => void): Disposable;
    hook(
      name: 'execute.after',
      fn: (event: { tool: string; sessionID: string; input: unknown; status: string; result?: V2ToolResult }) => unknown,
    ): Disposable;
  };
  skill: { transform(fn: (editor: V2SkillEditor) => void): Disposable };
}

/** The using-telepathy skill, for OpenCode 2's skill registry (which takes the content, not a folder). */
function readSkill(): { id: string; name: string; description?: string; path: string; content: string } | undefined {
  const file = path.join(skillsDir, 'using-telepathy', 'SKILL.md');
  try {
    const content = fs.readFileSync(file, 'utf8');
    const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim();
    return { id: 'using-telepathy', name: 'using-telepathy', description, path: file, content };
  } catch {
    return undefined;
  }
}

const jsonSchema = (args: z.ZodRawShape) => z.toJSONSchema(z.object(args));

async function setupV2(ctx: V2Context): Promise<() => Promise<void>> {
  const agent: Agent = 'opencode';
  const pid = process.pid;
  const directory = ctx.location.directory;
  const idOf = (sessionID: string) => peerId(agent, sessionID);
  const sessions = new Set<string>(); // this directory's sessions that registered here
  const parents = new Map<string, string>(); // subagent session → its parent: subagents are no peers of their own
  const disposables: Disposable[] = [];
  debugLog('opencode', `plugin set up (OpenCode 2) in pid ${pid} for ${directory}`);

  const register = (sessionID: string) => {
    if (parents.has(sessionID)) return;
    const id = idOf(sessionID);
    registerSession(agent, pid, { sessionId: sessionID, cwd: directory, source: 'plugin' }, id);
    if (sessions.has(sessionID)) return;
    sessions.add(sessionID);
    registerPresence(agent, pid, { cwd: directory }, id);
    registerListener(agent, pid, id); // this plugin wakes the session with its messages
    writeStatus(id, 'idle');
    watch(sessionID);
  };

  const delivering = new Set<string>();
  /** Hands pending messages to the session as a prompt; `steer` starts a turn, or joins the running one. */
  async function deliver(sessionID: string): Promise<void> {
    if (delivering.has(sessionID) || !isDeliveryOwner(idOf(sessionID), pid)) return;
    delivering.add(sessionID);
    try {
      const messages = claimInbox(idOf(sessionID));
      if (!messages.length) return;
      // The messages are a turn of their own here, so they need no lead-in.
      await ctx.session.prompt({ sessionID, text: formatForContext(messages, { lead: false }), delivery: 'steer' });
      debugLog('opencode', `delivered ${messages.map((m) => m.id).join(', ')} to session ${sessionID}`);
    } catch (err) {
      // The messages stay in the archive, where read_messages shows them as the most recent received.
      debugLog('opencode', `delivery to ${sessionID} failed: ${(err as Error).message}`);
    } finally {
      delivering.delete(sessionID);
    }
  }

  const watchers = new Map<string, fs.FSWatcher>();
  function watch(sessionID: string): void {
    if (watchers.has(sessionID)) return;
    try {
      const watcher = fs.watch(ensureDir(inboxDir(idOf(sessionID))), () => void deliver(sessionID));
      watcher.on('error', () => {
        watcher.close();
        watchers.delete(sessionID);
      });
      watchers.set(sessionID, watcher);
    } catch {
      // the interval below still polls
    }
  }
  const timer = setInterval(() => {
    for (const sessionID of sessions) {
      watch(sessionID);
      void deliver(sessionID);
    }
  }, 2000);
  timer.unref?.();

  // A restarted service runs the sessions of this directory that the previous one had, under a new pid: take them over.
  let names: string[] = [];
  try {
    names = fs.readdirSync(peersDir());
  } catch {
    // no registry yet
  }
  for (const name of names) {
    const session = name.startsWith(`${agent}-ses_`) ? readSession(name) : undefined;
    if (!session?.sessionId || session.cwd !== directory || session.pid === pid || isPeerAlive(readPeer(name))) continue;
    const sessionID = session.sessionId;
    ctx.session.get({ sessionID }).then(
      () => register(sessionID),
      () => fs.rmSync(peerDir(name), { recursive: true, force: true }), // deleted meanwhile
    );
  }

  disposables.push(ctx.session.hook('prompt', (event) => register(event.sessionID)));

  /** OpenCode shows no MCP instructions for plugin tools, so the guide goes into the system prompt. */
  disposables.push(
    ctx.session.hook('context', (event) => {
      if (Array.isArray(event.system)) event.system.push({ type: 'text', text: guideText(agent) });
    }),
  );

  const skill = readSkill();
  if (skill) {
    disposables.push(
      ctx.skill.transform((editor) => {
        if (!editor.get(skill.id)) editor.add(skill);
      }),
    );
  }

  const self = (sessionID: string) => {
    register(sessionID);
    return selfPeer(agent, pid, idOf(sessionID));
  };
  disposables.push(
    ctx.tool.transform((editor) => {
      editor.add({
        name: 'telepathy_list_peers',
        description: TOOLS.list_peers.description,
        input: jsonSchema(TOOLS.list_peers.args),
        execute: async (_input, c) => ({ content: out(listPeersTool(self(c.sessionID))) }),
      });
      editor.add({
        name: 'telepathy_send_message',
        description: TOOLS.send_message.description,
        input: jsonSchema(TOOLS.send_message.args),
        execute: async (input, c) => {
          const args = z.object(TOOLS.send_message.args).parse(input);
          return { content: out(await sendMessageTool(self(c.sessionID), args.to, args.message)) };
        },
      });
      editor.add({
        name: 'telepathy_read_messages',
        description: TOOLS.read_messages.description,
        input: jsonSchema(TOOLS.read_messages.args),
        execute: async (input, c) => {
          const args = z.object(TOOLS.read_messages.args).parse(input ?? {});
          return { content: out(readMessagesTool(self(c.sessionID).id, args)) };
        },
      });
    }),
  );

  /** Records the files a tool edited, and adds a note to its result when it touched another session's area. */
  disposables.push(
    ctx.tool.hook('execute.after', (event) => {
      const sessionID = parents.get(event.sessionID) ?? event.sessionID;
      if (!sessions.has(sessionID)) return;
      try {
        const note = trackTouchedFiles({ id: idOf(sessionID), agent }, event.tool, event.input, directory);
        const result = event.result;
        if (!note || event.status !== 'completed' || !result) return;
        if (typeof result.content === 'string') result.content += `\n\n${note}`;
        else if (Array.isArray(result.content)) result.content.push({ type: 'text', text: note });
      } catch (err) {
        debugLog('opencode', `file tracking failed: ${(err as Error).message}`);
      }
    }),
  );

  /** Statuses from the session's events: busy while it runs, waiting while it (or a subagent of it) asks for a permission. */
  const abort = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
      const data = event.data ?? {};
      const childID = data.info?.id ?? data.sessionID;
      const parentID = data.parentID ?? data.info?.parentID;
      if (event.type === 'session.created' && childID && parentID) parents.set(childID, parents.get(parentID) ?? parentID);
      const sessionID = data.sessionID && (parents.get(data.sessionID) ?? data.sessionID);
      if (!sessionID || !sessions.has(sessionID)) continue;
      const id = idOf(sessionID);
      if (event.type === 'session.deleted' && sessionID === data.sessionID) {
        sessions.delete(sessionID);
        watchers.get(sessionID)?.close();
        watchers.delete(sessionID);
        fs.rmSync(peerDir(id), { recursive: true, force: true });
        continue;
      }
      const status = STATUS_EVENTS[event.type];
      // A subagent finishing doesn't make its parent idle.
      if (status && (status === 'waiting' || status === 'busy' || sessionID === data.sessionID)) writeStatus(id, status);
    }
  })().catch((err) => {
    if (!abort.signal.aborted) debugLog('opencode', `event stream ended: ${(err as Error).message}`);
  });

  return async () => {
    abort.abort();
    clearInterval(timer);
    for (const watcher of watchers.values()) watcher.close();
    for (const d of await Promise.all(disposables)) {
      try {
        await d?.dispose();
      } catch {
        // already gone with the plugin
      }
    }
  };
}

const STATUS_EVENTS: Record<string, PeerStatus> = {
  'session.execution.started': 'busy',
  'session.execution.succeeded': 'idle',
  'session.execution.failed': 'idle',
  'session.execution.interrupted': 'idle',
  'permission.asked': 'waiting',
  'permission.replied': 'busy',
};

/**
 * OpenCode 2 takes `{ id, setup }` (it ignores other keys); OpenCode 1.x and Kilo Code take `{ id, server }`.
 */
export default { id: 'telepathy', server: TelepathyPlugin, setup: setupV2 };
