import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startAcpSession, type AcpSession } from '../acp/host.ts';
import { harnessByAgent, resolvedAcpBin } from '../cli/harnesses.ts';
import { launchEnv, pluginInstalled } from '../cli/launch.ts';
import { agentLabel, agentSpec, AGENT_IDS } from '../core/agents.ts';
import { deliverLocal } from '../core/deliver.ts';
import { formatAsUserTurn, type Message, newMessageId, type Party } from '../core/messages.ts';
import { ensureDir, envDurationMs, readJson, writeJsonAtomic } from '../core/paths.ts';
import { isPeerAlive, readPeer } from '../core/peers.ts';
import { procStart } from '../core/proc.ts';
import { removeCleanWorktree } from './worktree.ts';
import { writeStatus } from '../core/status.ts';
import { claimPluginSession, clearHosted, registerHostedPeer, startInboxPump, writeHeadlessRecord } from '../headless/peer.ts';
import { applySettings } from './configure.ts';
import {
  type AgentSpec,
  type AgentState,
  type PermissionAnswer,
  permissionAnswerFile,
  permissionRequestFile,
  permissionsDir,
  readSpec,
  transcriptFile,
  writeState,
} from './spec.ts';

/**
 * Variables that say which harness session a process belongs to. The started agent is a session of its own,
 * so it must not inherit the parent's: Claude's inbox socket would post its messages to the parent.
 */
const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PLUGIN_ROOT',
  'CODEX_THREAD_ID',
  'OPENCODE',
  'TELEPATHY_AGENT_PID',
  'TELEPATHY_NAME',
  ...AGENT_IDS.flatMap((agent) => agentSpec(agent).env ?? []),
];

const permissionWaitMs = () => envDurationMs('TELEPATHY_AGENT_PERMISSION_MS', 10 * 60_000);
const orphanMs = () => envDurationMs('TELEPATHY_AGENT_ORPHAN_MS', 10 * 60_000);

const now = () => new Date().toLocaleTimeString();

/** The process `start_agent` spawns: one harness session in ACP mode, until it is stopped or its parent is gone. */
/** A result the parent missed is sent again this many times, this far apart. */
const RESULT_RETRIES = 3;
const resultRetryMs = () => envDurationMs('TELEPATHY_AGENT_RESULT_RETRY_MS', 60_000);

