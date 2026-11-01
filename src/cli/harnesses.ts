import { execFileSync } from 'node:child_process';
import { agentLabel, isAgent, type Agent } from '../core/agents.ts';

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
  /** Kimi Code has no plugin subcommand. Telepathy does what its `/plugins install` does (src/core/kimi-plugin.ts). */
  | { kind: 'kimi' }
  | { kind: 'manual'; instructions: string }
  | { kind: 'none'; instructions: string };

export type RunMode = 'passthrough' | 'acp';
export type HeadlessPlane = 'claude' | 'codex' | 'opencode' | 'acp' | 'antigravity';

export interface AcpLaunch {
  /** Binary on PATH. Adapters (`claude-agent-acp`, `codex-acp`) may be absent. */
  bin: string;
  /** Tried, in order, when `bin` is not on PATH. `claude-code-acp` remains the old Claude adapter name. */
  fallbacks?: string[];
  args: string[];
  adapter: boolean;
  /** How to get a missing adapter. */
  installHint?: string;
}

export interface Harness {
  agent: Agent;
  /** Candidate executables, first match on PATH wins. */
  bins: string[];
  /** Native TUI. Unset when the product is only a headless/ACP adapter. */
  passthroughBin?: string;
  /** `acp` wherever the harness has an ACP mode; `--tui` still execs the vendor CLI. */
  defaultMode: RunMode;
  /** Set when the vendor TUI does not wake an idle session, so `telepathy run --tui` says so. */
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
    defaultMode: 'acp',
    headless: 'claude',
    acp: {
      bin: 'claude-agent-acp',
      fallbacks: ['claude-code-acp'],
      args: [],
      adapter: true,
      installHint: 'npm install -g @zed-industries/claude-agent-acp',
    },
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
    defaultMode: 'acp',
    headless: 'codex',
    acp: { bin: 'codex-acp', args: [], adapter: true, installHint: 'npm install -g @zed-industries/codex-acp' },
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
    defaultMode: 'acp',
    headless: 'opencode',
    acp: { bin: 'opencode', args: ['acp'], adapter: false },
    install: { kind: 'commands', steps: [{ cmd: 'opencode', args: ['plugin', 'add', OPENCODE_SPEC] }] },
  },
  {
    agent: 'kilo',
    bins: ['kilo', 'kilocode'],
    passthroughBin: 'kilo',
    defaultMode: 'acp',
    headless: 'opencode',
    acp: { bin: 'kilo', fallbacks: ['kilocode'], args: ['acp'], adapter: false },
    install: { kind: 'kilo-config' },
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
    defaultMode: 'acp',
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
    defaultMode: 'acp',
    acp: { bin: 'grok', args: ['agent', 'stdio'], adapter: false },
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
    defaultMode: 'acp',
    acp: { bin: 'devin', args: ['acp'], adapter: false },
    deliveryNote: 'Devin cannot wake an idle session; a message arrives on the next turn.',
    install: { kind: 'commands', steps: [{ cmd: 'devin', args: ['plugins', 'install', 'Winterrks/telepathy#plugin'] }] },
  },
  {
    agent: 'antigravity',
    bins: ['agy', 'antigravity'],
    passthroughBin: 'agy',
    defaultMode: 'acp',
    headless: 'antigravity',
    deliveryNote:
      'Antigravity CLI delivers at the next turn (no idle inject). The App is woken by the telepathy sidecar. The IDE has no idle wake yet.',
    acp: { bin: 'antigravity-acp', fallbacks: ['agy_acp_server.par'], args: [], adapter: true },
    install: {
      kind: 'commands',
      steps: [{ cmd: 'agy', args: ['plugin', 'install', `${REPO}/tree/main/antigravity`] }],
      note: 'Enables the App sidecar in ~/.gemini/config/config.json. A leftover ~/.gemini/extensions/telepathy is removed so `agy plugin import gemini` does not install telepathy twice.',
    },
  },
  {
    agent: 'cursor',
    bins: ['cursor-agent'],
    passthroughBin: 'cursor-agent',
    defaultMode: 'acp',
    acp: { bin: 'cursor-agent', args: ['acp'], adapter: false },
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
    defaultMode: 'acp',
    acp: { bin: 'kimi', fallbacks: ['kimi-code'], args: ['acp'], adapter: false },
    deliveryNote: 'Kimi Code cannot wake an idle session; a message arrives on the next turn.',
    install: { kind: 'kimi' },
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

/** `telepathy run agy` is Antigravity. Other names are agent ids. */
export function canonicalRunAgent(name: string | undefined): Agent | undefined {
  if (!name) return undefined;
  if (name === 'agy') return 'antigravity';
  return isAgent(name) ? name : undefined;
}

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

/** Default `telepathy run` mode: the ACP host wherever the harness has an ACP mode, otherwise the vendor CLI. */
export function defaultRunMode(harness: Harness): RunMode {
  return harness.acp ? harness.defaultMode : 'passthrough';
}

/** The plane `--headless` uses: the harness's own control plane, or its ACP mode when it has no other. */
export function headlessPlane(harness: Harness, forceAcp: boolean): HeadlessPlane | undefined {
  if (forceAcp) return harness.acp ? 'acp' : undefined;
  return harness.headless ?? (harness.acp ? 'acp' : undefined);
}

export function describeRun(harness: Harness): string {
  const mode = defaultRunMode(harness);
  const command = mode === 'acp' && harness.acp ? acpCommand(harness.acp) : (harness.passthroughBin ?? harness.bins[0]);
  const plane = headlessPlane(harness, false);
  const headless = plane ? `headless: ${plane}` : 'no headless plane';
  const note = mode === 'acp' ? ' — ACP host, a message starts a turn' : harness.deliveryNote ? ` — ${harness.deliveryNote}` : ' — native TUI, idle wake';
  const tui = mode === 'acp' && harness.passthroughBin ? ` --tui: ${harness.passthroughBin}` : '';
  return `${harness.agent.padEnd(12)} ${mode.padEnd(12)} ${command.padEnd(28)} ${headless}${note}${tui}`;
}

export function listRuns(): string {
  const lines = [
    'agent        default      command                      notes',
    ...HARNESSES.map((harness) => describeRun(harness)),
    '',
    'acp starts the harness in its ACP mode under telepathy, so a message starts a turn while it is idle.',
    'passthrough (and --tui) execs the vendor CLI with your arguments and a full TTY. A session started that way is reachable through its plugin.',
    'agy is an alias for antigravity. --headless keeps a peer up until `telepathy stop`.',
    `Labels: ${HARNESSES.map((harness) => agentLabel(harness.agent)).join(', ')}.`,
  ];
  return lines.join('\n');
}
