import path from 'node:path';
import { readJson, writeJsonAtomic } from '../core/paths.ts';

/**
 * Which of an agent's permission requests the parent is asked about. What `allow` names goes ahead. `auto`, the
 * default, is the harness's own auto mode where it has one over ACP (set at start, src/agent/configure.ts), and
 * telepathy's where it has none: a reviewer session of the same harness approves routine requests
 * (src/agent/reviewer.ts), and the rest still come to the parent. `ask` turns that reviewer off, so each request
 * comes to the parent; a harness's own auto mode stays on. Nothing approves everything: there is no bypass mode.
 */
export interface PermissionPolicy {
  mode: 'ask' | 'auto';
  /** Command prefixes (`git status`, `npm test`) and request kinds (`Edit`, `Read`, `Search`, `Fetch`) allowed without asking. */
  allow: string[];
  /** The reviewer's model in auto mode. Unset: the cheapest the harness offers, at medium effort. */
  model?: string;
  at?: string;
}

export const policyFile = (dir: string) => path.join(dir, 'policy.json');

export function readPolicy(dir: string): PermissionPolicy {
  const stored = readJson<Partial<PermissionPolicy>>(policyFile(dir));
  return {
    mode: stored?.mode === 'ask' ? 'ask' : 'auto',
    allow: Array.isArray(stored?.allow) ? stored.allow.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()) : [],
    ...(typeof stored?.model === 'string' && stored.model ? { model: stored.model } : {}),
    ...(stored?.at ? { at: stored.at } : {}),
  };
}

/** Changes the fields given; the others stay. Returns the policy now in force. */
export function updatePolicy(dir: string, change: { mode?: 'ask' | 'auto'; allow?: string[]; add?: string[]; model?: string }): PermissionPolicy {
  const policy = readPolicy(dir);
  if (change.mode) policy.mode = change.mode;
  if (change.allow) policy.allow = normalizeEntries(change.allow);
  if (change.add) policy.allow = normalizeEntries([...policy.allow, ...change.add]);
  if (change.model !== undefined) {
    if (change.model.trim()) policy.model = change.model.trim();
    else delete policy.model;
  }
  policy.at = new Date().toISOString();
  writeJsonAtomic(policyFile(dir), policy);
  return policy;
}

const KINDS: Record<string, string[]> = {
  edit: ['edit', 'delete', 'move'],
  read: ['read'],
  search: ['search'],
  fetch: ['fetch'],
};

/** `Bash(git status:*)` and `Shell(git)`, as Claude Code and Cursor write them, become `git status` and `git`. */
function normalizeEntry(entry: string): string {
  let value = entry.trim();
  const wrapped = /^(?:bash|shell)\((.*)\)$/i.exec(value);
  if (wrapped) value = wrapped[1].trim();
  return value.replace(/(?::\*|\s+\*|\*)$/, '').trim();
}

function normalizeEntries(entries: string[]): string[] {
  return [...new Set(entries.map(normalizeEntry).filter(Boolean))];
}

/** What a permission request is about, from ACP's `session/request_permission`. */
export interface RequestInfo {
  kind?: string;
  title: string;
  /** The shell command, for a request to run one. */
  command?: string;
  /** Why the agent says it needs it, when it says. */
  reason?: string;
  /** The files it names (ACP `locations`, or a path in its input). */
  paths?: string[];
}

