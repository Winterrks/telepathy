import { spawn } from 'node:child_process';
import os from 'node:os';
import { LineRpc } from '../acp/rpc.ts';
import { outsideIsolatedHome } from './installs.ts';
import { configuredEnv } from './paths.ts';
import { inTestSandbox, sandboxSpawnBlock } from './sandbox-launch.ts';
import { VERSION } from './version.ts';

/**
 * Codex asks once for each plugin hook, in `/hooks`. Since 0.166 the trusted hash covers the plugin's files too
 * (`<handler hash>/<content hash>`), so every telepathy update leaves its hooks `modified` until someone approves
 * them again. Codex's app-server has the same two calls its `/hooks` screen uses: `hooks/list` for the current hash
 * and `config/batchWrite`, which writes `trusted_hash` (and Codex itself splits out `trusted_content_hash`).
 * Telepathy never edits config.toml; Codex does the write.
 */

export type HookTrust = 'managed' | 'untrusted' | 'trusted' | 'modified';

export interface CodexHook {
  key: string;
  pluginId: string;
  eventName: string;
  trustStatus: HookTrust;
  currentHash: string;
}

export interface TrustResult {
  /** Keys trusted by this call. */
  trusted: CodexHook[];
  /** Telepathy hooks that were already trusted, or that this call was not allowed to trust. */
  left: CodexHook[];
  /** Set when Codex could not be asked. Nothing was written. */
  error?: string;
}

const timeoutMs = () => {
  const raw = Number(process.env.TELEPATHY_CODEX_HOOKS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
};

/** Same guard `runHarnessCommand` applies: a sandboxed test never reaches the real `~/.codex`. */
function codexBlocked(): string | undefined {
  const blocked = sandboxSpawnBlock('codex');
  if (blocked) return blocked;
  if (inTestSandbox()) {
    const home = configuredEnv('CODEX_HOME');
    if (!home || outsideIsolatedHome(home)) return `refusing to run codex outside the test sandbox (${home ?? 'CODEX_HOME unset'})`;
  }
  return undefined;
}

async function withAppServer<T>(fn: (rpc: LineRpc) => Promise<T>): Promise<T> {
  const blocked = codexBlocked();
  if (blocked) throw new Error(blocked);
  const child = spawn('codex', ['app-server'], { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {}); // Codex may exit before it reads
  const rpc = new LineRpc(
    child,
    (method, _params, id) => rpc.fail(id, `telepathy does not handle ${method}`),
    () => {},
  );
  let timer: NodeJS.Timeout | undefined;
  const failed = new Promise<never>((_, reject) => {
    child.on('error', (err) => {
      reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('`codex` is not on PATH') : err);
    });
    timer = setTimeout(() => reject(new Error(`codex app-server did not answer within ${Math.round(timeoutMs() / 1000)}s`)), timeoutMs());
  });
  const work = (async () => {
    await rpc.request('initialize', { clientInfo: { name: 'telepathy', version: VERSION }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    return fn(rpc);
  })();
  try {
    return await Promise.race([work, failed]);
  } finally {
    if (timer) clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

const isTelepathy = (hook: { pluginId?: unknown }) => typeof hook.pluginId === 'string' && hook.pluginId.startsWith('telepathy@');

async function listHooks(rpc: LineRpc): Promise<CodexHook[]> {
  const result = (await rpc.request('hooks/list', { cwds: [os.homedir()] })) as { data?: { hooks?: unknown[] }[] } | undefined;
  const seen = new Map<string, CodexHook>();
  for (const entry of result?.data ?? []) {
    for (const raw of entry.hooks ?? []) {
      const hook = raw as Partial<CodexHook>;
      if (!isTelepathy(hook) || typeof hook.key !== 'string' || typeof hook.currentHash !== 'string') continue;
      seen.set(hook.key, {
        key: hook.key,
        pluginId: hook.pluginId as string,
        eventName: String(hook.eventName ?? ''),
        trustStatus: (hook.trustStatus ?? 'untrusted') as HookTrust,
        currentHash: hook.currentHash,
      });
    }
  }
  return [...seen.values()];
}

/** Telepathy's plugin hooks as Codex sees them now. Read-only. */
export async function telepathyCodexHooks(): Promise<{ hooks: CodexHook[]; error?: string }> {
  try {
    return { hooks: await withAppServer(listHooks) };
  } catch (err) {
    return { hooks: [], error: (err as Error).message };
  }
}

/**
 * Trusts telepathy's own hooks whose status is in `statuses`. `telepathy setup` passes untrusted and modified;
 * auto-update passes only modified, so a hook the user never approved stays theirs to approve.
 */
export async function trustTelepathyCodexHooks(statuses: readonly HookTrust[]): Promise<TrustResult> {
  try {
    return await withAppServer(async (rpc) => {
      const hooks = await listHooks(rpc);
      const due = hooks.filter((hook) => statuses.includes(hook.trustStatus));
      const left = hooks.filter((hook) => !due.includes(hook));
      if (!due.length) return { trusted: [], left };
      const value = Object.fromEntries(due.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]));
      // One upsert of the `hooks.state` table: the keys hold dots, slashes and `@`, which a dotted keyPath can't.
      await rpc.request('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }], reloadUserConfig: true });
      const after = await listHooks(rpc);
      const trusted = due.filter((hook) => after.find((next) => next.key === hook.key)?.trustStatus === 'trusted');
      const missed = due.filter((hook) => !trusted.includes(hook));
      if (missed.length) {
        return { trusted, left: [...left, ...missed], error: `Codex still shows ${missed.map((h) => h.eventName || h.key).join(', ')} as not trusted` };
      }
      return { trusted, left };
    });
  } catch (err) {
    return { trusted: [], left: [], error: (err as Error).message };
  }
}

/** One line for a person: which hooks still need `/hooks`. */
export function describeHookState(hooks: CodexHook[]): string {
  if (!hooks.length) return 'Codex lists no telepathy hooks';
  const pending = hooks.filter((hook) => hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified');
  if (!pending.length) return `all ${hooks.length} telepathy hooks are trusted`;
  const modified = pending.filter((hook) => hook.trustStatus === 'modified').length;
  const reason = modified === pending.length ? 'changed since they were approved' : modified ? 'new or changed' : 'not approved yet';
  return `${pending.length} of ${hooks.length} telepathy hooks need approval (${reason})`;
}
