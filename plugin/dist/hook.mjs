import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);

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

// src/core/deliver.ts
import { execFile } from "node:child_process";
import crypto2 from "node:crypto";
import os3 from "node:os";
import path6 from "node:path";
import { promisify } from "node:util";

// src/core/messages.ts
import crypto from "node:crypto";
import fs4 from "node:fs";
import path5 from "node:path";

// src/core/peers.ts
import fs3 from "node:fs";
import os2 from "node:os";
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
function isSameProcess(pid, recordedStart) {
  if (!isAlive(pid)) return false;
  if (!recordedStart) return true;
  const current = processTable(0).get(pid)?.start;
  return current === void 0 || current === recordedStart;
}
function findAgentPid(agent) {
  const override = Number(process.env.TELEPATHY_AGENT_PID);
  if (Number.isInteger(override) && override > 0) return override;
  const table = processTable(0);
  const seen = /* @__PURE__ */ new Set();
  for (let pid = process.ppid; pid > 1 && !seen.has(pid); ) {
    seen.add(pid);
    const info = table.get(pid);
    if (!info) break;
    if (path3.basename(info.comm) === agent) return pid;
    pid = info.ppid;
  }
  const claudePid = Number(process.env.CLAUDE_PID);
  if (agent === "claude" && Number.isInteger(claudePid) && isAlive(claudePid)) return claudePid;
  return process.ppid;
}

