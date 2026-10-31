import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);

// src/update-all.ts
import { spawn } from "node:child_process";
import fs4 from "node:fs";
import os4 from "node:os";
import path5 from "node:path";

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
    ...packageCache("kilo")
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

// src/version-check.ts
import path4 from "node:path";
var DEFAULT_URL = "https://raw.githubusercontent.com/Winterrks/telepathy/main/package.json";
var cacheFile = () => path4.join(stateDir(), "github-version.json");
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
      return isOpencodeNpmInstall(install) ? [{ cmd: "opencode", args: ["plugin", "update", `telepathy@git+${REPO}.git`] }] : "cache";
    default:
      return "cache";
  }
}
function runHarnessCommand({ cmd, args }, cwd = os4.homedir()) {
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
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
  const packages = path5.join(process.env.XDG_CACHE_HOME || path5.join(os4.homedir(), ".cache"), install.agent, "packages");
  const relative = path5.relative(packages, install.dir).split(path5.sep);
  const entry = path5.join(packages, ...install.agent === "kilo" ? relative.slice(0, 2) : relative.slice(0, 1));
  const aside = path5.join(path5.dirname(packages), `.telepathy-update-${Date.now()}`);
  fs4.renameSync(entry, aside);
  const result = await runHarnessCommand({ cmd: install.agent, args: ["debug", "config"] });
  const reinstalled = installsInScope().find((i) => i.agent === install.agent);
  if (reinstalled) {
    fs4.rmSync(aside, { recursive: true, force: true });
    return { ok: true, output: result.output };
  }
  fs4.rmSync(entry, { recursive: true, force: true });
  fs4.renameSync(aside, entry);
  return { ok: false, output: `it didn't reinstall telepathy, so the old copy was kept. ${result.output}` };
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
  if (!before.length) {
    say("No agent on this machine has telepathy installed.");
    return 0;
  }
  const latest = await latestKnown();
  say(`telepathy is installed in: ${before.map((i) => `${agentLabel(i.agent)} ${i.version}`).join(", ")}.`);
  if (dryRun) {
    for (const install of before) {
      if (alreadyCurrent(install, latest)) {
        say(`- ${agentLabel(install.agent)}: already current`);
        continue;
      }
      const steps = stepsFor(install);
      const how = steps === "cache" ? `clear its package cache and run \`${install.agent} debug config\` to reinstall` : steps.map((s) => `\`${[s.cmd, ...s.args].join(" ")}\``).join(", then ");
      say(`- ${agentLabel(install.agent)}: ${how}`);
    }
    return 0;
  }
  const failures = [];
  for (const install of before) {
    if (alreadyCurrent(install, latest)) {
      say(`Updating ${agentLabel(install.agent)}\u2026 already current`);
      continue;
    }
    if (log) log(`Updating ${agentLabel(install.agent)}\u2026`);
    else process.stdout.write(`Updating ${agentLabel(install.agent)}\u2026 `);
    const steps = stepsFor(install);
    let result = { ok: true, output: "" };
    if (steps === "cache") result = await refreshPackageCache(install);
    else for (const step of steps) if ((result = await runHarnessCommand(step)).ok === false) break;
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
  if (failures.length) {
    say(`
Not updated: ${failures.join(", ")}. Run their own update command to see why.`);
    return 1;
  }
  return 0;
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
  runHarnessCommand,
  updateAll
};
