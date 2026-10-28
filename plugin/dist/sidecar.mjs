import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);

// src/sidecar.ts
import { spawn } from "node:child_process";
import fs3 from "node:fs";
import path4 from "node:path";
import { pathToFileURL } from "node:url";

// src/core/messages.ts
import fs2 from "node:fs";
import path3 from "node:path";

// src/core/paths.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function stateDir() {
  return process.env.TELEPATHY_HOME || path.join(os.homedir(), ".telepathy");
}
var peersDir = () => path.join(stateDir(), "peers");
var peerDir = (id) => path.join(peersDir(), id);
var inboxDir = (id) => path.join(peerDir(id), "inbox");
var archiveDir = (id) => path.join(peerDir(id), "archive");
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

// src/core/peers.ts
import path2 from "node:path";

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
var agentLabel = (agent) => SPECS[agent].label;
var AGENT_ALTERNATION = [...AGENT_IDS].sort((a, b) => b.length - a.length).join("|");

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
function procStart(pid) {
  return processTable().get(pid)?.start;
}

// src/core/peers.ts
var peerId = (agent, key) => `${agent}-${key}`;
var PEER_DIR_RE = new RegExp(`^(${AGENT_ALTERNATION})-([A-Za-z0-9][A-Za-z0-9_-]*)$`);
var AGENT_PREFIX_RE = new RegExp(`^(${AGENT_ALTERNATION}):`);
var REF_RE = new RegExp(`^(${AGENT_ALTERNATION})-(\\d+|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|ses_[A-Za-z0-9]+)$`);
var HOLD_MS = 60 * 6e4;
var SESSION_KEEP_MS = 24 * 60 * 6e4;
var SERVICE_SESSION_ACTIVE_MS = 12 * 60 * 6e4;
function registerListener(agent, pid, id = peerId(agent, pid)) {
  const record = { pid: process.pid, procStart: procStart(process.pid), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeJsonAtomic(path2.join(peerDir(id), "listener.json"), record);
}
var peerRef = (peer) => `${peer.address} [${peer.id}]`;

// src/core/messages.ts
var ARCHIVE_KEEP = 200;
var MSG_FILE_RE = /^m-[0-9a-z]+-[0-9a-f]+\.json$/;
function claimInbox(peerId2) {
  let files;
  try {
    files = fs2.readdirSync(inboxDir(peerId2)).filter((f) => MSG_FILE_RE.test(f)).sort();
  } catch {
    return [];
  }
  const claimed = [];
  for (const file of files) {
    const target = path3.join(ensureDir(archiveDir(peerId2)), file);
    try {
      fs2.renameSync(path3.join(inboxDir(peerId2), file), target);
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
    const files = fs2.readdirSync(archiveDir(peerId2)).filter((f) => MSG_FILE_RE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) {
      fs2.rmSync(path3.join(archiveDir(peerId2), f), { force: true });
    }
  } catch {
  }
}
var describeSender = (from) => `${agentLabel(from.agent)} session ${peerRef(from)}`;
var messageMarker = (id) => `telepathy-id:${id}`;
function formatAsUserTurn(msg) {
  return [
    `[telepathy] Message from ${describeSender(msg.from)}.`,
    messageMarker(msg.id),
    `It was sent by another AI agent through the telepathy plugin, not typed by your user. To reply, call the telepathy send_message tool with to: "${msg.from.address}".`,
    "",
    msg.body
  ].join("\n");
}

// src/sidecar.ts
function appConversations() {
  let names = [];
  try {
    names = fs3.readdirSync(peersDir());
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    const session = readJson(path4.join(peersDir(), name, "session.json"));
    if (session?.agent !== "antigravity" || session.surface !== "app" || !session.sessionId) continue;
    found.push({ id: name, pid: session.pid, conversationId: session.sessionId });
  }
  return found;
}
function restoreClaimed(peerId2, messages) {
  for (const msg of messages) {
    const file = `${msg.id}.json`;
    try {
      fs3.renameSync(path4.join(archiveDir(peerId2), file), path4.join(ensureDir(inboxDir(peerId2)), file));
    } catch {
    }
  }
}
function agentApiSend(conversationId, prompt, env) {
  return new Promise((resolve) => {
    const child = spawn("agentapi", ["send-message", conversationId, prompt], { env, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
async function pollSidecar(env = process.env) {
  let sent = 0;
  for (const peer of appConversations()) {
    registerListener("antigravity", peer.pid, peer.id);
    const messages = claimInbox(peer.id);
    if (!messages.length) continue;
    const prompt = messages.map((msg) => formatAsUserTurn(msg)).join("\n\n");
    const ok = await agentApiSend(peer.conversationId, prompt, env);
    if (!ok) restoreClaimed(peer.id, messages);
    else sent += messages.length;
  }
  return sent;
}
async function main() {
  for (; ; ) {
    try {
      await pollSidecar();
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 1e3));
  }
}
var entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path4.resolve(entry)).href) {
  void main();
}
export {
  pollSidecar
};
