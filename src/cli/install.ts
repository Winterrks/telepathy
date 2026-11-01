import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../core/agents.ts';
import { agentLabel, isAgent } from '../core/agents.ts';
import {
  enableAntigravitySidecar,
  geminiConfigFile,
  leftoverGeminiExtension,
  LEFTOVER_GEMINI_NOTE,
  removeLeftoverGeminiExtension,
} from '../core/antigravity.ts';
import { findInstalls, outsideIsolatedHome } from '../core/installs.ts';
import { installKimiPlugin } from '../core/kimi-plugin.ts';
import { runHarnessCommand } from '../update-all.ts';
import { detectedHarnesses, harnessByAgent, harnesses, OPENCODE_SPEC, REPO, type CommandStep, type Harness } from './harnesses.ts';

export function parseOnly(value: string | undefined): Agent[] | undefined {
  if (!value) return undefined;
  const ids = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((id) => (id === 'agy' ? 'antigravity' : id));
  const bad = ids.filter((id) => !isAgent(id));
  if (bad.length) throw new Error(`Unknown agent in --only: ${bad.join(', ')}. Known: ${harnesses().map((h) => h.agent).join(', ')}`);
  return ids as Agent[];
}

function kiloConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'kilo', 'kilo.json');
}

/** Adds the git plugin to Kilo's config. The Kilo CLI has no install subcommand. */
export function installKiloConfig(): void {
  const file = kiloConfigPath();
  let json: { plugin?: unknown } = {};
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8')) as { plugin?: unknown };
  } catch {
    json = {};
  }
  const list = Array.isArray(json.plugin) ? json.plugin.filter((item): item is string => typeof item === 'string') : [];
  if (!list.includes(OPENCODE_SPEC) && !list.includes('git:github.com/Winterrks/telepathy')) list.push('git:github.com/Winterrks/telepathy');
  json.plugin = list;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

/** Whether this harness already loads telepathy: its own copy, or Claude Code's for Grok and Cursor. */
export function alreadyInstalled(agent: Agent): boolean {
  return findInstalls().some((install) => install.agent === agent);
}

export interface InstallLine {
  agent: Agent;
  text: string;
  ok: boolean;
}

async function runSteps(steps: CommandStep[]): Promise<{ ok: boolean; output: string }> {
  let output = '';
  for (const step of steps) {
    const result = await runHarnessCommand(step);
    output += result.output;
    if (!result.ok) return { ok: false, output };
  }
  return { ok: true, output };
}

const lastLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim())
    .filter(Boolean)
    .at(-1);

/** How this harness installs telepathy, for `--dry-run` and for the ones a person has to finish. */
export function describeInstall(harness: Harness): string {
  const plan = harness.install;
  if (plan.kind === 'commands') {
    const cmds = plan.steps.map((step) => `\`${[step.cmd, ...step.args].join(' ')}\``).join(', then ');
    return plan.note ? `${cmds}. ${plan.note}` : cmds;
  }
  if (plan.kind === 'kilo-config') return `add "git:github.com/Winterrks/telepathy" to plugin in ${kiloConfigPath()}`;
  if (plan.kind === 'kimi') {
    return `download the latest release into ~/.kimi-code/plugins/managed/telepathy and list it in installed.json, as \`/plugins install ${REPO}\` does in a Kimi Code session`;
  }
  return plan.instructions;
}

export interface InstallOutcome {
  ok: boolean;
  /** What happened, for a person. */
  text: string;
  /** Something only a person can do next, such as Cursor's Marketplace step. */
  todo?: string;
}

/**
 * Installs telepathy into one harness with that harness's own mechanism. The caller has already checked that it
 * is missing. `manual` and `none` plans are not failures: they are what a person has to do.
 */
export async function installHarness(harness: Harness, log: (line: string) => void): Promise<InstallOutcome> {
  const plan = harness.install;
  if (plan.kind === 'none' || plan.kind === 'manual') return { ok: true, text: 'not installed', todo: plan.instructions };
  if (plan.kind === 'kilo-config') {
    try {
      installKiloConfig();
      return { ok: true, text: `updated ${kiloConfigPath()}` };
    } catch (err) {
      return { ok: false, text: `failed: ${(err as Error).message}` };
    }
  }
  if (plan.kind === 'kimi') {
    const result = await installKimiPlugin();
    return { ok: result.ok, text: result.ok ? result.output : `failed: ${result.output}` };
  }
  const result = await runSteps(plan.steps);
  if (!result.ok) return { ok: false, text: `failed: ${lastLine(result.output) ?? 'failed'}` };
  if (harness.agent === 'antigravity') enableSidecarIfInScope(log);
  return { ok: true, text: 'installed', todo: plan.note && harness.agent === 'cursor' ? plan.note : undefined };
}

