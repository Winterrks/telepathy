import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ROOT, makeSandbox, type Sandbox } from './helpers.ts';

const CLI = path.join(ROOT, 'src', 'cli.ts');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-harness.mjs');

/** A PATH holding only the fakes this test names, so "detected" means exactly these. */
function binDir(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepathy-setup-bins-'));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.env.FAKE_ARGV0 = ${JSON.stringify(name)};\nimport(process.env.FAKE_HARNESS_FILE);\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

interface World {
  sb: Sandbox;
  env: NodeJS.ProcessEnv;
  log: () => { cmd?: string; args?: string[]; event?: string; method?: string; params?: unknown }[];
  hookState: string;
  done: () => void;
}

function world(bins: string[], extra: NodeJS.ProcessEnv = {}): World {
  const sb = makeSandbox();
  fs.mkdirSync(sb.env.HOME, { recursive: true });
  const logFile = path.join(path.dirname(sb.home), 'harness.jsonl');
  const hookState = path.join(path.dirname(sb.home), 'hook-state.json');
  fs.writeFileSync(logFile, '');
  const dir = binDir(bins);
  const env: NodeJS.ProcessEnv = {
    ...sb.env,
    // The fakes' own `node`, and the system tools (`which`, `tar`). Not /opt/homebrew/bin: the real agents live there.
    PATH: [dir, path.dirname(fs.realpathSync(process.execPath)), '/usr/bin', '/bin'].join(path.delimiter),
    FAKE_HARNESS_LOG: logFile,
    FAKE_HARNESS_FILE: pathToFileURL(FAKE).href,
    FAKE_CODEX_HOOK_STATE: hookState,
    TELEPATHY_LATEST_VERSION: '0.9.0',
    TELEPATHY_GITHUB_WEB: 'http://127.0.0.1:9',
    TELEPATHY_GITHUB_CODELOAD: 'http://127.0.0.1:9',
    ...extra,
  };
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  return {
    sb,
    env,
    hookState,
    log: () =>
      fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    done: () => {
      sb.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Async, so a test's own HTTP server can answer while the CLI runs. */
function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const HOOKS = (statuses: string[]) =>
  JSON.stringify(
    ['session_start', 'post_tool_use', 'user_prompt_submit', 'permission_request'].map((event, i) => ({
      key: `telepathy@telepathy:hooks/codex-hooks.json:${event}:0:0`,
      eventName: event,
      trustStatus: statuses[i] ?? 'trusted',
      currentHash: `sha256:handler${i}/sha256:content`,
    })),
  );

function plantClaude(sb: Sandbox, version = '0.9.0'): void {
  const dir = path.join(sb.env.CLAUDE_CONFIG_DIR, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ plugins: { 'telepathy@telepathy': [{ version, installPath: dir }] } }));
}

function plantCodex(sb: Sandbox, version = '0.9.0'): void {
  fs.mkdirSync(path.join(sb.codexHome, 'plugins', 'cache', 'telepathy', 'telepathy', version), { recursive: true });
}

test('setup --dry-run plans installs, hook approval and adapters, and runs nothing', async () => {
  const w = world(['claude', 'codex', 'cursor-agent', 'hermes', 'npm']);
  try {
    const result = await cli(['setup', '--dry-run'], w.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Claude Code: would install: `claude plugin marketplace add Winterrks\/telepathy`/);
    assert.match(result.stdout, /would run `npm install -g @zed-industries\/claude-agent-acp`/);
    assert.match(result.stdout, /Codex: would install: .*; would approve telepathy's hooks .*; would run `npm install -g @zed-industries\/codex-acp`/);
    assert.match(result.stdout, /Cursor.*: loads Claude Code's copy/);
    assert.match(result.stdout, /Hermes.*: Telepathy has no Hermes install command yet/);
    assert.equal(w.log().length, 0, JSON.stringify(w.log()));
  } finally {
    w.done();
  }
});

test('setup approves new and changed Codex hooks, installs adapters, and is quiet the second time', async () => {
  const w = world(['claude', 'codex', 'npm'], { FAKE_CODEX_HOOKS: HOOKS(['modified', 'modified', 'untrusted', 'trusted']) });
  plantClaude(w.sb);
  plantCodex(w.sb);
  try {
    const first = await cli(['setup'], w.env);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /Claude Code: telepathy 0\.9\.0, current; installed claude-agent-acp/);
    assert.match(first.stdout, /Codex: telepathy 0\.9\.0, current; approved 3 hooks; installed codex-acp/);
    const npm = w.log().filter((entry) => entry.cmd === 'npm').map((entry) => entry.args?.join(' '));
    assert.deepEqual(npm.sort(), ['install -g @zed-industries/claude-agent-acp', 'install -g @zed-industries/codex-acp']);
    const writes = w.log().filter((entry) => entry.method === 'config/batchWrite');
    assert.equal(writes.length, 1);
    const edit = (writes[0]?.params as { edits: { keyPath: string; mergeStrategy: string; value: Record<string, { trusted_hash: string }> }[] }).edits[0];
    assert.equal(edit?.keyPath, 'hooks.state');
    assert.equal(edit?.mergeStrategy, 'upsert');
    assert.deepEqual(Object.keys(edit?.value ?? {}).length, 3);
    assert.equal(edit?.value['telepathy@telepathy:hooks/codex-hooks.json:session_start:0:0']?.trusted_hash, 'sha256:handler0/sha256:content');

    const second = await cli(['setup', '--no-adapters'], w.env);
    assert.equal(second.code, 0, second.stdout);
    assert.match(second.stdout, /Codex: telepathy 0\.9\.0, current; all 4 telepathy hooks are trusted/);
    assert.equal(w.log().filter((entry) => entry.method === 'config/batchWrite').length, 1);

    const before = w.log().length;
    const off = await cli(['setup', '--no-hooks', '--no-adapters', '--only', 'codex'], w.env);
    assert.equal(off.code, 0, off.stdout);
    assert.equal(w.log().slice(before).some((entry) => entry.args?.[0] === 'app-server'), false);
    assert.equal(w.log().slice(before).some((entry) => entry.cmd === 'npm'), false);
  } finally {
    w.done();
  }
});

test('update re-approves only Codex hooks the user had approved before', async () => {
  const w = world(['codex'], { FAKE_CODEX_HOOKS: HOOKS(['modified', 'modified', 'modified', 'untrusted']), FAKE_CODEX_UPGRADE_TO: '0.9.0' });
  plantCodex(w.sb, '0.8.0');
  try {
    const result = await cli(['update'], w.env);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Codex: 0\.8\.0 → 0\.9\.0/);
    assert.match(result.stdout, /approved telepathy's 3 updated hooks again/);
    assert.match(result.stdout, /1 telepathy hooks were never approved/);
    const approved = JSON.parse(fs.readFileSync(w.hookState, 'utf8')) as Record<string, string>;
    assert.equal(Object.keys(approved).length, 3);
    assert.equal(approved['telepathy@telepathy:hooks/codex-hooks.json:permission_request:0:0'], undefined);
  } finally {
    w.done();
  }
});

test('doctor reports Codex hooks that need approval', async () => {
  const w = world(['codex'], { FAKE_CODEX_HOOKS: HOOKS(['modified', 'modified', 'modified', 'modified']) });
  plantCodex(w.sb);
  try {
    const result = await cli(['doctor'], w.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Codex hooks: 4 of 4 telepathy hooks need approval \(changed since they were approved\)\. `telepathy setup` approves them/);
  } finally {
    w.done();
  }
});

test('OpenCode 2 reinstalls from a cleared package folder, and keeps the old copy when that fails', async () => {
  const w = world(['opencode'], { TELEPATHY_LATEST_VERSION: '0.9.0' });
  const npm = path.join(w.sb.env.XDG_CACHE_HOME, 'opencode', 'npm');
  const old = path.join(npm, 'git-telepathy-fake', '1', 'node_modules', 'telepathy');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ name: 'telepathy', version: '0.8.0' }));
  try {
    const failed = await cli(['update'], w.env);
    assert.equal(failed.code, 1, failed.stdout);
    assert.match(failed.stdout, /didn't reinstall telepathy, so the old copy was kept/);
    assert.ok(fs.existsSync(path.join(old, 'package.json')));
    assert.deepEqual(fs.readdirSync(path.dirname(npm)).filter((name) => name.startsWith('.telepathy-update-')), []);

    const ok = await cli(['update'], { ...w.env, FAKE_OPENCODE_REINSTALL: '0.9.0' });
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /OpenCode: 0\.8\.0 → 0\.9\.0/);
    assert.equal(fs.existsSync(old), false);
    const add = w.log().filter((entry) => entry.cmd === 'opencode' && entry.args?.[1] === 'add');
    assert.equal(add.at(-1)?.args?.[2], 'telepathy@git+https://github.com/Winterrks/telepathy.git');
    assert.deepEqual(fs.readdirSync(path.dirname(npm)).filter((name) => name.startsWith('.telepathy-update-')), []);
  } finally {
    w.done();
  }
});

