import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAgyApiKey } from '../cli/agy-auth.ts';
import { canonicalRunAgent, harnessByAgent, harnesses, resolvedAcpBin } from '../cli/harnesses.ts';
import { agentLabel } from '../core/agents.ts';
import { partyOf } from '../core/messages.ts';
import { envDurationMs, stateDir, writeJsonAtomic } from '../core/paths.ts';
import { listPeers, type Peer, slugify } from '../core/peers.ts';
import { isAlive } from '../core/proc.ts';
import { removeCleanWorktree } from './worktree.ts';
import { sandboxSpawnBlock } from '../core/sandbox-launch.ts';
import type { ToolResult } from '../core/tools.ts';
import {
  agentDir,
  type AgentEntry,
  type AgentSpec,
  hostAlive,
  listAgents,
  PERMISSION_ID,
  permissionAnswerFile,
  permissionRequestFile,
  readState,
  transcriptFile,
  type Worktree,
  writeSpec,
} from './spec.ts';

/** Harnesses `start_agent` can start: those with an ACP mode. */
export const startableHarnesses = () => harnesses().filter((h) => h.acp).map((h) => h.agent);

const startWaitMs = () => envDurationMs('TELEPATHY_AGENT_START_MS', 90_000);

/**
 * How to run the agent host from this process: `agent.mjs` next to a bundled server, `agent-main.ts` from
 * source, or the telepathy CLI's `agent-host` command.
 */
function hostCommand(dir: string): { cmd: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of [path.join(here, 'agent.mjs'), path.join(here, '..', 'agent-main.ts')]) {
    if (fs.existsSync(file)) return { cmd: process.execPath, args: [...process.execArgv, file, dir] };
  }
  return { cmd: process.execPath, args: [...process.execArgv, process.argv[1] ?? '', 'agent-host', dir] };
}

export interface StartArgs {
  harness: string;
  prompt: string;
  description: string;
  name?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  isolation?: 'worktree';
}

const failed = (text: string): ToolResult => ({ text, isError: true });

/**
 * A slug no live agent or session of this harness has, and whose worktree folder (kept after changes, or left by a
 * failed start) and branch are free. `busy` adds the caller's own checks.
 */
