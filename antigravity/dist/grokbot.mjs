import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);

// src/grokbot/cli.ts
import { spawn as spawn3 } from "node:child_process";
import fs18 from "node:fs";
import os9 from "node:os";
import path19 from "node:path";

// src/core/agents.ts
var AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "kilo",
  "qwen",
  "copilot",
  "cursor",
  "kimi",
  "grok",
  "devin",
  "antigravity",
  "hermes",
  "openclaw",
  "pi"
];
var SPECS = {
  // Its plugin monitor wakes interactive CLI sessions; the hooks cover sessions without one (the Claude app's Code
  // tab and `claude -p` run in stream-json mode, where plugin monitors don't start).
  claude: { id: "claude", label: "Claude Code", names: ["claude"], nextTurnHook: true },
  codex: { id: "codex", label: "Codex", names: ["codex"] },
  opencode: { id: "opencode", label: "OpenCode", names: ["opencode", ".opencode"], script: /(^|[\s/])opencode(\.js)?(\s|$)/ },
  kilo: { id: "kilo", label: "Kilo Code", names: ["kilo", "kilocode"], script: /(^|[\s/])kilo(code)?(\.js)?(\s|$)/ },
  qwen: {
    id: "qwen",
    label: "Qwen Code",
    names: ["qwen"],
    script: /(^|[\s/])qwen(\s|$)|qwen-code\/(cli|dist\/index)\.js/,
    nextTurnHook: true
  },
  copilot: {
    id: "copilot",
    label: "Copilot CLI",
    names: ["copilot"],
    script: /(^|[\s/])copilot(\.js)?(\s|$)/,
    env: ["COPILOT_AGENT_SESSION_ID", "COPILOT_CLI"],
    nextTurnHook: true
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    names: ["cursor-agent"],
    script: /(^|[\s/])cursor-agent(\s|$)|\/cursor-agent\/versions\//,
    exe: /cursor-agent\/.*\/(agent|cursor-agent)$/,
    env: ["CURSOR_PLUGIN_ROOT"],
    nextTurnHook: true
  },
  kimi: { id: "kimi", label: "Kimi Code", names: ["kimi-code", "kimi"], env: ["KIMI_PLUGIN_ROOT"], nextTurnHook: true },
  grok: {
    id: "grok",
    label: "Grok CLI",
    names: ["grok"],
    exe: /\/\.grok\/(bin|downloads)\/[^/]+$/,
    env: ["GROK_SESSION_ID"],
    nextTurnHook: true
  },
  devin: { id: "devin", label: "Devin CLI", names: ["devin"], env: ["DEVIN_PLUGIN_ROOT", "DEVIN_PROJECT_DIR"], nextTurnHook: true },
  // One plugin for the App, CLI, and IDE. The CLI TUI is turn-boundary only. The App sidecar wakes idle chats.
  antigravity: { id: "antigravity", label: "Antigravity", names: ["agy", "antigravity"], nextTurnHook: true },
  hermes: { id: "hermes", label: "Hermes Agent", names: ["hermes"], script: /(^|[\s/])hermes(\s|$)/ },
  openclaw: { id: "openclaw", label: "OpenClaw", names: ["openclaw"], script: /(^|[\s/])openclaw(\.mjs|\.js)?(\s|$)/ },
  pi: { id: "pi", label: "Pi", names: ["pi"], script: /(^|[\s/])pi(\s|$)|pi-coding-agent\/dist\/cli\.js/ }
};
var agentSpec = (agent) => SPECS[agent];
var agentLabel = (agent) => SPECS[agent].label;
var AGENT_ALTERNATION = [...AGENT_IDS].sort((a, b) => b.length - a.length).join("|");

// src/core/claude-socket.ts
import fs12 from "node:fs";
import path12 from "node:path";

// src/core/debug.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/core/paths.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var UNEXPANDED = /^\$\{[^}]+\}$/;
function scrubPlaceholderEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && UNEXPANDED.test(value.trim())) delete env[key];
  }
}
scrubPlaceholderEnv();
function configuredEnv(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value || UNEXPANDED.test(value)) return void 0;
  return value;
}
function envDurationMs(name, fallback, env = process.env) {
  const raw = env[name];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
function stateDir() {
  return configuredEnv("TELEPATHY_HOME") || path.join(os.homedir(), ".telepathy");
}
var peersDir = () => path.join(stateDir(), "peers");
var peerDir = (id) => path.join(peersDir(), id);
var inboxDir = (id) => path.join(peerDir(id), "inbox");
var archiveDir = (id) => path.join(peerDir(id), "archive");
var withdrawnDir = (id) => path.join(peerDir(id), "withdrawn");
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 448 });
  return dir;
}
function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 384 });
  fs.renameSync(tmp, file);
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return void 0;
  }
}

// src/core/debug.ts
function debugLog(component, line) {
  if (process.env.TELEPATHY_DEBUG !== "1") return;
  try {
    ensureDir(stateDir());
    fs2.appendFileSync(path2.join(stateDir(), "debug.log"), `${(/* @__PURE__ */ new Date()).toISOString()} [${component} ${process.pid}] ${line}
`);
  } catch {
  }
}

// src/core/confirm.ts
import fs11 from "node:fs";
import os6 from "node:os";
import path11 from "node:path";

// src/core/codex-activity.ts
import fs3 from "node:fs";
import path3 from "node:path";
var TAIL_STEPS = [1024 * 1024, 16 * 1024 * 1024];
var TURN_EVENTS = { task_started: "busy", task_complete: "idle", turn_aborted: "interrupted" };
function findRollout(codexHome, threadId) {
  const isRollout = (f) => f.startsWith("rollout-") && (f.endsWith(`-${threadId}.jsonl`) || f.includes(`-${threadId}_`) && f.endsWith(".jsonl"));
  const sorted = (dir) => {
    try {
      return fs3.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  const root = path3.join(codexHome, "sessions");
  for (const year of sorted(root)) {
    for (const month of sorted(path3.join(root, year))) {
      for (const day of sorted(path3.join(root, year, month))) {
        const dir = path3.join(root, year, month, day);
        const file = sorted(dir).find(isRollout);
        if (file) return path3.join(dir, file);
      }
    }
  }
  return void 0;
}
function readTail(file, bytes) {
  const fd = fs3.openSync(file, "r");
  try {
    const { size } = fs3.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs3.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return { text: start > 0 ? text.slice(text.indexOf("\n") + 1) : text, whole: start === 0 };
  } finally {
    fs3.closeSync(fd);
  }
}
function lastTurnEvent(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"event_msg"')) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const state = entry.type === "event_msg" ? TURN_EVENTS[entry.payload?.type ?? ""] : void 0;
    if (state) return state;
  }
  return void 0;
}
function codexActivity(codexHome, threadId) {
  try {
    const file = findRollout(codexHome, threadId);
    if (!file) return void 0;
    for (const bytes of TAIL_STEPS) {
      const { text, whole } = readTail(file, bytes);
      const state = lastTurnEvent(text);
      if (state || whole) return state;
    }
  } catch {
  }
  return void 0;
}
function codexLastResponse(codexHome, threadId) {
  try {
    const file = findRollout(codexHome, threadId);
    if (!file) return void 0;
    const lines = readTail(file, 256 * 1024).text.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"response_item"')) continue;
      try {
        const entry = JSON.parse(lines[i]);
        const at = Date.parse(entry.timestamp ?? "");
        if (entry.type === "response_item" && !Number.isNaN(at)) return at;
      } catch {
      }
    }
  } catch {
  }
  return void 0;
}

// src/core/codex-queue.ts
import { execFile, spawn } from "node:child_process";
import os5 from "node:os";
import path9 from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

// src/core/installs.ts
import fs4 from "node:fs";
import os2 from "node:os";
import path4 from "node:path";
function resolveReal(dir) {
  const abs = path4.resolve(dir);
  const missing = [];
  let current = abs;
  while (current !== path4.dirname(current)) {
    try {
      return path4.join(fs4.realpathSync(current), ...missing);
    } catch {
      missing.unshift(path4.basename(current));
      current = path4.dirname(current);
    }
  }
  return abs;
}
function genericDir(dir) {
  const normalized = resolveReal(dir);
  if (normalized === path4.parse(normalized).root) return true;
  const generic = ["/tmp", "/var", "/private", "/private/tmp", "/var/tmp", "/private/var"];
  if (generic.includes(normalized)) return true;
  try {
    const tmp = resolveReal(os2.tmpdir());
    if (normalized === tmp || normalized === path4.dirname(tmp)) return true;
  } catch {
  }
  return false;
}
function isolatedStateRoots() {
  const explicit = configuredEnv("TELEPATHY_HOME");
  if (!explicit) return void 0;
  const state = resolveReal(explicit);
  let passwd = path4.resolve(os2.userInfo().homedir);
  try {
    passwd = fs4.realpathSync(passwd);
  } catch {
  }
  if (state === resolveReal(path4.join(passwd, ".telepathy"))) return void 0;
  const parent = path4.dirname(state);
  const roots = [genericDir(parent) || parent === passwd ? state : parent];
  let apparent = path4.resolve(os2.homedir());
  try {
    apparent = fs4.realpathSync(apparent);
  } catch {
  }
  const covered = roots.some((root) => apparent === root || apparent.startsWith(root + path4.sep));
  if (apparent !== passwd && !covered) roots.push(apparent);
  return roots;
}
function inRoots(dir, roots) {
  const resolved = resolveReal(dir);
  return roots.some((root) => resolved === root || resolved.startsWith(root + path4.sep));
}
function outsideIsolatedHome(dir) {
  const roots = isolatedStateRoots();
  if (!roots) return false;
  return !inRoots(dir, roots);
}

// src/core/sandbox-launch.ts
import fs5 from "node:fs";
import os3 from "node:os";
import path5 from "node:path";
function inTestSandbox() {
  return process.env.TELEPATHY_SANDBOX === "1";
}
function realpathOr(file) {
  try {
    return fs5.realpathSync(file);
  } catch {
    return path5.resolve(file);
  }
}
function resolveOnPath(cmd, env = process.env) {
  if (cmd.includes("/") || cmd.includes("\\")) {
    const abs = path5.resolve(cmd);
    return fs5.existsSync(abs) ? abs : void 0;
  }
  for (const dir of (env.PATH ?? "").split(path5.delimiter)) {
    if (!dir) continue;
    const candidate = path5.join(dir, cmd);
    if (fs5.existsSync(candidate)) return candidate;
  }
  return void 0;
}
function sandboxAllowsExecutable(file) {
  if (!inTestSandbox()) return true;
  const resolved = realpathOr(file);
  const configured = process.env.TELEPATHY_CODEX_BIN;
  if (configured && realpathOr(configured) === resolved) return true;
  const tmp = realpathOr(os3.tmpdir());
  return resolved === tmp || resolved.startsWith(tmp + path5.sep);
}

// src/core/messages.ts
import crypto from "node:crypto";
import fs9 from "node:fs";
import path8 from "node:path";

// src/core/peers.ts
import { createHash } from "node:crypto";
import fs8 from "node:fs";
import os4 from "node:os";
import path7 from "node:path";

// src/core/version.ts
var VERSION = true ? "0.11.0" : "0.0.0-dev";

// src/core/codex-launch.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import fs6 from "node:fs";

// src/core/proc.ts
import { execFileSync } from "node:child_process";
var cache;
function psCommand() {
  return process.env.TELEPATHY_PS_BIN || "ps";
}
function processTable(maxAgeMs = 500) {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.table;
  const table = /* @__PURE__ */ new Map();
  let out = "";
  try {
    out = execFileSync(psCommand(), ["-Ao", "pid=,ppid=,lstart=,comm="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 16 * 1024 * 1024
    });
  } catch {
  }
  const re = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;
  for (const line of out.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    table.set(pid, { pid, ppid: Number(m[2]), start: m[3].replace(/\s+/g, " "), comm: m[4].trim() });
  }
  cache = { at: Date.now(), table };
  return table;
}
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function procStart(pid) {
  return processTable().get(pid)?.start;
}
function isSameProcess(pid, recordedStart) {
  if (!isAlive(pid)) return false;
  if (!recordedStart) return true;
  const current = processTable(0).get(pid)?.start;
  return current === void 0 || current === recordedStart;
}
var commandLine = (pid) => psField(pid, "args");
var argsCache;
function commandLines(maxAgeMs = 500) {
  if (argsCache && Date.now() - argsCache.at < maxAgeMs) return argsCache.table;
  const table = /* @__PURE__ */ new Map();
  let out = "";
  try {
    out = execFileSync(psCommand(), ["-ww", "-Ao", "pid=,args="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 16 * 1024 * 1024
    });
  } catch {
  }
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), match[2].trim());
  }
  argsCache = { at: Date.now(), table };
  return table;
}
function psField(pid, field) {
  try {
    return execFileSync(psCommand(), ["-ww", "-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
  } catch {
    return void 0;
  }
}

// src/core/codex-launch.ts
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "-c",
  "--config",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-i",
  "--image",
  "-a",
  "--ask-for-approval",
  "--sandbox",
  "-s",
  "-C",
  "--cd",
  "--add-dir",
  "--enable",
  "--disable",
  "--remote",
  "--output-schema"
]);
var SUBCOMMAND = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
var APP_BUNDLE = /\.app(?:\/|\s|$)/;
var INTERPRETERS = /* @__PURE__ */ new Set(["node", "nodejs", "bun", "deno", "python", "python3", "bash", "sh", "zsh", "env"]);
var THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function tokenize(command) {
  const tokens = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}
