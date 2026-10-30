import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);

// src/core/wake.ts
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs3 from "node:fs";
import path3 from "node:path";

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
function stateDir() {
  return configuredEnv("TELEPATHY_HOME") || path.join(os.homedir(), ".telepathy");
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 448 });
  return dir;
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

// src/core/wake.ts
var DEFAULT_TIMEOUT_MS = 8e3;
var DEFAULT_AUTH_HEADERS = ["Authorization", "X-Automation-Key"];
var deliveryConfigPath = () => path3.join(stateDir(), "delivery.json");
var wakeLogPath = () => path3.join(stateDir(), "wake.log");
function batchKey(target) {
  const material = JSON.stringify({ url: target.webhook?.url ?? "", command: target.command ?? [] });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}
function readDeliveryConfig() {
  const file = deliveryConfigPath();
  let mode;
  try {
    mode = fs3.statSync(file).mode & 511;
  } catch {
    return void 0;
  }
  if ((mode & 63) !== 0) {
    debugLog("wake", `delivery.json is mode ${mode.toString(8)}, not 600; webhook config was not loaded`);
    return void 0;
  }
  return readJson(file);
}
function configModeProblem() {
  const file = deliveryConfigPath();
  try {
    const mode = fs3.statSync(file).mode & 511;
    if ((mode & 63) !== 0) return `delivery.json is mode ${mode.toString(8)}, not 600; nothing was sent`;
    return void 0;
  } catch {
    return "delivery.json is not configured";
  }
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
    fs3.appendFileSync(wakeLogPath(), `${(/* @__PURE__ */ new Date()).toISOString()} ${safe}
`);
    fs3.chmodSync(wakeLogPath(), 384);
  } catch {
  }
  debugLog("wake", safe);
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
  const name = bin ? path3.basename(bin) : "command";
  if (!bin) {
    logFailure("command", name, "failed: command is empty", []);
    return Promise.resolve({ ok: false, how: "command", detail: "command is empty" });
  }
  return new Promise((resolve) => {
    const child = spawn(bin, argv.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
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
function listedTargets(config) {
  const out = [];
  if (config.webhook?.url || config.command?.length) {
    out.push({
      label: config.name?.trim() || "default",
      target: { webhook: config.webhook, command: config.command }
    });
  }
  for (const [key, target] of Object.entries(config.peers ?? {})) {
    if (target.webhook?.url || target.command?.length) out.push({ label: key, target });
  }
  const seen = /* @__PURE__ */ new Set();
  return out.filter((entry) => {
    const key = batchKey(entry.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function matchesName(label, config, which) {
  const wanted = which.trim().toLowerCase();
  const name = label.trim().toLowerCase();
  if (name === wanted) return true;
  const configured = config.name?.trim().toLowerCase();
  if (!configured || name !== configured) return false;
  return wanted === configured || wanted === `grok:${configured}` || wanted.endsWith(`:${configured}`);
}
async function probeDelivery(which) {
  const problem = configModeProblem();
  if (problem) return { reports: [], error: problem };
  const config = readDeliveryConfig();
  if (!config) return { reports: [], error: "delivery.json is not configured" };
  let targets = listedTargets(config);
  if (which) {
    targets = targets.filter((entry) => matchesName(entry.label, config, which));
    if (!targets.length) return { reports: [], error: `no webhook or command named ${which}` };
  }
  if (!targets.length) return { reports: [], error: "delivery.json has no webhook or command" };
  const reports = [];
  for (const entry of targets) {
    const result = await deliver(entry.target, { event: "probe" });
    const target = entry.target.webhook?.url ? hostOf(entry.target.webhook.url) : path3.basename(entry.target.command?.[0] ?? "command");
    reports.push({
      how: result.how,
      target,
      status: result.status,
      ok: result.ok,
      detail: result.detail ? scrub(result.detail, secretValues(entry.target.webhook)) : void 0
    });
  }
  return { reports };
}

// src/delivery.ts
function parse(argv) {
  const rest = argv[0] === "delivery" ? argv.slice(1) : argv;
  return { command: rest[0], name: rest[1] };
}
function formatProbe(report) {
  if (report.how === "webhook") {
    if (report.status !== void 0) return `webhook ${report.target} HTTP ${report.status}`;
    return `webhook ${report.target} failed: ${report.detail ?? "error"}`;
  }
  if (report.status !== void 0) return `command ${report.target} exited ${report.status}`;
  return `command ${report.target} failed: ${report.detail ?? "error"}`;
}
async function runDeliveryCli(argv) {
  const { command, name } = parse(argv);
  if (command !== "test") {
    return { code: 2, stdout: "", stderr: "usage: node delivery.mjs test [name]\n" };
  }
  const { reports, error } = await probeDelivery(name);
  if (error) return { code: 1, stdout: "", stderr: `${error}
` };
  const stdout = reports.map((report) => `${formatProbe(report)}
`).join("");
  return { code: reports.every((report) => report.ok) ? 0 : 1, stdout, stderr: "" };
}
var invoked = process.argv[1]?.endsWith("delivery.ts") || process.argv[1]?.endsWith("delivery.mjs");
if (invoked) {
  const result = await runDeliveryCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
export {
  formatProbe,
  runDeliveryCli
};