/** GitHub as Kimi Code's installer sees it: a latest-release redirect, a commits feed, and codeload. */
async function fakeGithub(version: string): Promise<{ url: string; sha: string; hits: string[]; close: () => Promise<void> }> {
  const sha = 'a'.repeat(39) + version.replace(/\D/g, '').slice(-1);
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'telepathy-kimi-src-'));
  const top = path.join(src, `telepathy-${sha}`);
  fs.mkdirSync(path.join(top, '.kimi-plugin'), { recursive: true });
  fs.writeFileSync(path.join(top, '.kimi-plugin', 'plugin.json'), JSON.stringify({ name: 'telepathy', version }));
  fs.writeFileSync(path.join(top, 'README.md'), `telepathy ${version}\n`);
  const tarball = path.join(src, 'main.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', src, `telepathy-${sha}`]);
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hits.push(url);
    if (url === '/Winterrks/telepathy/releases/latest') {
      res.writeHead(302, { location: `https://github.com/Winterrks/telepathy/releases/tag/v${version}` });
      res.end();
    } else if (url === `/Winterrks/telepathy/commits/v${version}.atom`) {
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      res.end(`<feed><entry><id>tag:github.com,2008:Grit::Commit/${sha}</id></entry></feed>`);
    } else if (url === `/Winterrks/telepathy/tar.gz/${sha}`) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(fs.readFileSync(tarball));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    sha,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        fs.rmSync(src, { recursive: true, force: true });
      }),
  };
}

