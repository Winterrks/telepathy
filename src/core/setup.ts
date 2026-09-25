import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentLabel } from './agents.ts';
import { findInstalls, isNewer } from './installs.ts';
import { defaultCodexHome, listPeers, type Peer } from './peers.ts';
import { VERSION } from './version.ts';

/** telepathy's Codex hooks, by the event key Codex uses when it records one as approved. */
const CODEX_HOOKS: Record<string, string> = {
  session_start: 'SessionStart',
  post_tool_use: 'PostToolUse',
  user_prompt_submit: 'UserPromptSubmit',
};

/**
 * telepathy's Codex hooks that aren't approved yet. Codex records each hook the user trusts as a
 * `[hooks.state."telepathy@<marketplace>:hooks/codex-hooks.json:<event>:0:0"]` table in its config.toml; only
 * those table names are read. A hook whose command changed may need approving again, which this can't see.
 * Undefined when the config can't be read.
 */
export function unapprovedCodexHooks(codexHome: string): string[] | undefined {
  let config: string;
  try {
    config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return undefined;
  }
  const approved = new Set(
    [...config.matchAll(/^\[hooks\.state\."telepathy@[^":]*:hooks\/codex-hooks\.json:([a-z_]+):/gm)].map((m) => m[1]),
  );
  return Object.keys(CODEX_HOOKS)
    .filter((key) => !approved.has(key))
    .map((key) => CODEX_HOOKS[key]);
}

/** `node "<dist>/update-all.mjs"`, next to the bundle this runs from. */
const updateAllCommand = () => `node "${path.join(path.dirname(fileURLToPath(import.meta.url)), 'update-all.mjs')}"`;

const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

/**
 * Things only the user can fix that keep messages from reaching this session on time, as `[telepathy setup]`
 * lines for the agent to pass on.
 */
export function setupNotes(self: Peer): string[] {
  const notes: string[] = [];
  if (self.agent === 'codex') {
    const missing = unapprovedCodexHooks(self.codexHome ?? defaultCodexHome());
    if (missing?.length) {
      const effects = [
        missing.includes('SessionStart') && "other sessions can't reach this one until it calls a telepathy tool",
        missing.includes('PostToolUse') && 'messages sent while you work reach you only when your turn ends',
        missing.includes('UserPromptSubmit') && 'after an interrupted turn, messages wait for a later turn',
      ].filter(Boolean);
      notes.push(
        `[telepathy setup] Codex hasn't approved telepathy's ${listed(missing)} hook${missing.length > 1 ? 's' : ''}, ` +
          `so ${effects.join('; ')}. Tell your user: open /hooks in this session and trust them (press t).`,
      );
    }
  }
  const installs = findInstalls();
  const newestOf = (versions: (string | undefined)[]) =>
    versions.filter((v): v is string => !!v).reduce<string | undefined>((best, v) => (!best || isNewer(v, best) ? v : best), undefined);
  const newest = newestOf([VERSION, ...listPeers().map((p) => p.version), ...installs.map((i) => i.version)]);
  const ownInstalled = newestOf(installs.filter((i) => i.agent === self.agent).map((i) => i.version));
  if (ownInstalled && isNewer(ownInstalled, VERSION)) {
    notes.push(
      `[telepathy setup] This session runs telepathy ${VERSION}, but ${ownInstalled} is installed, so messages may ` +
        'not reach this session as they should. Tell your user to restart this session to load the update.',
    );
  } else if (!ownInstalled && newest && isNewer(newest, VERSION)) {
    // Grok and Cursor load the copy installed in Claude Code.
    const where = self.agent === 'grok' || self.agent === 'cursor' ? "Claude Code's copy of telepathy" : 'telepathy in this agent';
    notes.push(
      `[telepathy setup] This session runs telepathy ${VERSION}, but another session runs ${newest}, so messages may ` +
        `not reach this session as they should. Tell your user to update ${where} and restart this session.`,
    );
  }
  const stale = installs.filter((i) => newest && isNewer(newest, i.version));
  if (newest && stale.length) {
    notes.push(
      `[telepathy setup] Some agents have an older telepathy installed than ${newest}: ` +
        `${stale.map((i) => `${agentLabel(i.agent)} ${i.version}`).join(', ')}. Tell your user; with their OK, you can ` +
        `update them all with: ${updateAllCommand()}`,
    );
  }
  return notes;
}
