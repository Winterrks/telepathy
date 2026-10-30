import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holdRepostDelayMs } from '../src/core/claude-socket.ts';
import { confirmAbortMs, confirmGraceMs, confirmPollMs } from '../src/core/confirm.ts';
import { socketWaitMs } from '../src/core/deliver.ts';
import { transientChildMs } from '../src/core/status.ts';
import { wakeDebounceMaxMs, wakeDebounceMs } from '../src/core/wake.ts';

const READERS: { name: string; read: () => number; fallback: number }[] = [
  { name: 'TELEPATHY_CONFIRM_ABORT_MS', read: confirmAbortMs, fallback: 100_000 },
  { name: 'TELEPATHY_CONFIRM_GRACE_MS', read: confirmGraceMs, fallback: 10_000 },
  { name: 'TELEPATHY_CONFIRM_POLL_MS', read: confirmPollMs, fallback: 200 },
  { name: 'TELEPATHY_SOCKET_WAIT_MS', read: socketWaitMs, fallback: 1_500 },
  { name: 'TELEPATHY_WAKE_DEBOUNCE_MS', read: wakeDebounceMs, fallback: 400 },
  { name: 'TELEPATHY_WAKE_DEBOUNCE_MAX_MS', read: wakeDebounceMaxMs, fallback: 1_500 },
  { name: 'TELEPATHY_HOLD_REPOST_DELAY_MS', read: holdRepostDelayMs, fallback: 2_000 },
  { name: 'TELEPATHY_TRANSIENT_CHILD_MS', read: transientChildMs, fallback: 2_000 },
];

function withEnv(values: Record<string, string | undefined>, body: () => void): void {
  const saved = Object.fromEntries(READERS.map(({ name }) => [name, process.env[name]]));
  for (const { name } of READERS) delete process.env[name];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('an empty duration env keeps the default at every call site', () => {
  for (const reader of READERS) {
    for (const blank of ['', '   ', '0', '-1', 'nope', 'NaN']) {
      withEnv({ [reader.name]: blank }, () => {
        assert.equal(reader.read(), reader.fallback, `${reader.name}=${JSON.stringify(blank)}`);
      });
    }
    withEnv({ [reader.name]: '2500' }, () => {
      const value = reader.read();
      assert.ok(value === 2500 || (reader.name === 'TELEPATHY_CONFIRM_POLL_MS' && value === 2500), reader.name);
      assert.equal(value, 2500, reader.name);
    });
  }
});
