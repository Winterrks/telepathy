import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { autoUpdateEnabled, runAutoUpdate, scheduleAutoUpdate } from '../src/auto-update.ts';
import { sendMessage } from '../src/core/deliver.ts';
import { installsInScope } from '../src/core/installs.ts';
import { configuredEnv, inboxDir, stateDir } from '../src/core/paths.ts';
import { configuredStableName, readPeer, registerSession } from '../src/core/peers.ts';
import { FORWARDED_ENV } from '../src/mcp-env.ts';
import { readHeadlessRecord } from '../src/headless/peer.ts';
import { parseRunArgs } from '../src/cli/run.ts';
import { ROOT, makeSandbox, type Sandbox } from './helpers.ts';

const CLI = path.join(ROOT, 'src', 'cli.ts');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-harness.mjs');
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'telepathy-bins-'));
const REAL_STATE = '/home/ubuntu/.telepathy';
const realStateBefore = fs.existsSync(REAL_STATE);

for (const name of ['claude', 'codex', 'opencode', 'kilo', 'agy', 'copilot', 'qwen', 'grok', 'devin', 'claude-agent-acp', 'claude-code-acp', 'codex-acp', 'antigravity-acp']) {
  const file = path.join(BIN_DIR, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.env.FAKE_ARGV0 = ${JSON.stringify(name)};\nimport(process.env.FAKE_HARNESS_FILE);\n`);
  fs.chmodSync(file, 0o755);
}

interface World {
  sb: Sandbox;
  env: NodeJS.ProcessEnv;
  logFile: string;
  restore: () => void;
  readLog: () => {
    cmd?: string;
    args?: string[];
    event?: string;
    method?: string;
    line?: string;
    params?: unknown;
    result?: unknown;
    url?: string;
    body?: string;
    cwd?: string;
    name?: string;
    home?: string;
    pluginDirs?: string;
  }[];
}

function world(extra: NodeJS.ProcessEnv = {}): World {
  const sb = makeSandbox();
  fs.mkdirSync(sb.env.HOME, { recursive: true });
  const logFile = path.join(path.dirname(sb.home), 'harness.jsonl');
  fs.writeFileSync(logFile, '');
  const previous = {
    TELEPATHY_HOME: process.env.TELEPATHY_HOME,
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    TELEPATHY_CONFIRM_WAIT: process.env.TELEPATHY_CONFIRM_WAIT,
    TELEPATHY_LATEST_VERSION: process.env.TELEPATHY_LATEST_VERSION,
  };
  process.env.TELEPATHY_HOME = sb.home;
  process.env.HOME = sb.env.HOME;
  process.env.CODEX_HOME = sb.codexHome;
  process.env.CLAUDE_CONFIG_DIR = sb.env.CLAUDE_CONFIG_DIR;
  process.env.XDG_CACHE_HOME = sb.env.XDG_CACHE_HOME;
  process.env.XDG_DATA_HOME = sb.env.XDG_DATA_HOME;
  process.env.TELEPATHY_LATEST_VERSION = '0.9.0';
  const env: NodeJS.ProcessEnv = {
    ...sb.env,
    PATH: `${BIN_DIR}${path.delimiter}${sb.env.PATH ?? ''}`,
    FAKE_HARNESS_LOG: logFile,
    FAKE_HARNESS_FILE: pathToFileURL(FAKE).href,
    TELEPATHY_LATEST_VERSION: '0.9.0',
    ...extra,
  };
  return {
    sb,
    env,
    logFile,
    readLog: () => {
      try {
        return fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ReturnType<World['readLog']>[number]);
      } catch {
        return [];
      }
    },
    restore: () => {
      sb.cleanup();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function plantClaude(sb: Sandbox): void {
  const dir = path.join(sb.env.CLAUDE_CONFIG_DIR, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'telepathy@telepathy': [{ version: '0.9.0', installPath: dir }] } }),
  );
}

function plantCodex(sb: Sandbox): void {
  fs.mkdirSync(path.join(sb.codexHome, 'plugins', 'cache', 'telepathy', 'telepathy', '0.9.0'), { recursive: true });
}

function plantCopilot(home: string): void {
  const dir = path.join(home, '.copilot', 'installed-plugins', 'telepathy', 'telepathy', '.github', 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'telepathy', version: '0.9.0' }));
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: 'utf8' });
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (err += chunk));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    child.on('exit', (code) => resolve({ code, out, err }));
  });
  return { child, done, out: () => out, err: () => err };
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function stop(env: NodeJS.ProcessEnv, name: string, done: Promise<unknown>, child: { kill: (signal?: NodeJS.Signals) => boolean }) {
  const stopped = run(['stop', name], env);
  const result = await Promise.race([
    done,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`stop hung: ${stopped.stderr}`)), 4000)),
  ]).catch((err) => {
    child.kill('SIGKILL');
    throw err;
  });
  return { stopped, result };
}

function sender() {
  registerSession('claude', process.pid, { sessionId: 'sender-1', cwd: '/work/sender', source: 'hook' });
  const self = readPeer('claude-sender-1');
  if (!self) throw new Error('sender peer missing');
  return self;
}

function confirmEnv(): void {
  process.env.TELEPATHY_CONFIRM_WAIT = '1';
  process.env.TELEPATHY_CONFIRM_ABORT_MS = '2000';
  process.env.TELEPATHY_CONFIRM_GRACE_MS = '200';
  process.env.TELEPATHY_CONFIRM_POLL_MS = '30';
}

test('parseRunArgs keeps harness flags after the agent', () => {
  const parsed = parseRunArgs(['--headless', '--name', 'box', 'claude', '--resume', 'abc']);
  assert.equal(parsed.headless, true);
  assert.equal(parsed.name, 'box');
  assert.equal(parsed.agent, 'claude');
  assert.deepEqual(parsed.userArgs, ['--resume', 'abc']);
  const after = parseRunArgs(['--headless', 'claude', '--name', 'box', '--cwd', '/tmp', 'extra']);
  assert.equal(after.name, 'box');
  assert.equal(after.cwd, '/tmp');
  assert.deepEqual(after.userArgs, ['extra']);
});

test('help, version, list, and an unknown agent', () => {
  const w = world();
  try {
    const help = run(['--help'], w.env);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /telepathy run/);
    assert.match(help.stdout, /--headless/);
    const version = run(['--version'], w.env);
    assert.equal(version.stdout.trim(), '0.0.0-dev');
    const list = run(['run', '--list'], w.env);
    assert.equal(list.status, 0);
    assert.match(list.stdout, /antigravity\s+passthrough/);
    assert.match(list.stdout, /headless: antigravity/);
    assert.match(list.stdout, /agy is an alias/);
    assert.doesNotMatch(list.stdout, /gemini/);
    assert.match(list.stdout, /headless: claude/);
    assert.match(list.stdout, /claude-agent-acp/);
    assert.doesNotMatch(list.stdout, /turn\.;/);
    const unknown = run(['run', 'not-an-agent'], w.env);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown agent/);
  } finally {
    w.restore();
  }
});

test('passthrough execs the vendor CLI with its arguments, cwd, exit code, and a delivery note', () => {
  const w = world();
  plantClaude(w.sb);
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-cwd-'));
    const result = run(['run', '--cwd', cwd, 'claude', '--', '--resume', 'sess'], { ...w.env, FAKE_EXIT_CODE: '4' });
    assert.equal(result.status, 4);
    const start = w.readLog().find((entry) => entry.event === 'start' && entry.args?.includes('--resume'));
    assert.ok(start);
    assert.equal(fs.realpathSync(start.cwd ?? ''), fs.realpathSync(cwd));
    assert.deepEqual(start?.args, ['--resume', 'sess']);
    const grok = run(['run', 'grok'], w.env);
    assert.equal(grok.status, 0);
    assert.match(grok.stderr, /Grok wakes an idle session only after/);
    const qwen = run(['run', 'qwen'], w.env);
    assert.match(qwen.stderr, /Qwen Code cannot wake/);
  } finally {
    w.restore();
  }
});

test('SIGTERM is forwarded to the vendor process', async () => {
  const w = world();
  plantClaude(w.sb);
  const launched = spawnCli(['run', 'claude', '--', '--sleep'], w.env);
  try {
    await waitFor(() => w.readLog().some((entry) => entry.args?.includes('--sleep')));
    process.kill(launched.child.pid as number, 'SIGTERM');
    const result = await launched.done;
    assert.equal(result.code, 0);
  } finally {
    if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
    w.restore();
  }
});

test('install --dry-run prints official commands and does not run them', () => {
  const w = world();
  try {
    const result = run(['install', '--dry-run', '--only', 'claude,kimi'], w.env);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /claude plugin marketplace add Winterrks\/telepathy/);
    assert.match(result.stdout, /plugin install telepathy@telepathy/);
    assert.match(result.stdout, /\/plugins install/);
    assert.doesNotMatch(result.stdout, /OpenCode|Antigravity|Copilot/);
    assert.equal(w.readLog().length, 0);
    const equals = run(['install', '--dry-run', '--only=kilo'], w.env);
    assert.match(equals.stdout, /kilo\.json/);
    assert.doesNotMatch(equals.stdout, /claude plugin/);
    const bad = run(['install', '--only', 'nope'], w.env);
    assert.equal(bad.status, 1);
  } finally {
    w.restore();
  }
});

test('status and config stay inside TELEPATHY_HOME', async () => {
  const w = world();
  try {
    const status = run(['status'], w.env);
    assert.equal(status.status, 0);
    assert.match(status.stdout, /latest on GitHub: 0\.9\.0/);
    assert.match(status.stdout, new RegExp(w.sb.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const doctor = run(['doctor'], w.env);
    assert.match(doctor.stdout, /Harness CLIs on PATH/);
    assert.match(doctor.stdout, /Claude Code: claude/);
    const off = run(['config', 'auto-update', 'off'], w.env);
    assert.equal(off.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.sb.home, 'config.json'), 'utf8')).autoUpdate, false);
    process.env.TELEPATHY_AUTO_UPDATE = '1';
    process.env.TELEPATHY_LATEST_VERSION = '0.9.0';
    await runAutoUpdate();
    assert.ok(fs.existsSync(path.join(w.sb.home, 'auto-update.json')));
    const marker = path.join(path.dirname(w.sb.home), 'marker');
    const stub = path.join(path.dirname(w.sb.home), 'stub.mjs');
    fs.writeFileSync(stub, `import fs from 'node:fs'; fs.writeFileSync(process.env.MARKER, 'yes');\n`);
    process.env.TELEPATHY_AUTO_UPDATE_ENTRY = stub;
    process.env.MARKER = marker;
    scheduleAutoUpdate('test');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.existsSync(marker), false);
    fs.rmSync(path.join(w.sb.home, 'auto-update.json'), { force: true });
    scheduleAutoUpdate('test');
    await waitFor(() => (fs.existsSync(marker) ? true : undefined));
    assert.equal(autoUpdateEnabled(), true);
  } finally {
    delete process.env.MARKER;
    delete process.env.TELEPATHY_AUTO_UPDATE_ENTRY;
    w.restore();
  }
});

test('headless claude stays reachable, confirms, resumes, and is offline after stop', async () => {
  const w = world();
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'box', 'claude'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    await waitFor(() => (readHeadlessRecord('claude', 'box')?.harnessSessionId === 'sess-claude-1' ? true : undefined));
    const record = readHeadlessRecord('claude', 'box');
    assert.ok(record);
    assert.match(fs.readFileSync(record.logFile, 'utf8'), /session_id/);
    assert.doesNotMatch(launched.out(), /session_id/);
    const self = sender();
    const sent = await sendMessage(self, 'claude:box', 'hello from the test');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    assert.ok(w.readLog().some((entry) => entry.event === 'stdin' && entry.line?.includes('telepathy-id:')));
    const transcript = path.join(w.sb.home, 'peers', 'claude-h-box', 'delivery-transcript.jsonl');
    assert.match(fs.readFileSync(transcript, 'utf8'), /telepathy-id:/);
    await stop(w.env, 'box', launched.done, launched.child);
    const started = Date.now();
    const late = await sendMessage(self, 'claude:box', 'too late');
    assert.ok(Date.now() - started < 1000);
    assert.equal(late.ok, false);
    if (!late.ok) assert.match(late.error, /offline[\s\S]*Nothing was left in its inbox/);
    assert.equal(fs.existsSync(inboxDir('claude-h-box')) ? fs.readdirSync(inboxDir('claude-h-box')).length : 0, 0);
    const again = spawnCli(['run', '--headless', '--name', 'box', 'claude'], w.env);
    try {
      await waitFor(() => (w.readLog().some((entry) => entry.args?.includes('--resume') && entry.args?.includes('sess-claude-1')) ? true : undefined));
      const listed = run(['ps'], w.env);
      assert.match(listed.stdout, /box\tclaude\tclaude-h-box/);
    } finally {
      await stop(w.env, 'claude:box', again.done, again.child);
    }
  } finally {
    if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
    w.restore();
  }
});

test('headless codex uses app-server turns and is offline once the supervisor exits', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.sb.codexHome, 'thread-writer-locks'), { recursive: true });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'thread', 'codex'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const sent = await sendMessage(self, 'codex:thread', 'steer this');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    assert.ok(w.readLog().some((entry) => entry.method === 'thread/start'));
    assert.ok(w.readLog().some((entry) => entry.method === 'turn/start' && JSON.stringify(entry.params).includes('telepathy-id:')));
    await stop(w.env, 'thread', launched.done, launched.child);
    const late = await sendMessage(self, 'codex:thread', 'after');
    assert.equal(late.ok, false);
    if (!late.ok) assert.match(late.error, /Nothing was left in its inbox/);
    const again = spawnCli(['run', '--headless', '--name', 'thread', 'codex'], w.env);
    try {
      await waitFor(() => (w.readLog().some((entry) => entry.method === 'thread/resume') ? true : undefined));
    } finally {
      await stop(w.env, 'codex:thread', again.done, again.child);
    }
  } finally {
    if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
    w.restore();
  }
});

test('headless opencode prompts the served session', async () => {
  const w = world();
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'serve', 'opencode'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const sent = await sendMessage(self, 'opencode:serve', 'via http');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    assert.ok(w.readLog().some((entry) => entry.event === 'http' && entry.url?.endsWith('/prompt') && entry.body?.includes('telepathy-id:')));
  } finally {
    await stop(w.env, 'serve', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('headless ACP adds telepathy only when that harness has no install, and confirms on an early update', async () => {
  const w = world({ FAKE_ACP_HOLD_MS: '4000' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'gem', 'copilot'], w.env);
  try {
    await waitFor(() => (w.readLog().some((entry) => entry.method === 'session/new') ? true : undefined));
    const created = w.readLog().find((entry) => entry.method === 'session/new');
    const servers = (created?.params as { mcpServers?: { type?: string; command?: string; env?: { name: string }[] }[] })?.mcpServers;
    assert.equal(servers?.length, 1);
    assert.equal(servers?.[0]?.type, 'stdio');
    assert.equal(servers?.[0]?.command, process.execPath);
    assert.ok(servers?.[0]?.env?.some((item) => item.name === 'HOME'));
    assert.ok(servers?.[0]?.env?.some((item) => item.name === 'TELEPATHY_HOME'));
    const self = sender();
    const started = Date.now();
    const sent = await sendMessage(self, 'copilot:gem', 'early update');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    assert.ok(Date.now() - started < 3000);
  } finally {
    await stop(w.env, 'gem', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('a failed headless send drops an ACP prompt that is still queued', async () => {
  const w = world({ FAKE_ACP_HOLD_MS: '4000' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'gem', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const first = await sendMessage(self, 'copilot:gem', 'first turn');
    assert.equal(first.ok, true, first.ok ? '' : first.error);
    const second = await sendMessage(self, 'copilot:gem', 'queued turn');
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.error, /Message failed/);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const prompts = w.readLog().filter((entry) => entry.method === 'session/prompt');
    assert.equal(prompts.length, 1);
    assert.match(JSON.stringify(prompts[0]?.params), /first turn/);
    assert.equal(JSON.stringify(w.readLog()).includes('queued turn'), false);
    const record = readHeadlessRecord('copilot', 'gem');
    assert.ok(record);
    const dir = inboxDir(record.peerId);
    assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
  } finally {
    await stop(w.env, 'gem', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('an installed ACP harness gets an empty mcpServers list', async () => {
  const w = world();
  plantCopilot(w.env.HOME as string);
  const launched = spawnCli(['run', '--headless', '--name', 'gem', 'copilot'], w.env);
  try {
    await waitFor(() => (w.readLog().some((entry) => entry.method === 'session/new') ? true : undefined));
    const created = w.readLog().find((entry) => entry.method === 'session/new');
    const servers = (created?.params as { mcpServers?: unknown[] })?.mcpServers;
    assert.deepEqual(servers, []);
    const started = w.readLog().find((entry) => entry.event === 'start' && entry.cmd === 'copilot');
    assert.equal(started?.name, 'gem');
    assert.equal(fs.existsSync(path.join(w.sb.home, 'peers', 'copilot-h-gem', 'hosted.json')), false);
  } finally {
    await stop(w.env, 'gem', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('a headless permission names the tool and is not described as allow once', async () => {
  const w = world({ FAKE_ACP_PERMISSION: '1' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'perm', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const sent = await sendMessage(self, 'copilot:perm', 'needs a yes');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    await waitFor(() => (launched.out().includes('shell') ? true : undefined));
    assert.match(launched.out(), /shell/);
    assert.match(launched.out(), /ls/);
    assert.match(launched.out(), /allow every permission/);
    assert.doesNotMatch(launched.out(), /allow once/);
    await waitFor(() => (JSON.stringify(w.readLog()).includes('"outcome":"cancelled"') ? true : undefined));
  } finally {
    await stop(w.env, 'perm', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('TELEPATHY_HEADLESS_APPROVE allows every permission, not one', async () => {
  const w = world({ FAKE_ACP_PERMISSION: '1', TELEPATHY_HEADLESS_APPROVE: '1' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'perm', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const sent = await sendMessage(self, 'copilot:perm', 'allowed');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    await waitFor(() => (launched.out().includes('allows every permission') ? true : undefined));
    assert.match(launched.out(), /shell/);
    assert.match(launched.out(), /allows every permission/);
    assert.doesNotMatch(launched.out(), /allow once/);
    await waitFor(() => (JSON.stringify(w.readLog()).includes('"outcome":"selected"') ? true : undefined));
  } finally {
    await stop(w.env, 'perm', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('interactive ACP takes a stdin prompt and exits when stdin closes', async () => {
  const w = world();
  const launched = spawnCli(['run', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.out().includes('session ') ? true : undefined));
    launched.child.stdin.write('hello interactive\n');
    await waitFor(() =>
      w.readLog().some((entry) => entry.method === 'session/prompt' && JSON.stringify(entry.params).includes('hello interactive')) ? true : undefined,
    );
    launched.child.stdin.end();
    const result = await launched.done;
    assert.equal(result.code, 0);
  } finally {
    if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
    w.restore();
  }
});

test('agents without a headless plane are refused', () => {
  const w = world();
  try {
    const result = run(['run', '--headless', 'grok'], w.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no headless control plane/);
    const acp = run(['run', '--acp', 'kimi'], w.env);
    assert.equal(acp.status, 1);
    assert.match(acp.stderr, /no ACP launcher/);
  } finally {
    w.restore();
  }
});

test('the bundled CLI starts with a shebang when the bundle has been built', () => {
  const file = path.join(ROOT, 'cli', 'dist', 'telepathy.mjs');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('#!/usr/bin/env node\n'));
  assert.ok(fs.statSync(file).mode & 0o111);
  const version = spawnSync(process.execPath, [file, '--version'], { encoding: 'utf8' });
  assert.equal(version.stdout.trim(), '0.9.0');
});

test('a tool call confirms an ACP turn before the turn finishes', async () => {
  const w = world({ FAKE_ACP_TOOL_FIRST: '1', FAKE_ACP_HOLD_MS: '4000' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'tool', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const started = Date.now();
    const sent = await sendMessage(self, 'copilot:tool', 'run a tool');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    assert.ok(Date.now() - started < 3000);
  } finally {
    await stop(w.env, 'tool', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('ACP messages are separated by a newline', async () => {
  const w = world({ FAKE_ACP_TWO: '1' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'lines', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const sent = await sendMessage(self, 'copilot:lines', 'hi');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    await waitFor(() => (launched.out().includes('one\ntwo') ? true : undefined));
  } finally {
    await stop(w.env, 'lines', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('an ACP auth failure after the prompt exits', async () => {
  const w = world({ FAKE_ACP_AUTH_LATE: '1' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'late', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const pending = sendMessage(self, 'copilot:late', 'hi');
    const result = await Promise.race([
      launched.done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`auth hang: ${launched.err()}\n${launched.out()}`)), 8000)),
    ]);
    assert.notEqual(result.code, 0);
    assert.match(`${launched.out()}\n${launched.err()}`, /authenticat/i);
    await pending.catch(() => undefined);
  } finally {
    if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
    w.restore();
  }
});

test('ACP text chunks are one stream, not one line each', async () => {
  const w = world({ FAKE_ACP_SPLIT: '1' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'chunks', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const sent = await sendMessage(self, 'copilot:chunks', 'hi');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    await waitFor(() => (launched.out().includes('Hello there') ? true : undefined));
    assert.doesNotMatch(launched.out(), /Hello\n/);
  } finally {
    await stop(w.env, 'chunks', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('Ctrl-C cancels the ACP turn, and a second Ctrl-C exits', async () => {
  const w = world({ FAKE_ACP_HOLD_MS: '8000' });
  const launched = spawnCli(['run', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.out().includes('session ') ? true : undefined));
    launched.child.stdin.write('hold this turn\n');
    await waitFor(() =>
      w.readLog().some((entry) => entry.method === 'session/prompt' && JSON.stringify(entry.params).includes('hold this turn')) ? true : undefined,
    );
    process.kill(launched.child.pid as number, 'SIGINT');
    await waitFor(() => (w.readLog().some((entry) => entry.method === 'session/cancel') ? true : undefined));
    assert.equal(launched.child.exitCode, null);
    process.kill(launched.child.pid as number, 'SIGINT');
    const result = await Promise.race([
      launched.done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('second Ctrl-C hung')), 4000)),
    ]);
    assert.equal(result.code, 0);
  } finally {
    if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
    w.restore();
  }
});

test('a cancelled permission does not consume the next line', async () => {
  const w = world({ FAKE_ACP_PERMISSION: '1' });
  const launched = spawnCli(['run', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.out().includes('session ') ? true : undefined));
    launched.child.stdin.write('first prompt\n');
    await waitFor(() => (launched.out().includes('permission requested') ? true : undefined));
    process.kill(launched.child.pid as number, 'SIGINT');
    await waitFor(() => (w.readLog().some((entry) => entry.method === 'session/cancel') ? true : undefined));
    launched.child.stdin.write('second prompt\n');
    await waitFor(() =>
      w.readLog().some((entry) => entry.method === 'session/prompt' && JSON.stringify(entry.params).includes('second prompt')) ? true : undefined,
    );
    launched.child.stdin.end();
    const result = await launched.done;
    assert.equal(result.code, 0);
  } finally {
    if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
    w.restore();
  }
});

test('an ACP agent that fails to authenticate exits instead of waiting', async () => {
  const w = world({ FAKE_ACP_AUTH_HANG: '1' });
  const launched = spawnCli(['run', 'copilot'], w.env);
  try {
    const result = await Promise.race([
      launched.done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`auth hang: ${launched.err()}`)), 4000)),
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /authenticat/i);
  } finally {
    if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
    w.restore();
  }
});

test('an installed plugin keeps the --name and is not a second host peer', async () => {
  const w = world();
  plantClaude(w.sb);
  const launched = spawnCli(['run', '--headless', '--name', 'box', 'claude'], w.env);
  try {
    await waitFor(() => {
      const started = w.readLog().find((entry) => entry.cmd === 'claude' && entry.args?.includes('stream-json'));
      return started?.name === 'box' ? started : undefined;
    });
    const started = w.readLog().find((entry) => entry.cmd === 'claude' && entry.args?.includes('stream-json'));
    assert.equal(started?.name, 'box');
    assert.equal(started?.home, w.sb.home);
    assert.ok(started?.pluginDirs?.includes(path.join(w.sb.env.CLAUDE_CONFIG_DIR, 'plugins')));
    assert.equal(fs.existsSync(path.join(w.sb.home, 'peers', 'claude-h-box', 'hosted.json')), false);
    assert.equal(w.readLog().some((entry) => entry.event === 'stdin'), false);
  } finally {
    await stop(w.env, 'box', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('claude ACP uses claude-agent-acp and falls back to claude-code-acp', async () => {
  const w = world();
  const launched = spawnCli(['run', '--headless', '--acp', '--name', 'ada', 'claude'], w.env);
  try {
    await waitFor(() => (w.readLog().some((entry) => entry.cmd === 'claude-agent-acp') ? true : undefined));
  } finally {
    await stop(w.env, 'ada', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acp-'));
  fs.symlinkSync(path.join(BIN_DIR, 'claude'), path.join(dir, 'claude'));
  fs.symlinkSync(path.join(BIN_DIR, 'claude-code-acp'), path.join(dir, 'claude-code-acp'));
  const env = { ...w.env, PATH: `${dir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin` };
  const fallback = spawnCli(['run', '--headless', '--acp', '--name', 'old', 'claude'], env);
  try {
    await waitFor(() => (w.readLog().some((entry) => entry.cmd === 'claude-code-acp') ? true : undefined), 8000);
  } finally {
    await stop(env, 'old', fallback.done, fallback.child).catch(() => fallback.child.kill('SIGKILL'));
    fs.rmSync(dir, { recursive: true, force: true });
    w.restore();
  }
});

test('a bin symlink named telepathy runs the CLI', () => {
  const w = world();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-bin-'));
  try {
    const link = path.join(dir, 'telepathy');
    fs.symlinkSync(CLI, link);
    const result = spawnSync(process.execPath, [link, '--version'], { env: w.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0\.0\.0-dev/);
    assert.equal(result.stdout.trim().length > 0, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    w.restore();
  }
});

test('--telepathy-auto-update is handled by the CLI and by the real spawned entry', async () => {
  const w = world();
  try {
    const direct = run(['--telepathy-auto-update'], { ...w.env, TELEPATHY_AUTO_UPDATE: '0' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.doesNotMatch(`${direct.stdout}${direct.stderr}`, /Unknown command/);
    assert.match(fs.readFileSync(path.join(w.sb.home, 'auto-update.log'), 'utf8'), /skipped: auto-update disabled/);
    fs.rmSync(path.join(w.sb.home, 'auto-update.log'), { force: true });
    fs.rmSync(path.join(w.sb.home, 'auto-update.json'), { force: true });
    process.env.TELEPATHY_AUTO_UPDATE = '1';
    process.env.TELEPATHY_LATEST_VERSION = '0.9.0';
    delete process.env.TELEPATHY_AUTO_UPDATE_ENTRY;
    scheduleAutoUpdate('test');
    const log = path.join(w.sb.home, 'auto-update.log');
    await waitFor(() => {
      if (!fs.existsSync(log)) return undefined;
      const text = fs.readFileSync(log, 'utf8');
      if (text.includes('Unknown command')) throw new Error(text);
      return /current 0\.9\.0/.test(text) ? true : undefined;
    });
    assert.equal(fs.existsSync(path.join(w.sb.home, 'github-version.json')), false);
  } finally {
    delete process.env.TELEPATHY_AUTO_UPDATE_ENTRY;
    w.restore();
  }
});

test('the bundled CLI handles --telepathy-auto-update', () => {
  const file = path.join(ROOT, 'cli', 'dist', 'telepathy.mjs');
  if (!fs.existsSync(file)) return;
  const w = world();
  try {
    const result = spawnSync(process.execPath, [file, '--telepathy-auto-update'], {
      env: { ...w.env, TELEPATHY_AUTO_UPDATE: '0' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Unknown command/);
    assert.match(fs.readFileSync(path.join(w.sb.home, 'auto-update.log'), 'utf8'), /skipped: auto-update disabled/);
  } finally {
    w.restore();
  }
});

test('update skips a current install and the Codex restart note', () => {
  const w = world();
  plantClaude(w.sb);
  try {
    const result = run(['update'], w.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already current/);
    assert.doesNotMatch(result.stdout, /Hook failed/);
    assert.equal(
      w.readLog().some((entry) => entry.args?.includes('plugin')),
      false,
    );
  } finally {
    w.restore();
  }
});

test('an isolated TELEPATHY_HOME does not see installs outside it', async () => {
  const w = world();
  plantClaude(w.sb);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-outside-'));
  const versionDir = path.join(outside, 'plugins', 'cache', 'telepathy', 'telepathy', '0.0.1');
  fs.mkdirSync(versionDir, { recursive: true });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = outside;
  process.env.TELEPATHY_AUTO_UPDATE = '1';
  process.env.TELEPATHY_LATEST_VERSION = '9.9.9';
  try {
    const installs = installsInScope();
    assert.ok(installs.some((install) => install.agent === 'claude'));
    assert.equal(installs.some((install) => install.dir.startsWith(outside)), false);
    const status = run(['status'], { ...w.env, CODEX_HOME: outside });
    assert.match(status.stdout, /Codex 0\.0\.1/);
    await runAutoUpdate();
    assert.equal(fs.existsSync(versionDir), true);
    assert.equal(fs.existsSync(path.join(w.sb.home, 'github-version.json')), false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(outside, { recursive: true, force: true });
    w.restore();
  }
});

test('MCP configs use only the placeholder syntax that harness expands', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/claude.mcp.json'), 'utf8')) as {
    mcpServers: { bridge: { env: Record<string, string> } };
  };
  for (const name of FORWARDED_ENV) assert.equal(claude.mcpServers.bridge.env[name], `\${${name}:-}`);
  const cursor = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/cursor.mcp.json'), 'utf8')) as {
    mcpServers: { telepathy: { env: Record<string, string> } };
  };
  for (const name of FORWARDED_ENV) assert.equal(cursor.mcpServers.telepathy.env[name], `\${env:${name}}`);
  const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/codex.mcp.json'), 'utf8')) as {
    mcpServers: { bridge: { env_vars: string[] } };
  };
  for (const name of FORWARDED_ENV) assert.ok(codex.mcpServers.bridge.env_vars.includes(name));
  for (const file of ['plugin/copilot.mcp.json', 'plugin/devin.mcp.json', 'plugin/grok.mcp.json', 'qwen-extension.json', '.kimi-plugin/plugin.json', 'antigravity/mcp_config.json']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /\$\{TELEPATHY_/, `${file} still assigns a \${TELEPATHY_} placeholder`);
    assert.doesNotMatch(text, /"CODEX_HOME"/, `${file} still assigns CODEX_HOME`);
  }
});

test('agy is the antigravity alias, and headless refuses a consumer login', () => {
  const w = world();
  try {
    const listed = parseRunArgs(['agy', '--conversation', 'abc']);
    assert.equal(listed.agent, 'agy');
    const refused = run(['run', '--headless', '--name', 'box', 'agy'], w.env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /consumer login/);
    assert.match(refused.stderr, /GEMINI_API_KEY/);
    assert.equal(w.readLog().some((entry) => entry.event === 'start'), false);
  } finally {
    w.restore();
  }
});

test('headless agy uses stream-json and an API key, not agy -p', async () => {
  const w = world({ GEMINI_API_KEY: 'test-key' });
  const settings = path.join(w.env.HOME as string, '.gemini', 'antigravity-cli', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ modelProvider: 'gemini' }));
  const launched = spawnCli(['run', '--headless', '--name', 'box', 'antigravity', '--conversation', 'conv-kept'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const started = await waitFor(() => w.readLog().find((entry) => entry.event === 'start' && entry.args?.includes('stream-json')));
    assert.ok(started?.args?.includes('--input-format'));
    assert.ok(started?.args?.includes('stream-json'));
    assert.equal(started?.args?.includes('-p'), false);
    assert.ok(started?.args?.includes('--conversation'));
    assert.ok(started?.args?.includes('conv-kept'));
    assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).modelProvider, 'gemini');
    const self = sender();
    const sent = await sendMessage(self, 'antigravity:box', 'hello agy');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    await waitFor(() => (w.readLog().some((entry) => entry.event === 'stdin' && entry.line?.includes('telepathy-id:')) ? true : undefined));
  } finally {
    await stop(w.env, 'box', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('an unexpanded placeholder is not a home, a name, or a transcript dir', () => {
  const saved = {
    TELEPATHY_HOME: process.env.TELEPATHY_HOME,
    TELEPATHY_NAME: process.env.TELEPATHY_NAME,
  };
  process.env.TELEPATHY_HOME = '${TELEPATHY_HOME}';
  process.env.TELEPATHY_NAME = '${TELEPATHY_NAME}';
  try {
    assert.equal(configuredEnv('TELEPATHY_HOME'), undefined);
    assert.equal(stateDir().includes('${'), false);
    assert.equal(configuredStableName(), undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('run does not install or edit the Gemini config', async () => {
  const w = world();
  const launched = spawnCli(['run', 'agy'], w.env);
  try {
    await waitFor(() => (w.readLog().some((entry) => entry.event === 'start' && entry.cmd === 'agy') ? true : undefined));
    assert.equal(
      w.readLog().some((entry) => entry.args?.includes('plugin')),
      false,
    );
    assert.equal(fs.existsSync(path.join(w.env.HOME as string, '.gemini', 'config', 'config.json')), false);
  } finally {
    if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
    w.restore();
  }
});

test('the real home state directory is untouched', () => {
  assert.equal(fs.existsSync(REAL_STATE), realStateBefore);
});
