import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateGlobalCli } from './cli-self-update.ts';
import { agentLabel } from './core/agents.ts';
import { trustTelepathyCodexHooks } from './core/codex-hooks.ts';
import { installsInScope, isNewer, type Install, isOpencodeNpmInstall, outsideIsolatedHome } from './core/installs.ts';
import { installKimiPlugin } from './core/kimi-plugin.ts';
import { configuredEnv } from './core/paths.ts';
import { inTestSandbox, sandboxSpawnBlock } from './core/sandbox-launch.ts';
import { cachedGithubVersion, latestGithubVersion } from './version-check.ts';

/**
 * Updates telepathy in every agent on this machine that has it installed, each with the agent's own update
 * command:
 *   node update-all.mjs [--dry-run]
 * Unlike the plugin itself, this needs the network: the agents fetch the new version from GitHub. Qwen Code
 * asks to confirm every update of a third-party extension; running this answers yes to such prompts. Running sessions
 * keep the version they started with until they restart.
 */

interface Step {
  cmd: string;
  args: string[];
}

const REPO = 'https://github.com/Winterrks/telepathy';
const OPENCODE_SPEC = `telepathy@git+${REPO}.git`;
const STEP_TIMEOUT_MS = 180_000;

type Plan = Step[] | 'cache' | 'opencode-npm' | 'kimi';

/**
 * The commands that update one agent's copy; `cache` for agents that reinstall from a cleared package cache;
 * `opencode-npm` for OpenCode 2's package folder; `kimi` for Kimi Code's managed copy.
 */
function stepsFor(install: Install): Plan {
  const marketplace = install.marketplace ?? 'telepathy';
  switch (install.agent) {
    case 'claude':
      return [
        { cmd: 'claude', args: ['plugin', 'marketplace', 'update', marketplace] },
        { cmd: 'claude', args: ['plugin', 'update', `telepathy@${marketplace}`] },
      ];
    case 'codex':
      return [{ cmd: 'codex', args: ['plugin', 'marketplace', 'upgrade', marketplace] }];
    case 'qwen':
      return [{ cmd: 'qwen', args: ['extensions', 'update', 'telepathy'] }];
    case 'copilot':
      return [{ cmd: 'copilot', args: ['plugin', 'update', `telepathy@${marketplace}`] }];
    case 'devin':
      return [{ cmd: 'devin', args: ['plugins', 'update', 'telepathy'] }];
    case 'antigravity':
      return [{ cmd: 'agy', args: ['plugin', 'install', `${REPO}/tree/main/antigravity`] }];
    case 'opencode':
      // `opencode plugin update` (2.2) does not see a git spec ("Plugin is not configured"); 1.x has no command.
      return isOpencodeNpmInstall(install) ? 'opencode-npm' : 'cache';
    case 'kimi':
      return 'kimi';
    default:
      return 'cache';
  }
}

/** Runs one step, answering "y" to any confirmation prompt (Qwen asks on every update). */
export function runHarnessCommand({ cmd, args }: Step, cwd = os.homedir()): Promise<{ ok: boolean; output: string }> {
  const blocked = sandboxSpawnBlock(cmd);
  if (blocked) return Promise.resolve({ ok: false, output: blocked });
  if (cmd === 'codex' && inTestSandbox()) {
    const home = configuredEnv('CODEX_HOME');
    if (!home || outsideIsolatedHome(home)) {
      return Promise.resolve({ ok: false, output: `refusing to run codex outside the test sandbox (${home ?? 'CODEX_HOME unset'})` });
    }
  }
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
  const reinstalled = installsInScope().find((i) => i.agent === install.agent);
  if (reinstalled) {
    fs.rmSync(aside, { recursive: true, force: true });
    return { ok: true, output: result.output };
  }
  fs.rmSync(entry, { recursive: true, force: true });
  fs.renameSync(aside, entry); // put the old copy back rather than leave the agent without one
  return { ok: false, output: `it didn't reinstall telepathy, so the old copy was kept. ${result.output}` };
}

/**
 * OpenCode 2 keeps a git plugin in `npm/<target folder>/<install time>/`. With that folder gone, `opencode plugin add`
 * fetches main again even though the config already lists the spec.
 */
async function refreshOpencodeNpm(install: Install): Promise<{ ok: boolean; output: string }> {
  const opencodeCache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'opencode');
  const npm = path.join(opencodeCache, 'npm');
  const entry = path.join(npm, path.relative(npm, install.dir).split(path.sep)[0] ?? '');
  const aside = path.join(opencodeCache, `.telepathy-update-${Date.now()}`);
  fs.renameSync(entry, aside);
  const result = await runHarnessCommand({ cmd: 'opencode', args: ['plugin', 'add', OPENCODE_SPEC] });
  const reinstalled = installsInScope().find((i) => i.agent === 'opencode' && isOpencodeNpmInstall(i));
  if (reinstalled) {
    fs.rmSync(aside, { recursive: true, force: true });
    return { ok: true, output: result.output };
  }
  fs.rmSync(entry, { recursive: true, force: true });
  fs.renameSync(aside, entry);
  return { ok: false, output: `it didn't reinstall telepathy, so the old copy was kept. ${result.output}` };
}

