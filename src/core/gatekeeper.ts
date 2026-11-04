import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { envDurationMs } from './paths.ts';
import { sandboxAllowsExecutable } from './sandbox-launch.ts';

/**
 * macOS can hold a downloaded program at launch until someone approves it on the Mac's screen. Homebrew casks
 * (claude-code, codex…) arrive with the `com.apple.quarantine` attribute, and a held program started from the
 * background or over SSH waits for that answer: an update step that runs it never returns. Not every program with
 * the attribute is held (one macOS already let run starts at once), so a quarantined program counts as held only
 * when it also doesn't answer `--version` in time. telepathy checks before it runs an agent's program in the
 * background, so it can say why instead of timing out.
 */

/** QTN_FLAG_USER_APPROVED: set in the attribute's flags once someone has approved the file. */
const USER_APPROVED = 0x0040;

const probeMs = () => envDurationMs('TELEPATHY_GATEKEEPER_PROBE_MS', 15_000);

/** The file `cmd` runs from, found on PATH the way a spawn finds it (or as given), with symlinks resolved. */
export function executablePath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = cmd.includes('/') ? [cmd] : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, cmd));
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return fs.realpathSync(file);
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The file `cmd` runs from, when it still has a quarantine flag nobody approved. */
export function unapprovedDownload(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const file = executablePath(cmd, env);
  if (!file) return undefined;
  let value: string;
  try {
    value = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
  } catch {
    return undefined; // no such attribute
  }
  const flags = Number.parseInt(value.trim().split(';')[0] ?? '', 16);
  return Number.isFinite(flags) && (flags & USER_APPROVED) === 0 ? file : undefined;
}

/** Whether `file --version` is still running after the probe time. Once per file per process. */
const probes = new Map<string, Promise<boolean>>();
function doesNotAnswer(file: string): Promise<boolean> {
  let probe = probes.get(file);
  if (!probe) {
    probe = new Promise((resolve) => {
      const child = spawn(file, ['--version'], { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(true);
      }, probeMs());
      const done = () => {
        clearTimeout(timer);
        resolve(false);
      };
      child.on('exit', done);
      child.on('error', done); // the step itself reports that
    });
    probes.set(file, probe);
  }
  return probe;
}

/** The file macOS holds when `cmd` starts: quarantined, never approved, and it doesn't answer `--version`. */
export async function gatekeeperHold(cmd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = unapprovedDownload(cmd, env);
  if (!file || !sandboxAllowsExecutable(file)) return undefined;
  return (await doesNotAnswer(file)) ? file : undefined;
}

const shellWord = (file: string) => (/^[\w@%+=:,./-]+$/.test(file) ? file : `'${file.replace(/'/g, `'\\''`)}'`);

/** Why `cmd` (at `file`) doesn't run, and the two ways to let it, on one line. */
export function heldNote(cmd: string, file: string): string {
  return (
    `\`${cmd}\` didn't start within ${Math.max(1, Math.round(probeMs() / 1000))}s, and ${file} still has the quarantine flag it was ` +
    `downloaded with, so macOS is most likely holding it for an approval on this Mac's screen. Run \`${cmd} --version\` ` +
    `in Terminal on this Mac and click Open if macOS asks, or clear the flag with ` +
    `\`xattr -d com.apple.quarantine ${shellWord(file)}\`.`
  );
}