function binName(token) {
  const base = token.split(/[/\\]/).pop() ?? token;
  return base.replace(/\.(js|mjs|cjs|exe)$/i, "");
}
function codexArgv(command) {
  const tokens = tokenize(command);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++;
  const exe = tokens[i];
  if (!exe) return void 0;
  if (binName(exe) === "codex") return tokens.slice(i + 1);
  if (!INTERPRETERS.has(binName(exe))) return void 0;
  const script = tokens[i + 1];
  if (!script || script.startsWith("-") || binName(script) !== "codex") return void 0;
  return tokens.slice(i + 2);
}
function codexPositionals(command) {
  const argv = codexArgv(command);
  if (!argv) return void 0;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("-")) {
      const name = token.split("=")[0] ?? token;
      if (!token.includes("=") && VALUE_FLAGS.has(name)) i++;
      continue;
    }
    positional.push(token);
  }
  return positional;
}
function isCodexExecCommand(command) {
  const sub = codexPositionals(command)?.[0];
  return sub === "exec" || sub === "e";
}
function codexTuiLaunch(command) {
  const positional = codexPositionals(command);
  if (!positional) return void 0;
  const sub = positional[0];
  if (!sub) return {};
  if (sub === "resume") {
    const threadId = positional.slice(1).find((token) => THREAD_ID.test(token));
    return threadId ? { threadId } : {};
  }
  if (sub === "fork") return {};
  if (SUBCOMMAND.test(sub)) return void 0;
  return {};
}
function parentIsAppBundle(parent) {
  return !!parent && APP_BUNDLE.test(parent);
}
function parentCommandOf(pid, table, lines) {
  const ppid = table.get(pid)?.ppid;
  if (!ppid) return void 0;
  const args = lines.get(ppid);
  const comm = table.get(ppid)?.comm;
  return [args, comm].filter((part) => !!part).join("\n") || void 0;
}
function procEnvironHome(pid) {
  try {
    const raw = fs6.readFileSync(`/proc/${pid}/environ`);
    for (const entry of raw.toString("utf8").split("\0")) {
      if (!entry.startsWith("CODEX_HOME=")) continue;
      const home = entry.slice("CODEX_HOME=".length);
      return { home: home || void 0 };
    }
    return {};
  } catch {
    return void 0;
  }
}
function codexHomes(pids) {
  const homes = /* @__PURE__ */ new Map();
  const missing = [];
  for (const pid of pids) {
    const fromProc = procEnvironHome(pid);
    if (!fromProc) {
      missing.push(pid);
      continue;
    }
    if (fromProc.home) homes.set(pid, fromProc.home);
  }
  if (!missing.length) return homes;
  try {
    const out = execFileSync2(psCommand(), ["-ww", "-p", missing.join(","), "-E", "-o", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" }
    });
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const home = /(?:^|\s)CODEX_HOME=(\S*)/.exec(match[2] ?? "");
      if (home?.[1]) homes.set(Number(match[1]), home[1]);
    }
  } catch {
  }
  return homes;
}
function processCwd(pid) {
  try {
    const cwd = fs6.readlinkSync(`/proc/${pid}/cwd`);
    if (cwd) return cwd;
  } catch {
  }
  try {
    const out = execFileSync2("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const line = out.split("\n").find((entry) => entry.startsWith("n") && entry.length > 1);
    return line?.slice(1);
  } catch {
    return void 0;
  }
}
function acceptTui(args, parent) {
  return !!codexTuiLaunch(args) && !parentIsAppBundle(parent);
}
function interpreterWrapper(command) {
  const tokens = tokenize(command);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++;
  const exe = tokens[i];
  return !!exe && INTERPRETERS.has(binName(exe));
}
function descendsFrom(pid, ancestor, ppidOf) {
  let current = ppidOf(pid);
  for (let hop = 0; hop < 16 && current; hop++) {
    if (current === ancestor) return true;
    current = ppidOf(current);
  }
  return false;
}
function dedupeCodexTuiProcs(procs, ppidOf) {
  const drop = /* @__PURE__ */ new Set();
  const wrappersOf = /* @__PURE__ */ new Map();
  for (const proc of procs) {
    if (!interpreterWrapper(proc.args)) continue;
    const descendants = procs.filter((other) => other.pid !== proc.pid && descendsFrom(other.pid, proc.pid, ppidOf));
    if (!descendants.length) continue;
    drop.add(proc.pid);
    for (const other of descendants) {
      const list = wrappersOf.get(other.pid) ?? [];
      if (!list.includes(proc.pid)) list.push(proc.pid);
      wrappersOf.set(other.pid, list);
    }
  }
  return procs.filter((proc) => !drop.has(proc.pid)).map((proc) => {
    const wrapperPids = wrappersOf.get(proc.pid);
    return wrapperPids?.length ? { ...proc, wrapperPids } : proc;
  });
}
function procsFromOverride(file) {
  try {
    const parsed = JSON.parse(fs6.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    const procs = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const rec = row;
      if (typeof rec.pid !== "number" || typeof rec.args !== "string") continue;
      const parent = typeof rec.parent === "string" ? rec.parent : void 0;
      const codexHome = typeof rec.codexHome === "string" && rec.codexHome ? rec.codexHome : void 0;
      if (!acceptTui(rec.args, parent)) continue;
      procs.push({
        pid: rec.pid,
        args: rec.args,
        cwd: typeof rec.cwd === "string" ? rec.cwd : void 0,
        start: typeof rec.start === "string" ? rec.start : void 0,
        codexHome,
        ppid: typeof rec.ppid === "number" ? rec.ppid : void 0
      });
    }
    const ppid = new Map(procs.map((proc) => [proc.pid, proc.ppid]));
    return dedupeCodexTuiProcs(procs, (pid) => ppid.get(pid));
  } catch {
    return [];
  }
}
var liveCache;
function codexTuiProcesses() {
  const override = process.env.TELEPATHY_CODEX_PROCS;
  if (override) return procsFromOverride(override);
  if (liveCache && Date.now() - liveCache.at < 500) return liveCache.procs;
  const lines = commandLines();
  const table = processTable();
  const candidates = [];
  for (const [pid, args] of lines) {
    if (!codexTuiLaunch(args)) continue;
    if (parentIsAppBundle(parentCommandOf(pid, table, lines))) continue;
    candidates.push({ pid, args });
  }
  const homes = codexHomes(candidates.map((candidate) => candidate.pid));
  const procs = dedupeCodexTuiProcs(
    candidates.map((candidate) => ({
      pid: candidate.pid,
      args: candidate.args,
      start: table.get(candidate.pid)?.start,
      codexHome: homes.get(candidate.pid)
    })),
    (pid) => table.get(pid)?.ppid
  );
  liveCache = { at: Date.now(), procs };
  return procs;
}

// src/core/codex-threads.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import fs7 from "node:fs";
import path6 from "node:path";
var locksDir = (codexHome) => path6.join(codexHome, "thread-writer-locks");
var cache2;
function heldLocks(dir, maxAgeMs = 1e3) {
  let files;
  try {
    files = fs7.readdirSync(dir).filter((f) => f.endsWith(".lock") && !f.startsWith("."));
  } catch {
    return void 0;
  }
  const key = `${dir}
${files.sort().join("\n")}`;
  if (cache2 && cache2.key === key && Date.now() - cache2.at < maxAgeMs) return cache2.held;
  let held;
  try {
    if (!files.length) {
      held = /* @__PURE__ */ new Set();
    } else {
      let out;
      try {
        out = execFileSync3("lsof", ["-F", "n", "--", ...files], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch (err) {
        const e = err;
        if (e.code === "ENOENT" || e.status !== 1) throw err;
        out = e.stdout ?? "";
      }
      held = new Set(
        out.split("\n").filter((l) => l.startsWith("n")).map((l) => path6.basename(l.slice(1)).replace(/\.lock$/, ""))
      );
    }
  } catch {
    held = void 0;
  }
  cache2 = { at: Date.now(), key, held };
  return held;
}
function codexThreadLoaded(codexHome, threadId) {
  const dir = locksDir(codexHome);
  if (!fs7.existsSync(dir)) return void 0;
  if (!fs7.existsSync(path6.join(dir, `${threadId}.lock`))) return false;
  return heldLocks(dir)?.has(threadId) ?? true;
}

// src/core/peers.ts
var peerId = (agent, key) => `${agent}-${key}`;
var sessionKey = (_agent, pid, sessionId) => sessionToken(sessionId) ?? pid;
function sessionToken(sessionId) {
  const trimmed = sessionId?.trim();
  if (!trimmed || trimmed.length > 180) return void 0;
  const safe = trimmed.replace(/[^A-Za-z0-9_-]/g, "_");
  return /^[A-Za-z0-9]/.test(safe) ? safe : void 0;
}
var sessionPeerId = (agent, pid, sessionId) => peerId(agent, sessionKey(agent, pid, sessionId));
var ownersFile = (id) => path7.join(peerDir(id), "owners.json");
var linkFile = (agent, pid) => path7.join(peerDir(peerId(agent, pid)), "link.json");
var rememberedFile = (agent, sessionId) => path7.join(stateDir(), "identities", agent, `${sessionToken(sessionId)}.json`);
function sessionOwners(id) {
  const owners = readJson(ownersFile(id)) ?? [];
  return owners.filter((owner) => isSameProcess(owner.pid, owner.procStart));
}
function claimSessionOwner(id, pid) {
  const owners = sessionOwners(id);
  if (!owners.some((owner) => owner.pid === pid)) {
    owners.push({ pid, procStart: procStart(pid), at: (/* @__PURE__ */ new Date()).toISOString() });
    owners.sort((a, b) => a.at.localeCompare(b.at));
    writeJsonAtomic(ownersFile(id), owners);
  }
  return owners[0]?.pid === pid;
}
function linkedPeerId(agent, pid) {
  const link = readJson(linkFile(agent, pid));
  return typeof link?.id === "string" ? link.id : void 0;
}
function rememberName(agent, sessionId, generated) {
  const token = sessionToken(sessionId);
  if (!token) return generated;
  const file = rememberedFile(agent, sessionId);
  const existing = readJson(file);
  if (existing?.name) return existing.name;
  writeJsonAtomic(file, { name: generated });
  return generated;
}
function rememberedName(agent, sessionId) {
  if (!sessionId || !sessionToken(sessionId)) return void 0;
  return readJson(rememberedFile(agent, sessionId))?.name;
}
var PEER_DIR_RE = new RegExp(`^(${AGENT_ALTERNATION})-([A-Za-z0-9][A-Za-z0-9_-]*)$`);
var AGENT_PREFIX_RE = new RegExp(`^(${AGENT_ALTERNATION}):`);
var REF_RE = new RegExp(`^(${AGENT_ALTERNATION})-(\\d+|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|ses_[A-Za-z0-9]+)$`);
var defaultCodexHome = () => configuredEnv("CODEX_HOME") || path7.join(os4.homedir(), ".codex");
function copilotEventsFile(sessionId, env = process.env) {
  const home = configuredEnv("COPILOT_HOME", env) || path7.join(os4.homedir(), ".copilot");
  return path7.join(home, "session-state", sessionId, "events.jsonl");
}
var claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path7.join(os4.homedir(), ".claude");
function registerSession(agent, pid, fields, id = sessionPeerId(agent, pid, fields.sessionId)) {
  const file = path7.join(peerDir(id), "session.json");
  const previous = readJson(file);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const owner = fields.sessionId ? claimSessionOwner(id, pid) : true;
  const primary = fields.sessionId ? sessionOwners(id)[0] : void 0;
  const record = {
    agent,
    pid: primary?.pid ?? pid,
    procStart: primary?.procStart ?? procStart(pid),
    ...fields,
    startedAt: previous?.sessionId === fields.sessionId && previous?.startedAt || now,
    updatedAt: now,
    surface: fields.surface ?? previous?.surface,
    transcriptPath: fields.transcriptPath ?? previous?.transcriptPath
  };
  if (previous?.exitedAt) dropInboxAfter(id, previous.exitedAt);
  writeJsonAtomic(file, record);
  if (fields.sessionId && sessionToken(fields.sessionId)) {
    const key = sessionToken(fields.sessionId);
    const carried = agent === "codex" ? carryLaunchedCodexName(fields.sessionId) : void 0;
    rememberName(agent, fields.sessionId, carried ?? displayName(agent, pid, key, fields.cwd ?? previous?.cwd));
    if (peerId(agent, pid) !== id) {
      writeJsonAtomic(linkFile(agent, pid), { id });
      if (owner) moveInbox(peerId(agent, pid), id);
    }
    adoptHeldMessages(agent, id, fields.sessionId);
  }
  return record;
}
function notePeerExit(id, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const session = readSession(id);
  if (!session || session.exitedAt) return;
  writeJsonAtomic(path7.join(peerDir(id), "session.json"), { ...session, exitedAt: at });
}
function dropInboxAfter(id, exitedAt) {
  const cutoff = Date.parse(exitedAt);
  if (Number.isNaN(cutoff)) return;
  let files = [];
  try {
    files = fs8.readdirSync(inboxDir(id));
  } catch {
    return;
  }
  for (const file of files) {
    const msg = readJson(path7.join(inboxDir(id), file));
    const sent = Date.parse(msg?.sentAt ?? "");
    if (Number.isNaN(sent) || sent <= cutoff) continue;
    try {
      fs8.rmSync(path7.join(inboxDir(id), file), { force: true });
    } catch {
    }
  }
}
function moveInbox(fromId, toId) {
  if (fromId === toId) return;
  let files = [];
  try {
    files = fs8.readdirSync(inboxDir(fromId));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      fs8.renameSync(path7.join(inboxDir(fromId), file), path7.join(ensureDir(inboxDir(toId)), file));
    } catch {
    }
  }
}
var HOLD_MS = 60 * 6e4;
var SESSION_KEEP_MS = 24 * 60 * 6e4;
var SERVICE_SESSION_ACTIVE_MS = 12 * 60 * 6e4;
function lastActivity(id) {
  const times = [readSession(id)?.updatedAt, readJson(path7.join(peerDir(id), "status.json"))?.at];
  return Math.max(...times.map((t) => Date.parse(t ?? "")).filter((t) => !Number.isNaN(t)), 0);
}
function keepsSession(peer, now = Date.now()) {
  return !!peer && isSessionKeyed(peer) && now - lastActivity(peer.id) < SESSION_KEEP_MS;
}
function holdsUnread(id, now = Date.now()) {
  try {
    return fs8.readdirSync(inboxDir(id)).some((f) => now - fs8.statSync(path7.join(inboxDir(id), f)).mtimeMs < HOLD_MS);
  } catch {
    return false;
  }
}
function adoptHeldMessages(agent, selfId, sessionId) {
  let names;
  try {
    names = fs8.readdirSync(peersDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (name === selfId || !name.startsWith(`${agent}-`)) continue;
    const old = readJson(path7.join(peerDir(name), "session.json"));
    if (old?.agent !== agent || old.sessionId !== sessionId || isPeerAlive(readPeer(name))) continue;
    let files = [];
    try {
      files = fs8.readdirSync(inboxDir(name));
    } catch {
    }
    for (const file of files) {
      try {
        fs8.renameSync(path7.join(inboxDir(name), file), path7.join(ensureDir(inboxDir(selfId)), file));
      } catch {
      }
    }
    fs8.rmSync(peerDir(name), { recursive: true, force: true });
  }
}
function registerListener(agent, pid, id = peerId(agent, pid)) {
  const record = { pid: process.pid, procStart: procStart(process.pid), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeJsonAtomic(path7.join(peerDir(id), "listener.json"), record);
}
function configuredStableName(explicit) {
  const raw = explicit?.trim() || configuredEnv("TELEPATHY_NAME");
  if (!raw) return void 0;
  return slugify(raw) || void 0;
}
function registerStableName(agent, id, explicit) {
  const name = configuredStableName(explicit);
  if (!name) {
    const file = path7.join(peerDir(id), "identity.json");
    if (readJson(file)?.name === "mcp") fs8.rmSync(file, { force: true });
    return;
  }
  writeJsonAtomic(path7.join(peerDir(id), "identity.json"), { name, pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() });
  adoptStableInbox(agent, id, name);
}
function adoptStableInbox(agent, selfId, stableName) {
  let names;
  try {
    names = fs8.readdirSync(peersDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (name === selfId || !name.startsWith(`${agent}-`)) continue;
    const ident = readJson(path7.join(peerDir(name), "identity.json"));
    if (ident?.name !== stableName || isPeerAlive(readPeer(name))) continue;
    let files = [];
    try {
      files = fs8.readdirSync(inboxDir(name));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        fs8.renameSync(path7.join(inboxDir(name), file), path7.join(ensureDir(inboxDir(selfId)), file));
      } catch {
      }
    }
  }
}
var sameStableName = (a, b) => !!a.stableName && a.id !== b.id && a.agent === b.agent && a.stableName === b.stableName;
function readSession(id) {
  return readJson(path7.join(peerDir(id), "session.json"));
}
function slugify(value) {
  return value.normalize("NFKD").replace(new RegExp("(\\p{Script=Latin})\\p{M}+", "gu"), "$1").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40).replace(/[-.]+$/g, "");
}
function claudeSessionName(pid) {
  const record = readJson(path7.join(claudeConfigDir(), "sessions", `${pid}.json`));
  return typeof record?.name === "string" && record.name ? record.name : void 0;
}
function codexThreadName(codexHome, sessionId) {
  if (!sessionId) return void 0;
  let text;
  try {
    text = fs8.readFileSync(path7.join(codexHome, "session_index.jsonl"), "utf8");
  } catch {
    return void 0;
  }
  let name;
  for (const line of text.split("\n")) {
    if (!line.includes(sessionId)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id === sessionId && entry.thread_name) name = entry.thread_name;
    } catch {
    }
  }
  return name;
}
var nameSuffix = (agent, key) => agent[0] + createHash("sha1").update(String(key)).digest("hex").slice(0, 2);
function displayName(agent, pid, key, cwd) {
  const folder = cwd ? slugify(path7.basename(cwd)) : "";
  if (agent === "claude") return claudeSessionName(pid) || folder || `session-${pid}`;
  const k = /^\d+$/.test(key) ? Number(key) : key;
  return folder ? `${folder}-${nameSuffix(agent, k)}` : `session-${key}`;
}
var isSessionKeyed = (peer) => {
  const token = sessionToken(peer.sessionId);
  return !!token && peer.id === peerId(peer.agent, token);
};
var isThreadKeyed = (peer) => peer.agent === "codex" && isSessionKeyed(peer);
function hostedSupervisorAlive(peer) {
  const rec = readJson(path7.join(peerDir(peer.id), "hosted.json"));
  return !!rec && typeof rec.pid === "number" && isSameProcess(rec.pid, rec.procStart);
}
function codexExecAlive(peer) {
  const session = readSession(peer.id);
  if (!session || session.source !== "hook" && session.source !== "meta") return false;
  const owners = sessionOwners(peer.id);
  const pid = owners[0]?.pid ?? session.pid;
  const started = owners[0]?.procStart ?? session.procStart;
  if (!isSameProcess(pid, started)) return false;
  const args = commandLine(pid);
  return !!args && isCodexExecCommand(args);
}
function isPeerAlive(peer, now = Date.now()) {
  if (!peer) return false;
  if (hostedSupervisorAlive(peer)) return true;
  if (isThreadKeyed(peer)) {
    const loaded = codexThreadLoaded(peer.codexHome ?? defaultCodexHome(), peer.sessionId);
    if (loaded === true) return true;
    if (loaded === false) return codexTuiNamesThread(peer.sessionId) || codexExecAlive(peer);
  }
  if (isSessionKeyed(peer)) {
    const owner = sessionOwners(peer.id)[0];
    const pid = owner?.pid ?? peer.pid;
    const started = owner?.procStart ?? readSession(peer.id)?.procStart;
    if (!isSameProcess(pid, started)) return false;
    if (peer.agent === "opencode" || peer.agent === "kilo") return now - lastActivity(peer.id) < SERVICE_SESSION_ACTIVE_MS;
    return true;
  }
  return isSameProcess(peer.pid, peer.procStart);
}
function readPeer(id) {
  const m = PEER_DIR_RE.exec(id);
  if (!m) return void 0;
  const agent = m[1];
  const dir = peerDir(id);
  const session = readJson(path7.join(dir, "session.json"));
  const presence = readJson(path7.join(dir, "presence.json"));
  const listener = readJson(path7.join(dir, "listener.json"));
  if (!session && !presence) return void 0;
  const pid = session?.pid ?? presence?.pid ?? Number(m[2]);
  const cwd = session?.cwd || presence?.cwd;
  const codexHome = session?.codexHome || presence?.codexHome || defaultCodexHome();
  const generated = displayName(agent, pid, m[2], cwd);
  const identity = readJson(path7.join(dir, "identity.json"));
  const stable = identity?.name && slugify(identity.name) === identity.name ? identity.name : void 0;
  const name = stable || rememberedName(agent, session?.sessionId) || generated;
  const sessionKeyed = !!session?.sessionId && m[2] === sessionToken(session.sessionId);
  const aliases = [
    cwd ? slugify(path7.basename(cwd)) : "",
    agent === "codex" ? slugify(codexThreadName(codexHome, session?.sessionId) ?? "") : "",
    stable ? slugify(generated) : ""
  ];
  return {
    id,
    agent,
    pid,
    // A session keyed by its id may outlive the process that hosted it when it registered (a Codex thread), or share
    // it with many others (an OpenCode service), so that process's start says nothing about the session.
    procStart: sessionKeyed ? void 0 : session?.procStart || presence?.procStart,
    startedAt: sessionKeyed ? session?.startedAt : void 0,
    sessionId: session?.sessionId,
    cwd,
    codexHome,
    name,
    address: `${agent}:${slugify(name) || id}`,
    stableName: stable,
    duplicate: sessionOwners(id).length > 1,
    hasListener: !!listener && isSameProcess(listener.pid, listener.procStart),
    hasServer: !!presence && isSameProcess(presence.serverPid, void 0),
    version: presence?.version,
    hookRan: session?.source === "hook",
    toolHookRan: fs8.existsSync(path7.join(dir, "tool-hook.json")),
    aliases: [...new Set(aliases)].filter((a) => a && a !== slugify(name))
  };
}
function listPeers() {
  observeLaunchedCodex();
  let names = [];
  try {
    names = fs8.readdirSync(peersDir());
  } catch {
    return [];
  }
  const peers = [];
  for (const name of names.sort()) {
    const m = PEER_DIR_RE.exec(name);
    if (!m) continue;
    const peer = readPeer(name);
    const pid = peer?.pid ?? (/^\d+$/.test(m[2]) ? Number(m[2]) : void 0);
    if (pid === void 0) continue;
    if (peer ? !isPeerAlive(peer) : !isSameProcess(pid, void 0)) {
      if (peer) notePeerExit(name);
      if (!holdsUnread(name) && !keepsSession(peer)) fs8.rmSync(peerDir(name), { recursive: true, force: true });
      continue;
    }
    if (peer) peers.push(peer);
  }
  const threads = new Set(peers.filter(isThreadKeyed).map((p) => p.sessionId));
  const ids = new Set(peers.map((p) => p.id));
  return peers.filter((p) => {
    if (p.agent === "codex" && !isThreadKeyed(p) && !!p.sessionId && threads.has(p.sessionId)) return false;
    const link = readJson(path7.join(peerDir(p.id), "link.json"));
    if (typeof link?.id === "string" && link.id !== p.id && ids.has(link.id)) return false;
    return p.agent !== "codex" || isThreadKeyed(p) || !!p.sessionId && !threads.has(p.sessionId) || isLaunchedCodexTui(p);
  });
}
function isLaunchedCodexTui(peer) {
  return peer.agent === "codex" && !peer.sessionId && readSession(peer.id)?.source === "process";
}
function launchedTuis() {
  const tuis = [];
  for (const proc of codexTuiProcesses()) {
    if (!isSameProcess(proc.pid, proc.start)) continue;
    const launch = codexTuiLaunch(proc.args);
    if (!launch) continue;
    tuis.push({ pid: proc.pid, cwd: proc.cwd || processCwd(proc.pid), threadId: launch.threadId });
  }
  return tuis;
}
function codexTuiNamesThread(threadId) {
  return launchedTuis().some((tui) => tui.threadId === threadId);
}
function carryLaunchedCodexName(sessionId) {
  const chosen = launchedTuis().find((tui) => tui.threadId === sessionId);
  if (!chosen) return void 0;
  const threadPeer = sessionPeerId("codex", chosen.pid, sessionId);
  const pidKey = peerId("codex", chosen.pid);
  if (pidKey !== threadPeer) {
    writeJsonAtomic(linkFile("codex", chosen.pid), { id: threadPeer });
    moveInbox(pidKey, threadPeer);
  }
  const placeholder = readPeer(pidKey);
  return placeholder && !placeholder.sessionId ? placeholder.name : void 0;
}
function observeLaunchedCodex() {
  for (const proc of codexTuiProcesses()) {
    if (!isSameProcess(proc.pid, proc.start)) continue;
    const launch = codexTuiLaunch(proc.args);
    if (!launch) continue;
    const cwd = proc.cwd || processCwd(proc.pid);
    if (launch.threadId && sessionToken(launch.threadId)) {
      observeResumedCodex(proc, launch.threadId, cwd);
      continue;
    }
    observeUnpromptedCodex(proc, cwd);
  }
}
function observeResumedCodex(proc, threadId, cwd) {
  const id = sessionPeerId("codex", proc.pid, threadId);
  const existing = readSession(id);
  const hostAlive = !!existing && isSameProcess(existing.pid, existing.procStart);
  const home = proc.codexHome ?? existing?.codexHome ?? defaultCodexHome();
  if (!existing?.sessionId || !hostAlive || proc.codexHome && existing.codexHome !== proc.codexHome) {
    registerSession("codex", proc.pid, {
      sessionId: threadId,
      cwd: cwd ?? existing?.cwd,
      source: existing?.source === "hook" || existing?.source === "meta" ? existing.source : "process",
      codexHome: home
    });
  }
  if (peerId("codex", proc.pid) !== id) writeJsonAtomic(linkFile("codex", proc.pid), { id });
  linkCodexWrappers(proc, id);
}
function linkCodexWrappers(proc, id) {
  for (const wrapperPid of proc.wrapperPids ?? []) {
    const wrapperId = peerId("codex", wrapperPid);
    if (wrapperId === id) continue;
    if (!fs8.existsSync(path7.join(peerDir(wrapperId), "session.json"))) continue;
    writeJsonAtomic(linkFile("codex", wrapperPid), { id });
  }
}
function observeUnpromptedCodex(proc, cwd) {
  const id = peerId("codex", proc.pid);
  const link = linkedPeerId("codex", proc.pid);
  if (link && link !== id) {
    const linked = readPeer(link);
    if (linked && isPeerAlive(linked)) return;
  }
  const existing = readSession(id);
  const home = proc.codexHome || existing?.codexHome || defaultCodexHome();
  if (existing?.source === "process" && existing.pid === proc.pid && isSameProcess(proc.pid, existing.procStart) && existing.codexHome === home && (existing.cwd || !cwd)) {
    linkCodexWrappers(proc, id);
    return;
  }
  registerSession("codex", proc.pid, { cwd, source: "process", codexHome: home });
  linkCodexWrappers(proc, id);
}
function keptPeers() {
  let names = [];
  try {
    names = fs8.readdirSync(peersDir());
  } catch {
    return [];
  }
  const kept = [];
  for (const name of names) {
    const peer = readPeer(name);
    if (!peer || !isSessionKeyed(peer) || isPeerAlive(peer) || !keepsSession(peer)) continue;
    kept.push(peer);
  }
  return kept;
}
var peerRef = (peer) => `${peer.address} [${peer.id}]`;
function resolvePeer(to, peers) {
  let query = to.trim().replace(/^["'`]|["'`]$/g, "").trim();
  const bracketed = /\[([^\]]+)\]\s*$/.exec(query);
  if (bracketed) query = bracketed[1].trim();
  const q = query.toLowerCase();
  if (!q) return { error: "Recipient is empty." };
  const pick = (matches, how) => {
    if (matches.length === 1) return { peer: matches[0] };
    if (matches.length > 1) {
      return {
        error: `"${to}" ${how} ${matches.length} sessions: ${matches.map(peerRef).join(", ")}. Use the [ref] to pick one.`
      };
    }
    return void 0;
  };
  const slugsOf = (p) => [p.address.slice(p.agent.length + 1), ...p.aliases ?? []];
  const qSlug = slugify(q.replace(AGENT_PREFIX_RE, ""));
  const qAgent = AGENT_PREFIX_RE.exec(q)?.[1] ?? (REF_RE.test(q) ? q.slice(0, q.lastIndexOf("-")) : void 0);
  const sameAgent = (p) => !qAgent || p.agent === qAgent;
  const byId = peers.filter((p) => p.id.toLowerCase() === q);
  const exactId = byId.filter((p) => p.id === query);
  return pick(exactId.length ? exactId : byId, "matches") ?? pick(peers.filter((p) => p.address.toLowerCase() === q), "matches") ?? // `codex:` with nothing after the colon is that agent when only one of its sessions is up.
  pick(q.endsWith(":") && qAgent && qSlug === "" ? peers.filter((p) => p.agent === qAgent) : [], "matches") ?? pick(peers.filter((p) => sameAgent(p) && (slugsOf(p).includes(qSlug) || p.name.toLowerCase() === q)), "matches") ?? pick(peers.filter((p) => sameAgent(p) && qSlug !== "" && slugsOf(p).some((s) => s.startsWith(qSlug))), "is a prefix of") ?? {
    error: `No reachable session matches "${to}". ` + (peers.length ? `Reachable: ${peers.map(peerRef).join(", ")}.` : "No other sessions with telepathy are running.")
  };
}

// src/core/tags.ts
var PEER_MESSAGE_TAG = "telepathy-peer-message";
var NOTE_TAG = "telepathy-note";
function tagAttr(value) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
var escapeTelepathyTags = (text) => text.replace(/<(\/?telepathy-)/gi, "<\\$1");
function noteTag(kind, text) {
  return `<${NOTE_TAG} kind="${kind}">${escapeTelepathyTags(text)}</${NOTE_TAG}>`;
}

// src/core/messages.ts
var MAX_MESSAGE_CHARS = 1e5;
var ARCHIVE_KEEP = 200;
var MSG_FILE_RE = /^m-[0-9a-z]+-[0-9a-f]+\.json$/;
var partyOf = (peer) => ({ id: peer.id, agent: peer.agent, name: peer.name, address: peer.address });
function newMessageId() {
  return `m-${Date.now().toString(36).padStart(9, "0")}-${crypto.randomBytes(3).toString("hex")}`;
}
function writeToInbox(msg) {
  writeJsonAtomic(path8.join(inboxDir(msg.to.id), `${msg.id}.json`), msg);
}
function archiveMessage(msg) {
  writeJsonAtomic(path8.join(archiveDir(msg.to.id), `${msg.id}.json`), msg);
  pruneArchive(msg.to.id);
}
function deliveryBlocked(peerId2, msg, now = Date.now()) {
  if (fs9.existsSync(path8.join(withdrawnDir(peerId2), `${msg.id}.json`))) return true;
  return typeof msg.deliverBy === "number" && Number.isFinite(msg.deliverBy) && now >= msg.deliverBy;
}
function withdrawEverywhere(peerId2, messageId) {
  const file = `${messageId}.json`;
  const dest = path8.join(ensureDir(withdrawnDir(peerId2)), file);
  const sources = [path8.join(inboxDir(peerId2), file), path8.join(archiveDir(peerId2), file)];
  if (!fs9.existsSync(dest)) {
    for (const src of sources) {
      try {
        fs9.renameSync(src, dest);
        break;
      } catch {
      }
    }
  }
  for (const src of sources) {
    try {
      if (fs9.existsSync(src)) fs9.rmSync(src, { force: true });
    } catch {
    }
  }
  if (fs9.existsSync(dest)) return "withdrawn";
  if (sources.some((src) => fs9.existsSync(src))) return "claimed";
  return "missing";
}
function pendingMessages(peerId2) {
  let files;
  try {
    files = fs9.readdirSync(inboxDir(peerId2)).filter((f) => MSG_FILE_RE.test(f)).sort();
  } catch {
    return [];
  }
  const pending = [];
  for (const file of files) {
    const msg = readJson(path8.join(inboxDir(peerId2), file));
    if (!msg) continue;
    if (deliveryBlocked(peerId2, msg)) {
      withdrawEverywhere(peerId2, msg.id);
      continue;
    }
    pending.push(msg);
  }
  return pending;
}
function archiveSettled(peerId2, id) {
  const dest = path8.join(ensureDir(archiveDir(peerId2)), `${id}.json`);
  for (const dir of [inboxDir(peerId2), withdrawnDir(peerId2)]) {
    try {
      fs9.renameSync(path8.join(dir, `${id}.json`), dest);
      return;
    } catch {
    }
  }
}
function pruneArchive(peerId2) {
  try {
    const files = fs9.readdirSync(archiveDir(peerId2)).filter((f) => MSG_FILE_RE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) {
      fs9.rmSync(path8.join(archiveDir(peerId2), f), { force: true });
    }
  } catch {
  }
}
var describeSender = (from) => escapeTelepathyTags(`${agentLabel(from.agent)} session ${peerRef(from)}`);
var messageMarker = (id) => `telepathy-id:${id}`;
function openTag(msg, extra = {}) {
  const attrs = {
    id: msg.id,
    from: peerRef(msg.from),
    agent: agentLabel(msg.from.agent),
    "reply-to": msg.from.address,
    ...msg.kind ? { kind: msg.kind } : {},
    ...msg.transcript ? { transcript: msg.transcript } : {},
    ...extra
  };
  const text = Object.entries(attrs).map(([key, value]) => `${key}="${tagAttr(value)}"`).join(" ");
  return `<${PEER_MESSAGE_TAG} ${text}>`;
}
var closeTag = `</${PEER_MESSAGE_TAG}>`;
function formatAsUserTurn(msg, reply) {
  return [
    openTag(msg),
    `Message from ${describeSender(msg.from)}.`,
    messageMarker(msg.id),
    `It was sent by another AI agent through the telepathy plugin, not typed by your user. ` + (reply ?? `To reply, call the telepathy send_message tool with to: "${escapeTelepathyTags(msg.from.address)}".`),
    "",
    escapeTelepathyTags(msg.body),
    closeTag
  ].join("\n");
}

// src/core/codex-queue.ts
var execFileAsync = promisify(execFile);
function codexCandidateBins() {
  const configured = process.env.TELEPATHY_CODEX_BIN;
  if (configured) return [configured];
  if (inTestSandbox()) return ["codex"];
  return ["codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex", path9.join(os5.homedir(), ".local", "bin", "codex")];
}
function sandboxCodexHomeBlock(codexHome) {
  if (!inTestSandbox()) return void 0;
  const home = codexHome || configuredEnv("CODEX_HOME");
  if (!home || outsideIsolatedHome(home)) return `refusing to launch codex outside the test sandbox (${home ?? "CODEX_HOME unset"})`;
  return void 0;
}
function sandboxBinaryBlock(bin) {
  if (!inTestSandbox()) return void 0;
  const resolved = resolveOnPath(bin);
  if (!resolved || sandboxAllowsExecutable(resolved)) return void 0;
  return `refusing to run ${resolved} from a test sandbox`;
}
var codexEnv = (codexHome) => ({ ...process.env, ...codexHome ? { CODEX_HOME: codexHome } : {} });
async function queueIntoCodex(threadId, text, codexHome) {
  const blocked = sandboxCodexHomeBlock(codexHome);
  if (blocked) throw new Error(blocked);
  const args = ["queue", `--thread=${threadId}`, `--message=${text}`];
  let lastError;
  for (const bin of codexCandidateBins()) {
    const binary = sandboxBinaryBlock(bin);
    if (binary) throw new Error(binary);
    try {
      const { stdout } = await execFileAsync(bin, args, { env: codexEnv(codexHome), timeout: 3e4, maxBuffer: 1024 * 1024 });
      return /Queued message (\S+) for thread/.exec(stdout)?.[1];
    } catch (err) {
      lastError = err;
      if (err.code !== "ENOENT") break;
    }
  }
  const e = lastError;
  if (e?.code === "ENOENT") {
    throw new Error("The codex CLI was not found on PATH; set TELEPATHY_CODEX_BIN to its path.");
  }
  throw new Error(`codex queue failed: ${(e?.stderr || e?.message || String(e)).trim()}`);
}
async function deleteFromCodexQueue(threadId, queueIds, codexHome, timeoutMs = 1e4) {
  if (!queueIds.length) return /* @__PURE__ */ new Map();
  if (sandboxCodexHomeBlock(codexHome)) return void 0;
  for (const bin of codexCandidateBins()) {
    if (sandboxBinaryBlock(bin)) return void 0;
    try {
      return await appServerDeletes(bin, threadId, queueIds, codexHome, timeoutMs);
    } catch (err) {
      if (err.code !== "ENOENT") return void 0;
    }
  }
  return void 0;
}
function appServerDeletes(bin, threadId, queueIds, codexHome, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["app-server"], { env: codexEnv(codexHome), stdio: ["pipe", "pipe", "ignore"] });
    const results = /* @__PURE__ */ new Map();
    const finish = (err) => {
      clearTimeout(timer2);
      child.kill();
      if (err) reject(err);
      else resolve(results);
    };
    const timer2 = setTimeout(() => finish(new Error("codex app-server timed out")), timeoutMs);
    child.on("error", (err) => finish(err));
    const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 0) {
        if (msg.error) return finish(new Error(msg.error.message ?? "initialize failed"));
        send({ method: "initialized" });
        queueIds.forEach(
          (queuedSubmissionId, i) => send({ id: i + 1, method: "thread/queue/delete", params: { threadId, queuedSubmissionId } })
        );
      } else if (typeof msg.id === "number" && msg.id >= 1 && msg.id <= queueIds.length) {
        if (msg.error) return finish(new Error(msg.error.message ?? "thread/queue/delete failed"));
        results.set(queueIds[msg.id - 1], msg.result?.deleted === true);
        if (results.size === queueIds.length) finish();
      }
    });
    send({
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "telepathy", version: VERSION }, capabilities: { experimentalApi: true } }
    });
  });
}

