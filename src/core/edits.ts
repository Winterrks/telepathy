import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from './agents.ts';
import { formatAgo } from './listing.ts';
import { peerDir, peersDir, readJson, stateDir, writeJsonAtomic } from './paths.ts';
import { isSameProcess } from './proc.ts';
import { peerRef, readPeer } from './peers.ts';

/**
 * Which files each session edits, so a session that reads or edits files another live session is changing learns
 * about it and can ask that session instead of working in the same place unaware. One file per edited path in
 * `peers/<id>/edits/`, written atomically, since parallel tool calls run their hooks at the same time; they go away
 * with the session's registration. Only edits made with the agent's edit tools are seen, not shell commands.
 */

/** How long after an edit the session still counts as working there. */
export const EDIT_WINDOW_MS = 60 * 60_000;

interface EditRecord {
  file: string;
  at: string;
}

export interface TouchedFiles {
  edited: string[];
  read: string[];
}

/** Tool names that change files, across agents: Edit, MultiEdit, Write, NotebookEdit, apply_patch, write_file, replace, create… */
const EDIT_TOOL_RE = /edit|write|patch|create|replace|insert|notebook/i;
/** Tools that read files or look into folders: Read, read_file, view, Grep, Glob, list_directory, search_file_content… */
const READ_TOOL_RE = /read|view|grep|glob|search|list/i;
/** Shell tools: Bash, shell, exec_command, run_shell_command… Their commands are scanned for paths that exist. */
const SHELL_TOOL_RE = /bash|shell|exec_command|run_command|terminal/i;
const PATH_FIELDS = ['file_path', 'filePath', 'notebook_path', 'absolute_path', 'target_file', 'path', 'file', 'dir_path'];
/** A shell command's words, split at whitespace and operators, quotes removed; flags and variables dropped. */
const SHELL_WORD_RE = /"([^"]*)"|'([^']*)'|([^\s;&|<>()`"']+)/g;

/**
 * Files and folders a shell command names (`cat src/x.ts`, `sed -n 1,80p a.ts`, `ls daemon`, `rg foo daemon/`). A
 * command can mean anything, so only words that are existing paths count, and at most the first few.
 */
function shellPaths(command: string, cwd: string | undefined): string[] {
  const found: string[] = [];
  for (const m of command.slice(0, 2000).matchAll(SHELL_WORD_RE)) {
    const word = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!word || word.startsWith('-') || word.includes('$') || word.includes('*') || word === '.' || word === '..') continue;
    if (!path.isAbsolute(word) && !cwd) continue;
    const resolved = path.resolve(cwd ?? '/', word);
    if (resolved === cwd || !fs.existsSync(resolved)) continue;
    found.push(resolved);
    if (found.length >= 8) break;
  }
  return found;
}
const PATCH_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** Files named in an apply_patch-style patch (`*** Update File: src/x.ts`), from any string field that holds one. */
function patchedFiles(input: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const value of Object.values(input)) {
    if (typeof value !== 'string' || !value.includes('*** ')) continue;
    for (const m of value.matchAll(PATCH_HEADER_RE)) files.push((m[1] ?? m[2]).trim());
  }
  return files;
}

/** Tool arguments arrive as an object, or as a JSON string (Copilot's `toolArgs`). */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Paths under these belong to no one's work: dependencies, git internals, telepathy's own state. */
function ignored(file: string): boolean {
  const parts = file.split(path.sep);
  return parts.includes('node_modules') || parts.includes('.git') || file.startsWith(stateDir() + path.sep);
}

/**
 * The files a tool call read or edited, from its name and arguments. Every agent names these differently, so this
 * goes by the tool name's shape and the usual path fields; anything it doesn't recognize touches no files.
 */
export function touchedFiles(toolName: unknown, toolInput: unknown, cwd: string | undefined): TouchedFiles {
  const none = { edited: [], read: [] };
  const input = asObject(toolInput);
  if (typeof toolName !== 'string' || !input) return none;
  const kind = EDIT_TOOL_RE.test(toolName) ? 'edited' : READ_TOOL_RE.test(toolName) || SHELL_TOOL_RE.test(toolName) ? 'read' : undefined;
  if (!kind) return none;
  const named = PATH_FIELDS.map((f) => input[f]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  const command = [input.command, input.cmd].find((v): v is string => typeof v === 'string');
  const raw = named.length
    ? [named[0]]
    : kind === 'edited'
      ? patchedFiles(input)
      : SHELL_TOOL_RE.test(toolName) && command
        ? shellPaths(command, cwd)
        : [];
  const files = [
    ...new Set(
      raw
        .map((f) => f.trim())
        .filter((f) => path.isAbsolute(f) || cwd)
        .map((f) => path.resolve(cwd ?? '/', f)),
    ),
  ].filter((f) => !ignored(f));
  return { ...none, [kind]: files };
}

const keyOf = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 16);
const editsDir = (id: string) => path.join(peerDir(id), 'edits');

