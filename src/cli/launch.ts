import path from 'node:path';
import type { Agent } from '../core/agents.ts';
import { findInstalls, installsInScope, isolatedStateRoots } from '../core/installs.ts';
import { stateDir } from '../core/paths.ts';
import { slugify } from '../core/peers.ts';

/**
 * The harness already loads telepathy, so its server is the peer.
 * Copilot reads `COPILOT_HOME`, `--plugin-dir`, and local folders, not the sandbox `TELEPATHY_HOME`
 * selects. An install outside that sandbox still loads, and a second host peer would sit beside it.
 */
export function pluginInstalled(agent: Agent): boolean {
  const installs = agent === 'copilot' ? findInstalls() : installsInScope();
  return installs.some((install) => install.agent === agent);
}

/**
 * Environment for a process telepathy spawned.
 * When the plugin is already installed, `TELEPATHY_NAME` is the only identity: the host does not
 * register a second peer. Isolation is `TELEPATHY_HOME` only. `CLAUDE_CONFIG_DIR` stays as the user
 * set it: on macOS the Keychain login is keyed by that directory.
 */
export function launchEnv(agent: Agent, name?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TELEPATHY_HOME: stateDir() };
  if (name && pluginInstalled(agent)) {
    const slug = slugify(name);
    if (slug) env.TELEPATHY_NAME = slug;
  }
  if (agent === 'claude') pointClaudeAtScopedPlugin(env);
  return env;
}

function pointClaudeAtScopedPlugin(env: NodeJS.ProcessEnv): void {
  if (!isolatedStateRoots()) return;
  const install = installsInScope().find((item) => item.agent === 'claude');
  if (!install) return;
  const dirs = (env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(path.delimiter).filter(Boolean);
  if (!dirs.includes(install.dir)) env.CLAUDE_CODE_PLUGIN_DIRS = [install.dir, ...dirs].join(path.delimiter);
}
