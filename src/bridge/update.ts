import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { envDurationMs } from '../core/paths.ts';

/**
 * What a bridge says about its own version inside its authenticated answers, so the devices that reach each
 * other update together and restart into a new version at the same moment.
 */
export interface BridgeInfo {
  /** The version this bridge runs. */
  version: string;
  /** The version installed where this bridge restarts from, when that is not the one it runs. */
  installed?: string;
  /** False when that device's user turned auto-update off: it will not update because another device did. */
  autoUpdate: boolean;
  /** Milliseconds until this bridge restarts into `installed`, once it has picked a moment. */
  restartInMs?: number;
}

const VERSION_TEXT = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION_TEXT.test(value);

/** How long a bridge with a new version installed waits for the devices it reaches to have it too. */
export const restartWaitMs = () => envDurationMs('TELEPATHY_BRIDGE_RESTART_WAIT_MS', 10 * 60_000);
const MAX_RESTART_IN_MS = 10 * 60_000;

/** Another device's `BridgeInfo`, checked field by field. A bridge before 0.11.2 sends none. */
export function parseBridgeInfo(raw: unknown): BridgeInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  if (!isVersion(input.version)) return undefined;
  const restartInMs = Number(input.restartInMs);
  return {
    version: input.version,
    installed: isVersion(input.installed) && input.installed !== input.version ? input.installed : undefined,
    autoUpdate: input.autoUpdate !== false,
    restartInMs:
      input.restartInMs !== undefined && Number.isFinite(restartInMs) && restartInMs >= 0 && restartInMs <= MAX_RESTART_IN_MS
        ? restartInMs
        : undefined,
  };
}

const signature = (file: string) => {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
};

/**
 * Watches the file this bridge runs from. An update (`npm install -g telepathy-cli`, `telepathy update`, the
 * auto-update) replaces it in place. Once it has stopped changing for one interval, the bridge asks the new file
 * for its version with `--version` and reports it. The file as it is at start is the version running now.
 */
export function watchInstall(entry: string, onVersion: (version: string) => void): () => void {
  let seen = signature(entry);
  let probed = seen;
  let probing = false;
  const tick = () => {
    const now = signature(entry);
    if (!now || probing) return;
    if (now !== seen) {
      seen = now;
      return;
    }
    if (now === probed) return;
    probing = true;
    execFile(
      process.execPath,
      [...process.execArgv, entry, '--version'],
      { timeout: 20_000, env: { ...process.env, TELEPATHY_AUTO_UPDATE: '0' } },
      (err, stdout) => {
        probing = false;
        const version = String(stdout ?? '').trim().split('\n').at(-1)?.trim();
        // A file still being written fails here; the next tick asks again.
        if (err || !isVersion(version)) return;
        probed = now;
        onVersion(version);
      },
    );
  };
  const timer = setInterval(tick, envDurationMs('TELEPATHY_BRIDGE_INSTALL_CHECK_MS', 10_000));
  return () => clearInterval(timer);
}
