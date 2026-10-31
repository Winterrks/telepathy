import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Set by the test sandbox. Production never sets it, so a real Codex install still runs. */
export function inTestSandbox(): boolean {
  return process.env.TELEPATHY_SANDBOX === '1';
}

function realpathOr(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** First executable `cmd` on PATH, or `cmd` itself when it is already a path. */
export function resolveOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cmd.includes('/') || cmd.includes('\\')) {
    const abs = path.resolve(cmd);
    return fs.existsSync(abs) ? abs : undefined;
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A sandboxed test may run its own fakes (under the temp dir, or `TELEPATHY_CODEX_BIN`).
 * It may not run the machine's Codex, Claude, or any other binary outside that temp dir:
 * those write `~/.codex/config.toml` and the rest of the real profile.
 */
export function sandboxAllowsExecutable(file: string): boolean {
  if (!inTestSandbox()) return true;
  const resolved = realpathOr(file);
  const configured = process.env.TELEPATHY_CODEX_BIN;
  if (configured && realpathOr(configured) === resolved) return true;
  const tmp = realpathOr(os.tmpdir());
  return resolved === tmp || resolved.startsWith(tmp + path.sep);
}

/** Why `cmd` must not be spawned, when this process is a test sandbox. */
export function sandboxSpawnBlock(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!inTestSandbox()) return undefined;
  const resolved = resolveOnPath(cmd, env);
  if (!resolved || sandboxAllowsExecutable(resolved)) return undefined;
  return `refusing to run ${resolved} from a test sandbox`;
}
