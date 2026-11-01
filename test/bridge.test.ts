import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { commitment, confirmMac, newKeyPair, open, pairKey, randomNonce, seal, shortCode, type PairTranscript } from '../src/bridge/crypto.ts';
import { remoteTarget } from '../src/bridge/remote.ts';
import { safeName } from '../src/bridge/state.ts';
import { connectServer, DIST, fakeAgent, killAndWait, makeSandbox, ROOT, runHook, type Sandbox, toolText, waitFor } from './helpers.ts';

const CLI = path.join(ROOT, 'src', 'cli.ts');
// Qwen records each turn in its own transcript. The test writes what the hook handed over here instead.
const TRANSCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-bridge-transcripts-'));

describe('bridge crypto', () => {
  test('both sides of a pairing derive the same key and code, and a sealed body opens only with that key', () => {
    const a = newKeyPair();
    const b = newKeyPair();
    const t: PairTranscript = {
      initiatorId: 'aaaa',
      responderId: 'bbbb',
      initiatorKey: a.publicKey,
      responderKey: b.publicKey,
      initiatorNonce: randomNonce(),
      responderNonce: randomNonce(),
    };
    const keyA = pairKey(a, b.publicKey, t);
    const keyB = pairKey(b, a.publicKey, t);
    assert.equal(keyA, keyB);
    assert.match(shortCode(t), /^\d{3} \d{3}$/);
    assert.notEqual(shortCode({ ...t, responderKey: newKeyPair().publicKey }), shortCode(t));
    assert.notEqual(confirmMac(keyA, 'initiator'), confirmMac(keyA, 'responder'));
    assert.equal(commitment(a.publicKey, t.initiatorNonce), commitment(a.publicKey, t.initiatorNonce));

    const sealed = seal(keyA, 'req /v1/send a->b', { hello: 'there' });
    assert.deepEqual(open(keyB, 'req /v1/send a->b', sealed), { hello: 'there' });
    assert.throws(() => open(keyB, 'req /v1/peers a->b', sealed), 'another route is another AAD');
    assert.throws(() => open(keyB, 'req /v1/send a->b', { ...sealed, t: sealed.t + 1 }), 'the time is authenticated');
    const other = pairKey(newKeyPair(), b.publicKey, t);
    assert.throws(() => open(other, 'req /v1/send a->b', sealed));
    // Base64 decoding ignores whitespace, so a padded nonce would slip past a replay cache keyed on the string.
    assert.throws(() => open(keyB, 'req /v1/send a->b', { ...sealed, n: `${sealed.n} ` }), 'a non-canonical nonce is refused');
  });

  test('a device name from the network cannot draw on the pairing prompt', () => {
    assert.equal(safeName('Laptop\n  Code: 111 111\u001b[2K'), 'Laptop Code: 111 111[2K');
    assert.equal(safeName('\u202eevil\u202c'), 'evil');
    assert.equal(safeName(undefined), 'device');
    assert.equal(safeName('x'.repeat(100)).length, 48);
  });

  test('an address with @device is remote; a local one is not', () => {
    assert.deepEqual(remoteTarget('codex:api-c3f@laptop'), { slug: 'laptop', query: 'codex:api-c3f' });
    assert.deepEqual(remoteTarget('codex:api-c3f@laptop [codex-123@laptop]'), { slug: 'laptop', query: 'codex-123' });
    assert.equal(remoteTarget('codex:api-c3f'), undefined);
    assert.equal(remoteTarget('codex:api@'), undefined);
  });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

interface Device {
  name: string;
  sb: Sandbox;
  port: number;
  env: NodeJS.ProcessEnv;
  daemon?: ChildProcess;
}

async function device(name: string, extra: NodeJS.ProcessEnv = {}): Promise<Device> {
  const sb = makeSandbox();
  const port = await freePort();
  const env = {
    ...sb.env,
    TELEPATHY_BRIDGE_PORT: String(port),
    TELEPATHY_TAILSCALE_BIN: '',
    TELEPATHY_BRIDGE_MDNS: '0',
    TELEPATHY_BRIDGE_POLL_MS: '200',
    TELEPATHY_BRIDGE_ONLINE_MS: '4000',
    ...extra,
  };
  fs.mkdirSync(path.join(sb.home, 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, 'bridge', 'settings.json'), JSON.stringify({ lan: false, tailscale: false, mdns: false }));
  assert.equal(cli(env, 'bridge', 'name', name).status, 0);
  return { name, sb, port, env };
}

const cli = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

function spawnCli(env: NodeJS.ProcessEnv, ...args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (out += chunk));
  const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, done, out: () => out };
}

