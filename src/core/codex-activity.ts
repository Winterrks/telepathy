import fs from 'node:fs';
import path from 'node:path';

/** How far back to look for the last turn event: the last megabyte, then further when a big tool output hides it. */
const TAIL_STEPS = [1024 * 1024, 16 * 1024 * 1024];

/**
 * `interrupted`: the last turn was aborted (Esc). Codex 0.156 then holds `codex queue` messages until the user sends
 * the next prompt, so the session is idle but won't wake for a message.
 */
export type CodexActivity = 'busy' | 'idle' | 'interrupted';

const TURN_EVENTS: Record<string, CodexActivity> = { task_started: 'busy', task_complete: 'idle', turn_aborted: 'interrupted' };

/**
 * Codex writes each thread to `<codexHome>/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`, and a long
 * thread goes on in further segments, `rollout-<time>-<threadId>_<segmentId>.jsonl`. The newest one is current.
 */
function findRollout(codexHome: string, threadId: string): string | undefined {
  const isRollout = (f: string) =>
    f.startsWith('rollout-') && (f.endsWith(`-${threadId}.jsonl`) || (f.includes(`-${threadId}_`) && f.endsWith('.jsonl')));
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
        const file = sorted(dir).find(isRollout); // names start with the time, so the newest segment comes first
        if (file) return path.join(dir, file);
      }
    }
  }
  return undefined;
}

function readTail(file: string, bytes: number): { text: string; whole: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Drop the partial first line.
    return { text: start > 0 ? text.slice(text.indexOf('\n') + 1) : text, whole: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function lastTurnEvent(text: string): CodexActivity | undefined {
  const lines = text.split('\n');
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
  return undefined;
}

/**
 * Best effort: whether a Codex thread is in the middle of a turn, from the last turn event in its rollout
 * log. The rollout format isn't a documented interface, so anything unexpected yields undefined.
 */
export function codexActivity(codexHome: string, threadId: string): CodexActivity | undefined {
  try {
    const file = findRollout(codexHome, threadId);
    if (!file) return undefined;
    for (const bytes of TAIL_STEPS) {
      const { text, whole } = readTail(file, bytes);
      const state = lastTurnEvent(text);
      if (state || whole) return state;
    }
  } catch {
    // unreadable file: no status
  }
  return undefined;
}

/**
 * When Codex last recorded a response item in a thread's rollout log (a tool call's output, reasoning, a message).
 * While a permission prompt is open Codex logs only bookkeeping (token usage, other items completing), and answering
 * it logs the tool's output, or after a denial the model's next step, so a response item after the prompt means it is
 * over. Undefined when the log has no timestamped response item in its last 256 KB.
 */
export function codexLastResponse(codexHome: string, threadId: string): number | undefined {
  try {
    const file = findRollout(codexHome, threadId);
    if (!file) return undefined;
    const lines = readTail(file, 256 * 1024).text.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"response_item"')) continue;
      try {
        const entry = JSON.parse(lines[i]) as { type?: string; timestamp?: string };
        const at = Date.parse(entry.timestamp ?? '');
        if (entry.type === 'response_item' && !Number.isNaN(at)) return at;
      } catch {
        // a line still being written
      }
    }
  } catch {
    // unreadable file
  }
  return undefined;
}
