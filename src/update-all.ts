import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentLabel } from './core/agents.ts';
import { findInstalls, type Install } from './core/installs.ts';

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
    default:
      return 'cache';
  }
}

/** Runs one step, answering "y" to any confirmation prompt (Gemini and Qwen ask on every update). */
function run({ cmd, args }: Step, cwd = os.homedir()): Promise<{ ok: boolean; output: string }> {
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
  const result = await run({ cmd: install.agent, args: ['debug', 'config'] });
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

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const before = findInstalls();
  if (!before.length) {
    console.log('No agent on this machine has telepathy installed.');
    return;
  }
  console.log(`telepathy is installed in: ${before.map((i) => `${agentLabel(i.agent)} ${i.version}`).join(', ')}.`);
  if (dryRun) {
    for (const install of before) {
      const steps = stepsFor(install);
      const how =
        steps === 'cache'
          ? `clear its package cache and run \`${install.agent} debug config\` to reinstall`
          : steps.map((s) => `\`${[s.cmd, ...s.args].join(' ')}\``).join(', then ');
      console.log(`- ${agentLabel(install.agent)}: ${how}`);
    }
    return;
  }

  const failures: string[] = [];
  for (const install of before) {
    process.stdout.write(`Updating ${agentLabel(install.agent)}… `);
    const steps = stepsFor(install);
    let result = { ok: true, output: '' };
    if (steps === 'cache') result = await refreshPackageCache(install);
    else for (const step of steps) if ((result = await run(step)).ok === false) break;
    if (result.ok) console.log('done');
    else {
      console.log(`failed: ${lastLine(result.output)}`);
      failures.push(agentLabel(install.agent));
    }
  }

  const after = findInstalls();
  console.log('\nInstalled versions:');
  for (const install of before) {
    const now = after.find((i) => i.agent === install.agent)?.version ?? 'not found';
    console.log(`- ${agentLabel(install.agent)}: ${install.version === now ? now : `${install.version} → ${now}`}`);
  }
  console.log(
    '\nSessions that are already running keep the version they started with: restart them to load the update. ' +
      'Running Codex sessions show "Hook failed" after tool calls until they restart, because the update replaces ' +
      'the folder their hooks run from.',
  );
  if (failures.length) {
    console.log(`\nNot updated: ${failures.join(', ')}. Run their own update command to see why.`);
    process.exitCode = 1;
  }
}

await main();