function freeSlug(harness: string, wanted: string, busy: (slug: string) => boolean = () => false): string {
  const taken = new Set(listPeers().filter((p) => p.agent === harness).map((p) => p.address.slice(harness.length + 1)));
  for (const entry of listAgents()) if (entry.spec.harness === harness && hostAlive(entry.state)) taken.add(entry.spec.slug);
  const free = (slug: string) =>
    !taken.has(slug) && !fs.existsSync(path.join(stateDir(), 'worktrees', `${harness}-${slug}`)) && !busy(slug);
  if (free(wanted)) return wanted;
  for (let n = 2; ; n++) if (free(`${wanted}-${n}`)) return `${wanted}-${n}`;
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeWorktree(cwd: string, harness: string, slug: string): Worktree & { cwd: string } {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = git('rev-parse', '--show-toplevel');
  const base = git('rev-parse', 'HEAD');
  const tree = path.join(stateDir(), 'worktrees', `${harness}-${slug}`);
  const branch = `telepathy/${slug}`;
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  git('worktree', 'add', '-b', branch, tree, base);
  const inside = path.relative(fs.realpathSync(repo), fs.realpathSync(cwd));
  return { repo, path: tree, branch, base, cwd: inside && !inside.startsWith('..') ? path.join(tree, inside) : tree };
}

export async function startAgentTool(self: Peer, args: StartArgs): Promise<ToolResult> {
  const harness = canonicalRunAgent(args.harness);
  const known = harness ? harnessByAgent(harness) : undefined;
  if (!harness || !known?.acp) {
    return failed(`Not started: "${args.harness}" has no ACP mode. start_agent can start: ${startableHarnesses().join(', ')}.`);
  }
  const acpBin = resolvedAcpBin(known.acp);
  // In a test sandbox, a real adapter outside the temp dir counts as absent rather than being started.
  if (!acpBin || sandboxSpawnBlock(acpBin)) {
    const hint = known.acp.installHint ? ` Install it with \`${known.acp.installHint}\`.` : '';
    return failed(`Not started: ${agentLabel(harness)} needs \`${known.acp.bin}\` on PATH for ACP, and it is not there.${hint}`);
  }
  if (harness === 'antigravity') {
    const auth = ensureAgyApiKey();
    if (!auth.ok) return failed(`Not started: ${auth.warning}`);
  }
  if (!args.prompt.trim()) return failed('Not started: the prompt is empty.');

  let cwd = path.resolve(args.cwd ?? self.cwd ?? process.cwd());
  let isDir = false;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch {
    return failed(`Not started: ${cwd} does not exist.`);
  }
  if (!isDir) return failed(`Not started: ${cwd} is not a directory.`);
  const base = cwd;
  const slug = freeSlug(
    harness,
    slugify(args.name ?? args.description) || `${harness}-agent`,
    (candidate) => args.isolation === 'worktree' && branchExists(base, `telepathy/${candidate}`),
  );
  let worktree: Worktree | undefined;
  if (args.isolation === 'worktree') {
    try {
      const made = makeWorktree(cwd, harness, slug);
      cwd = made.cwd;
      worktree = { repo: made.repo, path: made.path, branch: made.branch, base: made.base };
    } catch (err) {
      return failed(`Not started: could not make a git worktree from ${cwd}: ${(err as Error).message.trim()}`);
    }
  }

  const dir = agentDir(harness, slug);
  fs.rmSync(dir, { recursive: true, force: true });
  const spec: AgentSpec = {
    harness,
    slug,
    description: args.description,
    prompt: args.prompt,
    model: args.model,
    effort: args.effort,
    cwd,
    isolation: args.isolation,
    worktree,
    parent: partyOf(self),
    createdAt: new Date().toISOString(),
  };
  writeSpec(dir, spec);
  const { cmd, args: argv } = hostCommand(dir);
  const log = fs.openSync(path.join(dir, 'host.log'), 'a');
  const child = spawn(cmd, argv, { cwd, detached: true, stdio: ['ignore', log, log], env: process.env });
  // Without a listener, a spawn error is an uncaught 'error' event and takes this whole MCP server down.
  let spawnError: string | undefined;
  child.on('error', (err) => (spawnError = err.message));
  child.unref();
  fs.closeSync(log);

  const deadline = Date.now() + startWaitMs();
  while (Date.now() < deadline) {
    const state = readState(dir);
    if (state?.status === 'failed') return failed(`Not started: ${agentLabel(harness)} ${state.error ?? 'failed to start'}.`.replace(/\.\.$/, '.'));
    if (state?.status === 'ready' && state.address && state.peerId) {
      const settings = state.settings?.length ? state.settings.join(', ') : 'its default settings';
      return {
        text: [
          `Started ${state.address} [${state.peerId}], ${agentLabel(harness)} in ${cwd}, with ${settings}.`,
          `Transcript: ${transcriptFile(dir)}`,
          worktree ? `It works in its own worktree on branch ${worktree.branch}; an unchanged worktree is removed when it stops.` : '',
          `It works in the background. When its turn ends, its final message arrives here as a message from it ` +
            `(kind="agent-result") with that transcript path. Don't wait or poll for it. Continue it with send_message to ` +
            `"${state.address}"; stop it with stop_agent when you no longer need it.`,
          ...(state.notes ?? []),
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }
    if (spawnError) {
      removeCleanWorktree(spec);
      return failed(`Not started: could not run the agent host (${spawnError}).`);
    }
    if (child.exitCode !== null && !hostAlive(readState(dir))) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  try {
    if (child.pid) process.kill(child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  // A host killed before it was ready never reaches its own cleanup.
  for (let i = 0; i < 20 && child.exitCode === null && child.pid && isAlive(child.pid); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  removeCleanWorktree(spec);
  return failed(`Not started: ${agentLabel(harness)} did not get ready within ${Math.round(startWaitMs() / 1000)}s. See ${path.join(dir, 'host.log')}.`);
}

/** The agent `name` names among those this session started: its address, ref, or name. */
function findChild(self: Peer, name: string): AgentEntry | { error: string } {
  const q = name.trim().replace(/^["'`]|["'`]$/g, '').replace(/^.*\[([^\]]+)\]\s*$/, '$1').toLowerCase();
  const matches = listAgents().filter((entry) => {
    const keys = [entry.spec.slug, `${entry.spec.harness}:${entry.spec.slug}`, entry.state?.address, entry.state?.peerId];
    return keys.some((key) => key?.toLowerCase() === q);
  });
  const mine = matches.filter((entry) => entry.spec.parent.id === self.id);
  const pick = (mine.length ? mine : matches).sort((a, b) => b.spec.createdAt.localeCompare(a.spec.createdAt))[0];
  if (!pick) return { error: `No agent named "${name}" was started with start_agent.` };
  if (pick.spec.parent.id !== self.id) return { error: `${name} was started by ${pick.spec.parent.address}, not this session.` };
  return pick;
}

export async function stopAgentTool(self: Peer, name: string): Promise<ToolResult> {
  const found = findChild(self, name);
  if ('error' in found) return failed(found.error);
  const address = found.state?.address ?? `${found.spec.harness}:${found.spec.slug}`;
  if (!hostAlive(found.state)) return { text: `${address} is not running.` };
  process.kill(found.state!.pid, 'SIGTERM');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && readState(found.dir)?.status !== 'stopped') await new Promise((resolve) => setTimeout(resolve, 150));
  const state = readState(found.dir);
  const kept = state?.worktreeKept && found.spec.worktree ? ` Its worktree ${found.spec.worktree.path} (branch ${found.spec.worktree.branch}) has changes and was kept.` : '';
  return { text: `Stopped ${address}. Transcript: ${transcriptFile(found.dir)}.${kept}` };
}

export function answerPermissionTool(self: Peer, args: { agent: string; request: string; allow: boolean }): ToolResult {
  if (!PERMISSION_ID.test(args.request)) return failed(`"${args.request}" is not a permission request id.`);
  const found = findChild(self, args.agent);
  if ('error' in found) return failed(found.error);
  if (!fs.existsSync(permissionRequestFile(found.dir, args.request))) {
    return failed(`${args.agent} has no permission request "${args.request}".`);
  }
  const answer = permissionAnswerFile(found.dir, args.request);
  if (fs.existsSync(answer)) return failed(`Request "${args.request}" was already answered.`);
  if (!hostAlive(found.state)) return failed(`${args.agent} is no longer running.`);
  writeJsonAtomic(answer, { allow: args.allow, at: new Date().toISOString() });
  return { text: `${args.allow ? 'Allowed' : 'Denied'} request ${args.request} for ${found.state?.address ?? args.agent}.` };
}
