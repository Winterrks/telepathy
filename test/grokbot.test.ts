import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeSandbox, ROOT, type Sandbox } from './helpers.ts';

const CLI = path.join(ROOT, 'src', 'cli.ts');
const KEY = 'crsr_test_routine_key_0123456789abcdef';

interface Post {
  path: string;
  auth?: string;
  context?: string;
}

describe('telepathy grokbot', () => {
  let sb: Sandbox;
  let env: NodeJS.ProcessEnv;
  let base = '';
  const posts: Post[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let context: string | undefined;
      try {
        context = (JSON.parse(raw) as { context?: string }).context;
      } catch {
        context = undefined;
      }
      posts.push({ path: req.url ?? '', auth: req.headers.authorization, context });
      // /hook/busy stands in for a Bot that is out of usage or rate limited.
      if (req.url === '/hook/busy') {
        res.writeHead(429, { 'content-type': 'application/json', 'x-automation-failure-hint': 'CONCURRENT_LIMIT_EXCEEDED' });
        res.end(JSON.stringify({ code: 'error', message: 'Too many runs' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, runUuid: `run-${posts.length}` }));
    });
  });

  // Async on purpose: the fake routine server runs in this process and must keep answering while the CLI waits.
  const cli = (args: string[], input?: string, extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'grokbot', ...args], { env: { ...env, ...extra } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.end(input ?? '');
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  before(async () => {
    sb = makeSandbox();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    env = {
      ...sb.env,
      TELEPATHY_GROKBOT_DEBOUNCE_MS: '1200',
      TELEPATHY_GROKBOT_DEBOUNCE_MAX_MS: '2500',
      // The real confirm rule, on a short clock: success only once the host recorded the POST.
      TELEPATHY_CONFIRM_WAIT: '1',
      TELEPATHY_CONFIRM_ABORT_MS: '8000',
      TELEPATHY_CONFIRM_GRACE_MS: '500',
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    };
  });

  after(async () => {
    for (const name of ['one', 'two', 'busy']) {
      spawnSync(process.execPath, [CLI, 'grokbot', 'stop', name], { env, encoding: 'utf8' });
    }
    server.close();
  });

  test('connect keeps the key out of every output and in a mode-600 file', async () => {
    for (const [name, hook] of [['one', 'one'], ['two', 'two'], ['busy', 'busy']]) {
      const out = await cli(['connect', name, `${base}/hook/${hook}`], `${KEY}\n`);
      assert.equal(out.status, 0, out.stderr + out.stdout);
      assert.match(out.stdout, new RegExp(`Connected grok:${name}`));
      assert.match(out.stdout, /is up \(pid \d+\)/);
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(KEY));
      const file = path.join(sb.env.TELEPATHY_HOME, 'grokbot', `${name}.json`);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    const status = await cli(['status']);
    assert.match(status.stdout, /grok:one\trunning/);
    assert.doesNotMatch(status.stdout, new RegExp(KEY));
    assert.equal((await cli(['connect', 'bad', 'http://example.com/hook'], `${KEY}\n`)).status, 1, 'plain http off loopback is refused');
    assert.equal((await cli(['connect', 'bad', `${base}/hook/x`], 'short\n')).status, 1, 'a key that is too short is refused');
  });

  test('a message to grok:<name> starts one routine run with the message as context, and that run is the delivery', async () => {
    const out = await cli(['send', 'one', 'grok:two', 'Can you check the release notes?']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const post = posts.find((p) => p.path === '/hook/two');
    assert.ok(post, 'the routine webhook was called');
    assert.equal(post.auth, `Bearer ${KEY}`);
    assert.match(post.context ?? '', /<telepathy-note kind="wake">.*grok:two/);
    assert.match(post.context ?? '', /<telepathy-peer-message id="[^"]+" from="grok:one/);
    assert.match(post.context ?? '', /telepathy-id:m-/);
    assert.match(post.context ?? '', /Can you check the release notes\?/);
    assert.match(post.context ?? '', /send two <address>/, 'the context says how to answer from this machine');
    assert.match(post.context ?? '', /send two 'grok:one' '<reply>'/, 'the sender address is shell-quoted');
    const log = fs.readFileSync(path.join(sb.env.TELEPATHY_HOME, 'headless', 'grok-two.log'), 'utf8');
    assert.match(log, /delivered m-\S+ in one run run-\d+ \(HTTP 200/);
    assert.doesNotMatch(log, new RegExp(KEY));
  });

  test('messages that arrive together share one run', async () => {
    const before = posts.filter((p) => p.path === '/hook/one').length;
    const results = await Promise.all([cli(['send', 'two', 'grok:one', 'first of two']), cli(['send', 'two', 'grok:one', 'second of two'])]);
    assert.deepEqual(results.map((r) => r.status), [0, 0], results.map((r) => r.stdout).join('\n'));
    const runs = posts.filter((p) => p.path === '/hook/one').slice(before);
    assert.equal(runs.length, 1, 'one POST for the burst');
    assert.match(runs[0].context ?? '', /2 messages for you/);
    assert.match(runs[0].context ?? '', /first of two[\s\S]*second of two|second of two[\s\S]*first of two/);
  });

  test('a refused POST is not a delivery: the send fails and nothing stays queued', async () => {
    const out = await cli(['send', 'one', 'grok:busy', 'are you there?'], undefined, { TELEPATHY_CONFIRM_ABORT_MS: '2500' });
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /not delivered|failed|withdrawn/i);
    const log = fs.readFileSync(path.join(sb.env.TELEPATHY_HOME, 'headless', 'grok-busy.log'), 'utf8');
    assert.match(log, /POST failed for m-\S+: HTTP 429: Too many runs: hint CONCURRENT_LIMIT_EXCEEDED/);
  });

  test('peers lists the sessions the Bot can reach, and disconnect stops the host and forgets the key', async () => {
    const peers = await cli(['peers', 'one']);
    assert.equal(peers.status, 0, peers.stderr);
    assert.match(peers.stdout, /grok:two/);
    assert.doesNotMatch(peers.stdout, /grok-\d+/, 'a CLI send is not a session of its own');
    const gone = await cli(['disconnect', 'busy']);
    assert.equal(gone.status, 0, gone.stdout + gone.stderr);
    assert.match(gone.stdout, /Stopped grok:busy .*Removed its URL and key/);
    assert.equal(fs.existsSync(path.join(sb.env.TELEPATHY_HOME, 'grokbot', 'busy.json')), false);
    const status = await cli(['status']);
    assert.doesNotMatch(status.stdout, /grok:busy\t/);
  });
});