// src/core/wake.ts
import { spawn as spawn2 } from "node:child_process";
import crypto2 from "node:crypto";
import fs10 from "node:fs";
import path10 from "node:path";
var WAKE_DEBOUNCE_MS = 400;
var WAKE_DEBOUNCE_MAX_MS = 1500;
var DEFAULT_TIMEOUT_MS = 8e3;
var DEFAULT_AUTH_HEADERS = ["Authorization", "X-Automation-Key"];
var deliveryConfigPath = () => path10.join(stateDir(), "delivery.json");
var wakeLogPath = () => path10.join(stateDir(), "wake.log");
function wakeDebounceMs() {
  return envDurationMs("TELEPATHY_WAKE_DEBOUNCE_MS", WAKE_DEBOUNCE_MS);
}
function wakeDebounceMaxMs() {
  return Math.max(envDurationMs("TELEPATHY_WAKE_DEBOUNCE_MAX_MS", WAKE_DEBOUNCE_MAX_MS), wakeDebounceMs());
}
var wakeDir = () => path10.join(stateDir(), "wake");
var batchPath = (key) => path10.join(wakeDir(), `${key}.json`);
function batchKey(target) {
  const material = JSON.stringify({ url: target.webhook?.url ?? "", command: target.command ?? [] });
  return crypto2.createHash("sha256").update(material).digest("hex").slice(0, 32);
}
function readDeliveryConfig() {
  const file = deliveryConfigPath();
  let mode;
  try {
    mode = fs10.statSync(file).mode & 511;
  } catch {
    return void 0;
  }
  if ((mode & 63) !== 0) {
    debugLog("wake", `delivery.json is mode ${mode.toString(8)}, not 600; webhook config was not loaded`);
    return void 0;
  }
  return readJson(file);
}
function wakeForPeer(peer, config = readDeliveryConfig()) {
  if (!config) return void 0;
  const keys = [peer.address, peer.stableName, peer.id].filter((k) => !!k);
  for (const key of keys) {
    const hit = config.peers?.[key];
    if (hit?.webhook?.url || hit?.command?.length) return hit;
  }
  if (!config.webhook?.url && !config.command?.length) return void 0;
  const name = config.name?.trim().toLowerCase();
  if (!name) return void 0;
  if (peer.stableName === name || peer.address.toLowerCase() === `${peer.agent}:${name}`) {
    return { webhook: config.webhook, command: config.command };
  }
  return void 0;
}
function webhookHeaders(target) {
  const headers = { "content-type": "application/json" };
  const key = target.key?.trim();
  if (key) {
    const names = target.authHeaders?.length ? target.authHeaders : DEFAULT_AUTH_HEADERS;
    for (const name of names) {
      headers[name] = name.toLowerCase() === "authorization" ? `Bearer ${key}` : key;
    }
  }
  for (const [name, value] of Object.entries(target.headers ?? {})) headers[name] = value;
  return headers;
}
function headerSecrets(headers) {
  return Object.values(headers ?? {}).filter((v) => v.length >= 4);
}
function secretValues(target) {
  const values = headerSecrets(webhookHeaders(target ?? { url: "" }));
  const key = target?.key?.trim();
  if (key && key.length >= 4) values.push(key);
  if (target?.url) {
    try {
      for (const value of new URL(target.url).searchParams.values()) {
        if (value.length >= 4) values.push(value);
      }
    } catch {
    }
  }
  return values;
}
var scrub = (text, secrets) => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 200);
};
function hostOf(url) {
  try {
    return new URL(url).host || "webhook";
  } catch {
    return "webhook";
  }
}
function logFailure(kind, target, detail, secrets, url) {
  let text = `${kind} ${target} ${detail}`;
  if (url) text = text.split(url).join(target);
  const safe = scrub(text, secrets);
  try {
    ensureDir(stateDir());
    fs10.appendFileSync(wakeLogPath(), `${(/* @__PURE__ */ new Date()).toISOString()} ${safe}
`);
    fs10.chmodSync(wakeLogPath(), 384);
  } catch {
  }
  debugLog("wake", safe);
}
function sleepSync(ms) {
  const until = Date.now() + ms;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    while (Date.now() < until) {
    }
  }
}
function withLockSync(fn) {
  ensureDir(wakeDir());
  const lock = path10.join(wakeDir(), ".lock");
  const start = Date.now();
  for (; ; ) {
    try {
      const fd = fs10.openSync(lock, "wx");
      try {
        return fn();
      } finally {
        fs10.closeSync(fd);
        try {
          fs10.unlinkSync(lock);
        } catch {
        }
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs10.statSync(lock).mtimeMs > 5e3) fs10.unlinkSync(lock);
      } catch {
      }
      if (Date.now() - start > 2e3) throw new Error("wake lock timed out");
      sleepSync(10);
    }
  }
}
function pendingItems(items) {
  return items.filter((item) => {
    try {
      return fs10.existsSync(path10.join(inboxDir(item.peerId), `${item.id}.json`));
    } catch {
      return false;
    }
  });
}
function wakePayload(items) {
  const last = items[items.length - 1];
  return {
    id: last?.id ?? "",
    ids: items.map((item) => item.id),
    from: last?.from ?? "",
    count: items.length,
    at: last?.at ?? ""
  };
}
var refTimers = true;
var timer;
var flushing;
function armTimer(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = void 0;
    void kick();
  }, ms);
  if (!refTimers) timer.unref();
}
function scheduleFlush() {
  armTimer(wakeDebounceMs());
}
async function kick() {
  if (flushing) {
    await flushing;
    return;
  }
  flushing = flushDue().finally(() => {
    flushing = void 0;
  });
  await flushing;
}
function listBatches() {
  try {
    return fs10.readdirSync(wakeDir()).filter((name) => name.endsWith(".json")).map((name) => path10.join(wakeDir(), name));
  } catch {
    return [];
  }
}
function dueIn(file) {
  const batch = readJson(file);
  if (!batch) return 0;
  const due = Math.min(batch.lastAtMs + wakeDebounceMs(), batch.firstAtMs + wakeDebounceMaxMs());
  return Math.max(0, due - Date.now());
}
async function flushDue() {
  for (const file of listBatches()) {
    const peek = readJson(file);
    if (!peek || dueIn(file) > 0) continue;
    let taken;
    withLockSync(() => {
      const cur = readJson(file);
      if (!cur) return;
      const due = Math.min(cur.lastAtMs + wakeDebounceMs(), cur.firstAtMs + wakeDebounceMaxMs());
      if (Date.now() < due) return;
      taken = cur;
      try {
        fs10.unlinkSync(file);
      } catch {
        taken = void 0;
      }
    });
    if (taken) await deliverBatch(taken);
  }
}
async function deliverBatch(batch) {
  const items = pendingItems(batch.items);
  if (!items.length) return;
  const payload = wakePayload(items);
  const target = { webhook: batch.webhook, command: batch.command };
  await deliver(target, payload);
}
async function deliver(target, payload) {
  if (target.webhook?.url) {
    const posted = await postWebhook(target.webhook, payload);
    if (posted.ok || !target.command?.length) return posted;
    const ran = await runCommand(target.command, payload, target.webhook.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (ran.ok) return ran;
    return { ok: false, how: "webhook", detail: `${posted.detail}; command failed (${ran.detail})` };
  }
  if (target.command?.length) return runCommand(target.command, payload, DEFAULT_TIMEOUT_MS);
  return { ok: false, how: "webhook", detail: "webhook url is invalid" };
}
async function postWebhook(target, payload) {
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets = secretValues(target);
  let host = "webhook";
  try {
    host = new URL(target.url).host || host;
  } catch {
    logFailure("webhook", host, "failed: url is invalid", secrets);
    return { ok: false, how: "webhook", detail: "webhook url is invalid" };
  }
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: webhookHeaders(target),
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      logFailure("webhook", host, `HTTP ${res.status}`, secrets, target.url);
      return { ok: false, how: "webhook", detail: `HTTP ${res.status}`, status: res.status };
    }
    debugLog("wake", `webhook ${host} HTTP ${res.status}`);
    return { ok: true, how: "webhook", status: res.status };
  } catch (err) {
    const detail = scrub(err.name === "TimeoutError" ? "timed out" : err.message, secrets);
    logFailure("webhook", host, `failed: ${detail}`, secrets, target.url);
    return { ok: false, how: "webhook", detail };
  }
}
function runCommand(argv, payload, timeoutMs) {
  const bin = argv[0];
  const name = bin ? path10.basename(bin) : "command";
  if (!bin) {
    logFailure("command", name, "failed: command is empty", []);
    return Promise.resolve({ ok: false, how: "command", detail: "command is empty" });
  }
  return new Promise((resolve) => {
    const child = spawn2(bin, argv.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    const timerId = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timerId);
      const detail = scrub(err.message, []);
      logFailure("command", name, `failed: ${detail}`, []);
      resolve({ ok: false, how: "command", detail });
    });
    child.on("close", (code) => {
      clearTimeout(timerId);
      if (code === 0) {
        debugLog("wake", `command ${name} exited 0`);
        resolve({ ok: true, how: "command", status: 0 });
        return;
      }
      logFailure("command", name, `exited ${code ?? "signal"}`, []);
      resolve({ ok: false, how: "command", detail: `exit ${code ?? "signal"}`, status: code ?? void 0 });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
function notifyWake(peer, message) {
  const target = wakeForPeer(peer);
  if (!target) return void 0;
  if (target.webhook?.url) {
    try {
      void new URL(target.webhook.url);
    } catch {
      return { ok: false, how: "webhook", detail: "webhook url is invalid" };
    }
  }
  const key = batchKey(target);
  const file = batchPath(key);
  try {
    withLockSync(() => {
      const batch = readJson(file) ?? {
        items: [],
        firstAtMs: Date.now(),
        lastAtMs: Date.now(),
        webhook: target.webhook,
        command: target.command
      };
      if (!batch.items.some((item) => item.id === message.id)) {
        batch.items.push({ id: message.id, peerId: message.to.id, from: message.from.address, at: message.sentAt });
      }
      batch.lastAtMs = Date.now();
      batch.webhook = target.webhook;
      batch.command = target.command;
      writeJsonAtomic(file, batch);
    });
  } catch (err) {
    const detail = scrub(err.message, secretValues(target.webhook));
    logFailure(target.webhook?.url ? "webhook" : "command", target.webhook?.url ? hostOf(target.webhook.url) : "command", `failed: ${detail}`, secretValues(target.webhook));
    return { ok: false, how: target.webhook?.url ? "webhook" : "command", detail };
  }
  scheduleFlush();
  return { ok: true, how: target.webhook?.url ? "webhook" : "command", scheduled: true };
}
function cancelWake(peerId2, messageId) {
  let result = "absent";
  for (const file of listBatches()) {
    withLockSync(() => {
      const batch = readJson(file);
      if (!batch) return;
      const next = batch.items.filter((item) => !(item.id === messageId && item.peerId === peerId2));
      if (next.length === batch.items.length) return;
      result = "cancelled";
      if (!next.length) {
        try {
          fs10.unlinkSync(file);
        } catch {
        }
        return;
      }
      writeJsonAtomic(file, { ...batch, items: next });
    });
  }
  return result;
}

// src/core/confirm.ts
function confirmWaitEnabled() {
  const v = process.env.TELEPATHY_CONFIRM_WAIT;
  return v !== "0" && v !== "false";
}
function confirmAbortMs() {
  return envDurationMs("TELEPATHY_CONFIRM_ABORT_MS", 1e5);
}
var toolCallStartedAt;
function beginToolCall(at = Date.now()) {
  if (toolCallStartedAt !== void 0) return false;
  toolCallStartedAt = at;
  return true;
}
function endToolCall() {
  toolCallStartedAt = void 0;
}
function confirmWindow(now = Date.now()) {
  const abort = confirmAbortMs();
  const grace = confirmGraceMs();
  if (toolCallStartedAt === void 0) return { abort, grace };
  const deadline = toolCallStartedAt + abort + grace;
  const left = Math.max(0, deadline - now);
  const graceMs = Math.min(grace, left);
  return { abort: left - graceMs, grace: graceMs, deadline };
}
function confirmGraceMs() {
  return envDurationMs("TELEPATHY_CONFIRM_GRACE_MS", 1e4);
}
function confirmPollMs() {
  return Math.max(15, envDurationMs("TELEPATHY_CONFIRM_POLL_MS", 200));
}
var FULL_READ = 32 * 1024 * 1024;
var TAIL_READ = 4 * 1024 * 1024;
function hostedTranscript(peer, marker) {
  const file = path11.join(peerDir(peer.id), "delivery-transcript.jsonl");
  if (!fs11.existsSync(file)) return void 0;
  return { located: true, found: fileHas(file, marker) };
}
function inspectTranscript(peer, marker) {
  const hosted = hostedTranscript(peer, marker);
  if (hosted?.found) return hosted;
  const harness = inspectHarnessTranscript(peer, marker);
  if (harness.found || !hosted) return harness;
  return hosted;
}
function inspectHarnessTranscript(peer, marker) {
  const harness = searchHarnessTranscript(peer, marker);
  const extra = configuredEnv("TELEPATHY_TRANSCRIPT_DIR");
  if (!extra) return harness;
  const extraFound = fs11.existsSync(extra) && treeHas(extra, marker, 4);
  if (extraFound) return { located: true, found: true };
  if (harness.found) return harness;
  return { located: harness.located || fs11.existsSync(extra), found: false };
}
function searchHarnessTranscript(peer, marker) {
  if (peer.agent === "claude") return claudeTranscript(peer, marker);
  if (peer.agent === "codex") return codexTranscript(peer, marker);
  if (peer.agent === "opencode" || peer.agent === "kilo") return opencodeTranscript(marker);
  if (peer.agent === "antigravity") return antigravityTranscript(peer, marker);
  if (peer.agent === "copilot" && peer.sessionId) return copilotTranscript(peer, marker);
  return { located: false, found: false };
}
function copilotTranscript(peer, marker) {
  const files = /* @__PURE__ */ new Set();
  const recorded2 = readSession(peer.id)?.transcriptPath;
  if (recorded2 && !UNEXPANDED_PATH.test(recorded2)) files.add(recorded2);
  if (peer.sessionId) files.add(copilotEventsFile(peer.sessionId));
  const existing = [...files].filter((file) => fs11.existsSync(file));
  if (!existing.length) return { located: false, found: false };
  return { located: true, found: existing.some((file) => copilotLogHasMarker(file, marker)) };
}
function claudeTranscript(peer, marker) {
  if (!peer.sessionId) return { located: false, found: false };
  const projects = path11.join(claudeConfigDir(), "projects");
  const name = `${peer.sessionId}.jsonl`;
  const files = /* @__PURE__ */ new Set();
  if (peer.cwd) {
    const slug = peer.cwd.replace(/[^A-Za-z0-9]/g, "-").slice(0, 200);
    files.add(path11.join(projects, slug, name));
  }
  if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CODE_PROJECT_DIR_NAME) {
    files.add(path11.join(projects, process.env.CLAUDE_CODE_PROJECT_DIR_NAME, name));
  }
  try {
    for (const dir of fs11.readdirSync(projects).slice(0, 80)) {
      files.add(path11.join(projects, dir, name));
    }
  } catch {
  }
  const existing = [...files].filter((file) => fs11.existsSync(file));
  if (!existing.length) return { located: false, found: false };
  return { located: true, found: existing.some((file) => fileHas(file, marker)) };
}
function codexTranscript(peer, marker) {
  if (!peer.sessionId) return { located: false, found: false };
  const home = peer.codexHome || process.env.CODEX_HOME || path11.join(os6.homedir(), ".codex");
  const file = findRollout(home, peer.sessionId);
  if (!file) return { located: false, found: false };
  return { located: true, found: fileHas(file, marker) };
}
function opencodeTranscript(marker) {
  const xdg = process.env.XDG_DATA_HOME || path11.join(os6.homedir(), ".local", "share");
  const db = process.env.OPENCODE_DB || path11.join(xdg, "opencode", "opencode.db");
  const files = [db, `${db}-wal`];
  const legacy = path11.join(xdg, "opencode", "storage");
  const existing = files.filter((file) => fs11.existsSync(file));
  const inDb = existing.some((file) => fileHas(file, marker));
  if (inDb) return { located: true, found: true };
  if (fs11.existsSync(legacy) && treeHas(legacy, marker, 5)) return { located: true, found: true };
  if (existing.length || fs11.existsSync(legacy)) return { located: true, found: false };
  return { located: false, found: false };
}
function antigravityTranscript(peer, marker) {
  const files = [];
  const recorded2 = readSession(peer.id)?.transcriptPath;
  if (recorded2 && !UNEXPANDED_PATH.test(recorded2)) files.push(recorded2);
  if (peer.sessionId) {
    const root = path11.join(os6.homedir(), ".gemini");
    for (const dir of ["antigravity-cli", "antigravity-ide", "antigravity"]) {
      files.push(path11.join(root, dir, "brain", peer.sessionId, ".system_generated", "logs", "transcript.jsonl"));
    }
  }
  const existing = [...new Set(files)].filter((file) => fs11.existsSync(file));
  if (!existing.length) return { located: false, found: false };
  return { located: true, found: existing.some((file) => fileHas(file, marker)) };
}
var UNEXPANDED_PATH = /^\$\{[^}]+\}$/;
function treeHas(dir, marker, depth) {
  if (depth < 0) return false;
  let names;
  try {
    names = fs11.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (name === "node_modules") continue;
    const file = path11.join(dir, name);
    let st;
    try {
      st = fs11.statSync(file);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (treeHas(file, marker, depth - 1)) return true;
    } else if (st.isFile() && fileHas(file, marker)) return true;
  }
  return false;
}
function readTranscriptText(file) {
  let fd;
  try {
    const st = fs11.statSync(file);
    if (!st.isFile() || st.size === 0) return void 0;
    fd = fs11.openSync(file, "r");
    const start = st.size <= FULL_READ ? 0 : Math.max(0, st.size - TAIL_READ);
    const buf = Buffer.alloc(st.size - start);
    fs11.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch {
    return void 0;
  } finally {
    if (fd !== void 0) fs11.closeSync(fd);
  }
}
function fileHas(file, marker) {
  return readTranscriptText(file)?.includes(marker) ?? false;
}
var COPILOT_DELIVERY_EVENTS = /* @__PURE__ */ new Set(["user.message", "userPromptSubmitted"]);
function copilotEventNames(record) {
  if (!record || typeof record !== "object") return [];
  const body = record;
  const names = [];
  const push = (value) => {
    if (typeof value === "string" && value) names.push(value);
  };
  for (const key of ["type", "event", "name"]) push(body[key]);
  const data = body.data;
  if (data && typeof data === "object") {
    const nested = data;
    for (const key of ["type", "event", "hook", "hookEventName", "hookType"]) push(nested[key]);
  }
  return names;
}
function copilotLogHasMarker(file, marker) {
  const text = readTranscriptText(file);
  if (!text || !text.includes(marker)) return false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.includes(marker)) continue;
    try {
      if (copilotEventNames(JSON.parse(trimmed)).some((name) => COPILOT_DELIVERY_EVENTS.has(name))) return true;
    } catch {
    }
  }
  return false;
}
function withdrawPending(peerId2, messageId) {
  return withdrawEverywhere(peerId2, messageId);
}
function storedMessage(peerId2, messageId) {
  for (const dir of [inboxDir(peerId2), archiveDir(peerId2), withdrawnDir(peerId2)]) {
    const msg = readJson(path11.join(dir, `${messageId}.json`));
    if (msg) return msg;
  }
  return void 0;
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var CONFIRM_QUEUE_DELETE_MS = 2e3;
async function untilMarker(peer, marker, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const step = confirmPollMs();
  let located = false;
  for (; ; ) {
    const look = inspectTranscript(peer, marker);
    if (look.found) return { kind: "found" };
    located = look.located;
    if (!isPeerAlive(peer)) return { kind: "offline" };
    const left = deadline - Date.now();
    if (left <= 0) return { kind: "timeout", located };
    await sleep(Math.min(step, left));
  }
}
var UNRECALLABLE = /cannot be recalled/i;
function scrubSignal(text) {
  return text.replace(/Message delivered to /g, "Unconfirmed handoff to ").replace(/Message stored for /g, "Unconfirmed handoff to ").replace(
    "It stays in the inbox for the next prompt, or until the session calls read_messages.",
    "The inbox copy was withdrawn, so the next prompt will not see it."
  ).replace(
    "It stays in the inbox until the session calls read_messages.",
    "The inbox copy was withdrawn, so a later read will not see it."
  ).replace("The inbox copy can still be withdrawn.", "The inbox copy was withdrawn.").replace(/\bstays\b/gi, "was set aside").replace(/\bstored\b/gi, "handed off").replace(/\bdelivered\b/gi, "handed off");
}
function dedupeSentences(text) {
  const kept = [];
  for (const part of text.split(/(?<=\.)\s+/)) {
    const sentence = part.trim();
    if (!sentence) continue;
    const body = sentence.replace(/\.+$/, "");
    const overlap = kept.findIndex((prev) => {
      const prevBody = prev.replace(/\.+$/, "");
      return prevBody === body || prevBody.startsWith(body) || body.startsWith(prevBody);
    });
    if (overlap === -1) kept.push(sentence);
    else if (body.length > kept[overlap].replace(/\.+$/, "").length) kept[overlap] = sentence;
  }
  return kept.join(" ");
}
function withoutOverlap(notes, said) {
  const bodies = said.split(/(?<=\.)\s+/).map((sentence) => sentence.trim().replace(/\.+$/, "")).filter(Boolean);
  return notes.filter((note) => {
    const body = note.trim().replace(/\.+$/, "");
    return !bodies.some((prev) => prev === body || body.startsWith(prev) || prev.startsWith(body));
  });
}
async function retract(peer, messageId, routeStatus, deleteMs) {
  const stored = storedMessage(peer.id, messageId);
  const withdrawn = withdrawPending(peer.id, messageId);
  const signal = UNRECALLABLE.test(routeStatus) ? routeStatus : scrubSignal(routeStatus);
  const notes = [];
  const noted = signal !== routeStatus && /was withdrawn/i.test(signal);
  if (withdrawn === "withdrawn" && !noted && !UNRECALLABLE.test(routeStatus)) {
    notes.push("The inbox copy was withdrawn so a later turn cannot pick it up.");
  }
  if (withdrawn === "claimed") notes.push("The inbox copy was already claimed, which is not proof the model saw it.");
  const queueId = stored?.codexQueueId;
  const thread = stored?.codexThreadId ?? peer.sessionId;
  if (peer.agent === "codex" && queueId && thread) {
    if (deleteMs <= 0) {
      notes.push("The Codex queue item could not be removed in the time left.");
    } else {
      const removed = await deleteFromCodexQueue(thread, [queueId], peer.codexHome, deleteMs);
      if (!removed) notes.push("The Codex queue item could not be removed because the app-server was unreachable.");
      else if (removed.get(queueId) === false) notes.push("Codex had already taken the queue item, so it could not be removed.");
      else notes.push("The Codex queue item was removed.");
    }
  }
  const wake = cancelWake(peer.id, messageId);
  if (/webhook|delivery command/i.test(routeStatus)) {
    notes.push(
      wake === "cancelled" ? "The pending wake was cancelled before it was sent." : "A wake that already left cannot be recalled; its body has no message text."
    );
  }
  return { withdrawn, signal, notes };
}
function failureStatus(peer, marker, routeStatus, reason, retracted, located) {
  const extra = retracted.notes.length ? ` ${retracted.notes.join(" ")}` : "";
  if (UNRECALLABLE.test(routeStatus)) {
    const where2 = located ? "A transcript file was found and does not contain the marker, so delivery is unconfirmed." : "No transcript file was found for this session, so delivery is unconfirmed.";
    return `${routeStatus} ${where2}${extra}`;
  }
  if (reason === "offline") {
    const copy = retracted.withdrawn === "withdrawn" ? "The inbox copy was withdrawn." : "Nothing was left in its inbox.";
    const rest = withoutOverlap(retracted.notes, copy);
    const tail = rest.length ? ` ${rest.join(" ")}` : "";
    return `Message failed: ${peerRef(peer)} is offline (session not running). ${copy}${tail}`;
  }
  const where = located ? "A transcript file was found and does not contain the marker, so delivery is unconfirmed." : "No transcript file was found for this session, so delivery is unconfirmed.";
  return `Message failed: ${peerRef(peer)} did not show ${marker} in its transcript before the wait ended. ${where} Strongest signal: ${retracted.signal}${extra}`;
}
async function confirmDelivery(peer, message, routeStatus) {
  const marker = messageMarker(message.id);
  const delivered = `Message delivered to ${peerRef(peer)}. The transcript shows ${marker}.`;
  const plan = confirmWindow();
  const deleteBudget = () => plan.deadline === void 0 ? CONFIRM_QUEUE_DELETE_MS : Math.min(CONFIRM_QUEUE_DELETE_MS, Math.max(0, plan.deadline - Date.now()));
  let retracted;
  const fail = async (reason, located = false) => {
    if (reason === "offline") notePeerExit(peer.id);
    retracted ??= await retract(peer, message.id, routeStatus, deleteBudget());
    const status = failureStatus(peer, marker, routeStatus, reason, retracted, located);
    const text = UNRECALLABLE.test(routeStatus) ? status : scrubSignal(status);
    return { confirmed: false, status: dedupeSentences(text) };
  };
  if (!UNRECALLABLE.test(routeStatus) && !isPeerAlive(peer)) return fail("offline");
  const first = await untilMarker(peer, marker, plan.abort);
  if (first.kind === "found") {
    archiveSettled(peer.id, message.id);
    return { confirmed: true, status: delivered };
  }
  if (first.kind === "offline") return fail("offline");
  retracted = await retract(peer, message.id, routeStatus, deleteBudget());
  const graceMs = plan.deadline === void 0 ? plan.grace : Math.max(0, plan.deadline - Date.now());
  const second = await untilMarker(peer, marker, graceMs);
  if (second.kind === "found") {
    archiveSettled(peer.id, message.id);
    return { confirmed: true, status: delivered };
  }
  if (second.kind === "offline") return fail("offline");
  return fail("unconfirmed", second.located);
}

// src/core/claude-socket.ts
var SOCKET_LINE_MAX = 1024 * 1024;
var INBOUND_RANK = { accept: 0, hold: 1, refuse: 2 };
var socketFile = (id) => path12.join(peerDir(id), "socket.json");
var listenerFile = (id) => path12.join(peerDir(id), "socket-listener.json");
function readClaudeSocket(id) {
  const record = readJson(socketFile(id));
  if (!record?.path) return void 0;
  if (typeof record.ownerPid === "number") {
    const owners = sessionOwners(id);
    if (owners.length > 0 && owners[0]?.pid !== record.ownerPid) return void 0;
  }
  return { path: record.path, ...record.token ? { token: record.token } : {} };
}
function claudeSocketArmed(id) {
  const record = readJson(listenerFile(id));
  return !!record && isSameProcess(record.pid, record.procStart);
}
function readInbound(file) {
  const value = readJson(file)?.crossSessionInbound;
  if (value === "accept" || value === "hold" || value === "refuse") return value;
  return void 0;
}
function managedSettingsDir() {
  if (process.env.TELEPATHY_MANAGED_SETTINGS_DIR) return process.env.TELEPATHY_MANAGED_SETTINGS_DIR;
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (process.platform === "win32") return path12.join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode");
  return "/etc/claude-code";
}
function managedInbound() {
  const dir = managedSettingsDir();
  let found = readInbound(path12.join(dir, "managed-settings.json"));
  let names = [];
  try {
    names = fs12.readdirSync(path12.join(dir, "managed-settings.d")).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  } catch {
  }
  for (const name of names) {
    const value = readInbound(path12.join(dir, "managed-settings.d", name));
    if (value) found = value;
  }
  return found;
}
function crossSessionInbound(peer) {
  const managed = managedInbound();
  const user = readInbound(path12.join(claudeConfigDir(), "settings.json"));
  const higher = managed ?? user;
  const project = peer?.cwd ? readInbound(path12.join(peer.cwd, ".claude", "settings.json")) : void 0;
  const local = peer?.cwd ? readInbound(path12.join(peer.cwd, ".claude", "settings.local.json")) : void 0;
  let effective = higher;
  for (const value of [project, local]) {
    if (!value) continue;
    if (higher === void 0 || INBOUND_RANK[value] > INBOUND_RANK[higher]) effective = value;
  }
  return effective;
}
var flushImpl;
async function flushClaudeSocket(id) {
  if (flushImpl) return flushImpl(id);
  return "idle";
}

// src/core/status.ts
import path13 from "node:path";
var OWN_SOURCE = ["claude", "codex", "opencode", "kilo"];
var statusFromHooks = (agent) => !OWN_SOURCE.includes(agent);
var statusFile = (id) => path13.join(peerDir(id), "status.json");
function recorded(id) {
  const record = readJson(statusFile(id));
  const at = record ? Date.parse(record.at) : Number.NaN;
  return record && typeof record.status === "string" && !Number.isNaN(at) ? { status: record.status, at } : void 0;
}
var CLAUDE_STATUSES = ["busy", "shell", "idle", "waiting"];
function claudeStatus(pid) {
  const record = readJson(path13.join(claudeConfigDir(), "sessions", `${pid}.json`));
  if (typeof record?.status !== "string" || !CLAUDE_STATUSES.includes(record.status)) return void 0;
  let status = record.status;
  if (status === "shell" && shellIsTelepathyMonitorOnly(descendantCommands(pid))) status = "idle";
  return { status, at: typeof record.statusUpdatedAt === "number" ? record.statusUpdatedAt : void 0 };
}
var TELEPATHY_PROCESS = /(?:^|[\s/])(?:monitor|server|hook)\.mjs\b/;
function transientChildMs() {
  return envDurationMs("TELEPATHY_TRANSIENT_CHILD_MS", 2e3);
}
function ignoredShellChild(command, ageMs) {
  const token = command.trim().split(/\s+/)[0] ?? "";
  const base = token.replace(/^["']|["']$/g, "").split(/[/\\]/).pop() ?? "";
  if (base === "ps" || base === "(ps)") return true;
  if (TELEPATHY_PROCESS.test(command) && /--agent(?:\s|=)/.test(command)) return false;
  return ageMs !== void 0 && ageMs >= 0 && ageMs < transientChildMs();
}
function processAgeMs(start) {
  if (!start) return void 0;
  const at = Date.parse(start);
  if (Number.isNaN(at)) return void 0;
  return Date.now() - at;
}
function shellIsTelepathyMonitorOnly(commands) {
  let monitor = false;
  for (const command of commands) {
    if (TELEPATHY_PROCESS.test(command) && /--agent(?:\s|=)/.test(command)) {
      if (/monitor\.mjs/.test(command)) monitor = true;
      continue;
    }
    return false;
  }
  return monitor;
}
function descendantCommands(rootPid) {
  const table = processTable(0);
  const byParent = /* @__PURE__ */ new Map();
  for (const info of table.values()) {
    const kids = byParent.get(info.ppid);
    if (kids) kids.push(info.pid);
    else byParent.set(info.ppid, [info.pid]);
  }
  const commands = [];
  const stack = [...byParent.get(rootPid) ?? []];
  const seen = /* @__PURE__ */ new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (pid === void 0 || seen.has(pid)) continue;
    seen.add(pid);
    const info = table.get(pid);
    const args = commandLine(pid) ?? info?.comm;
    if (args && !ignoredShellChild(args, processAgeMs(info?.start))) commands.push(args);
    for (const child of byParent.get(pid) ?? []) stack.push(child);
  }
  return commands;
}
function codexStatus(peer) {
  if (!peer.codexHome || !peer.sessionId) return void 0;
  const activity = codexActivity(peer.codexHome, peer.sessionId);
  const hook = recorded(peer.id);
  if (hook?.status === "waiting" && activity !== "idle" && activity !== "interrupted") {
    const lastResponse = codexLastResponse(peer.codexHome, peer.sessionId);
    if (lastResponse === void 0 || lastResponse <= (hook.at ?? 0)) return hook;
  }
  return activity ? { status: activity } : void 0;
}
function peerStatus(peer) {
  if (peer.agent === "claude") return claudeStatus(peer.pid);
  if (peer.agent === "codex") return codexStatus(peer);
  const info = recorded(peer.id);
  return info && { ...info, fromHooks: statusFromHooks(peer.agent) };
}
var STALE_MS = 15 * 6e4;
var stale = (info, now) => info.fromHooks && info.at !== void 0 && now - info.at > STALE_MS ? `? (no activity for ${Math.round((now - info.at) / 6e4)}m)` : "";
function statusText(info, now = Date.now()) {
  if (!info) return void 0;
  switch (info.status) {
    case "waiting":
      return `waiting on a permission prompt for its user${stale(info, now)}`;
    case "shell":
      return "shell (not generating, but a command it started is still running)";
    case "interrupted":
      return "interrupted: a send fails until its user prompts it";
    case "busy":
      return `busy${stale(info, now)}`;
    default:
      return info.status;
  }
}

// src/core/deliver.ts
import crypto3 from "node:crypto";
import fs13 from "node:fs";
import path14 from "node:path";
var DUPLICATE_WINDOW_MS = 2 * 6e4;
var RATE_WINDOW_MS = 10 * 6e4;
var RATE_MAX_PER_RECIPIENT = 20;
function socketWaitMs() {
  return envDurationMs("TELEPATHY_SOCKET_WAIT_MS", 1500);
}
var sentLogFile = (selfId) => path14.join(peerDir(selfId), "sent-log.json");
function checkRate(selfId, toId, body) {
  const now = Date.now();
  const log = (readJson(sentLogFile(selfId)) ?? []).filter((e) => now - e.at < RATE_WINDOW_MS);
  const hash = crypto3.createHash("sha256").update(body).digest("hex").slice(0, 16);
  const dup = log.find((e) => e.to === toId && e.hash === hash && now - e.at < DUPLICATE_WINDOW_MS);
  if (dup) {
    return `The same message was already sent to ${toId} ${Math.round((now - dup.at) / 1e3)}s ago. Don't resend; a reply will arrive as a new message.`;
  }
  if (log.filter((e) => e.to === toId).length >= RATE_MAX_PER_RECIPIENT) {
    return `Rate limit: ${RATE_MAX_PER_RECIPIENT} messages to ${toId} in the last ${RATE_WINDOW_MS / 6e4} minutes. Batch what's left into one message or wait.`;
  }
  return void 0;
}
function recordSent(selfId, toId, body) {
  const now = Date.now();
  const log = (readJson(sentLogFile(selfId)) ?? []).filter((e) => now - e.at < RATE_WINDOW_MS);
  log.push({ to: toId, hash: crypto3.createHash("sha256").update(body).digest("hex").slice(0, 16), at: now });
  writeJsonAtomic(sentLogFile(selfId), log);
}
var stillPending = (peerId2, messageId) => fs13.existsSync(path14.join(inboxDir(peerId2), `${messageId}.json`));
function bodyProblem(body) {
  if (!body.trim()) return "Message is empty.";
  if (body.length > MAX_MESSAGE_CHARS) {
    return `Message is ${body.length} characters; the limit is ${MAX_MESSAGE_CHARS}. Write the content to a file and send its path instead.`;
  }
  return void 0;
}
async function sendMessage(self, to, body) {
  const ownsClock = beginToolCall();
  try {
    const problem = bodyProblem(body);
    if (problem) return { ok: false, error: problem };
    const remote = remoteTarget(to);
    if (remote) return await sendRemote(self, remote, body);
    return await deliverLocal(partyOf(self), to, body, self);
  } finally {
    if (ownsClock) endToolCall();
  }
}
async function deliverLocal(from, to, body, self, extra = {}) {
  const peers = listPeers().filter((p) => p.id !== self?.id);
  let resolved = resolvePeer(to, peers);
  if ("error" in resolved) {
    const selfMatch = self ? resolvePeer(to, [self]) : void 0;
    if (selfMatch && "peer" in selfMatch) return { ok: false, error: `"${to}" is this session itself.` };
    if (/ (?:matches|is a prefix of) \d+ sessions: /.test(resolved.error)) return { ok: false, error: resolved.error };
    const offline = resolvePeer(to, keptPeers().filter((p) => p.id !== self?.id));
    if ("peer" in offline) resolved = offline;
    else return { ok: false, error: resolved.error };
  }
  const recipient = resolved.peer;
  const limited = self ? checkRate(self.id, recipient.id, body) : void 0;
  if (limited) return { ok: false, error: limited };
  const plan = confirmWindow();
  const message = {
    id: newMessageId(),
    from,
    to: partyOf(recipient),
    body,
    ...extra,
    sentAt: (/* @__PURE__ */ new Date()).toISOString(),
    deliverBy: plan.deadline ?? Date.now() + plan.abort + plan.grace
  };
  if (recipient.agent === "codex" && !recipient.sessionId) {
    return {
      ok: false,
      error: `Message failed: ${peerRef(recipient)} has no thread yet; prompt it once.`
    };
  }
  if (!isPeerAlive(recipient)) {
    notePeerExit(recipient.id);
    return {
      ok: false,
      error: `Message failed: ${peerRef(recipient)} is offline (session not running). Nothing was left in its inbox.`
    };
  }
  if (recipient.agent === "codex" && peerStatus(recipient)?.status === "interrupted") {
    return {
      ok: false,
      error: `Message failed: ${peerRef(recipient)} is interrupted, so its queue will not run this. Nothing was left for a later prompt.`
    };
  }
  const delivery = await routeDelivery(recipient, message);
  if (!confirmWaitEnabled()) {
    if (self) recordSent(self.id, recipient.id, body);
    return { ok: true, message, recipient, status: delivery.status, delivery: delivery.report };
  }
  const proof = await confirmDelivery(recipient, message, delivery.status);
  if (!proof.confirmed) return { ok: false, error: proof.status };
  if (self) recordSent(self.id, recipient.id, body);
  return {
    ok: true,
    message,
    recipient,
    status: proof.status,
    delivery: { ...delivery.report, confirmed: true }
  };
}
async function routeDelivery(recipient, message) {
  if (fs13.existsSync(path14.join(peerDir(recipient.id), "hosted.json"))) return routeInbox(recipient, message);
  if (recipient.agent === "codex") return routeCodex(recipient, message);
  return routeInbox(recipient, message);
}
async function routeCodex(recipient, message) {
  const activity = peerStatus(recipient)?.status;
  const attempts = [];
  if (activity === "busy" && recipient.toolHookRan) {
    attempts.push({ id: "codex-mid-turn", result: "armed", when: "mid-turn" });
  } else {
    attempts.push({ id: "codex-mid-turn", result: "unsupported", when: "mid-turn" });
  }
  if (activity === "interrupted") {
    attempts.push({ id: "codex-queue", result: "unsupported", when: "turn-end", detail: "paused after interrupt" });
    return {
      status: `Message failed: ${peerRef(recipient)} is interrupted, so its queue will not run this. Nothing was left for a later prompt.`,
      report: { confirmed: false, attempts }
    };
  }
  let codexQueueId;
  try {
    codexQueueId = await queueIntoCodex(recipient.sessionId, formatAsUserTurn(message), recipient.codexHome);
  } catch (err) {
    const detail = err.message;
    attempts.push({ id: "codex-queue", result: "failed", when: activity === "busy" ? "turn-end" : "idle", detail });
    writeToInbox(message);
    attempts.push(inboxRung(recipient));
    return {
      status: `${codexHeldStatus(recipient, detail)}`,
      report: { confirmed: false, attempts }
    };
  }
  if (codexQueueId) writeToInbox({ ...message, codexQueueId, codexThreadId: recipient.sessionId });
  else archiveMessage(message);
  const when = activity === "busy" || activity === "waiting" ? "turn-end" : "idle";
  attempts.push({ id: "codex-queue", result: "armed", when });
  return { status: codexQueueStatus(recipient), report: { confirmed: false, attempts } };
}
async function routeInbox(recipient, message) {
  const attempts = [];
  writeToInbox(message);
  const inbound = recipient.agent === "claude" ? crossSessionInbound(recipient) : void 0;
  const inboundBlocks = inbound === "hold" || inbound === "refuse";
  let socketOutcome;
  if (inboundBlocks) {
    attempts.push({
      id: "claude-socket",
      result: "unsupported",
      when: "immediate",
      detail: `crossSessionInbound is ${inbound}`
    });
  } else if (recipient.agent === "claude" && (readClaudeSocket(recipient.id) || claudeSocketArmed(recipient.id))) {
    socketOutcome = await flushClaudeSocket(recipient.id);
    if (socketOutcome === "idle") await waitForSocket(recipient.id, message.id);
    if (socketOutcome !== "blocked" && !stillPending(recipient.id, message.id)) {
      attempts.push({ id: "claude-socket", result: "confirmed", when: "immediate" });
      return {
        status: `Message delivered to ${peerRef(recipient)} through Claude's inbox socket.`,
        report: { confirmed: true, attempts }
      };
    }
    if (socketOutcome === "blocked") {
      attempts.push({
        id: "claude-socket",
        result: "unsupported",
        when: "immediate",
        detail: "crossSessionInbound is hold or refuse"
      });
    } else if (socketOutcome === "held") {
      withdrawPending(recipient.id, message.id);
      attempts.push({ id: "claude-socket", result: "armed", when: "immediate", detail: "held" });
      return { status: claudeSocketHeldStatus(recipient), report: { confirmed: false, attempts } };
    } else {
      attempts.push({
        id: "claude-socket",
        result: socketOutcome === "failed" ? "failed" : "armed",
        when: "immediate",
        detail: socketOutcome === "idle" ? "not confirmed" : socketOutcome
      });
    }
  } else if (recipient.agent === "claude") {
    attempts.push({ id: "claude-socket", result: "unsupported", when: "immediate" });
  }
  const socketPosted = socketOutcome !== void 0 && socketOutcome !== "blocked";
  if (!inboundBlocks && recipient.hasListener && !socketPosted && !claudeSocketArmed(recipient.id)) {
    attempts.push({ id: "listener", result: "armed", when: "immediate" });
    return { status: inboxStatus(recipient), report: { confirmed: false, attempts } };
  }
  attempts.push({
    id: "listener",
    result: "unsupported",
    when: "immediate",
    detail: recipient.hasListener && socketPosted ? "monitor stands down while the socket watcher is running" : void 0
  });
  const wake = await notifyWake(recipient, message);
  if (wake) attempts.push(wakeAttempt(wake));
  const socketBlockingHooks = socketPosted && (claudeSocketArmed(recipient.id) || !!readClaudeSocket(recipient.id));
  const fallbackPeer = socketBlockingHooks ? { ...recipient, hasListener: false, hookRan: false } : recipient;
  const fallback = inboxRung(fallbackPeer);
  attempts.push(fallback);
  if (inbound === "hold" || inbound === "refuse") {
    return { status: claudeInboundBlockedStatus(recipient, inbound), report: { confirmed: false, attempts } };
  }
  const status = wakeStatus(recipient, inboxStatus(fallbackPeer), wake);
  if (socketOutcome === "blocked") {
    return { status: claudeInboundBlockedStatus(recipient, "hold"), report: { confirmed: false, attempts } };
  }
  return { status, report: { confirmed: false, attempts } };
}
function wakeAttempt(wake) {
  return {
    id: wake.how,
    result: wake.ok ? "armed" : "failed",
    when: "idle",
    detail: wake.ok ? void 0 : wake.detail
  };
}
function seesAtNextTurn(recipient) {
  if (recipient.agent === "copilot") return true;
  return !!agentSpec(recipient.agent).nextTurnHook && !!recipient.hookRan;
}
function inboxRung(recipient) {
  if (seesAtNextTurn(recipient) || recipient.agent === "codex" && recipient.hookRan) {
    return { id: "next-boundary", result: "armed", when: "next-prompt" };
  }
  return { id: "poll", result: "armed", when: "poll" };
}
async function waitForSocket(peerId2, messageId) {
  const deadline = Date.now() + socketWaitMs();
  while (stillPending(peerId2, messageId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function claudeInboundBlockedStatus(recipient, inbound) {
  const why = inbound === "hold" ? "that session is holding peer messages (crossSessionInbound is hold)" : "that session is refusing peer messages (crossSessionInbound is refuse)";
  return `Nothing was posted to ${peerRef(recipient)}: ${why}. The inbox copy can still be withdrawn.`;
}
function claudeSocketHeldStatus(recipient) {
  return `Message not confirmed for ${peerRef(recipient)}. Claude reported the inbox-socket post as held. That copy cannot be recalled and may still be delivered if the hold is released. The inbox copy was withdrawn so a later turn does not also show it.`;
}
var waitingNote = (ref, verb) => `Message ${verb} ${ref}, but it's waiting on a permission prompt for its user, so it gets to your message only after its user answers. Tell your user if it's urgent; don't resend.`;
function codexHeldStatus(recipient, why) {
  const ref = peerRef(recipient);
  const via = recipient.hookRan ? "It stays in the inbox for the next prompt, or until the session calls read_messages." : "It stays in the inbox until the session calls read_messages.";
  return `Message stored for ${ref}. ${why} ${via}`;
}
function codexQueueStatus(recipient) {
  const ref = peerRef(recipient);
  const activity = peerStatus(recipient)?.status;
  if (activity === "waiting") return waitingNote(ref, "queued for");
  if (activity === "busy") {
    if (recipient.toolHookRan) {
      return `Message delivered to ${ref}. It's in the middle of a turn and gets it after its next tool call, or when the turn ends.`;
    }
    return `Message queued for ${ref}. It's in the middle of a turn, so the message is delivered only after that turn ends.`;
  }
  return `Message queued for delivery to ${ref}.`;
}
function inboxStatus(recipient) {
  const ref = peerRef(recipient);
  if (peerStatus(recipient)?.status === "waiting") return waitingNote(ref, recipient.hasListener ? "delivered to" : "stored for");
  if (recipient.hasListener) return `Message delivered to ${ref}.`;
  if (recipient.agent === "grok") {
    return `Message stored for ${ref}. No wait_for_messages call is parked. A Grok Bot session receives it from that call; a Grok Build session receives it at its next turn, or as soon as its telepathy monitor is running.`;
  }
  if (seesAtNextTurn(recipient)) {
    return `Message stored for ${ref}. It can't be woken while idle, so it will see it at its next turn.`;
  }
  return `Message stored for ${ref}. It has no listener, so it will see it only when it calls read_messages.`;
}
function wakeStatus(recipient, base, wake) {
  if (!wake) return base;
  const ref = peerRef(recipient);
  const how = wake.how === "webhook" ? "webhook" : "delivery command";
  if (!wake.ok) return `${base} The ${how} notification failed (${wake.detail}).`;
  if (wake.scheduled) {
    return `A ${how} wake for ${ref} is scheduled. ${base} The ${how} body is a wake, not the message, and must be treated as untrusted.`;
  }
  return `Notified ${ref} by ${how}. ${base} The ${how} body is a wake, not the message, and must be treated as untrusted.`;
}

// src/bridge/crypto.ts
import crypto4 from "node:crypto";
var SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
function seal(key, aad, value, t = Date.now()) {
  const iv = crypto4.randomBytes(12);
  const cipher = crypto4.createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  cipher.setAAD(Buffer.from(`${aad}\0${t}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { t, n: iv.toString("base64"), c: body.toString("base64") };
}
function open(key, aad, sealed) {
  const iv = Buffer.from(String(sealed.n), "base64");
  const data = Buffer.from(String(sealed.c), "base64");
  if (iv.length !== 12 || data.length < 16) throw new Error("bad envelope");
  if (iv.toString("base64") !== sealed.n) throw new Error("bad envelope");
  const decipher = crypto4.createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  decipher.setAAD(Buffer.from(`${aad}\0${sealed.t}`));
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

// src/bridge/state.ts
import crypto5 from "node:crypto";
import fs14 from "node:fs";
import os7 from "node:os";
import path15 from "node:path";
var bridgeDir = () => path15.join(stateDir(), "bridge");
var deviceFile = () => path15.join(bridgeDir(), "device.json");
var trustedFile = () => path15.join(bridgeDir(), "trusted.json");
var remoteFile = () => path15.join(bridgeDir(), "remote.json");
var eventsFile = () => path15.join(bridgeDir(), "events.jsonl");
var onlineWindowMs = () => envDurationMs("TELEPATHY_BRIDGE_ONLINE_MS", 15e3);
function deviceIdentity() {
  const stored = readJson(deviceFile());
  if (stored?.id && stored.name) return stored;
  const identity = { id: crypto5.randomBytes(8).toString("hex"), name: defaultDeviceName() };
  writeSecret(deviceFile(), identity);
  return identity;
}
function defaultDeviceName() {
  const host = os7.hostname().replace(/\.local$/i, "").split(".")[0];
  return slugify(host) || "device";
}
function trustedDevices() {
  return readJson(trustedFile()) ?? {};
}
function writeSecret(file, value) {
  ensureDir(path15.dirname(file));
  writeJsonAtomic(file, value);
  try {
    fs14.chmodSync(file, 384);
  } catch {
  }
}
function readRemoteState() {
  return readJson(remoteFile());
}
var isOnline = (device, now = Date.now()) => now - Date.parse(device.lastSeen) < onlineWindowMs();
function knownDevices() {
  const state = readRemoteState();
  if (!state) return [];
  return state.devices.filter((device) => device.trusted);
}
function safeName(value, fallback = "device", max = 48) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  return text || fallback;
}
function logEvent(event) {
  try {
    ensureDir(bridgeDir());
    fs14.appendFileSync(eventsFile(), JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...event }) + "\n", { mode: 384 });
    const size = fs14.statSync(eventsFile()).size;
    if (size > 512 * 1024) {
      const lines = fs14.readFileSync(eventsFile(), "utf8").trim().split("\n").slice(-500);
      fs14.writeFileSync(eventsFile(), lines.join("\n") + "\n", { mode: 384 });
    }
  } catch {
  }
}
var preview = (body) => safeName(body, "", 160);

// src/bridge/client.ts
var requestAad = (path20, from, to) => `req ${path20} ${from}->${to}`;
var responseAad = (path20, from, to, nonce) => `res ${path20} ${from}->${to} ${nonce}`;
var baseUrl = (addr) => `http://${addr}`;
async function call(target, path20, body, timeoutMs) {
  const self = deviceIdentity();
  const trusted = trustedDevices();
  const key = Object.hasOwn(trusted, target.id) ? trusted[target.id].key : void 0;
  if (!key && target.trust !== "tailscale") throw new Error("this device is not paired with it");
  const wire = { device: self.id, name: self.name };
  if (key) wire.sealed = seal(key, requestAad(path20, self.id, target.id), body);
  else wire.body = body;
  const res = await fetch(`${baseUrl(target.addr)}${path20}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(wire),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const reply = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (reply.error) throw new Error(reply.error);
  if (key) {
    if (!reply.sealed || !wire.sealed) throw new Error("the answer was not sealed");
    return open(key, responseAad(path20, self.id, target.id, wire.sealed.n), reply.sealed);
  }
  return reply.body;
}

// src/bridge/remote.ts
function remoteTarget(to) {
  let query = to.trim().replace(/^["'`]|["'`]$/g, "").trim();
  const bracketed = /\[([^\]]+)\]\s*$/.exec(query);
  if (bracketed) query = bracketed[1].trim();
  const at = query.lastIndexOf("@");
  if (at <= 0 || at === query.length - 1) return void 0;
  return { slug: query.slice(at + 1).trim().toLowerCase(), query: query.slice(0, at).trim() };
}
function findDevice(slug) {
  const devices = knownDevices();
  return devices.find((d) => d.slug === slug) ?? devices.find((d) => d.name.toLowerCase() === slug) ?? devices.find((d) => d.id === slug);
}
var qualify = (value, device) => `${value}@${device.slug}`;
function asPeer(wire, device, qualified) {
  return {
    id: qualified ? qualify(wire.id, device) : wire.id,
    agent: wire.agent,
    pid: 0,
    startedAt: wire.startedAt,
    cwd: wire.cwd,
    name: wire.name,
    address: qualified ? qualify(wire.address, device) : wire.address,
    hasListener: true,
    hasServer: true
  };
}
function remoteListings(now = Date.now()) {
  return knownDevices().map((device) => {
    const online = isOnline(device, now);
    return {
      device,
      online,
      peers: online ? device.peers.map((wire) => ({ peer: asPeer(wire, device, true), status: wire.status, delivery: wire.delivery })) : []
    };
  });
}
function formatRemoteListings(listings, now = Date.now()) {
  if (!listings.length) return [];
  const lines = [];
  for (const { device, online, peers } of listings) {
    const via = device.trust === "tailscale" ? "your tailnet" : `paired, ${device.route === "tailscale" ? "over Tailscale" : "on the local network"}`;
    if (!online) {
      lines.push(`Device ${device.slug} (${via}) is offline, last seen ${formatAgo(now - Date.parse(device.lastSeen))}.`);
      continue;
    }
    lines.push(`On device ${device.slug} (${via}), ${peers.length} session${peers.length === 1 ? "" : "s"}:`);
    for (const { peer, status, delivery } of peers) {
      const notes = [peer.cwd ? `cwd ${peer.cwd}` : "", status ?? "", delivery ?? ""].filter(Boolean);
      lines.push([`- ${peerRef(peer)}`, ...notes].join(" \xB7 "));
    }
  }
  return lines;
}
var marginMs = () => envDurationMs("TELEPATHY_BRIDGE_MARGIN_MS", 1500);
async function sendRemote(self, target, body) {
  const device = findDevice(target.slug);
  if (!device) {
    const known = knownDevices().map((d) => d.slug);
    return {
      ok: false,
      error: `No device named "${target.slug}" is reachable. ` + (known.length ? `Known devices: ${known.join(", ")}.` : "Run `telepathy bridge start` on both devices; devices of your own tailnet appear by themselves, others need `telepathy bridge pair`.")
    };
  }
  if (!isOnline(device)) {
    return {
      ok: false,
      error: `Message failed: device ${device.slug} is offline (its telepathy bridge is not answering). Nothing was sent.`
    };
  }
  const unqualified = device.peers.map((wire) => asPeer(wire, device, false));
  const resolved = resolvePeer(target.query, unqualified);
  if ("error" in resolved && / (?:matches|is a prefix of) \d+ sessions: /.test(resolved.error)) {
    return { ok: false, error: qualifyText(resolved.error, unqualified, device) };
  }
  const to = "peer" in resolved ? resolved.peer.id : target.query;
  const rateKey = `${to}@${device.id}`;
  const limited = checkRate(self.id, rateKey, body);
  if (limited) return { ok: false, error: limited };
  const plan = confirmWindow();
  const deadline = plan.deadline ?? Date.now() + plan.abort + plan.grace;
  const budgetMs = deadline - Date.now() - marginMs();
  if (budgetMs < 2e3) return { ok: false, error: `Message failed: too little of this call's wait is left to reach device ${device.slug}.` };
  const from = partyOf(self);
  let reply;
  try {
    reply = await call(device, "/v1/send", { from, to, body, budgetMs }, budgetMs + marginMs());
  } catch (err) {
    const code = (err.cause ?? {}).code;
    const why = err.name === "TimeoutError" ? "it did not answer before the wait ended" : err.message;
    const error = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN"].includes(code ?? "") ? `Message failed: device ${device.slug} is offline (its telepathy bridge refused the connection). Nothing was sent.` : `Message not confirmed: the bridge on device ${device.slug} failed (${why}). That device withdraws any copy it could not confirm, so a later turn there will not show it.`;
    logEvent({ dir: "out", device: device.slug, from: from.address, to: `${target.query}@${device.slug}`, ok: false, status: error, preview: preview(body) });
    return { ok: false, error };
  }
  const peers = reply.recipient ? [...unqualified, asPeer({ ...reply.recipient }, device, false)] : unqualified;
  const status = qualifyText(reply.ok ? reply.status ?? "Message delivered." : reply.error ?? "Message failed.", peers, device);
  const toAddress = reply.recipient ? qualify(reply.recipient.address, device) : `${target.query}@${device.slug}`;
  logEvent({ dir: "out", device: device.slug, from: from.address, to: toAddress, ok: reply.ok, status, preview: preview(body) });
  if (!reply.ok || !reply.recipient) return { ok: false, error: status };
  recordSent(self.id, rateKey, body);
  const recipient = asPeer(reply.recipient, device, true);
  const toParty = { id: recipient.id, agent: recipient.agent, name: recipient.name, address: recipient.address };
  const message = { id: reply.messageId ?? newMessageId(), from, to: toParty, body, sentAt: (/* @__PURE__ */ new Date()).toISOString() };
  const delivery = { confirmed: true, attempts: [{ id: "bridge", result: "confirmed", when: "immediate", detail: device.slug }] };
  return { ok: true, message, recipient, status, delivery };
}
function qualifyText(text, peers, device) {
  let out = text;
  for (const peer of peers) {
    out = out.split(peerRef(peer)).join(`${qualify(peer.address, device)} [${qualify(peer.id, device)}]`);
  }
  return out;
}

// src/core/listing.ts
function formatAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1e3));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function launchHint(peer) {
  if ((peer.agent === "opencode" || peer.agent === "kilo") && !peer.sessionId) {
    return "no session yet, sees messages at its first prompt";
  }
  if (peer.agent === "codex" && !peer.sessionId) return "no thread yet";
  return void 0;
}
function deliveryHint(peer) {
  const launch = launchHint(peer);
  if (launch) return launch;
  if (peer.agent === "copilot") {
    return peer.hasListener ? "the host delivers messages as they arrive" : "sees messages at its next turn";
  }
  if (peer.agent === "codex" || peer.hasListener) return void 0;
  if (peer.agent === "claude" && readClaudeSocket(peer.id)) {
    const inbound = crossSessionInbound(peer);
    if (inbound !== "hold" && inbound !== "refuse") return "sees messages through its inbox socket";
  }
  if (peer.agent === "grok") {
    return "no listener: Grok Bot receives via wait_for_messages; Grok Build via its monitor or next turn";
  }
  if (agentSpec(peer.agent).nextTurnHook && peer.hookRan) return "sees messages at its next turn";
  return "no listener: it reads messages only via read_messages";
}
function describePeer(peer) {
  const notes = [];
  if (peer.cwd) notes.push(`cwd ${peer.cwd}`);
  const status = statusText(peerStatus(peer));
  if (status) notes.push(status);
  const delivery = deliveryHint(peer);
  if (delivery) notes.push(delivery);
  return [`- ${peerRef(peer)}`, ...notes].join(" \xB7 ");
}
function formatPeerList(self, peers, remote = remoteListings()) {
  const lines = [`This session is ${peerRef(self)}.`];
  const elsewhere = formatRemoteListings(remote);
  const dupes = peers.filter((p) => sameStableName(self, p));
  if (self.stableName && dupes.length) {
    lines.push(
      `${dupes.length + 1} live sessions share the name ${self.agent}:${self.stableName}. Use the [ref] to pick one.`
    );
  }
  if (!peers.length && !elsewhere.length) {
    lines.push(
      "No other sessions with telepathy are running. A session of any supported agent appears here once it starts with the plugin installed."
    );
    return lines.join("\n");
  }
  if (peers.length) {
    lines.push(
      `Reachable sessions (${peers.length}):`,
      ...peers.map((p) => {
        const shared = p.duplicate || sameStableName(self, p) || peers.some((other) => sameStableName(p, other));
        return shared ? `${describePeer(p)} \xB7 duplicate session` : describePeer(p);
      })
    );
  } else {
    lines.push("No other sessions on this device.");
  }
  lines.push(...elsewhere);
  lines.push(
    elsewhere.length ? 'Send with send_message, using the address (e.g. "codex:name", or "codex:name@device" on another device) or the [ref] when names collide.' : 'Send with send_message, using the address (e.g. "codex:name") or the [ref] when names collide.'
  );
  return lines.join("\n");
}

// src/headless/peer.ts
import fs15 from "node:fs";
import path16 from "node:path";
var headlessDir = () => path16.join(stateDir(), "headless");
var headlessRecordPath = (agent, slug) => path16.join(headlessDir(), `${agent}-${slug}.json`);
var headlessLogPath = (agent, slug) => path16.join(headlessDir(), `${agent}-${slug}.log`);
function readHeadlessRecord(agent, slug) {
  return readJson(headlessRecordPath(agent, slug));
}
function writeHeadlessRecord(record) {
  writeJsonAtomic(headlessRecordPath(record.agent, record.slug), record);
}
function writeHosted(peerId2) {
  writeJsonAtomic(path16.join(peerDir(peerId2), "hosted.json"), {
    pid: process.pid,
    procStart: procStart(process.pid)
  });
}
function clearHosted(peerId2) {
  try {
    fs15.rmSync(path16.join(peerDir(peerId2), "hosted.json"), { force: true });
  } catch {
  }
}
function registerHostedPeer(agent, cwd, name) {
  const slug = name ? slugify(name) || `${agent}-headless` : "";
  const sessionId = slug ? `h-${slug}` : `h-pid${process.pid}`;
  const peerId2 = sessionPeerId(agent, process.pid, sessionId);
  registerSession(agent, process.pid, { sessionId, cwd, source: "plugin" });
  if (slug) registerStableName(agent, peerId2, slug);
  registerListener(agent, process.pid, peerId2);
  writeHosted(peerId2);
  const peer = readPeer(peerId2);
  return { peerId: peerId2, slug: slug || sessionId, address: peer?.address ?? `${agent}:${slug || sessionId}` };
}

// src/grokbot/config.ts
import fs16 from "node:fs";
import path17 from "node:path";
var grokbotDir = () => path17.join(stateDir(), "grokbot");
var configPath = (slug) => path17.join(grokbotDir(), `${slug}.json`);
function urlProblem(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a URL.`;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "The webhook URL must be https.";
  if (url.username || url.password) return "The webhook URL must not contain credentials; the key is passed separately.";
  return void 0;
}
function keyProblem(key) {
  if (!key) return "No key was given.";
  if (/\s/.test(key)) return "The key contains whitespace; paste only the key.";
  if (key.length < 16) return "That key is too short to be a routine key.";
  return void 0;
}
function readConfig(slug) {
  const file = configPath(slug);
  try {
    if ((fs16.statSync(file).mode & 63) !== 0) return void 0;
  } catch {
    return void 0;
  }
  const config = readJson(file);
  if (!config || typeof config.url !== "string" || typeof config.key !== "string") return void 0;
  return config;
}
function writeConfig(name, url, key) {
  const slug = slugify(name);
  if (!slug) throw new Error(`"${name}" has no usable characters for a name.`);
  const config = { name, slug, url, key, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeJsonAtomic(configPath(slug), config);
  return config;
}
function removeConfig(slug) {
  const file = configPath(slug);
  if (!fs16.existsSync(file)) return false;
  fs16.rmSync(file, { force: true });
  return true;
}
function listConfigs() {
  let names = [];
  try {
    names = fs16.readdirSync(grokbotDir());
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => readConfig(name.slice(0, -".json".length))).filter((config) => !!config);
}
function looseConfigs() {
  let names = [];
  try {
    names = fs16.readdirSync(grokbotDir());
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!name.endsWith(".json")) return false;
    try {
      return (fs16.statSync(path17.join(grokbotDir(), name)).mode & 63) !== 0;
    } catch {
      return false;
    }
  });
}

// src/grokbot/host.ts
import fs17 from "node:fs";
import os8 from "node:os";
import path18 from "node:path";
import { fileURLToPath } from "node:url";

// src/cli/harnesses.ts
import { execFileSync as execFileSync4 } from "node:child_process";
var REPO = "https://github.com/Winterrks/telepathy";
var OPENCODE_SPEC = `telepathy@git+${REPO}.git`;
var HARNESSES = [
  {
    agent: "claude",
    bins: ["claude"],
    passthroughBin: "claude",
    defaultMode: "acp",
    headless: "claude",
    acp: {
      bin: "claude-agent-acp",
      fallbacks: ["claude-code-acp"],
      args: [],
      adapter: true,
      installHint: "npm install -g @zed-industries/claude-agent-acp"
    },
    install: {
      kind: "commands",
      steps: [
        { cmd: "claude", args: ["plugin", "marketplace", "add", "Winterrks/telepathy"] },
        { cmd: "claude", args: ["plugin", "install", "telepathy@telepathy"] }
      ]
    }
  },
  {
    agent: "codex",
    bins: ["codex"],
    passthroughBin: "codex",
    defaultMode: "acp",
    headless: "codex",
    acp: { bin: "codex-acp", args: [], adapter: true, installHint: "npm install -g @zed-industries/codex-acp" },
    install: {
      kind: "commands",
      steps: [
        { cmd: "codex", args: ["plugin", "marketplace", "add", "Winterrks/telepathy"] },
        { cmd: "codex", args: ["plugin", "add", "telepathy@telepathy"] }
      ]
    }
  },
  {
    agent: "opencode",
    bins: ["opencode"],
    passthroughBin: "opencode",
    defaultMode: "acp",
    headless: "opencode",
    acp: { bin: "opencode", args: ["acp"], adapter: false },
    install: { kind: "commands", steps: [{ cmd: "opencode", args: ["plugin", "add", OPENCODE_SPEC] }] }
  },
  {
    agent: "kilo",
    bins: ["kilo", "kilocode"],
    passthroughBin: "kilo",
    defaultMode: "acp",
    headless: "opencode",
    acp: { bin: "kilo", fallbacks: ["kilocode"], args: ["acp"], adapter: false },
    install: { kind: "kilo-config" }
  },
  {
    agent: "copilot",
    bins: ["copilot"],
    passthroughBin: "copilot",
    defaultMode: "acp",
    headless: "acp",
    acp: { bin: "copilot", args: ["--acp"], adapter: false },
    install: {
      kind: "commands",
      steps: [
        { cmd: "copilot", args: ["plugin", "marketplace", "add", "Winterrks/telepathy"] },
        { cmd: "copilot", args: ["plugin", "install", "telepathy@telepathy"] }
      ]
    }
  },
  {
    agent: "qwen",
    bins: ["qwen"],
    passthroughBin: "qwen",
    defaultMode: "acp",
    headless: "acp",
    deliveryNote: "Qwen Code cannot wake an idle session; a message arrives on the next turn.",
    acp: { bin: "qwen", args: ["--acp"], adapter: false },
    install: {
      kind: "commands",
      steps: [{ cmd: "qwen", args: ["extensions", "install", `${REPO}/archive/refs/heads/main.tar.gz`, "--auto-update"] }]
    }
  },
  {
    agent: "grok",
    bins: ["grok"],
    passthroughBin: "grok",
    defaultMode: "acp",
    acp: { bin: "grok", args: ["agent", "stdio"], adapter: false },
    deliveryNote: "Grok wakes an idle session only after it starts the telepathy monitor, on its first prompt.",
    install: {
      kind: "commands",
      steps: [{ cmd: "grok", args: ["plugin", "install", "Winterrks/telepathy#plugin", "--trust"] }]
    }
  },
  {
    agent: "devin",
    bins: ["devin"],
    passthroughBin: "devin",
    defaultMode: "acp",
    acp: { bin: "devin", args: ["acp"], adapter: false },
    deliveryNote: "Devin cannot wake an idle session; a message arrives on the next turn.",
    install: { kind: "commands", steps: [{ cmd: "devin", args: ["plugins", "install", "Winterrks/telepathy#plugin"] }] }
  },
  {
    agent: "antigravity",
    bins: ["agy", "antigravity"],
    passthroughBin: "agy",
    defaultMode: "acp",
    headless: "antigravity",
    deliveryNote: "Antigravity CLI delivers at the next turn (no idle inject). The App is woken by the telepathy sidecar. The IDE has no idle wake yet.",
    acp: { bin: "antigravity-acp", fallbacks: ["agy_acp_server.par"], args: [], adapter: true },
    install: {
      kind: "commands",
      steps: [{ cmd: "agy", args: ["plugin", "install", `${REPO}/tree/main/antigravity`] }],
      note: "Enables the App sidecar in ~/.gemini/config/config.json. A leftover ~/.gemini/extensions/telepathy is removed so `agy plugin import gemini` does not install telepathy twice."
    }
  },
  {
    agent: "cursor",
    bins: ["cursor-agent"],
    passthroughBin: "cursor-agent",
    defaultMode: "acp",
    acp: { bin: "cursor-agent", args: ["acp"], adapter: false },
    deliveryNote: "Cursor hands a message over after the next tool call; it does not wake an idle session.",
    install: {
      kind: "commands",
      steps: [{ cmd: "cursor-agent", args: ["plugin", "marketplace", "add", REPO] }],
      note: "Then install telepathy from the Marketplace tab of /plugin in the Cursor CLI."
    }
  },
  {
    agent: "kimi",
    bins: ["kimi", "kimi-code"],
    passthroughBin: "kimi",
    defaultMode: "acp",
    acp: { bin: "kimi", fallbacks: ["kimi-code"], args: ["acp"], adapter: false },
    deliveryNote: "Kimi Code cannot wake an idle session; a message arrives on the next turn.",
    install: { kind: "kimi" }
  },
  {
    agent: "hermes",
    bins: ["hermes"],
    passthroughBin: "hermes",
    defaultMode: "passthrough",
    deliveryNote: "Telepathy has no Hermes plugin yet. The process starts, and it will not see messages.",
    install: { kind: "none", instructions: "Telepathy has no Hermes install command yet." }
  },
  {
    agent: "openclaw",
    bins: ["openclaw"],
    passthroughBin: "openclaw",
    defaultMode: "passthrough",
    deliveryNote: "Telepathy has no OpenClaw plugin yet. The process starts, and it will not see messages.",
    install: { kind: "none", instructions: "Telepathy has no OpenClaw install command yet." }
  },
  {
    agent: "pi",
    bins: ["pi"],
    passthroughBin: "pi",
    defaultMode: "passthrough",
    deliveryNote: "Telepathy has no Pi plugin yet. The process starts, and it will not see messages.",
    install: { kind: "none", instructions: "Telepathy has no Pi install command yet." }
  }
];
function onPath(cmd, env = process.env) {
  try {
    execFileSync4(process.platform === "win32" ? "where" : "which", [cmd], { env, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// src/grokbot/host.ts
var debounceMs = () => envDurationMs("TELEPATHY_GROKBOT_DEBOUNCE_MS", 400);
var debounceMaxMs = () => envDurationMs("TELEPATHY_GROKBOT_DEBOUNCE_MAX_MS", 1500);
var postTimeoutMs = () => envDurationMs("TELEPATHY_GROKBOT_TIMEOUT_MS", 2e4);
var BACKOFF_MS = [2e3, 5e3, 15e3, 3e4, 6e4];
var MAX_BATCH = 10;
var MAX_CONTEXT_CHARS = 4e5;
async function postContext(config, context) {
  const start = Date.now();
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
      body: JSON.stringify({ context }),
      redirect: "error",
      signal: AbortSignal.timeout(postTimeoutMs())
    });
    const text = await res.text().catch(() => "");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = void 0;
    }
    const ms = Date.now() - start;
    if (!res.ok) {
      const said = [body?.error, body?.message].find((v) => typeof v === "string" && !!v.trim());
      const hint = res.headers.get("x-automation-failure-hint");
      const detail = [`HTTP ${res.status}`, said, hint ? `hint ${hint}` : ""].filter(Boolean).join(": ");
      return { ok: false, status: res.status, detail: scrub2(detail, config.key), ms };
    }
    return { ok: true, status: res.status, runId: typeof body?.runUuid === "string" ? body.runUuid : void 0, ms };
  } catch (err) {
    const e = err;
    const detail = e.name === "TimeoutError" ? `timed out after ${Math.round(postTimeoutMs() / 1e3)}s` : e.message;
    return { ok: false, detail: scrub2(detail, config.key), ms: Date.now() - start };
  }
}
var scrub2 = (text, key) => (key.length >= 4 ? text.split(key).join("[key]") : text).slice(0, 300);
function grokbotArgv() {
  const here = path18.dirname(fileURLToPath(import.meta.url));
  for (const file of [path18.join(here, "grokbot.mjs"), path18.join(here, "..", "grokbot-main.ts")]) {
    if (fs17.existsSync(file)) return [process.execPath, ...process.execArgv, file];
  }
  return [process.execPath, ...process.execArgv, process.argv[1] ?? "", "grokbot"];
}
var shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
function takeLock(slug) {
  const file = path18.join(ensureDir(grokbotDir()), `${slug}.lock`);
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs17.writeFileSync(file, JSON.stringify({ pid: process.pid, procStart: procStart(process.pid) }), { flag: "wx", mode: 384 });
      return () => {
        try {
          const held = JSON.parse(fs17.readFileSync(file, "utf8"));
          if (held.pid === process.pid) fs17.rmSync(file, { force: true });
        } catch {
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") return void 0;
      let held = {};
      try {
        held = JSON.parse(fs17.readFileSync(file, "utf8"));
      } catch {
        return void 0;
      }
      if (typeof held.pid === "number" && isSameProcess(held.pid, held.procStart)) return void 0;
      fs17.rmSync(file, { force: true });
    }
  }
  return void 0;
}
function cliCommand() {
  if (onPath("telepathy")) return "telepathy grokbot";
  return grokbotArgv().map((arg, i) => i === grokbotArgv().length - 1 && arg === "grokbot" ? arg : `"${arg}"`).join(" ");
}
function contextFor(config, messages, cli = cliCommand()) {
  const host = os8.hostname().replace(/\.local$/, "");
  const send = `${cli} send ${config.slug}`;
  const note = noteTag(
    "wake",
    `telepathy on ${host}: ${messages.length === 1 ? "a message" : `${messages.length} messages`} for you (grok:${config.slug}). To answer, run on ${host}: ${send} <address> '<reply>'. \`${cli} peers ${config.slug}\` lists the sessions there. Replies reach that session as a new turn; don't wait or poll.`
  );
  const turns = messages.map(
    (msg) => formatAsUserTurn(msg, `To reply, run on ${host}: ${send} ${shellQuote(msg.from.address)} '<reply>'.`)
  );
  return [note, ...turns].join("\n\n");
}
function appendTranscript(peerId2, text) {
  const file = path18.join(ensureDir(peerDir(peerId2)), "delivery-transcript.jsonl");
  fs17.appendFileSync(file, JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), text }) + "\n");
}
async function runGrokbotHost(slug) {
  const initial = readConfig(slug);
  if (!initial) {
    process.stderr.write(`telepathy: no Grok Bot named ${slug} is connected (or its file is not mode 600).
`);
    return 1;
  }
  const unlock = takeLock(slug);
  if (!unlock) {
    const previous = readHeadlessRecord("grok", slug);
    process.stderr.write(`telepathy: grok:${slug} is already running${previous ? ` (pid ${previous.pid})` : ""}.
`);
    return 1;
  }
  const logFile = headlessLogPath("grok", slug);
  ensureDir(path18.dirname(logFile));
  const log = (line) => {
    try {
      fs17.appendFileSync(logFile, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, { mode: 384 });
    } catch {
    }
  };
  const cwd = process.cwd();
  const hosted = registerHostedPeer("grok", cwd, initial.slug);
  writeHeadlessRecord({
    name: initial.name,
    slug: initial.slug,
    agent: "grok",
    peerId: hosted.peerId,
    pid: process.pid,
    procStart: procStart(process.pid),
    cwd,
    logFile,
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  const cli = cliCommand();
  log(`up as ${hosted.address} [${hosted.peerId}], posting to ${new URL(initial.url).host}`);
  const done = /* @__PURE__ */ new Set();
  let running = false;
  let failures = 0;
  let retryAt = 0;
  const tick = async () => {
    if (running || Date.now() < retryAt) return;
    running = true;
    try {
      const config = readConfig(slug);
      if (!config) {
        log("config removed; stopping");
        stop();
        return;
      }
      const pendingFile = (msg) => path18.join(inboxDir(hosted.peerId), `${msg.id}.json`);
      const waiting = pendingMessages(hosted.peerId).filter((msg) => !done.has(msg.id) && fs17.existsSync(pendingFile(msg)));
      if (!waiting.length) return;
      const times = waiting.map((msg) => Date.parse(msg.sentAt)).filter(Number.isFinite);
      const now = Date.now();
      if (times.length && now - Math.max(...times) < debounceMs() && now - Math.min(...times) < debounceMaxMs()) return;
      const batch = [];
      let size = 0;
      for (const msg of waiting) {
        const cost = msg.body.length + 1e3;
        if (batch.length && (batch.length >= MAX_BATCH || size + cost > MAX_CONTEXT_CHARS)) break;
        batch.push(msg);
        size += cost;
      }
      const live = batch.filter((msg) => fs17.existsSync(pendingFile(msg)));
      if (!live.length) return;
      const context = contextFor(config, live, cli);
      const result = await postContext(config, context);
      if (!result.ok) {
        failures++;
        retryAt = Date.now() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
        log(`POST failed for ${live.map((m) => m.id).join(",")}: ${result.detail} (${result.ms}ms); retry in ${Math.round((retryAt - Date.now()) / 1e3)}s`);
        return;
      }
      failures = 0;
      for (const msg of live) {
        done.add(msg.id);
        if (fs17.existsSync(path18.join(withdrawnDir(hosted.peerId), `${msg.id}.json`))) continue;
        appendTranscript(hosted.peerId, formatAsUserTurn(msg));
        if (fs17.existsSync(pendingFile(msg))) archiveSettled(hosted.peerId, msg.id);
      }
      log(`delivered ${live.map((m) => m.id).join(",")} in one run${result.runId ? ` ${result.runId}` : ""} (HTTP ${result.status}, ${result.ms}ms)`);
    } catch (err) {
      log(`error: ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer2 = setInterval(() => void tick(), 100);
  let resolveExit = () => {
  };
  const exited = new Promise((resolve) => resolveExit = resolve);
  function stop() {
    clearInterval(timer2);
    resolveExit(0);
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    return await exited;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    clearHosted(hosted.peerId);
    notePeerExit(hosted.peerId);
    unlock();
    log("stopped");
  }
}

// src/grokbot/cli.ts
var HELP = `telepathy grokbot: a Grok Bot routine webhook as a telepathy session.

  telepathy grokbot connect <name> <url> [--no-start]
      Paste the key when asked (or pipe it on stdin). Starts grok:<name>.
  telepathy grokbot start [name]       start the host (all connected Bots without a name)
  telepathy grokbot stop [name]
  telepathy grokbot status
  telepathy grokbot test <name>        wake the Bot once with a test note
  telepathy grokbot send <name> <to> <message | ->
  telepathy grokbot peers <name>
  telepathy grokbot disconnect <name>

Ask the Bot to make a routine with a webhook trigger. Open that routine from the Bot's info pane in the Grok Bot
app; its Webhook section shows the URL and the key. While the host runs, a message to grok:<name> starts one run
of that routine with the message as its context, and the Bot answers with \`telepathy grokbot send\` on this
machine. The key stays in ~/.telepathy/grokbot/<name>.json (mode 600) and is never printed.`;
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "") {
          stdin.setRawMode?.(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\x7F" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
function hostRunning(slug) {
  const record = readHeadlessRecord("grok", slug);
  return record && isSameProcess(record.pid, record.procStart) ? record.pid : void 0;
}
async function startHost(slug) {
  const pid = hostRunning(slug);
  if (pid) return { ok: true, text: `grok:${slug} is already running (pid ${pid}).` };
  const logFile = headlessLogPath("grok", slug);
  fs18.mkdirSync(path19.dirname(logFile), { recursive: true, mode: 448 });
  const out = fs18.openSync(logFile, "a", 384);
  const [cmd, ...args] = grokbotArgv();
  const home = os9.homedir();
  const child = spawn3(cmd, [...args, "host", slug], {
    cwd: fs18.existsSync(home) ? home : stateDir(),
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env
  });
  let spawnError;
  child.on("error", (err) => spawnError = err.message);
  child.unref();
  fs18.closeSync(out);
  const deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    const record = readHeadlessRecord("grok", slug);
    if (record && record.pid === child.pid && readPeer(record.peerId)) {
      return { ok: true, text: `grok:${slug} is up (pid ${child.pid}). Log: ${logFile}` };
    }
    if (child.exitCode !== null || spawnError) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const other = hostRunning(slug);
  if (other) return { ok: true, text: `grok:${slug} is up (pid ${other}).` };
  return { ok: false, text: `grok:${slug} did not start${spawnError ? ` (${spawnError})` : ""}. See ${logFile}.` };
}
function stopHost(slug) {
  const pid = hostRunning(slug);
  if (!pid) return `grok:${slug} is not running.`;
  process.kill(pid, "SIGTERM");
  return `Stopped grok:${slug} (pid ${pid}).`;
}
function needName(name, usage) {
  const slug = name ? slugify(name) : "";
  if (!slug) throw new Error(`Usage: ${usage}`);
  return slug;
}
async function grokbotCommand(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(HELP);
    return 0;
  }
  if (sub === "host") return runGrokbotHost(needName(rest[0], "telepathy grokbot host <name>"));
  if (sub === "connect") {
    const noStart = rest.includes("--no-start");
    const [name, url] = rest.filter((arg) => arg !== "--no-start");
    if (!name || !url) throw new Error("Usage: telepathy grokbot connect <name> <url>");
    const bad = urlProblem(url);
    if (bad) throw new Error(bad);
    const key = (process.stdin.isTTY ? await promptHidden("Routine key (input hidden): ") : await readStdin()).trim();
    const badKey = keyProblem(key);
    if (badKey) throw new Error(badKey);
    const config = writeConfig(name, url, key);
    console.log(`Connected grok:${config.slug} to ${new URL(url).host}. Key saved in ${configPath(config.slug)} (mode 600).`);
    console.log(`\`telepathy grokbot test ${config.slug}\` wakes the Bot once to check it.`);
    if (noStart) return 0;
    const started = await startHost(config.slug);
    console.log(started.text);
    return started.ok ? 0 : 1;
  }
  if (sub === "start") {
    const slugs = rest[0] ? [needName(rest[0], "telepathy grokbot start [name]")] : listConfigs().map((c) => c.slug);
    if (!slugs.length) {
      console.log("No Grok Bot is connected. Run `telepathy grokbot connect <name> <url>`.");
      return 1;
    }
    let ok = true;
    for (const slug of slugs) {
      if (!readConfig(slug)) {
        console.log(`grok:${slug}: not connected.`);
        ok = false;
        continue;
      }
      const started = await startHost(slug);
      console.log(started.text);
      ok &&= started.ok;
    }
    return ok ? 0 : 1;
  }
  if (sub === "stop") {
    const slugs = rest[0] ? [needName(rest[0], "telepathy grokbot stop [name]")] : listConfigs().map((c) => c.slug);
    for (const slug of slugs) console.log(stopHost(slug));
    return 0;
  }
  if (sub === "status") {
    const configs = listConfigs();
    const loose = looseConfigs();
    if (!configs.length && !loose.length) {
      console.log("No Grok Bot is connected.");
      return 0;
    }
    for (const config of configs) {
      const pid = hostRunning(config.slug);
      console.log(`grok:${config.slug}	${pid ? `running (pid ${pid})` : "stopped"}	${new URL(config.url).host}	log ${headlessLogPath("grok", config.slug)}`);
    }
    for (const name of loose) console.log(`${name}: ignored, the file is not mode 600 (chmod 600 it).`);
    return 0;
  }
  if (sub === "test") {
    const slug = needName(rest[0], "telepathy grokbot test <name>");
    const config = readConfig(slug);
    if (!config) throw new Error(`grok:${slug} is not connected.`);
    const host = os9.hostname().replace(/\.local$/, "");
    const context = noteTag(
      "wake",
      `telepathy test from ${host}: this webhook reaches you. No reply is needed. Messages to grok:${slug} will arrive like this, and you answer them by running on ${host}: ${cliCommand()} send ${slug} <address> "<reply>".`
    );
    const result = await postContext(config, context);
    if (!result.ok) {
      console.log(`Webhook failed: ${result.detail} (${result.ms}ms).`);
      return 1;
    }
    console.log(`Webhook accepted (HTTP ${result.status}, ${result.ms}ms)${result.runId ? `, run ${result.runId}` : ""}. The Bot runs that routine now.`);
    return 0;
  }
  if (sub === "send") {
    const [name, to, ...words] = rest;
    const slug = needName(name, "telepathy grokbot send <name> <to> <message | ->");
    if (!to || !words.length) throw new Error("Usage: telepathy grokbot send <name> <to> <message | ->");
    const record = readHeadlessRecord("grok", slug);
    if (!record || !isSameProcess(record.pid, record.procStart)) throw new Error(`grok:${slug} is not running. Start it with \`telepathy grokbot start ${slug}\`.`);
    const self = readPeer(record.peerId);
    if (!self) throw new Error(`grok:${slug} is not registered yet. Try again in a moment.`);
    const body = words.length === 1 && words[0] === "-" ? await readStdin() : words.join(" ");
    const result = await sendMessage(self, to, body);
    if (!result.ok) {
      console.log(result.error);
      return 1;
    }
    console.log(result.status);
    return 0;
  }
  if (sub === "peers") {
    const slug = needName(rest[0], "telepathy grokbot peers <name>");
    const record = readHeadlessRecord("grok", slug);
    const self = record && isSameProcess(record.pid, record.procStart) ? readPeer(record.peerId) : void 0;
    if (!self) throw new Error(`grok:${slug} is not running. Start it with \`telepathy grokbot start ${slug}\`.`);
    console.log(formatPeerList(self, listPeers()));
    return 0;
  }
  if (sub === "disconnect") {
    const slug = needName(rest[0], "telepathy grokbot disconnect <name>");
    const stopped = stopHost(slug);
    const removed = removeConfig(slug);
    console.log(removed ? `${stopped} Removed its URL and key.` : `grok:${slug} was not connected.`);
    return removed ? 0 : 1;
  }
  console.error(`Unknown grokbot command ${JSON.stringify(sub)}.

${HELP}`);
  return 1;
}

// src/grokbot-main.ts
grokbotCommand(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`telepathy grokbot: ${err.message}
`);
    process.exitCode = 1;
  }
);
