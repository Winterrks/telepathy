import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentLabel } from './core/agents.ts';
import { findInstalls, type Install, isOpencodeNpmInstall } from './core/installs.ts';

/**
 * Updates telepathy in every agent on this machine that has it installed, each with the agent's own update
 * command:
 *   node update-all.mjs [--dry-run]
 * Unlike the plugin itself, this needs the network: the agents fetch the new version from GitHub. Gemini CLI and
 * Qwen Code ask to confirm every update of a third-party extension; running this answers yes to such prompts. Running sessions
 * keep the version they started with until they restart.
 */

interface Step {
  cmd: string;
  args: string[];
}

const REPO = 'https://github.com/Winterrks/telepathy';
const STEP_TIMEOUT_MS = 180_000;

/** The commands that update one agent's copy, or `cache` for agents that reinstall from a cleared package cache. */
function stepsFor(install: Install): Step[] | 'cache' {
  const marketplace = install.marketplace ?? 'telepathy';
  switch (install.agent) {
    case 'claude':
      return [
        { cmd: 'claude', args: ['plugin', 'marketplace', 'update', marketplace] },
        { cmd: 'claude', args: ['plugin', 'update', `telepathy@${marketplace}`] },
      ];
    case 'codex':
      return [{ cmd: 'codex', args: ['plugin', 'marketplace', 'upgrade', marketplace] }];
    case 'gemini':
    case 'qwen':
      return [{ cmd: install.agent, args: ['extensions', 'update', 'telepathy'] }];
    case 'copilot':
      return [{ cmd: 'copilot', args: ['plugin', 'update', `telepathy@${marketplace}`] }];
    case 'devin':
      return [{ cmd: 'devin', args: ['plugins', 'update', 'telepathy'] }];
    case 'antigravity':
      return [{ cmd: 'agy', args: ['plugin', 'install', `${REPO}/tree/main/antigravity`] }];
    case 'opencode':
      // OpenCode 2 updates package plugins itself; 1.x reinstalls from a cleared cache.
      return isOpencodeNpmInstall(install) ? [{ cmd: 'opencode', args: ['plugin', 'update', `telepathy@git+${REPO}.git`] }] : 'cache';
    default:
      return 'cache';
  }
}

/** Runs one step, answering "y" to any confirmation prompt (Gemini and Qwen ask on every update). */
export function runHarnessCommand({ cmd, args }: Step, cwd = os.homedir()): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), STEP_TIMEOUT_MS);
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.stdin.on('error', () => {}); // the command may exit without reading
    child.stdin.write('y\n'.repeat(20));
    child.stdin.end();
    child.on('error', (err) => {
      clearTimeout(timer);
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      resolve({ ok: false, output: missing ? `\`${cmd}\` is not on PATH` : err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: code === null ? `timed out after ${STEP_TIMEOUT_MS / 1000}s` : output });
    });
  });
}

/** OpenCode and Kilo Code reinstall the package when it's gone from their cache and they load their config. */
async function refreshPackageCache(install: Install): Promise<{ ok: boolean; output: string }> {
  const packages = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), install.agent, 'packages');
  const relative = path.relative(packages, install.dir).split(path.sep);
  // OpenCode: packages/telepathy@…/…; Kilo Code: packages/git/<repo folder>.
  const entry = path.join(packages, ...(install.agent === 'kilo' ? relative.slice(0, 2) : relative.slice(0, 1)));
  // Outside the package folder, so the old copy can't be mistaken for the reinstalled one.
  const aside = path.join(path.dirname(packages), `.telepathy-update-${Date.now()}`);
  fs.renameSync(entry, aside);
  const result = await runHarnessCommand({ cmd: install.agent, args: ['debug', 'config'] });
  const reinstalled = findInstalls().find((i) => i.agent === install.agent);
  if (reinstalled) {
    fs.rmSync(aside, { recursive: true, force: true });
    return { ok: true, output: result.output };
  }
  fs.rmSync(entry, { recursive: true, force: true });
  fs.renameSync(aside, entry); // put the old copy back rather than leave the agent without one
  return { ok: false, output: `it didn't reinstall telepathy, so the old copy was kept. ${result.output}` };
}

const lastLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim())
    .filter(Boolean)
    .at(-1) ?? '';

export interface UpdateAllOptions {
  dryRun?: boolean;
  /**
   * Receives each line that would have gone to stdout, without a trailing newline.
   * Unset, the script prints exactly as `node update-all.mjs` always has.
   */
  log?: (line: string) => void;
}

/** Updates every install. Returns 0 when every harness updated, 1 when any failed or none were found. */
export async function updateAll(options: UpdateAllOptions = {}): Promise<number> {
  const dryRun = options.dryRun === true;
  const log = options.log;
  const say = (line: string) => (log ? log(line) : console.log(line));
  const before = findInstalls();
  if (!before.length) {
    say('No agent on this machine has telepathy installed.');
    return 0;
  }
  say(`telepathy is installed in: ${before.map((i) => `${agentLabel(i.agent)} ${i.version}`).join(', ')}.`);
  if (dryRun) {
    for (const install of before) {
      const steps = stepsFor(install);
      const how =
        steps === 'cache'
          ? `clear its package cache and run \`${install.agent} debug config\` to reinstall`
          : steps.map((s) => `\`${[s.cmd, ...s.args].join(' ')}\``).join(', then ');
      say(`- ${agentLabel(install.agent)}: ${how}`);
    }
    return 0;
  }

  const failures: string[] = [];
  for (const install of before) {
    if (log) log(`Updating ${agentLabel(install.agent)}…`);
    else process.stdout.write(`Updating ${agentLabel(install.agent)}… `);
    const steps = stepsFor(install);
    let result = { ok: true, output: '' };
    if (steps === 'cache') result = await refreshPackageCache(install);
    else for (const step of steps) if ((result = await runHarnessCommand(step)).ok === false) break;
    if (result.ok) say('done');
    else {
      say(`failed: ${lastLine(result.output)}`);
      failures.push(agentLabel(install.agent));
    }
  }

  const after = findInstalls();
  say('\nInstalled versions:');
  for (const install of before) {
    const now = after.find((i) => i.agent === install.agent)?.version ?? 'not found';
    say(`- ${agentLabel(install.agent)}: ${install.version === now ? now : `${install.version} → ${now}`}`);
  }
  say(
    '\nSessions that are already running keep the version they started with: restart them to load the update. ' +
      'Running Codex sessions show "Hook failed" after tool calls until they restart, because the update replaces ' +
      'the folder their hooks run from.',
  );
  if (failures.length) {
    say(`\nNot updated: ${failures.join(', ')}. Run their own update command to see why.`);
    return 1;
  }
  return 0;
}

/** True when this file is the process entry (`node update-all.mjs`), not a bundled import. */
function invokedAsUpdateAll(): boolean {
  const entry = process.argv[1] ?? '';
  return /(?:^|[/\\])update-all\.(?:mjs|ts|js)$/.test(entry);
}

if (invokedAsUpdateAll()) {
  const code = await updateAll({ dryRun: process.argv.includes('--dry-run') });
  if (code !== 0) process.exitCode = code;
}
