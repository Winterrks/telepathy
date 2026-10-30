import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNewer, installsInScope } from './core/installs.ts';
import { configuredEnv, ensureDir, readJson, stateDir, writeJsonAtomic } from './core/paths.ts';
import { isAlive } from './core/proc.ts';
import { updateAll } from './update-all.ts';
import { latestGithubVersion, rememberGithubVersion } from './version-check.ts';

/**
 * Opt-out auto-update. On unless `telepathy config auto-update off` or `TELEPATHY_AUTO_UPDATE` is
 * `0` / `off` / `false` / `no`. The env var wins, so a test sandbox can force it off without a config file.
 */
export function autoUpdateEnabled(): boolean {
  const env = configuredEnv('TELEPATHY_AUTO_UPDATE')?.toLowerCase();
  if (env === '0' || env === 'off' || env === 'false' || env === 'no') return false;
  if (env === '1' || env === 'on' || env === 'true' || env === 'yes') return true;
  const cfg = readJson<{ autoUpdate?: unknown }>(path.join(stateDir(), 'config.json'));
  if (typeof cfg?.autoUpdate === 'boolean') return cfg.autoUpdate;
  return true;
}

export function setAutoUpdate(on: boolean): void {
  const file = path.join(stateDir(), 'config.json');
  const cfg = readJson<Record<string, unknown>>(file) ?? {};
  cfg.autoUpdate = on;
  writeJsonAtomic(file, cfg);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const stampFile = () => path.join(stateDir(), 'auto-update.json');
const lockFile = () => path.join(stateDir(), 'auto-update.lock');
const logFile = () => path.join(stateDir(), 'auto-update.log');

interface Stamp {
  checkedAt: string;
}

interface Lock {
  pid: number;
  at: string;
}

export function autoUpdateCheckedAt(): string | undefined {
  return readJson<Stamp>(stampFile())?.checkedAt;
}

function recentlyChecked(): boolean {
  const at = Date.parse(autoUpdateCheckedAt() ?? '');
  return Number.isFinite(at) && Date.now() - at < DAY_MS;
}

/** Failures stay off the session's stdout. The log is under `TELEPATHY_HOME`. */
export function logAutoUpdate(line: string): void {
  try {
    ensureDir(stateDir());
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // a log failure must not surface in the session
  }
}

function autoUpdateEntry(): string {
  const override = process.env.TELEPATHY_AUTO_UPDATE_ENTRY;
  if (override) return override;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['hook.mjs', 'hook.ts']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return fileURLToPath(import.meta.url);
}

/**
 * Starts a detached check when one is due. Returns immediately. The session start hook and the MCP server
 * both call this; the lock and the 24h stamp keep them from updating twice.
 */
export function scheduleAutoUpdate(reason: string): void {
  try {
    if (process.argv.includes('--telepathy-auto-update')) return;
    if (!autoUpdateEnabled()) return;
    if (recentlyChecked()) return;
    const child = spawn(process.execPath, [autoUpdateEntry(), '--telepathy-auto-update'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, TELEPATHY_HOME: stateDir() },
    });
    child.on('error', (err) => logAutoUpdate(`spawn failed (${reason}): ${err.message}`));
    child.unref();
  } catch (err) {
    logAutoUpdate(`schedule failed (${reason}): ${(err as Error).message}`);
  }
}

function acquireLock(): boolean {
  ensureDir(stateDir());
  try {
    const fd = fs.openSync(lockFile(), 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() } satisfies Lock));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    const info = readJson<Lock>(lockFile());
    const age = Date.now() - Date.parse(info?.at ?? '');
    const alive = typeof info?.pid === 'number' && isAlive(info.pid);
    if (alive && Number.isFinite(age) && age < 60 * 60 * 1000) return false;
    try {
      fs.rmSync(lockFile(), { force: true });
    } catch {
      return false;
    }
    return acquireLock();
  }
}

function releaseLock(): void {
  const info = readJson<Lock>(lockFile());
  if (info?.pid === process.pid) fs.rmSync(lockFile(), { force: true });
}

/**
 * One check: stamp first (a failure still counts toward the 24h), then update when GitHub is newer.
 * Quiet. The caller is already a detached process.
 */
export async function runAutoUpdate(): Promise<void> {
  if (!autoUpdateEnabled()) {
    logAutoUpdate('skipped: auto-update disabled');
    return;
  }
  if (!acquireLock()) {
    logAutoUpdate('skipped: another check holds the lock');
    return;
  }
  try {
    if (recentlyChecked()) {
      logAutoUpdate('skipped: checked within 24h');
      return;
    }
    writeJsonAtomic(stampFile(), { checkedAt: new Date().toISOString() } satisfies Stamp);
    let latest: string;
    try {
      latest = await latestGithubVersion();
      rememberGithubVersion(latest);
    } catch (err) {
      logAutoUpdate(`version check failed: ${(err as Error).message}`);
      return;
    }
    const installs = installsInScope();
    const stale = installs.filter((install) => isNewer(latest, install.version));
    if (!stale.length) {
      logAutoUpdate(`current ${latest}; ${installs.length} install(s)`);
      return;
    }
    logAutoUpdate(`updating ${stale.map((install) => `${install.agent} ${install.version}`).join(', ')} toward ${latest}`);
    const lines: string[] = [];
    const code = await updateAll({ log: (line) => lines.push(line) });
    if (lines.length) logAutoUpdate(lines.join('\n'));
    if (code !== 0) logAutoUpdate(`update exited ${code}`);
  } catch (err) {
    logAutoUpdate(`failed: ${(err as Error).message}`);
  } finally {
    releaseLock();
  }
}