// src/core/peers.ts
var peerId = (agent, pid) => `${agent}-${pid}`;
var PEER_DIR_RE = /^(claude|codex)-(\d+)$/;
var defaultCodexHome = () => process.env.CODEX_HOME || path4.join(os2.homedir(), ".codex");
var claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path4.join(os2.homedir(), ".claude");
function registerSession(agent, pid, fields) {
  const record = {
    agent,
    pid,
    procStart: procStart(pid),
    ...fields,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeJsonAtomic(path4.join(peerDir(peerId(agent, pid)), "session.json"), record);
  return record;
}
function slugify(value) {
  return value.normalize("NFKD").replace(new RegExp("(\\p{Script=Latin})\\p{M}+", "gu"), "$1").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40).replace(/[-.]+$/g, "");
}
function claudeSessionName(pid) {
  const record = readJson(path4.join(claudeConfigDir(), "sessions", `${pid}.json`));
  return typeof record?.name === "string" && record.name ? record.name : void 0;
}
function codexThreadName(codexHome, sessionId) {
  if (!sessionId) return void 0;
  let text;
  try {
    text = fs3.readFileSync(path4.join(codexHome, "session_index.jsonl"), "utf8");
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
function displayName(agent, pid, cwd, sessionId, codexHome) {
  const fromAgent = agent === "claude" ? claudeSessionName(pid) : codexThreadName(codexHome, sessionId);
  return fromAgent || (cwd ? path4.basename(cwd) : "") || `session-${pid}`;
}
function readPeer(id) {
  const m = PEER_DIR_RE.exec(id);
  if (!m) return void 0;
  const agent = m[1];
  const pid = Number(m[2]);
  const dir = peerDir(id);
  const session = readJson(path4.join(dir, "session.json"));
  const presence = readJson(path4.join(dir, "presence.json"));
  const listener = readJson(path4.join(dir, "listener.json"));
  if (!session && !presence) return void 0;
  const cwd = session?.cwd || presence?.cwd;
  const codexHome = session?.codexHome || presence?.codexHome || defaultCodexHome();
  const name = displayName(agent, pid, cwd, session?.sessionId, codexHome);
  const folderSlug = cwd ? slugify(path4.basename(cwd)) : "";
  return {
    id,
    agent,
    pid,
    procStart: session?.procStart || presence?.procStart,
    sessionId: session?.sessionId,
    cwd,
    codexHome,
    name,
    address: `${agent}:${slugify(name) || id}`,
    hasListener: !!listener && isSameProcess(listener.pid, listener.procStart),
    hasServer: !!presence && isSameProcess(presence.serverPid, void 0),
    aliases: folderSlug && folderSlug !== slugify(name) ? [folderSlug] : []
  };
}
function listPeers() {
  let names = [];
  try {
    names = fs3.readdirSync(peersDir());
  } catch {
    return [];
  }
  const peers = [];
  for (const name of names.sort()) {
    const m = PEER_DIR_RE.exec(name);
    if (!m) continue;
    const peer = readPeer(name);
    if (!isSameProcess(Number(m[2]), peer?.procStart)) {
      fs3.rmSync(peerDir(name), { recursive: true, force: true });
      continue;
    }
    if (peer) peers.push(peer);
  }
  return peers;
}
function selfPeer(agent, pid) {
  const id = peerId(agent, pid);
  return readPeer(id) ?? {
    id,
    agent,
    pid,
    name: `session-${pid}`,
    address: `${agent}:session-${pid}`,
    hasListener: false,
    hasServer: false
  };
}
var agentLabel = (agent) => agent === "claude" ? "Claude Code" : "Codex";
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
  const qSlug = slugify(q.replace(/^(claude|codex):/, ""));
  const qAgent = /^(claude|codex)[:-]/.exec(q)?.[1];
  const sameAgent = (p) => !qAgent || p.agent === qAgent;
  return pick(peers.filter((p) => p.id === q), "matches") ?? pick(peers.filter((p) => p.address.toLowerCase() === q), "matches") ?? pick(peers.filter((p) => sameAgent(p) && (slugsOf(p).includes(qSlug) || p.name.toLowerCase() === q)), "matches") ?? pick(peers.filter((p) => sameAgent(p) && qSlug !== "" && slugsOf(p).some((s) => s.startsWith(qSlug))), "is a prefix of") ?? {
    error: `No reachable session matches "${to}". ` + (peers.length ? `Reachable: ${peers.map(peerRef).join(", ")}.` : "No other sessions with telepathy are running.")
  };
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
  writeJsonAtomic(path5.join(inboxDir(msg.to.id), `${msg.id}.json`), msg);
}
function archiveMessage(msg) {
  writeJsonAtomic(path5.join(archiveDir(msg.to.id), `${msg.id}.json`), msg);
  pruneArchive(msg.to.id);
}
function pruneArchive(peerId2) {
  try {
    const files = fs4.readdirSync(archiveDir(peerId2)).filter((f) => MSG_FILE_RE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) {
      fs4.rmSync(path5.join(archiveDir(peerId2), f), { force: true });
    }
  } catch {
  }
}
var describeSender = (from) => `${agentLabel(from.agent)} session ${peerRef(from)}`;
function formatForCodex(msg) {
  return [
    `[telepathy] Message from ${describeSender(msg.from)}.`,
    `It was sent by another AI agent through the telepathy plugin, not typed by your user. To reply, call the telepathy send_message tool with to: "${msg.from.address}".`,
    "",
    msg.body
  ].join("\n");
}

// src/core/deliver.ts
var execFileAsync = promisify(execFile);
var DUPLICATE_WINDOW_MS = 2 * 6e4;
var RATE_WINDOW_MS = 10 * 6e4;
var RATE_MAX_PER_RECIPIENT = 20;
var sentLogFile = (selfId) => path6.join(peerDir(selfId), "sent-log.json");
function checkRate(selfId, toId, body) {
  const now = Date.now();
  const log = (readJson(sentLogFile(selfId)) ?? []).filter((e) => now - e.at < RATE_WINDOW_MS);
  const hash = crypto2.createHash("sha256").update(body).digest("hex").slice(0, 16);
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
  log.push({ to: toId, hash: crypto2.createHash("sha256").update(body).digest("hex").slice(0, 16), at: now });
  writeJsonAtomic(sentLogFile(selfId), log);
}
function codexCandidates() {
  const configured = process.env.TELEPATHY_CODEX_BIN;
  if (configured) return [configured];
  return ["codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex", path6.join(os3.homedir(), ".local", "bin", "codex")];
}
async function queueIntoCodex(threadId, text, codexHome) {
  const args = ["queue", `--thread=${threadId}`, `--message=${text}`];
  const env = { ...process.env, ...codexHome ? { CODEX_HOME: codexHome } : {} };
  let lastError;
  for (const bin of codexCandidates()) {
    try {
      await execFileAsync(bin, args, { env, timeout: 3e4, maxBuffer: 1024 * 1024 });
      return;
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
async function sendMessage(self, to, body) {
  if (!body.trim()) return { ok: false, error: "Message is empty." };
  if (body.length > MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      error: `Message is ${body.length} characters; the limit is ${MAX_MESSAGE_CHARS}. Write the content to a file and send its path instead.`
    };
  }
  const peers = listPeers().filter((p) => p.id !== self.id);
  const resolved = resolvePeer(to, peers);
  if ("error" in resolved) {
    const selfMatch = resolvePeer(to, [self]);
    if ("peer" in selfMatch) return { ok: false, error: `"${to}" is this session itself.` };
    return { ok: false, error: resolved.error };
  }
  const recipient = resolved.peer;
  const limited = checkRate(self.id, recipient.id, body);
  if (limited) return { ok: false, error: limited };
  const message = {
    id: newMessageId(),
    from: partyOf(self),
    to: partyOf(recipient),
    body,
    sentAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const who = `${agentLabel(recipient.agent)} session ${peerRef(recipient)}`;
  const replyNote = "A reply, if any, arrives as a new message; there is no need to wait or poll.";
  if (recipient.agent === "codex") {
    if (!recipient.sessionId) {
      return {
        ok: false,
        error: `${who} hasn't reported its thread id yet. In that Codex session, approve the telepathy SessionStart hook with /hooks (or have it call list_peers once), then retry.`
      };
    }
    try {
      await queueIntoCodex(recipient.sessionId, formatForCodex(message), recipient.codexHome);
    } catch (err) {
      return { ok: false, error: `Could not deliver to ${who}: ${err.message}` };
    }
    archiveMessage(message);
    recordSent(self.id, recipient.id, body);
    return {
      ok: true,
      message,
      recipient,
      status: `Queued ${message.id} for ${who}. Codex starts a new turn with it within about 10 seconds if that session is idle, or right after its current turn. ${replyNote}`
    };
  }
  writeToInbox(message);
  recordSent(self.id, recipient.id, body);
  const status = recipient.hasListener ? `Delivered ${message.id} to ${who}. Claude sees it right away and starts a turn if that session is idle. ${replyNote}` : `Stored ${message.id} in the inbox of ${who}, but that session has no active listener (plugin monitors only run in interactive Claude Code sessions), so it sees the message only when it calls read_messages.`;
  return { ok: true, message, recipient, status };
}

// src/core/listing.ts
function describePeer(peer) {
  const notes = [agentLabel(peer.agent)];
  if (peer.cwd) notes.push(`cwd ${peer.cwd}`);
  if (peer.agent === "codex" && !peer.sessionId) {
    notes.push("not reachable yet: its SessionStart hook has not run (approve it with /hooks in that session)");
  }
  if (peer.agent === "claude" && !peer.hasListener) notes.push("no listener: it reads messages only via read_messages");
  return `- ${peerRef(peer)} \xB7 ${notes.join(" \xB7 ")}`;
}

// src/hook.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}
var print = (value) => process.stdout.write(JSON.stringify(value) + "\n");
function sessionStart(agent, agentPid, input) {
  registerSession(agent, agentPid, {
    sessionId: input.session_id,
    cwd: input.cwd,
    source: "hook",
    codexHome: agent === "codex" ? defaultCodexHome() : void 0
  });
}
function listAgents(agentPid) {
  const selfId = peerId("claude", agentPid);
  const codexPeers = listPeers().filter((p) => p.id !== selfId && p.agent === "codex");
  if (!codexPeers.length) return;
  print({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [
        "Codex sessions on this machine are also reachable, through the telepathy plugin (they are not in the listing above).",
        'To message one, call SendMessage with its address (such as "codex:name") as `to`, or use the telepathy send_message tool:',
        ...codexPeers.map(describePeer)
      ].join("\n")
    }
  });
}
function addressedToCodex(to) {
  if (/^\s*["'`]?codex:/i.test(to) || /\[\s*codex-\d+\s*\]\s*$/i.test(to)) return true;
  const ref = to.trim().replace(/^["'`]|["'`]$/g, "").toLowerCase();
  return /^codex-\d+$/.test(ref) && listPeers().some((p) => p.agent === "codex" && p.id === ref);
}
async function interceptSendMessage(agentPid, input) {
  const to = input.tool_input?.to;
  if (typeof to !== "string" || !addressedToCodex(to)) return;
  const message = typeof input.tool_input?.message === "string" ? input.tool_input.message : "";
  const deny = (reason) => print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  if (!message.trim()) {
    deny("Not sent: Codex sessions only accept messages with text; notify_when_idle subscriptions are not supported for them.");
    return;
  }
  const result = await sendMessage(selfPeer("claude", agentPid), to, message);
  debugLog("hook", result.ok ? `SendMessage \u2192 ${result.recipient.id}` : `SendMessage failed: ${result.error}`);
  deny(
    result.ok ? `Delivered by the telepathy plugin. ${result.status} (SendMessage itself can't reach Codex sessions, so the plugin delivered the message and stopped this SendMessage call. Do not resend it.)` : `Not delivered: ${result.error}`
  );
}
async function main() {
  const argv = process.argv.slice(2);
  const agent = parseAgent(argv[argv.indexOf("--agent") + 1]);
  const event = argv.at(-1);
  const input = await readStdin();
  const agentPid = findAgentPid(agent);
  debugLog("hook", `${agent} ${event} (agent pid ${agentPid})`);
  if (event === "session-start") sessionStart(agent, agentPid, input);
  else if (event === "list-agents" && agent === "claude") listAgents(agentPid);
  else if (event === "send-message" && agent === "claude") await interceptSendMessage(agentPid, input);
  else throw new Error(`unknown hook event ${JSON.stringify(event)} for ${agent}`);
}
main().catch((err) => {
  process.stderr.write(`telepathy hook: ${err.message}
`);
  debugLog("hook", `error: ${err.stack}`);
});
