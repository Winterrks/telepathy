import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugLog } from './core/debug.ts';
import { sendMessage } from './core/deliver.ts';
import { listAgentsRow } from './core/listing.ts';
import { defaultCodexHome, listPeers, peerId, peerRef, registerSession, selfPeer } from './core/peers.ts';
import { type Agent, findAgentPid, parseAgent } from './core/proc.ts';

/**
 * Hook entry point, shared by Claude Code and Codex:
 *   node hook.mjs --agent <claude|codex> <session-start|list-agents|send-message>
 * Reads the hook's JSON input from stdin; prints JSON output only when there is something to say.
 */

interface HookInput {
  session_id?: string;
  cwd?: string;
  /** SessionStart: `startup`, `resume`, `clear`, `compact` (and `fork` in Claude Code). */
  source?: string;
  tool_input?: { to?: unknown; message?: unknown };
  tool_response?: unknown;
}

async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? (JSON.parse(raw) as HookInput) : {};
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

/** The plugin's own skill, next to the bundle: dist/hook.mjs → skills/using-telepathy/SKILL.md. */
const SKILL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'using-telepathy', 'SKILL.md');

/**
 * The using-telepathy skill as session context, like superpowers loads using-superpowers. A resumed or forked
 * conversation already has it, so it is only added when the context starts empty.
 */
function skillContext(source: string | undefined): string | undefined {
  if (source === 'resume' || source === 'fork') return undefined;
  let skill: string;
  try {
    skill = fs.readFileSync(SKILL_FILE, 'utf8');
  } catch {
    return undefined;
  }
  const body = skill.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
  return `The telepathy plugin is installed in this session. This is its telepathy:using-telepathy skill, already loaded:\n\n${body}`;
}

/**
 * SessionStart: record which session/thread this agent process is running, so peers can address it, and
 * load the using-telepathy skill. Both agents accept the same `additionalContext` output.
 */
function sessionStart(agent: Agent, agentPid: number, input: HookInput): void {
  registerSession(agent, agentPid, {
    sessionId: input.session_id,
    cwd: input.cwd,
    source: 'hook',
    codexHome: agent === 'codex' ? defaultCodexHome() : undefined,
  });
  const context = skillContext(input.source);
  if (context) print({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
}

/**
 * Claude PostToolUse on ListAgents: the built-in listing can't show Codex sessions, so add them to it, as
 * rows in ListAgents' own shape. ListAgents returns `{ listing: string }`; if that ever changes, a rewrite
 * would be ignored, so fall back to a note next to the result.
 */
function listAgents(agentPid: number, input: HookInput): void {
  const selfId = peerId('claude', agentPid);
  const codexPeers = listPeers().filter((p) => p.id !== selfId && p.agent === 'codex');
  if (!codexPeers.length) return;
  const heading =
    `Codex sessions (${codexPeers.length}), reachable through the telepathy plugin with SendMessage or its ` +
    'send_message tool (SendMessage shows an error for these, but the message is delivered):';
  const block = [heading, ...codexPeers.map((p) => listAgentsRow(p))].join('\n');
  const response = input.tool_response as { listing?: unknown } | undefined;
  if (typeof response?.listing === 'string') {
    const listing = `${response.listing.trimEnd()}\n\n${block}`;
    print({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, listing } } });
    return;
  }
  print({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: block } });
}

/**
 * Only addresses that can't name a Claude session count as ours: the `codex:` namespace, a `[codex-<pid>]`
 * ref (Claude's refs are hex), or the exact ref of a live Codex session. A bare name, or one merely starting
 * with "codex-", may be a Claude session (Claude names sessions after their folder), so it is left to SendMessage.
 */
function addressedToCodex(to: string): boolean {
  if (/^\s*["'`]?codex:/i.test(to) || /\[\s*codex-\d+\s*\]\s*$/i.test(to)) return true;
  const ref = to.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase();
  return /^codex-\d+$/.test(ref) && listPeers().some((p) => p.agent === 'codex' && p.id === ref);
}

/**
 * Claude PreToolUse on SendMessage: SendMessage only reaches Claude sessions, so a message addressed to a
 * Codex session is delivered here instead, and the SendMessage call is stopped with a reason saying so.
 */
async function interceptSendMessage(agentPid: number, input: HookInput): Promise<void> {
  const to = input.tool_input?.to;
  if (typeof to !== 'string' || !addressedToCodex(to)) return; // not ours: let SendMessage run normally
  const message = typeof input.tool_input?.message === 'string' ? input.tool_input.message : '';
  const deny = (reason: string) =>
    print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

  if (!message.trim()) {
    deny('Not sent: Codex sessions only accept messages with text; notify_when_idle subscriptions are not supported for them.');
    return;
  }
  const result = await sendMessage(selfPeer('claude', agentPid), to, message);
  debugLog('hook', result.ok ? `SendMessage → ${result.recipient.id}` : `SendMessage failed: ${result.error}`);
  deny(
    result.ok
      ? `Sent via telepathy, not a failure: queued ${result.message.id} for ${peerRef(result.recipient)}, which ` +
          "picks it up within about 10 seconds, or after its current turn. SendMessage can't reach Codex, so " +
          'telepathy delivered the message and cancelled this call. Do not resend it; a reply arrives as a new message.'
      : `Not delivered: ${result.error}`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const agent = parseAgent(argv[argv.indexOf('--agent') + 1]);
  const event = argv.at(-1);
  const input = await readStdin();
  const agentPid = findAgentPid(agent);
  debugLog('hook', `${agent} ${event} (agent pid ${agentPid})`);

  if (event === 'session-start') sessionStart(agent, agentPid, input);
  else if (event === 'list-agents' && agent === 'claude') listAgents(agentPid, input);
  else if (event === 'send-message' && agent === 'claude') await interceptSendMessage(agentPid, input);
  else throw new Error(`unknown hook event ${JSON.stringify(event)} for ${agent}`);
}

main().catch((err) => {
  // A broken hook must never block the agent: report on stderr and exit 0.
  process.stderr.write(`telepathy hook: ${(err as Error).message}\n`);
  debugLog('hook', `error: ${(err as Error).stack}`);
});
