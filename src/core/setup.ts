import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentLabel } from './agents.ts';
import { findInstalls, isNewer } from './installs.ts';
import { peerDir, readJson, writeJsonAtomic } from './paths.ts';
import { defaultCodexHome, listPeers, type Peer, sameStableName } from './peers.ts';
import { commandLine } from './proc.ts';
import { VERSION } from './version.ts';

/**
 * Codex names this plugin's MCP server `bridge` (`plugin/codex.mcp.json`). `send_message` waits up to 115s, and
 * Codex's default `tool_timeout_sec` is 60, so a value below 115 cuts the wait off.
 */
export const CODEX_BRIDGE_TIMEOUT_KEY = 'plugins."telepathy@telepathy".mcp_servers.bridge.tool_timeout_sec';
const CODEX_BRIDGE_TIMEOUT_MIN = 115;

/** The configured `tool_timeout_sec` for telepathy's Codex MCP server, or undefined when the key is absent. Later entries win. */
export function codexBridgeTimeoutSec(config: string): number | undefined {
  let found: number | undefined;
  let inTable = false;
  for (const line of config.split('\n')) {
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      inTable = header[1] === 'plugins."telepathy@telepathy".mcp_servers.bridge';
      continue;
    }
    const dotted = /plugins\."telepathy@telepathy"\.mcp_servers\.bridge\.tool_timeout_sec\s*=\s*([0-9]+)/.exec(line);
    if (dotted?.[1]) {
      found = Number(dotted[1]);
      continue;
    }
    if (!inTable) continue;
    const local = /^\s*tool_timeout_sec\s*=\s*([0-9]+)/.exec(line);
    if (local?.[1]) found = Number(local[1]);
  }
  return found;
}

/**
 * A `-c` / `--config` override for the bridge timeout, if the Codex process command line carries one.
 * Later matches win. Codex applies these over `config.toml`, so a file that lacks the key is not "unset".
 */
export function codexBridgeTimeoutFromCommandLine(args: string): number | undefined {
  const re = /mcp_servers\.bridge\.tool_timeout_sec\s*=\s*["']?([0-9]+)/g;
  let found: number | undefined;
  for (const match of args.matchAll(re)) {
    if (match[1]) found = Number(match[1]);
  }
  return found;
}

/** `node "<dist>/update-all.mjs"`, next to the bundle this runs from. */
const updateAllCommand = () => `node "${path.join(path.dirname(fileURLToPath(import.meta.url)), 'update-all.mjs')}"`;

/**
 * Things only the user can fix that keep messages from reaching this session on time, as `[telepathy setup]`
 * lines for the agent to pass on.
 */
export function setupNotes(self: Peer): string[] {
  const notes: string[] = [];
  const dupes = listPeers().filter((p) => sameStableName(self, p));
  if (self.stableName && dupes.length) {
    notes.push(
      `[telepathy setup] ${dupes.length + 1} live sessions share the name ${self.agent}:${self.stableName} ` +
        `(${[self.id, ...dupes.map((p) => p.id)].join(', ')}). A message to that name can reach either one; use the [ref] to pick.`,
    );
  }
  if (self.agent === 'codex') {
    // A missing config.toml table is not evidence the hooks are untrusted: they can be approved and still
    // absent from the file this process reads. Warn only when no telepathy hook has ever fired here.
    if (!self.hookRan && !self.toolHookRan) {
      notes.push(
        `[telepathy setup] No telepathy hook has fired for this session, so other sessions may not reach it until one does. ` +
          'If /hooks shows telepathy\'s hooks untrusted, trust them (press t).',
      );
    }
    const codexHome = self.codexHome ?? defaultCodexHome();
    let timeout: number | undefined;
    let config = '';
    try {
      config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
      timeout = codexBridgeTimeoutSec(config);
    } catch {
      config = '';
    }
    const fromArgs = self.pid ? codexBridgeTimeoutFromCommandLine(commandLine(self.pid) ?? '') : undefined;
    const effective = fromArgs ?? timeout;
    if (effective !== undefined && effective < CODEX_BRIDGE_TIMEOUT_MIN) {
      notes.push(
        `[telepathy setup] ${CODEX_BRIDGE_TIMEOUT_KEY} is ${effective}s, which is below the 115s send_message waits ` +
          'for a transcript. Set that key to at least 115.',
      );
    } else if (config && effective === undefined) {
      notes.push(
        `[telepathy setup] Could not verify ${CODEX_BRIDGE_TIMEOUT_KEY}. It is not in config.toml, and no -c override ` +
          'was visible on this Codex process. If it is below 115, send_message can be cut off. Set that key to at least 115 if it is not already.',
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

const shownFile = (id: string) => path.join(peerDir(id), 'setup-shown.json');

/**
 * Setup notes this session has not already been shown. Each distinct note is recorded, so a new MCP process
 * does not repeat it on the next `list_peers` or `send_message`.
 */
export function unseenSetupNotes(self: Peer): string[] {
  const notes = setupNotes(self);
  const shown = new Set(readJson<string[]>(shownFile(self.id)) ?? []);
  const fresh = notes.filter((note) => !shown.has(note));
  if (fresh.length) writeJsonAtomic(shownFile(self.id), [...shown, ...fresh]);
  return fresh;
}
