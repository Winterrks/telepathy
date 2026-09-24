import { debugLog } from './core/debug.ts';
import { sendMessage } from './core/deliver.ts';
import { describePeer } from './core/listing.ts';
import { defaultCodexHome, listPeers, peerId, registerSession, selfPeer } from './core/peers.ts';
import { type Agent, findAgentPid, parseAgent } from './core/proc.ts';

/**
 * Hook entry point, shared by Claude Code and Codex:
 *   node hook.mjs --agent <claude|codex> <session-start|list-agents|send-message>
 * Reads the hook's JSON input from stdin; prints JSON output only when there is something to say.
 */

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_input?: { to?: unknown; message?: unknown };
}

async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? (JSON.parse(raw) as HookInput) : {};
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

/** SessionStart: record which session/thread this agent process is running, so peers can address it. */
function sessionStart(agent: Agent, agentPid: number, input: HookInput): void {
  registerSession(agent, agentPid, {
    sessionId: input.session_id,
    cwd: input.cwd,
    source: 'hook',
    codexHome: agent === 'codex' ? defaultCodexHome() : undefined,
  });
}

/** Claude PostToolUse on ListAgents: the built-in listing can't show Codex sessions, so add them. */
function listAgents(agentPid: number): void {
  const selfId = peerId('claude', agentPid);
  const codexPeers = listPeers().filter((p) => p.id !== selfId && p.agent === 'codex');
  if (!codexPeers.length) return;
  print({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        'Codex sessions on this machine are also reachable, through the telepathy plugin (they are not in the listing above).',
        'To message one, call SendMessage with its address (such as "codex:name") as `to`, or use the telepathy send_message tool:',
        ...codexPeers.map(describePeer),
      ].join('\n'),
    },
  });
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
      ? `Delivered by the telepathy plugin. ${result.status} (SendMessage itself can't reach Codex sessions, ` +
          'so the plugin delivered the message and stopped this SendMessage call. Do not resend it.)'
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
  else if (event === 'list-agents' && agent === 'claude') listAgents(agentPid);
  else if (event === 'send-message' && agent === 'claude') await interceptSendMessage(agentPid, input);
  else throw new Error(`unknown hook event ${JSON.stringify(event)} for ${agent}`);
}

main().catch((err) => {
  // A broken hook must never block the agent: report on stderr and exit 0.
  process.stderr.write(`telepathy hook: ${(err as Error).message}\n`);
  debugLog('hook', `error: ${(err as Error).stack}`);
});
