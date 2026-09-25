import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { debugLog } from './debug.ts';
import { archivePending, pendingMessages } from './messages.ts';
import { VERSION } from './version.ts';

const execFileAsync = promisify(execFile);

function codexCandidates(): string[] {
  const configured = process.env.TELEPATHY_CODEX_BIN;
  if (configured) return [configured];
  // MCP servers and hooks may run with a minimal PATH, so also try the usual install locations.
  return ['codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local', 'bin', 'codex')];
}

const codexEnv = (codexHome: string | undefined) => ({ ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) });

/**
 * Hands the text to Codex's own queue (`codex queue`), which starts a turn in the live session. Returns the
 * queued item's id, which `codex queue` prints, when it can be read.
 */
export async function queueIntoCodex(threadId: string, text: string, codexHome: string | undefined): Promise<string | undefined> {
  const args = ['queue', `--thread=${threadId}`, `--message=${text}`];
  let lastError: unknown;
  for (const bin of codexCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, args, { env: codexEnv(codexHome), timeout: 30_000, maxBuffer: 1024 * 1024 });
      return /Queued message (\S+) for thread/.exec(stdout)?.[1];
    } catch (err) {
      lastError = err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') break;
    }
  }
  const e = lastError as NodeJS.ErrnoException & { stderr?: string };
  if (e?.code === 'ENOENT') {
    throw new Error('The codex CLI was not found on PATH; set TELEPATHY_CODEX_BIN to its path.');
  }
  throw new Error(`codex queue failed: ${(e?.stderr || e?.message || String(e)).trim()}`);
}

/**
 * Removes items from a thread's queue through the Codex app server (`thread/queue/delete`, an experimental
 * method), so a message the session already read with read_messages doesn't come back as a turn. The running
 * session sees the change like any other queue edit. Returns, per id, whether it was still queued: false means
 * Codex already started a turn with it. Undefined when the app server couldn't be asked.
 */
export async function deleteFromCodexQueue(
  threadId: string,
  queueIds: string[],
  codexHome: string | undefined,
): Promise<Map<string, boolean> | undefined> {
  if (!queueIds.length) return new Map();
  for (const bin of codexCandidates()) {
    try {
      return await appServerDeletes(bin, threadId, queueIds, codexHome);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    }
  }
  return undefined;
}

function appServerDeletes(
  bin: string,
  threadId: string,
  queueIds: string[],
  codexHome: string | undefined,
): Promise<Map<string, boolean>> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server'], { env: codexEnv(codexHome), stdio: ['pipe', 'pipe', 'ignore'] });
    const results = new Map<string, boolean>();
    const finish = (err?: Error) => {
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(results);
    };
    const timer = setTimeout(() => finish(new Error('codex app-server timed out')), 10_000);
    child.on('error', (err) => finish(err));
    const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: { id?: number; result?: { deleted?: boolean }; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 0) {
        if (msg.error) return finish(new Error(msg.error.message ?? 'initialize failed'));
        send({ method: 'initialized' });
        queueIds.forEach((queuedSubmissionId, i) =>
          send({ id: i + 1, method: 'thread/queue/delete', params: { threadId, queuedSubmissionId } }),
        );
      } else if (typeof msg.id === 'number' && msg.id >= 1 && msg.id <= queueIds.length) {
        if (msg.error) return finish(new Error(msg.error.message ?? 'thread/queue/delete failed'));
        results.set(queueIds[msg.id - 1], msg.result?.deleted === true);
        if (results.size === queueIds.length) finish();
      }
    });
    send({
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'telepathy', version: VERSION }, capabilities: { experimentalApi: true } },
    });
  });
}

/**
 * Before read_messages in a Codex session: takes the unread messages back out of Codex's queue, so each
 * reaches the model once. A message whose queue item is gone was already delivered as a turn, so it's archived
 * instead of shown again. If the app server can't be asked, nothing changes and the queue delivers them too.
 */
export async function withdrawFromCodexQueue(selfId: string, threadId: string, codexHome: string | undefined): Promise<void> {
  const queued = pendingMessages(selfId).filter((m) => m.codexQueueId);
  const results = await deleteFromCodexQueue(
    threadId,
    queued.map((m) => m.codexQueueId as string),
    codexHome,
  );
  if (!results) {
    debugLog('codex-queue', `couldn't reach codex app-server; ${queued.length} message(s) stay queued as well`);
    return;
  }
  for (const msg of queued) {
    if (results.get(msg.codexQueueId as string) === false) archivePending(selfId, msg.id);
  }
}
