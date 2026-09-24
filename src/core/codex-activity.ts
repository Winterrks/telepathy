import fs from 'node:fs';
import path from 'node:path';

const TAIL_BYTES = 1024 * 1024;
const TURN_EVENTS: Record<string, 'busy' | 'idle'> = { task_started: 'busy', task_complete: 'idle', turn_aborted: 'idle' };

/** Codex writes each thread to `<codexHome>/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`. */
function findRollout(codexHome: string, threadId: string): string | undefined {
  const suffix = `-${threadId}.jsonl`;
  const sorted = (dir: string) => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  const root = path.join(codexHome, 'sessions');
  // Newest day first: a live thread's file is almost always in one of the latest folders.
  for (const year of sorted(root)) {
    for (const month of sorted(path.join(root, year))) {
      for (const day of sorted(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day);
        const file = sorted(dir).find((f) => f.startsWith('rollout-') && f.endsWith(suffix));
        if (file) return path.join(dir, file);
      }
    }
  }
  return undefined;
}

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text; // drop the partial first line
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Best effort: whether a Codex thread is in the middle of a turn, from the last turn event in its rollout
 * log. The rollout format isn't a documented interface, so anything unexpected yields undefined.
 */
export function codexActivity(codexHome: string, threadId: string): 'busy' | 'idle' | undefined {
  try {
    const file = findRollout(codexHome, threadId);
    if (!file) return undefined;
    const lines = readTail(file).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"event_msg"')) continue;
      let entry: { type?: string; payload?: { type?: string } };
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue; // e.g. a line still being written
      }
      const state = entry.type === 'event_msg' ? TURN_EVENTS[entry.payload?.type ?? ''] : undefined;
      if (state) return state;
    }
  } catch {
    // unreadable file: no status
  }
  return undefined;
}
