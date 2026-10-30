import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Agent } from '../core/agents.ts';
import { pluginInstalled } from '../cli/launch.ts';
import { copilotLogHasMarker } from '../core/confirm.ts';
import { copilotEventsFile, readSession, sessionPeerId } from '../core/peers.ts';
import { VERSION } from '../core/version.ts';
import { resolveArgvPath } from '../cli/entry.ts';
import { LineRpc } from './rpc.ts';

export interface AcpLaunch {
  agent: Agent;
  bin: string;
  args: string[];
  cwd: string;
  /** Headless peers do not read stdin and do not exit when the pipe closes. */
  headless: boolean;
  resumeSessionId?: string;
  /** Child environment. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** User-visible status lines (session id, permissions). */
  emit: (line: string) => void;
  /** Model text, written as it arrives. Chunks are not forced onto their own lines. */
  stream?: (text: string) => void;
  /** Raw child stderr, for the log file. */
  trace?: (line: string) => void;
  /**
   * No `session/prompt` is in flight. A Copilot turn the hook marked busy is idle again even when
   * `agentStop` did not run.
   */
  onTurnSettled?: () => void;
}

export interface AcpSession {
  sessionId: string;
  child: ChildProcess;
  /** True while a `session/prompt` has not finished. */
  busy(): boolean;
  /**
   * First Ctrl-C during a turn. Sends `session/cancel` and drops a permission prompt that is waiting.
   * Returns false when the turn was already cancelled, or when no turn is running.
   */
  cancelTurn(): boolean;
  /** Stop reading stdin so a dead agent does not wait for Ctrl-D. */
  releaseStdin(): void;
  /** Resolves once the agent has accepted the turn, which may be before the turn finishes. */
  prompt(text: string, stillPending?: () => boolean, withdrawn?: () => boolean): Promise<boolean>;
  /**
   * True when `resumeSessionId` was loaded. False when that load failed or returned a different id,
   * including a Copilot session that was stopped before it ever had a turn.
   */
  resumed: boolean;
  close(): void;
  exited: Promise<number>;
}

interface McpServer {
  type: 'stdio';
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

/**
 * The MCP server block for `session/new`. Gemini merges this onto the user's settings; an empty list
 * leaves those settings in place. Copilot's behavior is unverified live (see the design note).
 * The env array replaces the server's environment, so it carries the variables the user already has.
 */
export function telepathyMcpServers(agent: Agent): McpServer[] {
  if (pluginInstalled(agent)) return [];
  const entry = mcpEntry();
  const args = entry.viaCli ? [entry.file, 'mcp', '--agent', agent] : [entry.file, '--agent', agent];
  return [
    {
      type: 'stdio',
      name: 'telepathy',
      command: process.execPath,
      args,
      env: Object.entries(process.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name, value]) => ({ name, value })),
    },
  ];
}

/** `viaCli` means the file is the `telepathy` command, so the server is `telepathy mcp`. */
function mcpEntry(): { file: string; viaCli: boolean } {
  const override = process.env.TELEPATHY_MCP_ENTRY;
  if (override) return { file: override, viaCli: !override.endsWith('server.mjs') };
  const argv1 = process.argv[1];
  const resolved = argv1 ? resolveArgvPath(argv1) : '';
  if (resolved && /(?:^|[/\\])(?:telepathy|cli)\.(?:mjs|ts|js)$/.test(resolved)) return { file: path.resolve(resolved), viaCli: true };
  const beside = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugin/dist/server.mjs');
  if (fs.existsSync(beside)) return { file: beside, viaCli: false };
  return { file: path.resolve(resolved || argv1 || 'telepathy'), viaCli: true };
}

