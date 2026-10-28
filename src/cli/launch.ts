import path from 'node:path';
import type { Agent } from '../core/agents.ts';
import { installsInScope, isolatedStateRoots } from '../core/installs.ts';
import { stateDir } from '../core/paths.ts';
import { slugify } from '../core/peers.ts';

/** The harness already loads telepathy, so its server is the peer. */
export function pluginInstalled(agent: Agent): boolean {
  return installsInScope().some((install) => install.agent === agent);
}

/**
 * Environment for a process telepathy spawned.
 * When the plugin is already installed, `TELEPATHY_NAME` is the only identity: the host does not
 * register a second peer. An isolated `TELEPATHY_HOME` points Claude at the plugin inside that tree
 * instead of the copy under the real `~/.claude`.
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
  if (!env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = path.join(path.dirname(stateDir()), 'claude-config');
  const install = installsInScope().find((item) => item.agent === 'claude');
  if (!install) return;
  const dirs = (env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(path.delimiter).filter(Boolean);
  if (!dirs.includes(install.dir)) env.CLAUDE_CODE_PLUGIN_DIRS = [install.dir, ...dirs].join(path.delimiter);
}
