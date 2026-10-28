import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { withdrawFromCodexQueue } from './core/codex-queue.ts';
import { debugLog } from './core/debug.ts';
import { unseenSetupNotes } from './core/setup.ts';
import { guideText } from './core/guide.ts';
import { recordClaudeSocket, startClaudeSocketWatcher } from './core/claude-socket.ts';
import { startWakeFlusher } from './core/wake.ts';
import {
  codexThreadsOf,
  defaultCodexHome,
  isDeliveryOwner,
  linkedPeerId,
  peerId,
  readSession,
  registerPresence,
  registerSession,
  registerStableName,
  selfPeer,
  sessionPeerId,
} from './core/peers.ts';
import { findAgent, isStreamJsonClaude, parseAgent } from './core/proc.ts';
import { listPeersTool, readMessagesTool, sendMessageTool, TOOLS, type ToolResult } from './core/tools.ts';
import { VERSION } from './core/version.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const value = argv[argv.indexOf(name) + 1];
  return value && !value.startsWith('--') ? value : undefined;
};
const { agent, pid: agentPid } = findAgent(parseAgent(flag('--agent')));

/**
 * Where the session works, if the server's cwd says so. Some agents (Codex, Kimi Code, Antigravity) start
 * plugin MCP servers in the plugin's own directory, which says nothing about the session.
 */
function sessionCwd(): string | undefined {
  const cwd = process.cwd();
  const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const declaredRoots = Object.entries(process.env)
    .filter(([name, value]) => name.endsWith('PLUGIN_ROOT') && value)
    .map(([, value]) => path.resolve(value as string));
  if (agent === 'codex' || cwd === pluginRoot || cwd.startsWith(pluginRoot + path.sep) || declaredRoots.includes(cwd)) {
    return undefined;
  }
  return cwd;
}

/**
 * Grok can't run a plugin monitor, but its model can start one with its own monitor tool, whose output lines wake
 * the session like Claude Code's plugin monitors do.
 */
function monitorCommand(): string {
  const monitor = path.join(path.dirname(fileURLToPath(import.meta.url)), 'monitor.mjs');
  return `node "${monitor}" --agent ${agent}`;
}

/**
 * Claude Code starts plugin monitors only in interactive terminal sessions. Hosts that drive it over stream-json
 * (the Claude app's Code tab, Agent SDK apps) never run one, so there the session keeps a one-shot waiter running
 * itself. A one-prompt `claude -p` run ends anyway, so it needs neither.
 */
function claudeWithoutMonitor(): boolean {
  return agent === 'claude' && isStreamJsonClaude(agentPid) && !process.env.CLAUDE_CODE_MESSAGING_SOCKET;
}

// A Codex session goes by its thread, which the server learns only from a tool call (see selfIdFor).
// Any other harness is keyed by its session id once a hook has linked this process to one.
function boundId(): string {
  return linkedPeerId(agent, agentPid) ?? peerId(agent, agentPid);
}
const selfId = boundId();
if (agent !== 'codex' && isDeliveryOwner(selfId, agentPid)) {
  registerPresence(agent, agentPid, { cwd: sessionCwd() }, selfId);
  registerStableName(agent, selfId, flag('--name'));
}
let stopSocketWatcher: (() => void) | undefined;
let watchingSocket: string | undefined;
function armClaudeSocket(id: string): void {
  if (agent !== 'claude' || watchingSocket === id) return;
  if (!isDeliveryOwner(id, agentPid)) return;
  stopSocketWatcher?.();
  recordClaudeSocket(id, process.env, agentPid);
  stopSocketWatcher = startClaudeSocketWatcher(id, agentPid);
  watchingSocket = id;
}
armClaudeSocket(selfId);
// The SessionStart hook may link this process after the server has started.
let activeId = selfId;
const relink = setInterval(() => {
  const id = boundId();
  if (!isDeliveryOwner(id, agentPid) || id === activeId) return;
  if (agent !== 'codex') {
    registerPresence(agent, agentPid, { cwd: sessionCwd() }, id);
    registerStableName(agent, id, flag('--name'));
  }
  armClaudeSocket(id);
  activeId = id;
}, 500);
relink.unref();
debugLog('server', `started for ${selfId}`);
startWakeFlusher();

