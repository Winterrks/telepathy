import { debugLog } from './core/debug.ts';
import { sendMessage } from './core/deliver.ts';
import { guideText } from './core/guide.ts';
import { listAgentsRow } from './core/listing.ts';
import { claimInbox, formatForContext } from './core/messages.ts';
import { AGENT_ALTERNATION } from './core/agents.ts';
import {
  agentLabel,
  defaultCodexHome,
  listPeers,
  peerId,
  readPeer,
  readSession,
  registerSession,
  selfPeer,
} from './core/peers.ts';
import { type Agent, findAgent, parseAgent } from './core/proc.ts';

/**
 * Hook entry point, shared by every agent with command hooks:
 *   node hook.mjs --agent <agent> <action> [<the agent's event name>]
 * Actions:
 *   session-start   record the session so peers can address it
 *   inbox           before a prompt or after a tool call: hand pending messages to the model as context
 *   turn-end        when a turn ends: keep going with pending messages instead of stopping
 *   list-agents, send-message   Claude Code's ListAgents and SendMessage
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

/** Agents that put the project directory in an environment variable rather than in the hook input. */
const PROJECT_DIR_ENV: Partial<Record<Agent, string>> = {
  devin: 'DEVIN_PROJECT_DIR',
  cursor: 'CURSOR_PROJECT_DIR',
  copilot: 'COPILOT_PROJECT_DIR',
  grok: 'GROK_WORKSPACE_ROOT',
  gemini: 'GEMINI_PROJECT_DIR',
  qwen: 'QWEN_PROJECT_DIR',
};

/** Agents name the same hook inputs differently (`session_id`, `sessionId`, `conversationId`…). */
function sessionOf(agent: Agent, input: HookInput): { sessionId?: string; cwd?: string } {
  const firstOf = (value: unknown) => (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined);
  const envName = PROJECT_DIR_ENV[agent];
  return {
    sessionId: firstString(input, ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId']),
    cwd:
      firstString(input, ['cwd', 'workspaceRoot', 'project_dir', 'projectDir']) ??
      firstOf(input.workspace_roots) ??
      firstOf(input.workspacePaths) ??
      (envName ? process.env[envName] : undefined),
  };
}

async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? (JSON.parse(raw) as HookInput) : {};
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

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
  gemini: { context: hookSpecificContext, turnEnd: blockStop },
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
function sessionStart(agent: Agent, agentPid: number, input: HookInput): void {
  registerSession(agent, agentPid, {
    ...sessionOf(agent, input),
    source: 'hook',
    codexHome: agent === 'codex' ? defaultCodexHome() : undefined,
  });
  reply(SHAPES[agent]?.sessionStart?.(guideText(agent)));
}

/**
 * Keeps the registration current from any hook: some agents have no session-start event (Antigravity), and
 * `/clear` or a resume can switch the session in the same process without one.
 */
function refreshSession(agent: Agent, agentPid: number, input: HookInput): void {
  const { sessionId, cwd } = sessionOf(agent, input);
  const existing = readSession(peerId(agent, agentPid));
  if (existing?.source === 'hook' && (!sessionId || existing.sessionId === sessionId) && (existing.cwd || !cwd)) return;
  registerSession(agent, agentPid, { sessionId: sessionId ?? existing?.sessionId, cwd: cwd ?? existing?.cwd, source: 'hook' });
}

/**
 * Whether something else already wakes this session with its messages: Claude's plugin monitor, or the monitor Grok
 * runs with its monitor tool. Then the hooks stay out of its way.
 */
const hasListener = (agent: Agent, agentPid: number) => readPeer(peerId(agent, agentPid))?.hasListener ?? false;

/** Before a prompt or after a tool call: pending messages go into the model's context. */
function inbox(agent: Agent, agentPid: number, input: HookInput, event: string): void {
  const shape = SHAPES[agent];
  if (!shape) return;
  refreshSession(agent, agentPid, input);
  if (hasListener(agent, agentPid)) return;
  const messages = claimInbox(peerId(agent, agentPid));
  if (!messages.length) return;
  debugLog('hook', `${agent} ${event}: delivered ${messages.map((m) => m.id).join(', ')}`);
  reply(shape.context(formatForContext(messages), event));
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
  if (!endedNormally(input) || hasListener(agent, agentPid)) return;
  const messages = claimInbox(peerId(agent, agentPid));
  if (!messages.length) return;
  debugLog('hook', `${agent} turn end: delivered ${messages.map((m) => m.id).join(', ')}`);
  reply(shape.turnEnd(formatForContext(messages)));
}

/**
 * Claude PostToolUse on ListAgents: the built-in listing only shows Claude sessions, so add the other
 * agents' sessions to it, as rows in ListAgents' own shape. ListAgents returns `{ listing: string }`; if that
 * ever changes, a rewrite would be ignored, so fall back to a note next to the result.
 */
function listAgents(agentPid: number, input: HookInput): void {
  const selfId = peerId('claude', agentPid);
  const others = listPeers().filter((p) => p.id !== selfId && p.agent !== 'claude');
  if (!others.length) return;
  const heading =
    `Other agents' sessions (${others.length}), reachable through the telepathy plugin with SendMessage or its ` +
    'send_message tool (SendMessage shows an error for these, but the message is delivered):';
  const block = [heading, ...others.map((p) => listAgentsRow(p))].join('\n');
  const response = input.tool_response as { listing?: unknown } | undefined;
  if (typeof response?.listing === 'string') {
    const listing = `${response.listing.trimEnd()}\n\n${block}`;
    print({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, listing } } });
    return;
  }
  print({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: block } });
}