export function requestInfo(params: unknown, label: string): RequestInfo {
  const tool = (((params ?? {}) as { toolCall?: unknown }).toolCall ?? {}) as {
    kind?: unknown;
    title?: unknown;
    rawInput?: unknown;
    input?: unknown;
    content?: unknown;
    locations?: unknown;
  };
  const kind = typeof tool.kind === 'string' ? tool.kind : undefined;
  const title = typeof tool.title === 'string' && tool.title ? tool.title : label;
  const raw = (tool.rawInput ?? tool.input ?? {}) as Record<string, unknown>;
  let command: string | undefined;
  for (const value of [raw.command, raw.cmd]) {
    if (typeof value === 'string' && value.trim()) command = value.trim();
    else if (Array.isArray(value) && value.every((part) => typeof part === 'string')) command = (value as string[]).join(' ');
    if (command) break;
  }
  // Cursor puts the command in the title, in backticks, and nothing in rawInput.
  if (!command && kind === 'execute') {
    const quoted = /^`([\s\S]+)`$/.exec(title.trim());
    command = (quoted ? quoted[1].replace(/\\`/g, '`') : title).trim() || undefined;
  }
  const texts = Array.isArray(tool.content)
    ? tool.content.flatMap((item) => {
        const inner = (item ?? {}) as { content?: { text?: unknown }; text?: unknown };
        const text = inner.content?.text ?? inner.text;
        return typeof text === 'string' && text.trim() ? [text.trim()] : [];
      })
    : [];
  const paths = [
    ...(Array.isArray(tool.locations) ? tool.locations.map((l) => ((l ?? {}) as { path?: unknown }).path) : []),
    raw.path,
    raw.file_path,
    raw.filePath,
    raw.target,
    raw.destination,
  ].filter((p): p is string => typeof p === 'string' && !!p.trim());
  return {
    kind,
    title,
    command,
    reason: texts.join('\n').slice(0, 1000) || undefined,
    ...(paths.length ? { paths: [...new Set(paths)] } : {}),
  };
}

/**
 * The simple commands in a shell command line, split at `&&`, `||`, `;`, `|` and newlines outside quotes, as
 * word lists. Undefined when it substitutes a command (`$(…)`, backticks, `<(…)`) or writes to a file with `>`:
 * no prefix can say what that runs or writes.
 */
export function simpleCommands(line: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
      continue;
    }
    if (c === '\\' && next !== undefined) {
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (c === '`' || (c === '$' && next === '(')) return undefined;
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
      continue;
    }
    if ((c === '<' || c === '>') && next === '(') return undefined;
    if (c === '>' || c === '<') {
      // `2>&1`, `>/dev/null` and `2>/dev/null` write nothing; any other redirect does, or reads a file in.
      const fd = /^\d*$/.test(word) && inWord ? word : '';
      const rest = line.slice(i + 1);
      const target = c === '>' ? (/^&\d+(?![^\s;&|])/.exec(rest) ?? /^>?\s*\/dev\/null(?![^\s;&|])/.exec(rest)) : null;
      if (!target) return undefined;
      if (fd) {
        word = '';
        inWord = false;
      } else endWord();
      i += target[0].length;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && next !== '&') return undefined; // a background job
      if ((c === '&' || c === '|') && next === c) i++;
      endCommand();
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  if (quote) return undefined;
  endCommand();
  return commands;
}

const wordsOf = (entry: string) => simpleCommands(entry)?.[0] ?? [];

/** `git -C <dir> status` is `git status` run in another folder, as `cd <dir> && git status` is. */
function plain(words: string[]): string[] {
  if (words[0] !== 'git') return words;
  const out = ['git'];
  let i = 1;
  for (; i < words.length; i++) {
    if (words[i] === '-C' && i + 1 < words.length) i++;
    else if (words[i] !== '--no-pager') break;
  }
  return [...out, ...words.slice(i)];
}

/** `cd` alone changes nothing, so it never needs allowing. */
const harmless = (words: string[]) => words[0] === 'cd' && words.length <= 2;

const inside = (file: string, root: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(root, file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The allow entry that covers this request, if one does: every part of a command has to be covered. `Edit` covers
 * only files inside the agent's folder (`roots`): outside it, an agent could rewrite its own policy.json.
 */
export function allowedBy(policy: PermissionPolicy, request: RequestInfo, roots: string[] = []): string | undefined {
  const entries = normalizeEntries(policy.allow);
  for (const entry of entries) {
    const kinds = KINDS[entry.toLowerCase()];
    if (!kinds || !request.kind || !kinds.includes(request.kind)) continue;
    if (entry.toLowerCase() === 'edit' && request.paths?.some((file) => !roots.some((root) => inside(file, root)))) continue;
    return entry;
  }
  if (!request.command) return undefined;
  const parts = simpleCommands(request.command);
  if (!parts?.length) return undefined;
  const prefixes = entries.filter((entry) => !KINDS[entry.toLowerCase()]).map((entry) => ({ entry, words: wordsOf(entry) }));
  const used = new Set<string>();
  for (const part of parts) {
    if (harmless(part)) continue;
    const words = plain(part);
    const hit = prefixes.find((p) => p.words.length > 0 && p.words.length <= words.length && p.words.every((w, i) => w === words[i]));
    if (!hit) return undefined;
    used.add(hit.entry);
  }
  return used.size ? [...used].join(', ') : undefined;
}

/** Tools whose first word is a family of subcommands: the prefix to remember is that word and the subcommand. */
const FAMILIES = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl', 'swift', 'uv', 'pip', 'pip3', 'brew',
  'make', 'gradle', './gradlew', 'mvn', 'dotnet', 'terraform', 'xcrun', 'pod', 'deno', 'poetry',
]);
/** Tools whose subcommands have subcommands of their own: the prefix to remember is three words. */
const DEEP = new Set(['gh', 'gcloud', 'aws', 'az', 'glab']);
/** Commands that run whatever they are given: remembering the word alone would allow anything. */
const RUNNERS = new Set([
  'node', 'python', 'python3', 'ruby', 'perl', 'php', 'bash', 'sh', 'zsh', 'fish', 'eval', 'exec', 'sudo', 'su', 'env',
  'xargs', 'npx', 'bunx', 'pnpx', 'osascript', 'ssh', 'nohup', 'time', 'timeout', 'watch', 'nice', 'command', 'builtin',
]);

/** Subcommands that run code they are given, or a package they fetch. */
const EXECS = new Set(['exec', 'x', 'dlx', 'eval', 'shell', 'repl', 'console']);

/**
 * The prefixes `always` would remember for this request: `git status` for `git status -s`, `ls` for `ls -la`.
 * Empty when the command can't be split safely or runs other code (`node script.js`, `bash -c …`).
 */
export function suggestPrefixes(request: RequestInfo): string[] {
  if (!request.command) return [];
  const parts = simpleCommands(request.command);
  if (!parts?.length) return [];
  const out: string[] = [];
  for (const part of parts) {
    if (harmless(part)) continue;
    const words = plain(part);
    const [first, second, third] = words;
    if (!first || RUNNERS.has(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return [];
    const sub = (word: string | undefined) => !!word && /^[a-z][\w:.-]*$/i.test(word);
    let prefix = first;
    if (FAMILIES.has(first) || DEEP.has(first)) {
      // `git -C dir …` and the like: the subcommand is further in, past options this can't read.
      if (!sub(second)) return [];
      prefix = `${first} ${second}`;
      // `npm exec`, `uv run python`, `docker run`: they run what they are given.
      if (EXECS.has(second!)) return [];
      // `npm run build`, not `npm run`, which would also allow every other script.
      // `gh pr view`, not `gh pr`, which would also allow `gh pr merge`.
      if (DEEP.has(first) || second === 'run') {
        if (!sub(third) || RUNNERS.has(third!)) return [];
        prefix += ` ${third}`;
      }
    }
    if (!out.includes(prefix)) out.push(prefix);
  }
  return out;
}
