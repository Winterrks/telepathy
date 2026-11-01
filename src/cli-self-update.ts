import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isNewer } from './core/installs.ts';
import { inTestSandbox } from './core/sandbox-launch.ts';
import { runHarnessCommand } from './update-all.ts';

/**
 * The `telepathy` command is the npm package `telepathy-cli`. The agents' plugins update from GitHub; the CLI only
 * from npm. When a global npm install of it exists, auto-update and `telepathy update` move it to npm's `latest`.
 * A copy run from a checkout, `npx`, or a test sandbox is not touched.
 */

const PACKAGE = 'telepathy-cli';
const registry = () => (process.env.TELEPATHY_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');

/** `<npm root -g>/telepathy-cli`, when npm has it installed globally. */
export function globalCliDir(): string | undefined {
  if (inTestSandbox()) return undefined;
  let root: string;
  try {
    root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
  const dir = path.join(root, PACKAGE);
  try {
    const name = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
    return name === PACKAGE ? dir : undefined;
  } catch {
    return undefined;
  }
}

function installedVersion(dir: string): string | undefined {
  try {
    const version = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

export async function latestCliVersion(): Promise<string> {
  const res = await fetch(`${registry()}/${PACKAGE}/latest`, { signal: AbortSignal.timeout(8_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const version = ((await res.json()) as { version?: unknown }).version;
  if (typeof version !== 'string' || !version.trim()) throw new Error('npm registry has no version for telepathy-cli');
  return version.trim();
}

/**
 * Updates the global `telepathy-cli` when npm has a newer one. Returns a line for the log, or undefined when there
 * is no global install to update. Never throws.
 */
export async function updateGlobalCli(options: { dryRun?: boolean } = {}): Promise<{ ok: boolean; line: string } | undefined> {
  const dir = globalCliDir();
  if (!dir) return undefined;
  const current = installedVersion(dir);
  let latest: string;
  try {
    latest = await latestCliVersion();
  } catch (err) {
    return { ok: false, line: `telepathy CLI: could not check npm (${(err as Error).message})` };
  }
  if (current && !isNewer(latest, current)) return { ok: true, line: `telepathy CLI: ${current}, current` };
  if (options.dryRun) return { ok: true, line: `telepathy CLI: \`npm install -g ${PACKAGE}@${latest}\` (installed ${current ?? 'unknown'})` };
  const result = await runHarnessCommand({ cmd: 'npm', args: ['install', '-g', `${PACKAGE}@${latest}`] });
  if (!result.ok) {
    const tail = result.output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? 'failed';
    return { ok: false, line: `telepathy CLI: npm install -g ${PACKAGE}@${latest} failed: ${tail}` };
  }
  return { ok: true, line: `telepathy CLI: ${current ?? 'unknown'} → ${installedVersion(dir) ?? latest}` };
}
