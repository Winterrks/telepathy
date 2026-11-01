import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
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

describe('a device that does not accept connections', () => {
  let alpha: Device;
  let gamma: Device;
  const agents: ChildProcess[] = [];
  // Accepts and never answers: what a macOS firewall holding `node` looks like from the other device.
  const held = new Set<net.Socket>();
  const blackHole = net.createServer((socket) => {
    held.add(socket);
    socket.on('close', () => held.delete(socket));
  });

  before(async () => {
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    alpha = await device('alpha', { TELEPATHY_BRIDGE_HOLD_MS: '1000' });
    gamma = await device('gamma', { TELEPATHY_BRIDGE_HOLD_MS: '1000' });
    await startDaemon(alpha);
    await startDaemon(gamma);
    // Gamma tells alpha its bridge is at the black hole, so alpha can never connect to it. Gamma reaches alpha.
    const port = (blackHole.address() as net.AddressInfo).port;
    await pair({ ...gamma, env: { ...gamma.env, TELEPATHY_BRIDGE_PORT: String(port) } }, alpha);
  });

  after(async () => {
    for (const child of [...agents, alpha?.daemon, gamma?.daemon]) if (child) await killAndWait(child);
    for (const socket of held) socket.destroy();
    blackHole.close();
    alpha?.sb.cleanup();
    gamma?.sb.cleanup();
  });

  test('its sessions are listed over the connection it keeps open, and both status screens say so', async () => {
    const qwenG = fakeAgent();
    agents.push(qwenG);
    runHook(gamma.sb, 'qwen', qwenG.pid, 'session-start', { session_id: 'g-g', cwd: '/w/notes' });
    await waitFor(() =>
      remoteState(alpha).devices.some(
        (d) => d.slug === 'gamma' && d.trusted && (d as { reach?: string }).reach === 'reverse' && d.peers.some((p) => p.address.startsWith('qwen:notes')),
      )
        ? true
        : undefined,
    );
    const here = cli(alpha.env, 'bridge', 'status').stdout;
    assert.match(here, /gamma · paired · 127\.0\.0\.1 · 1 session · over its own connection \(gamma does not accept connections\)/);
    assert.doesNotMatch(here, /does not accept connections from other devices/);
    await waitFor(() => (/alpha can't connect to this device/.test(cli(gamma.env, 'bridge', 'status').stdout) ? true : undefined));
    const there = cli(gamma.env, 'bridge', 'status').stdout;
    assert.match(there, /This device does not accept connections from other devices\. Messages still go both ways/);
  });

  test('a message to it goes out over that connection and is checked there like a direct one', async () => {
    const qwenA = fakeAgent();
    agents.push(qwenA);
    runHook(alpha.sb, 'qwen', qwenA.pid, 'session-start', { session_id: 'g-a', cwd: '/w/web' });
    const client = await connectServer(alpha.sb, 'qwen', qwenA.pid);
    try {
      const sent = toolText(await client.callTool({ name: 'send_message', arguments: { to: 'qwen:notes@gamma', message: 'over the reverse connection' } }));
      assert.match(sent, /^Message stored for qwen:notes-q[0-9a-f]{2}@gamma \[qwen-g-g@gamma\]/);
      const inbox = path.join(gamma.sb.home, 'peers', 'qwen-g-g', 'inbox');
      const msg = JSON.parse(fs.readFileSync(path.join(inbox, fs.readdirSync(inbox)[0]), 'utf8'));
      assert.match(msg.from.address, /^qwen:web-q[0-9a-f]{2}@alpha$/);
      assert.equal(msg.body, 'over the reverse connection');
    } finally {
      await client.close();
    }
  });

  test('the outbox carries only the routes a device serves', async () => {
    const res = await fetch(`http://127.0.0.1:${alpha.port}/v1/outbox`, {
      method: 'POST',
      body: JSON.stringify({ device: 'ffffffffffffffff', route: '/v1/reverse', wire: {} }),
    });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /malformed request/, 'only the routes a device serves can go out');
  });

  test('once it stops, a send fails as never sent instead of waiting out the clock', async () => {
    await killAndWait(gamma.daemon!);
    gamma.daemon = undefined;
    const qwenA = agents[1] as ChildProcess & { pid: number };
    const client = await connectServer(alpha.sb, 'qwen', qwenA.pid);
    try {
      const started = Date.now();
      const result = await client.callTool({ name: 'send_message', arguments: { to: 'qwen:notes@gamma', message: 'still there?' } });
      assert.equal(result.isError, true);
      assert.match(toolText(result), /^Message failed: device gamma is offline \(.*\)\. Nothing was sent\.$/);
      assert.ok(Date.now() - started < 4000, 'well inside the confirm window');
    } finally {
      await client.close();
    }
  });
});

// A telepathy install whose version the test controls: what `npm install -g telepathy-cli` replaces in place.
const CLI_URL = pathToFileURL(CLI).href;
const install = (version: string, opts: { broken?: boolean } = {}) =>
  `globalThis.__TELEPATHY_VERSION__ = ${JSON.stringify(version)};\n` +
  (opts.broken ? `if (process.argv.includes('run')) process.exit(3);\n` : '') +
  `await import(${JSON.stringify(CLI_URL)});\n`;

// Stands in for auto-update: records each check, and installs the release the test published, if any.
const UPDATER = `import fs from 'node:fs';
const env = process.env;
fs.appendFileSync(env.FAKE_UPDATES, JSON.stringify({ force: env.TELEPATHY_AUTO_UPDATE_FORCE === '1' }) + '\\n');
let release;
try {
  release = JSON.parse(fs.readFileSync(env.FAKE_RELEASE, 'utf8'));
} catch {}
if (release && !fs.readFileSync(env.FAKE_WRAPPER, 'utf8').includes(JSON.stringify(release.version))) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  fs.writeFileSync(env.FAKE_WRAPPER, ${JSON.stringify(install('@@VERSION@@'))}.replace('"@@VERSION@@"', JSON.stringify(release.version)));
}
`;

describe('bridges that update together', () => {
  let alpha: Device;
  let gamma: Device;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-bridge-update-'));
  const release = path.join(dir, 'release.json');
  const updater = path.join(dir, 'updater.mjs');
  const entryOf = (d: Device) => path.join(dir, d.name, 'telepathy.mjs');
  const updatesOf = (d: Device) => path.join(dir, d.name, 'updates.jsonl');
  const record = (d: Device) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(d.sb.home, 'bridge', 'daemon.json'), 'utf8')) as {
        pid: number;
        startedAt: string;
        version?: string;
        restart?: { into: string; at?: number; waitingFor: string[] };
        failedInto?: string;
      };
    } catch {
      return undefined;
    }
  };
  const seen = (from: Device, slug: string) =>
    (JSON.parse(fs.readFileSync(path.join(from.sb.home, 'bridge', 'remote.json'), 'utf8')) as {
      devices: { slug: string; trusted: boolean; lastSeen: string; version?: string; installed?: string }[];
    }).devices.find((d) => d.slug === slug && d.trusted && Date.now() - Date.parse(d.lastSeen) < 4000);

  before(async () => {
    fs.writeFileSync(updater, UPDATER);
    const env = (name: string) => ({
      TELEPATHY_AUTO_UPDATE: '1',
      TELEPATHY_AUTO_UPDATE_ENTRY: updater,
      TELEPATHY_BRIDGE_INSTALL_CHECK_MS: '200',
      TELEPATHY_BRIDGE_RESTART_WAIT_MS: '60000',
      FAKE_RELEASE: release,
      FAKE_WRAPPER: path.join(dir, name, 'telepathy.mjs'),
      FAKE_UPDATES: path.join(dir, name, 'updates.jsonl'),
    });
    alpha = await device('alpha', env('alpha'));
    gamma = await device('gamma', env('gamma'));
    for (const d of [alpha, gamma]) {
      fs.mkdirSync(path.dirname(entryOf(d)), { recursive: true });
      fs.writeFileSync(entryOf(d), install('0.0.1'));
      const child = spawn(process.execPath, [entryOf(d), 'bridge', 'run'], { env: d.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      d.daemon = child;
      await waitFor(() => (out.includes('listening on') ? true : undefined), 15_000);
    }
    await pair(gamma, alpha);
    await waitFor(() => (seen(alpha, 'gamma')?.version === '0.0.1' && seen(gamma, 'alpha')?.version === '0.0.1' ? true : undefined), 15_000);
  });

  after(async () => {
    // Restarted bridges are detached; daemon.json names them.
    for (const d of [alpha, gamma]) {
      if (!d) continue;
      cli(d.env, 'bridge', 'stop');
      const pid = record(d)?.pid;
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      if (d.daemon) await killAndWait(d.daemon);
      d.sb.cleanup();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a newer version on one device makes the other check for updates, and both restart into it at one moment', async (t) => {
    const first = { alpha: record(alpha)?.pid, gamma: record(gamma)?.pid };
    fs.writeFileSync(release, JSON.stringify({ version: '0.0.2' }));
    // Alpha's own update lands first.
    fs.writeFileSync(entryOf(alpha), install('0.0.2'));
    // Alpha waits for gamma, which checks for updates because alpha has a newer version.
    await waitFor(() => (record(alpha)?.restart?.waitingFor.includes('gamma') ? true : undefined), 15_000, 20);
    const [a, g] = await waitFor(() => {
      const [ra, rg] = [record(alpha), record(gamma)];
      return ra?.version === '0.0.2' && rg?.version === '0.0.2' && ra.pid !== first.alpha && rg.pid !== first.gamma ? [ra, rg] : undefined;
    }, 30_000);
    const apart = Math.abs(Date.parse(a.startedAt) - Date.parse(g.startedAt));
    t.diagnostic(`the two bridges restarted ${apart}ms apart`);
    assert.ok(apart < 1500, `restarted together: ${a.startedAt} and ${g.startedAt}`);
    const checks = fs.readFileSync(updatesOf(gamma), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { force: boolean });
    assert.ok(checks.some((check) => check.force), 'gamma checked for updates at once, not at its next daily check');
    // The new bridges find each other again, each on the new version.
    await waitFor(() => (seen(alpha, 'gamma')?.version === '0.0.2' && seen(gamma, 'alpha')?.version === '0.0.2' ? true : undefined), 15_000);
    assert.match(cli(alpha.env, 'bridge', 'status').stdout, /^telepathy bridge 0\.0\.2 · alpha · listening on/);
  });

  test('a new version whose bridge does not start leaves the running one up', async () => {
    const before = record(alpha);
    fs.writeFileSync(release, JSON.stringify({ version: '0.0.3' }));
    fs.writeFileSync(entryOf(alpha), install('0.0.3', { broken: true }));
    await waitFor(() => (record(alpha)?.failedInto === '0.0.3' ? true : undefined), 30_000);
    const now = record(alpha);
    assert.equal(now?.pid, before?.pid, 'the same bridge took its port back');
    assert.equal(now?.version, '0.0.2');
    assert.match(cli(alpha.env, 'bridge', 'status').stdout, /could not restart into telepathy 0\.0\.3, so it still runs 0\.0\.2/);
    // Gamma restarted into 0.0.3 and still reaches alpha, which says what it has.
    await waitFor(() => (record(gamma)?.version === '0.0.3' && seen(gamma, 'alpha')?.installed === '0.0.3' ? true : undefined), 30_000);
    assert.match(cli(gamma.env, 'bridge', 'status').stdout, /alpha · paired · 127\.0\.0\.1:\d+ · \d+ sessions? · telepathy 0\.0\.2, 0\.0\.3 installed/);
  });

  test('a device on a protocol this one can\'t speak is listed with its version, and pairing with it is refused', async () => {
    const future = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocol: 2, id: 'fedcba9876543210', name: 'future', version: '9.0.0', pairing: true }));
    });
    await new Promise<void>((resolve) => future.listen(0, '127.0.0.1', resolve));
    const addr = `127.0.0.1:${(future.address() as net.AddressInfo).port}`;
    const checks = () => fs.readFileSync(updatesOf(alpha), 'utf8').split('\n').filter((line) => line.includes('"force":true')).length;
    const forced = checks();
    try {
      assert.equal(cli(alpha.env, 'bridge', 'add', addr).status, 0);
      await waitFor(() =>
        /future · manual 127\.0\.0\.1:\d+ · runs telepathy 9\.0\.0, which this one \(0\.0\.2\) can't talk to\. Pairing needs versions that match/.test(
          cli(alpha.env, 'bridge', 'status').stdout,
        )
          ? true
          : undefined,
      );
      // Not spawnSync: the device answering is a server in this process.
      const paired = spawnCli(alpha.env, 'bridge', 'pair', addr);
      assert.equal(await paired.done, 1);
      assert.match(paired.out(), /future runs telepathy 9\.0\.0, which this one \(0\.0\.0-dev\) can't talk to/);
      // A device it does not trust can claim any version; that is no reason to check.
      assert.equal(checks(), forced);
    } finally {
      cli(alpha.env, 'bridge', 'remove', addr);
      future.close();
    }
  });
});
