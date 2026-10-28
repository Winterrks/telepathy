import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { scheduleAutoUpdate } from '../auto-update.ts';
import { startAcpSession } from '../acp/host.ts';
import { agentLabel, isAgent } from '../core/agents.ts';
import { findInstalls, isNewer } from '../core/installs.ts';
import { cachedGithubVersion } from '../version-check.ts';
import { runHeadless } from '../headless/run.ts';
import { clearHosted, namedPeerId, recallHarnessSession, registerHostedPeer, rememberHarnessSession, startInboxPump } from '../headless/peer.ts';
import { ensureInstalled } from './install.ts';
import { acpCommand, harnessByAgent, harnesses, listRuns, onPath, resolvedAcpBin, resolvedBin, type AcpLaunch, type Harness } from './harnesses.ts';
import { launchEnv, pluginInstalled } from './launch.ts';

export interface RunArgs {
  acp: boolean;
  headless: boolean;
  list: boolean;
  name?: string;
  cwd?: string;
  agent?: string;
  userArgs: string[];
}

/** Flags that belong to telepathy stay in front of the agent. Later arguments are the harness's. */
export function parseRunArgs(argv: string[]): RunArgs {
  let acp = false;
  let headless = false;
  let list = false;
  let name: string | undefined;
  let cwd: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const beforeAgent = positionals.length === 0;
    const nameStillOpen = positionals.length <= 1;
    if (arg === '--') continue;
    if (beforeAgent && arg === '--acp') {
      acp = true;
      continue;
    }
    if (beforeAgent && arg === '--headless') {
      headless = true;
      continue;
    }
    if (beforeAgent && arg === '--list') {
      list = true;
      continue;
    }
    if (nameStillOpen && (arg === '--name' || arg === '--cwd')) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--name') name = value;
      else cwd = value;
      continue;
    }
    positionals.push(arg);
  }
  return { acp, headless, list, name, cwd, agent: positionals[0], userArgs: positionals.slice(1) };
}

async function prepare(agent: Harness['agent']): Promise<boolean> {
  const latest = cachedGithubVersion();
  const install = findInstalls().find((item) => item.agent === agent);
  if (latest && install && isNewer(latest, install.version)) {
    process.stderr.write(
      `telepathy: ${agentLabel(agent)} has telepathy ${install.version}, older than GitHub ${latest}. An update will run in the background.\n`,
    );
    scheduleAutoUpdate('run');
  }
  const ensured = await ensureInstalled(agent);
  if (ensured.note) process.stderr.write(`telepathy: ${ensured.note}\n`);
  if (!ensured.ok) return false;
  return true;
}

function missing(bin: string, hint: string): number {
  console.error(`telepathy: \`${bin}\` is not on PATH. ${hint}`);
  return 1;
}

/**
 * `telepathy run`. Passthrough keeps the vendor TUI. ACP and `--headless` are processes telepathy spawned,
 * which is not a way to attach to a TUI that is already open.
 */
