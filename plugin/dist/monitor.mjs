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

// src/core/proc.ts
import { execFileSync } from "node:child_process";
import path3 from "node:path";
function parseAgent(value) {
  if (value === "claude" || value === "codex") return value;
  throw new Error(`--agent must be "claude" or "codex" (got ${JSON.stringify(value)})`);
}
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
function findAgentPid(agent2) {
  const override = Number(process.env.TELEPATHY_AGENT_PID);
  if (Number.isInteger(override) && override > 0) return override;
  const table = processTable(0);
  const seen = /* @__PURE__ */ new Set();
  for (let pid = process.ppid; pid > 1 && !seen.has(pid); ) {
    seen.add(pid);
    const info = table.get(pid);
    if (!info) break;
    if (path3.basename(info.comm) === agent2) return pid;
    pid = info.ppid;
  }
  const claudePid = Number(process.env.CLAUDE_PID);
  if (agent2 === "claude" && Number.isInteger(claudePid) && isAlive(claudePid)) return claudePid;
  return process.ppid;
}

// src/core/peers.ts
var peerId = (agent2, pid) => `${agent2}-${pid}`;
function registerListener(agent2, pid) {
  const record = { pid: process.pid, procStart: procStart(process.pid), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeJsonAtomic(path4.join(peerDir(peerId(agent2, pid)), "listener.json"), record);
}
var agentLabel = (agent2) => agent2 === "claude" ? "Claude Code" : "Codex";
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
var agent = parseAgent(argv[argv.indexOf("--agent") + 1]);
var agentPid = findAgentPid(agent);
var id = peerId(agent, agentPid);
var listenerFile = path6.join(peerDir(id), "listener.json");
var draining = false;
function drain() {
  if (draining) return;
  draining = true;
  try {
    for (const msg of claimInbox(id)) {
      process.stdout.write(formatMonitorLine(msg) + "\n");
      debugLog("monitor", `delivered ${msg.id} from ${msg.from.id}`);
    }
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
    fs4.rmSync(listenerFile, { force: true });
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
