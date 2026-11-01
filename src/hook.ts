import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSocketArmed, crossSessionInbound, readClaudeSocket, recordClaudeSocket } from './core/claude-socket.ts';
import { withdrawFromCodexQueue } from './core/codex-queue.ts';
import { debugLog } from './core/debug.ts';
import { trackTouchedFiles } from './core/edits.ts';
import { beginToolCall, endToolCall } from './core/confirm.ts';
import { sendMessage } from './core/deliver.ts';
import { unrefWakeTimers } from './core/wake.ts';
import { guideText } from './core/guide.ts';
import { listAgentsRow } from './core/listing.ts';
import { claimInbox, formatForContext } from './core/messages.ts';
import { isRemoteAddress, remoteListings } from './bridge/remote.ts';
import { noteTag } from './core/tags.ts';
import { peerDir, readJson, writeJsonAtomic } from './core/paths.ts';
import { AGENT_ALTERNATION } from './core/agents.ts';
import {
  agentLabel,
  defaultCodexHome,
  listPeers,
  markToolHook,
  peerId,
  peerRef,
  readPeer,
  readSession,
  isDeliveryOwner,
  linkedPeerId,
  copilotEventsFile,
  registerSession,
  registerStableName,
  selfPeer,
  sessionPeerId,
} from './core/peers.ts';
import { type Agent, findAgent, isStreamJsonClaude, parseAgent } from './core/proc.ts';
import { statusFromHooks, writeStatus } from './core/status.ts';
import { scheduleAutoUpdate } from './auto-update.ts';
import { argvFlag } from './core/argv.ts';
import { antigravitySurface, expandHomePath, type AntigravitySurface } from './core/antigravity.ts';

/**
 * Hook entry point, shared by every agent with command hooks:
 *   node hook.mjs --agent <agent> <action> [<the agent's event name>]
 * Actions:
 *   session-start   record the session so peers can address it
 *   inbox           before a prompt or after a tool call: hand pending messages to the model as context
 *   turn-end        when a turn ends: keep going with pending messages instead of stopping
 *   files           after a tool call (Claude Code): note when it read or edited files another session is editing
 *   status waiting  a permission prompt is waiting for the user (Codex PermissionRequest, Gemini Notification)
 *   list-agents, send-message   Claude Code's ListAgents and SendMessage; send-message also takes Qwen's send_message
 * Reads the hook's JSON input from stdin; prints output only when there is something to say.
 */

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_input?: { to?: unknown; message?: unknown };
  tool_response?: unknown;
  [field: string]: unknown;
}

const firstString = (input: HookInput, fields: string[]): string | undefined =>
  fields.map((f) => input[f]).find((v): v is string => typeof v === 'string' && v.length > 0);

/** Harness session ids that live in the environment when the hook payload omits them. */
const SESSION_ENV: Partial<Record<Agent, string>> = {
  // Copilot CLI exports this for the running session. See agents.ts.
  copilot: 'COPILOT_AGENT_SESSION_ID',
};

/** Agents that put the project directory in an environment variable rather than in the hook input. */
const PROJECT_DIR_ENV: Partial<Record<Agent, string>> = {
  devin: 'DEVIN_PROJECT_DIR',
  cursor: 'CURSOR_PROJECT_DIR',
  copilot: 'COPILOT_PROJECT_DIR',
  grok: 'GROK_WORKSPACE_ROOT',
  qwen: 'QWEN_PROJECT_DIR',
};

