/**
 * Names a harness must forward into the plugin MCP server.
 * Codex copies only `env_vars`. Anything missing is invisible, so `TELEPATHY_AUTO_UPDATE=0`
 * never reaches the server and auto-update runs against the real installs.
 * `TELEPATHY_AGENT_PID` stays out: it is the parent process, not the agent.
 */
export const FORWARDED_ENV = [
  'TELEPATHY_HOME',
  'TELEPATHY_AUTO_UPDATE',
  'TELEPATHY_NAME',
  'TELEPATHY_DEBUG',
  'TELEPATHY_CODEX_BIN',
  'TELEPATHY_LATEST_VERSION',
  'TELEPATHY_VERSION_URL',
  'TELEPATHY_CONFIRM_WAIT',
  'TELEPATHY_CONFIRM_ABORT_MS',
  'TELEPATHY_CONFIRM_GRACE_MS',
  'TELEPATHY_CONFIRM_POLL_MS',
  'TELEPATHY_WAKE_DEBOUNCE_MS',
  'TELEPATHY_WAKE_DEBOUNCE_MAX_MS',
  'TELEPATHY_TRANSCRIPT_DIR',
  'TELEPATHY_HOLD_REPOST_DELAY_MS',
  'TELEPATHY_MANAGED_SETTINGS_DIR',
  'TELEPATHY_SOCKET_WAIT_MS',
  'TELEPATHY_AUTO_UPDATE_ENTRY',
  'TELEPATHY_CODEX_PROCS',
  'TELEPATHY_PS_BIN',
  'CODEX_HOME',
] as const;

/**
 * Environment written into a Copilot `--additional-mcp-config` file, and passed on ACP `session/new`.
 * Copilot inherits `PATH` and otherwise uses only the `env` object in that file, so the variables the
 * server reads have to be listed. Everything else, including tokens, stays off disk.
 */
const MCP_ENV_EXACT = new Set<string>([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'COPILOT_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  ...FORWARDED_ENV,
]);

export function mcpChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value) continue;
    if (key.startsWith('TELEPATHY_') || MCP_ENV_EXACT.has(key)) out[key] = value;
  }
  return out;
}
