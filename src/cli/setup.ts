import { updateGlobalCli } from '../cli-self-update.ts';
import { agentLabel, type Agent } from '../core/agents.ts';
import { describeHookState, trustTelepathyCodexHooks } from '../core/codex-hooks.ts';
import { installsInScope, isNewer } from '../core/installs.ts';
import { describeUpdate, latestKnown, runHarnessCommand, updateInstall } from '../update-all.ts';
import { detectedHarnesses, harnessByAgent, resolvedAcpBin, type Harness } from './harnesses.ts';
import { alreadyInstalled, describeInstall, enableSidecarIfInScope, installHarness, parseOnly } from './install.ts';

/**
 * `telepathy setup`: every agent CLI on PATH ends up with a current copy of telepathy, telepathy's own hooks approved
 * where the agent has a command for that (Codex, through its app-server; Grok's install passes `--trust`), and the
 * ACP adapters `telepathy run` needs for Claude Code and Codex. What only a person can do is listed at the end.
 */

interface SetupArgs {
  dryRun: boolean;
  hooks: boolean;
  adapters: boolean;
  only?: Agent[];
}

const USAGE = 'Usage: telepathy setup [--dry-run] [--only a,b] [--no-hooks] [--no-adapters]';

export function parseSetupArgs(argv: string[]): SetupArgs {
  const args: SetupArgs = { dryRun: false, hooks: true, adapters: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-hooks') args.hooks = false;
    else if (arg === '--no-adapters') args.adapters = false;
    else if (arg === '--only') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--only needs a value');
      args.only = parseOnly(value);
    } else if (arg.startsWith('--only=')) args.only = parseOnly(arg.slice('--only='.length));
    else throw new Error(`Unknown setup option ${JSON.stringify(arg)}.\n${USAGE}`);
  }
  return args;
}

interface Report {
  parts: string[];
  todo: string[];
  failed: boolean;
  changed: boolean;
}

/** Grok and Cursor load Claude Code's copy. A second install of their own would load telepathy twice. */
const usesClaudeCopy = (agent: Agent) => agent === 'grok' || agent === 'cursor';

async function setupPlugin(harness: Harness, args: SetupArgs, latest: string | undefined, claudeCopy: boolean, report: Report): Promise<void> {
  const log = (line: string) => report.parts.push(line.replace(/^- /, ''));
  if (usesClaudeCopy(harness.agent) && claudeCopy) {
    report.parts.push("loads Claude Code's copy");
    return;
  }
  const own = installsInScope().find((install) => install.agent === harness.agent);
  if (own) {
    if (harness.agent === 'antigravity' && !args.dryRun) enableSidecarIfInScope(log);
    if (!latest || !isNewer(latest, own.version)) {
      report.parts.push(`telepathy ${own.version}${latest ? ', current' : ''}`);
      return;
    }
    if (args.dryRun) {
      report.parts.push(`would update ${own.version} → ${latest}: ${describeUpdate(own)}`);
      return;
    }
    const result = await updateInstall(own);
    const now = installsInScope().find((install) => install.agent === harness.agent)?.version;
    if (result.ok) {
      report.parts.push(`updated ${own.version} → ${now ?? latest}`);
      report.changed = true;
    } else {
      const tail = result.output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? 'failed';
      report.parts.push(`update failed: ${tail}`);
      report.failed = true;
    }
    return;
  }
  // Copilot's own lookup also counts copies outside a sandbox home; it would load those, so don't add one.
  if (harness.agent === 'copilot' && alreadyInstalled('copilot')) {
    report.parts.push('installed');
    return;
  }
  if (args.dryRun) {
    report.parts.push(`would install: ${describeInstall(harness)}`);
    return;
  }
  const outcome = await installHarness(harness, log);
  report.parts.push(outcome.text);
  if (outcome.todo) report.todo.push(outcome.todo);
  if (!outcome.ok) report.failed = true;
  else if (outcome.text !== 'not installed') report.changed = true;
}