/** Agents name the same hook inputs differently (`session_id`, `sessionId`, `conversationId`…). */
function sessionOf(agent: Agent, input: HookInput): { sessionId?: string; cwd?: string } {
  const firstOf = (value: unknown) => (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined);
  const envName = PROJECT_DIR_ENV[agent];
  const envSession = SESSION_ENV[agent] ? process.env[SESSION_ENV[agent]]?.trim() : undefined;
  return {
    sessionId: firstString(input, ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId']) ?? (envSession || undefined),
    cwd:
      firstString(input, ['cwd', 'workspaceRoot', 'project_dir', 'projectDir']) ??
      firstOf(input.workspace_roots) ??
      firstOf(input.workspacePaths) ??
      (envName ? process.env[envName] : undefined),
  };
}

/** The session a hook runs for: `<agent>-<session id>` once the harness names one, otherwise `<agent>-<pid>`. */
const idOf = (agent: Agent, agentPid: number, input: HookInput) => sessionPeerId(agent, agentPid, sessionOf(agent, input).sessionId);

async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? (JSON.parse(raw) as HookInput) : {};
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

const HOST_PROMPT = (id: string) => path.join(peerDir(id), 'host-prompt.json');
const MESSAGE_MARKER = /telepathy-id:(m-[0-9a-z]+-[0-9a-f]+)/g;

/** Ids the ACP host already placed in this prompt. Copilot's userPromptSubmitted hook must not claim them. */
function promptMessageIds(input: HookInput): Set<string> {
  const ids = new Set<string>();
  const raw = JSON.stringify(input);
  for (const match of raw.matchAll(MESSAGE_MARKER)) ids.add(match[1]);
  return ids;
}

function rememberHostPrompt(peerId: string, ids: Set<string>): void {
  writeJsonAtomic(HOST_PROMPT(peerId), { ids: [...ids] });
}

function takeHostPrompt(peerId: string): Set<string> | undefined {
  const file = HOST_PROMPT(peerId);
  const ids = readJson<{ ids?: unknown }>(file)?.ids;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // already gone
  }
  if (!Array.isArray(ids)) return undefined;
  return new Set(ids.filter((id): id is string => typeof id === 'string'));
}

