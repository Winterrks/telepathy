import { execFileSync } from 'node:child_process';
import type { Agent } from '../core/agents.ts';
import { agentLabel } from '../core/agents.ts';

/** GitHub repo the harness install commands fetch. OpenCode's package name stays `telepathy`. */
export const REPO = 'https://github.com/Winterrks/telepathy';
export const OPENCODE_SPEC = `telepathy@git+${REPO}.git`;

export interface CommandStep {
  cmd: string;
  args: string[];
}

export type InstallPlan =
  | { kind: 'commands'; steps: CommandStep[]; note?: string }
  | { kind: 'kilo-config' }
  | { kind: 'manual'; instructions: string }
  | { kind: 'none'; instructions: string };

export type RunMode = 'passthrough' | 'acp';
export type HeadlessPlane = 'claude' | 'codex' | 'opencode' | 'acp';

export interface AcpLaunch {
  /** Binary on PATH. Adapters (`claude-agent-acp`, `codex-acp`) may be absent. */
  bin: string;
  /** Tried, in order, when `bin` is not on PATH. `claude-code-acp` remains the old Claude adapter name. */
  fallbacks?: string[];
  args: string[];
  adapter: boolean;
}

export interface Harness {
  agent: Agent;
  /** Candidate executables, first match on PATH wins. */
  bins: string[];
  /** Native TUI. Unset when the product is only a headless/ACP adapter. */
  passthroughBin?: string;
  defaultMode: RunMode;
  /** Set when passthrough does not wake an idle session, so `telepathy run` says so. */
  deliveryNote?: string;
  /** Long-lived `telepathy run --headless` plane. Unset when this repo has no control plane for it. */
  headless?: HeadlessPlane;
  /** Present when `telepathy run --acp` can launch one. */
  acp?: AcpLaunch;
  install: InstallPlan;
}

const HARNESSES: Harness[] = [
  {
    agent: 'claude',
    bins: ['claude'],
    passthroughBin: 'claude',
    defaultMode: 'passthrough',
    headless: 'claude',
    acp: { bin: 'claude-agent-acp', fallbacks: ['claude-code-acp'], args: [], adapter: true },
    install: {
      kind: 'commands',
      steps: [
        { cmd: 'claude', args: ['plugin', 'marketplace', 'add', 'Winterrks/telepathy'] },
        { cmd: 'claude', args: ['plugin', 'install', 'telepathy@telepathy'] },
      ],
    },
  },
  {
    agent: 'codex',
    bins: ['codex'],
    passthroughBin: 'codex',
    defaultMode: 'passthrough',
    headless: 'codex',
    acp: { bin: 'codex-acp', args: [], adapter: true },
    install: {
      kind: 'commands',
      steps: [
        { cmd: 'codex', args: ['plugin', 'marketplace', 'add', 'Winterrks/telepathy'] },
        { cmd: 'codex', args: ['plugin', 'add', 'telepathy@telepathy'] },
      ],
    },
  },
  {
    agent: 'opencode',
    bins: ['opencode'],
    passthroughBin: 'opencode',
    defaultMode: 'passthrough',
    headless: 'opencode',
    acp: { bin: 'opencode', args: ['acp'], adapter: false },
    install: { kind: 'commands', steps: [{ cmd: 'opencode', args: ['plugin', 'add', OPENCODE_SPEC] }] },
  },
  {
    agent: 'kilo',
    bins: ['kilo', 'kilocode'],
    passthroughBin: 'kilo',
    defaultMode: 'passthrough',
    headless: 'opencode',
    install: { kind: 'kilo-config' },
  },
  {
    agent: 'gemini',
    bins: ['gemini'],
    passthroughBin: 'gemini',
    defaultMode: 'acp',
    headless: 'acp',
    acp: { bin: 'gemini', args: ['--acp'], adapter: false },
    install: {
      kind: 'commands',
      steps: [{ cmd: 'gemini', args: ['extensions', 'install', REPO, '--auto-update'] }],
    },
  },
  {
    agent: 'copilot',
    bins: ['copilot'],
    passthroughBin: 'copilot',
    defaultMode: 'acp',
    headless: 'acp',
    acp: { bin: 'copilot', args: ['--acp'], adapter: false },
    install: {
      kind: 'commands',
      steps: [
        { cmd: 'copilot', args: ['plugin', 'marketplace', 'add', 'Winterrks/telepathy'] },
        { cmd: 'copilot', args: ['plugin', 'install', 'telepathy@telepathy'] },
      ],
    },
  },
  {
    agent: 'qwen',
    bins: ['qwen'],
    passthroughBin: 'qwen',
    defaultMode: 'passthrough',
    headless: 'acp',
    deliveryNote: 'Qwen Code cannot wake an idle session; a message arrives on the next turn.',
    acp: { bin: 'qwen', args: ['--acp'], adapter: false },
    install: {
      kind: 'commands',
      steps: [{ cmd: 'qwen', args: ['extensions', 'install', `${REPO}/archive/refs/heads/main.tar.gz`, '--auto-update'] }],
    },
  },
  {
    agent: 'grok',
    bins: ['grok'],
    passthroughBin: 'grok',
    defaultMode: 'passthrough',
    deliveryNote: 'Grok wakes an idle session only after it starts the telepathy monitor, on its first prompt.',
    install: {
      kind: 'commands',
      steps: [{ cmd: 'grok', args: ['plugin', 'install', 'Winterrks/telepathy#plugin', '--trust'] }],
    },
  },
  {
    agent: 'devin',
    bins: ['devin'],
    passthroughBin: 'devin',
    defaultMode: 'passthrough',
    deliveryNote: 'Devin cannot wake an idle session; a message arrives on the next turn.',
    install: { kind: 'commands', steps: [{ cmd: 'devin', args: ['plugins', 'install', 'Winterrks/telepathy#plugin'] }] },
  },
  {
    agent: 'antigravity',
    bins: ['agy', 'antigravity'],
    passthroughBin: 'agy',
    defaultMode: 'passthrough',
    deliveryNote: 'Antigravity cannot wake an idle session; a message arrives on the next turn.',
    install: {
      kind: 'commands',
      steps: [{ cmd: 'agy', args: ['plugin', 'install', `${REPO}/tree/main/antigravity`] }],
    },
  },
  {
    agent: 'cursor',
    bins: ['cursor-agent'],
    passthroughBin: 'cursor-agent',
    defaultMode: 'passthrough',
    deliveryNote: 'Cursor hands a message over after the next tool call; it does not wake an idle session.',
    install: {
      kind: 'commands',
      steps: [{ cmd: 'cursor-agent', args: ['plugin', 'marketplace', 'add', REPO] }],
      note: 'Then install telepathy from the Marketplace tab of /plugin in the Cursor CLI.',
    },
  },
  {
    agent: 'kimi',
    bins: ['kimi', 'kimi-code'],
    passthroughBin: 'kimi',
    defaultMode: 'passthrough',
    deliveryNote: 'Kimi Code cannot wake an idle session; a message arrives on the next turn.',
    install: {
      kind: 'manual',
      instructions: `In a Kimi Code session: /plugins install ${REPO}`,
    },
  },
  {
    agent: 'hermes',
    bins: ['hermes'],
    passthroughBin: 'hermes',
    defaultMode: 'passthrough',
    deliveryNote: 'Telepathy has no Hermes plugin yet. The process starts, and it will not see messages.',
    install: { kind: 'none', instructions: 'Telepathy has no Hermes install command yet.' },
  },
  {
    agent: 'openclaw',
    bins: ['openclaw'],
    passthroughBin: 'openclaw',
    defaultMode: 'passthrough',
    deliveryNote: 'Telepathy has no OpenClaw plugin yet. The process starts, and it will not see messages.',
    install: { kind: 'none', instructions: 'Telepathy has no OpenClaw install command yet.' },
  },
  {
    agent: 'pi',
    bins: ['pi'],
    passthroughBin: 'pi',
    defaultMode: 'passthrough',
    deliveryNote: 'Telepathy has no Pi plugin yet. The process starts, and it will not see messages.',
    install: { kind: 'none', instructions: 'Telepathy has no Pi install command yet.' },
  },
];