/** Updates one agent's copy with that agent's own mechanism. */
export async function updateInstall(install: Install): Promise<{ ok: boolean; output: string }> {
  const steps = stepsFor(install);
  if (steps === 'cache') return refreshPackageCache(install);
  if (steps === 'opencode-npm') return refreshOpencodeNpm(install);
  if (steps === 'kimi') return installKimiPlugin();
  let result = { ok: true, output: '' };
  for (const step of steps) if ((result = await runHarnessCommand(step)).ok === false) break;
  return result;
}

/** How `updateInstall` would update this copy, for `--dry-run`. */
export function describeUpdate(install: Install): string {
  const steps = stepsFor(install);
  if (steps === 'cache') return `clear its package cache and run \`${install.agent} debug config\` to reinstall`;
  if (steps === 'opencode-npm') return `move its package folder aside and run \`opencode plugin add ${OPENCODE_SPEC}\` to reinstall`;
  if (steps === 'kimi') return 'download the latest release into ~/.kimi-code/plugins/managed/telepathy, as `/plugins install` does';
  return steps.map((s) => `\`${[s.cmd, ...s.args].join(' ')}\``).join(', then ');
}

/**
 * After telepathy updates Codex's copy, its hooks show as changed and stop running until someone approves them
 * in `/hooks` again. The user approved an earlier version, so those (and only those) are approved again.
 */
export async function retrustChangedCodexHooks(say: (line: string) => void): Promise<boolean> {
  const result = await trustTelepathyCodexHooks(['modified']);
  if (result.trusted.length) say(`Codex: approved telepathy's ${result.trusted.length} updated hooks again.`);
  const untrusted = result.left.filter((hook) => hook.trustStatus === 'untrusted').length;
  if (untrusted) say(`Codex: ${untrusted} telepathy hooks were never approved. Open /hooks in Codex, or run \`telepathy setup\`.`);
  if (result.error) {
    say(`Codex: could not check telepathy's hooks (${result.error}). If /hooks shows them changed, approve them there.`);
    return false;
  }
  return true;
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
  /** Also update a global npm install of the CLI. Default true. Auto-update does that step itself. */
  cli?: boolean;
}

/** GitHub's version when we can see it. A forced `TELEPATHY_LATEST_VERSION` is not cached. */
export async function latestKnown(): Promise<string | undefined> {
  if (process.env.TELEPATHY_LATEST_VERSION?.trim()) return process.env.TELEPATHY_LATEST_VERSION.trim();
  try {
    return await latestGithubVersion();
  } catch {
    return cachedGithubVersion();
  }
}

const alreadyCurrent = (install: Install, latest: string | undefined) => !!latest && !isNewer(latest, install.version);

/** Updates every install. Returns 0 when every harness updated, 1 when any failed or none were found. */
export async function updateAll(options: UpdateAllOptions = {}): Promise<number> {
  const dryRun = options.dryRun === true;
  const log = options.log;
  const say = (line: string) => (log ? log(line) : console.log(line));
  const before = installsInScope();
  const cliStep = async (): Promise<boolean> => {
    if (options.cli === false) return true;
    const cli = await updateGlobalCli({ dryRun });
    if (cli) say(cli.line);
    return cli?.ok ?? true;
  };
  if (!before.length) {
    say('No agent on this machine has telepathy installed.');
    return (await cliStep()) ? 0 : 1;
  }
  const latest = await latestKnown();
  say(`telepathy is installed in: ${before.map((i) => `${agentLabel(i.agent)} ${i.version}`).join(', ')}.`);
  if (dryRun) {
    for (const install of before) {
      if (alreadyCurrent(install, latest)) {
        say(`- ${agentLabel(install.agent)}: already current`);
        continue;
      }
      say(`- ${agentLabel(install.agent)}: ${describeUpdate(install)}`);
    }
    return (await cliStep()) ? 0 : 1;
  }

  const failures: string[] = [];
  for (const install of before) {
    if (alreadyCurrent(install, latest)) {
      say(`Updating ${agentLabel(install.agent)}… already current`);
      continue;
    }
    if (log) log(`Updating ${agentLabel(install.agent)}…`);
    else process.stdout.write(`Updating ${agentLabel(install.agent)}… `);
    const result = await updateInstall(install);
    if (result.ok) say('done');
    else {
      say(`failed: ${lastLine(result.output)}`);
      failures.push(agentLabel(install.agent));
    }
  }

  const after = installsInScope();
  let changed = false;
  say('\nInstalled versions:');
  for (const install of before) {
    const now = after.find((i) => i.agent === install.agent)?.version ?? 'not found';
    if (install.version !== now) changed = true;
    say(`- ${agentLabel(install.agent)}: ${install.version === now ? now : `${install.version} → ${now}`}`);
  }
  if (changed) {
    say(
      '\nSessions that are already running keep the version they started with: restart them to load the update. ' +
        'Running Codex sessions show "Hook failed" after tool calls until they restart, because the update replaces ' +
        'the folder their hooks run from.',
    );
  }
  const codexBefore = before.find((i) => i.agent === 'codex');
  const codexAfter = after.find((i) => i.agent === 'codex');
  if (codexBefore && codexAfter && codexBefore.version !== codexAfter.version) await retrustChangedCodexHooks(say);
  const cliOk = await cliStep();
  if (failures.length) {
    say(`\nNot updated: ${failures.join(', ')}. Run their own update command to see why.`);
    return 1;
  }
  return cliOk ? 0 : 1;
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