/** What a hook hands back: stdout, and for agents that read it, stderr plus an exit code. */
interface HookReply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const json = (value: unknown): HookReply => ({ stdout: JSON.stringify(value) });
const hookSpecificContext = (text: string, event: string) =>
  json({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
const blockStop = (text: string) => json({ decision: 'block', reason: text });

/**
 * How each agent's hooks hand text to the model: as context for the next model call, as the prompt that
 * continues a turn that was about to end, and (for agents that don't show MCP server instructions) as the
 * guide at session start.
 */
interface HookShape {
  context: (text: string, event: string) => HookReply;
  turnEnd: (text: string) => HookReply;
  sessionStart?: (text: string) => HookReply;
}

const SHAPES: Partial<Record<Agent, HookShape>> = {
  claude: { context: hookSpecificContext, turnEnd: blockStop },
  // Codex has no turn-end hook here: its queue starts a turn with anything still unread once the turn ends.
  codex: { context: hookSpecificContext, turnEnd: blockStop },
  qwen: { context: hookSpecificContext, turnEnd: blockStop },
  devin: { context: hookSpecificContext, turnEnd: blockStop },
  grok: { context: hookSpecificContext, turnEnd: blockStop },
  copilot: {
    context: (text) => json({ additionalContext: text }),
    turnEnd: blockStop,
    sessionStart: (text) => json({ additionalContext: text }),
  },
  cursor: {
    context: (text) => json({ additional_context: text }),
    turnEnd: (text) => json({ followup_message: text }),
    sessionStart: (text) => json({ additional_context: text }),
  },
  antigravity: {
    context: (text) => json({ injectSteps: [{ userMessage: text }] }),
    turnEnd: (text) => json({ decision: 'continue', reason: text }),
    sessionStart: (text) => json({ injectSteps: [{ systemMessage: { systemMessage: text } }] }),
  },
  // Kimi Code adds a UserPromptSubmit hook's plain stdout to the context; a Stop hook continues on exit code 2.
  kimi: { context: (text) => ({ stdout: text }), turnEnd: (text) => ({ stderr: text, exitCode: 2 }) },
};

function reply(r: HookReply | undefined): void {
  if (!r) return;
  if (r.stdout) process.stdout.write(r.stdout + '\n');
  if (r.stderr) process.stderr.write(r.stderr + '\n');
  if (r.exitCode !== undefined) process.exitCode = r.exitCode;
}

/**
 * SessionStart: record which session/thread this agent process is running, so peers can address it. Prints
 * nothing unless the agent can't show MCP server instructions: agents add this hook's output to the context.
 */
/** Where this Copilot process writes `events.jsonl`. The sender cannot see `COPILOT_HOME`. */
function copilotSessionFields(sessionId: string | undefined): { transcriptPath?: string } {
  if (!sessionId) return {};
  return { transcriptPath: copilotEventsFile(sessionId) };
}

function sessionStart(agent: Agent, agentPid: number, input: HookInput): void {
  // Detached, and a no-op when a check already ran today. Never delays this hook's reply.
  scheduleAutoUpdate('session-start');
  const id = idOf(agent, agentPid, input);
  const session = sessionOf(agent, input);
  registerSession(agent, agentPid, {
    ...session,
    source: 'hook',
    codexHome: agent === 'codex' ? defaultCodexHome() : undefined,
    ...(agent === 'antigravity' ? antigravitySessionFields(input) : {}),
    ...(agent === 'copilot' ? copilotSessionFields(session.sessionId) : {}),
  });
  registerStableName(agent, id);
  if (agent === 'claude' && isDeliveryOwner(id, agentPid)) recordClaudeSocket(id, process.env, agentPid);
  if (statusFromHooks(agent)) writeStatus(id, 'idle');
  reply(SHAPES[agent]?.sessionStart?.(guideText(agent)));
}

/** Antigravity's transcript path names the surface and the file confirm searches. */
function antigravitySessionFields(input: HookInput): { surface?: AntigravitySurface; transcriptPath?: string } {
  const raw = firstString(input, ['transcriptPath', 'transcript_path']);
  if (!raw) return {};
  const transcriptPath = expandHomePath(raw);
  const surface = antigravitySurface(transcriptPath);
  return { transcriptPath, ...(surface ? { surface } : {}) };
}

/**
 * Keeps the registration current from any hook. `/clear`, `--conversation`, or `/fork` can switch the
 * conversation in the same process. A new Antigravity conversation id (a `/fork`) is a new peer; the same
 * id (a `--conversation` resume) keeps the peer and its name.
 */
function refreshSession(agent: Agent, agentPid: number, input: HookInput): void {
  const { sessionId, cwd } = sessionOf(agent, input);
  const existing = readSession(idOf(agent, agentPid, input));
  // A Codex thread's record also names the process hosting it, which changes when Codex updates its daemon.
  const sameHost = existing?.pid === agentPid;
  registerStableName(agent, idOf(agent, agentPid, input));
  if (agent === 'claude' && isDeliveryOwner(idOf(agent, agentPid, input), agentPid)) {
    recordClaudeSocket(idOf(agent, agentPid, input), process.env, agentPid);
  }
  const extra =
    agent === 'antigravity'
      ? antigravitySessionFields(input)
      : agent === 'copilot'
        ? copilotSessionFields(sessionId ?? existing?.sessionId)
        : {};
  if (
    existing?.source === 'hook' &&
    sameHost &&
    (!sessionId || existing.sessionId === sessionId) &&
    (existing.cwd || !cwd) &&
    (!extra.transcriptPath || existing.transcriptPath === extra.transcriptPath)
  ) {
    return;
  }
  registerSession(agent, agentPid, {
    sessionId: sessionId ?? existing?.sessionId,
    cwd: cwd ?? existing?.cwd,
    source: 'hook',
    codexHome: agent === 'codex' ? defaultCodexHome() : undefined,
    ...extra,
  });
}

/**
 * Whether something else is already delivering this session's messages: Claude's plugin monitor, the monitor
 * Grok Build starts, or a Grok Bot wait_for_messages call. Then the hooks stay out of its way.
 */
const hasListener = (selfId: string) => readPeer(selfId)?.hasListener ?? false;

/**
 * The socket watcher is the delivery path when a post can be confirmed. hold and refuse are not posted, so the
 * hooks stay the path that can still be withdrawn. A recorded socket is enough: the monitor exits when the
 * session exported one, and must not be what keeps the hooks quiet.
 */
function socketOwnsDelivery(selfId: string): boolean {
  if (!readClaudeSocket(selfId) && !claudeSocketArmed(selfId)) return false;
  const inbound = crossSessionInbound(readPeer(selfId));
  return inbound !== 'hold' && inbound !== 'refuse';
}

/**
 * A Claude Code session driven over stream-json (the Claude app) runs no plugin monitor, so it keeps a one-shot
 * waiter running as a background command instead: the waiter exits when a message arrives, and its completion
 * wakes the session. Returns the reminder to start it, when this is such a session and no waiter is running.
 */
function waiterReminder(agent: Agent, agentPid: number): string | undefined {
  // A stream-json session with an inbox socket is woken by the post. The Bash waiter is for a host that has neither.
  if (agent !== 'claude' || !isStreamJsonClaude(agentPid) || process.env.CLAUDE_CODE_MESSAGING_SOCKET) return undefined;
  const waiter = `node "${path.join(path.dirname(fileURLToPath(import.meta.url)), 'monitor.mjs')}" --agent claude --once`;
  return noteTag(
    'wake',
    "This session can't run telepathy's monitor, so messages from other agent sessions can't wake it " +
      `yet. Start the waiter now with your Bash tool in the background (run_in_background: true): ${waiter}. It exits ` +
      'when a message arrives, which wakes you; after handling the message, start it again the same way.',
  );
}

/**
 * After a tool call: records the files it edited, and returns a note when it read or edited files another live
 * session edited recently. Agents name the tool and its arguments differently (`tool_name`/`tool_input`, Copilot's
 * `toolName`/`toolArgs`); a hook input without them (a prompt, a turn end) touched no files.
 */
function touchedFilesNote(agent: Agent, agentPid: number, input: HookInput): string | undefined {
  const toolName = input.tool_name ?? input.toolName;
  if (toolName === undefined) return undefined;
  const selfId = idOf(agent, agentPid, input);
  const cwd = sessionOf(agent, input).cwd ?? readSession(selfId)?.cwd;
  try {
    const note = trackTouchedFiles({ id: selfId, agent }, toolName, input.tool_input ?? input.toolArgs ?? input.tool_args, cwd);
    if (note) debugLog('hook', `${agent} ${String(toolName)}: overlap note`);
    return note;
  } catch (err) {
    debugLog('hook', `file tracking failed: ${(err as Error).message}`); // never at the cost of delivering messages
    return undefined;
  }
}

/** Claude PostToolUse on its file, search and Bash tools: the monitor delivers Claude's messages, so this only tracks files. */
function files(agent: Agent, agentPid: number, input: HookInput): void {
  const note = touchedFilesNote(agent, agentPid, input);
  if (note) reply(hookSpecificContext(note, 'PostToolUse'));
}

/** Before a prompt or after a tool call: pending messages (and a note on files another session is editing) go into the model's context. */
async function inbox(agent: Agent, agentPid: number, input: HookInput, event: string): Promise<void> {
  const shape = SHAPES[agent];
  if (!shape) return;
  refreshSession(agent, agentPid, input);
  const selfId = idOf(agent, agentPid, input);
  // A second live process on this session (a fork, or the session open twice) must not also inject the inbox.
  if (!isDeliveryOwner(selfId, agentPid)) {
    debugLog('hook', `${selfId} pid ${agentPid} is not the delivery owner`);
    return;
  }
  // A prompt or a tool call means a turn is running; for Codex it also ends a permission prompt that was answered.
  if (statusFromHooks(agent) || agent === 'codex') writeStatus(selfId, 'busy');
  const overlap = touchedFilesNote(agent, agentPid, input);
  // Qwen's list_agents shows its own sessions. A hook can't rewrite that result, so the rest follows as context.
  const listing =
    agent === 'qwen' && /PostToolUse/i.test(event) && input.tool_name === NATIVE_TOOLS.qwen?.list
      ? nativeListingBlock('qwen', selfId)
      : undefined;
  if (hasListener(selfId) || socketOwnsDelivery(selfId)) {
    const parts = [listing ?? '', overlap ?? ''].filter(Boolean);
    if (parts.length) reply(shape.context(parts.join('\n\n'), event));
    return;
  }
  if (agent === 'codex') {
    // Senders can then say a busy Codex gets messages after its next tool call, not only at the end of the turn.
    if (event === 'PostToolUse') markToolHook(selfId);
    const session = readSession(selfId);
    if (session?.sessionId) await withdrawFromCodexQueue(selfId, session.sessionId, session.codexHome);
  }
  const hostInjected = agent === 'copilot' && /userPromptSubmitted/i.test(event) ? promptMessageIds(input) : undefined;
  if (hostInjected?.size) rememberHostPrompt(selfId, hostInjected);
  const messages = claimInbox(selfId, hostInjected);
  if (messages.length) debugLog('hook', `${agent} ${event}: delivered ${messages.map((m) => m.id).join(', ')}`);
  const parts = [listing ?? '', messages.length ? formatForContext(messages) : '', overlap ?? '', waiterReminder(agent, agentPid) ?? ''].filter(Boolean);
  if (parts.length) reply(shape.context(parts.join('\n\n'), event));
}

/** Whether the turn ended on its own, rather than by an interrupt, an error or the agent shutting down. */
function endedNormally(input: HookInput): boolean {
  if (typeof input.status === 'string' && input.status !== 'completed') return false; // Cursor
  const reason = firstString(input, ['reason', 'stopReason', 'terminationReason']);
  return !reason || !/shutdown|closed|abort|interrupt|cancel|error/i.test(reason);
}

/**
 * When a turn ends: if messages arrived meanwhile, the turn goes on with them. Claiming archives them, so the
 * next turn end finds the inbox empty and lets the agent stop; that, not `stop_hook_active`, prevents loops.
 */
function turnEnd(agent: Agent, agentPid: number, input: HookInput): void {
  const shape = SHAPES[agent];
  if (!shape) return;
  refreshSession(agent, agentPid, input);
  const selfId = idOf(agent, agentPid, input);
  if (!isDeliveryOwner(selfId, agentPid)) return;
  const tracked = statusFromHooks(agent);
  if (tracked) writeStatus(selfId, 'idle');
  // Taken even when the turn did not end cleanly, so the next prompt can claim a copy the host did not archive.
  const hostInjected = agent === 'copilot' ? takeHostPrompt(selfId) : undefined;
  if (!endedNormally(input) || hasListener(selfId) || socketOwnsDelivery(selfId)) return;
  const messages = claimInbox(selfId, hostInjected);
  if (messages.length) {
    if (tracked) writeStatus(selfId, 'busy'); // the turn goes on with the messages
    debugLog('hook', `${agent} turn end: delivered ${messages.map((m) => m.id).join(', ')}`);
    reply(shape.turnEnd([formatForContext(messages), waiterReminder(agent, agentPid)].filter(Boolean).join('\n\n')));
    return;
  }
  // Don't go idle without the waiter, but ask only once per stop: if it can't be started, let the turn end.
  const reminder = input.stop_hook_active === true ? undefined : waiterReminder(agent, agentPid);
  if (reminder) reply(shape.turnEnd(reminder));
}

/**
 * A permission prompt is waiting for the user: Codex's PermissionRequest hook. Prints nothing: a PermissionRequest
 * hook's output could answer the prompt, and that is the user's call alone.
 */
function waiting(agent: Agent, agentPid: number, input: HookInput): void {
  const type = input.notification_type;
  if (typeof type === 'string' && type !== 'ToolPermission') return;
  writeStatus(idOf(agent, agentPid, input), 'waiting');
}

/** What each harness calls its own listing and send tools, and which sessions that listing already shows. */
const NATIVE_TOOLS: Partial<Record<Agent, { list: string; send: string }>> = {
  claude: { list: 'ListAgents', send: 'SendMessage' },
  qwen: { list: 'list_agents', send: 'send_message' },
};

/**
 * The sessions a harness's own agent listing does not show: other agents' sessions here, and every session on
 * another device. Claude's ListAgents and Qwen's list_agents already list their own harness's sessions here.
 */
function nativeListingBlock(agent: Agent, selfId: string): string | undefined {
  const tools = NATIVE_TOOLS[agent];
  if (!tools) return undefined;
  const others = listPeers().filter((p) => p.id !== selfId && p.agent !== agent);
  const remote = remoteListings().filter((listing) => listing.online && listing.peers.length);
  if (!others.length && !remote.length) return undefined;
  const sections: string[] = [];
  if (others.length) {
    sections.push(
      [
        `Other agents' sessions (${others.length}), reachable through the telepathy plugin with send_message ` +
          `(${tools.send} only reaches ${agentLabel(agent)} sessions; a ${tools.send} to one of these is delivered by telepathy, stopped, and shows an error):`,
        ...others.map((p) => listAgentsRow(p)),
      ].join('\n'),
    );
  }
  for (const { device, peers } of remote) {
    sections.push(
      [
        `Sessions on device ${device.slug} (${peers.length}), reachable through the telepathy bridge with send_message:`,
        ...peers.map(({ peer, status }) => `  ${peerRef(peer)}  ·  interactive${status ? `  ·  ${status}` : ''}`),
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}

/**
 * Claude PostToolUse on ListAgents: the built-in listing only shows Claude sessions, so add the other
 * agents' sessions to it, as rows in ListAgents' own shape. ListAgents returns `{ listing: string }`; if that
 * ever changes, a rewrite would be ignored, so fall back to a note next to the result.
 */
function listAgents(agentPid: number, input: HookInput): void {
  const block = nativeListingBlock('claude', peerId('claude', agentPid));
  if (!block) return;
  const response = input.tool_response as { listing?: unknown } | undefined;
  if (typeof response?.listing === 'string') {
    const listing = `${response.listing.trimEnd()}\n\n${block}`;
    print({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, listing } } });
    return;
  }
  print({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: block } });
}

/** Addresses another harness's sessions can have: `codex:…`, a `[codex-…]` ref, or a live session's exact ref. */
function otherAgentPatterns(agent: Agent) {
  const others = AGENT_ALTERNATION.split('|')
    .filter((a) => a !== agent)
    .join('|');
  return {
    prefix: new RegExp(`^\\s*["'\`]?(${others}):`, 'i'),
    bracketRef: new RegExp(`\\[\\s*(${others})-[a-z0-9][a-z0-9_-]*\\s*\\]\\s*$`, 'i'),
    ref: new RegExp(`^(${others})-[a-z0-9][a-z0-9_-]*$`),
  };
}

/**
 * Only addresses that can't name one of the harness's own sessions count as ours: another agent's namespace
 * (`codex:`), a `[codex-<pid>]` ref (Claude's refs are hex), the exact ref of a live session of another agent,
 * or a session on another device. A bare name, or one merely starting with "codex-", may be one of the harness's
 * own sessions (Claude names sessions after their folder), so it is left to the native tool. Qwen's own
 * destination names never have a `qwen:` prefix, so for Qwen that prefix is ours too.
 */
function addressedToOtherAgent(agent: Agent, to: string): boolean {
  const patterns = otherAgentPatterns(agent);
  if (patterns.prefix.test(to) || patterns.bracketRef.test(to)) return true;
  if (agent === 'qwen' && /^\s*["'`]?qwen:/i.test(to)) return true;
  // A session on another device, the harness's own included, is only reachable through the bridge.
  if (isRemoteAddress(to)) return true;
  const ref = to.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase();
  return patterns.ref.test(ref) && listPeers().some((p) => p.agent !== agent && p.id === ref);
}

/**
 * PreToolUse on the harness's own send tool (Claude's SendMessage, Qwen's send_message): it only reaches its
 * own harness's sessions, so a message addressed to another agent's session is delivered here instead, and the
 * native call is stopped with a reason saying so. Deny is the only decision that stops it, so it shows as an error.
 */
async function interceptSendMessage(agent: Agent, agentPid: number, input: HookInput): Promise<void> {
  const tools = NATIVE_TOOLS[agent];
  if (!tools) return;
  if (typeof input.tool_name === 'string' && input.tool_name !== tools.send) return;
  const to = input.tool_input?.to;
  if (typeof to !== 'string' || !addressedToOtherAgent(agent, to)) return; // not ours: let the native tool run
  const message = typeof input.tool_input?.message === 'string' ? input.tool_input.message : '';
  const deny = (reason: string) =>
    print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

  if (!message.trim()) {
    deny('Not sent: sessions of other agents only accept messages with text; notify_when_idle subscriptions are not supported for them.');
    return;
  }
  const fromInput = idOf(agent, agentPid, input);
  const bound = fromInput !== peerId(agent, agentPid) ? fromInput : (linkedPeerId(agent, agentPid) ?? fromInput);
  const ownsClock = beginToolCall();
  let result: Awaited<ReturnType<typeof sendMessage>>;
  try {
    result = await sendMessage(selfPeer(agent, agentPid, bound), to, message);
  } finally {
    if (ownsClock) endToolCall();
  }
  debugLog('hook', result.ok ? `${tools.send} → ${result.recipient.id}` : `${tools.send} failed: ${result.error}`);
  deny(
    result.ok
      ? `${result.status} (Sent by telepathy: ${tools.send} can't reach ${agentLabel(result.recipient.agent)}, so this ` +
          "shows as an error. Don't resend.)"
      : `Not delivered: ${result.error}`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--telepathy-auto-update')) {
    const { runAutoUpdate } = await import('./auto-update.ts');
    await runAutoUpdate();
    return;
  }
  // Printing the hook result must not wait for a webhook. The session's server posts the batch.
  unrefWakeTimers();
  const argv = process.argv.slice(2);
  const agentIndex = argv.indexOf('--agent');
  const [action, event] = argv.filter((_, i) => agentIndex < 0 || (i !== agentIndex && i !== agentIndex + 1));
  const input = await readStdin();
  const { agent, pid: agentPid } = findAgent(parseAgent(argvFlag(argv, '--agent')));
  debugLog('hook', `${agent} ${action}${event ? ` ${event}` : ''} (agent pid ${agentPid})`);

  if (action === 'session-start') sessionStart(agent, agentPid, input);
  else if (action === 'inbox') await inbox(agent, agentPid, input, event ?? 'PostToolUse');
  else if (action === 'turn-end') turnEnd(agent, agentPid, input);
  else if (action === 'files') files(agent, agentPid, input);
  else if (action === 'status' && event === 'waiting') waiting(agent, agentPid, input);
  else if (action === 'list-agents' && agent === 'claude') listAgents(agentPid, input);
  else if (action === 'send-message') await interceptSendMessage(agent, agentPid, input);
  else throw new Error(`unknown hook action ${JSON.stringify(action)} for ${agent}`);
}

main().catch((err) => {
  // A broken hook must never block the agent: report on stderr and exit 0.
  process.stderr.write(`telepathy hook: ${(err as Error).message}\n`);
  debugLog('hook', `error: ${(err as Error).stack}`);
});
