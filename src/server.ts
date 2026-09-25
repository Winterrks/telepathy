import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { withdrawFromCodexQueue } from './core/codex-queue.ts';
import { debugLog } from './core/debug.ts';
import { setupNotes } from './core/setup.ts';
import { guideText } from './core/guide.ts';
import { defaultCodexHome, peerId, readSession, registerPresence, registerSession, selfPeer } from './core/peers.ts';
import { findAgent, isStreamJsonClaude, parseAgent } from './core/proc.ts';
import { listPeersTool, readMessagesTool, sendMessageTool, TOOLS, type ToolResult } from './core/tools.ts';
import { VERSION } from './core/version.ts';

const argv = process.argv.slice(2);
const { agent, pid: agentPid } = findAgent(parseAgent(argv[argv.indexOf('--agent') + 1]));
const selfId = peerId(agent, agentPid);

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
  return agent === 'claude' && isStreamJsonClaude(agentPid);
}

registerPresence(agent, agentPid, {
  cwd: sessionCwd(),
  codexHome: agent === 'codex' ? defaultCodexHome() : undefined,
});
debugLog('server', `started for ${selfId}`);

/**
 * Codex sends the thread id in the `_meta` of every tool call. The SessionStart hook is the primary source
 * (it registers the session before any tool runs); this covers sessions where the hook isn't approved yet.
 */
function learnCodexThread(meta: Record<string, unknown> | undefined): void {
  if (agent !== 'codex' || !meta) return;
  const id = [meta.sessionId, meta.threadId].find((v): v is string => typeof v === 'string' && v.length > 0);
  if (!id) return;
  const existing = readSession(selfId);
  if (existing?.source === 'hook' || existing?.sessionId === id) return;
  registerSession(agent, agentPid, { sessionId: id, cwd: existing?.cwd, source: 'meta', codexHome: defaultCodexHome() });
  debugLog('server', `learned codex thread ${id} from tool-call _meta (keys: ${Object.keys(meta).join(',')})`);
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

const text = ({ text, isError }: ToolResult) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const NOTE_EVERY_MS = 10 * 60_000;
const noteShownAt = new Map<string, number>();

/**
 * Adds `[telepathy setup]` notes: things the user has to fix before messages reach this session on time.
 * read_messages always shows them (an agent calls it when messages seem not to arrive); the other tools at most
 * every ten minutes per note.
 */
function withSetupNotes(result: ToolResult, always = false): ToolResult {
  const now = Date.now();
  const notes = setupNotes(selfPeer(agent, agentPid)).filter((note) => always || now - (noteShownAt.get(note) ?? 0) > NOTE_EVERY_MS);
  for (const note of notes) noteShownAt.set(note, now);
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
    learnCodexThread(ctx.mcpReq._meta);
    return text(withSetupNotes(listPeersTool(selfPeer(agent, agentPid))));
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
    learnCodexThread(ctx.mcpReq._meta);
    return text(withSetupNotes(await sendMessageTool(selfPeer(agent, agentPid), to, message)));
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
    learnCodexThread(ctx.mcpReq._meta);
    if (agent === 'codex') {
      const session = readSession(selfId);
      if (session?.sessionId) await withdrawFromCodexQueue(selfId, session.sessionId, session.codexHome);
    }
    return text(withSetupNotes(readMessagesTool(selfId, { id, limit }), true));
  },
);

await server.connect(new StdioServerTransport());