export const harnesses = (): Harness[] => HARNESSES;
export const harnessByAgent = (agent: Agent): Harness | undefined => HARNESSES.find((h) => h.agent === agent);

export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The executable this machine has, or the preferred name when none is installed. */
export function resolvedBin(harness: Harness, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return harness.bins.find((bin) => onPath(bin, env));
}

/** `claude-agent-acp` when it is installed, otherwise the old `claude-code-acp` name. */
export function resolvedAcpBin(acp: AcpLaunch, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return [acp.bin, ...(acp.fallbacks ?? [])].find((bin) => onPath(bin, env));
}

export function acpCommand(acp: AcpLaunch, env: NodeJS.ProcessEnv = process.env): string {
  const bin = resolvedAcpBin(acp, env) ?? acp.bin;
  return `${bin} ${acp.args.join(' ')}`.trim();
}

export function detectedHarnesses(env: NodeJS.ProcessEnv = process.env): Harness[] {
  return HARNESSES.filter((harness) => resolvedBin(harness, env));
}

/** Default `telepathy run` mode: ACP where the native TUI cannot wake, otherwise the vendor CLI. */
export function defaultRunMode(harness: Harness): RunMode {
  return harness.defaultMode;
}

export function describeRun(harness: Harness): string {
  const mode = harness.defaultMode === 'acp' && harness.acp ? acpCommand(harness.acp) : (harness.passthroughBin ?? harness.bins[0]);
  const headless = harness.headless ? `headless: ${harness.headless}` : 'no headless plane';
  const note = harness.deliveryNote ? ` — ${harness.deliveryNote}` : harness.defaultMode === 'acp' ? ' — ACP host (no idle wake in the native TUI)' : ' — native TUI, idle wake';
  const forced = harness.acp && harness.defaultMode !== 'acp' ? ` --acp: ${acpCommand(harness.acp)}` : '';
  return `${harness.agent.padEnd(12)} ${harness.defaultMode.padEnd(12)} ${mode.padEnd(28)} ${headless}${note}${forced}`;
}

export function listRuns(): string {
  const lines = [
    'agent        default      command                      notes',
    ...HARNESSES.map((harness) => describeRun(harness)),
    '',
    'passthrough execs the vendor CLI with your arguments and a full TTY.',
    'acp is the default only where the native TUI cannot wake an idle session (Gemini CLI, Copilot CLI).',
    '--acp forces an ACP host where one exists. --headless keeps a peer up until `telepathy stop`.',
    `Labels: ${HARNESSES.map((harness) => agentLabel(harness.agent)).join(', ')}.`,
  ];
  return lines.join('\n');
}
