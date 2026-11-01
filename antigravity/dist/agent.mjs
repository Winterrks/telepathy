import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);

// src/agent/host.ts
import crypto4 from "node:crypto";
import fs17 from "node:fs";
import path20 from "node:path";

// src/acp/host.ts
import { spawn as spawn3 } from "node:child_process";
import fs13 from "node:fs";
import os7 from "node:os";
import path14 from "node:path";
import readline2 from "node:readline";
import { fileURLToPath } from "node:url";

// src/cli/launch.ts
import path6 from "node:path";

// src/core/installs.ts
import fs2 from "node:fs";
import os2 from "node:os";
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

// src/core/installs.ts
var home = () => os2.homedir();
var cacheHome = () => process.env.XDG_CACHE_HOME || path2.join(home(), ".cache");
var dataHome = () => process.env.XDG_DATA_HOME || path2.join(home(), ".local", "share");
function resolveReal(dir) {
  const abs = path2.resolve(dir);
  const missing = [];
  let current = abs;
  while (current !== path2.dirname(current)) {
    try {
      return path2.join(fs2.realpathSync(current), ...missing);
    } catch {
      missing.unshift(path2.basename(current));
      current = path2.dirname(current);
    }
  }
  return abs;
}
function genericDir(dir) {
  const normalized = resolveReal(dir);
  if (normalized === path2.parse(normalized).root) return true;
  const generic = ["/tmp", "/var", "/private", "/private/tmp", "/var/tmp", "/private/var"];
  if (generic.includes(normalized)) return true;
  try {
    const tmp = resolveReal(os2.tmpdir());
    if (normalized === tmp || normalized === path2.dirname(tmp)) return true;
  } catch {
  }
  return false;
}
function isolatedStateRoots() {
  const explicit = configuredEnv("TELEPATHY_HOME");
  if (!explicit) return void 0;
  const state = resolveReal(explicit);
  let passwd = path2.resolve(os2.userInfo().homedir);
  try {
    passwd = fs2.realpathSync(passwd);
  } catch {
  }
  if (state === resolveReal(path2.join(passwd, ".telepathy"))) return void 0;
  const parent = path2.dirname(state);
  const roots = [genericDir(parent) || parent === passwd ? state : parent];
  let apparent = path2.resolve(os2.homedir());
  try {
    apparent = fs2.realpathSync(apparent);
  } catch {
  }
  const covered = roots.some((root) => apparent === root || apparent.startsWith(root + path2.sep));
  if (apparent !== passwd && !covered) roots.push(apparent);
  return roots;
}
function inRoots(dir, roots) {
  const resolved = resolveReal(dir);
  return roots.some((root) => resolved === root || resolved.startsWith(root + path2.sep));
}
function outsideIsolatedHome(dir) {
  const roots = isolatedStateRoots();
  if (!roots) return false;
  return !inRoots(dir, roots);
}
function readVersion(file) {
  try {
    const version = JSON.parse(fs2.readFileSync(file, "utf8")).version;
    return typeof version === "string" ? version : void 0;
  } catch {
    return void 0;
  }
}
function builtVersion(dir) {
  try {
    return /var VERSION = (?:true \? )?"(\d+\.\d+\.\d+[^"]*)"/.exec(fs2.readFileSync(path2.join(dir, "dist", "server.mjs"), "utf8"))?.[1];
  } catch {
    return void 0;
  }
}
var list = (dir) => {
  try {
    return fs2.readdirSync(dir);
  } catch {
    return [];
  }
};
var versionParts = (v) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
function isNewer(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}
function newestOf(installs) {
  return installs.reduce((best, i) => !best || isNewer(i.version, best.version) ? i : best, void 0);
}
function claude() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path2.join(home(), ".claude");
  let plugins = {};
  try {
    plugins = JSON.parse(fs2.readFileSync(path2.join(configDir, "plugins", "installed_plugins.json"), "utf8")).plugins ?? {};
  } catch {
    return [];
  }
  return Object.entries(plugins).filter(([key]) => key.startsWith("telepathy@")).flatMap(
    ([key, entries]) => (entries ?? []).filter((e) => e.version && e.installPath).map((e) => ({ agent: "claude", version: e.version, dir: e.installPath, marketplace: key.slice("telepathy@".length) }))
  );
}
function codex() {
  const cache3 = path2.join(process.env.CODEX_HOME || path2.join(home(), ".codex"), "plugins", "cache");
  const found = list(cache3).flatMap(
    (marketplace) => list(path2.join(cache3, marketplace, "telepathy")).map((version) => ({
      agent: "codex",
      version,
      dir: path2.join(cache3, marketplace, "telepathy", version),
      marketplace
    }))
  );
  const newest = newestOf(found.filter((i) => /^\d+\.\d+\.\d+/.test(i.version)));
  return newest ? [newest] : [];
}
function extension(agent) {
  const dir = path2.join(home(), `.${agent}`, "extensions", "telepathy");
  const version = readVersion(path2.join(dir, `${agent}-extension.json`));
  return version ? [{ agent, version, dir }] : [];
}
var COPILOT_MANIFESTS = [".github/plugin/plugin.json", ".plugin/plugin.json", "plugin.json", ".claude-plugin/plugin.json"];
function manifestAt(dir) {
  for (const rel of COPILOT_MANIFESTS) {
    const body = readJson(path2.join(dir, rel));
    if (!body) continue;
    const name = typeof body.name === "string" ? body.name : void 0;
    const version = typeof body.version === "string" ? body.version : void 0;
    if (!name && !version) continue;
    return { name, version };
  }
  return void 0;
}
function asCopilotInstall(dir, marketplace, version) {
  const manifest = manifestAt(dir);
  if (manifest?.name && manifest.name !== "telepathy") return void 0;
  const found = manifest?.version ?? version;
  if (!found) return void 0;
  const named = manifest?.name === "telepathy" || path2.basename(dir) === "telepathy" || !manifest && version !== void 0;
  if (!named) return void 0;
  return { agent: "copilot", version: found, dir, ...marketplace ? { marketplace } : {} };
}
function copilotTree(root) {
  return list(root).flatMap((marketplace) => {
    const marketName = marketplace === "_direct" ? void 0 : marketplace;
    return list(path2.join(root, marketplace)).flatMap((child) => {
      const install = asCopilotInstall(path2.join(root, marketplace, child), marketName);
      return install ? [install] : [];
    });
  });
}
function stringField(record, ...keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return void 0;
}
function installFromRecord(entry) {
  if (!entry || typeof entry !== "object") return void 0;
  const record = entry;
  if (record.name !== "telepathy" || record.enabled === false) return void 0;
  const source = record.source;
  let sourcePath;
  if (source && typeof source === "object") {
    const body = source;
    const kind = typeof body.source === "string" ? body.source : "";
    if (typeof body.path === "string" && (!kind || kind === "local" || kind === "directory")) sourcePath = body.path;
  }
  const dir = [stringField(record, "cache_path", "cachePath"), sourcePath].find((candidate) => candidate && fs2.existsSync(candidate));
  if (!dir) return void 0;
  const marketplace = typeof record.marketplace === "string" && record.marketplace && record.marketplace !== "local" ? record.marketplace : void 0;
  const version = typeof record.version === "string" ? record.version : void 0;
  return asCopilotInstall(dir, marketplace, version);
}
function installsFromConfigFile(file) {
  const body = readJson(file);
  if (!body) return [];
  const lists = [body.installedPlugins, body.installed_plugins].filter(Array.isArray);
  return lists.flatMap((list2) => list2.flatMap((entry) => {
    const install = installFromRecord(entry);
    return install ? [install] : [];
  }));
}
function marketplaceDirs(file, base2) {
  const markets = readJson(file)?.extraKnownMarketplaces;
  if (!markets || typeof markets !== "object") return [];
  const dirs = [];
  for (const value of Object.values(markets)) {
    if (!value || typeof value !== "object") continue;
    const source = value.source;
    if (!source || typeof source !== "object") continue;
    const body = source;
    const kind = typeof body.source === "string" ? body.source : "";
    if (typeof body.path !== "string" || !body.path) continue;
    if (kind && kind !== "directory" && kind !== "local") continue;
    dirs.push(path2.resolve(base2, body.path));
  }
  return dirs;
}
function pluginsInFolder(dir, marketplace) {
  const own = asCopilotInstall(dir, marketplace);
  const children = list(dir).flatMap((child) => {
    const install = asCopilotInstall(path2.join(dir, child), marketplace);
    return install ? [install] : [];
  });
  return [...own ? [own] : [], ...children];
}
function launchCwd(argv = process.argv) {
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd" && argv[i + 1] && !argv[i + 1].startsWith("--")) cwd = path2.resolve(argv[++i]);
    else if (arg.startsWith("--cwd=")) cwd = path2.resolve(arg.slice("--cwd=".length));
  }
  return cwd;
}
function pluginDirsFromArgv(argv = process.argv) {
  const cwd = launchCwd(argv);
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--plugin-dir" && argv[i + 1] && !argv[i + 1].startsWith("-")) dirs.push(path2.resolve(cwd, argv[++i]));
    else if (arg.startsWith("--plugin-dir=")) dirs.push(path2.resolve(cwd, arg.slice("--plugin-dir=".length)));
  }
  return dirs;
}
function copilotConfigDirs() {
  const dirs = [];
  const add = (dir) => {
    if (!dir) return;
    const resolved = path2.resolve(dir);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };
  add(configuredEnv("COPILOT_HOME"));
  add(path2.join(home(), ".copilot"));
  add(configuredEnv("TELEPATHY_HOME") ? path2.join(configuredEnv("TELEPATHY_HOME"), ".copilot") : void 0);
  for (const root of isolatedStateRoots() ?? []) add(path2.join(root, ".copilot"));
  return dirs;
}
function dedupeInstalls(installs) {
  const byDir = /* @__PURE__ */ new Map();
  for (const install of installs) {
    let key = install.dir;
    try {
      key = resolveReal(install.dir);
    } catch {
    }
    const prev = byDir.get(key);
    if (!prev || install.marketplace && !prev.marketplace && !isNewer(prev.version, install.version) || isNewer(install.version, prev.version)) {
      byDir.set(key, install);
    }
  }
  return [...byDir.values()];
}
function copilot() {
  const configs = copilotConfigDirs();
  const fromConfigs = configs.flatMap((dir) => [
    ...copilotTree(path2.join(dir, "installed-plugins")),
    ...installsFromConfigFile(path2.join(dir, "config.json")),
    ...installsFromConfigFile(path2.join(dir, "settings.json")),
    ...marketplaceDirs(path2.join(dir, "settings.json"), dir).flatMap((folder) => pluginsInFolder(folder))
  ]);
  const cwd = launchCwd();
  const projectSettings = [path2.join(cwd, ".github", "copilot", "settings.json"), path2.join(cwd, ".github", "copilot", "settings.local.json")];
  const fromProject = projectSettings.flatMap((file) => [
    ...installsFromConfigFile(file),
    ...marketplaceDirs(file, cwd).flatMap((folder) => pluginsInFolder(folder))
  ]);
  const fromArgs = pluginDirsFromArgv().flatMap((dir) => pluginsInFolder(dir));
  return dedupeInstalls([...fromConfigs, ...fromProject, ...fromArgs]);
}
function devin() {
  const cache3 = path2.join(dataHome(), "devin", "cli", "plugins", "cache");
  const found = list(cache3).filter((name) => /telepathy/i.test(name)).flatMap(
    (name) => list(path2.join(cache3, name)).flatMap((version) => {
      const dir = path2.join(cache3, name, version);
      const manifest = readVersion(path2.join(dir, ".devin-plugin", "plugin.json"));
      return manifest ? [{ agent: "devin", version: manifest, dir }] : [];
    })
  );
  const newest = newestOf(found);
  return newest ? [newest] : [];
}
function antigravity() {
  const dirs = [
    path2.join(home(), ".gemini", "config", "plugins", "telepathy"),
    path2.join(home(), ".gemini", "antigravity-cli", "plugins", "telepathy")
  ];
  const found = dirs.flatMap((dir) => {
    const version = builtVersion(dir);
    return version ? [{ agent: "antigravity", version, dir }] : [];
  });
  const newest = newestOf(found);
  return newest ? [newest] : [];
}
var kimiHome = () => process.env.KIMI_CODE_HOME || path2.join(home(), ".kimi-code");
function readKimiInstalled() {
  const file = readJson(path2.join(kimiHome(), "plugins", "installed.json"));
  if (!file || !Array.isArray(file.plugins)) return void 0;
  return { version: file.version ?? 1, plugins: file.plugins };
}
function kimi() {
  const entry = readKimiInstalled()?.plugins.find((plugin) => plugin?.id === "telepathy");
  if (!entry || typeof entry.root !== "string") return [];
  const version = readVersion(path2.join(entry.root, ".kimi-plugin", "plugin.json"));
  return version ? [{ agent: "kimi", version, dir: entry.root }] : [];
}
function opencodeNpmCache() {
  const npm = path2.join(cacheHome(), "opencode", "npm");
  return list(npm).filter((name) => /telepathy/i.test(name)).flatMap((name) => list(path2.join(npm, name)).map((install) => path2.join(npm, name, install, "node_modules", "telepathy"))).filter((dir) => fs2.existsSync(path2.join(dir, "package.json")));
}
function packageCache(agent) {
  const packages = path2.join(cacheHome(), agent, "packages");
  const candidates = agent === "opencode" ? [...opencodeNpmCache(), ...list(packages).filter((name) => name.startsWith("telepathy@")).flatMap((name) => {
    const found2 = [];
    const walk = (dir, depth) => {
      if (fs2.existsSync(path2.join(dir, "node_modules", "telepathy", "package.json"))) found2.push(path2.join(dir, "node_modules", "telepathy"));
      else if (depth < 4) for (const sub of list(dir)) walk(path2.join(dir, sub), depth + 1);
    };
    walk(path2.join(packages, name), 0);
    return found2;
  })] : list(path2.join(packages, "git")).filter((name) => /telepathy/i.test(name) && !name.endsWith(".json")).map((name) => path2.join(packages, "git", name));
  const found = candidates.flatMap((dir) => {
    const version = readVersion(path2.join(dir, "package.json"));
    return version ? [{ agent, version, dir }] : [];
  });
  const newest = newestOf(found);
  return newest ? [newest] : [];
}
function findInstalls() {
  return [
    ...claude(),
    ...codex(),
    ...extension("qwen"),
    ...copilot(),
    ...devin(),
    ...antigravity(),
    ...packageCache("opencode"),
    ...packageCache("kilo"),
    ...kimi()
  ];
}
function installsInScope(installs = findInstalls()) {
  const roots = isolatedStateRoots();
  if (!roots) return installs;
  return installs.filter((install) => inRoots(install.dir, roots));
}

