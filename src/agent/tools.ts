import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalRunAgent, harnessByAgent, harnesses, resolvedAcpBin } from '../cli/harnesses.ts';
import { type Agent, agentLabel } from '../core/agents.ts';
import { type Party, partyOf } from '../core/messages.ts';
import { ensureDir, envDurationMs, readJson, stateDir, writeJsonAtomic } from '../core/paths.ts';
import { listPeers, type Peer, slugify } from '../core/peers.ts';
import { isAlive } from '../core/proc.ts';
import { removeCleanWorktree } from './worktree.ts';
import { type PermissionPolicy, readPolicy, updatePolicy } from './policy.ts';
import { sandboxSpawnBlock } from '../core/sandbox-launch.ts';
import type { ToolResult } from '../core/tools.ts';
import {
  agentDir,
  agentsDir,
  type AgentEntry,
  type AgentSpec,
  type AgentState,
  hostAlive,
  listAgents,
  PERMISSION_ID,
  permissionAnswerFile,
  permissionRequestFile,
  permissionsDir,
  permissionWaitMs,
  type PermissionRequest,
  readState,
  transcriptFile,
  type Worktree,
  writeSpec,
} from './spec.ts';

/** Harnesses `start_agent` can start: those with an ACP mode. */
export const startableHarnesses = () => harnesses().filter((h) => h.acp).map((h) => h.agent);

export const startWaitMs = () => envDurationMs('TELEPATHY_AGENT_START_MS', 90_000);

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
  /** Its permission policy from the start (src/agent/policy.ts); set_permission_mode changes it later. */
  permissions?: { mode?: 'ask' | 'auto'; allow?: string[]; model?: string };
}

const failed = (text: string): ToolResult => ({ text, isError: true });

/**
 * A slug no live agent or session of this harness has, and whose worktree folder (kept after changes, or left by a
 * failed start) and branch are free, reserved by making the agent's folder: two starts at once (Claude sends several
 * Agent calls in one message) can't take the same name. `busy` adds the caller's own checks.
 */
function reserveSlug(harness: Agent, wanted: string, busy: (slug: string) => boolean = () => false): string {
  const taken = new Set(listPeers().filter((p) => p.agent === harness).map((p) => p.address.slice(harness.length + 1)));
  for (const entry of listAgents()) if (entry.spec.harness === harness && hostAlive(entry.state)) taken.add(entry.spec.slug);
  const free = (slug: string) =>
    !taken.has(slug) && !fs.existsSync(path.join(stateDir(), 'worktrees', `${harness}-${slug}`)) && !busy(slug);
  ensureDir(agentsDir());
  for (let n = 1; ; n++) {
    const slug = n === 1 ? wanted : `${wanted}-${n}`;
    if (free(slug) && claimDir(agentDir(harness, slug))) return slug;
  }
}

/**
 * Makes an agent's folder, or reuses the folder of an agent whose host has exited. A folder with a live host, or
 * one another start made moments ago and has no host state in yet, is someone else's.
 */
function claimDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const state = readState(dir);
  if (hostAlive(state)) return false;
  if (!state) {
    let age = 0;
    try {
      age = Date.now() - fs.statSync(dir).mtimeMs;
    } catch {
      return false;
    }
    if (age < startWaitMs() + 10_000) return false;
  }
  // Moved aside first, so of two starts reusing it, one makes the new folder and the other moves on.
  const aside = `${dir}.old-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.renameSync(dir, aside);
  } catch {
    return false;
  }
  fs.rmSync(aside, { recursive: true, force: true });
  try {
    fs.mkdirSync(dir);
    return true;
  } catch {
    return false;
  }
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

/** Who an agent is started for: a session here, or one on another device through this device's bridge. */
export interface AgentParent {
  party: Party;
  /** Its folder, where the agent works unless the call names another. */
  cwd?: string;
  remote?: AgentSpec['remote'];
}

export const parentOf = (self: Peer): AgentParent => ({ party: partyOf(self), cwd: self.cwd });

export type Launched =
  | { ok: true; dir: string; spec: AgentSpec; address: string; child: ChildProcess; spawnError: () => string | undefined }
  | { ok: false; text: string };

/**
 * Checks the request, reserves the name, makes the worktree, and spawns the detached host, without waiting for
 * it to get ready. start_agent waits for it; as an MCP task, the task follows it instead.
 */
export function launchAgent(parent: AgentParent, args: StartArgs): Launched {
  const fail = (text: string): Launched => ({ ok: false, text });
  const harness = canonicalRunAgent(args.harness);
  const known = harness ? harnessByAgent(harness) : undefined;
  if (!harness || !known?.acp) {
    return fail(`Not started: "${args.harness}" has no ACP mode. start_agent can start: ${startableHarnesses().join(', ')}.`);
  }
  const acpBin = resolvedAcpBin(known.acp);
  // In a test sandbox, a real adapter outside the temp dir counts as absent rather than being started.
  if (!acpBin || sandboxSpawnBlock(acpBin)) {
    const hint = known.acp.installHint ? ` Install it with \`${known.acp.installHint}\`.` : '';
    return fail(`Not started: ${agentLabel(harness)} needs \`${known.acp.bin}\` on PATH for ACP, and it is not there.${hint}`);
  }
  if (!args.prompt.trim()) return fail('Not started: the prompt is empty.');

  let cwd = path.resolve(args.cwd ?? parent.cwd ?? process.cwd());
  let isDir = false;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch {
    return fail(`Not started: ${cwd} does not exist.`);
  }
  if (!isDir) return fail(`Not started: ${cwd} is not a directory.`);
  const base = cwd;
  const slug = reserveSlug(
    harness,
    slugify(args.name ?? args.description) || `${harness}-agent`,
    (candidate) => args.isolation === 'worktree' && branchExists(base, `telepathy/${candidate}`),
  );
  const dir = agentDir(harness, slug);
  let worktree: Worktree | undefined;
  if (args.isolation === 'worktree') {
    try {
      const made = makeWorktree(cwd, harness, slug);
      cwd = made.cwd;
      worktree = { repo: made.repo, path: made.path, branch: made.branch, base: made.base };
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      return fail(`Not started: could not make a git worktree from ${cwd}: ${(err as Error).message.trim()}`);
    }
  }

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
    parent: parent.party,
    ...(parent.remote ? { remote: parent.remote } : {}),
    createdAt: new Date().toISOString(),
  };
  writeSpec(dir, spec);
  if (args.permissions) updatePolicy(dir, { mode: args.permissions.mode, allow: args.permissions.allow, model: args.permissions.model });
  const { cmd, args: argv } = hostCommand(dir);
  const log = fs.openSync(path.join(dir, 'host.log'), 'a');
  const child = spawn(cmd, argv, { cwd, detached: true, stdio: ['ignore', log, log], env: process.env });
  // Without a listener, a spawn error is an uncaught 'error' event and takes this whole MCP server down.
  let spawnError: string | undefined;
  child.on('error', (err) => (spawnError = err.message));
  child.unref();
  fs.closeSync(log);
  return { ok: true, dir, spec, address: `${harness}:${slug}`, child, spawnError: () => spawnError };
}

/**
 * Who decides its permission requests. Auto mode is the harness's own where it has one over ACP, and telepathy's
 * reviewer only where it has none; `ask` turns that reviewer off. The allow list comes first either way.
 */
function decides(policy: PermissionPolicy, noAutoMode: boolean | undefined, label: string): string {
  if (!noAutoMode) return "its harness's own auto mode decides, and what it still asks about comes to you";
  if (policy.mode === 'ask') return "it has no auto mode over ACP, and telepathy's is off: each permission request it makes comes to you";
  const model = policy.model ? `model ${policy.model}` : 'its cheapest model, medium effort';
  return `it has no auto mode over ACP, so telepathy's is on: a reviewer session of ${label} (${model}) approves routine permission requests, and the rest come to you`;
}

