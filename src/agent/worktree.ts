import { execFileSync } from 'node:child_process';
import type { AgentSpec } from './spec.ts';

/** Removes the agent's worktree and its branch when nothing changed. Returns false when it was kept. */
export function removeCleanWorktree(spec: AgentSpec): boolean {
  const tree = spec.worktree;
  if (!tree) return true;
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const dirty = git('-C', tree.path, 'status', '--porcelain');
    const head = git('-C', tree.path, 'rev-parse', 'HEAD');
    if (dirty || head !== tree.base) return false;
    git('-C', tree.repo, 'worktree', 'remove', '--force', tree.path);
    git('-C', tree.repo, 'branch', '-D', tree.branch);
    return true;
  } catch {
    return false;
  }
}
