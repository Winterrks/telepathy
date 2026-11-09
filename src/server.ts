import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { withdrawFromCodexQueue } from './core/codex-queue.ts';
import { beginToolCall, endToolCall } from './core/confirm.ts';
import { debugLog } from './core/debug.ts';
import { unseenSetupNotes } from './core/setup.ts';
import { guideText } from './core/guide.ts';
import { recordClaudeSocket, startClaudeSocketWatcher } from './core/claude-socket.ts';
import { waitForInbox } from './core/inbox-wait.ts';
import { startWakeFlusher } from './core/wake.ts';
import {
  clearListener,
  codexThreadsOf,
  defaultCodexHome,
  isDeliveryOwner,
  linkedPeerId,
  listenerPid,
  type Peer,
  peerId,
  readPeer,
  readSession,
  registerListener,
  registerPresence,
  registerSession,
  registerStableName,
  selfPeer,
  sessionPeerId,
} from './core/peers.ts';
import { argvFlag } from './core/argv.ts';
import { claimResumedCopilot } from './core/copilot-resume.ts';
import { findAgent, isStreamJsonClaude, parseAgent, procStart } from './core/proc.ts';
import {
  ALREADY_LISTENING,
  DEFAULT_WAIT_MS,
  formatWaitResult,
  listPeersTool,
  readMessagesTool,
  sendMessageTool,
  TOOLS,
  type ToolResult,
} from './core/tools.ts';
import { attachGrokDelivery } from './grok-delivery.ts';
import { answerPermissionTool, findChild, setPermissionModeTool, startAgentTool, stopAgentTool } from './agent/tools.ts';
import { answerRemotePermission, findRemoteChild, setRemotePermissionMode, startRemoteAgentTool, stopRemoteAgentTool } from './agent/remote.ts';
import { installedTaskHarnesses } from './agent/task.ts';
import { answerTaskRequest, clientTakesTasks, continueAgentTask, openFollowTask, startAgentTask } from './agent/mcp-tasks.ts';
import { VERSION } from './core/version.ts';
import { scheduleAutoUpdate } from './auto-update.ts';

/**
 * The plugin MCP server. The standalone `server.mjs` bundle calls this immediately. The `telepathy` CLI
 * calls it only for `telepathy mcp`, so importing this module does not take over stdio.
 */