async function startDaemon(d: Device): Promise<void> {
  const run = spawnCli(d.env, 'bridge', 'run');
  d.daemon = run.child;
  await waitFor(() => (run.out().includes('listening on') ? true : undefined), 15_000);
}

const remoteState = (d: Device) =>
  JSON.parse(fs.readFileSync(path.join(d.sb.home, 'bridge', 'remote.json'), 'utf8')) as {
    devices: { slug: string; trusted: boolean; lastSeen: string; peers: { address: string }[] }[];
  };

async function pair(initiator: Device, responder: Device): Promise<void> {
  const accept = spawnCli(responder.env, 'bridge', 'pair');
  await waitFor(() => (accept.out().includes('Pairing is open') ? true : undefined));
  const ask = spawnCli(initiator.env, 'bridge', 'pair', `127.0.0.1:${responder.port}`);
  try {
    const askCode = await waitFor(() => /Code: (\d{3} \d{3})/.exec(ask.out())?.[1]);
    ask.child.stdin.write('y\n');
    const acceptCode = await waitFor(() => /asks to pair\.\n\s+Code: (\d{3} \d{3})/.exec(accept.out())?.[1]);
    assert.equal(askCode, acceptCode, 'both screens show the same code');
    accept.child.stdin.write('y\n');
    assert.equal(await ask.done, 0, ask.out());
    assert.equal(await accept.done, 0, accept.out());
  } finally {
    // A prompt that never matched leaves both waiting on stdin, which would hold the test run open.
    for (const run of [ask, accept]) if (run.child.exitCode === null) run.child.kill();
  }
}