async function setupCodexHooks(args: SetupArgs, report: Report): Promise<void> {
  if (!args.hooks) return;
  if (args.dryRun) {
    report.parts.push("would approve telepathy's hooks that Codex shows as new or changed");
    return;
  }
  const result = await trustTelepathyCodexHooks(['untrusted', 'modified']);
  if (result.error) {
    report.parts.push(`hooks: ${result.error}`);
    report.todo.push("Codex: open /hooks and trust telepathy's hooks (press t).");
    report.failed = true;
    return;
  }
  if (result.trusted.length) report.parts.push(`approved ${result.trusted.length} hooks`);
  else report.parts.push(describeHookState(result.left));
}

async function setupAdapter(harness: Harness, args: SetupArgs, report: Report): Promise<void> {
  const acp = harness.acp;
  if (!args.adapters || !acp?.adapter || !acp.installHint) return;
  if (resolvedAcpBin(acp)) return;
  const [cmd, ...rest] = acp.installHint.split(' ');
  if (!cmd) return;
  if (args.dryRun) {
    report.parts.push(`would run \`${acp.installHint}\` for \`telepathy run ${harness.agent}\``);
    return;
  }
  const result = await runHarnessCommand({ cmd, args: rest });
  if (result.ok) {
    report.parts.push(`installed ${acp.bin}`);
    report.changed = true;
  } else {
    const tail = result.output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? 'failed';
    report.parts.push(`${acp.bin}: ${tail}`);
    report.todo.push(`${agentLabel(harness.agent)}: \`${acp.installHint}\` (needed for \`telepathy run ${harness.agent}\`).`);
    report.failed = true;
  }
}

export async function setupCommand(argv: string[]): Promise<number> {
  let args: SetupArgs;
  try {
    args = parseSetupArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const say = (line: string) => console.log(line);
  const targets = args.only
    ? args.only.flatMap((agent) => {
        const harness = harnessByAgent(agent);
        return harness ? [harness] : [];
      })
    : detectedHarnesses();
  if (!targets.length) {
    say(args.only ? 'No harness in --only was recognized.' : 'No supported agent CLI is on PATH.');
    return args.only ? 1 : 0;
  }
  const latest = await latestKnown();
  say(`${args.dryRun ? 'Would set up' : 'Setting up'} telepathy${latest ? ` ${latest}` : ''} in ${targets.map((h) => agentLabel(h.agent)).join(', ')}.`);

  let failed = false;
  let changed = false;
  const todo: string[] = [];
  // In a dry run Claude Code's copy is only planned; Grok and Cursor would still load it.
  let claudeCopy = installsInScope().some((install) => install.agent === 'claude');
  for (const harness of targets) {
    const report: Report = { parts: [], todo: [], failed: false, changed: false };
    if (harness.install.kind === 'none') {
      say(`- ${agentLabel(harness.agent)}: ${harness.install.instructions}`);
      continue;
    }
    await setupPlugin(harness, args, latest, claudeCopy, report);
    if (harness.agent === 'claude' && (args.dryRun || installsInScope().some((install) => install.agent === 'claude'))) claudeCopy = true;
    if (harness.agent === 'codex' && !report.failed) await setupCodexHooks(args, report);
    await setupAdapter(harness, args, report);
    say(`- ${agentLabel(harness.agent)}: ${report.parts.join('; ')}`);
    todo.push(...report.todo);
    failed ||= report.failed;
    changed ||= report.changed;
  }

  const cli = await updateGlobalCli({ dryRun: args.dryRun });
  if (cli) {
    say(cli.line);
    failed ||= !cli.ok;
  }
  if (todo.length) {
    say('\nStill to do by hand:');
    for (const line of todo) say(`- ${line}`);
  }
  if (changed) say('\nRestart sessions that were already running to load the change.');
  return failed ? 1 : 0;
}