/**
 * Installs telepathy into every detected harness, each with that harness's own command.
 * `--only` limits the set. Already-installed copies are left alone.
 */
export async function installAll(
  options: { dryRun?: boolean; only?: Agent[]; removeLegacy?: boolean; log?: (line: string) => void } = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const requested = options.only?.length ? options.only.flatMap((id) => {
    const harness = harnessByAgent(id);
    return harness ? [harness] : [];
  }) : undefined;
  const present = requested ?? detectedHarnesses();
  if (!present.length) {
    log(options.only ? `No harness in --only was recognized.` : 'No supported agent CLI is on PATH.');
    removeLegacyGemini(options, log);
    return options.only ? 1 : 0;
  }
  let failed = false;
  for (const harness of present) {
    const label = agentLabel(harness.agent);
    const how = describeInstall(harness);
    if (harness.install.kind === 'none') {
      log(`- ${label}: ${how}`);
      continue;
    }
    if (alreadyInstalled(harness.agent) && harness.install.kind !== 'manual') {
      if (harness.agent === 'antigravity' && !options.dryRun) enableSidecarIfInScope(log);
      log(`- ${label}: already installed${options.dryRun ? `; would run ${how}` : ''}`);
      continue;
    }
    if (options.dryRun) {
      log(`- ${label}: ${how}`);
      continue;
    }
    const outcome = await installHarness(harness, log);
    if (!outcome.ok) failed = true;
    const note = harness.install.kind === 'commands' ? harness.install.note : undefined;
    log(`- ${label}: ${outcome.todo && outcome.text === 'not installed' ? outcome.todo : `${outcome.text}${outcome.ok && note ? `. ${note}` : ''}`}`);
  }
  removeLegacyGemini(options, log);
  return failed ? 1 : 0;
}

/** Enables the App sidecar only when its config file is inside the active home. */
export function enableSidecarIfInScope(log: (line: string) => void): void {
  const file = geminiConfigFile();
  if (outsideIsolatedHome(path.dirname(file))) {
    log(`- Antigravity sidecar: left unchanged. ${file} is outside this TELEPATHY_HOME.`);
    return;
  }
  enableAntigravitySidecar();
}

/** Removes the old Gemini extension only when `install --remove-legacy` asked for it. */
function removeLegacyGemini(
  options: { dryRun?: boolean; removeLegacy?: boolean },
  log: (line: string) => void,
): void {
  if (!options.removeLegacy) return;
  const dir = leftoverGeminiExtension();
  if (!dir) {
    log('No leftover Gemini CLI extension.');
    return;
  }
  if (options.dryRun) {
    log(`Would remove leftover Gemini CLI extension at ${dir}. ${LEFTOVER_GEMINI_NOTE}`);
    return;
  }
  removeLeftoverGeminiExtension();
  log(`Removed leftover Gemini CLI extension at ${dir}. ${LEFTOVER_GEMINI_NOTE}`);
}

/** Installs one harness before `telepathy run` execs it. A manual install is a warning, not a failure. */
export async function ensureInstalled(agent: Agent): Promise<{ ok: boolean; note?: string }> {
  if (alreadyInstalled(agent)) return { ok: true };
  const harness = harnessByAgent(agent);
  if (!harness) return { ok: false, note: `Unknown harness ${agent}.` };
  if (harness.install.kind === 'manual' || harness.install.kind === 'none') {
    return { ok: true, note: harness.install.instructions };
  }
  process.stderr.write(`telepathy: ${agentLabel(agent)} does not have telepathy installed. Installing…\n`);
  const outcome = await installHarness(harness, (line) => process.stderr.write(`telepathy: ${line}\n`));
  if (!outcome.ok) return { ok: false, note: outcome.text.replace(/^failed: /, '') };
  if (harness.install.kind === 'commands' && harness.install.note) process.stderr.write(`telepathy: ${harness.install.note}\n`);
  if (!alreadyInstalled(agent) && harness.install.kind === 'commands') {
    process.stderr.write('telepathy: the install command finished, but no copy is visible on disk yet. Starting anyway.\n');
  }
  return { ok: true };
}
