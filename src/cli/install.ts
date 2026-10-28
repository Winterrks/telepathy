import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../core/agents.ts';
import { agentLabel, isAgent } from '../core/agents.ts';
import {
  enableAntigravitySidecar,
  leftoverGeminiExtension,
  LEFTOVER_GEMINI_NOTE,
  removeLeftoverGeminiExtension,
} from '../core/antigravity.ts';
import { findInstalls } from '../core/installs.ts';
import { runHarnessCommand } from '../update-all.ts';
import { detectedHarnesses, harnessByAgent, harnesses, OPENCODE_SPEC, type CommandStep, type Harness } from './harnesses.ts';

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

function alreadyInstalled(agent: Agent): boolean {
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

function describe(harness: Harness): string {
  const plan = harness.install;
  if (plan.kind === 'commands') {
    const cmds = plan.steps.map((step) => `\`${[step.cmd, ...step.args].join(' ')}\``).join(', then ');
    return plan.note ? `${cmds}. ${plan.note}` : cmds;
  }
  if (plan.kind === 'kilo-config') return `add "git:github.com/Winterrks/telepathy" to plugin in ${kiloConfigPath()}`;
  return plan.instructions;
}

/**
 * Installs telepathy into every detected harness, each with that harness's own command.
 * `--only` limits the set. Already-installed copies are left alone.
 */
export async function installAll(options: { dryRun?: boolean; only?: Agent[]; log?: (line: string) => void } = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const chosen = (options.only ? options.only.map((id) => harnessByAgent(id)).filter((h): h is Harness => !!h) : detectedHarnesses()).filter(
    (harness) => !options.only || options.only.includes(harness.agent),
  );
  const present = options.only ? chosen : detectedHarnesses().filter((harness) => !options.only || options.only.includes(harness.agent));
  if (!present.length) {
    log(options.only ? `No harness in --only was recognized.` : 'No supported agent CLI is on PATH.');
    reportLeftoverGemini(options.dryRun === true, log);
    return options.only ? 1 : 0;
  }
  let failed = false;
  for (const harness of present) {
    const label = agentLabel(harness.agent);
    const how = describe(harness);
    if (harness.install.kind === 'none') {
      log(`- ${label}: ${how}`);
      continue;
    }
    if (alreadyInstalled(harness.agent) && harness.install.kind !== 'manual') {
      if (harness.agent === 'antigravity' && !options.dryRun) enableAntigravitySidecar();
      log(`- ${label}: already installed${options.dryRun ? `; would run ${how}` : ''}`);
      continue;
    }
    if (options.dryRun) {
      log(`- ${label}: ${how}`);
      continue;
    }
    if (harness.install.kind === 'manual') {
      log(`- ${label}: ${harness.install.instructions}`);
      continue;
    }
    if (harness.install.kind === 'kilo-config') {
      try {
        installKiloConfig();
        log(`- ${label}: updated ${kiloConfigPath()}`);
      } catch (err) {
        log(`- ${label}: failed: ${(err as Error).message}`);
        failed = true;
      }
      continue;
    }
    const result = await runSteps(harness.install.steps);
    if (result.ok) {
      if (harness.agent === 'antigravity' && !options.dryRun) enableAntigravitySidecar();
      log(`- ${label}: installed. ${harness.install.note ?? ''}`.trim());
    }
    else {
      const tail = result.output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? 'failed';
      log(`- ${label}: failed: ${tail}`);
      failed = true;
    }
  }
  reportLeftoverGemini(options.dryRun === true, log);
  return failed ? 1 : 0;
}

function reportLeftoverGemini(dryRun: boolean, log: (line: string) => void): void {
  const dir = leftoverGeminiExtension();
  if (!dir) return;
  if (dryRun) {
    log(`Leftover Gemini CLI extension at ${dir}. Would remove it. ${LEFTOVER_GEMINI_NOTE}`);
    return;
  }
  removeLeftoverGeminiExtension();
  log(`Removed leftover Gemini CLI extension at ${dir}. ${LEFTOVER_GEMINI_NOTE}`);
}

/** Installs one harness before `telepathy run` execs it. A manual install is a warning, not a failure. */
export async function ensureInstalled(agent: Agent): Promise<{ ok: boolean; note?: string }> {
  if (alreadyInstalled(agent)) {
    if (agent === 'antigravity') {
      enableAntigravitySidecar();
      const removed = removeLeftoverGeminiExtension();
      if (removed) process.stderr.write(`telepathy: removed leftover Gemini CLI extension at ${removed}. ${LEFTOVER_GEMINI_NOTE}\n`);
    }
    return { ok: true };
  }
  const harness = harnessByAgent(agent);
  if (!harness) return { ok: false, note: `Unknown harness ${agent}.` };
  if (harness.install.kind === 'manual' || harness.install.kind === 'none') {
    return { ok: true, note: harness.install.instructions };
  }
  if (harness.install.kind === 'kilo-config') {
    installKiloConfig();
    return { ok: true };
  }
  process.stderr.write(`telepathy: ${agentLabel(agent)} does not have telepathy installed. Installing…\n`);
  const result = await runSteps(harness.install.steps);
  if (!result.ok) {
    const tail = result.output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? 'install failed';
    return { ok: false, note: tail };
  }
  if (agent === 'antigravity') {
    enableAntigravitySidecar();
    const removed = removeLeftoverGeminiExtension();
    if (removed) process.stderr.write(`telepathy: removed leftover Gemini CLI extension at ${removed}. ${LEFTOVER_GEMINI_NOTE}\n`);
  }
  if (harness.install.note) process.stderr.write(`telepathy: ${harness.install.note}\n`);
  if (!alreadyInstalled(agent) && harness.install.kind === 'commands') {
    process.stderr.write('telepathy: the install command finished, but no copy is visible on disk yet. Starting anyway.\n');
  }
  return { ok: true };
}
