import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { debugLog } from './core/debug.ts';
import { guideText } from './core/guide.ts';
import { defaultCodexHome, peerId, readSession, registerPresence, registerSession, selfPeer } from './core/peers.ts';
import { findAgent, parseAgent } from './core/proc.ts';
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
    instructions: guideText(agent, { monitorCommand: agent === 'grok' ? monitorCommand() : undefined }),
  },
);

const text = ({ text, isError }: ToolResult) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

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
    return text(listPeersTool(selfPeer(agent, agentPid)));
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
    return text(await sendMessageTool(selfPeer(agent, agentPid), to, message));
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
    return text(readMessagesTool(selfId, { id, limit }));
  },
);

await server.connect(new StdioServerTransport());
