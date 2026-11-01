import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);

// src/update-all.ts
import { spawn as spawn2 } from "node:child_process";
import fs6 from "node:fs";
import os5 from "node:os";
import path7 from "node:path";

// src/cli-self-update.ts
import { execFileSync } from "node:child_process";
import fs4 from "node:fs";
import path4 from "node:path";

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
function stateDir() {
  return configuredEnv("TELEPATHY_HOME") || path.join(os.homedir(), ".telepathy");
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
  const cache = path2.join(process.env.CODEX_HOME || path2.join(home(), ".codex"), "plugins", "cache");
  const found = list(cache).flatMap(
    (marketplace) => list(path2.join(cache, marketplace, "telepathy")).map((version) => ({
      agent: "codex",
      version,
      dir: path2.join(cache, marketplace, "telepathy", version),
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
function marketplaceDirs(file, base) {
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
    dirs.push(path2.resolve(base, body.path));
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
  const cache = path2.join(dataHome(), "devin", "cli", "plugins", "cache");
  const found = list(cache).filter((name) => /telepathy/i.test(name)).flatMap(
    (name) => list(path2.join(cache, name)).flatMap((version) => {
      const dir = path2.join(cache, name, version);
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
var isOpencodeNpmInstall = (install) => install.agent === "opencode" && install.dir.startsWith(path2.join(cacheHome(), "opencode", "npm") + path2.sep);
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

// src/core/sandbox-launch.ts
import fs3 from "node:fs";
import os3 from "node:os";
import path3 from "node:path";
function inTestSandbox() {
  return process.env.TELEPATHY_SANDBOX === "1";
}
function realpathOr(file) {
  try {
    return fs3.realpathSync(file);
  } catch {
    return path3.resolve(file);
  }
}
function resolveOnPath(cmd, env = process.env) {
  if (cmd.includes("/") || cmd.includes("\\")) {
    const abs = path3.resolve(cmd);
    return fs3.existsSync(abs) ? abs : void 0;
  }
  for (const dir of (env.PATH ?? "").split(path3.delimiter)) {
    if (!dir) continue;
    const candidate = path3.join(dir, cmd);
    if (fs3.existsSync(candidate)) return candidate;
  }
  return void 0;
}
function sandboxAllowsExecutable(file) {
  if (!inTestSandbox()) return true;
  const resolved = realpathOr(file);
  const configured = process.env.TELEPATHY_CODEX_BIN;
  if (configured && realpathOr(configured) === resolved) return true;
  const tmp = realpathOr(os3.tmpdir());
  return resolved === tmp || resolved.startsWith(tmp + path3.sep);
}
function sandboxSpawnBlock(cmd, env = process.env) {
  if (!inTestSandbox()) return void 0;
  const resolved = resolveOnPath(cmd, env);
  if (!resolved || sandboxAllowsExecutable(resolved)) return void 0;
  return `refusing to run ${resolved} from a test sandbox`;
}

// src/cli-self-update.ts
var PACKAGE = "telepathy-cli";
var registry = () => (process.env.TELEPATHY_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");
function globalCliDir() {
  if (inTestSandbox()) return void 0;
  let root;
  try {
    root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15e3, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return void 0;
  }
  const dir = path4.join(root, PACKAGE);
  try {
    const name = JSON.parse(fs4.readFileSync(path4.join(dir, "package.json"), "utf8")).name;
    return name === PACKAGE ? dir : void 0;
  } catch {
    return void 0;
  }
}
function installedVersion(dir) {
  try {
    const version = JSON.parse(fs4.readFileSync(path4.join(dir, "package.json"), "utf8")).version;
    return typeof version === "string" ? version : void 0;
  } catch {
    return void 0;
  }
}
async function latestCliVersion() {
  const res = await fetch(`${registry()}/${PACKAGE}/latest`, { signal: AbortSignal.timeout(8e3), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const version = (await res.json()).version;
  if (typeof version !== "string" || !version.trim()) throw new Error("npm registry has no version for telepathy-cli");
  return version.trim();
}
async function updateGlobalCli(options = {}) {
  const dir = globalCliDir();
  if (!dir) return void 0;
  const current = installedVersion(dir);
  let latest;
  try {
    latest = await latestCliVersion();
  } catch (err) {
    return { ok: false, line: `telepathy CLI: could not check npm (${err.message})` };
  }
  if (current && !isNewer(latest, current)) return { ok: true, line: `telepathy CLI: ${current}, current` };
  if (options.dryRun) return { ok: true, line: `telepathy CLI: \`npm install -g ${PACKAGE}@${latest}\` (installed ${current ?? "unknown"})` };
  const result = await runHarnessCommand({ cmd: "npm", args: ["install", "-g", `${PACKAGE}@${latest}`] });
  if (!result.ok) {
    const tail = result.output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "failed";
    return { ok: false, line: `telepathy CLI: npm install -g ${PACKAGE}@${latest} failed: ${tail}` };
  }
  return { ok: true, line: `telepathy CLI: ${current ?? "unknown"} \u2192 ${installedVersion(dir) ?? latest}` };
}

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

// src/core/codex-hooks.ts
import { spawn } from "node:child_process";
import os4 from "node:os";

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

// src/core/version.ts
var VERSION = true ? "0.11.2" : "0.0.0-dev";

// src/core/codex-hooks.ts
var timeoutMs = () => {
  const raw = Number(process.env.TELEPATHY_CODEX_HOOKS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3e4;
};
function codexBlocked() {
  const blocked = sandboxSpawnBlock("codex");
  if (blocked) return blocked;
  if (inTestSandbox()) {
    const home2 = configuredEnv("CODEX_HOME");
    if (!home2 || outsideIsolatedHome(home2)) return `refusing to run codex outside the test sandbox (${home2 ?? "CODEX_HOME unset"})`;
  }
  return void 0;
}
async function withAppServer(fn) {
  const blocked = codexBlocked();
  if (blocked) throw new Error(blocked);
  const child = spawn("codex", ["app-server"], { cwd: os4.homedir(), stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => {
  });
  const rpc = new LineRpc(
    child,
    (method, _params, id) => rpc.fail(id, `telepathy does not handle ${method}`),
    () => {
    }
  );
  let timer;
  const failed = new Promise((_, reject) => {
    child.on("error", (err) => {
      reject(err.code === "ENOENT" ? new Error("`codex` is not on PATH") : err);
    });
    timer = setTimeout(() => reject(new Error(`codex app-server did not answer within ${Math.round(timeoutMs() / 1e3)}s`)), timeoutMs());
  });
  const work = (async () => {
    await rpc.request("initialize", { clientInfo: { name: "telepathy", version: VERSION }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    return fn(rpc);
  })();
  try {
    return await Promise.race([work, failed]);
  } finally {
    if (timer) clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}
var isTelepathy = (hook) => typeof hook.pluginId === "string" && hook.pluginId.startsWith("telepathy@");
async function listHooks(rpc) {
  const result = await rpc.request("hooks/list", { cwds: [os4.homedir()] });
  const seen = /* @__PURE__ */ new Map();
  for (const entry of result?.data ?? []) {
    for (const raw of entry.hooks ?? []) {
      const hook = raw;
      if (!isTelepathy(hook) || typeof hook.key !== "string" || typeof hook.currentHash !== "string") continue;
      seen.set(hook.key, {
        key: hook.key,
        pluginId: hook.pluginId,
        eventName: String(hook.eventName ?? ""),
        trustStatus: hook.trustStatus ?? "untrusted",
        currentHash: hook.currentHash
      });
    }
  }
  return [...seen.values()];
}
async function trustTelepathyCodexHooks(statuses) {
  try {
    return await withAppServer(async (rpc) => {
      const hooks = await listHooks(rpc);
      const due = hooks.filter((hook) => statuses.includes(hook.trustStatus));
      const left = hooks.filter((hook) => !due.includes(hook));
      if (!due.length) return { trusted: [], left };
      const value = Object.fromEntries(due.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]));
      await rpc.request("config/batchWrite", { edits: [{ keyPath: "hooks.state", value, mergeStrategy: "upsert" }], reloadUserConfig: true });
      const after = await listHooks(rpc);
      const trusted = due.filter((hook) => after.find((next) => next.key === hook.key)?.trustStatus === "trusted");
      const missed = due.filter((hook) => !trusted.includes(hook));
      if (missed.length) {
        return { trusted, left: [...left, ...missed], error: `Codex still shows ${missed.map((h) => h.eventName || h.key).join(", ")} as not trusted` };
      }
      return { trusted, left };
    });
  } catch (err) {
    return { trusted: [], left: [], error: err.message };
  }
}

// src/core/kimi-plugin.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import fs5 from "node:fs";
import path5 from "node:path";
var ID = "telepathy";
var DEFAULT_SOURCE = "https://github.com/Winterrks/telepathy";
var githubWeb = () => (process.env.TELEPATHY_GITHUB_WEB || "https://github.com").replace(/\/$/, "");
var codeload = () => (process.env.TELEPATHY_GITHUB_CODELOAD || "https://codeload.github.com").replace(/\/$/, "");
function parseSource(source) {
  let url;
  try {
    url = new URL(source.trim());
  } catch {
    return void 0;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return void 0;
  const [owner, repoRaw, tree, ...rest] = url.pathname.split("/").filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/, "");
  if (!owner || !repo) return void 0;
  if (tree !== "tree" || !rest.length) return { owner, repo };
  const value = rest.join("/");
  return { owner, repo, ref: { kind: /^[0-9a-f]{40}$/i.test(value) ? "sha" : "branch", value } };
}
async function resolveRef(owner, repo, pinned) {
  if (pinned) return pinned;
  const res = await fetch(`${githubWeb()}/${owner}/${repo}/releases/latest`, { redirect: "manual", signal: AbortSignal.timeout(1e4) });
  if (res.status === 404) return { kind: "branch", value: "HEAD" };
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(res.headers.get("location") ?? "")?.[1];
  if ((res.status === 301 || res.status === 302) && tag) return { kind: "tag", value: decodeURIComponent(tag) };
  throw new Error(`could not look up the latest release of ${owner}/${repo}: HTTP ${res.status}`);
}
async function resolveSha(owner, repo, ref) {
  if (ref.kind === "sha") return ref.value.toLowerCase();
  const res = await fetch(`${githubWeb()}/${owner}/${repo}/commits/${ref.value.split("/").map(encodeURIComponent).join("/")}.atom`, {
    headers: { accept: "application/atom+xml", range: "bytes=0-4095" },
    signal: AbortSignal.timeout(1e4)
  });
  if (!res.ok) throw new Error(`could not resolve ${owner}/${repo}@${ref.value}: HTTP ${res.status}`);
  const sha = /Grit::Commit\/([0-9a-f]{40})/i.exec(await res.text())?.[1];
  if (!sha) throw new Error(`could not resolve ${owner}/${repo}@${ref.value} to a commit`);
  return sha.toLowerCase();
}
function readManifestVersion(root) {
  try {
    const version = JSON.parse(fs5.readFileSync(path5.join(root, ".kimi-plugin", "plugin.json"), "utf8")).version;
    return typeof version === "string" ? version : void 0;
  } catch {
    return void 0;
  }
}
function writeInstalled(plugins) {
  const dir = path5.join(kimiHome(), "plugins");
  fs5.mkdirSync(dir, { recursive: true });
  const final = path5.join(dir, "installed.json");
  fs5.writeFileSync(`${final}.tmp`, JSON.stringify({ version: 1, plugins }, null, 2), "utf8");
  fs5.renameSync(`${final}.tmp`, final);
}
async function installKimiPlugin(options = {}) {
  const home2 = kimiHome();
  if (outsideIsolatedHome(home2)) return { ok: false, output: `left unchanged: ${home2} is outside this TELEPATHY_HOME` };
  const installed = readKimiInstalled() ?? { version: 1, plugins: [] };
  const existing = installed.plugins.find((plugin) => plugin?.id === ID);
  if (existing && existing.source !== "github") {
    return { ok: true, output: `Kimi Code loads telepathy from ${existing.root} (${existing.source ?? "a local folder"}); update that copy yourself` };
  }
  const originalSource = existing?.originalSource || DEFAULT_SOURCE;
  const parsed = parseSource(originalSource) ?? parseSource(DEFAULT_SOURCE);
  const owner = existing?.github?.owner ?? parsed.owner;
  const repo = existing?.github?.repo ?? parsed.repo;
  try {
    const ref = await resolveRef(owner, repo, parsed.ref);
    const sha = await resolveSha(owner, repo, ref);
    const managed = path5.join(home2, "plugins", "managed", ID);
    const current = existing ? readManifestVersion(existing.root) : void 0;
    if (existing && existing.github?.installedSha === sha && current) {
      return { ok: true, output: `already at ${ref.value} (${sha.slice(0, 12)})`, version: current, changed: false };
    }
    if (options.dryRun) return { ok: true, output: `would download ${owner}/${repo}@${ref.value} (${sha.slice(0, 12)}) into ${managed}` };
    const parent = path5.dirname(managed);
    fs5.mkdirSync(parent, { recursive: true });
    const staging = fs5.mkdtempSync(path5.join(parent, `${ID}-`));
    const previous = `${staging}-previous`;
    const archive = `${staging}.tar.gz`;
    let moved = false;
    let published = false;
    try {
      const res = await fetch(`${codeload()}/${owner}/${repo}/tar.gz/${sha}`, { signal: AbortSignal.timeout(12e4) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      fs5.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      execFileSync2("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"], { stdio: "ignore" });
      const version = readManifestVersion(staging);
      if (!version) throw new Error("the download has no .kimi-plugin/plugin.json");
      try {
        fs5.renameSync(managed, previous);
        moved = true;
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      fs5.renameSync(staging, managed);
      published = true;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const entry = {
        id: ID,
        root: fs5.realpathSync(managed),
        source: "github",
        enabled: existing?.enabled ?? true,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        originalSource,
        capabilities: existing?.capabilities,
        github: { owner, repo, ref, installedSha: sha }
      };
      const plugins = existing ? installed.plugins.map((plugin) => plugin?.id === ID ? entry : plugin) : [...installed.plugins, entry];
      writeInstalled(plugins);
      if (moved) fs5.rmSync(previous, { recursive: true, force: true });
      const from = current && current !== version ? `${current} \u2192 ` : "";
      return { ok: true, output: `${existing ? "updated" : "installed"} ${from}${version} (${ref.value}, ${sha.slice(0, 12)})`, version, changed: true };
    } catch (err) {
      fs5.rmSync(published ? managed : staging, { recursive: true, force: true });
      if (moved) fs5.renameSync(previous, managed);
      throw err;
    } finally {
      fs5.rmSync(archive, { force: true });
      fs5.rmSync(staging, { recursive: true, force: true });
    }
  } catch (err) {
    return { ok: false, output: err.message };
  }
}

// src/version-check.ts
import path6 from "node:path";
var DEFAULT_URL = "https://raw.githubusercontent.com/Winterrks/telepathy/main/package.json";
var cacheFile = () => path6.join(stateDir(), "github-version.json");
function cachedGithubVersion() {
  return readJson(cacheFile())?.version;
}
async function latestGithubVersion() {
  const override = process.env.TELEPATHY_LATEST_VERSION?.trim();
  if (override) return override;
  const url = process.env.TELEPATHY_VERSION_URL?.trim() || DEFAULT_URL;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8e3),
    headers: { accept: "application/json", "user-agent": "telepathy-cli" }
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const body = await res.json();
  if (typeof body.version !== "string" || !body.version.trim()) throw new Error("GitHub package.json has no version");
  return body.version.trim();
}

// src/update-all.ts
var REPO = "https://github.com/Winterrks/telepathy";
var OPENCODE_SPEC = `telepathy@git+${REPO}.git`;
var STEP_TIMEOUT_MS = 18e4;
function stepsFor(install) {
  const marketplace = install.marketplace ?? "telepathy";
  switch (install.agent) {
    case "claude":
      return [
        { cmd: "claude", args: ["plugin", "marketplace", "update", marketplace] },
        { cmd: "claude", args: ["plugin", "update", `telepathy@${marketplace}`] }
      ];
    case "codex":
      return [{ cmd: "codex", args: ["plugin", "marketplace", "upgrade", marketplace] }];
    case "qwen":
      return [{ cmd: "qwen", args: ["extensions", "update", "telepathy"] }];
    case "copilot":
      return [{ cmd: "copilot", args: ["plugin", "update", `telepathy@${marketplace}`] }];
    case "devin":
      return [{ cmd: "devin", args: ["plugins", "update", "telepathy"] }];
    case "antigravity":
      return [{ cmd: "agy", args: ["plugin", "install", `${REPO}/tree/main/antigravity`] }];
    case "opencode":
      return isOpencodeNpmInstall(install) ? "opencode-npm" : "cache";
    case "kimi":
      return "kimi";
    default:
      return "cache";
  }
}
function runHarnessCommand({ cmd, args }, cwd = os5.homedir()) {
  const blocked = sandboxSpawnBlock(cmd);
  if (blocked) return Promise.resolve({ ok: false, output: blocked });
  if (cmd === "codex" && inTestSandbox()) {
    const home2 = configuredEnv("CODEX_HOME");
    if (!home2 || outsideIsolatedHome(home2)) {
      return Promise.resolve({ ok: false, output: `refusing to run codex outside the test sandbox (${home2 ?? "CODEX_HOME unset"})` });
    }
  }
  return new Promise((resolve) => {
    let output = "";
    const child = spawn2(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), STEP_TIMEOUT_MS);
    child.stdout.on("data", (d) => output += d);
    child.stderr.on("data", (d) => output += d);
    child.stdin.on("error", () => {
    });
    child.stdin.write("y\n".repeat(20));
    child.stdin.end();
    child.on("error", (err) => {
      clearTimeout(timer);
      const missing = err.code === "ENOENT";
      resolve({ ok: false, output: missing ? `\`${cmd}\` is not on PATH` : err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: code === null ? `timed out after ${STEP_TIMEOUT_MS / 1e3}s` : output });
    });
  });
}
async function refreshPackageCache(install) {
  const packages = path7.join(process.env.XDG_CACHE_HOME || path7.join(os5.homedir(), ".cache"), install.agent, "packages");
  const relative = path7.relative(packages, install.dir).split(path7.sep);
  const entry = path7.join(packages, ...install.agent === "kilo" ? relative.slice(0, 2) : relative.slice(0, 1));
  const aside = path7.join(path7.dirname(packages), `.telepathy-update-${Date.now()}`);
  fs6.renameSync(entry, aside);
  const result = await runHarnessCommand({ cmd: install.agent, args: ["debug", "config"] });
  const reinstalled = installsInScope().find((i) => i.agent === install.agent);
  if (reinstalled) {
    fs6.rmSync(aside, { recursive: true, force: true });
    return { ok: true, output: result.output };
  }
  fs6.rmSync(entry, { recursive: true, force: true });
  fs6.renameSync(aside, entry);
  return { ok: false, output: `it didn't reinstall telepathy, so the old copy was kept. ${result.output}` };
}
async function refreshOpencodeNpm(install) {
  const opencodeCache = path7.join(process.env.XDG_CACHE_HOME || path7.join(os5.homedir(), ".cache"), "opencode");
  const npm = path7.join(opencodeCache, "npm");
  const entry = path7.join(npm, path7.relative(npm, install.dir).split(path7.sep)[0] ?? "");
  const aside = path7.join(opencodeCache, `.telepathy-update-${Date.now()}`);
  fs6.renameSync(entry, aside);
  const result = await runHarnessCommand({ cmd: "opencode", args: ["plugin", "add", OPENCODE_SPEC] });
  const reinstalled = installsInScope().find((i) => i.agent === "opencode" && isOpencodeNpmInstall(i));
  if (reinstalled) {
    fs6.rmSync(aside, { recursive: true, force: true });
    return { ok: true, output: result.output };
  }
  fs6.rmSync(entry, { recursive: true, force: true });
  fs6.renameSync(aside, entry);
  return { ok: false, output: `it didn't reinstall telepathy, so the old copy was kept. ${result.output}` };
}
async function updateInstall(install) {
  const steps = stepsFor(install);
  if (steps === "cache") return refreshPackageCache(install);
  if (steps === "opencode-npm") return refreshOpencodeNpm(install);
  if (steps === "kimi") return installKimiPlugin();
  let result = { ok: true, output: "" };
  for (const step of steps) if ((result = await runHarnessCommand(step)).ok === false) break;
  return result;
}
function describeUpdate(install) {
  const steps = stepsFor(install);
  if (steps === "cache") return `clear its package cache and run \`${install.agent} debug config\` to reinstall`;
  if (steps === "opencode-npm") return `move its package folder aside and run \`opencode plugin add ${OPENCODE_SPEC}\` to reinstall`;
  if (steps === "kimi") return "download the latest release into ~/.kimi-code/plugins/managed/telepathy, as `/plugins install` does";
  return steps.map((s) => `\`${[s.cmd, ...s.args].join(" ")}\``).join(", then ");
}
async function retrustChangedCodexHooks(say) {
  const result = await trustTelepathyCodexHooks(["modified"]);
  if (result.trusted.length) say(`Codex: approved telepathy's ${result.trusted.length} updated hooks again.`);
  const untrusted = result.left.filter((hook) => hook.trustStatus === "untrusted").length;
  if (untrusted) say(`Codex: ${untrusted} telepathy hooks were never approved. Open /hooks in Codex, or run \`telepathy setup\`.`);
  if (result.error) {
    say(`Codex: could not check telepathy's hooks (${result.error}). If /hooks shows them changed, approve them there.`);
    return false;
  }
  return true;
}
var lastLine = (text) => text.split("\n").map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim()).filter(Boolean).at(-1) ?? "";
async function latestKnown() {
  if (process.env.TELEPATHY_LATEST_VERSION?.trim()) return process.env.TELEPATHY_LATEST_VERSION.trim();
  try {
    return await latestGithubVersion();
  } catch {
    return cachedGithubVersion();
  }
}
var alreadyCurrent = (install, latest) => !!latest && !isNewer(latest, install.version);
async function updateAll(options = {}) {
  const dryRun = options.dryRun === true;
  const log = options.log;
  const say = (line) => log ? log(line) : console.log(line);
  const before = installsInScope();
  const cliStep = async () => {
    if (options.cli === false) return true;
    const cli = await updateGlobalCli({ dryRun });
    if (cli) say(cli.line);
    return cli?.ok ?? true;
  };
  if (!before.length) {
    say("No agent on this machine has telepathy installed.");
    return await cliStep() ? 0 : 1;
  }
  const latest = await latestKnown();
  say(`telepathy is installed in: ${before.map((i) => `${agentLabel(i.agent)} ${i.version}`).join(", ")}.`);
  if (dryRun) {
    for (const install of before) {
      if (alreadyCurrent(install, latest)) {
        say(`- ${agentLabel(install.agent)}: already current`);
        continue;
      }
      say(`- ${agentLabel(install.agent)}: ${describeUpdate(install)}`);
    }
    return await cliStep() ? 0 : 1;
  }
  const failures = [];
  for (const install of before) {
    if (alreadyCurrent(install, latest)) {
      say(`Updating ${agentLabel(install.agent)}\u2026 already current`);
      continue;
    }
    if (log) log(`Updating ${agentLabel(install.agent)}\u2026`);
    else process.stdout.write(`Updating ${agentLabel(install.agent)}\u2026 `);
    const result = await updateInstall(install);
    if (result.ok) say("done");
    else {
      say(`failed: ${lastLine(result.output)}`);
      failures.push(agentLabel(install.agent));
    }
  }
  const after = installsInScope();
  let changed = false;
  say("\nInstalled versions:");
  for (const install of before) {
    const now = after.find((i) => i.agent === install.agent)?.version ?? "not found";
    if (install.version !== now) changed = true;
    say(`- ${agentLabel(install.agent)}: ${install.version === now ? now : `${install.version} \u2192 ${now}`}`);
  }
  if (changed) {
    say(
      '\nSessions that are already running keep the version they started with: restart them to load the update. Running Codex sessions show "Hook failed" after tool calls until they restart, because the update replaces the folder their hooks run from.'
    );
  }
  const codexBefore = before.find((i) => i.agent === "codex");
  const codexAfter = after.find((i) => i.agent === "codex");
  if (codexBefore && codexAfter && codexBefore.version !== codexAfter.version) await retrustChangedCodexHooks(say);
  const cliOk = await cliStep();
  if (failures.length) {
    say(`
Not updated: ${failures.join(", ")}. Run their own update command to see why.`);
    return 1;
  }
  return cliOk ? 0 : 1;
}
function invokedAsUpdateAll() {
  const entry = process.argv[1] ?? "";
  return /(?:^|[/\\])update-all\.(?:mjs|ts|js)$/.test(entry);
}
if (invokedAsUpdateAll()) {
  const code = await updateAll({ dryRun: process.argv.includes("--dry-run") });
  if (code !== 0) process.exitCode = code;
}
export {
  describeUpdate,
  latestKnown,
  retrustChangedCodexHooks,
  runHarnessCommand,
  updateAll,
  updateInstall
};