const OTHER_AGENTS = AGENT_ALTERNATION.split('|')
  .filter((a) => a !== 'claude')
  .join('|');
const OTHER_PREFIX_RE = new RegExp(`^\\s*["'\`]?(${OTHER_AGENTS}):`, 'i');
const OTHER_BRACKET_REF_RE = new RegExp(`\\[\\s*(${OTHER_AGENTS})-[a-z0-9][a-z0-9_-]*\\s*\\]\\s*$`, 'i');
const OTHER_REF_RE = new RegExp(`^(${OTHER_AGENTS})-[a-z0-9][a-z0-9_-]*$`);

/**
 * Only addresses that can't name a Claude session count as ours: another agent's namespace (`codex:`), a
 * `[codex-<pid>]` ref (Claude's refs are hex), or the exact ref of a live session of another agent. A bare
 * name, or one merely starting with "codex-", may be a Claude session (Claude names sessions after their
 * folder), so it is left to SendMessage.
 */
function addressedToOtherAgent(to: string): boolean {
  if (OTHER_PREFIX_RE.test(to) || OTHER_BRACKET_REF_RE.test(to)) return true;
  const ref = to.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase();
  return OTHER_REF_RE.test(ref) && listPeers().some((p) => p.agent !== 'claude' && p.id === ref);
}

/**
 * Claude PreToolUse on SendMessage: SendMessage only reaches Claude sessions, so a message addressed to
 * another agent's session is delivered here instead, and the SendMessage call is stopped with a reason
 * saying so.
 */
async function interceptSendMessage(agentPid: number, input: HookInput): Promise<void> {
  const to = input.tool_input?.to;
  if (typeof to !== 'string' || !addressedToOtherAgent(to)) return; // not ours: let SendMessage run normally
  const message = typeof input.tool_input?.message === 'string' ? input.tool_input.message : '';
  const deny = (reason: string) =>
    print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

  if (!message.trim()) {
    deny('Not sent: sessions of other agents only accept messages with text; notify_when_idle subscriptions are not supported for them.');
    return;
  }
  const result = await sendMessage(selfPeer('claude', agentPid), to, message);
  debugLog('hook', result.ok ? `SendMessage → ${result.recipient.id}` : `SendMessage failed: ${result.error}`);
  deny(
    result.ok
      ? `${result.status} (Sent by telepathy: SendMessage can't reach ${agentLabel(result.recipient.agent)}, so this ` +
          "shows as an error. Don't resend.)"
      : `Not delivered: ${result.error}`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const agentIndex = argv.indexOf('--agent');
  const [action, event] = argv.filter((_, i) => agentIndex < 0 || (i !== agentIndex && i !== agentIndex + 1));
  const input = await readStdin();
  const { agent, pid: agentPid } = findAgent(parseAgent(argv[agentIndex + 1]));
  debugLog('hook', `${agent} ${action}${event ? ` ${event}` : ''} (agent pid ${agentPid})`);

  if (action === 'session-start') sessionStart(agent, agentPid, input);
  else if (action === 'inbox') inbox(agent, agentPid, input, event ?? 'PostToolUse');
  else if (action === 'turn-end') turnEnd(agent, agentPid, input);
  else if (action === 'list-agents' && agent === 'claude') listAgents(agentPid, input);
  else if (action === 'send-message' && agent === 'claude') await interceptSendMessage(agentPid, input);
  else throw new Error(`unknown hook action ${JSON.stringify(action)} for ${agent}`);
}

main().catch((err) => {
  // A broken hook must never block the agent: report on stderr and exit 0.
  process.stderr.write(`telepathy hook: ${(err as Error).message}\n`);
  debugLog('hook', `error: ${(err as Error).stack}`);
});