const presenceFor = new Set<string>();

/**
 * The session a tool call comes from. Codex hosts many threads in one process (see sessionKey), and sends the thread
 * id in the `_meta` of every tool call, so a Codex session is the thread named there. The SessionStart hook is the
 * primary source of the thread's record (it registers the session before any tool runs); this covers sessions where
 * the hook isn't approved yet.
 */
function selfIdFor(meta: Record<string, unknown> | undefined): string {
  if (agent !== 'codex') return boundId();
  let thread = [meta?.threadId, meta?.sessionId].find((v): v is string => typeof v === 'string' && v.length > 0);
  if (!thread) {
    // Without one, the thread this process runs, if its hooks registered exactly one.
    const own = codexThreadsOf(agentPid);
    if (own.length === 1) thread = own[0];
  }
  const id = sessionPeerId(agent, agentPid, thread);
  if (!thread) return id;
  if (!presenceFor.has(id)) {
    registerPresence(agent, agentPid, { codexHome: defaultCodexHome() }, id);
    registerStableName(agent, id, flag('--name'));
    presenceFor.add(id);
  }
  const existing = readSession(id);
  if (!existing) {
    registerSession(agent, agentPid, { sessionId: thread, source: 'meta', codexHome: defaultCodexHome() });
    debugLog('server', `learned codex thread ${thread} from tool-call _meta (keys: ${Object.keys(meta ?? {}).join(',')})`);
  }
  return id;
}

const server = new McpServer(
  { name: 'telepathy', version: VERSION },
  {
    capabilities: { tools: {} },
    // Claude Code keeps these in its system prompt; Codex shows them with the tools. The full guide is the
    // using-telepathy skill, loaded on demand.
    instructions: guideText(agent, {
      monitorCommand: agent === 'grok' ? monitorCommand() : undefined,
      waiterCommand: claudeWithoutMonitor() ? `${monitorCommand()} --once` : undefined,
    }),
  },
);

const text = ({ text, isError, structured }: ToolResult) => ({
  content: [{ type: 'text' as const, text }],
  ...(structured ? { structuredContent: structured } : {}),
  ...(isError ? { isError } : {}),
});

/**
 * Adds `[telepathy setup]` notes the first time this session would show each one. A later tool call, including
 * from a new server process, does not repeat a note it has already shown.
 */
function withSetupNotes(selfId: string, result: ToolResult): ToolResult {
  const notes = unseenSetupNotes(selfPeer(agent, agentPid, selfId));
  return notes.length ? { ...result, text: `${result.text}\n\n${notes.join('\n')}` } : result;
}

server.registerTool(
  'list_peers',
  {
    title: TOOLS.list_peers.title,
    description: TOOLS.list_peers.description,
    inputSchema: z.object(TOOLS.list_peers.args),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (_args, ctx) => {
    const selfId = selfIdFor(ctx.mcpReq._meta);
    return text(withSetupNotes(selfId, listPeersTool(selfPeer(agent, agentPid, selfId))));
  },
);

server.registerTool(
  'send_message',
  {
    title: TOOLS.send_message.title,
    description: TOOLS.send_message.description,
    inputSchema: z.object(TOOLS.send_message.args),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ to, message }, ctx) => {
    const selfId = selfIdFor(ctx.mcpReq._meta);
    return text(withSetupNotes(selfId, await sendMessageTool(selfPeer(agent, agentPid, selfId), to, message)));
  },
);

server.registerTool(
  'read_messages',
  {
    title: TOOLS.read_messages.title,
    description: TOOLS.read_messages.description,
    inputSchema: z.object(TOOLS.read_messages.args),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ id, limit }, ctx) => {
    const selfId = selfIdFor(ctx.mcpReq._meta);
    if (agent === 'codex') {
      const session = readSession(selfId);
      if (session?.sessionId) await withdrawFromCodexQueue(selfId, session.sessionId, session.codexHome);
    }
    return text(withSetupNotes(selfId, readMessagesTool(selfId, { id, limit })));
  },
);

await server.connect(new StdioServerTransport());
