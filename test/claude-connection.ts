import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { DIST, killAndWait } from './helpers.ts';

const TASKS = 'io.modelcontextprotocol/tasks';

interface Reply {
  result?: Record<string, any>;
  error?: { code: number; message: string };
}

/**
 * A Claude Code session's MCP connection the way Claude Code 2.1.316 opens it: `server/discover` on protocol
 * revision 2026-07-28, then every request with the per-request envelope, which declares the tasks extension.
 */
export function claudeConnection(env: Record<string, string>) {
  const child = spawn(process.execPath, [path.join(DIST, 'server.mjs'), '--agent', 'claude'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, (reply: Reply) => void>();
  let buffer = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === 'number' && pending.has(message.id)) {
        pending.get(message.id)!(message);
        pending.delete(message.id);
      }
    }
  });
  const envelope = (tasks: boolean) => ({
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.316' },
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} }, ...(tasks ? { extensions: { [TASKS]: {} } } : {}) },
  });
  const request = (method: string, params: Record<string, unknown> = {}, tasks = true) =>
    new Promise<Reply>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: envelope(tasks) } }) + '\n');
    });
  const call = (name: string, args: Record<string, unknown>, tasks = true) => request('tools/call', { name, arguments: args }, tasks);
  /** Polls the task the way Claude Code does until it leaves `working`. */
  const settle = async (taskId: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const reply = await request('tasks/get', { taskId });
      if (reply.result?.status !== 'working' || Date.now() > deadline) return reply.result!;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  /** Ends the connection the way Claude Code does at exit: its end of stdin closes. */
  const close = async () => {
    child.stdin.end();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await killAndWait(child as ChildProcess & { pid: number });
  };
  return { child, request, call, settle, close };
}

