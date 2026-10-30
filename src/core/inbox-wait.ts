import fs from 'node:fs';
import path from 'node:path';
import { claimInbox, formatForReading, type Message } from './messages.ts';
import { ensureDir, inboxDir, peerDir } from './paths.ts';

export type WaitReason = 'message' | 'timeout' | 'cancelled';

export interface WaitResult {
  messages: Message[];
  reason: WaitReason;
}

/**
 * Claims this session's inbox, or waits until a message arrives, the timeout elapses, or the caller aborts.
 * `timeoutMs` <= 0 returns whatever is already waiting. A message already in the inbox wins over abort and timeout,
 * so a cancel never drops one that landed first.
 */
/**
 * Records that this wait handed the messages to the client. `send_message` confirms delivery only when
 * `telepathy-id:<id>` is in a transcript. Grok Bot has no harness transcript, so the line this call returns
 * is written where the hosted inbox pump writes its acceptance. A withdrawn or expired id never reaches here:
 * `claimInbox` drops those, so a failed send cannot be returned by a later wait.
 */
function recordAccepted(peerId: string, messages: Message[]): void {
  if (!messages.length) return;
  const file = path.join(ensureDir(peerDir(peerId)), 'delivery-transcript.jsonl');
  const chunk =
    messages.map((msg) => JSON.stringify({ at: new Date().toISOString(), text: formatForReading(msg) })).join('\n') + '\n';
  fs.appendFileSync(file, chunk);
}

export function waitForInbox(peerId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
  const ready = claimInbox(peerId);
  if (ready.length) {
    recordAccepted(peerId, ready);
    return Promise.resolve({ messages: ready, reason: 'message' });
  }
  if (signal?.aborted) return Promise.resolve({ messages: [], reason: 'cancelled' });
  if (timeoutMs <= 0) return Promise.resolve({ messages: [], reason: 'timeout' });

  return new Promise((resolve) => {
    let settled = false;
    let watcher: fs.FSWatcher | undefined;
    let poll: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (messages: Message[], reason: WaitReason) => {
      if (settled) return;
      settled = true;
      recordAccepted(peerId, messages);
      clearTimeout(timer);
      clearInterval(poll);
      try {
        watcher?.close();
      } catch {
        // already closed
      }
      signal?.removeEventListener('abort', onAbort);
      resolve({ messages, reason });
    };

    const check = () => {
      const messages = claimInbox(peerId);
      if (messages.length) finish(messages, 'message');
    };

    const onAbort = () => {
      const messages = claimInbox(peerId);
      finish(messages, messages.length ? 'message' : 'cancelled');
    };

    try {
      ensureDir(inboxDir(peerId));
      watcher = fs.watch(inboxDir(peerId), check);
      watcher.on('error', () => {
        try {
          watcher?.close();
        } catch {
          // already closed
        }
        watcher = undefined;
      });
    } catch {
      watcher = undefined; // the interval below still polls
    }

    poll = setInterval(check, 100);
    poll.unref();
    timer = setTimeout(() => {
      const messages = claimInbox(peerId);
      finish(messages, messages.length ? 'message' : 'timeout');
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
