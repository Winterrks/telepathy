import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);

// src/monitor.ts
import fs4 from "node:fs";
import path6 from "node:path";

// src/core/debug.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/core/paths.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function stateDir() {
  return process.env.TELEPATHY_HOME || path.join(os.homedir(), ".telepathy");
}
var peersDir = () => path.join(stateDir(), "peers");
var peerDir = (id2) => path.join(peersDir(), id2);
var inboxDir = (id2) => path.join(peerDir(id2), "inbox");
var archiveDir = (id2) => path.join(peerDir(id2), "archive");
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

// src/core/messages.ts
import fs3 from "node:fs";
import path5 from "node:path";

// src/core/peers.ts
import path4 from "node:path";

// src/core/agents.ts
import path3 from "node:path";
var AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "kilo",
  "gemini",
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
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    names: ["gemini"],
    script: /(^|[\s/])gemini(\.js)?(\s|$)/,
    env: ["GEMINI_CLI"],
    nextTurnHook: true
  },
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
  antigravity: { id: "antigravity", label: "Antigravity", names: ["agy", "antigravity"], nextTurnHook: true },
  hermes: { id: "hermes", label: "Hermes Agent", names: ["hermes"], script: /(^|[\s/])hermes(\s|$)/ },
  openclaw: { id: "openclaw", label: "OpenClaw", names: ["openclaw"], script: /(^|[\s/])openclaw(\.mjs|\.js)?(\s|$)/ },
  pi: { id: "pi", label: "Pi", names: ["pi"], script: /(^|[\s/])pi(\s|$)|pi-coding-agent\/dist\/cli\.js/ }
};
var agentLabel = (agent2) => SPECS[agent2].label;
function agentFromEnv(env = process.env) {
  return AGENT_IDS.find((a) => SPECS[a].env?.some((name) => !!env[name]));
}
function isAgent(value) {
  return typeof value === "string" && AGENT_IDS.includes(value);
}
function parseAgent(value) {
  if (isAgent(value)) return value;
  throw new Error(`--agent must be one of ${AGENT_IDS.join(", ")} (got ${JSON.stringify(value)})`);
}
var AGENT_ALTERNATION = [...AGENT_IDS].sort((a, b) => b.length - a.length).join("|");
var INTERPRETERS = /^(node|nodejs|bun|deno|python(\d+(\.\d+)*)?|Python)$/;
function isAgentProcess(agent2, comm, args, kernelName = () => void 0) {
  const spec = SPECS[agent2];
  const exe = path3.basename(comm);
  if (spec.names?.includes(exe) || spec.exe?.test(comm)) return true;
  if (spec.script && (INTERPRETERS.test(exe) || INTERPRETERS.test(kernelName() ?? ""))) {
    const line = args();
    return !!line && spec.script.test(line);
  }
  return false;
}