test("Kimi Code: update replaces the managed copy and keeps installed.json in Kimi's own shape", async () => {
  const gh = await fakeGithub('0.9.0');
  const w = world(['kimi'], { TELEPATHY_GITHUB_WEB: gh.url, TELEPATHY_GITHUB_CODELOAD: gh.url });
  const kimiHome = path.join(w.sb.env.HOME, '.kimi-code');
  const managed = path.join(kimiHome, 'plugins', 'managed', 'telepathy');
  fs.mkdirSync(path.join(managed, '.kimi-plugin'), { recursive: true });
  fs.writeFileSync(path.join(managed, '.kimi-plugin', 'plugin.json'), JSON.stringify({ name: 'telepathy', version: '0.4.4' }));
  fs.writeFileSync(path.join(managed, 'stale.txt'), 'old');
  const other = { id: 'other', root: '/somewhere/else', source: 'local-path', enabled: false, installedAt: 'x', updatedAt: 'x' };
  const entry = {
    id: 'telepathy',
    root: fs.realpathSync(managed),
    source: 'github',
    enabled: true,
    installedAt: '2026-09-24T12:19:26.510Z',
    updatedAt: '2026-09-24T12:19:26.510Z',
    originalSource: 'https://github.com/Winterrks/telepathy',
    github: { owner: 'Winterrks', repo: 'telepathy', ref: { kind: 'branch', value: 'HEAD' }, installedSha: 'b'.repeat(40) },
  };
  fs.writeFileSync(path.join(kimiHome, 'plugins', 'installed.json'), JSON.stringify({ version: 1, plugins: [other, entry] }));
  try {
    const status = await cli(['status'], w.env);
    assert.match(status.stdout, /Kimi Code 0\.4\.4 {2}outdated/);
    const result = await cli(['update'], w.env);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Kimi Code: 0\.4\.4 → 0\.9\.0/);
    assert.equal(fs.existsSync(path.join(managed, 'stale.txt')), false);
    const installed = JSON.parse(fs.readFileSync(path.join(kimiHome, 'plugins', 'installed.json'), 'utf8'));
    assert.deepEqual(installed.plugins[0], other);
    const updated = installed.plugins[1];
    assert.equal(updated.installedAt, entry.installedAt);
    assert.notEqual(updated.updatedAt, entry.updatedAt);
    assert.deepEqual(updated.github, { owner: 'Winterrks', repo: 'telepathy', ref: { kind: 'tag', value: 'v0.9.0' }, installedSha: gh.sha });
    assert.equal(updated.source, 'github');
    assert.equal(updated.enabled, true);
    assert.deepEqual(
      fs.readdirSync(path.dirname(managed)).filter((name) => name !== 'telepathy'),
      [],
      'no staging or previous folder is left behind',
    );
    const again = await cli(['setup', '--only', 'kimi'], w.env);
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, /Kimi Code: telepathy 0\.9\.0, current/);
  } finally {
    await gh.close();
    w.done();
  }
});

