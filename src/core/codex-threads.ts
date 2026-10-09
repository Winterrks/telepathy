import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Codex holds `<codexHome>/thread-writer-locks/<thread id>.lock` open in the process that has the thread loaded (the
 * app-server daemon behind terminal sessions, the ChatGPT app, or a Codex CLI of its own), and removes it when the
 * thread is unloaded. The lock moves to the new daemon when Codex updates it, so it tells whether a thread is still
 * running whichever process hosts it. Like the rollout log, it isn't a documented interface: anything unexpected
 * yields undefined, and callers fall back to the process that registered the thread.
 */
const locksDir = (codexHome: string) => path.join(codexHome, 'thread-writer-locks');

let cache: { at: number; key: string; held: Set<string> | undefined } | undefined;

/**
 * Thread ids whose lock file some process holds open, from one `lsof` call; undefined when lsof can't tell. Cached for
 * a second while the same lock files exist, because listing peers asks for every Codex thread.
 */
function heldLocks(dir: string, maxAgeMs = 1000): Set<string> | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.lock') && !f.startsWith('.'));
  } catch {
    return undefined;
  }
  const key = `${dir}\n${files.sort().join('\n')}`;
  if (cache && cache.key === key && Date.now() - cache.at < maxAgeMs) return cache.held;
  let held: Set<string> | undefined;
  try {
    if (!files.length) {
      held = new Set();
    } else {
      // lsof exits 1 when it lists nothing, so read its output either way.
      let out: string;
      try {
        out = execFileSync('lsof', ['-F', 'n', '--', ...files], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (err) {
        const e = err as { stdout?: string; code?: string; status?: number };
        if (e.code === 'ENOENT' || e.status !== 1) throw err;
        out = e.stdout ?? '';
      }
      held = new Set(
        out
          .split('\n')
          .filter((l) => l.startsWith('n'))
          .map((l) => path.basename(l.slice(1)).replace(/\.lock$/, '')),
      );
    }
  } catch {
    held = undefined;
  }
  cache = { at: Date.now(), key, held };
  return held;
}

/**
 * Whether a Codex process has the thread loaded: its lock file exists and, when lsof can tell, a process holds it.
 * Undefined when this Codex keeps no writer locks.
 */
export function codexThreadLoaded(codexHome: string, threadId: string): boolean | undefined {
  const dir = locksDir(codexHome);
  if (!fs.existsSync(dir)) return undefined;
  if (!fs.existsSync(path.join(dir, `${threadId}.lock`))) return false;
  return heldLocks(dir)?.has(threadId) ?? true;
}