// src/core/peers.ts
import { createHash } from "node:crypto";
import fs5 from "node:fs";
import os3 from "node:os";
import path5 from "node:path";

// src/core/agents.ts
import path3 from "node:path";
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
var INTERPRETERS = /^(node|nodejs|bun|deno|python(\d+(\.\d+)*)?|Python)$/;
function isAgentProcess(agent, comm, args, kernelName = () => void 0) {
  const spec = SPECS[agent];
  const exe = path3.basename(comm);
  if (spec.names?.includes(exe) || spec.exe?.test(comm)) return true;
  if (spec.script && (INTERPRETERS.test(exe) || INTERPRETERS.test(kernelName() ?? ""))) {
    const line = args();
    return !!line && spec.script.test(line);
  }
  return false;
}

// src/core/version.ts
var VERSION = true ? "0.11.1" : "0.0.0-dev";

// src/core/codex-launch.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import fs3 from "node:fs";

// src/core/proc.ts
import { execFileSync } from "node:child_process";
var cache;
function psCommand() {
  return process.env.TELEPATHY_PS_BIN || "ps";
}
function clearProcessListCache() {
  cache = void 0;
  argsCache = void 0;
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
function descendantPids(root) {
  if (!Number.isInteger(root) || root <= 0) return [];
  const table = processTable(0);
  const children = /* @__PURE__ */ new Map();
  for (const info of table.values()) {
    const list2 = children.get(info.ppid);
    if (list2) list2.push(info.pid);
    else children.set(info.ppid, [info.pid]);
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (pid === void 0 || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}
function isNpmCopilotShim(command) {
  return /(?:^|[\s/])\.bin\/copilot(?:\.js)?(?:\s|$)/.test(command);
}
function isTelepathyMcp(command) {
  if (!/telepathy/i.test(command)) return false;
  return /(?:server|hook)\.mjs/.test(command) || /(?:^|\s)mcp(?:\s|$)/.test(command);
}
function resolveCopilotPid(spawnedPid) {
  if (!Number.isInteger(spawnedPid) || spawnedPid <= 0) return spawnedPid;
  const tree = descendantPids(spawnedPid);
  if (!tree.length) return spawnedPid;
  const inTree = new Set(tree);
  const table = processTable(0);
  const lines = commandLines(0);
  const lineOf = (pid) => lines.get(pid) ?? "";
  const depth = /* @__PURE__ */ new Map([[spawnedPid, 0]]);
  for (const pid of tree) {
    if (pid === spawnedPid) continue;
    const parent = table.get(pid)?.ppid;
    const parentDepth = parent === void 0 ? void 0 : depth.get(parent);
    if (parentDepth !== void 0) depth.set(pid, parentDepth + 1);
  }
  const looksCopilot = (pid) => {
    const info = table.get(pid);
    if (!info) return false;
    return isAgentProcess("copilot", info.comm, () => lineOf(pid));
  };
  const mcpPids = tree.filter((pid) => isTelepathyMcp(lineOf(pid)));
  for (const mcp of mcpPids) {
    let pid = table.get(mcp)?.ppid;
    while (pid && inTree.has(pid)) {
      if (looksCopilot(pid) && !isNpmCopilotShim(lineOf(pid))) return pid;
      pid = table.get(pid)?.ppid;
    }
    let parent = table.get(mcp)?.ppid;
    while (parent && inTree.has(parent)) {
      if (!isNpmCopilotShim(lineOf(parent))) return parent;
      parent = table.get(parent)?.ppid;
    }
  }
  let best = spawnedPid;
  let bestDepth = -1;
  for (const pid of tree) {
    if (!looksCopilot(pid) || isNpmCopilotShim(lineOf(pid))) continue;
    const d = depth.get(pid) ?? 0;
    if (d >= bestDepth) {
      best = pid;
      bestDepth = d;
    }
  }
  return best;
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
var INTERPRETERS2 = /* @__PURE__ */ new Set(["node", "nodejs", "bun", "deno", "python", "python3", "bash", "sh", "zsh", "env"]);
var THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function tokenize(command) {
  const tokens = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}
function binName(token) {
  const base2 = token.split(/[/\\]/).pop() ?? token;
  return base2.replace(/\.(js|mjs|cjs|exe)$/i, "");
}
function codexArgv(command) {
  const tokens = tokenize(command);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++;
  const exe = tokens[i];
  if (!exe) return void 0;
  if (binName(exe) === "codex") return tokens.slice(i + 1);
  if (!INTERPRETERS2.has(binName(exe))) return void 0;
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
    const raw = fs3.readFileSync(`/proc/${pid}/environ`);
    for (const entry of raw.toString("utf8").split("\0")) {
      if (!entry.startsWith("CODEX_HOME=")) continue;
      const home2 = entry.slice("CODEX_HOME=".length);
      return { home: home2 || void 0 };
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
      const home2 = /(?:^|\s)CODEX_HOME=(\S*)/.exec(match[2] ?? "");
      if (home2?.[1]) homes.set(Number(match[1]), home2[1]);
    }
  } catch {
  }
  return homes;
}
function processCwd(pid) {
  try {
    const cwd = fs3.readlinkSync(`/proc/${pid}/cwd`);
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
  return !!exe && INTERPRETERS2.has(binName(exe));
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
      const list2 = wrappersOf.get(other.pid) ?? [];
      if (!list2.includes(proc.pid)) list2.push(proc.pid);
      wrappersOf.set(other.pid, list2);
    }
  }
  return procs.filter((proc) => !drop.has(proc.pid)).map((proc) => {
    const wrapperPids = wrappersOf.get(proc.pid);
    return wrapperPids?.length ? { ...proc, wrapperPids } : proc;
  });
}
function procsFromOverride(file) {
  try {
    const parsed = JSON.parse(fs3.readFileSync(file, "utf8"));
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
import fs4 from "node:fs";
import path4 from "node:path";
var locksDir = (codexHome) => path4.join(codexHome, "thread-writer-locks");
var cache2;
function heldLocks(dir, maxAgeMs = 1e3) {
  let files;
  try {
    files = fs4.readdirSync(dir).filter((f) => f.endsWith(".lock") && !f.startsWith("."));
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
        out.split("\n").filter((l) => l.startsWith("n")).map((l) => path4.basename(l.slice(1)).replace(/\.lock$/, ""))
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
  if (!fs4.existsSync(dir)) return void 0;
  if (!fs4.existsSync(path4.join(dir, `${threadId}.lock`))) return false;
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
var ownersFile = (id) => path5.join(peerDir(id), "owners.json");
var linkFile = (agent, pid) => path5.join(peerDir(peerId(agent, pid)), "link.json");
var rememberedFile = (agent, sessionId) => path5.join(stateDir(), "identities", agent, `${sessionToken(sessionId)}.json`);
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
function focusSessionOwner(id, pid) {
  const record = { pid, procStart: procStart(pid), at: (/* @__PURE__ */ new Date()).toISOString() };
  writeJsonAtomic(ownersFile(id), [record]);
  const session = readSession(id);
  if (!session || session.pid === pid) return;
  writeJsonAtomic(path5.join(peerDir(id), "session.json"), { ...session, pid, procStart: record.procStart });
}
function linkAgentProcess(agent, pid, sessionPeer) {
  const from = peerId(agent, pid);
  if (from === sessionPeer) return;
  writeJsonAtomic(linkFile(agent, pid), { id: sessionPeer });
  moveInbox(from, sessionPeer);
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
var defaultCodexHome = () => configuredEnv("CODEX_HOME") || path5.join(os3.homedir(), ".codex");
function copilotEventsFile(sessionId, env = process.env) {
  const home2 = configuredEnv("COPILOT_HOME", env) || path5.join(os3.homedir(), ".copilot");
  return path5.join(home2, "session-state", sessionId, "events.jsonl");
}
var claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path5.join(os3.homedir(), ".claude");
function registerSession(agent, pid, fields, id = sessionPeerId(agent, pid, fields.sessionId)) {
  const file = path5.join(peerDir(id), "session.json");
  const previous = readJson(file);
  const now2 = (/* @__PURE__ */ new Date()).toISOString();
  const owner = fields.sessionId ? claimSessionOwner(id, pid) : true;
  const primary = fields.sessionId ? sessionOwners(id)[0] : void 0;
  const record = {
    agent,
    pid: primary?.pid ?? pid,
    procStart: primary?.procStart ?? procStart(pid),
    ...fields,
    startedAt: previous?.sessionId === fields.sessionId && previous?.startedAt || now2,
    updatedAt: now2,
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
  writeJsonAtomic(path5.join(peerDir(id), "session.json"), { ...session, exitedAt: at });
}
function dropInboxAfter(id, exitedAt) {
  const cutoff = Date.parse(exitedAt);
  if (Number.isNaN(cutoff)) return;
  let files = [];
  try {
    files = fs5.readdirSync(inboxDir(id));
  } catch {
    return;
  }
  for (const file of files) {
    const msg = readJson(path5.join(inboxDir(id), file));
    const sent = Date.parse(msg?.sentAt ?? "");
    if (Number.isNaN(sent) || sent <= cutoff) continue;
    try {
      fs5.rmSync(path5.join(inboxDir(id), file), { force: true });
    } catch {
    }
  }
}
function moveInbox(fromId, toId) {
  if (fromId === toId) return;
  let files = [];
  try {
    files = fs5.readdirSync(inboxDir(fromId));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      fs5.renameSync(path5.join(inboxDir(fromId), file), path5.join(ensureDir(inboxDir(toId)), file));
    } catch {
    }
  }
}
var HOLD_MS = 60 * 6e4;
var SESSION_KEEP_MS = 24 * 60 * 6e4;
var SERVICE_SESSION_ACTIVE_MS = 12 * 60 * 6e4;
function lastActivity(id) {
  const times = [readSession(id)?.updatedAt, readJson(path5.join(peerDir(id), "status.json"))?.at];
  return Math.max(...times.map((t) => Date.parse(t ?? "")).filter((t) => !Number.isNaN(t)), 0);
}
function keepsSession(peer, now2 = Date.now()) {
  return !!peer && isSessionKeyed(peer) && now2 - lastActivity(peer.id) < SESSION_KEEP_MS;
}
function holdsUnread(id, now2 = Date.now()) {
  try {
    return fs5.readdirSync(inboxDir(id)).some((f) => now2 - fs5.statSync(path5.join(inboxDir(id), f)).mtimeMs < HOLD_MS);
  } catch {
    return false;
  }
}
function adoptHeldMessages(agent, selfId, sessionId) {
  let names;
  try {
    names = fs5.readdirSync(peersDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (name === selfId || !name.startsWith(`${agent}-`)) continue;
    const old = readJson(path5.join(peerDir(name), "session.json"));
    if (old?.agent !== agent || old.sessionId !== sessionId || isPeerAlive(readPeer(name))) continue;
    let files = [];
    try {
      files = fs5.readdirSync(inboxDir(name));
    } catch {
    }
    for (const file of files) {
      try {
        fs5.renameSync(path5.join(inboxDir(name), file), path5.join(ensureDir(inboxDir(selfId)), file));
      } catch {
      }
    }
    fs5.rmSync(peerDir(name), { recursive: true, force: true });
  }
}
function registerListener(agent, pid, id = peerId(agent, pid)) {
  const record = { pid: process.pid, procStart: procStart(process.pid), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeJsonAtomic(path5.join(peerDir(id), "listener.json"), record);
}
function configuredStableName(explicit) {
  const raw = explicit?.trim() || configuredEnv("TELEPATHY_NAME");
  if (!raw) return void 0;
  return slugify(raw) || void 0;
}
function registerStableName(agent, id, explicit) {
  const name = configuredStableName(explicit);
  if (!name) {
    const file = path5.join(peerDir(id), "identity.json");
    if (readJson(file)?.name === "mcp") fs5.rmSync(file, { force: true });
    return;
  }
  writeJsonAtomic(path5.join(peerDir(id), "identity.json"), { name, pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() });
  adoptStableInbox(agent, id, name);
}
function adoptStableInbox(agent, selfId, stableName) {
  let names;
  try {
    names = fs5.readdirSync(peersDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (name === selfId || !name.startsWith(`${agent}-`)) continue;
    const ident = readJson(path5.join(peerDir(name), "identity.json"));
    if (ident?.name !== stableName || isPeerAlive(readPeer(name))) continue;
    let files = [];
    try {
      files = fs5.readdirSync(inboxDir(name));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        fs5.renameSync(path5.join(inboxDir(name), file), path5.join(ensureDir(inboxDir(selfId)), file));
      } catch {
      }
    }
  }
}
function readSession(id) {
  return readJson(path5.join(peerDir(id), "session.json"));
}
function slugify(value) {
  return value.normalize("NFKD").replace(new RegExp("(\\p{Script=Latin})\\p{M}+", "gu"), "$1").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40).replace(/[-.]+$/g, "");
}
function claudeSessionName(pid) {
  const record = readJson(path5.join(claudeConfigDir(), "sessions", `${pid}.json`));
  return typeof record?.name === "string" && record.name ? record.name : void 0;
}
function codexThreadName(codexHome, sessionId) {
  if (!sessionId) return void 0;
  let text;
  try {
    text = fs5.readFileSync(path5.join(codexHome, "session_index.jsonl"), "utf8");
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
  const folder = cwd ? slugify(path5.basename(cwd)) : "";
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
  const rec = readJson(path5.join(peerDir(peer.id), "hosted.json"));
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
function isPeerAlive(peer, now2 = Date.now()) {
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
    if (peer.agent === "opencode" || peer.agent === "kilo") return now2 - lastActivity(peer.id) < SERVICE_SESSION_ACTIVE_MS;
    return true;
  }
  return isSameProcess(peer.pid, peer.procStart);
}
function readPeer(id) {
  const m = PEER_DIR_RE.exec(id);
  if (!m) return void 0;
  const agent = m[1];
  const dir = peerDir(id);
  const session = readJson(path5.join(dir, "session.json"));
  const presence = readJson(path5.join(dir, "presence.json"));
  const listener = readJson(path5.join(dir, "listener.json"));
  if (!session && !presence) return void 0;
  const pid = session?.pid ?? presence?.pid ?? Number(m[2]);
  const cwd = session?.cwd || presence?.cwd;
  const codexHome = session?.codexHome || presence?.codexHome || defaultCodexHome();
  const generated = displayName(agent, pid, m[2], cwd);
  const identity = readJson(path5.join(dir, "identity.json"));
  const stable = identity?.name && slugify(identity.name) === identity.name ? identity.name : void 0;
  const name = stable || rememberedName(agent, session?.sessionId) || generated;
  const sessionKeyed = !!session?.sessionId && m[2] === sessionToken(session.sessionId);
  const aliases = [
    cwd ? slugify(path5.basename(cwd)) : "",
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
    toolHookRan: fs5.existsSync(path5.join(dir, "tool-hook.json")),
    aliases: [...new Set(aliases)].filter((a) => a && a !== slugify(name))
  };
}
function listPeers() {
  observeLaunchedCodex();
  let names = [];
  try {
    names = fs5.readdirSync(peersDir());
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
      if (!holdsUnread(name) && !keepsSession(peer)) fs5.rmSync(peerDir(name), { recursive: true, force: true });
      continue;
    }
    if (peer) peers.push(peer);
  }
  const threads = new Set(peers.filter(isThreadKeyed).map((p) => p.sessionId));
  const ids = new Set(peers.map((p) => p.id));
  return peers.filter((p) => {
    if (p.agent === "codex" && !isThreadKeyed(p) && !!p.sessionId && threads.has(p.sessionId)) return false;
    const link = readJson(path5.join(peerDir(p.id), "link.json"));
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
  const home2 = proc.codexHome ?? existing?.codexHome ?? defaultCodexHome();
  if (!existing?.sessionId || !hostAlive || proc.codexHome && existing.codexHome !== proc.codexHome) {
    registerSession("codex", proc.pid, {
      sessionId: threadId,
      cwd: cwd ?? existing?.cwd,
      source: existing?.source === "hook" || existing?.source === "meta" ? existing.source : "process",
      codexHome: home2
    });
  }
  if (peerId("codex", proc.pid) !== id) writeJsonAtomic(linkFile("codex", proc.pid), { id });
  linkCodexWrappers(proc, id);
}
function linkCodexWrappers(proc, id) {
  for (const wrapperPid of proc.wrapperPids ?? []) {
    const wrapperId = peerId("codex", wrapperPid);
    if (wrapperId === id) continue;
    if (!fs5.existsSync(path5.join(peerDir(wrapperId), "session.json"))) continue;
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
  const home2 = proc.codexHome || existing?.codexHome || defaultCodexHome();
  if (existing?.source === "process" && existing.pid === proc.pid && isSameProcess(proc.pid, existing.procStart) && existing.codexHome === home2 && (existing.cwd || !cwd)) {
    linkCodexWrappers(proc, id);
    return;
  }
  registerSession("codex", proc.pid, { cwd, source: "process", codexHome: home2 });
  linkCodexWrappers(proc, id);
}
function keptPeers() {
  let names = [];
  try {
    names = fs5.readdirSync(peersDir());
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

// src/cli/launch.ts
function pluginInstalled(agent) {
  const installs = agent === "copilot" ? findInstalls() : installsInScope();
  if (agent === "grok" || agent === "cursor") return installs.some((install) => install.agent === "claude");
  return installs.some((install) => install.agent === agent);
}
function harnessProvidesMcp(agent) {
  if (agent !== "copilot") return pluginInstalled(agent);
  return findInstalls().some(
    (install) => install.agent === "copilot" && install.dir.split(path6.sep).includes("installed-plugins")
  );
}
function launchEnv(agent, name) {
  const env = { ...process.env, TELEPATHY_HOME: stateDir() };
  if (name && pluginInstalled(agent)) {
    const slug = slugify(name);
    if (slug) env.TELEPATHY_NAME = slug;
  }
  if (agent === "claude") pointClaudeAtScopedPlugin(env);
  return env;
}
function pointClaudeAtScopedPlugin(env) {
  if (!isolatedStateRoots()) return;
  const install = installsInScope().find((item) => item.agent === "claude");
  if (!install) return;
  const dirs = (env.CLAUDE_CODE_PLUGIN_DIRS ?? "").split(path6.delimiter).filter(Boolean);
  if (!dirs.includes(install.dir)) env.CLAUDE_CODE_PLUGIN_DIRS = [install.dir, ...dirs].join(path6.delimiter);
}

// src/mcp-env.ts
var FORWARDED_ENV = [
  "TELEPATHY_HOME",
  "TELEPATHY_AUTO_UPDATE",
  "TELEPATHY_NAME",
  "TELEPATHY_DEBUG",
  "TELEPATHY_CODEX_BIN",
  "TELEPATHY_LATEST_VERSION",
  "TELEPATHY_VERSION_URL",
  "TELEPATHY_CONFIRM_WAIT",
  "TELEPATHY_CONFIRM_ABORT_MS",
  "TELEPATHY_CONFIRM_GRACE_MS",
  "TELEPATHY_CONFIRM_POLL_MS",
  "TELEPATHY_WAKE_DEBOUNCE_MS",
  "TELEPATHY_WAKE_DEBOUNCE_MAX_MS",
  "TELEPATHY_TRANSCRIPT_DIR",
  "TELEPATHY_HOLD_REPOST_DELAY_MS",
  "TELEPATHY_MANAGED_SETTINGS_DIR",
  "TELEPATHY_SOCKET_WAIT_MS",
  "TELEPATHY_AUTO_UPDATE_ENTRY",
  "TELEPATHY_CODEX_PROCS",
  "TELEPATHY_PS_BIN",
  "CODEX_HOME"
];
var MCP_ENV_EXACT = /* @__PURE__ */ new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "COPILOT_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  ...FORWARDED_ENV
]);
function mcpChildEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value) continue;
    if (key.startsWith("TELEPATHY_") || MCP_ENV_EXACT.has(key)) out[key] = value;
  }
  return out;
}

// src/core/confirm.ts
import fs11 from "node:fs";
import os6 from "node:os";
import path13 from "node:path";

// src/core/codex-activity.ts
import fs6 from "node:fs";
import path7 from "node:path";
var TAIL_STEPS = [1024 * 1024, 16 * 1024 * 1024];
var TURN_EVENTS = { task_started: "busy", task_complete: "idle", turn_aborted: "interrupted" };
function findRollout(codexHome, threadId) {
  const isRollout = (f) => f.startsWith("rollout-") && (f.endsWith(`-${threadId}.jsonl`) || f.includes(`-${threadId}_`) && f.endsWith(".jsonl"));
  const sorted = (dir) => {
    try {
      return fs6.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  const root = path7.join(codexHome, "sessions");
  for (const year of sorted(root)) {
    for (const month of sorted(path7.join(root, year))) {
      for (const day of sorted(path7.join(root, year, month))) {
        const dir = path7.join(root, year, month, day);
        const file = sorted(dir).find(isRollout);
        if (file) return path7.join(dir, file);
      }
    }
  }
  return void 0;
}
function readTail(file, bytes) {
  const fd = fs6.openSync(file, "r");
  try {
    const { size } = fs6.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs6.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return { text: start > 0 ? text.slice(text.indexOf("\n") + 1) : text, whole: start === 0 };
  } finally {
    fs6.closeSync(fd);
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
import path11 from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

// src/core/debug.ts
import fs7 from "node:fs";
import path8 from "node:path";
function debugLog(component, line) {
  if (process.env.TELEPATHY_DEBUG !== "1") return;
  try {
    ensureDir(stateDir());
    fs7.appendFileSync(path8.join(stateDir(), "debug.log"), `${(/* @__PURE__ */ new Date()).toISOString()} [${component} ${process.pid}] ${line}
`);
  } catch {
  }
}

// src/core/sandbox-launch.ts
import fs8 from "node:fs";
import os4 from "node:os";
import path9 from "node:path";
function inTestSandbox() {
  return process.env.TELEPATHY_SANDBOX === "1";
}
function realpathOr(file) {
  try {
    return fs8.realpathSync(file);
  } catch {
    return path9.resolve(file);
  }
}
function resolveOnPath(cmd, env = process.env) {
  if (cmd.includes("/") || cmd.includes("\\")) {
    const abs = path9.resolve(cmd);
    return fs8.existsSync(abs) ? abs : void 0;
  }
  for (const dir of (env.PATH ?? "").split(path9.delimiter)) {
    if (!dir) continue;
    const candidate = path9.join(dir, cmd);
    if (fs8.existsSync(candidate)) return candidate;
  }
  return void 0;
}
function sandboxAllowsExecutable(file) {
  if (!inTestSandbox()) return true;
  const resolved = realpathOr(file);
  const configured = process.env.TELEPATHY_CODEX_BIN;
  if (configured && realpathOr(configured) === resolved) return true;
  const tmp = realpathOr(os4.tmpdir());
  return resolved === tmp || resolved.startsWith(tmp + path9.sep);
}
function sandboxSpawnBlock(cmd, env = process.env) {
  if (!inTestSandbox()) return void 0;
  const resolved = resolveOnPath(cmd, env);
  if (!resolved || sandboxAllowsExecutable(resolved)) return void 0;
  return `refusing to run ${resolved} from a test sandbox`;
}

// src/core/messages.ts
import crypto from "node:crypto";
import fs9 from "node:fs";
import path10 from "node:path";

// src/core/tags.ts
var PEER_MESSAGE_TAG = "telepathy-peer-message";
function tagAttr(value) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
var escapeTelepathyTags = (text) => text.replace(/<(\/?telepathy-)/gi, "<\\$1");

// src/core/messages.ts
var ARCHIVE_KEEP = 200;
var MSG_FILE_RE = /^m-[0-9a-z]+-[0-9a-f]+\.json$/;
var partyOf = (peer) => ({ id: peer.id, agent: peer.agent, name: peer.name, address: peer.address });
function newMessageId() {
  return `m-${Date.now().toString(36).padStart(9, "0")}-${crypto.randomBytes(3).toString("hex")}`;
}
function writeToInbox(msg) {
  writeJsonAtomic(path10.join(inboxDir(msg.to.id), `${msg.id}.json`), msg);
}
function archiveMessage(msg) {
  writeJsonAtomic(path10.join(archiveDir(msg.to.id), `${msg.id}.json`), msg);
  pruneArchive(msg.to.id);
}
function deliveryBlocked(peerId2, msg, now2 = Date.now()) {
  if (fs9.existsSync(path10.join(withdrawnDir(peerId2), `${msg.id}.json`))) return true;
  return typeof msg.deliverBy === "number" && Number.isFinite(msg.deliverBy) && now2 >= msg.deliverBy;
}
function withdrawEverywhere(peerId2, messageId) {
  const file = `${messageId}.json`;
  const dest = path10.join(ensureDir(withdrawnDir(peerId2)), file);
  const sources = [path10.join(inboxDir(peerId2), file), path10.join(archiveDir(peerId2), file)];
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
    const msg = readJson(path10.join(inboxDir(peerId2), file));
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
  const dest = path10.join(ensureDir(archiveDir(peerId2)), `${id}.json`);
  for (const dir of [inboxDir(peerId2), withdrawnDir(peerId2)]) {
    try {
      fs9.renameSync(path10.join(dir, `${id}.json`), dest);
      return;
    } catch {
    }
  }
}
function pruneArchive(peerId2) {
  try {
    const files = fs9.readdirSync(archiveDir(peerId2)).filter((f) => MSG_FILE_RE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - ARCHIVE_KEEP))) {
      fs9.rmSync(path10.join(archiveDir(peerId2), f), { force: true });
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
  return ["codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex", path11.join(os5.homedir(), ".local", "bin", "codex")];
}
function sandboxCodexHomeBlock(codexHome) {
  if (!inTestSandbox()) return void 0;
  const home2 = codexHome || configuredEnv("CODEX_HOME");
  if (!home2 || outsideIsolatedHome(home2)) return `refusing to launch codex outside the test sandbox (${home2 ?? "CODEX_HOME unset"})`;
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
import path12 from "node:path";
var WAKE_DEBOUNCE_MS = 400;
var WAKE_DEBOUNCE_MAX_MS = 1500;
var DEFAULT_TIMEOUT_MS = 8e3;
var DEFAULT_AUTH_HEADERS = ["Authorization", "X-Automation-Key"];
var deliveryConfigPath = () => path12.join(stateDir(), "delivery.json");
var wakeLogPath = () => path12.join(stateDir(), "wake.log");
function wakeDebounceMs() {
  return envDurationMs("TELEPATHY_WAKE_DEBOUNCE_MS", WAKE_DEBOUNCE_MS);
}
function wakeDebounceMaxMs() {
  return Math.max(envDurationMs("TELEPATHY_WAKE_DEBOUNCE_MAX_MS", WAKE_DEBOUNCE_MAX_MS), wakeDebounceMs());
}
var wakeDir = () => path12.join(stateDir(), "wake");
var batchPath = (key) => path12.join(wakeDir(), `${key}.json`);
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
  const lock = path12.join(wakeDir(), ".lock");
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
      return fs10.existsSync(path12.join(inboxDir(item.peerId), `${item.id}.json`));
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
    return fs10.readdirSync(wakeDir()).filter((name) => name.endsWith(".json")).map((name) => path12.join(wakeDir(), name));
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
  const name = bin ? path12.basename(bin) : "command";
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
function confirmWindow(now2 = Date.now()) {
  const abort = confirmAbortMs();
  const grace = confirmGraceMs();
  if (toolCallStartedAt === void 0) return { abort, grace };
  const deadline = toolCallStartedAt + abort + grace;
  const left = Math.max(0, deadline - now2);
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
  const file = path13.join(peerDir(peer.id), "delivery-transcript.jsonl");
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
  const projects = path13.join(claudeConfigDir(), "projects");
  const name = `${peer.sessionId}.jsonl`;
  const files = /* @__PURE__ */ new Set();
  if (peer.cwd) {
    const slug = peer.cwd.replace(/[^A-Za-z0-9]/g, "-").slice(0, 200);
    files.add(path13.join(projects, slug, name));
  }
  if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CODE_PROJECT_DIR_NAME) {
    files.add(path13.join(projects, process.env.CLAUDE_CODE_PROJECT_DIR_NAME, name));
  }
  try {
    for (const dir of fs11.readdirSync(projects).slice(0, 80)) {
      files.add(path13.join(projects, dir, name));
    }
  } catch {
  }
  const existing = [...files].filter((file) => fs11.existsSync(file));
  if (!existing.length) return { located: false, found: false };
  return { located: true, found: existing.some((file) => fileHas(file, marker)) };
}
function codexTranscript(peer, marker) {
  if (!peer.sessionId) return { located: false, found: false };
  const home2 = peer.codexHome || process.env.CODEX_HOME || path13.join(os6.homedir(), ".codex");
  const file = findRollout(home2, peer.sessionId);
  if (!file) return { located: false, found: false };
  return { located: true, found: fileHas(file, marker) };
}
function opencodeTranscript(marker) {
  const xdg = process.env.XDG_DATA_HOME || path13.join(os6.homedir(), ".local", "share");
  const db = process.env.OPENCODE_DB || path13.join(xdg, "opencode", "opencode.db");
  const files = [db, `${db}-wal`];
  const legacy = path13.join(xdg, "opencode", "storage");
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
    const root = path13.join(os6.homedir(), ".gemini");
    for (const dir of ["antigravity-cli", "antigravity-ide", "antigravity"]) {
      files.push(path13.join(root, dir, "brain", peer.sessionId, ".system_generated", "logs", "transcript.jsonl"));
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
    const file = path13.join(dir, name);
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
    const msg = readJson(path13.join(dir, `${messageId}.json`));
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
    const tail2 = rest.length ? ` ${rest.join(" ")}` : "";
    return `Message failed: ${peerRef(peer)} is offline (session not running). ${copy}${tail2}`;
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

// src/cli/entry.ts
import fs12 from "node:fs";
function resolveArgvPath(entry) {
  if (!entry) return "";
  try {
    return fs12.realpathSync(entry);
  } catch {
    return entry;
  }
}

// src/acp/rpc.ts
var LineRpc = class {
  nextId = 1;
  buf = "";
  pending = /* @__PURE__ */ new Map();
  child;
  onRequest;
  onNotification;
  constructor(child, onRequest, onNotification) {
    this.child = child;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    child.stdout?.on("data", (chunk) => this.feed(chunk.toString()));
    child.on("exit", () => this.failAll("agent exited"));
    child.on("error", (err) => this.failAll(err.message));
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }
  fail(id, message) {
    this.send({ jsonrpc: "2.0", id, error: { code: -32e3, message } });
  }
  send(msg) {
    if (!this.child.stdin?.writable) {
      this.failAll("agent stdin is closed");
      return;
    }
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  failAll(message) {
    for (const waiter of this.pending.values()) waiter.reject(new Error(message));
    this.pending.clear();
  }
  feed(text) {
    this.buf += text;
    for (; ; ) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== void 0) {
        void Promise.resolve(this.onRequest(msg.method, msg.params, msg.id)).catch((err) => this.fail(msg.id, err.message));
      } else if (msg.method) {
        this.onNotification(msg.method, msg.params);
      } else if (msg.id !== void 0) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) continue;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message || "request failed"));
        else waiter.resolve(msg.result);
      }
    }
  }
};

// src/acp/host.ts
function telepathyMcpServers(agent, env = process.env) {
  if (harnessProvidesMcp(agent)) return [];
  const entry = mcpEntry();
  const args = entry.viaCli ? [entry.file, "mcp", "--agent", agent] : [entry.file, "--agent", agent];
  return [
    {
      type: "stdio",
      name: "telepathy",
      command: process.execPath,
      args,
      env: Object.entries(mcpChildEnv(env)).map(([name, value]) => ({ name, value }))
    }
  ];
}
function agentAuthMethod(initialized) {
  const methods = (initialized ?? {}).authMethods;
  if (!Array.isArray(methods)) return void 0;
  const own = methods.filter((raw) => {
    const m = raw ?? {};
    return typeof m.id === "string" && (m.type === void 0 || m.type === "agent") && !m._meta?.["terminal-auth"];
  });
  return own.length === 1 ? own[0].id : void 0;
}
function advertisesStdioMcp(result) {
  const root = result ?? {};
  const agentCaps = root.agentCapabilities ?? {};
  const raw = agentCaps.mcpCapabilities ?? root.mcpCapabilities;
  if (Array.isArray(raw)) return raw.some((item) => item === "stdio" || item === "local");
  if (!raw || typeof raw !== "object") return false;
  const flags = raw;
  return flags.stdio === true || flags.local === true;
}
function copilotCliMcp(agent, env) {
  if (agent !== "copilot" || harnessProvidesMcp(agent)) return void 0;
  const dir = fs13.mkdtempSync(path14.join(os7.tmpdir(), "telepathy-mcp-"));
  const file = path14.join(dir, "mcp.json");
  const entry = mcpEntry();
  const args = entry.viaCli ? [entry.file, "mcp", "--agent", agent] : [entry.file, "--agent", agent];
  const serverEnv = mcpChildEnv(env);
  fs13.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        telepathy: { type: "local", command: process.execPath, args, tools: ["*"], env: serverEnv }
      }
    })
  );
  fs13.chmodSync(file, 384);
  return {
    args: ["--additional-mcp-config", `@${file}`],
    cleanup: () => fs13.rmSync(dir, { recursive: true, force: true })
  };
}
function insertBeforeDoubleDash(args, extra) {
  if (!extra.length) return args;
  const end = args.indexOf("--");
  if (end < 0) return [...args, ...extra];
  return [...args.slice(0, end), ...extra, ...args.slice(end)];
}
function mcpEntry() {
  const override = process.env.TELEPATHY_MCP_ENTRY;
  if (override) return { file: override, viaCli: !override.endsWith("server.mjs") };
  const argv1 = process.argv[1];
  const resolved = argv1 ? resolveArgvPath(argv1) : "";
  if (resolved && /(?:^|[/\\])(?:telepathy|cli)\.(?:mjs|ts|js)$/.test(resolved)) return { file: path14.resolve(resolved), viaCli: true };
  const beside = path14.resolve(path14.dirname(fileURLToPath(import.meta.url)), "../../plugin/dist/server.mjs");
  if (fs13.existsSync(beside)) return { file: beside, viaCli: false };
  return { file: path14.resolve(resolved || argv1 || "telepathy"), viaCli: true };
}
function textOf(params) {
  const root = params ?? {};
  const update = root.update ?? root;
  const content = update.content ?? update.message?.content ?? root.content;
  if (typeof content === "string") return content;
  if (typeof update.text === "string") return update.text;
  if (content && typeof content === "object" && "text" in content && typeof content.text === "string") {
    return content.text;
  }
  if (Array.isArray(content)) {
    return content.map((block) => block && typeof block === "object" && "text" in block ? String(block.text ?? "") : "").filter(Boolean).join("");
  }
  return "";
}
function relevantUpdate(_params) {
  return true;
}
var PROMPT_MARKER = /telepathy-id:(m-[0-9a-z]+-[0-9a-f]+)/;
function promptMarker(text) {
  const match = PROMPT_MARKER.exec(text);
  return match ? `telepathy-id:${match[1]}` : void 0;
}
function copilotEventsHaveMarker(sessionId, marker) {
  const files = /* @__PURE__ */ new Set([copilotEventsFile(sessionId)]);
  const recorded2 = readSession(sessionPeerId("copilot", 0, sessionId))?.transcriptPath;
  if (recorded2 && !recorded2.includes("${")) files.add(recorded2);
  for (const file of files) {
    if (copilotLogHasMarker(file, marker)) return true;
  }
  return false;
}
function summarize(value) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return "";
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}
function describePermission(params) {
  const body = params ?? {};
  const tool = body.toolCall ?? {};
  const name = typeof tool.title === "string" && tool.title || typeof tool.kind === "string" && tool.kind || typeof body.title === "string" && body.title || typeof tool.toolCallId === "string" && tool.toolCallId || "tool";
  const input = summarize(tool.rawInput ?? tool.input);
  return input ? `${name} (${input})` : name;
}
function allowOption(params) {
  const options = (params ?? {}).options ?? [];
  const says = (option, re) => re.test(option.name ?? "") || re.test(option.optionId ?? "");
  const match = options.find((option) => option.kind === "allow_once") ?? options.find((option) => !option.kind?.startsWith("reject") && says(option, /allow/i) && !says(option, /always/i)) ?? options.find((option) => option.kind === "allow_always");
  return match?.optionId ?? options[0]?.optionId ?? "allow";
}
function sessionIdOf(result) {
  const body = result;
  const id = body?.sessionId ?? body?.session?.sessionId ?? body?.session?.id ?? body?.id;
  return typeof id === "string" && id ? id : void 0;
}
var AUTH_FAILURE = /not logged in|login required|authentication (?:failed|required)|please run \S+ login|unauthorized|invalid api key|credentials? (?:not found|missing|expired)/i;
async function startAcpSession(options) {
  const blocked = sandboxSpawnBlock(options.bin, options.env ?? process.env);
  if (blocked) throw new Error(blocked);
  const mcpEnv = options.env ?? process.env;
  const cliMcp = copilotCliMcp(options.agent, mcpEnv);
  const child = spawn3(options.bin, insertBeforeDoubleDash(options.args, cliMcp?.args ?? []), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  const stopChild = (signal) => {
    const pid = child.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
      }
    }
    if (child.exitCode === null && !child.killed) child.kill(signal);
  };
  let stderrTail = "";
  let sessionReady = false;
  let failure;
  let authReported = false;
  const noteStderr = (text) => {
    options.trace?.(text);
    stderrTail = (stderrTail + text).slice(-4e3);
    if (!AUTH_FAILURE.test(stderrTail)) return;
    failure = 1;
    if (sessionReady && !authReported) {
      authReported = true;
      options.emit(authMessage(options.bin, stderrTail));
    }
    stopChild("SIGTERM");
  };
  child.stderr?.on("data", (chunk) => noteStderr(chunk.toString()));
  let userStop = false;
  const exited = new Promise((resolve) => {
    child.on("error", () => {
      cliMcp?.cleanup();
      resolve(failure ?? 127);
    });
    child.on("exit", (code, signal) => {
      if (failure !== void 0) resolve(failure);
      else if (userStop) resolve(0);
      else resolve(signal ? 1 : code ?? 1);
    });
  });
  let ask;
  const clearAsk = () => {
    const pending = ask;
    ask = void 0;
    pending?.("");
  };
  const permission = async (params) => {
    const label = describePermission(params);
    if (options.askPermission) return options.askPermission(params, label);
    if (process.env.TELEPATHY_HEADLESS_APPROVE === "1" && (options.headless || !process.stdin.isTTY)) {
      options.emit(`allowed ${label}: TELEPATHY_HEADLESS_APPROVE=1 allows every permission.`);
      return true;
    }
    if (options.headless || !process.stdin.isTTY) {
      if (!options.headless && !process.stdin.isTTY) {
        options.emit(`permission requested: ${label}. Reply y or n.`);
        const line2 = await new Promise((resolve) => {
          ask = resolve;
        });
        ask = void 0;
        return /^y(es)?$/i.test(line2.trim());
      }
      options.emit(`permission rejected (${label}). Set TELEPATHY_HEADLESS_APPROVE=1 to allow every permission.`);
      return false;
    }
    options.emit(`permission requested: ${label}. Reply y or n.`);
    const line = await new Promise((resolve) => {
      ask = resolve;
    });
    ask = void 0;
    return /^y(es)?$/i.test(line.trim());
  };
  let endedWithNl = true;
  const writeText = (text) => {
    if (!text) return;
    if (options.stream) options.stream(text);
    else options.emit(text);
    endedWithNl = text.endsWith("\n");
  };
  const endText = () => {
    if (endedWithNl) return;
    writeText("\n");
  };
  let lastUpdate;
  const updateIdentity = (params) => {
    const root = params ?? {};
    const update = root.update ?? root;
    return {
      kind: typeof update.sessionUpdate === "string" ? update.sessionUpdate : "text",
      messageId: typeof update.messageId === "string" ? update.messageId : void 0
    };
  };
  let acceptDelivery;
  let onUpdate = (params) => {
    const text = textOf(params);
    const identity = updateIdentity(params);
    const newMessage = !!lastUpdate && !!text && (lastUpdate.kind !== identity.kind || !!identity.messageId && !!lastUpdate.messageId && identity.messageId !== lastUpdate.messageId);
    if (newMessage && !endedWithNl) writeText("\n");
    if (text) lastUpdate = identity;
    writeText(text);
  };
  const rpc = new LineRpc(
    child,
    async (method, params, id) => {
      if (method !== "session/request_permission") {
        rpc.fail(id, `telepathy does not handle ${method}`);
        return;
      }
      acceptDelivery?.();
      const allow = await permission(params);
      clearAsk();
      if (!allow) {
        rpc.respond(id, { outcome: { outcome: "cancelled" } });
        return;
      }
      rpc.respond(id, { outcome: { outcome: "selected", optionId: allowOption(params) } });
    },
    (method, params) => {
      if (method === "session/update") {
        options.onSessionUpdate?.(params);
        onUpdate(params);
      }
    }
  );
  let activeTurns = 0;
  let cancelledThisTurn = false;
  let rl;
  const releaseStdin = () => {
    const current = rl;
    rl = void 0;
    current?.close();
    setImmediate(() => {
      if (process.stdin.destroyed) return;
      process.stdin.pause();
      if (typeof process.stdin.unref === "function") process.stdin.unref();
    });
  };
  child.on("exit", () => {
    releaseStdin();
    cliMcp?.cleanup();
  });
  let session;
  const cancelTurn = () => {
    clearAsk();
    if (activeTurns === 0 || cancelledThisTurn || !sessionReady) return false;
    cancelledThisTurn = true;
    rpc.notify("session/cancel", { sessionId: session?.sessionId });
    return true;
  };
  let handlingSigint = false;
  const onSigint = () => {
    if (handlingSigint) return;
    handlingSigint = true;
    try {
      if (!cancelTurn()) {
        userStop = true;
        stopChild("SIGTERM");
        releaseStdin();
      }
    } finally {
      handlingSigint = false;
    }
  };
  if (!options.headless) {
    rl = readline2.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const text = line.trim();
      if (/^\/(?:exit|quit)$/i.test(text)) {
        clearAsk();
        userStop = true;
        stopChild("SIGTERM");
        releaseStdin();
        return;
      }
      if (ask) {
        const answer = ask;
        ask = void 0;
        answer(line);
        return;
      }
      if (text && session) void session.prompt(text);
    });
    rl.on("close", () => session?.close());
    rl.on("SIGINT", onSigint);
    process.on("SIGINT", onSigint);
  }
  try {
    if (failure !== void 0) {
      stopChild("SIGTERM");
      throw new Error(authMessage(options.bin, stderrTail));
    }
    const initialized = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "telepathy", version: VERSION }
    });
    if (failure !== void 0) throw new Error(authMessage(options.bin, stderrTail));
    const stdioOk = advertisesStdioMcp(initialized);
    const mcpServers = harnessProvidesMcp(options.agent) || cliMcp || !stdioOk ? [] : telepathyMcpServers(options.agent, mcpEnv);
    if (!harnessProvidesMcp(options.agent) && !cliMcp && !stdioOk) {
      options.emit(
        `${options.bin} does not accept stdio MCP servers, and telepathy has no command-line way to add one. This session has no telepathy tools.`
      );
    }
    let sessionId = options.resumeSessionId;
    let resumed = false;
    let created;
    if (sessionId) {
      const wanted = sessionId;
      try {
        const loaded = await rpc.request("session/load", { sessionId, cwd: options.cwd, mcpServers });
        created = loaded;
        sessionId = sessionIdOf(loaded) ?? wanted;
        resumed = sessionId === wanted;
      } catch {
        sessionId = void 0;
        resumed = false;
      }
    }
    if (!sessionId) {
      try {
        created = await rpc.request("session/new", { cwd: options.cwd, mcpServers });
      } catch (err) {
        const method = agentAuthMethod(initialized);
        if (!method || !/auth/i.test(err.message)) throw err;
        await Promise.race([
          rpc.request("authenticate", { methodId: method }),
          new Promise(
            (_, reject) => setTimeout(
              () => reject(new Error(`is not signed in: its sign-in (${method}) did not finish within 30s. Sign in with its own CLI first (for Grok, \`grok login\`)`)),
              3e4
            ).unref()
          )
        ]);
        created = await rpc.request("session/new", { cwd: options.cwd, mcpServers });
      }
      sessionId = sessionIdOf(created);
    }
    if (!sessionId) {
      stopChild("SIGTERM");
      throw new Error(`${options.bin} did not return a session id`);
    }
    sessionReady = true;
    options.emit(`session ${sessionId}`);
    let tail2 = Promise.resolve();
    session = {
      sessionId,
      child,
      resumed,
      created,
      request: (method, params) => rpc.request(method, params),
      busy: () => activeTurns > 0,
      cancelTurn,
      releaseStdin,
      prompt(text, stillPending2 = () => true, withdrawn) {
        const recalled = withdrawn ?? (() => !stillPending2());
        const marker = options.agent === "copilot" ? promptMarker(text) : void 0;
        const eventsProven = () => !!marker && copilotEventsHaveMarker(sessionId, marker);
        let resolveAccepted = () => {
        };
        const accepted = new Promise((resolve) => {
          resolveAccepted = resolve;
        });
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          resolveAccepted(ok);
        };
        const job = tail2.then(async () => {
          activeTurns += 1;
          cancelledThisTurn = false;
          const previous = onUpdate;
          let sent = false;
          let cancelSent = false;
          let turnResult;
          const cancel = () => {
            if (cancelSent || !sent || settled) return;
            cancelSent = true;
            clearAsk();
            rpc.notify("session/cancel", { sessionId });
          };
          const watch = setInterval(() => {
            if (settled || !sent) return;
            if (recalled()) cancel();
            else if (eventsProven()) finish(true);
          }, 25);
          try {
            if (!stillPending2() || recalled()) {
              finish(false);
              return;
            }
            onUpdate = (params) => {
              previous(params);
              if (recalled()) return;
              if (marker) {
                if (textOf(params).includes(marker) || eventsProven()) finish(true);
                return;
              }
              if (relevantUpdate(params)) finish(true);
            };
            acceptDelivery = () => {
              if (!recalled()) finish(true);
            };
            sent = true;
            if (!stillPending2() || recalled()) {
              finish(false);
              return;
            }
            const outcome = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
            turnResult = { stopReason: typeof outcome?.stopReason === "string" ? outcome.stopReason : void 0 };
            if (recalled()) {
              cancel();
              finish(false);
            } else if (!marker || eventsProven()) {
              finish(true);
            } else {
              while (!settled && !recalled()) {
                if (child.exitCode !== null || child.signalCode) break;
                if (eventsProven()) {
                  finish(true);
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              if (!settled) {
                if (recalled()) cancel();
                finish(false);
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const closed = message === "agent exited" || message === "agent stdin is closed";
            if (sent) turnResult = { error: message };
            if (!closed) {
              const auth = AUTH_FAILURE.test(message) || AUTH_FAILURE.test(stderrTail);
              options.emit(auth ? authMessage(options.bin, stderrTail || message) : message);
              if (auth) {
                failure = 1;
                stopChild("SIGTERM");
              }
            }
            finish(false);
          } finally {
            clearInterval(watch);
            onUpdate = previous;
            acceptDelivery = void 0;
            activeTurns = Math.max(0, activeTurns - 1);
            if (activeTurns === 0) options.onTurnSettled?.();
            clearAsk();
            endText();
            if (sent && turnResult) options.onTurnEnd?.(turnResult);
          }
        });
        tail2 = job.then(
          () => {
          },
          () => {
          }
        );
        return accepted;
      },
      close() {
        stopChild("SIGTERM");
        releaseStdin();
      },
      exited
    };
    return session;
  } catch (err) {
    if (!options.headless) process.off("SIGINT", onSigint);
    releaseStdin();
    stopChild("SIGTERM");
    const message = err instanceof Error ? err.message : String(err);
    const detail = stderrTail.trim().split("\n").filter(Boolean).at(-1);
    if (detail && !message.includes(detail)) throw new Error(`${message}: ${detail}`);
    throw err;
  }
}
function authMessage(bin, stderrTail) {
  const detail = stderrTail.trim().split("\n").filter(Boolean).at(-1);
  return detail ? `${bin} failed to authenticate: ${detail}` : `${bin} failed to authenticate`;
}

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
var harnessByAgent = (agent) => HARNESSES.find((h) => h.agent === agent);
function onPath(cmd, env = process.env) {
  try {
    execFileSync4(process.platform === "win32" ? "where" : "which", [cmd], { env, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function resolvedAcpBin(acp, env = process.env) {
  return [acp.bin, ...acp.fallbacks ?? []].find((bin) => onPath(bin, env));
}

// src/core/deliver.ts
import crypto3 from "node:crypto";
import fs15 from "node:fs";
import path17 from "node:path";

// src/core/claude-socket.ts
import fs14 from "node:fs";
import path15 from "node:path";
var SOCKET_LINE_MAX = 1024 * 1024;
var INBOUND_RANK = { accept: 0, hold: 1, refuse: 2 };
var socketFile = (id) => path15.join(peerDir(id), "socket.json");
var listenerFile = (id) => path15.join(peerDir(id), "socket-listener.json");
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
  if (process.platform === "win32") return path15.join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode");
  return "/etc/claude-code";
}
function managedInbound() {
  const dir = managedSettingsDir();
  let found = readInbound(path15.join(dir, "managed-settings.json"));
  let names = [];
  try {
    names = fs14.readdirSync(path15.join(dir, "managed-settings.d")).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  } catch {
  }
  for (const name of names) {
    const value = readInbound(path15.join(dir, "managed-settings.d", name));
    if (value) found = value;
  }
  return found;
}
function crossSessionInbound(peer) {
  const managed = managedInbound();
  const user = readInbound(path15.join(claudeConfigDir(), "settings.json"));
  const higher = managed ?? user;
  const project = peer?.cwd ? readInbound(path15.join(peer.cwd, ".claude", "settings.json")) : void 0;
  const local = peer?.cwd ? readInbound(path15.join(peer.cwd, ".claude", "settings.local.json")) : void 0;
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
import path16 from "node:path";
var OWN_SOURCE = ["claude", "codex", "opencode", "kilo"];
var statusFromHooks = (agent) => !OWN_SOURCE.includes(agent);
var statusFile = (id) => path16.join(peerDir(id), "status.json");
function writeStatus(id, status, now2 = Date.now()) {
  writeJsonAtomic(statusFile(id), { status, at: new Date(now2).toISOString() });
}
function recorded(id) {
  const record = readJson(statusFile(id));
  const at = record ? Date.parse(record.at) : Number.NaN;
  return record && typeof record.status === "string" && !Number.isNaN(at) ? { status: record.status, at } : void 0;
}
var CLAUDE_STATUSES = ["busy", "shell", "idle", "waiting"];
function claudeStatus(pid) {
  const record = readJson(path16.join(claudeConfigDir(), "sessions", `${pid}.json`));
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
  const base2 = token.replace(/^["']|["']$/g, "").split(/[/\\]/).pop() ?? "";
  if (base2 === "ps" || base2 === "(ps)") return true;
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

// src/bridge/crypto.ts
var SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

// src/core/deliver.ts
var DUPLICATE_WINDOW_MS = 2 * 6e4;
var RATE_WINDOW_MS = 10 * 6e4;
var RATE_MAX_PER_RECIPIENT = 20;
function socketWaitMs() {
  return envDurationMs("TELEPATHY_SOCKET_WAIT_MS", 1500);
}
var sentLogFile = (selfId) => path17.join(peerDir(selfId), "sent-log.json");
function checkRate(selfId, toId, body) {
  const now2 = Date.now();
  const log = (readJson(sentLogFile(selfId)) ?? []).filter((e) => now2 - e.at < RATE_WINDOW_MS);
  const hash = crypto3.createHash("sha256").update(body).digest("hex").slice(0, 16);
  const dup = log.find((e) => e.to === toId && e.hash === hash && now2 - e.at < DUPLICATE_WINDOW_MS);
  if (dup) {
    return `The same message was already sent to ${toId} ${Math.round((now2 - dup.at) / 1e3)}s ago. Don't resend; a reply will arrive as a new message.`;
  }
  if (log.filter((e) => e.to === toId).length >= RATE_MAX_PER_RECIPIENT) {
    return `Rate limit: ${RATE_MAX_PER_RECIPIENT} messages to ${toId} in the last ${RATE_WINDOW_MS / 6e4} minutes. Batch what's left into one message or wait.`;
  }
  return void 0;
}
function recordSent(selfId, toId, body) {
  const now2 = Date.now();
  const log = (readJson(sentLogFile(selfId)) ?? []).filter((e) => now2 - e.at < RATE_WINDOW_MS);
  log.push({ to: toId, hash: crypto3.createHash("sha256").update(body).digest("hex").slice(0, 16), at: now2 });
  writeJsonAtomic(sentLogFile(selfId), log);
}
var stillPending = (peerId2, messageId) => fs15.existsSync(path17.join(inboxDir(peerId2), `${messageId}.json`));
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
  if (fs15.existsSync(path17.join(peerDir(recipient.id), "hosted.json"))) return routeInbox(recipient, message);
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
function wakeStatus(recipient, base2, wake) {
  if (!wake) return base2;
  const ref = peerRef(recipient);
  const how = wake.how === "webhook" ? "webhook" : "delivery command";
  if (!wake.ok) return `${base2} The ${how} notification failed (${wake.detail}).`;
  if (wake.scheduled) {
    return `A ${how} wake for ${ref} is scheduled. ${base2} The ${how} body is a wake, not the message, and must be treated as untrusted.`;
  }
  return `Notified ${ref} by ${how}. ${base2} The ${how} body is a wake, not the message, and must be treated as untrusted.`;
}

// src/agent/worktree.ts
import { execFileSync as execFileSync5 } from "node:child_process";
function removeCleanWorktree(spec) {
  const tree = spec.worktree;
  if (!tree) return true;
  const git = (...args) => execFileSync5("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const dirty = git("-C", tree.path, "status", "--porcelain");
    const head = git("-C", tree.path, "rev-parse", "HEAD");
    if (dirty || head !== tree.base) return false;
    git("-C", tree.repo, "worktree", "remove", "--force", tree.path);
    git("-C", tree.repo, "branch", "-D", tree.branch);
    return true;
  } catch {
    return false;
  }
}

// src/headless/peer.ts
import fs16 from "node:fs";
import path18 from "node:path";
var headlessDir = () => path18.join(stateDir(), "headless");
var headlessRecordPath = (agent, slug) => path18.join(headlessDir(), `${agent}-${slug}.json`);
function writeHeadlessRecord(record) {
  writeJsonAtomic(headlessRecordPath(record.agent, record.slug), record);
}
function writeHosted(peerId2) {
  writeJsonAtomic(path18.join(peerDir(peerId2), "hosted.json"), {
    pid: process.pid,
    procStart: procStart(process.pid)
  });
}
function clearHosted(peerId2) {
  try {
    fs16.rmSync(path18.join(peerDir(peerId2), "hosted.json"), { force: true });
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
function claimPluginSession(agent, childPid, sessionId, cwd, name) {
  if (agent === "copilot") return claimCopilotSession(childPid, sessionId, cwd, name);
  const id = sessionPeerId(agent, childPid, sessionId);
  registerSession(agent, childPid, { sessionId, cwd, source: "plugin" });
  if (name) registerStableName(agent, id, name);
  registerListener(agent, childPid, id);
  return id;
}
function claimCopilotSession(spawnedPid, sessionId, cwd, name) {
  const id = bindCopilotSession(spawnedPid, sessionId, cwd, name);
  const home2 = process.env.TELEPATHY_HOME;
  for (const ms of [200, 800]) {
    const timer2 = setTimeout(() => {
      try {
        if (process.env.TELEPATHY_HOME !== home2) return;
        if (!readSession(id)) return;
        bindCopilotSession(spawnedPid, sessionId, cwd, name);
      } catch {
      }
    }, ms);
    timer2.unref();
  }
  return id;
}
function bindCopilotSession(spawnedPid, sessionId, cwd, name) {
  clearProcessListCache();
  const agentPid = resolveCopilotPid(spawnedPid);
  const id = sessionPeerId("copilot", agentPid, sessionId);
  const previous = readSession(id);
  registerSession("copilot", agentPid, {
    sessionId,
    cwd: cwd || previous?.cwd,
    source: previous?.source === "hook" ? "hook" : "plugin",
    transcriptPath: previous?.transcriptPath || copilotEventsFile(sessionId)
  });
  focusSessionOwner(id, agentPid);
  if (name) registerStableName("copilot", id, name);
  registerListener("copilot", agentPid, id);
  linkCopilotPlaceholders(spawnedPid, agentPid, id);
  return id;
}
function linkCopilotPlaceholders(spawnedPid, agentPid, sessionPeer) {
  const lines = commandLines(0);
  const table = processTable(0);
  for (const pid of descendantPids(spawnedPid)) {
    if (pid === agentPid) continue;
    const info = table.get(pid);
    const line = lines.get(pid) ?? "";
    const looksCopilot = !!info && isAgentProcess("copilot", info.comm, () => line);
    const listed = fs16.existsSync(peerDir(peerId("copilot", pid)));
    if (pid !== spawnedPid && !looksCopilot && !listed) continue;
    linkAgentProcess("copilot", pid, sessionPeer);
  }
}
function appendTranscript(peerId2, text) {
  const file = path18.join(ensureDir(peerDir(peerId2)), "delivery-transcript.jsonl");
  fs16.appendFileSync(file, JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), text }) + "\n");
}
function startInboxPump(peerId2, inject) {
  const resolve = typeof peerId2 === "function" ? peerId2 : () => peerId2;
  const done = /* @__PURE__ */ new Set();
  let running = false;
  let lastId;
  const tick = async () => {
    if (running) return;
    const id = resolve();
    if (!id) return;
    lastId = id;
    running = true;
    try {
      for (const msg of pendingMessages(id)) {
        if (done.has(msg.id)) continue;
        const file = path18.join(inboxDir(id), `${msg.id}.json`);
        const withdrawnFile = path18.join(withdrawnDir(id), `${msg.id}.json`);
        const pending = () => fs16.existsSync(file);
        const withdrawn = () => fs16.existsSync(withdrawnFile);
        if (!pending()) {
          done.add(msg.id);
          continue;
        }
        const text = formatAsUserTurn(msg);
        const ok = await inject(text, pending, withdrawn);
        if (withdrawn()) {
          done.add(msg.id);
          continue;
        }
        if (!ok) {
          if (!pending()) done.add(msg.id);
          else return;
          continue;
        }
        appendTranscript(id, text);
        if (pending()) archiveSettled(id, msg.id);
        done.add(msg.id);
      }
    } catch {
    } finally {
      running = false;
    }
  };
  const timer2 = setInterval(() => void tick(), 40);
  return () => {
    clearInterval(timer2);
    if (lastId) notePeerExit(lastId);
  };
}

// src/agent/configure.ts
function flatten(options) {
  if (!Array.isArray(options)) return [];
  return options.flatMap((item) => {
    const entry = item ?? {};
    if (Array.isArray(entry.options)) return flatten(entry.options);
    return typeof entry.value === "string" ? [{ value: entry.value, name: typeof entry.name === "string" ? entry.name : void 0 }] : [];
  });
}
function readOffer(created) {
  const root = created ?? {};
  const options = Array.isArray(root.configOptions) ? root.configOptions.flatMap((raw) => {
    const o = raw ?? {};
    return typeof o.id === "string" ? [{ id: o.id, category: typeof o.category === "string" ? o.category : void 0, options: flatten(o.options) }] : [];
  }) : [];
  const byCategory = (category) => options.find((o) => o.category === category) ?? options.find((o) => o.id === category);
  const offer = {};
  const mode = byCategory("mode");
  if (mode) offer.mode = { configId: mode.id, choices: mode.options };
  else if (root.modes?.availableModes?.length) {
    offer.mode = {
      choices: root.modes.availableModes.flatMap((m) => typeof m.id === "string" ? [{ value: m.id, name: typeof m.name === "string" ? m.name : void 0 }] : [])
    };
  }
  const model = byCategory("model");
  if (model) offer.model = { configId: model.id, choices: model.options };
  else if (root.models?.availableModels?.length) {
    offer.model = {
      choices: root.models.availableModels.flatMap((m) => typeof m.modelId === "string" ? [{ value: m.modelId, name: typeof m.name === "string" ? m.name : void 0 }] : [])
    };
  }
  const effort = options.find((o) => o.category === "thought_level");
  if (effort) offer.effort = { configId: effort.id, choices: effort.options };
  return offer;
}
var tail = (value) => value.toLowerCase().split(/[#/]/).pop() ?? "";
function autoMode(choices) {
  for (const wanted of ["auto", "autopilot", "smart"]) {
    const hit = choices.find((c) => tail(c.value) === wanted || c.name?.toLowerCase() === wanted);
    if (hit) return hit.value;
  }
  return void 0;
}
var base = (value) => value.toLowerCase().replace(/\[.*$/, "");
function pickModel(choices, wanted, effort) {
  const q = wanted.trim().toLowerCase();
  const exact = choices.filter((c) => c.value === wanted);
  if (exact.length === 1) return { value: exact[0].value };
  const tiers = [
    choices.filter((c) => c.value.toLowerCase() === q || c.name?.toLowerCase() === q || base(c.value) === q),
    choices.filter((c) => base(c.value).startsWith(q) || c.name?.toLowerCase().startsWith(q)),
    choices.filter((c) => base(c.value).includes(q) || c.name?.toLowerCase().includes(q))
  ];
  for (let matches of tiers) {
    if (!matches.length) continue;
    if (effort && matches.length > 1) {
      const e = effort.toLowerCase();
      const withEffort = matches.filter((c) => new RegExp(`(?:^|[,\\[])(?:effort|reasoning_effort|reasoning)=${e}(?:[,\\]]|$)`).test(c.value.toLowerCase()));
      if (withEffort.length) matches = withEffort;
    }
    const bases = new Set(matches.map((c) => base(c.value)));
    if (matches.length === 1 || bases.size === 1) return { value: matches[0].value };
    return { ambiguous: matches.map((c) => c.value) };
  }
  return {};
}
function pickEffort(choices, wanted) {
  const q = wanted.trim().toLowerCase();
  return choices.find((c) => c.value.toLowerCase() === q || c.name?.toLowerCase() === q)?.value;
}
async function applySettings(request, sessionId, created, wanted) {
  const offer = readOffer(created);
  const settings = [];
  const notes = [];
  const setOption = (configId, value) => request("session/set_config_option", { sessionId, configId, value });
  const auto = offer.mode ? autoMode(offer.mode.choices) : void 0;
  if (auto) {
    if (offer.mode?.configId) await setOption(offer.mode.configId, auto);
    else await request("session/set_mode", { sessionId, modeId: auto });
    settings.push(`mode ${tail(auto)}`);
  } else {
    notes.push("This harness has no auto mode, so each permission request it makes comes to you.");
  }
  let modelValue;
  if (wanted.model) {
    if (!offer.model?.choices.length) throw new Error(`this harness does not offer a model choice over ACP, so model "${wanted.model}" cannot be set`);
    const picked = pickModel(offer.model.choices, wanted.model, offer.effort ? void 0 : wanted.effort);
    if (picked.ambiguous) {
      throw new Error(`model "${wanted.model}" matches ${picked.ambiguous.length} models: ${picked.ambiguous.slice(0, 12).join(", ")}`);
    }
    if (!picked.value) {
      throw new Error(`no model matches "${wanted.model}". Available: ${offer.model.choices.slice(0, 40).map((c) => c.value).join(", ")}`);
    }
    modelValue = picked.value;
    if (offer.model.configId) await setOption(offer.model.configId, picked.value);
    else await request("session/set_model", { sessionId, modelId: picked.value });
    settings.push(`model ${picked.value}`);
  }
  if (wanted.effort) {
    if (offer.effort) {
      const value = pickEffort(offer.effort.choices, wanted.effort);
      if (!value) {
        throw new Error(`effort "${wanted.effort}" is not one of ${offer.effort.choices.map((c) => c.value).join(", ")}`);
      }
      await setOption(offer.effort.configId, value);
      settings.push(`effort ${value}`);
    } else if (!modelValue || !/[[,](?:effort|reasoning_effort|reasoning)=/.test(modelValue)) {
      notes.push(`This harness has no effort setting over ACP, so effort "${wanted.effort}" was not applied.`);
    }
  }
  return { settings, notes };
}

// src/agent/spec.ts
import path19 from "node:path";
var specFile = (dir) => path19.join(dir, "spec.json");
var stateFile = (dir) => path19.join(dir, "state.json");
var transcriptFile = (dir) => path19.join(dir, "transcript.md");
var permissionsDir = (dir) => path19.join(dir, "permissions");
var readSpec = (dir) => readJson(specFile(dir));
function writeState(dir, state) {
  ensureDir(dir);
  writeJsonAtomic(stateFile(dir), state);
}
var permissionRequestFile = (dir, id) => path19.join(permissionsDir(dir), `${id}.json`);
var permissionAnswerFile = (dir, id) => path19.join(permissionsDir(dir), `${id}.answer.json`);

// src/agent/host.ts
var SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PLUGIN_ROOT",
  "CODEX_THREAD_ID",
  "OPENCODE",
  "TELEPATHY_AGENT_PID",
  "TELEPATHY_NAME",
  ...AGENT_IDS.flatMap((agent) => agentSpec(agent).env ?? [])
];
var permissionWaitMs = () => envDurationMs("TELEPATHY_AGENT_PERMISSION_MS", 10 * 6e4);
var orphanMs = () => envDurationMs("TELEPATHY_AGENT_ORPHAN_MS", 10 * 6e4);
var now = () => (/* @__PURE__ */ new Date()).toLocaleTimeString();
var RESULT_RETRIES = 3;
var resultRetryMs = () => envDurationMs("TELEPATHY_AGENT_RESULT_RETRY_MS", 6e4);
async function runAgent(dir) {
  const spec = readSpec(dir);
  if (!spec) return 1;
  for (const name of SESSION_MARKERS) delete process.env[name];
  const state = { status: "starting", pid: process.pid, procStart: procStart(process.pid) };
  const save = () => writeState(dir, state);
  const fail = (error) => {
    if (spec.worktree) state.worktreeKept = !removeCleanWorktree(spec);
    state.status = "failed";
    state.error = error;
    save();
    return 1;
  };
  save();
  const harness = harnessByAgent(spec.harness);
  const bin = harness?.acp ? resolvedAcpBin(harness.acp) : void 0;
  if (!harness?.acp || !bin) return fail(`${spec.harness} has no ACP launcher on PATH`);
  const transcript = transcriptFile(dir);
  const out = fs17.createWriteStream(transcript, { flags: "a" });
  const write = (text) => out.write(text);
  const log = fs17.createWriteStream(path20.join(dir, "host.log"), { flags: "a" });
  const label = agentLabel(spec.harness);
  const notes = [];
  let segment = "";
  let segmentOpen = false;
  const onSessionUpdate = (params) => {
    const update = (params ?? {}).update ?? params;
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.type === "text" || typeof update.content?.text === "string" ? update.content?.text ?? "" : "";
      if (!text) return;
      if (!segmentOpen) {
        segment = "";
        segmentOpen = true;
        write(`

## ${label} \xB7 ${now()}

`);
      }
      segment += text;
      write(text);
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      segmentOpen = false;
      write(`

- tool: ${update.title ?? update.kind ?? update.toolCallId ?? "call"}${update.status ? ` (${update.status})` : ""}`);
      return;
    }
    if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
      segmentOpen = false;
      write(`
  - ${update.title ?? update.toolCallId ?? "call"}: ${update.status}`);
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "plan") segmentOpen = false;
  };
  let self;
  let pushes = Promise.resolve();
  let stopping = false;
  const deliver2 = async (from, body, kind) => {
    try {
      const result = await deliverLocal(from, spec.parent.id, body, void 0, { kind, transcript });
      if (!result.ok) write(`

> Not delivered to ${spec.parent.address}: ${result.error}
`);
      return result.ok;
    } catch (err) {
      write(`

> Not delivered to ${spec.parent.address}: ${err.message}
`);
      return false;
    }
  };
  const tellParent = (body, kind) => {
    const from = self;
    if (!from) return Promise.resolve(false);
    const sent = pushes = pushes.then(() => deliver2(from, body, kind));
    if (kind === "agent-result") {
      void sent.then(async (ok) => {
        for (let attempt = 1; !ok && attempt <= RESULT_RETRIES && !stopping; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, resultRetryMs()).unref());
          if (stopping) return;
          write(`
> Sending that result again (${attempt} of ${RESULT_RETRIES}).
`);
          ok = await deliver2(from, body, kind);
        }
      });
    }
    return sent;
  };
  const onTurnEnd = (result) => {
    const final = segment.trim();
    segment = "";
    segmentOpen = false;
    write(`

\u2014 turn ended${result.error ? `: ${result.error}` : result.stopReason ? `: ${result.stopReason}` : ""}
`);
    const why = result.error ? `The turn failed: ${result.error}.` : result.stopReason && result.stopReason !== "end_turn" ? `The turn stopped: ${result.stopReason}.` : "";
    const body = [final || "(The turn ended without a final message.)", why].filter(Boolean).join("\n\n");
    void tellParent(body, "agent-result");
  };
  const askPermission = async (_params, what) => {
    if (!self) return false;
    const id = `p-${Date.now().toString(36)}-${crypto4.randomBytes(2).toString("hex")}`;
    ensureDir(permissionsDir(dir));
    writeJsonAtomic(permissionRequestFile(dir, id), { id, label: what, at: (/* @__PURE__ */ new Date()).toISOString() });
    write(`

- permission requested: ${what} (asked ${spec.parent.address}, request ${id})`);
    let undeliverable = false;
    void tellParent(
      `${self.address} asks for permission: ${what}.
Ask your user, then call answer_permission with agent "${self.address}", request "${id}" and allow true or false. Without an answer within ${Math.round(permissionWaitMs() / 6e4)} minutes it is denied.`,
      "permission"
    ).then((ok) => {
      if (!ok) undeliverable = true;
    });
    const deadline = Date.now() + permissionWaitMs();
    while (Date.now() < deadline && !undeliverable) {
      const answer = readJson(permissionAnswerFile(dir, id));
      if (answer) {
        write(`
  - ${answer.allow ? "allowed" : "denied"} by ${spec.parent.address}`);
        return answer.allow === true;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    write(`
  - denied: ${undeliverable ? "the request could not be delivered" : "no answer in time"}`);
    return false;
  };
  write(
    `# ${label} agent: ${spec.description}

Started by ${spec.parent.address} [${spec.parent.id}] at ${(/* @__PURE__ */ new Date()).toISOString()}, in ${spec.cwd}.
`
  );
  let session;
  let peerId2;
  try {
    session = await startAcpSession({
      agent: spec.harness,
      bin,
      args: harness.acp.args,
      cwd: spec.cwd,
      headless: true,
      env: launchEnv(spec.harness, spec.slug),
      emit: (line) => {
        log.write(line.endsWith("\n") ? line : `${line}
`);
        if (/no telepathy tools/.test(line)) notes.push("It has no telepathy tools, so it cannot message other sessions. Its final message still reaches you.");
      },
      stream: () => {
      },
      trace: (line) => log.write(line),
      onSessionUpdate,
      onTurnEnd,
      askPermission,
      onTurnSettled: () => {
        if (peerId2) writeStatus(peerId2, "idle");
      }
    });
  } catch (err) {
    out.end();
    return fail(err.message);
  }
  try {
    const applied = await applySettings(session.request, session.sessionId, session.created, { model: spec.model, effort: spec.effort });
    state.settings = applied.settings;
    notes.push(...applied.notes);
  } catch (err) {
    session.close();
    out.end();
    return fail(err.message);
  }
  const pluginPeer = pluginInstalled(spec.harness);
  peerId2 = pluginPeer && session.child.pid ? claimPluginSession(spec.harness, session.child.pid, session.sessionId, spec.cwd, spec.slug) : registerHostedPeer(spec.harness, spec.cwd, spec.slug).peerId;
  const peer = readPeer(peerId2);
  self = { id: peerId2, agent: spec.harness, name: peer?.name ?? spec.slug, address: peer?.address ?? `${spec.harness}:${spec.slug}` };
  writeStatus(peerId2, "idle");
  writeHeadlessRecord({
    name: spec.slug,
    slug: spec.slug,
    agent: spec.harness,
    peerId: peerId2,
    pid: process.pid,
    procStart: state.procStart,
    cwd: spec.cwd,
    logFile: transcript,
    harnessSessionId: session.sessionId,
    startedAt: spec.createdAt
  });
  Object.assign(state, { status: "ready", peerId: peerId2, address: self.address, sessionId: session.sessionId, notes });
  save();
  const stopPump = startInboxPump(peerId2, (text, stillPending2, withdrawn) => {
    write(`

## Message \xB7 ${now()}

${text}`);
    return session.prompt(text, stillPending2, withdrawn);
  });
  const task = {
    id: newMessageId(),
    from: spec.parent,
    to: self,
    body: `${spec.prompt}

(You are an agent ${spec.parent.address} started with telepathy's start_agent for this task: ${spec.description}. Work on it on your own. When you are done, end your turn with your final report as your last message: telepathy delivers that message to ${spec.parent.address} with your transcript, so don't also send it with send_message. ${spec.parent.address} may send you follow-ups.)`,
    sentAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const taskText = formatAsUserTurn(task);
  write(`

## Task from ${spec.parent.address} \xB7 ${now()}

${taskText}`);
  void session.prompt(taskText);
  let goneSince;
  const watch = setInterval(() => {
    if (isPeerAlive(readPeer(spec.parent.id))) {
      goneSince = void 0;
      return;
    }
    goneSince ??= Date.now();
    if (Date.now() - goneSince > orphanMs()) {
      write(`

\u2014 stopped: ${spec.parent.address} has been gone for ${Math.round(orphanMs() / 6e4)} minutes
`);
      session.close();
    }
  }, 5e3);
  const shutdown = () => session.close();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await session.exited;
  stopping = true;
  clearInterval(watch);
  stopPump();
  await pushes.catch(() => void 0);
  if (!pluginPeer) clearHosted(peerId2);
  if (spec.worktree) state.worktreeKept = !removeCleanWorktree(spec);
  write(`

\u2014 stopped at ${(/* @__PURE__ */ new Date()).toISOString()}${state.worktreeKept ? `; its worktree ${spec.worktree?.path} (branch ${spec.worktree?.branch}) has changes and was kept` : ""}
`);
  await new Promise((resolve) => out.end(() => resolve()));
  log.end();
  state.status = "stopped";
  save();
  return 0;
}

// src/agent-main.ts
runAgent(process.argv[2] ?? "").then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`telepathy agent: ${err.stack ?? err}
`);
    process.exit(1);
  }
);