test('Kimi Code: setup installs a fresh copy, and a failed download leaves nothing behind', async () => {
  const gh = await fakeGithub('0.9.0');
  const w = world(['kimi'], { TELEPATHY_GITHUB_WEB: gh.url, TELEPATHY_GITHUB_CODELOAD: `${gh.url}/missing` });
  const kimiHome = path.join(w.sb.env.HOME, '.kimi-code');
  try {
    const broken = await cli(['setup', '--only', 'kimi'], w.env);
    assert.equal(broken.code, 1, broken.stdout);
    assert.match(broken.stdout, /Kimi Code: failed: download failed: HTTP 404/);
    assert.equal(fs.existsSync(path.join(kimiHome, 'plugins', 'installed.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(kimiHome, 'plugins', 'managed')), []);

    const fresh = await cli(['setup', '--only', 'kimi'], { ...w.env, TELEPATHY_GITHUB_CODELOAD: gh.url });
    assert.equal(fresh.code, 0, fresh.stdout + fresh.stderr);
    assert.match(fresh.stdout, /Kimi Code: installed 0\.9\.0 \(v0\.9\.0, a{12}\)/);
    const installed = JSON.parse(fs.readFileSync(path.join(kimiHome, 'plugins', 'installed.json'), 'utf8'));
    assert.equal(installed.version, 1);
    assert.equal(installed.plugins.length, 1);
    assert.equal(installed.plugins[0].id, 'telepathy');
    assert.equal(installed.plugins[0].originalSource, 'https://github.com/Winterrks/telepathy');
    assert.equal(installed.plugins[0].root, fs.realpathSync(path.join(kimiHome, 'plugins', 'managed', 'telepathy')));
    assert.ok(fs.existsSync(path.join(installed.plugins[0].root, 'README.md')));
  } finally {
    await gh.close();
    w.done();
  }
});

test('Kimi Code outside a sandbox TELEPATHY_HOME is left alone', async () => {
  const w = world(['kimi'], { KIMI_CODE_HOME: path.join(os.homedir(), '.kimi-code-not-in-sandbox') });
  try {
    const result = await cli(['setup', '--only', 'kimi'], w.env);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /outside this TELEPATHY_HOME/);
    assert.equal(fs.existsSync(path.join(os.homedir(), '.kimi-code-not-in-sandbox')), false);
  } finally {
    w.done();
  }
});

test('setup rejects unknown options', async () => {
  const w = world([]);
  try {
    const result = await cli(['setup', '--force'], w.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown setup option "--force"/);
  } finally {
    w.done();
  }
});
