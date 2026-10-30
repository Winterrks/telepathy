import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A harness that does not expand `${VAR}` forwards the token as the value. That is unset. */
const UNEXPANDED = /^\$\{[^}]+\}$/;

/**
 * Drops env values that are still `${...}` tokens. A literal assignment shadows a real inherited
 * value, so the server, hook, sidecar, and CLI all treat it as missing.
 */
export function scrubPlaceholderEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && UNEXPANDED.test(value.trim())) delete env[key];
  }
}

scrubPlaceholderEnv();

/** The variable's value, or undefined when it is missing, blank, or an unexpanded `${...}` token. */
export function configuredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  if (!value || UNEXPANDED.test(value)) return undefined;
  return value;
}

/**
 * A millisecond duration from the environment. Missing, blank, whitespace, non-finite, and
 * non-positive values are unset, so the default stands. `${VAR:-}` arrives as `""`, and
 * `Number("")` is `0`, which must not become a zero timeout.
 */
export function envDurationMs(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Root of all shared state. Every agent session on this machine reads and writes here. */
export function stateDir(): string {
  return configuredEnv('TELEPATHY_HOME') || path.join(os.homedir(), '.telepathy');
}

export const peersDir = () => path.join(stateDir(), 'peers');
export const peerDir = (id: string) => path.join(peersDir(), id);
export const inboxDir = (id: string) => path.join(peerDir(id), 'inbox');
export const archiveDir = (id: string) => path.join(peerDir(id), 'archive');
/** Inbox files pulled back because delivery was not confirmed. Not a successful claim. */
export const withdrawnDir = (id: string) => path.join(peerDir(id), 'withdrawn');

/** Creates a directory (and parents) readable only by the current OS user. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Writes JSON atomically: readers never observe a half-written file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