export async function startMcpServer(): Promise<void> {
// A process telepathy started without itself, such as a permission reviewer (src/agent/reviewer.ts): no session here.
if (process.env.TELEPATHY_DISABLED === '1') return;
const argv = process.argv.slice(2);
const flag = (name: string) => argvFlag(argv, name);
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

// A Codex session goes by its thread. This server learns that thread from a tool call (see selfIdFor) and does
// not register the daemon pid: one daemon hosts every thread. A TUI that has not been prompted yet is listed
// from the process table until a thread id exists (see observeLaunchedCodex).
// Any other harness is keyed by its session id once a hook has linked this process to one.
// A resumed plain Copilot has not run sessionStart yet. Claim that id now when argv, the
// session.resume event, and workspace.yaml agree; otherwise stay on the pid until the hook.
function boundId(): string {
  return linkedPeerId(agent, agentPid) ?? peerId(agent, agentPid);
}
let copilotResumeSettled = agent !== 'copilot';
const copilotResumeUntil = Date.now() + 60_000;
function pollCopilotResume(): void {
  if (copilotResumeSettled || agent !== 'copilot') return;
  const look = claimResumedCopilot(agentPid, { cwd: sessionCwd() });
  if (look.state === 'claimed') debugLog('server', `claimed resumed copilot ${look.sessionId}`);
  if (look.state !== 'pending') copilotResumeSettled = true;
}
pollCopilotResume();
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
  if (!copilotResumeSettled && Date.now() < copilotResumeUntil) pollCopilotResume();
  else copilotResumeSettled = true;
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
// A version check, at most once a day, in a detached process. It must not delay this server's handshake.
scheduleAutoUpdate('server');
// A connected Grok Bot's host does not survive a reboot. Any session's server brings it back.
void import('./grokbot/cli.ts').then((m) => m.ensureGrokbotHosts()).catch(() => {});

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

const ownProcStart = procStart(process.pid);

/**
 * In Claude Code's terminal, a call about an agent whose working turn no task follows (its task was lost when this
 * server restarted under a plugin update) answers with a task that follows it again; see openFollowTask.
 */
async function followAgain(self: Peer, name: string, ctx: unknown, act: () => ToolResult | Promise<ToolResult>) {
  const follow = agent === 'claude' && clientTakesTasks(ctx) ? await openFollowTask(self, name, ownProcStart) : undefined;
  const done = await act();
  if (!follow) return text(done);
  if (done.isError) {
    follow.cancel();
    return text(done);
  }
  return follow.answer(done.text) as unknown as ReturnType<typeof text>;
}
const text = ({ text, isError, structured }: ToolResult) => ({
  content: [{ type: 'text' as const, text }],
  ...(structured ? { structuredContent: structured } : {}),
  ...(isError ? { isError } : {}),
});

/**
 * Adds `<telepathy-note kind="setup">` notes the first time this session would show each one. A later tool call, including
 * from a new server process, does not repeat a note it has already shown.
 */
function withSetupNotes(selfId: string, result: ToolResult): ToolResult {
  const notes = unseenSetupNotes(selfPeer(agent, agentPid, selfId));
  return notes.length ? { ...result, text: `${result.text}\n\n${notes.join('\n')}` } : result;
}

/**
 * The server and its tools. Claude Code's stdio connection may build one per protocol era it tries (see the end of
 * this function), so this has no side effects of its own.
 */
function buildServer(): McpServer {
const server = new McpServer(
  { name: 'telepathy', version: VERSION },
  {
    // Grok Bot has no host-owned wake. Logging and resource updates are a best-effort side channel;
    // wait_for_messages, registered below, is what actually returns the message.
    capabilities: agent === 'grok' ? { tools: {}, resources: { subscribe: true }, logging: {} } : { tools: {} },
    // Claude Code keeps these in its system prompt; Codex shows them with the tools. The full guide is the
    // using-telepathy skill, loaded on demand.
    instructions: guideText(agent, {
      monitorCommand: agent === 'grok' ? monitorCommand() : undefined,
      waiterCommand: claudeWithoutMonitor() ? `${monitorCommand()} --once` : undefined,
      taskHarnesses: agent === 'claude' ? installedTaskHarnesses() : undefined,
    }),
  },
);

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
    const ownsClock = beginToolCall();
    try {
      const selfId = selfIdFor(ctx.mcpReq._meta);
      if (agent === 'claude' && clientTakesTasks(ctx)) {
        // A follow-up to an agent this session started: its next report is the task's result.
        const task = await continueAgentTask(selfPeer(agent, agentPid, selfId), to, message, ownProcStart);
        if (task && 'resultType' in task) return task as unknown as ReturnType<typeof text>;
        if (task) return text(task);
      }
      return text(withSetupNotes(selfId, await sendMessageTool(selfPeer(agent, agentPid, selfId), to, message)));
    } finally {
      if (ownsClock) endToolCall();
    }
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

server.registerTool(
  'start_agent',
  {
    title: TOOLS.start_agent.title,
    description: TOOLS.start_agent.description,
    inputSchema: z.object(TOOLS.start_agent.args),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args, ctx) => {
    const selfId = selfIdFor(ctx.mcpReq._meta);
    if (agent === 'claude' && clientTakesTasks(ctx)) {
      // Claude Code follows it as a background task of its own: see src/agent/task.ts.
      const task = await startAgentTask(selfPeer(agent, agentPid, selfId), args, ownProcStart);
      return 'resultType' in task ? (task as unknown as ReturnType<typeof text>) : text(task);
    }
    const self = selfPeer(agent, agentPid, selfId);
    return text(args.device ? await startRemoteAgentTool(self, args.device, args) : await startAgentTool(self, args));
  },
);

server.registerTool(
  'stop_agent',
  {
    title: TOOLS.stop_agent.title,
    description: TOOLS.stop_agent.description,
    inputSchema: z.object(TOOLS.stop_agent.args),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ name }, ctx) => {
    const self = selfPeer(agent, agentPid, selfIdFor(ctx.mcpReq._meta));
    // One this session started on another device, when none here goes by that name.
    const elsewhere = 'error' in findChild(self, name) ? findRemoteChild(self, name) : undefined;
    return text(elsewhere ? await stopRemoteAgentTool(self, elsewhere) : await stopAgentTool(self, name));
  },
);

server.registerTool(
  'answer_permission',
  {
    title: TOOLS.answer_permission.title,
    description: TOOLS.answer_permission.description,
    inputSchema: z.object(TOOLS.answer_permission.args),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args, ctx) => {
    const self = selfPeer(agent, agentPid, selfIdFor(ctx.mcpReq._meta));
    const elsewhere = 'error' in findChild(self, args.agent) ? findRemoteChild(self, args.agent) : undefined;
    return followAgain(self, args.agent, ctx, () =>
      elsewhere ? answerRemotePermission(self, elsewhere, args.request, args.allow, args.always) : answerPermissionTool(self, args),
    );
  },
);

server.registerTool(
  'set_permission_mode',
  {
    title: TOOLS.set_permission_mode.title,
    description: TOOLS.set_permission_mode.description,
    inputSchema: z.object(TOOLS.set_permission_mode.args),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args, ctx) => {
    const self = selfPeer(agent, agentPid, selfIdFor(ctx.mcpReq._meta));
    const elsewhere = 'error' in findChild(self, args.agent) ? findRemoteChild(self, args.agent) : undefined;
    return followAgain(self, args.agent, ctx, () => (elsewhere ? setRemotePermissionMode(self, elsewhere, args) : setPermissionModeTool(self, args)));
  },
);

if (agent === 'grok') {
  // Overlapping waits share one listener registration. The last one to finish clears it.
  const waits = new Map<string, number>();
  const heldByOther = (selfId: string) => {
    const peer = readPeer(selfId);
    return !!peer?.hasListener && listenerPid(selfId) !== process.pid;
  };

  server.registerTool(
    'wait_for_messages',
    {
      title: TOOLS.wait_for_messages.title,
      description: TOOLS.wait_for_messages.description,
      inputSchema: z.object(TOOLS.wait_for_messages.args),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ timeoutMs }, ctx) => {
      const selfId = selfIdFor(ctx.mcpReq._meta);
      const timeout = timeoutMs ?? DEFAULT_WAIT_MS;
      if (heldByOther(selfId)) return text({ text: ALREADY_LISTENING });
      if (ctx.mcpReq.signal.aborted) return text(withSetupNotes(selfId, formatWaitResult([], 'cancelled', timeout)));

      const token = ctx.mcpReq._meta?.progressToken;
      const progressToken = typeof token === 'string' || typeof token === 'number' ? token : undefined;
      const started = Date.now();
      const tell = (message: string) => {
        if (progressToken === undefined) return Promise.resolve();
        return ctx.mcpReq
          .notify({ method: 'notifications/progress', params: { progressToken, progress: Date.now() - started, message } })
          .catch(() => undefined);
      };

      waits.set(selfId, (waits.get(selfId) ?? 0) + 1);
      registerListener(agent, agentPid, selfId);
      const progress = setInterval(() => {
        void tell(`Still waiting for telepathy messages (${Math.round((Date.now() - started) / 1000)}s).`);
      }, 10_000);
      progress.unref();
      await tell('Waiting for telepathy messages.');
      try {
        const result = await waitForInbox(selfId, timeout, ctx.mcpReq.signal);
        debugLog('server', `wait_for_messages ${result.reason} for ${selfId}: ${result.messages.length}`);
        return text(withSetupNotes(selfId, formatWaitResult(result.messages, result.reason, timeout)));
      } finally {
        clearInterval(progress);
        const left = (waits.get(selfId) ?? 1) - 1;
        if (left <= 0) {
          waits.delete(selfId);
          clearListener(selfId);
        } else {
          waits.set(selfId, left);
        }
      }
    },
  );

  attachGrokDelivery(server, boundId);
}
return server;
}

if (agent !== 'claude') {
  await buildServer().connect(new StdioServerTransport());
  return;
}
// Claude Code asks for protocol revision 2026-07-28, on which start_agent can answer with an MCP task. serveStdio
// settles the revision per connection. The SDK has no tasks/* methods on that revision, so they are answered here,
// ahead of it.
const wire = new StdioServerTransport();
serveStdio(buildServer, { transport: wire });
const sdkOnMessage = wire.onmessage;
wire.onmessage = (message) => {
  const request = message as { id?: string | number; method?: string; params?: Record<string, unknown> };
  const reply =
    request.id !== undefined && typeof request.method === 'string'
      ? answerTaskRequest(request.method, request.params, () => selfPeer(agent, agentPid, boundId()), ownProcStart)
      : undefined;
  if (!reply) return sdkOnMessage?.(message);
  void wire.send({ jsonrpc: '2.0', id: request.id!, ...(reply.error ? { error: reply.error } : { result: reply.result! }) } as never).catch(() => undefined);
};
// Agents don't stop with this server: a plugin reload restarts it mid-session. They stop when the session itself
// ends (the agent host watches it), and a restarted server takes their tasks up again (see adopt in mcp-tasks.ts).
}