const allowSentence = (policy: PermissionPolicy) => (policy.allow.length ? `Allowed without asking: ${policy.allow.join(', ')}.` : '');

/** start_agent's line on permissions: nothing for a harness in its own auto mode with no allow list. */
export function policyLine(policy: PermissionPolicy | undefined, noAutoMode: boolean | undefined, label: string): string {
  if (!policy) return '';
  const who = noAutoMode ? decides(policy, noAutoMode, label) : '';
  return [who ? `${who[0].toUpperCase()}${who.slice(1)}.` : '', allowSentence(policy)].filter(Boolean).join(' ');
}

/** What start_agent says once the agent is ready. `address` is how the caller reaches it. */
export function startedText(
  spec: Pick<AgentSpec, 'harness' | 'cwd' | 'worktree'>,
  state: AgentState & { policy?: PermissionPolicy },
  where: { address: string; ref: string; transcript: string; on?: string },
): string {
  const settings = state.settings?.length ? state.settings.join(', ') : 'its default settings';
  return [
    `Started ${where.address} [${where.ref}], ${agentLabel(spec.harness)} in ${spec.cwd}${where.on ? ` on ${where.on}` : ''}, with ${settings}.`,
    `Transcript: ${where.transcript}`,
    spec.worktree ? `It works in its own worktree on branch ${spec.worktree.branch}; an unchanged worktree is removed when it stops.` : '',
    policyLine(state.policy, state.noAutoMode, agentLabel(spec.harness)),
    `It works in the background. When its turn ends, its final message arrives here as a message from it ` +
      `(kind="agent-result") with that transcript path. Don't wait or poll for it. Continue it with send_message to ` +
      `"${where.address}"; stop it with stop_agent when you no longer need it.`,
    ...(state.notes ?? []),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function startAgentTool(self: Peer, args: StartArgs): Promise<ToolResult> {
  const launched = launchAgent(parentOf(self), args);
  if (!launched.ok) return failed(launched.text);
  const { dir, spec, child } = launched;
  const { harness } = spec;

  const deadline = Date.now() + startWaitMs();
  while (Date.now() < deadline) {
    const state = readState(dir);
    if (state?.status === 'failed') return failed(`Not started: ${agentLabel(harness)} ${state.error ?? 'failed to start'}.`.replace(/\.\.$/, '.'));
    if (state?.status === 'ready' && state.address && state.peerId) {
      return {
        text: startedText(spec, { ...state, policy: readPolicy(dir) }, { address: state.address, ref: state.peerId, transcript: transcriptFile(dir) }),
      };
    }
    const spawnError = launched.spawnError();
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
export function findChild(self: Peer, name: string): AgentEntry | { error: string } {
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

/** Stops an agent's host and waits up to `waitMs` for it to flush its transcript. */
export async function stopAgentEntry(entry: AgentEntry, waitMs = 15_000): Promise<AgentState | undefined> {
  const state = readState(entry.dir);
  if (!hostAlive(state)) return state;
  try {
    process.kill(state!.pid, 'SIGTERM');
  } catch {
    // gone already
  }
  // A host stopped before it was ready exits without writing `stopped`.
  const deadline = Date.now() + waitMs;
  for (let now = readState(entry.dir); Date.now() < deadline && now?.status !== 'stopped' && hostAlive(now); now = readState(entry.dir)) {
    await sleep(150);
  }
  return readState(entry.dir);
}

export const keptNote = (entry: AgentEntry, state: AgentState | undefined) =>
  state?.worktreeKept && entry.spec.worktree
    ? ` Its worktree ${entry.spec.worktree.path} (branch ${entry.spec.worktree.branch}) has changes and was kept.`
    : '';

export const agentAddress = (entry: AgentEntry) => readState(entry.dir)?.address ?? `${entry.spec.harness}:${entry.spec.slug}`;

export async function stopAgentTool(self: Peer, name: string): Promise<ToolResult> {
  const found = findChild(self, name);
  if ('error' in found) return failed(found.error);
  const address = agentAddress(found);
  if (!hostAlive(readState(found.dir))) return { text: `${address} is not running.` };
  const state = await stopAgentEntry(found);
  return { text: `Stopped ${address}. Transcript: ${transcriptFile(found.dir)}.${keptNote(found, state)}` };
}

/** The oldest permission request still waiting for an answer. */
export function openPermission(dir: string): PermissionRequest | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(permissionsDir(dir));
  } catch {
    return undefined;
  }
  return names
    .filter((name) => name.endsWith('.json') && !name.endsWith('.answer.json'))
    .map((name) => readJson<PermissionRequest>(path.join(permissionsDir(dir), name)))
    .filter(
      (request): request is PermissionRequest =>
        !!request &&
        PERMISSION_ID.test(request.id) &&
        !fs.existsSync(permissionAnswerFile(dir, request.id)) &&
        Date.now() - Date.parse(request.at) < permissionWaitMs(),
    )
    .sort((a, b) => a.at.localeCompare(b.at))[0];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function answerPermissionTool(self: Peer, args: { agent: string; request: string; allow: boolean; always?: boolean }): ToolResult {
  if (!PERMISSION_ID.test(args.request)) return failed(`"${args.request}" is not a permission request id.`);
  const found = findChild(self, args.agent);
  if ('error' in found) return failed(found.error);
  const request = readJson<PermissionRequest>(permissionRequestFile(found.dir, args.request));
  if (!request) return failed(`${args.agent} has no permission request "${args.request}".`);
  const answer = permissionAnswerFile(found.dir, args.request);
  if (fs.existsSync(answer)) return failed(`Request "${args.request}" was already answered.`);
  if (!hostAlive(found.state)) return failed(`${args.agent} is no longer running.`);
  const remembered = args.allow && args.always ? rememberPrefixes(found.dir, request.prefixes) : '';
  writeJsonAtomic(answer, { allow: args.allow, at: new Date().toISOString() });
  return { text: `${args.allow ? 'Allowed' : 'Denied'} request ${args.request} for ${found.state?.address ?? args.agent}.${remembered}` };
}

/** `always` on an answer: the request's command prefixes go on the agent's allow list. Says what happened. */
export function rememberPrefixes(dir: string, prefixes: string[] | undefined): string {
  if (!prefixes?.length) return ' Nothing was added to its allow list: that command has no prefix that is safe to allow on its own.';
  const policy = updatePolicy(dir, { add: prefixes });
  return ` From now on it runs ${prefixes.join(', ')} without asking (allowed: ${policy.allow.join(', ')}).`;
}

export interface PermissionModeArgs {
  agent: string;
  mode?: 'ask' | 'auto';
  allow?: string[];
  model?: string;
}

/** What set_permission_mode says the agent may now do. */
export function permissionModeText(address: string, policy: PermissionPolicy, noAutoMode: boolean | undefined, label: string): string {
  return `${address}: ${decides(policy, noAutoMode, label)}. ${allowSentence(policy) || 'Nothing is allowed without asking.'}`;
}

export function setPermissionModeTool(self: Peer, args: PermissionModeArgs): ToolResult {
  const found = findChild(self, args.agent);
  if ('error' in found) return failed(found.error);
  if (!hostAlive(readState(found.dir))) return failed(`${agentAddress(found)} is not running.`);
  const policy = updatePolicy(found.dir, { mode: args.mode, allow: args.allow, model: args.model });
  return { text: permissionModeText(agentAddress(found), policy, readState(found.dir)?.noAutoMode, agentLabel(found.spec.harness)) };
}
