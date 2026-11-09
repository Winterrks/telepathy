import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startAcpSession, type AcpSession } from '../acp/host.ts';
import { acpArgs, harnessByAgent, resolvedAcpBin } from '../cli/harnesses.ts';
import { launchEnv, pluginInstalled } from '../cli/launch.ts';
import { type Agent, agentLabel, agentSpec, AGENT_IDS } from '../core/agents.ts';
import { deliverLocal } from '../core/deliver.ts';
import { sendRemote } from '../bridge/remote.ts';
import { isOnline, knownDevices } from '../bridge/state.ts';
import { formatAsUserTurn, type Message, newMessageId, type Party } from '../core/messages.ts';
import { ensureDir, envDurationMs, peerDir, readJson, writeJsonAtomic } from '../core/paths.ts';
import { isPeerAlive, notePeerExit, readPeer } from '../core/peers.ts';
import { isSameProcess, procStart } from '../core/proc.ts';
import { removeCleanWorktree } from './worktree.ts';
import { writeStatus } from '../core/status.ts';
import { claimPluginSession, clearHosted, registerHostedPeer, startInboxPump, writeHeadlessRecord, writeHosted } from '../headless/peer.ts';
import { applySettings } from './configure.ts';
import { allowedBy, readPolicy, requestInfo, suggestPrefixes } from './policy.ts';
import { createReviewer, type Reviewer } from './reviewer.ts';
import { forgetLostTasks, limitNotice, offerEvent, takeBack, type TaskEvent, taskFollow, taskPickupMs } from './task.ts';
import {
  type AgentSpec,
  type AgentState,
  type PermissionAnswer,
  permissionAnswerFile,
  permissionRequestFile,
  permissionsDir,
  permissionWaitMs,
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

/**
 * How long the agent outlives its parent session. A Claude Code session's agents end with it, like its own
 * subagents; a short grace rides over a moment the session's process is not found. Other parents get longer.
 */
const orphanMs = (parent: Agent) => envDurationMs('TELEPATHY_AGENT_ORPHAN_MS', parent === 'claude' ? 15_000 : 10 * 60_000);
const span = (ms: number) => {
  const [n, unit] = ms < 120_000 ? [Math.round(ms / 1000), 'second'] : [Math.round(ms / 60_000), 'minute'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

const now = () => new Date().toLocaleTimeString();

/** How long an agent whose parent is on another device waits for that device to be reachable again. */
const unreachableMs = () => envDurationMs('TELEPATHY_AGENT_UNREACHABLE_MS', 10 * 60_000);

/** True while the parent session runs, false once it is gone, undefined when its device can't be reached to tell. */
function parentPresent(spec: AgentSpec): boolean | undefined {
  if (!spec.remote) {
    if (isPeerAlive(readPeer(spec.parent.id))) return true;
    // The registry can miss a session for a moment (a hook rewriting its files, a re-login); its process can't.
    const own = spec.parentProcess;
    return !!own && isSameProcess(own.pid, own.procStart);
  }
  const { device: id, parentId } = spec.remote;
  const device = knownDevices().find((d) => d.id === id);
  if (!device || !isOnline(device)) return undefined;
  return device.peers.some((peer) => peer.id === parentId);
}

/**
 * codex-acp carries its own copy of Codex, which can be older than the codex CLI: a config.toml the CLI reads can
 * stop that copy at start (an `[agents]` table it doesn't know). Say so, rather than only Codex's parse error.
 */
export function explainStartError(harness: Agent, bin: string, message: string): string {
  if (harness !== 'codex' || !/error loading config/i.test(message)) return message;
  return (
    `${message.replace(/\.?\s*$/, '')}. This ${path.basename(bin)} runs a Codex older than your codex CLI, which can't read a setting ` +
    'the CLI does: Zed\'s retired adapter does. `telepathy update` replaces it, or run ' +
    '`npm uninstall -g @zed-industries/codex-acp && npm install -g @agentclientprotocol/codex-acp`.'
  );
}

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
  /** Asked to stop (stop_agent, TaskStop, the session ending): the turn that ends now has nothing to report. */
  let stopRequested = false;
  const deliver = async (from: Party, body: string, kind: Message['kind']) => {
    try {
      // A parent on another device: the message goes to that device's bridge, which delivers it there.
      const sender = spec.remote && peerId ? readPeer(peerId) : undefined;
      const result = spec.remote
        ? sender
          ? await sendRemote(sender, { slug: spec.remote.device, query: spec.remote.parentId }, body, { kind, transcript }, { rate: false })
          : { ok: false as const, error: 'this agent has no session record' }
        : await deliverLocal(from, spec.parent.id, body, undefined, { kind, transcript });
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

  const takeHeldReport = (): string | undefined => {
    if (!peerId) return undefined;
    const file = path.join(peerDir(peerId), 'parent-report.json');
    const held = readJson<{ body?: string }>(file);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // already gone
    }
    return held?.body?.trim() || undefined;
  };

  const onTurnEnd = (result: { stopReason?: string; error?: string }) => {
    const rawFinal = segment.trim();
    const held = takeHeldReport();
    const final = !held ? rawFinal : !rawFinal ? held : rawFinal.includes(held) ? rawFinal : `${held}\n\n${rawFinal}`;
    segment = '';
    segmentOpen = false;
    write(`\n\n— turn ended${result.error ? `: ${result.error}` : result.stopReason ? `: ${result.stopReason}` : ''}\n`);
    const refused = !result.error && limitNotice(final);
    const why = result.error
      ? `The turn failed: ${result.error}.`
      : refused
        ? `The turn failed: that message is ${agentLabel(spec.harness)}'s own (a plan or usage limit), not the agent's work.`
        : result.stopReason && result.stopReason !== 'end_turn'
        ? `The turn stopped: ${result.stopReason}.`
        : '';
    const body = [final || '(The turn ended without a final message.)', why].filter(Boolean).join('\n\n');
    // A turn that errored failed, whatever text came before the error.
    const failed = !!result.error || refused;
    if (stopRequested) return;
    void offerToTask({ kind: 'result', body, ...(failed ? { failed: true } : {}) }).then((taken) => {
      if (taken) write(`\n\n> Reported to ${spec.parent.address} as its task's result.\n`);
      else void tellParent(body, 'agent-result');
    });
  };

  /**
   * While the parent's server has an MCP task open on this agent (start_agent or a follow-up in Claude Code), the
   * report or permission request is the task's to take: see src/agent/task.ts. A task whose server went away
   * without closing it may be taken up again by the restarted server, so it gets the same wait. Otherwise, or when
   * no poll takes it in time, it goes to the parent as a message.
   */
  const offerToTask = async (event: Omit<TaskEvent, 'at'>): Promise<boolean> => {
    if (taskFollow(dir) === 'none') return false;
    const file = offerEvent(dir, event);
    const deadline = Date.now() + taskPickupMs();
    while (Date.now() < deadline && !stopping) {
      if (!fs.existsSync(file)) return true;
      await new Promise((resolve) => setTimeout(resolve, 200).unref());
    }
    if (!takeBack(file)) return true;
    // Nobody took the lost task up again (a plugin update changes the server Claude Code checks a task against):
    // the next event goes as a message at once, until a call about this agent opens a task again.
    if (taskFollow(dir) === 'lost') {
      forgetLostTasks(dir);
      write(`\n\n> Its task in ${spec.parent.address} was lost when that session's telepathy server restarted; this went as a message.\n`);
    }
    return false;
  };

  /** telepathy's own auto mode for this agent, started on its first review (src/agent/reviewer.ts). */
  let reviewer: Reviewer | undefined;
  const review = () =>
    (reviewer ??= createReviewer(
      spec,
      { bin, args: acpArgs(harness.acp!, bin), env: launchEnv(spec.harness) },
      () => self?.address ?? `${spec.harness}:${spec.slug}`,
      (line) => log.write(line.endsWith('\n') ? line : `${line}\n`),
    ));

  const askPermission = async (params: unknown, what: string): Promise<boolean> => {
    if (!self) return false;
    // What the parent already allowed (set_permission_mode, or "always" on an earlier answer) goes ahead.
    const info = requestInfo(params, what);
    const policy = readPolicy(dir);
    const allowed = allowedBy(policy, info, [spec.cwd, ...(spec.worktree ? [spec.worktree.path] : [])]);
    if (allowed) {
      write(`\n\n- allowed without asking: ${what} (allowed: ${allowed})`);
      return true;
    }
    let reviewed = '';
    // The reviewer stands in for an auto mode the harness lacks; one that has its own already decided to ask.
    if (policy.mode === 'auto' && state.noAutoMode) {
      write(`\n\n- reviewing: ${what}`);
      const verdict = await review().review(info, policy.model);
      if (stopping) return false;
      if (verdict.allow) {
        write(`\n  - allowed by the reviewer: ${verdict.reason}`);
        return true;
      }
      write(`\n  - the reviewer left it to ${spec.parent.address}: ${verdict.reason}`);
      reviewed = `The reviewer did not approve it on its own: ${verdict.reason.replace(/\.$/, '')}.\n`;
    }
    const prefixes = suggestPrefixes(info);
    const id = `p-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    ensureDir(permissionsDir(dir));
    writeJsonAtomic(permissionRequestFile(dir, id), {
      id,
      label: what,
      at: new Date().toISOString(),
      ...(info.command ? { command: info.command } : {}),
      ...(prefixes.length ? { prefixes } : {}),
    });
    write(`\n\n- permission requested: ${what} (asked ${spec.parent.address}, request ${id})`);
    let undeliverable = false;
    const minutes = Math.round(permissionWaitMs() / 60_000);
    const listed = prefixes.map((p) => `"${p}"`).join(', ');
    const asMessage = () =>
      tellParent(
        `${self!.address} asks for permission: ${what}.\n${reviewed}` +
          `Ask your user, then call answer_permission with agent "${self!.address}", request "${id}" and allow true or false` +
          (prefixes.length ? ` (with always true, ${listed} won't be asked about again)` : '') +
          `. Without an answer within ${minutes} minutes it is denied. To be asked less: set_permission_mode allows commands by prefix` +
          (state.noAutoMode && policy.mode === 'ask' ? ", or turns telepathy's auto mode back on, where a reviewer approves routine requests." : '.'),
        'permission',
      ).then((ok) => {
        if (!ok) undeliverable = true;
      });
    void offerToTask({
      kind: 'permission',
      body: `${self.address} asks for permission: ${what}.${reviewed ? `\n${reviewed.trim()}` : ''}`,
      request: id,
      ...(prefixes.length ? { prefixes } : {}),
    }).then((taken) => (taken ? undefined : asMessage()));
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
      args: acpArgs(harness.acp, bin),
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
        if (state.working) {
          state.working = false;
          save();
        }
      },
    });
  } catch (err) {
    out.end();
    return fail(explainStartError(spec.harness, bin, (err as Error).message));
  }

  try {
    const applied = await applySettings(session.request, session.sessionId, session.created, { model: spec.model, effort: spec.effort });
    state.settings = applied.settings;
    if (!applied.auto) state.noAutoMode = true;
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
  writeHosted(peerId, spec.parent.address);
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

  const setWorking = (value: boolean) => {
    if (!!state.working === value) return;
    state.working = value;
    save();
  };
  /** A turn is running from now on, unless the agent never takes this prompt. */
  const submit = (text: string, stillPending?: () => boolean, withdrawn?: () => boolean, onStart?: () => void, claim?: () => boolean) => {
    setWorking(true);
    // Busy only once the prompt goes: OpenCode's plugin steers what arrives while the agent is busy, and would
    // otherwise take this very message.
    const accepted = session.prompt(text, stillPending, withdrawn, () => {
      writeStatus(peerId, 'busy');
      onStart?.();
    }, claim);
    void accepted.then((ok) => {
      if (!ok && !session.busy()) {
        setWorking(false);
        writeStatus(peerId, 'idle');
      }
    });
    return accepted;
  };
  const stopPump = startInboxPump(peerId, (text, stillPending, withdrawn, claim) =>
    submit(text, stillPending, withdrawn, () => write(`\n\n## Message · ${now()}\n\n${text}`), claim),
  );

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
  void submit(taskText);

  // The parent session has ended (not just its MCP server, which a plugin reload restarts): stop with it. A parent
  // on another device is looked for in that device's listing; while the device is out of reach, nobody can tell,
  // so the agent waits longer before it stops.
  let goneSince: number | undefined;
  let stopReason: string | undefined;
  const orphan = orphanMs(spec.parent.agent);
  const unreachable = Math.max(orphan, unreachableMs());
  const watch = setInterval(() => {
    const present = parentPresent(spec);
    if (present === true) {
      goneSince = undefined;
      return;
    }
    goneSince ??= Date.now();
    const limit = present === undefined ? unreachable : orphan;
    if (Date.now() - goneSince > limit) {
      stopReason =
        present === undefined
          ? `the device ${spec.parent.address} is on has been out of reach for ${span(limit)}`
          : `${spec.parent.address} has been gone for ${span(orphan)}`;
      write(`\n\n— stopped: ${stopReason}\n`);
      stopRequested = true;
      session.close();
    }
  }, Math.min(5000, Math.max(250, orphan / 3)));
  const shutdown = () => {
    stopReason ??= 'it was stopped (stop_agent, or a signal)';
    stopRequested = true;
    session.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const code = await session.exited;
  if (!stopRequested) {
    // The harness ended on its own (a crash, a sign-out): the parent hears it instead of finding the agent gone.
    stopReason = `its ${agentLabel(spec.harness)} process exited${code ? ` with code ${code}` : ''}`;
    write(`\n\n— stopped: ${stopReason}\n`);
    const body = `${self?.address ?? spec.slug} stopped: ${stopReason}. Its transcript: ${transcriptFile(dir)}. Start a new agent to go on.`;
    if (!(await offerToTask({ kind: 'result', body, failed: true }))) await tellParent(body, 'agent-result');
  }
  stopping = true;
  reviewer?.close();
  clearInterval(watch);
  stopPump();
  await pushes.catch(() => undefined);
  clearHosted(peerId);
  notePeerExit(peerId);
  fs.rmSync(peerDir(peerId), { recursive: true, force: true });
  if (spec.worktree) state.worktreeKept = !removeCleanWorktree(spec);
  write(`\n\n— stopped at ${new Date().toISOString()}${state.worktreeKept ? `; its worktree ${spec.worktree?.path} (branch ${spec.worktree?.branch}) has changes and was kept` : ''}\n`);
  await new Promise<void>((resolve) => out.end(() => resolve()));
  log.end();
  // Last, so whoever waits for `stopped` reads a finished transcript.
  state.status = 'stopped';
  if (stopReason) state.stopReason = stopReason;
  state.stoppedAt = new Date().toISOString();
  save();
  return 0;
}


