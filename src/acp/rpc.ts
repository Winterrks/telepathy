import type { ChildProcess } from 'node:child_process';

interface RpcError {
  message?: string;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio.
 * ACP agents and `codex app-server` both speak this. Responses, requests, and notifications share one stream.
 */
export class LineRpc {
  private nextId = 1;
  private buf = '';
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private readonly child: ChildProcess;
  private readonly onRequest: (method: string, params: unknown, id: number) => Promise<void> | void;
  private readonly onNotification: (method: string, params: unknown) => void;

  constructor(
    child: ChildProcess,
    onRequest: (method: string, params: unknown, id: number) => Promise<void> | void,
    onNotification: (method: string, params: unknown) => void,
  ) {
    this.child = child;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    child.stdout?.on('data', (chunk: Buffer) => this.feed(chunk.toString()));
    child.on('exit', () => this.failAll('agent exited'));
    child.on('error', (err) => this.failAll(err.message));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  respond(id: number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  fail(id: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }

  private send(msg: object): void {
    if (!this.child.stdin?.writable) {
      this.failAll('agent stdin is closed');
      return;
    }
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private failAll(message: string): void {
    for (const waiter of this.pending.values()) waiter.reject(new Error(message));
    this.pending.clear();
  }

  private feed(text: string): void {
    this.buf += text;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        void Promise.resolve(this.onRequest(msg.method, msg.params, msg.id)).catch((err: Error) => this.fail(msg.id as number, err.message));
      } else if (msg.method) {
        this.onNotification(msg.method, msg.params);
      } else if (msg.id !== undefined) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) continue;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message || 'request failed'));
        else waiter.resolve(msg.result);
      }
    }
  }
}
