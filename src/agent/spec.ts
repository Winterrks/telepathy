import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../core/agents.ts';
import type { Party } from '../core/messages.ts';
import { ensureDir, readJson, stateDir, writeJsonAtomic } from '../core/paths.ts';
import { isAlive, isSameProcess } from '../core/proc.ts';

/**
 * An agent one session started with `start_agent`: a harness in its ACP mode, hosted by a detached
 * `agent.mjs` process. Its folder is `<state>/agents/<harness>-<slug>/`: the request, the host's state,
 * the transcript, and permission requests waiting for the parent.
 */
export interface AgentSpec {
  harness: Agent;
  slug: string;
  description: string;
  prompt: string;
  model?: string;
  effort?: string;
  /** Where it works: the caller's folder, or its own worktree. */
  cwd: string;
  isolation?: 'worktree';
  worktree?: Worktree;
  /** The session that started it. Results and permission requests go there. */
  parent: Party;
  createdAt: string;
}

export interface Worktree {
  repo: string;
  path: string;
  branch: string;
  /** The commit it started from. A worktree still there, with no changes, is removed at stop. */
  base: string;
}

export interface AgentState {
  status: 'starting' | 'ready' | 'failed' | 'stopped';
  pid: number;
  procStart?: string;
  error?: string;
  peerId?: string;
  address?: string;
  sessionId?: string;
  /** What was set over ACP, as `mode auto`, `model …`, `effort high`. */
  settings?: string[];
  /** Things the parent should know: no auto mode, an effort the harness has no setting for. */
  notes?: string[];
  /** True when the worktree had changes at stop and was kept. */
  worktreeKept?: boolean;
}

export const agentsDir = () => path.join(stateDir(), 'agents');
export const agentDir = (harness: Agent, slug: string) => path.join(agentsDir(), `${harness}-${slug}`);
export const specFile = (dir: string) => path.join(dir, 'spec.json');
export const stateFile = (dir: string) => path.join(dir, 'state.json');
export const transcriptFile = (dir: string) => path.join(dir, 'transcript.md');
export const permissionsDir = (dir: string) => path.join(dir, 'permissions');

export function writeSpec(dir: string, spec: AgentSpec): void {
  ensureDir(dir);
  writeJsonAtomic(specFile(dir), spec);
}

export const readSpec = (dir: string) => readJson<AgentSpec>(specFile(dir));
export const readState = (dir: string) => readJson<AgentState>(stateFile(dir));

export function writeState(dir: string, state: AgentState): void {
  ensureDir(dir);
  writeJsonAtomic(stateFile(dir), state);
}

/** The host process is still the one that wrote the state. */
export function hostAlive(state: AgentState | undefined): boolean {
  return !!state && isAlive(state.pid) && (!state.procStart || isSameProcess(state.pid, state.procStart));
}

export interface AgentEntry {
  dir: string;
  spec: AgentSpec;
  state?: AgentState;
}

export function listAgents(): AgentEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(agentsDir());
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const dir = path.join(agentsDir(), name);
    const spec = readSpec(dir);
    return spec ? [{ dir, spec, state: readState(dir) }] : [];
  });
}

/** Agents `parentId` started whose host is still running. */
export const liveChildren = (parentId: string) =>
  listAgents().filter((entry) => entry.spec.parent.id === parentId && hostAlive(entry.state));

export interface PermissionRequest {
  id: string;
  label: string;
  at: string;
}

export interface PermissionAnswer {
  allow: boolean;
  at: string;
}

/** Request ids as the host makes them. Anything else is refused before it becomes part of a path. */
export const PERMISSION_ID = /^p-[0-9a-z]+-[0-9a-f]{4,16}$/;

export const permissionRequestFile = (dir: string, id: string) => path.join(permissionsDir(dir), `${id}.json`);
export const permissionAnswerFile = (dir: string, id: string) => path.join(permissionsDir(dir), `${id}.answer.json`);
