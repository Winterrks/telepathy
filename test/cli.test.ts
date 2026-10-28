import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { autoUpdateEnabled, runAutoUpdate, scheduleAutoUpdate } from '../src/auto-update.ts';
import { sendMessage } from '../src/core/deliver.ts';
import { inboxDir } from '../src/core/paths.ts';
import { readPeer, registerSession } from '../src/core/peers.ts';
import { readHeadlessRecord } from '../src/headless/peer.ts';
import { parseRunArgs } from '../src/cli/run.ts';
import { ROOT, makeSandbox, type Sandbox } from './helpers.ts';

const CLI = path.join(ROOT, 'src', 'cli.ts');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-harness.mjs');
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'telepathy-bins-'));
const REAL_STATE = '/home/ubuntu/.telepathy';
const realStateBefore = fs.existsSync(REAL_STATE);

for (const name of ['claude', 'codex', 'opencode', 'kilo', 'gemini', 'copilot', 'qwen', 'grok', 'devin', 'claude-code-acp', 'codex-acp']) {
  const file = path.join(BIN_DIR, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.env.FAKE_ARGV0 = ${JSON.stringify(name)};\nimport(process.env.FAKE_HARNESS_FILE);\n`);
  fs.chmodSync(file, 0o755);
}

interface World {
  sb: Sandbox;
  env: NodeJS.ProcessEnv;
  logFile: string;
  restore: () => void;
  readLog: () => { cmd?: string; args?: string[]; event?: string; method?: string; line?: string; params?: unknown; url?: string; body?: string; cwd?: string }[];
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

function plantGemini(home: string): void {
  const dir = path.join(home, '.gemini', 'extensions', 'telepathy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gemini-extension.json'), JSON.stringify({ version: '0.9.0' }));
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
    assert.match(list.stdout, /gemini\s+acp/);
    assert.match(list.stdout, /headless: claude/);
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
    assert.equal(start?.cwd, cwd);
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
    assert.equal(w.readLog().length, 0);
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
  plantClaude(w.sb);
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'box', 'claude'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    await waitFor(() => (readHeadlessRecord('claude', 'box')?.harnessSessionId === 'sess-claude-1' ? true : undefined));
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
  plantCodex(w.sb);
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
  const launched = spawnCli(['run', '--headless', '--name', 'gem', 'gemini'], w.env);
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
    const sent = await sendMessage(self, 'gemini:gem', 'early update');
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
  const launched = spawnCli(['run', '--headless', '--name', 'gem', 'gemini'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const first = await sendMessage(self, 'gemini:gem', 'first turn');
    assert.equal(first.ok, true, first.ok ? '' : first.error);
    const second = await sendMessage(self, 'gemini:gem', 'queued turn');
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.error, /Message failed/);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const prompts = w.readLog().filter((entry) => entry.method === 'session/prompt');
    assert.equal(prompts.length, 1);
    assert.match(JSON.stringify(prompts[0]?.params), /first turn/);
    assert.equal(JSON.stringify(w.readLog()).includes('queued turn'), false);
    const record = readHeadlessRecord('gemini', 'gem');
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
  plantGemini(w.env.HOME as string);
  const launched = spawnCli(['run', '--headless', '--name', 'gem', 'gemini'], w.env);
  try {
    await waitFor(() => (w.readLog().some((entry) => entry.method === 'session/new') ? true : undefined));
    const created = w.readLog().find((entry) => entry.method === 'session/new');
    const servers = (created?.params as { mcpServers?: unknown[] })?.mcpServers;
    assert.deepEqual(servers, []);
  } finally {
    await stop(w.env, 'gem', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('headless permission is rejected unless TELEPATHY_HEADLESS_APPROVE=1', async () => {
  const w = world({ FAKE_ACP_PERMISSION: '1' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'perm', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const sent = await sendMessage(self, 'copilot:perm', 'needs a yes');
    assert.equal(sent.ok, false);
    if (!sent.ok) assert.match(sent.error, /Message failed/);
  } finally {
    await stop(w.env, 'perm', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('TELEPATHY_HEADLESS_APPROVE allows one headless permission', async () => {
  const w = world({ FAKE_ACP_PERMISSION: '1', TELEPATHY_HEADLESS_APPROVE: '1' });
  confirmEnv();
  const launched = spawnCli(['run', '--headless', '--name', 'perm', 'copilot'], w.env);
  try {
    await waitFor(() => (launched.err().includes('is up') ? true : undefined));
    const self = sender();
    const sent = await sendMessage(self, 'copilot:perm', 'allowed');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
  } finally {
    await stop(w.env, 'perm', launched.done, launched.child).catch(() => launched.child.kill('SIGKILL'));
    w.restore();
  }
});

test('interactive ACP takes a stdin prompt and exits when stdin closes', async () => {
  const w = world();
  const launched = spawnCli(['run', 'gemini'], w.env);
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

test('the real home state directory is untouched', () => {
  assert.equal(fs.existsSync(REAL_STATE), realStateBefore);
});
