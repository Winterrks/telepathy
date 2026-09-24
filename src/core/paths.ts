import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root of all shared state. Every agent session on this machine reads and writes here. */
export function stateDir(): string {
  return process.env.TELEPATHY_HOME || path.join(os.homedir(), '.telepathy');
}

export const peersDir = () => path.join(stateDir(), 'peers');
export const peerDir = (id: string) => path.join(peersDir(), id);
export const inboxDir = (id: string) => path.join(peerDir(id), 'inbox');
export const archiveDir = (id: string) => path.join(peerDir(id), 'archive');

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