export function recordEdits(selfId: string, files: string[], now = Date.now()): void {
  for (const file of files) {
    writeJsonAtomic(path.join(editsDir(selfId), `${keyOf(file)}.json`), { file, at: new Date(now).toISOString() } satisfies EditRecord);
  }
}

/** Every other session's recent edits, without checking yet whether that session is still running. */
function othersRecentEdits(selfId: string, now: number): { id: string; edit: EditRecord; at: number }[] {
  const found: { id: string; edit: EditRecord; at: number }[] = [];
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(peersDir());
  } catch {
    return found;
  }
  for (const id of ids) {
    if (id === selfId) continue;
    let files: string[] = [];
    try {
      files = fs.readdirSync(editsDir(id));
    } catch {
      continue;
    }
    for (const name of files) {
      const edit = readJson<EditRecord>(path.join(editsDir(id), name));
      const at = edit ? Date.parse(edit.at) : Number.NaN;
      if (edit && typeof edit.file === 'string' && now - at < EDIT_WINDOW_MS) found.push({ id, edit, at });
    }
  }
  return found;
}

/** How the note tells the agent to reach the other session: the tool it actually has. */
const SEND_HINT: Partial<Record<Agent, string>> = {
  claude: 'SendMessage or send_message',
  opencode: 'telepathy_send_message',
  kilo: 'telepathy_send_message',
};

const isDirectory = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * A note for files (or folders) this session just read, listed or edited where another live session edited within
 * the last hour: the same file, or failing that another file in the same folder. Each other session is mentioned once per folder, so the
 * note shows up when an agent first steps into another's area, not on every file it touches there.
 */
export function overlapNote(self: { id: string; agent: Agent }, files: string[], cwd: string | undefined, now = Date.now()): string | undefined {
  if (!files.length) return undefined;
  const recent = othersRecentEdits(self.id, now);
  if (!recent.length) return undefined;
  const shownDir = path.join(peerDir(self.id), 'overlaps');
  const alive = new Map<string, ReturnType<typeof readPeer>>();
  const lines: string[] = [];
  for (const file of files) {
    const dir = isDirectory(file) ? file : path.dirname(file);
    const byPeer = new Map<string, (typeof recent)[number]>();
    for (const r of recent) {
      const same = r.edit.file === file;
      if (!same && path.dirname(r.edit.file) !== dir) continue;
      const best = byPeer.get(r.id);
      // The same file beats another file in the folder; then the latest edit.
      if (!best || (same && best.edit.file !== file) || (same === (best.edit.file === file) && r.at > best.at)) byPeer.set(r.id, r);
    }
    for (const [id, r] of byPeer) {
      const marker = path.join(shownDir, `${keyOf(`${id}\n${dir}`)}.json`);
      if (fs.existsSync(marker)) continue;
      if (!alive.has(id)) {
        const peer = readPeer(id);
        alive.set(id, peer && isSameProcess(peer.pid, peer.procStart) ? peer : undefined);
      }
      const peer = alive.get(id);
      if (!peer) continue;
      const shown = cwd && r.edit.file.startsWith(cwd + path.sep) ? path.relative(cwd, r.edit.file) : r.edit.file;
      lines.push(
        `[telepathy note] Another session, ${peerRef(peer)}, edited ${shown} ${formatAgo(now - r.at)}, so it may be working in this area. ` +
          `If you need changes there, consider reaching out to it with ${SEND_HINT[self.agent] ?? 'send_message'}.`,
      );
      writeJsonAtomic(marker, { peer: id, dir, at: new Date(now).toISOString() });
    }
  }
  return lines.length ? lines.join('\n') : undefined;
}

/** After a tool call: remember the files it edited, and return a note if it touched another session's area. */
export function trackTouchedFiles(
  self: { id: string; agent: Agent },
  toolName: unknown,
  toolInput: unknown,
  cwd: string | undefined,
): string | undefined {
  const { edited, read } = touchedFiles(toolName, toolInput, cwd);
  if (edited.length) recordEdits(self.id, edited);
  return overlapNote(self, [...edited, ...read], cwd);
}
