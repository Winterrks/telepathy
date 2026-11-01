import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { scheduleAutoUpdate } from '../auto-update.ts';
import { noteMissedCopilotResume, startAcpSession } from '../acp/host.ts';
import { ensureAgyApiKey } from './agy-auth.ts';
import { agentLabel } from '../core/agents.ts';
import { findInstalls, isNewer } from '../core/installs.ts';
import { cachedGithubVersion } from '../version-check.ts';
import { runHeadless } from '../headless/run.ts';
import { writeStatus } from '../core/status.ts';
import { claimPluginSession, clearHosted, namedPeerId, pluginInboxPeerId, recallHarnessSession, registerHostedPeer, rememberHarnessSession, startInboxPump, type HostedPeer } from '../headless/peer.ts';
import { ensureInstalled } from './install.ts';
import { acpCommand, canonicalRunAgent, defaultRunMode, harnessByAgent, harnesses, headlessPlane, listRuns, onPath, resolvedAcpBin, resolvedBin, type AcpLaunch, type Harness } from './harnesses.ts';
import { launchEnv, pluginInstalled } from './launch.ts';

export interface RunArgs {
  acp: boolean;
  /** Exec the vendor TUI instead of the ACP host. */
  tui: boolean;
  headless: boolean;
  list: boolean;
  /** Install or repair the plugin before starting. Unset, `run` does not touch global configs. */
  install: boolean;
  name?: string;
  cwd?: string;
  agent?: string;
  userArgs: string[];
}

