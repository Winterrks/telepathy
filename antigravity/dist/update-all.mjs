import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);

// src/update-all.ts
import { spawn } from "node:child_process";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";

// src/core/agents.ts
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
var agentLabel = (agent) => SPECS[agent].label;
var AGENT_ALTERNATION = [...AGENT_IDS].sort((a, b) => b.length - a.length).join("|");

// src/core/installs.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var home = () => os.homedir();
var cacheHome = () => process.env.XDG_CACHE_HOME || path.join(home(), ".cache");
var dataHome = () => process.env.XDG_DATA_HOME || path.join(home(), ".local", "share");
function readVersion(file) {
  try {
    const version = JSON.parse(fs.readFileSync(file, "utf8")).version;
    return typeof version === "string" ? version : void 0;
  } catch {
    return void 0;
  }
}
function builtVersion(dir) {
  try {
    return /var VERSION = (?:true \? )?"(\d+\.\d+\.\d+[^"]*)"/.exec(fs.readFileSync(path.join(dir, "dist", "server.mjs"), "utf8"))?.[1];
  } catch {
    return void 0;
  }
}
var list = (dir) => {
  try {
    return fs.readdirSync(dir);
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
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
  let plugins = {};
  try {
    plugins = JSON.parse(fs.readFileSync(path.join(configDir, "plugins", "installed_plugins.json"), "utf8")).plugins ?? {};
  } catch {
    return [];
  }
  return Object.entries(plugins).filter(([key]) => key.startsWith("telepathy@")).flatMap(
    ([key, entries]) => (entries ?? []).filter((e) => e.version && e.installPath).map((e) => ({ agent: "claude", version: e.version, dir: e.installPath, marketplace: key.slice("telepathy@".length) }))
  );
}
function codex() {
  const cache = path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "plugins", "cache");
  const found = list(cache).flatMap(
    (marketplace) => list(path.join(cache, marketplace, "telepathy")).map((version) => ({
      agent: "codex",
      version,
      dir: path.join(cache, marketplace, "telepathy", version),
      marketplace
    }))
  );
  const newest = newestOf(found.filter((i) => /^\d+\.\d+\.\d+/.test(i.version)));
  return newest ? [newest] : [];
}
function extension(agent) {
  const dir = path.join(home(), `.${agent}`, "extensions", "telepathy");
  const version = readVersion(path.join(dir, `${agent}-extension.json`));
  return version ? [{ agent, version, dir }] : [];
}
function copilot() {
  const root = path.join(home(), ".copilot", "installed-plugins");
  return list(root).flatMap((marketplace) => {
    const dir = path.join(root, marketplace, "telepathy");
    const version = readVersion(path.join(dir, ".github", "plugin", "plugin.json"));
    return version ? [{ agent: "copilot", version, dir, marketplace }] : [];
  });
}
function devin() {
  const cache = path.join(dataHome(), "devin", "cli", "plugins", "cache");
  const found = list(cache).filter((name) => /telepathy/i.test(name)).flatMap(
    (name) => list(path.join(cache, name)).flatMap((version) => {
      const dir = path.join(cache, name, version);
      const manifest = readVersion(path.join(dir, ".devin-plugin", "plugin.json"));
      return manifest ? [{ agent: "devin", version: manifest, dir }] : [];
    })
  );
  const newest = newestOf(found);
  return newest ? [newest] : [];
}
function antigravity() {
  const dir = path.join(home(), ".gemini", "config", "plugins", "telepathy");
  const version = builtVersion(dir);
  return version ? [{ agent: "antigravity", version, dir }] : [];
}
function packageCache(agent) {
  const packages = path.join(cacheHome(), agent, "packages");
  const candidates = agent === "opencode" ? list(packages).filter((name) => name.startsWith("telepathy@")).flatMap((name) => {
    const found2 = [];
    const walk = (dir, depth) => {
      if (fs.existsSync(path.join(dir, "node_modules", "telepathy", "package.json"))) found2.push(path.join(dir, "node_modules", "telepathy"));
      else if (depth < 4) for (const sub of list(dir)) walk(path.join(dir, sub), depth + 1);
    };
    walk(path.join(packages, name), 0);
    return found2;
  }) : list(path.join(packages, "git")).filter((name) => /telepathy/i.test(name) && !name.endsWith(".json")).map((name) => path.join(packages, "git", name));
  const found = candidates.flatMap((dir) => {
    const version = readVersion(path.join(dir, "package.json"));
    return version ? [{ agent, version, dir }] : [];
  });
  const newest = newestOf(found);
  return newest ? [newest] : [];
}
function findInstalls() {
  return [
    ...claude(),
    ...codex(),
    ...extension("gemini"),
    ...extension("qwen"),
    ...copilot(),
    ...devin(),
    ...antigravity(),
    ...packageCache("opencode"),
    ...packageCache("kilo")
  ];
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
    case "gemini":
    case "qwen":
      return [{ cmd: install.agent, args: ["extensions", "update", "telepathy"] }];
    case "copilot":
      return [{ cmd: "copilot", args: ["plugin", "update", `telepathy@${marketplace}`] }];
    case "devin":
      return [{ cmd: "devin", args: ["plugins", "update", "telepathy"] }];
    case "antigravity":
      return [{ cmd: "agy", args: ["plugin", "install", `${REPO}/tree/main/antigravity`] }];
    default:
      return "cache";
  }
}
function run({ cmd, args }, cwd = os2.homedir()) {
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
  const packages = path2.join(process.env.XDG_CACHE_HOME || path2.join(os2.homedir(), ".cache"), install.agent, "packages");
  const relative = path2.relative(packages, install.dir).split(path2.sep);
  const entry = path2.join(packages, ...install.agent === "kilo" ? relative.slice(0, 2) : relative.slice(0, 1));
  const aside = path2.join(path2.dirname(packages), `.telepathy-update-${Date.now()}`);
  fs2.renameSync(entry, aside);
  const result = await run({ cmd: install.agent, args: ["debug", "config"] });
  const reinstalled = findInstalls().find((i) => i.agent === install.agent);
  if (reinstalled) {
    fs2.rmSync(aside, { recursive: true, force: true });
    return { ok: true, output: result.output };
  }
  fs2.rmSync(entry, { recursive: true, force: true });
  fs2.renameSync(aside, entry);
  return { ok: false, output: `it didn't reinstall telepathy, so the old copy was kept. ${result.output}` };
}
var lastLine = (text) => text.split("\n").map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim()).filter(Boolean).at(-1) ?? "";
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const before = findInstalls();
  if (!before.length) {
    console.log("No agent on this machine has telepathy installed.");
    return;
  }
  console.log(`telepathy is installed in: ${before.map((i) => `${agentLabel(i.agent)} ${i.version}`).join(", ")}.`);
  if (dryRun) {
    for (const install of before) {
      const steps = stepsFor(install);
      const how = steps === "cache" ? `clear its package cache and run \`${install.agent} debug config\` to reinstall` : steps.map((s) => `\`${[s.cmd, ...s.args].join(" ")}\``).join(", then ");
      console.log(`- ${agentLabel(install.agent)}: ${how}`);
    }
    return;
  }
  const failures = [];
  for (const install of before) {
    process.stdout.write(`Updating ${agentLabel(install.agent)}\u2026 `);
    const steps = stepsFor(install);
    let result = { ok: true, output: "" };
    if (steps === "cache") result = await refreshPackageCache(install);
    else for (const step of steps) if ((result = await run(step)).ok === false) break;
    if (result.ok) console.log("done");
    else {
      console.log(`failed: ${lastLine(result.output)}`);
      failures.push(agentLabel(install.agent));
    }
  }
  const after = findInstalls();
  console.log("\nInstalled versions:");
  for (const install of before) {
    const now = after.find((i) => i.agent === install.agent)?.version ?? "not found";
    console.log(`- ${agentLabel(install.agent)}: ${install.version === now ? now : `${install.version} \u2192 ${now}`}`);
  }
  console.log(
    '\nSessions that are already running keep the version they started with: restart them to load the update. Running Codex sessions show "Hook failed" after tool calls until they restart, because the update replaces the folder their hooks run from.'
  );
  if (failures.length) {
    console.log(`
Not updated: ${failures.join(", ")}. Run their own update command to see why.`);
    process.exitCode = 1;
  }
}
await main();
