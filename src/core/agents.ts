import path from 'node:path';

/**
 * Every agent telepathy knows. The id is what addresses and refs start with (`gemini:api`, `gemini-4242`),
 * so it must stay short, lowercase and free of `:`.
 */
export const AGENT_IDS = [
  'claude',
  'codex',
  'opencode',
  'kilo',
  'gemini',
  'qwen',
  'copilot',
  'cursor',
  'kimi',
  'grok',
  'devin',
  'antigravity',
  'hermes',
  'openclaw',
  'pi',
] as const;

export type Agent = (typeof AGENT_IDS)[number];

export interface AgentSpec {
  id: Agent;
  /** Product name shown to models and people: "Gemini CLI". */
  label: string;
  /**
   * Recognizes the agent's main process while walking up the process tree. `names` match the executable's
   * basename; `script` matches the command line when the executable is an interpreter (node, bun, python),
   * as for CLIs installed as npm or Python scripts. `exe` matches the executable's full path, for generic
   * names like `agent` (which both Grok and Cursor install).
   */
  names?: string[];
  script?: RegExp;
  exe?: RegExp;
  /**
   * Environment variables only this agent sets for its MCP servers or hooks. Used only when the process walk
   * finds no agent, since children inherit them (a Claude session started from a Gemini shell has GEMINI_CLI).
   */
  env?: string[];
  /** Its hooks hand pending messages to the model at the next turn (when nothing can wake it while idle). */
  nextTurnHook?: boolean;
}

const SPECS: Record<Agent, AgentSpec> = {
  // Its plugin monitor wakes interactive CLI sessions; the hooks cover sessions without one (the Claude app's Code
  // tab and `claude -p` run in stream-json mode, where plugin monitors don't start).
  claude: { id: 'claude', label: 'Claude Code', names: ['claude'], nextTurnHook: true },
  codex: { id: 'codex', label: 'Codex', names: ['codex'] },
  opencode: { id: 'opencode', label: 'OpenCode', names: ['opencode', '.opencode'], script: /(^|[\s/])opencode(\.js)?(\s|$)/ },
  kilo: { id: 'kilo', label: 'Kilo Code', names: ['kilo', 'kilocode'], script: /(^|[\s/])kilo(code)?(\.js)?(\s|$)/ },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    names: ['gemini'],
    script: /(^|[\s/])gemini(\.js)?(\s|$)/,
    env: ['GEMINI_CLI'],
    nextTurnHook: true,
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen Code',
    names: ['qwen'],
    script: /(^|[\s/])qwen(\s|$)|qwen-code\/(cli|dist\/index)\.js/,
    nextTurnHook: true,
  },
  copilot: {
    id: 'copilot',
    label: 'Copilot CLI',
    names: ['copilot'],
    script: /(^|[\s/])copilot(\.js)?(\s|$)/,
    env: ['COPILOT_AGENT_SESSION_ID', 'COPILOT_CLI'],
    nextTurnHook: true,
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    names: ['cursor-agent'],
    script: /(^|[\s/])cursor-agent(\s|$)|\/cursor-agent\/versions\//,
    exe: /cursor-agent\/.*\/(agent|cursor-agent)$/,
    env: ['CURSOR_PLUGIN_ROOT'],
    nextTurnHook: true,
  },
  kimi: { id: 'kimi', label: 'Kimi Code', names: ['kimi-code', 'kimi'], env: ['KIMI_PLUGIN_ROOT'], nextTurnHook: true },
  grok: {
    id: 'grok',
    label: 'Grok CLI',
    names: ['grok'],
    exe: /\/\.grok\/(bin|downloads)\/[^/]+$/,
    env: ['GROK_SESSION_ID'],
    nextTurnHook: true,
  },
  devin: { id: 'devin', label: 'Devin CLI', names: ['devin'], env: ['DEVIN_PLUGIN_ROOT', 'DEVIN_PROJECT_DIR'], nextTurnHook: true },
  antigravity: { id: 'antigravity', label: 'Antigravity', names: ['agy', 'antigravity'], nextTurnHook: true },
  hermes: { id: 'hermes', label: 'Hermes Agent', names: ['hermes'], script: /(^|[\s/])hermes(\s|$)/ },
  openclaw: { id: 'openclaw', label: 'OpenClaw', names: ['openclaw'], script: /(^|[\s/])openclaw(\.mjs|\.js)?(\s|$)/ },
  pi: { id: 'pi', label: 'Pi', names: ['pi'], script: /(^|[\s/])pi(\s|$)|pi-coding-agent\/dist\/cli\.js/ },
};

export const agentSpec = (agent: Agent): AgentSpec => SPECS[agent];
export const agentLabel = (agent: Agent): string => SPECS[agent].label;

/** The agent whose own environment variables are set, for when the process walk finds none. */
export function agentFromEnv(env: NodeJS.ProcessEnv = process.env): Agent | undefined {
  return AGENT_IDS.find((a) => SPECS[a].env?.some((name) => !!env[name]));
}

export function isAgent(value: unknown): value is Agent {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

export function parseAgent(value: string | undefined): Agent {
  if (isAgent(value)) return value;
  throw new Error(`--agent must be one of ${AGENT_IDS.join(', ')} (got ${JSON.stringify(value)})`);
}

/** `^(claude|codex|…)` alternation, longest first so `kilo` never shadows a longer id. */
export const AGENT_ALTERNATION = [...AGENT_IDS].sort((a, b) => b.length - a.length).join('|');

const INTERPRETERS = /^(node|nodejs|bun|deno|python(\d+(\.\d+)*)?|Python)$/;

/**
 * True when a process is `agent`'s main process. `comm` is its executable path as `ps` shows it; `kernelName`
 * and `args` are looked up lazily. `comm` comes from argv[0], so a wrapper that runs `exec -a <name> node …`
 * (Cursor's CLI) leaves only the kernel's name saying the process is node.
 */
export function isAgentProcess(
  agent: Agent,
  comm: string,
  args: () => string | undefined,
  kernelName: () => string | undefined = () => undefined,
): boolean {
  const spec = SPECS[agent];
  const exe = path.basename(comm);
  if (spec.names?.includes(exe) || spec.exe?.test(comm)) return true;
  if (spec.script && (INTERPRETERS.test(exe) || INTERPRETERS.test(kernelName() ?? ''))) {
    const line = args();
    return !!line && spec.script.test(line);
  }
  return false;
}