export async function runAgent(dir: string): Promise<number> {
  const spec = readSpec(dir);
  if (!spec) return 1;
  for (const name of SESSION_MARKERS) delete process.env[name];

  const state: AgentState = { status: 'starting', pid: process.pid, procStart: procStart(process.pid) };
  const save = () => writeState(dir, state);
  const fail = (error: string) => {
    // A start that failed leaves nothing behind: a clean worktree would block the same name next time.
    if (spec.worktree) state.worktreeKept = !removeCleanWorktree(spec);
    state.status = 'failed';
    state.error = error;
    save();
    return 1;
  };
  save();

  const harness = harnessByAgent(spec.harness);
  const bin = harness?.acp ? resolvedAcpBin(harness.acp) : undefined;
  if (!harness?.acp || !bin) return fail(`${spec.harness} has no ACP launcher on PATH`);

  const transcript = transcriptFile(dir);
  const out = fs.createWriteStream(transcript, { flags: 'a' });
  const write = (text: string) => out.write(text);
  const log = fs.createWriteStream(path.join(dir, 'host.log'), { flags: 'a' });
  const label = agentLabel(spec.harness);
  const notes: string[] = [];

  // The last unbroken run of agent text in a turn is its final message. A tool call or a thought ends a run.
  let segment = '';
  let segmentOpen = false;
  const onSessionUpdate = (params: unknown) => {
    const update = (((params ?? {}) as { update?: unknown }).update ?? params) as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
      title?: string;
      kind?: string;
      status?: string;
      toolCallId?: string;
    };
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.type === 'text' || typeof update.content?.text === 'string' ? (update.content?.text ?? '') : '';
      if (!text) return;
      if (!segmentOpen) {
        segment = '';
        segmentOpen = true;
        write(`\n\n## ${label} · ${now()}\n\n`);
      }
      segment += text;
      write(text);
      return;
    }
    if (update.sessionUpdate === 'tool_call') {
      segmentOpen = false;
      write(`\n\n- tool: ${update.title ?? update.kind ?? update.toolCallId ?? 'call'}${update.status ? ` (${update.status})` : ''}`);
      return;
    }
    if (update.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
      segmentOpen = false;
      write(`\n  - ${update.title ?? update.toolCallId ?? 'call'}: ${update.status}`);
      return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'plan') segmentOpen = false;
  };

  let self: Party | undefined;
  let pushes: Promise<unknown> = Promise.resolve();
  let stopping = false;
  const deliver = async (from: Party, body: string, kind: Message['kind']) => {
    try {
      const result = await deliverLocal(from, spec.parent.id, body, undefined, { kind, transcript });
      if (!result.ok) write(`\n\n> Not delivered to ${spec.parent.address}: ${result.error}\n`);
      return result.ok;
    } catch (err) {
      write(`\n\n> Not delivered to ${spec.parent.address}: ${(err as Error).message}\n`);
      return false;
    }
  };
  /**
   * Tell the parent something, as a message from this agent. A failed delivery is noted in the transcript. A
   * result the parent missed (busy past the confirm window) is sent again a few times, outside the queue, so a
   * permission request behind it isn't held up.
   */
  const tellParent = (body: string, kind: Message['kind']) => {
    const from = self;
    if (!from) return Promise.resolve(false);
    const sent = (pushes = pushes.then(() => deliver(from, body, kind)));
    if (kind === 'agent-result') {
      void (sent as Promise<boolean>).then(async (ok) => {
        for (let attempt = 1; !ok && attempt <= RESULT_RETRIES && !stopping; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, resultRetryMs()).unref());
          if (stopping) return;
          write(`\n> Sending that result again (${attempt} of ${RESULT_RETRIES}).\n`);
          ok = await deliver(from, body, kind);
        }
      });
    }
    return sent as Promise<boolean>;
  };

  const onTurnEnd = (result: { stopReason?: string; error?: string }) => {
    const final = segment.trim();
    segment = '';
    segmentOpen = false;
    write(`\n\n— turn ended${result.error ? `: ${result.error}` : result.stopReason ? `: ${result.stopReason}` : ''}\n`);
    const why = result.error
      ? `The turn failed: ${result.error}.`
      : result.stopReason && result.stopReason !== 'end_turn'
        ? `The turn stopped: ${result.stopReason}.`
        : '';
    const body = [final || '(The turn ended without a final message.)', why].filter(Boolean).join('\n\n');
    void tellParent(body, 'agent-result');
  };

  const askPermission = async (_params: unknown, what: string): Promise<boolean> => {
    if (!self) return false;
    const id = `p-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    ensureDir(permissionsDir(dir));
    writeJsonAtomic(permissionRequestFile(dir, id), { id, label: what, at: new Date().toISOString() });
    write(`\n\n- permission requested: ${what} (asked ${spec.parent.address}, request ${id})`);
    let undeliverable = false;
    void tellParent(
      `${self.address} asks for permission: ${what}.\n` +
        `Ask your user, then call answer_permission with agent "${self.address}", request "${id}" and allow true or false. ` +
        `Without an answer within ${Math.round(permissionWaitMs() / 60_000)} minutes it is denied.`,
      'permission',
    ).then((ok) => {
      if (!ok) undeliverable = true;
    });
    const deadline = Date.now() + permissionWaitMs();
    while (Date.now() < deadline && !undeliverable) {
      const answer = readJson<PermissionAnswer>(permissionAnswerFile(dir, id));
      if (answer) {
        write(`\n  - ${answer.allow ? 'allowed' : 'denied'} by ${spec.parent.address}`);
        return answer.allow === true;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    write(`\n  - denied: ${undeliverable ? 'the request could not be delivered' : 'no answer in time'}`);
    return false;
  };

  write(
    `# ${label} agent: ${spec.description}\n\nStarted by ${spec.parent.address} [${spec.parent.id}] at ${new Date().toISOString()}, ` +
      `in ${spec.cwd}.\n`,
  );

  let session: AcpSession;
  let peerId: string | undefined;
  try {
    session = await startAcpSession({
      agent: spec.harness,
      bin,
      args: harness.acp.args,
      cwd: spec.cwd,
      headless: true,
      env: launchEnv(spec.harness, spec.slug),
      emit: (line) => {
        log.write(line.endsWith('\n') ? line : `${line}\n`);
        if (/no telepathy tools/.test(line)) notes.push('It has no telepathy tools, so it cannot message other sessions. Its final message still reaches you.');
      },
      stream: () => {},
      trace: (line) => log.write(line),
      onSessionUpdate,
      onTurnEnd,
      askPermission,
      onTurnSettled: () => {
        if (peerId) writeStatus(peerId, 'idle');
      },
    });
  } catch (err) {
    out.end();
    return fail((err as Error).message);
  }

  try {
    const applied = await applySettings(session.request, session.sessionId, session.created, { model: spec.model, effort: spec.effort });
    state.settings = applied.settings;
    notes.push(...applied.notes);
  } catch (err) {
    session.close();
    out.end();
    return fail((err as Error).message);
  }

  const pluginPeer = pluginInstalled(spec.harness);
  peerId =
    pluginPeer && session.child.pid
      ? claimPluginSession(spec.harness, session.child.pid, session.sessionId, spec.cwd, spec.slug)
      : registerHostedPeer(spec.harness, spec.cwd, spec.slug).peerId;
  const peer = readPeer(peerId);
  self = { id: peerId, agent: spec.harness, name: peer?.name ?? spec.slug, address: peer?.address ?? `${spec.harness}:${spec.slug}` };
  writeStatus(peerId, 'idle');
  writeHeadlessRecord({
    name: spec.slug,
    slug: spec.slug,
    agent: spec.harness,
    peerId,
    pid: process.pid,
    procStart: state.procStart,
    cwd: spec.cwd,
    logFile: transcript,
    harnessSessionId: session.sessionId,
    startedAt: spec.createdAt,
  });
  Object.assign(state, { status: 'ready', peerId, address: self.address, sessionId: session.sessionId, notes });
  save();

  const stopPump = startInboxPump(peerId, (text, stillPending, withdrawn) => {
    write(`\n\n## Message · ${now()}\n\n${text}`);
    return session.prompt(text, stillPending, withdrawn);
  });

  const task: Message = {
    id: newMessageId(),
    from: spec.parent,
    to: self,
    body:
      `${spec.prompt}\n\n` +
      `(You are an agent ${spec.parent.address} started with telepathy's start_agent for this task: ${spec.description}. ` +
      `Work on it on your own. When you are done, end your turn with your final report as your last message: telepathy ` +
      `delivers that message to ${spec.parent.address} with your transcript, so don't also send it with send_message. ` +
      `${spec.parent.address} may send you follow-ups.)`,
    sentAt: new Date().toISOString(),
  };
  const taskText = formatAsUserTurn(task);
  write(`\n\n## Task from ${spec.parent.address} · ${now()}\n\n${taskText}`);
  void session.prompt(taskText);

  // A parent that has been gone this long is not coming back for the result.
  let goneSince: number | undefined;
  const watch = setInterval(() => {
    if (isPeerAlive(readPeer(spec.parent.id))) {
      goneSince = undefined;
      return;
    }
    goneSince ??= Date.now();
    if (Date.now() - goneSince > orphanMs()) {
      write(`\n\n— stopped: ${spec.parent.address} has been gone for ${Math.round(orphanMs() / 60_000)} minutes\n`);
      session.close();
    }
  }, 5000);
  const shutdown = () => session.close();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await session.exited;
  stopping = true;
  clearInterval(watch);
  stopPump();
  await pushes.catch(() => undefined);
  if (!pluginPeer) clearHosted(peerId);
  if (spec.worktree) state.worktreeKept = !removeCleanWorktree(spec);
  write(`\n\n— stopped at ${new Date().toISOString()}${state.worktreeKept ? `; its worktree ${spec.worktree?.path} (branch ${spec.worktree?.branch}) has changes and was kept` : ''}\n`);
  await new Promise<void>((resolve) => out.end(() => resolve()));
  log.end();
  // Last, so whoever waits for `stopped` reads a finished transcript.
  state.status = 'stopped';
  save();
  return 0;
}