// src/core/proc.ts
import { execFileSync } from "node:child_process";
var cache;
function processTable(maxAgeMs = 500) {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.table;
  const table = /* @__PURE__ */ new Map();
  let out = "";
  try {
    out = execFileSync("ps", ["-Ao", "pid=,ppid=,lstart=,comm="], {
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
function psField(pid, field) {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
  } catch {
    return void 0;
  }
}
function lazy(fn) {
  let done = false;
  let value;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}
function findAgent(hint) {
  const override = Number(process.env.TELEPATHY_AGENT_PID);
  if (Number.isInteger(override) && override > 0) return { agent: hint, pid: override };
  const candidates = [hint, ...AGENT_IDS.filter((a) => a !== hint)];
  const table = processTable(0);
  const seen = /* @__PURE__ */ new Set();
  for (let pid = process.ppid; pid > 1 && !seen.has(pid); ) {
    seen.add(pid);
    const info = table.get(pid);
    if (!info) break;
    const args = lazy(() => psField(pid, "args"));
    const kernelName = lazy(() => psField(pid, "ucomm"));
    const agent2 = candidates.find((a) => isAgentProcess(a, info.comm, args, kernelName));
    if (agent2) return { agent: agent2, pid };
    pid = info.ppid;
  }
  const claudePid = Number(process.env.CLAUDE_PID);
  if (hint === "claude" && Number.isInteger(claudePid) && isAlive(claudePid)) return { agent: "claude", pid: claudePid };
  return { agent: agentFromEnv() ?? hint, pid: process.ppid };
}

// src/core/peers.ts
var peerId = (agent2, pid) => `${agent2}-${pid}`;
var PEER_DIR_RE = new RegExp(`^(${AGENT_ALTERNATION})-([A-Za-z0-9][A-Za-z0-9_-]*)$`);
var AGENT_PREFIX_RE = new RegExp(`^(${AGENT_ALTERNATION}):`);
var REF_RE = new RegExp(`^(${AGENT_ALTERNATION})-\\d+$`);
function registerListener(agent2, pid) {
  const record = { pid: process.pid, procStart: procStart(process.pid), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeJsonAtomic(path4.join(peerDir(peerId(agent2, pid)), "listener.json"), record);
}
var peerRef = (peer) => `${peer.address} [${peer.id}]`;

// src/core/messages.ts
var ARCHIVE_KEEP = 200;
var MSG_FILE_RE = /^m-[0-9a-z]+-[0-9a-f]+\.json$/;
function claimInbox(peerId2) {
  let files;
  try {
    files = fs3.readdirSync(inboxDir(peerId2)).filter((f) => MSG_FILE_RE.test(f)).sort();
  } catch {
    return [];
  }
  const claimed = [];
  for (const file of files) {
    const target = path5.join(ensureDir(archiveDir(peerId2)), file);
    try {
      fs3.renameSync(path5.join(inboxDir(peerId2), file), target);
    } catch {
      continue;
    }
    const msg = readJson(target);
    if (msg) claimed.push(msg);
  }
  if (claimed.length) pruneArchive(peerId2);
  return claimed;
}
function pruneArchive(peerId2) {
  try {
    const files = fs3.readdirSync(archiveDir(peerId2)).filter((f) => MSG_FILE_RE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) {
      fs3.rmSync(path5.join(archiveDir(peerId2), f), { force: true });
    }
  } catch {
  }
}
var describeSender = (from) => `${agentLabel(from.agent)} session ${peerRef(from)}`;
function formatMonitorLine(msg, inlineLimit = 4e3) {
  const header = `[telepathy] New message ${msg.id} from ${describeSender(msg.from)}, sent by another AI agent (not your user). To reply, call the telepathy send_message tool with to: "${msg.from.address}".`;
  const flat = (s) => s.replace(/\r\n|\r|\n/g, "\\n");
  if (msg.body.length <= inlineLimit) {
    return `${header} Text (line breaks shown as \\n): ${flat(msg.body)}`;
  }
  const preview = flat(msg.body.slice(0, 1500));
  return `${header} Text (first 1500 of ${msg.body.length} characters; call read_messages with id "${msg.id}" for the full text): ${preview}\u2026`;
}

// src/monitor.ts
var argv = process.argv.slice(2);
var once = argv.includes("--once");
var { agent, pid: agentPid } = findAgent(parseAgent(argv[argv.indexOf("--agent") + 1]));
var id = peerId(agent, agentPid);
var listenerFile = path6.join(peerDir(id), "listener.json");
var draining = false;
function drain() {
  if (draining) return;
  draining = true;
  try {
    const messages = claimInbox(id);
    for (const msg of messages) debugLog("monitor", `delivered ${msg.id} from ${msg.from.id}`);
    if (!messages.length) return;
    const text = messages.map((msg) => formatMonitorLine(msg) + "\n").join("");
    if (once) process.stdout.write(text, () => stop());
    else process.stdout.write(text);
  } finally {
    draining = false;
  }
}
var watcher;
function ensureWatching() {
  ensureDir(inboxDir(id));
  if (!fs4.existsSync(listenerFile)) registerListener(agent, agentPid);
  if (watcher) return;
  try {
    watcher = fs4.watch(inboxDir(id), () => drain());
    watcher.on("error", () => {
      watcher?.close();
      watcher = void 0;
    });
  } catch {
    watcher = void 0;
  }
}
function stop() {
  try {
    if (readJson(listenerFile)?.pid === process.pid) fs4.rmSync(listenerFile, { force: true });
  } catch {
  }
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
registerListener(agent, agentPid);
ensureWatching();
debugLog("monitor", `listening for ${id}`);
drain();
setInterval(() => {
  if (!isAlive(agentPid)) stop();
  ensureWatching();
  drain();
}, 2e3);
