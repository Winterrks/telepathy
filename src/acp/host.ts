import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Agent } from '../core/agents.ts';
import { findInstalls } from '../core/installs.ts';
import { VERSION } from '../core/version.ts';
import { LineRpc } from './rpc.ts';

export interface AcpLaunch {
  agent: Agent;
  bin: string;
  args: string[];
  cwd: string;
  /** Headless peers do not read stdin and do not exit when the pipe closes. */
  headless: boolean;
  resumeSessionId?: string;
  /** User-visible lines (the line UI and status). */
  emit: (line: string) => void;
  /** Raw child stderr, for the log file. */
  trace?: (line: string) => void;
}

export interface AcpSession {
  sessionId: string;
  child: ChildProcess;
  /** Resolves once the agent has accepted the turn, which may be before the turn finishes. */
  prompt(text: string, stillPending?: () => boolean): Promise<boolean>;
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
  if (findInstalls().some((install) => install.agent === agent)) return [];
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
  if (argv1 && /(?:^|[/\\])(?:telepathy|cli)\.(?:mjs|ts|js)$/.test(argv1)) return { file: path.resolve(argv1), viaCli: true };
  const beside = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugin/dist/server.mjs');
  if (fs.existsSync(beside)) return { file: beside, viaCli: false };
  return { file: path.resolve(argv1 ?? 'telepathy'), viaCli: true };
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

function relevantUpdate(params: unknown): boolean {
  const root = (params ?? {}) as { update?: { sessionUpdate?: string; status?: string } };
  const update = root.update ?? (params as { sessionUpdate?: string; status?: string });
  const kind = update?.sessionUpdate;
  if (textOf(params).trim()) return true;
  return kind === 'agent_message' || kind === 'agent_message_chunk' || kind === 'user_message' || kind === 'running' || update?.status === 'running';
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

/**
 * Spawns an ACP agent and speaks initialize / session/new|load / session/prompt.
 * A prompt counts as accepted on the RPC result or on the first agent update after the request,
 * so a long turn can still confirm inside the 110s window.
 * `stillPending` is checked again immediately before `session/prompt`. A send that `fail()` already withdrew
 * is not submitted. A prompt already on the wire and not yet accepted is cancelled.
 */
export async function startAcpSession(options: AcpLaunch): Promise<AcpSession> {
  const child = spawn(options.bin, options.args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => options.trace?.(chunk.toString()));
  const exited = new Promise<number>((resolve) => {
    child.on('error', () => resolve(127));
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });

  let ask: ((line: string) => void) | undefined;
  const permission = async (params: unknown): Promise<boolean> => {
    if (options.headless || !process.stdin.isTTY) {
      if (process.env.TELEPATHY_HEADLESS_APPROVE === '1') return true;
      if (!options.headless && !process.stdin.isTTY) {
        options.emit('permission requested. Reply y or n.');
        const line = await new Promise<string>((resolve) => {
          ask = resolve;
        });
        return /^y(es)?$/i.test(line.trim());
      }
      options.emit('permission rejected. Set TELEPATHY_HEADLESS_APPROVE=1 to allow once.');
      return false;
    }
    options.emit('permission requested. Reply y or n.');
    const line = await new Promise<string>((resolve) => {
      ask = resolve;
    });
    return /^y(es)?$/i.test(line.trim());
  };

  let onUpdate: (params: unknown) => void = (params) => {
    const text = textOf(params).trim();
    if (text) options.emit(text);
  };

  const rpc = new LineRpc(
    child,
    async (method, params, id) => {
      if (method !== 'session/request_permission') {
        rpc.fail(id, `telepathy does not handle ${method}`);
        return;
      }
      const allow = await permission(params);
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

  let session: AcpSession | undefined;
  if (!options.headless) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (ask) {
        const answer = ask;
        ask = undefined;
        answer(line);
        return;
      }
      const text = line.trim();
      if (text && session) void session.prompt(text);
    });
    rl.on('close', () => session?.close());
  }

  await rpc.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'telepathy', version: VERSION },
  });

  const mcpServers = telepathyMcpServers(options.agent);
  let sessionId = options.resumeSessionId;
  if (sessionId) {
    try {
      const loaded = await rpc.request('session/load', { sessionId, cwd: options.cwd, mcpServers });
      sessionId = sessionIdOf(loaded) ?? sessionId;
    } catch {
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    const created = await rpc.request('session/new', { cwd: options.cwd, mcpServers });
    sessionId = sessionIdOf(created);
  }
  if (!sessionId) {
    child.kill('SIGTERM');
    throw new Error(`${options.bin} did not return a session id`);
  }
  options.emit(`session ${sessionId}`);

  let tail: Promise<void> = Promise.resolve();
  session = {
    sessionId,
    child,
    prompt(text: string, stillPending: () => boolean = () => true): Promise<boolean> {
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
        if (!stillPending()) {
          finish(false);
          return;
        }
        const previous = onUpdate;
        let sent = false;
        let cancelSent = false;
        const cancel = () => {
          if (cancelSent || !sent || settled) return;
          cancelSent = true;
          rpc.notify('session/cancel', { sessionId });
        };
        const watch = setInterval(() => {
          if (!settled && sent && !stillPending()) cancel();
        }, 25);
        onUpdate = (params) => {
          previous(params);
          if (relevantUpdate(params) && stillPending()) finish(true);
        };
        try {
          sent = true;
          if (!stillPending()) {
            finish(false);
            return;
          }
          await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
          if (stillPending()) finish(true);
          else {
            cancel();
            finish(false);
          }
        } catch {
          finish(false);
        } finally {
          clearInterval(watch);
          onUpdate = previous;
        }
      });
      tail = job.then(
        () => {},
        () => {},
      );
      return accepted;
    },
    close() {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    },
    exited,
  };
  return session;
}