function textOf(params: unknown): string {
  const root = (params ?? {}) as { update?: unknown; content?: unknown; text?: unknown; message?: { content?: unknown } };
  const update = (root.update ?? root) as { content?: unknown; text?: unknown; message?: { content?: unknown } };
  const content = update.content ?? update.message?.content ?? root.content;
  if (typeof content === 'string') return content;
  if (typeof update.text === 'string') return update.text;
  if (content && typeof content === 'object' && 'text' in content && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

/**
 * Any `session/update` for this prompt's turn is delivery, including a turn that starts with a tool call.
 * Text-only updates missed those turns, and the 110s confirm then cancelled a prompt the agent already had.
 * Copilot is the exception: a marker prompt is accepted only when the update echoes that marker.
 */
function relevantUpdate(_params: unknown): boolean {
  return true;
}

const PROMPT_MARKER = /telepathy-id:(m-[0-9a-z]+-[0-9a-f]+)/;

function promptMarker(text: string): string | undefined {
  const match = PROMPT_MARKER.exec(text);
  return match ? `telepathy-id:${match[1]}` : undefined;
}

/**
 * Copilot has the injected prompt when a `user.message` event carries its marker, or a `hook.start`
 * whose `data.hookType` is `userPromptSubmitted`.
 * sessionStart writes the same text as `initialPrompt` before that event exists.
 */
function copilotEventsHaveMarker(sessionId: string, marker: string): boolean {
  const files = new Set<string>([copilotEventsFile(sessionId)]);
  const recorded = readSession(sessionPeerId('copilot', 0, sessionId))?.transcriptPath;
  if (recorded && !recorded.includes('${')) files.add(recorded);
  for (const file of files) {
    if (copilotLogHasMarker(file, marker)) return true;
  }
  return false;
}

/**
 * Copilot does not save a session that never had a turn. A `--name` restart then starts a new one;
 * say so instead of looking like the old session came back.
 */
export function noteMissedCopilotResume(
  agent: Agent,
  requested: string | undefined,
  session: { resumed: boolean; sessionId: string },
): void {
  if (agent !== 'copilot' || !requested || session.resumed) return;
  process.stderr.write(
    `telepathy: Copilot did not resume ${requested} (it does not save a session that never had a turn). Started a new session ${session.sessionId}.\n`,
  );
}

function summarize(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '';
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}

/** Tool name plus a short input, so the prompt is not just "permission requested". */
export function describePermission(params: unknown): string {
  const body = (params ?? {}) as {
    toolCall?: { title?: unknown; kind?: unknown; toolCallId?: unknown; rawInput?: unknown; input?: unknown };
    title?: unknown;
  };
  const tool = body.toolCall ?? {};
  const name =
    (typeof tool.title === 'string' && tool.title) ||
    (typeof tool.kind === 'string' && tool.kind) ||
    (typeof body.title === 'string' && body.title) ||
    (typeof tool.toolCallId === 'string' && tool.toolCallId) ||
    'tool';
  const input = summarize(tool.rawInput ?? tool.input);
  return input ? `${name} (${input})` : name;
}

function allowOption(params: unknown): string {
  const options = ((params ?? {}) as { options?: { optionId?: string; kind?: string; name?: string }[] }).options ?? [];
  const match = options.find((option) => option.kind === 'allow_once' || /allow/i.test(option.name ?? '') || /allow/i.test(option.optionId ?? ''));
  return match?.optionId ?? options[0]?.optionId ?? 'allow';
}

function sessionIdOf(result: unknown): string | undefined {
  const body = result as { sessionId?: unknown; id?: unknown; session?: { id?: unknown; sessionId?: unknown } };
  const id = body?.sessionId ?? body?.session?.sessionId ?? body?.session?.id ?? body?.id;
  return typeof id === 'string' && id ? id : undefined;
}

const AUTH_FAILURE = /not logged in|login required|authentication (?:failed|required)|please run \S+ login|unauthorized|invalid api key|credentials? (?:not found|missing|expired)/i;

/**
 * Spawns an ACP agent and speaks initialize / session/new|load / session/prompt.
 * A prompt counts as accepted on the RPC result, on any `session/update` after the request
 * (including tool calls), or on `session/request_permission`.
 * A Copilot prompt that carries `telepathy-id:` is accepted only when an update echoes that marker,
 * when Copilot's `events.jsonl` contains it, or on `session/request_permission`. The RPC result
 * alone is not enough, and the wait stays inside the sender's confirm budget: a withdraw ends it.
 * `stillPending` is checked again immediately before `session/prompt`. A send that `fail()` already withdrew
 * is not submitted. A prompt already on the wire is cancelled only when `withdrawn` says the sender
 * recalled it. Copilot's userPromptSubmitted hook claims the inbox copy of a prompt this host just
 * injected; that copy is no longer pending, and cancelling it drops the turn.
 */
export async function startAcpSession(options: AcpLaunch): Promise<AcpSession> {
  // A new process group so Ctrl-C reaches this host, which sends session/cancel, and not the adapter.
  const child = spawn(options.bin, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const stopChild = (signal: NodeJS.Signals) => {
    const pid = child.pid;
    if (pid && process.platform !== 'win32') {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // The process group is already gone. Fall through to the child handle.
      }
    }
    if (child.exitCode === null && !child.killed) child.kill(signal);
  };
  let stderrTail = '';
  let sessionReady = false;
  let failure: number | undefined;
  let authReported = false;
  const noteStderr = (text: string) => {
    options.trace?.(text);
    stderrTail = (stderrTail + text).slice(-4000);
    if (!AUTH_FAILURE.test(stderrTail)) return;
    failure = 1;
    if (sessionReady && !authReported) {
      authReported = true;
      options.emit(authMessage(options.bin, stderrTail));
    }
    stopChild('SIGTERM');
  };
  child.stderr?.on('data', (chunk: Buffer) => noteStderr(chunk.toString()));
  let userStop = false;
  const exited = new Promise<number>((resolve) => {
    child.on('error', () => resolve(failure ?? 127));
    child.on('exit', (code, signal) => {
      if (failure !== undefined) resolve(failure);
      else if (userStop) resolve(0);
      else resolve(signal ? 1 : (code ?? 1));
    });
  });

  let ask: ((line: string) => void) | undefined;
  /** Drop a permission question so the next typed line is a prompt, not the answer to a dead one. */
  const clearAsk = () => {
    const pending = ask;
    ask = undefined;
    pending?.('');
  };

  const permission = async (params: unknown): Promise<boolean> => {
    const label = describePermission(params);
    if (process.env.TELEPATHY_HEADLESS_APPROVE === '1' && (options.headless || !process.stdin.isTTY)) {
      options.emit(`allowed ${label}: TELEPATHY_HEADLESS_APPROVE=1 allows every permission.`);
      return true;
    }
    if (options.headless || !process.stdin.isTTY) {
      if (!options.headless && !process.stdin.isTTY) {
        options.emit(`permission requested: ${label}. Reply y or n.`);
        const line = await new Promise<string>((resolve) => {
          ask = resolve;
        });
        ask = undefined;
        return /^y(es)?$/i.test(line.trim());
      }
      options.emit(`permission rejected (${label}). Set TELEPATHY_HEADLESS_APPROVE=1 to allow every permission.`);
      return false;
    }
    options.emit(`permission requested: ${label}. Reply y or n.`);
    const line = await new Promise<string>((resolve) => {
      ask = resolve;
    });
    ask = undefined;
    return /^y(es)?$/i.test(line.trim());
  };

  let endedWithNl = true;
  const writeText = (text: string) => {
    if (!text) return;
    if (options.stream) options.stream(text);
    else options.emit(text);
    endedWithNl = text.endsWith('\n');
  };
  const endText = () => {
    if (endedWithNl) return;
    writeText('\n');
  };

  let lastUpdate: { kind: string; messageId?: string } | undefined;
  const updateIdentity = (params: unknown): { kind: string; messageId?: string } => {
    const root = (params ?? {}) as { update?: unknown };
    const update = (root.update ?? root) as { sessionUpdate?: unknown; messageId?: unknown };
    return {
      kind: typeof update.sessionUpdate === 'string' ? update.sessionUpdate : 'text',
      messageId: typeof update.messageId === 'string' ? update.messageId : undefined,
    };
  };

  let acceptDelivery: (() => void) | undefined;
  let onUpdate: (params: unknown) => void = (params) => {
    const text = textOf(params);
    const identity = updateIdentity(params);
    const newMessage =
      !!lastUpdate &&
      !!text &&
      (lastUpdate.kind !== identity.kind ||
        (!!identity.messageId && !!lastUpdate.messageId && identity.messageId !== lastUpdate.messageId));
    if (newMessage && !endedWithNl) writeText('\n');
    if (text) lastUpdate = identity;
    writeText(text);
  };

  const rpc = new LineRpc(
    child,
    async (method, params, id) => {
      if (method !== 'session/request_permission') {
        rpc.fail(id, `telepathy does not handle ${method}`);
        return;
      }
      acceptDelivery?.();
      const allow = await permission(params);
      clearAsk();
      if (!allow) {
        rpc.respond(id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      rpc.respond(id, { outcome: { outcome: 'selected', optionId: allowOption(params) } });
    },
    (method, params) => {
      if (method === 'session/update') onUpdate(params);
    },
  );

  let activeTurns = 0;
  let cancelledThisTurn = false;
  let rl: readline.Interface | undefined;
  const releaseStdin = () => {
    const current = rl;
    rl = undefined;
    current?.close();
    // Closing readline from its own `line` callback does not drop stdin's ref. The host would
    // stay up after the agent exits for as long as the caller's pipe stays open.
    setImmediate(() => {
      if (process.stdin.destroyed) return;
      process.stdin.pause();
      process.stdin.unref();
    });
  };
  child.on('exit', () => releaseStdin());

  let session: AcpSession | undefined;
  const cancelTurn = (): boolean => {
    clearAsk();
    if (activeTurns === 0 || cancelledThisTurn || !sessionReady) return false;
    cancelledThisTurn = true;
    rpc.notify('session/cancel', { sessionId: session?.sessionId });
    return true;
  };
  let handlingSigint = false;
  const onSigint = () => {
    if (handlingSigint) return;
    handlingSigint = true;
    try {
      if (!cancelTurn()) {
        userStop = true;
        stopChild('SIGTERM');
        releaseStdin();
      }
    } finally {
      handlingSigint = false;
    }
  };

  if (!options.headless) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const text = line.trim();
      // The host owns these. An idle Ctrl-C stops the child; so do /exit and /quit, without sending them.
      if (/^\/(?:exit|quit)$/i.test(text)) {
        clearAsk();
        userStop = true;
        stopChild('SIGTERM');
        releaseStdin();
        return;
      }
      if (ask) {
        const answer = ask;
        ask = undefined;
        answer(line);
        return;
      }
      if (text && session) void session.prompt(text);
    });
    rl.on('close', () => session?.close());
    rl.on('SIGINT', onSigint);
    process.on('SIGINT', onSigint);
  }

  try {
    if (failure !== undefined) {
      stopChild('SIGTERM');
      throw new Error(authMessage(options.bin, stderrTail));
    }
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'telepathy', version: VERSION },
    });
    if (failure !== undefined) throw new Error(authMessage(options.bin, stderrTail));

    const mcpServers = telepathyMcpServers(options.agent);
    let sessionId = options.resumeSessionId;
    let resumed = false;
    if (sessionId) {
      const wanted = sessionId;
      try {
        const loaded = await rpc.request('session/load', { sessionId, cwd: options.cwd, mcpServers });
        sessionId = sessionIdOf(loaded) ?? wanted;
        resumed = sessionId === wanted;
      } catch {
        sessionId = undefined;
        resumed = false;
      }
    }
    if (!sessionId) {
      const created = await rpc.request('session/new', { cwd: options.cwd, mcpServers });
      sessionId = sessionIdOf(created);
    }
    if (!sessionId) {
      stopChild('SIGTERM');
      throw new Error(`${options.bin} did not return a session id`);
    }
    sessionReady = true;
    options.emit(`session ${sessionId}`);

    let tail: Promise<void> = Promise.resolve();
    session = {
      sessionId,
      child,
      resumed,
      busy: () => activeTurns > 0,
      cancelTurn,
      releaseStdin,
      prompt(text: string, stillPending: () => boolean = () => true, withdrawn?: () => boolean): Promise<boolean> {
        // Callers that only know "still in the inbox" keep the old cancel. The inbox pump passes
        // `withdrawn` so a hook claim is not treated as a recall.
        const recalled = withdrawn ?? (() => !stillPending());
        // Copilot logs the user message in events.jsonl after the first session/update. An update
        // that does not echo this marker is not proof the prompt is in the session.
        const marker = options.agent === 'copilot' ? promptMarker(text) : undefined;
        const eventsProven = () => !!marker && copilotEventsHaveMarker(sessionId, marker);
        let resolveAccepted: (ok: boolean) => void = () => {};
        const accepted = new Promise<boolean>((resolve) => {
          resolveAccepted = resolve;
        });
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          resolveAccepted(ok);
        };
        const job = tail.then(async () => {
          activeTurns += 1;
          cancelledThisTurn = false;
          const previous = onUpdate;
          let sent = false;
          let cancelSent = false;
          const cancel = () => {
            if (cancelSent || !sent || settled) return;
            cancelSent = true;
            clearAsk();
            rpc.notify('session/cancel', { sessionId });
          };
          const watch = setInterval(() => {
            if (settled || !sent) return;
            if (recalled()) cancel();
            else if (eventsProven()) finish(true);
          }, 25);
          try {
            if (!stillPending() || recalled()) {
              finish(false);
              return;
            }
            onUpdate = (params) => {
              previous(params);
              if (recalled()) return;
              if (marker) {
                if (textOf(params).includes(marker) || eventsProven()) finish(true);
                return;
              }
              if (relevantUpdate(params)) finish(true);
            };
            acceptDelivery = () => {
              if (!recalled()) finish(true);
            };
            sent = true;
            if (!stillPending() || recalled()) {
              finish(false);
              return;
            }
            await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
            if (recalled()) {
              cancel();
              finish(false);
            } else if (!marker || eventsProven()) {
              finish(true);
            } else {
              // The turn returned without an echo. Copilot may still flush events.jsonl.
              // Stop when the marker appears or the sender withdraws the copy (the confirm abort).
              while (!settled && !recalled()) {
                if (child.exitCode !== null || child.signalCode) break;
                if (eventsProven()) {
                  finish(true);
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              if (!settled) {
                if (recalled()) cancel();
                finish(false);
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const closed = message === 'agent exited' || message === 'agent stdin is closed';
            if (!closed) {
              const auth = AUTH_FAILURE.test(message) || AUTH_FAILURE.test(stderrTail);
              options.emit(auth ? authMessage(options.bin, stderrTail || message) : message);
              if (auth) {
                failure = 1;
                stopChild('SIGTERM');
              }
            }
            finish(false);
          } finally {
            clearInterval(watch);
            onUpdate = previous;
            acceptDelivery = undefined;
            activeTurns = Math.max(0, activeTurns - 1);
            if (activeTurns === 0) options.onTurnSettled?.();
            clearAsk();
            endText();
          }
        });
        tail = job.then(
          () => {},
          () => {},
        );
        return accepted;
      },
      close() {
        stopChild('SIGTERM');
        releaseStdin();
      },
      exited,
    };
    return session;
  } catch (err) {
    if (!options.headless) process.off('SIGINT', onSigint);
    releaseStdin();
    stopChild('SIGTERM');
    const message = err instanceof Error ? err.message : String(err);
    const detail = stderrTail.trim().split('\n').filter(Boolean).at(-1);
    if (detail && !message.includes(detail)) throw new Error(`${message}: ${detail}`);
    throw err;
  }
}

function authMessage(bin: string, stderrTail: string): string {
  const detail = stderrTail.trim().split('\n').filter(Boolean).at(-1);
  return detail ? `${bin} failed to authenticate: ${detail}` : `${bin} failed to authenticate`;
}