describe('bridge between two devices', () => {
  let alpha: Device;
  let beta: Device;
  const agents: ChildProcess[] = [];

  before(async () => {
    alpha = await device('alpha');
    beta = await device('beta', {
      TELEPATHY_TRANSCRIPT_DIR: TRANSCRIPTS,
      TELEPATHY_CONFIRM_WAIT: '1',
      TELEPATHY_CONFIRM_ABORT_MS: '3000',
      TELEPATHY_CONFIRM_GRACE_MS: '300',
      TELEPATHY_CONFIRM_POLL_MS: '25',
    });
    await startDaemon(alpha);
    await startDaemon(beta);
  });

  after(async () => {
    for (const child of [...agents, alpha?.daemon, beta?.daemon]) if (child) await killAndWait(child);
    alpha?.sb.cleanup();
    beta?.sb.cleanup();
    fs.rmSync(TRANSCRIPTS, { recursive: true, force: true });
  });

  test('an unpaired device is seen but not trusted, and its requests are refused', async () => {
    assert.equal(cli(alpha.env, 'bridge', 'add', `127.0.0.1:${beta.port}`).status, 0);
    await waitFor(() => (remoteState(alpha).devices.some((d) => d.slug === 'beta' && !d.trusted) ? true : undefined));
    const status = cli(alpha.env, 'bridge', 'status').stdout;
    assert.match(status, /beta · manual 127\.0\.0\.1:\d+ · not paired \(telepathy bridge pair beta\)/);

    const ask = (device: string) =>
      fetch(`http://127.0.0.1:${beta.port}/v1/peers`, { method: 'POST', body: JSON.stringify({ device, name: 'x', body: {} }) });
    const unknown = await ask('0123456789abcdef');
    assert.equal(unknown.status, 403);
    assert.match(((await unknown.json()) as { error: string }).error, /not trusted/);
    const malformed = await ask('intruder');
    assert.equal(malformed.status, 403, 'a device id that is not 16 hex digits is refused before any lookup');
    const pairClosed = cli(alpha.env, 'bridge', 'pair', `127.0.0.1:${beta.port}`);
    assert.equal(pairClosed.status, 1);
    assert.match(pairClosed.stderr, /Pairing is not open on beta/);
  });

  test('pairing shows one code on both screens, and then each lists the other\'s sessions', async () => {
    await pair(alpha, beta);
    const qwenB = fakeAgent();
    agents.push(qwenB);
    runHook(beta.sb, 'qwen', qwenB.pid, 'session-start', { session_id: 'g-b', cwd: '/w/docs' });
    await waitFor(() =>
      remoteState(alpha).devices.some((d) => d.slug === 'beta' && d.trusted && d.peers.some((p) => p.address.startsWith('qwen:docs')))
        ? true
        : undefined,
    );
    await waitFor(() => (remoteState(beta).devices.some((d) => d.slug === 'alpha' && d.trusted) ? true : undefined));

    const qwenA = fakeAgent();
    agents.push(qwenA);
    runHook(alpha.sb, 'qwen', qwenA.pid, 'session-start', { session_id: 'g-a', cwd: '/w/web' });
    const client = await connectServer(alpha.sb, 'qwen', qwenA.pid);
    try {
      const listed = toolText(await client.callTool({ name: 'list_peers', arguments: {} }));
      assert.match(listed, /On device beta \(paired, on the local network\), 1 session:/);
      assert.match(listed, /- qwen:docs-q[0-9a-f]{2}@beta \[qwen-g-b@beta\] · cwd \/w\/docs/);
      assert.match(listed, /"codex:name@device" on another device/);
    } finally {
      await client.close();
    }
  });

  test('a message crosses with the sender\'s @device address, confirms on the transcript there, and a reply comes back', async () => {
    const qwenA = agents[1] as ChildProcess & { pid: number };
    const qwenB = agents[0] as ChildProcess & { pid: number };
    const client = await connectServer(alpha.sb, 'qwen', qwenA.pid, ROOT, undefined, {
      TELEPATHY_CONFIRM_WAIT: '1',
      TELEPATHY_CONFIRM_ABORT_MS: '6000',
      TELEPATHY_CONFIRM_GRACE_MS: '500',
    });
    try {
      // Beta's next turn hands the message over: its hook claims the inbox and records the marker.
      let context = '';
      const turns = setInterval(() => {
        const res = runHook(beta.sb, 'qwen', qwenB.pid, 'inbox', { session_id: 'g-b', hook_event_name: 'BeforeAgent' }, 'BeforeAgent');
        if (!res.stdout) return;
        context = JSON.parse(res.stdout).hookSpecificOutput?.additionalContext ?? context;
        fs.writeFileSync(path.join(TRANSCRIPTS, 'qwen-g-b.jsonl'), JSON.stringify({ text: context }) + '\n');
      }, 300);
      let sent: string;
      try {
        sent = toolText(await client.callTool({ name: 'send_message', arguments: { to: 'qwen:docs@beta', message: 'Is the API reference current?' } }));
      } finally {
        clearInterval(turns);
      }
      assert.match(sent, /^Message delivered to qwen:docs-q[0-9a-f]{2}@beta \[qwen-g-b@beta\]\. The transcript shows telepathy-id:m-/);
      assert.match(context, /<telepathy-peer-message id="m-[^"]+" from="qwen:web-q[0-9a-f]{2}@alpha \[qwen-g-a@alpha\]" agent="Qwen Code" reply-to="qwen:web-q[0-9a-f]{2}@alpha">/);
      assert.match(context, /Is the API reference current\?\n<\/telepathy-peer-message>/);

      const replyTo = /reply-to="([^"]+)"/.exec(context)![1];
      const back = await connectServer(beta.sb, 'qwen', qwenB.pid, ROOT, undefined, { TELEPATHY_CONFIRM_WAIT: '0' });
      try {
        const replied = toolText(await back.callTool({ name: 'send_message', arguments: { to: replyTo, message: 'Yes, regenerated this morning.' } }));
        assert.match(replied, /^Message stored for qwen:web-q[0-9a-f]{2}@alpha \[qwen-g-a@alpha\]/);
      } finally {
        await back.close();
      }
      const inbox = path.join(alpha.sb.home, 'peers', 'qwen-g-a', 'inbox');
      const [file] = fs.readdirSync(inbox);
      const msg = JSON.parse(fs.readFileSync(path.join(inbox, file), 'utf8'));
      assert.equal(msg.from.address.endsWith('@beta'), true);
      assert.equal(msg.body, 'Yes, regenerated this morning.');

      const watch = cli(alpha.env, 'bridge', 'watch', '--once').stdout;
      assert.match(watch, /✓ qwen:web-q[0-9a-f]{2} → qwen:docs-q[0-9a-f]{2}@beta {2}"Is the API reference current\?"/);
      assert.match(watch, /✓ qwen:web-q[0-9a-f]{2} ← qwen:docs-q[0-9a-f]{2}@beta {2}"Yes, regenerated this morning\."/);
    } finally {
      await client.close();
    }
  });

  test('Claude\'s ListAgents shows the other device\'s sessions, Claude\'s included, and SendMessage reaches them', async () => {
    const claudeB = fakeAgent();
    agents.push(claudeB);
    runHook(beta.sb, 'claude', claudeB.pid, 'session-start', { session_id: 'c-b', cwd: '/w/app' });
    await waitFor(() =>
      remoteState(alpha).devices.some((d) => d.slug === 'beta' && d.peers.some((p) => p.address.startsWith('claude:'))) ? true : undefined,
    );
    const claudeA = fakeAgent();
    agents.push(claudeA);
    runHook(alpha.sb, 'claude', claudeA.pid, 'session-start', { session_id: 'c-a', cwd: '/w/web' });
    const input = { session_id: 'c-a', tool_name: 'ListAgents', tool_response: { listing: 'Peer sessions (0):' } };
    const out = JSON.parse(runHook(alpha.sb, 'claude', claudeA.pid, 'list-agents', input).stdout).hookSpecificOutput;
    const listing: string = out.updatedToolOutput.listing;
    assert.match(listing, /^Peer sessions \(0\):\n\nOther agents' sessions \(1\)[^\n]*\n {2}qwen:web-q[0-9a-f]{2} \[qwen-g-a\]/);
    assert.match(listing, /\n\nSessions on device beta \(2\), reachable through the telepathy bridge with send_message:/);
    assert.match(listing, /\n {2}claude:[^\s]+@beta \[claude-c-b@beta\] {2}· {2}interactive/);
    assert.match(listing, /\n {2}qwen:docs-q[0-9a-f]{2}@beta \[qwen-g-b@beta\] {2}· {2}interactive/);

    const remoteClaude = /(claude:[^\s]+@beta)/.exec(listing)![1];
    // Nothing shows the marker in that Claude's transcript, so beta withdraws it inside alpha's short wait.
    const sent = spawnSync(process.execPath, [path.join(DIST, 'hook.mjs'), '--agent', 'claude', 'send-message'], {
      input: JSON.stringify({ session_id: 'c-a', tool_input: { to: remoteClaude, message: 'hello from alpha' } }),
      env: { ...alpha.sb.env, TELEPATHY_AGENT_PID: String(claudeA.pid), TELEPATHY_CONFIRM_ABORT_MS: '5000', TELEPATHY_CONFIRM_GRACE_MS: '300' },
      encoding: 'utf8',
    });
    const reason: string = JSON.parse(sent.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /^Not delivered: Message failed: claude:app@beta \[claude-c-b@beta\] did not show telepathy-id:m-/);
    assert.deepEqual(fs.readdirSync(path.join(beta.sb.home, 'peers', 'claude-c-b', 'inbox')), []);
  });

  test('a message nobody takes fails inside the sender\'s wait and leaves nothing on the other device', async () => {
    const qwenA = agents[1] as ChildProcess & { pid: number };
    const client = await connectServer(alpha.sb, 'qwen', qwenA.pid, ROOT, undefined, {
      TELEPATHY_CONFIRM_WAIT: '1',
      TELEPATHY_CONFIRM_ABORT_MS: '6000',
      TELEPATHY_CONFIRM_GRACE_MS: '500',
    });
    try {
      const started = Date.now();
      const result = await client.callTool({ name: 'send_message', arguments: { to: 'qwen:docs@beta', message: 'nobody reads this' } });
      assert.ok(Date.now() - started < 7000, 'inside the sender\'s 6.5s');
      assert.equal(result.isError, true);
      assert.match(toolText(result), /^Message failed: qwen:docs-q[0-9a-f]{2}@beta \[qwen-g-b@beta\] did not show telepathy-id:m-/);
      assert.deepEqual(fs.readdirSync(path.join(beta.sb.home, 'peers', 'qwen-g-b', 'inbox')), []);
      const unknown = await client.callTool({ name: 'send_message', arguments: { to: 'qwen:docs@gamma', message: 'hi' } });
      assert.match(toolText(unknown), /^No device named "gamma" is reachable\. Known devices: beta\./);
    } finally {
      await client.close();
    }
  });

  test('a stopped bridge makes that device offline, and a send fails at once', async () => {
    await killAndWait(beta.daemon!);
    beta.daemon = undefined;
    const qwen = agents[1] as ChildProcess & { pid: number };
    const early = await connectServer(alpha.sb, 'qwen', qwen.pid);
    try {
      // Still inside the online window: the connection is refused, so nothing reached beta.
      const refused = await early.callTool({ name: 'send_message', arguments: { to: 'qwen:docs@beta', message: 'anyone?' } });
      assert.match(toolText(refused), /^Message failed: device beta is offline \(its telepathy bridge refused the connection\)\. Nothing was sent\.$/);
    } finally {
      await early.close();
    }
    await waitFor(() => (/beta · paired · offline/.test(cli(alpha.env, 'bridge', 'status').stdout) ? true : undefined), 10_000);
    const qwenA = agents[1] as ChildProcess & { pid: number };
    const client = await connectServer(alpha.sb, 'qwen', qwenA.pid, ROOT, undefined, { TELEPATHY_BRIDGE_ONLINE_MS: '4000' });
    try {
      const result = await client.callTool({ name: 'send_message', arguments: { to: 'qwen:docs@beta', message: 'still there?' } });
      assert.match(toolText(result), /^Message failed: device beta is offline/);
      assert.match(toolText(await client.callTool({ name: 'list_peers', arguments: {} })), /Device beta \(paired, on the local network\) is offline, last seen/);
    } finally {
      await client.close();
    }
  });
});