/** Flags that belong to telepathy stay in front of the agent. Later arguments are the harness's. */
export function parseRunArgs(argv: string[]): RunArgs {
  let acp = false;
  let tui = false;
  let headless = false;
  let list = false;
  let install = false;
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
    if (beforeAgent && arg === '--tui') {
      tui = true;
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
    if (beforeAgent && arg === '--install') {
      install = true;
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
  return { acp, tui, headless, list, install, name, cwd, agent: positionals[0], userArgs: positionals.slice(1) };
}

async function prepare(agent: Harness['agent'], install: boolean): Promise<boolean> {
  const latest = cachedGithubVersion();
  const found = findInstalls().find((item) => item.agent === agent);
  if (latest && found && isNewer(latest, found.version)) {
    process.stderr.write(
      `telepathy: ${agentLabel(agent)} has telepathy ${found.version}, older than GitHub ${latest}. An update will run in the background.\n`,
    );
    scheduleAutoUpdate('run');
  }
  if (!install) return true;
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
  const agent = canonicalRunAgent(parsed.agent);
  if (!agent) {
    console.error(
      `Unknown agent ${JSON.stringify(parsed.agent ?? '')}. Known: ${harnesses().map((harness) => harness.agent).join(', ')} (agy is antigravity).\n` +
        'Run `telepathy run --list` to see how each one starts.',
    );
    return 1;
  }
  const harness = harnessByAgent(agent);
  if (!harness) return 1;
  if (parsed.tui && (parsed.acp || parsed.headless)) {
    console.error(`telepathy: --tui runs the ${agentLabel(agent)} CLI itself; it cannot be combined with ${parsed.acp ? '--acp' : '--headless'}.`);
    return 1;
  }
  if (parsed.acp && !harness.acp) {
    console.error(`telepathy: ${harness.agent} has no ACP launcher. \`telepathy run --tui ${harness.agent}\` starts its CLI.`);
    return 1;
  }
  const useAcp = !parsed.headless && !parsed.tui && (parsed.acp || defaultRunMode(harness) === 'acp');
  if (harness.agent === 'antigravity' && (parsed.headless || useAcp)) {
    const auth = ensureAgyApiKey();
    if (!auth.ok) {
      console.error(auth.warning);
      return 1;
    }
  }
  if (!(await prepare(harness.agent, parsed.install))) return 1;
  const cwd = parsed.cwd ? path.resolve(parsed.cwd) : process.cwd();
  const name = parsed.name;

  if (parsed.headless) {
    const plane = headlessPlane(harness, parsed.acp);
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
      if (!acpBin) return missingAcp(harness);
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

  if (useAcp && harness.acp) {
    const acpBin = resolvedAcpBin(harness.acp);
    if (!acpBin) return missingAcp(harness);
    return runInteractiveAcp(harness, acpBin, parsed.userArgs, cwd, name);
  }

  if (harness.deliveryNote) process.stderr.write(`telepathy: ${harness.deliveryNote}\n`);
  const bin = resolvedBin(harness) ?? harness.passthroughBin ?? harness.bins[0];
  if (!onPath(bin)) return missing(bin, 'Install the CLI and try again.');
  return execPassthrough(bin, parsed.userArgs, cwd, launchEnv(harness.agent, name));
}

/** `telepathy run` starts the ACP mode. A missing adapter says how to get it, and that `--tui` is the vendor CLI. */
function missingAcp(harness: Harness): number {
  const acp = harness.acp as AcpLaunch;
  const get = acp.installHint
    ? `${agentLabel(harness.agent)} speaks ACP through that adapter. Install it with \`${acp.installHint}\`.`
    : acp.adapter
      ? `${agentLabel(harness.agent)} speaks ACP through that adapter. Install it and try again.`
      : 'Install the CLI and try again.';
  const tui = harness.passthroughBin ? ` \`telepathy run --tui ${harness.agent}\` starts the ${agentLabel(harness.agent)} CLI instead.` : '';
  return missing(acpCommand(acp), get + tui);
}

/** `telepathy run copilot --resume <id>` (and `-r`). The id is the harness session, not the peer name. */
export function explicitResume(userArgs: string[]): string | undefined {
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i];
    if (arg === '--resume' || arg === '-r') {
      const value = userArgs[i + 1];
      if (value && !value.startsWith('-')) return value;
    } else if (arg.startsWith('--resume=')) {
      const value = arg.slice('--resume='.length);
      if (value) return value;
    }
  }
  return undefined;
}

async function runInteractiveAcp(harness: Harness, bin: string, userArgs: string[], cwd: string, name?: string): Promise<number> {
  const acp = harness.acp;
  if (!acp) return 1;
  const pluginPeer = pluginInstalled(harness.agent);
  const named = name ? namedPeerId(harness.agent, name) : undefined;
  // The plugin's peer is keyed by the harness session. Skipping the load when the plugin is installed
  // starts a new session and a new peer id, even though `--name` is the same.
  const resume = explicitResume(userArgs) ?? (named ? recallHarnessSession(named.peerId) : undefined);
  let hosted: HostedPeer | undefined;
  let sessionId = '';
  // Set once session/new or session/load returns, before the first prompt. The callback runs later.
  let pluginId: string | undefined;
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
    onTurnSettled: () => {
      const id = hosted?.peerId ?? pluginId ?? pluginInboxPeerId(harness.agent, name, sessionId);
      if (id) writeStatus(id, 'idle');
    },
  });
  sessionId = session.sessionId;
  noteMissedCopilotResume(harness.agent, resume, session);
  if (pluginPeer && session.child.pid) {
    pluginId = claimPluginSession(harness.agent, session.child.pid, session.sessionId, cwd, name);
    writeStatus(pluginId, 'idle');
  }
  // The installed plugin is the named peer. A second host registration shows up beside it.
  // The host still pumps that peer's inbox: an idle ACP session has no other delivery path.
  hosted = pluginPeer ? undefined : registerHostedPeer(harness.agent, cwd, name);
  const memoryPeer = hosted?.peerId ?? named?.peerId;
  if (memoryPeer) rememberHarnessSession(memoryPeer, session.sessionId);
  const stopPump = startInboxPump(
    hosted?.peerId ?? pluginId ?? (() => pluginInboxPeerId(harness.agent, name, session.sessionId)),
    (text, stillPending, withdrawn) => session.prompt(text, stillPending, withdrawn),
  );
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