export async function runCommand(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv);
  if (parsed.list) {
    console.log(listRuns());
    return 0;
  }
  if (!parsed.agent || !isAgent(parsed.agent)) {
    console.error(
      `Unknown agent ${JSON.stringify(parsed.agent ?? '')}. Known: ${harnesses().map((harness) => harness.agent).join(', ')}.\n` +
        'Run `telepathy run --list` to see how each one starts.',
    );
    return 1;
  }
  const harness = harnessByAgent(parsed.agent);
  if (!harness) return 1;
  if (!(await prepare(harness.agent))) return 1;
  const cwd = parsed.cwd ? path.resolve(parsed.cwd) : process.cwd();
  const name = parsed.name;

  if (parsed.headless) {
    const plane = parsed.acp ? 'acp' : harness.headless;
    if (!plane) {
      const supported = harnesses()
        .filter((item) => item.headless)
        .map((item) => item.agent)
        .join(', ');
      console.error(`telepathy: ${harness.agent} has no headless control plane. Headless peers: ${supported}.`);
      return 1;
    }
    if (plane === 'acp') {
      if (!harness.acp) {
        console.error(`telepathy: ${harness.agent} has no ACP launcher.`);
        return 1;
      }
      const acpBin = resolvedAcpBin(harness.acp);
      if (!acpBin) return missingAcp(harness.acp);
      const peerName = name ?? `${harness.agent}-headless`;
      return runHeadless({
        agent: harness.agent,
        plane: 'acp',
        bin: acpBin,
        acpArgs: harness.acp.args,
        userArgs: parsed.userArgs,
        cwd,
        name: peerName,
        env: launchEnv(harness.agent, peerName),
        pluginPeer: pluginInstalled(harness.agent),
      });
    }
    const bin = resolvedBin(harness) ?? harness.passthroughBin ?? harness.bins[0];
    if (!onPath(bin)) return missing(bin, 'Install the CLI and try again.');
    const peerName = name ?? `${harness.agent}-headless`;
    return runHeadless({
      agent: harness.agent,
      plane,
      bin,
      userArgs: parsed.userArgs,
      cwd,
      name: peerName,
      env: launchEnv(harness.agent, peerName),
      pluginPeer: pluginInstalled(harness.agent),
    });
  }

  if (parsed.acp || harness.defaultMode === 'acp') {
    if (!harness.acp) {
      console.error(`telepathy: ${harness.agent} has no ACP launcher. \`telepathy run ${harness.agent}\` starts its CLI.`);
      return 1;
    }
    const acpBin = resolvedAcpBin(harness.acp);
    if (!acpBin) {
      return missing(
        acpCommand(harness.acp),
        harness.acp.adapter ? 'It is an optional adapter. The native CLI does not speak ACP.' : 'Install the CLI and try again.',
      );
    }
    return runInteractiveAcp(harness, acpBin, parsed.userArgs, cwd, name);
  }

  if (harness.deliveryNote) process.stderr.write(`telepathy: ${harness.deliveryNote}\n`);
  const bin = resolvedBin(harness) ?? harness.passthroughBin ?? harness.bins[0];
  if (!onPath(bin)) return missing(bin, 'Install the CLI and try again.');
  return execPassthrough(bin, parsed.userArgs, cwd, launchEnv(harness.agent, name));
}

function missingAcp(acp: AcpLaunch): number {
  return missing(acpCommand(acp), 'Install it, or run without --acp where a native plane exists.');
}

async function runInteractiveAcp(harness: Harness, bin: string, userArgs: string[], cwd: string, name?: string): Promise<number> {
  const acp = harness.acp;
  if (!acp) return 1;
  const pluginPeer = pluginInstalled(harness.agent);
  const resume = !pluginPeer && name ? recallHarnessSession(namedPeerId(harness.agent, name).peerId) : undefined;
  const session = await startAcpSession({
    agent: harness.agent,
    bin,
    args: [...acp.args, ...userArgs],
    cwd,
    headless: false,
    resumeSessionId: resume,
    env: launchEnv(harness.agent, name),
    emit: (line) => process.stdout.write(line.endsWith('\n') ? line : line + '\n'),
    stream: (text) => process.stdout.write(text),
  });
  // The installed plugin is the named peer. A second host registration shows up beside it.
  const hosted = pluginPeer ? undefined : registerHostedPeer(harness.agent, cwd, name);
  if (hosted) rememberHarnessSession(hosted.peerId, session.sessionId);
  const stopPump = hosted ? startInboxPump(hosted.peerId, (text, stillPending) => session.prompt(text, stillPending)) : () => {};
  const shutdown = () => session.close();
  process.on('SIGTERM', shutdown);
  try {
    return await session.exited;
  } finally {
    process.off('SIGTERM', shutdown);
    stopPump();
    if (hosted) clearHosted(hosted.peerId);
  }
}

/**
 * Replaces this process's stdio with the vendor CLI. SIGINT is left to the terminal's process group so a
 * keystroke is not delivered twice. SIGTERM and SIGHUP are forwarded.
 */
function execPassthrough(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode) return;
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    };
    const onTerm = () => forward('SIGTERM');
    const onHup = () => forward('SIGHUP');
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    child.on('error', (err) => {
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
      console.error(`telepathy: could not start ${bin}: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
      if (signal) {
        const num = os.constants.signals[signal];
        resolve(typeof num === 'number' ? 128 + num : 1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
