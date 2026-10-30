import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { sendMessage } from '../src/core/deliver.ts';
import { isDeliveryOwner, listPeers, markToolHook, readPeer, registerListener, registerPresence, registerSession, registerStableName } from '../src/core/peers.ts';
import { readMessagesTool } from '../src/core/tools.ts';
import { crossSessionInbound, readClaudeSocket, recordClaudeSocket, startClaudeSocketWatcher } from '../src/core/claude-socket.ts';
import { inboxDir, withdrawnDir } from '../src/core/paths.ts';
import { deliveryConfigPath, flushPendingWakes, probeDelivery, wakeLogPath } from '../src/core/wake.ts';
import { runDeliveryCli } from '../src/delivery.ts';
import { codexBridgeTimeoutFromCommandLine, codexBridgeTimeoutSec, setupNotes, unseenSetupNotes } from '../src/core/setup.ts';
import { describePeer, formatPeerList } from '../src/core/listing.ts';
import { fakeAgent, killAndWait, makeSandbox, setCodexProcs, type Sandbox, waitFor } from './helpers.ts';

const saved = {
  home: process.env.TELEPATHY_HOME,
  codex: process.env.CODEX_HOME,
  bin: process.env.TELEPATHY_CODEX_BIN,
  log: process.env.FAKE_CODEX_LOG,
  claude: process.env.CLAUDE_CONFIG_DIR,
  debug: process.env.TELEPATHY_DEBUG,
  fail: process.env.FAKE_CODEX_FAIL,
  name: process.env.TELEPATHY_NAME,
};

describe('delivery ladder', () => {
  let sb: Sandbox;
  const agents: ReturnType<typeof fakeAgent>[] = [];
  const spawn = () => {
    const agent = fakeAgent();
    agents.push(agent);
    return agent;
  };

  before(() => {
    sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CODEX_HOME = sb.codexHome;
    process.env.TELEPATHY_CODEX_BIN = sb.env.TELEPATHY_CODEX_BIN;
    process.env.FAKE_CODEX_LOG = sb.codexLog;
    process.env.CLAUDE_CONFIG_DIR = sb.env.CLAUDE_CONFIG_DIR;
    process.env.TELEPATHY_DEBUG = '1';
    delete process.env.FAKE_CODEX_FAIL;
    delete process.env.TELEPATHY_NAME;
  });

  after(async () => {
    await Promise.all(agents.map((a) => killAndWait(a)));
    sb.cleanup();
    for (const [key, value] of Object.entries({
      TELEPATHY_HOME: saved.home,
      CODEX_HOME: saved.codex,
      TELEPATHY_CODEX_BIN: saved.bin,
      FAKE_CODEX_LOG: saved.log,
      CLAUDE_CONFIG_DIR: saved.claude,
      TELEPATHY_DEBUG: saved.debug,
      FAKE_CODEX_FAIL: saved.fail,
      TELEPATHY_NAME: saved.name,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const rollout = (thread: string, event: string) => {
    const day = path.join(sb.codexHome, 'sessions', '2026', '10', '27');
    fs.mkdirSync(day, { recursive: true });
    fs.appendFileSync(
      path.join(day, `rollout-2026-10-27T12-00-00-${thread}.jsonl`),
      JSON.stringify({ type: 'event_msg', payload: { type: event } }) + '\n',
    );
  };

  const codexPeer = (thread: string) => {
    const proc = spawn();
    registerSession('codex', proc.pid, { sessionId: thread, cwd: `/work/${thread}`, source: 'hook', codexHome: sb.codexHome });
    return proc;
  };

  let senderN = 0;
  const sender = () => {
    const proc = spawn();
    const sessionId = `sender-${senderN++}`;
    const id = `claude-${sessionId}`;
    registerPresence('claude', proc.pid, { cwd: '/work/me' }, id);
    registerSession('claude', proc.pid, { sessionId, cwd: '/work/me', source: 'hook' });
    const peer = readPeer(id);
    assert.ok(peer);
    return peer;
  };

  test('a busy Codex with a tool hook keeps the inbox for the tool result and still queues for the turn end', async () => {
    const proc = codexPeer('thread-mid');
    markToolHook(`codex-thread-mid`);
    rollout('thread-mid', 'task_started');
    const before = fs.existsSync(sb.codexLog) ? fs.readFileSync(sb.codexLog, 'utf8').split('\n').filter(Boolean).length : 0;
    const result = await sendMessage(sender(), 'codex:thread-mid', 'steer this');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.status, /after its next tool call, or when the turn ends/);
    assert.equal(result.delivery.confirmed, false);
    assert.deepEqual(
      result.delivery.attempts.filter((a) => a.result !== 'unsupported').map((a) => [a.id, a.result, a.when]),
      [
        ['codex-mid-turn', 'armed', 'mid-turn'],
        ['codex-queue', 'armed', 'turn-end'],
      ],
    );
    const calls = fs.readFileSync(sb.codexLog, 'utf8').trim().split('\n').slice(before);
    assert.equal(calls.length, 1);
    const pending = fs.readdirSync(inboxDir(`codex-thread-mid`));
    assert.equal(pending.length, 1, 'the hook can still claim it');
    const stored = JSON.parse(fs.readFileSync(path.join(inboxDir(`codex-thread-mid`), pending[0]), 'utf8')) as { codexQueueId?: string };
    assert.ok(stored.codexQueueId);
    assert.equal(proc.pid > 0, true);
  });

  test('an idle Codex is queued for when the turn is not running', async () => {
    codexPeer('thread-idle');
    rollout('thread-idle', 'task_complete');
    const result = await sendMessage(sender(), 'codex:thread-idle', 'after the turn');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.status, /^Message queued for delivery to /);
    const queued = result.delivery.attempts.find((a) => a.id === 'codex-queue');
    assert.deepEqual(queued && { result: queued.result, when: queued.when }, { result: 'armed', when: 'idle' });
    assert.equal(result.delivery.confirmed, false);
  });

  test('a Codex with no thread fails immediately and stores nothing', async () => {
    const tui = spawn();
    setCodexProcs(sb, [{ pid: tui.pid, args: '/usr/local/bin/codex', cwd: '/work/fresh' }]);
    try {
      const listed = listPeers().find((p) => p.id === `codex-${tui.pid}`);
      assert.ok(listed);
      assert.equal(listed.sessionId, undefined);
      assert.match(describePeer(listed), /no thread yet/);
      const before = fs.existsSync(sb.codexLog) ? fs.readFileSync(sb.codexLog, 'utf8').split('\n').filter(Boolean).length : 0;
      const result = await sendMessage(sender(), listed.address, 'before the first prompt');
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /Message failed: .+ has no thread yet; prompt it once\./);
      assert.equal(fs.existsSync(inboxDir(listed.id)), false);
      const calls = fs.existsSync(sb.codexLog) ? fs.readFileSync(sb.codexLog, 'utf8').split('\n').filter(Boolean).slice(before) : [];
      assert.equal(calls.length, 0, 'codex queue was not called');
    } finally {
      setCodexProcs(sb, []);
      await killAndWait(tui);
    }
  });

  test('codex resume of an id is queued on that thread', async () => {
    const thread = '01a14000-bbbb-7000-8000-000000000002';
    const tui = spawn();
    const home = path.join(sb.codexHome, 'other');
    setCodexProcs(sb, [{ pid: tui.pid, args: `codex resume ${thread}`, cwd: '/work/resumed', codexHome: home }]);
    try {
      const listed = listPeers().find((p) => p.id === `codex-${thread}`);
      assert.ok(listed);
      assert.equal(listed.sessionId, thread);
      const before = fs.existsSync(sb.codexLog) ? fs.readFileSync(sb.codexLog, 'utf8').split('\n').filter(Boolean).length : 0;
      const result = await sendMessage(sender(), listed.id, 'after resume');
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.match(result.status, /^Message queued for delivery to /);
      const calls = fs.readFileSync(sb.codexLog, 'utf8').trim().split('\n').filter(Boolean).slice(before);
      assert.equal(calls.length, 1);
      assert.match(calls[0] ?? '', new RegExp(thread));
      assert.equal(JSON.parse(calls[0] ?? '{}').codexHome, home);
    } finally {
      setCodexProcs(sb, []);
      await killAndWait(tui);
    }
  });

  test('an interrupted Codex fails immediately and leaves nothing', async () => {
    codexPeer('thread-stop');
    rollout('thread-stop', 'turn_aborted');
    const before = fs.existsSync(sb.codexLog) ? fs.readFileSync(sb.codexLog, 'utf8').split('\n').filter(Boolean).length : 0;
    const started = Date.now();
    const result = await sendMessage(sender(), 'codex:thread-stop', 'after the stop');
    assert.ok(Date.now() - started < 2_000);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /is interrupted, so its queue will not run this\. Nothing was left for a later prompt\./);
    assert.doesNotMatch(result.error, /\b(stays|stored|delivered)\b/i);
    const calls = fs.existsSync(sb.codexLog) ? fs.readFileSync(sb.codexLog, 'utf8').trim().split('\n').filter(Boolean).slice(before) : [];
    assert.equal(calls.length, 0, 'codex queue was not called');
    assert.equal(fs.existsSync(inboxDir('codex-thread-stop')), false);
    assert.equal(fs.existsSync(withdrawnDir('codex-thread-stop')), false);
    const read = readMessagesTool('codex-thread-stop', {});
    assert.doesNotMatch(read.text, /after the stop/);
  });

  test('a codex queue failure leaves the message in the inbox', async () => {
    codexPeer('thread-fail');
    process.env.FAKE_CODEX_FAIL = '1';
    try {
      const result = await sendMessage(sender(), 'codex:thread-fail', 'keep me');
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.delivery.confirmed, false);
      assert.equal(result.delivery.attempts.find((a) => a.id === 'codex-queue')?.result, 'failed');
      assert.match(result.status, /codex queue failed/);
      assert.equal(fs.readdirSync(inboxDir('codex-thread-fail')).length, 1);
    } finally {
      delete process.env.FAKE_CODEX_FAIL;
    }
  });
});

describe('Claude inbox socket', () => {
  let sb: Sandbox;
  const agents: ReturnType<typeof fakeAgent>[] = [];
  let stop: (() => void) | undefined;

  before(() => {
    sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CLAUDE_CONFIG_DIR = sb.env.CLAUDE_CONFIG_DIR;
    process.env.TELEPATHY_DEBUG = '1';
    fs.mkdirSync(sb.home, { recursive: true });
    fs.mkdirSync(sb.env.CLAUDE_CONFIG_DIR, { recursive: true });
  });

  after(async () => {
    stop?.();
    await Promise.all(agents.map((a) => killAndWait(a)));
    sb.cleanup();
  });

  const pair = (name: string) => {
    const claude = fakeAgent();
    const other = fakeAgent();
    agents.push(claude, other);
    const cwd = path.join(sb.home, name);
    const id = `claude-${name}`;
    const fromId = `qwen-g-${name}`;
    registerPresence('claude', claude.pid, { cwd }, id);
    registerSession('claude', claude.pid, { sessionId: name, cwd, source: 'hook' });
    registerPresence('qwen', other.pid, { cwd: '/work/docs' }, fromId);
    registerSession('qwen', other.pid, { sessionId: `g-${name}`, cwd: '/work/docs', source: 'hook' });
    const from = readPeer(fromId);
    assert.ok(from);
    return { id, from, address: `claude:${name}` };
  };

  const serve = (file: string, respond: (buf: string) => string | undefined) =>
    new Promise<net.Server>((resolve) => {
      const server = net.createServer((socket) => {
        let buf = '';
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const reply = respond(buf);
          if (reply !== undefined) socket.end(reply);
        });
      });
      server.listen(file, () => resolve(server));
    });

  test('a delivered reply claims the inbox and a held reply does not', async () => {
    const deliveredSock = path.join(sb.home, 'delivered.sock');
    const heldSock = path.join(sb.home, 'held.sock');
    let deliveredBuf = '';
    const delivered = await serve(deliveredSock, (buf) => {
      deliveredBuf = buf;
      return buf.includes('"type":"user"') ? `${JSON.stringify({ type: 'delivered' })}\n` : undefined;
    });
    const held = await serve(heldSock, (buf) => (buf.includes('"type":"user"') ? `${JSON.stringify({ type: 'held' })}\n` : undefined));
    try {
      const first = pair('app');
      recordClaudeSocket(first.id, { CLAUDE_CODE_MESSAGING_SOCKET: deliveredSock, CLAUDE_CODE_MESSAGING_TOKEN: 'socket-token-a' });
      stop = startClaudeSocketWatcher(first.id);
      const ok = await sendMessage(first.from, first.address, 'via the socket');
      assert.equal(ok.ok, true);
      if (!ok.ok) return;
      assert.equal(ok.delivery.confirmed, true);
      assert.match(ok.status, /through Claude's inbox socket/);
      assert.match(deliveredBuf, /\{"type":"auth","token":"socket-token-a"\}/);
      assert.match(deliveredBuf, /\{"type":"user","message":\{"role":"user","content":".*via the socket/);
      assert.match(deliveredBuf, /from-name=\\"Qwen Code session qwen:docs/);
      assert.equal(fs.existsSync(path.join(inboxDir(first.id), `${ok.message.id}.json`)), false);
      const log = fs.readFileSync(path.join(sb.home, 'debug.log'), 'utf8');
      assert.equal(log.includes('socket-token-a'), false);

      stop();
      stop = undefined;
      const second = pair('held');
      recordClaudeSocket(second.id, { CLAUDE_CODE_MESSAGING_SOCKET: heldSock });
      stop = startClaudeSocketWatcher(second.id);
      const heldResult = await sendMessage(second.from, second.address, 'please hold');
      assert.equal(heldResult.ok, true);
      if (!heldResult.ok) return;
      assert.equal(heldResult.delivery.confirmed, false);
      assert.equal(heldResult.delivery.attempts.find((a) => a.id === 'claude-socket')?.detail, 'held');
      assert.match(heldResult.status, /cannot be recalled/);
      assert.match(heldResult.status, /inbox copy was withdrawn/);
      assert.doesNotMatch(heldResult.status, /Message failed/);
      assert.equal(fs.existsSync(path.join(inboxDir(second.id), `${heldResult.message.id}.json`)), false);
      assert.equal(fs.readdirSync(withdrawnDir(second.id)).length, 1);
    } finally {
      delivered.close();
      held.close();
      stop?.();
      stop = undefined;
    }
  });

  test('silence from the socket confirms an own-child post only when no inbound setting applies', async () => {
    const sock = path.join(sb.home, 'silent.sock');
    let posts = 0;
    const server = await serve(sock, (buf) => {
      if (!buf.includes('"type":"user"')) return undefined;
      posts += 1;
      return '';
    });
    try {
      const peer = pair('silent');
      recordClaudeSocket(peer.id, { CLAUDE_CODE_MESSAGING_SOCKET: sock });
      stop = startClaudeSocketWatcher(peer.id);
      const ok = await sendMessage(peer.from, peer.address, 'child post');
      assert.equal(ok.ok, true);
      if (!ok.ok) return;
      assert.equal(ok.delivery.confirmed, true);
      assert.equal(posts, 1);

      stop();
      fs.writeFileSync(path.join(sb.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ crossSessionInbound: 'hold' }));
      const held = pair('setting');
      recordClaudeSocket(held.id, { CLAUDE_CODE_MESSAGING_SOCKET: sock });
      stop = startClaudeSocketWatcher(held.id);
      const before = posts;
      const blocked = await sendMessage(held.from, held.address, 'held by setting');
      assert.equal(blocked.ok, true);
      if (!blocked.ok) return;
      assert.equal(blocked.delivery.confirmed, false);
      assert.match(blocked.status, /Nothing was posted to .+: that session is holding peer messages \(crossSessionInbound is hold\)/);
      assert.doesNotMatch(blocked.status, /Message stored/);
      assert.doesNotMatch(blocked.status, /\bdelivered\b/i);
      assert.doesNotMatch(blocked.status, /no listener/);
      assert.match(blocked.status, /can still be withdrawn/);
      assert.equal(posts, before);
      assert.equal(fs.existsSync(path.join(inboxDir(held.id), `${blocked.message.id}.json`)), true);
    } finally {
      server.close();
      fs.rmSync(path.join(sb.env.CLAUDE_CONFIG_DIR, 'settings.json'), { force: true });
      stop?.();
      stop = undefined;
    }
  });

  test('a hold or refuse is not posted, and lifting the hold posts once', async () => {
    process.env.TELEPATHY_HOLD_REPOST_DELAY_MS = '1';
    const sock = path.join(sb.home, 'once.sock');
    let posts = 0;
    const server = await serve(sock, (buf) => {
      if (!buf.includes('"type":"user"')) return undefined;
      posts += 1;
      return '';
    });
    try {
      const settingsDir = path.join(sb.home, 'once', '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(path.join(settingsDir, 'settings.local.json'), JSON.stringify({ crossSessionInbound: 'hold' }));
      const peer = pair('once');
      recordClaudeSocket(peer.id, { CLAUDE_CODE_MESSAGING_SOCKET: sock });
      stop = startClaudeSocketWatcher(peer.id);
      const held = await sendMessage(peer.from, peer.address, 'do not repeat');
      assert.equal(held.ok, true);
      if (!held.ok) return;
      assert.match(held.status, /Nothing was posted to .+: that session is holding peer messages \(crossSessionInbound is hold\)/);
      assert.doesNotMatch(held.status, /Message stored/);
      const log = path.join(sb.home, 'debug.log');
      const holdLines = () =>
        (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter((line) => line.includes(`${peer.id} crossSessionInbound is hold; not posting`)).length;
      await waitFor(() => (holdLines() === 1 ? true : undefined));
      const logged = holdLines();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.equal(holdLines(), logged, 'hold is logged once per state, not on every flush');
      assert.equal(posts, 0);
      assert.equal(fs.existsSync(path.join(inboxDir(peer.id), `${held.message.id}.json`)), true);
      fs.rmSync(path.join(sb.home, 'once', '.claude', 'settings.local.json'));
      const heldFile = path.join(inboxDir(peer.id), `${held.message.id}.json`);
      await waitFor(() => (posts === 1 && !fs.existsSync(heldFile) ? true : undefined));
      assert.equal(posts, 1);
      assert.equal(fs.existsSync(heldFile), false);
    } finally {
      server.close();
      fs.rmSync(path.join(sb.home, 'once', '.claude'), { recursive: true, force: true });
      stop?.();
      stop = undefined;
      delete process.env.TELEPATHY_HOLD_REPOST_DELAY_MS;
    }
  });

  test('a transcript marker is archived when a hold lifts, without a post', async () => {
    process.env.TELEPATHY_HOLD_REPOST_DELAY_MS = '5000';
    const transcript = path.join(sb.home, 'transcripts');
    fs.mkdirSync(transcript, { recursive: true });
    process.env.TELEPATHY_TRANSCRIPT_DIR = transcript;
    const sock = path.join(sb.home, 'delay.sock');
    let posts = 0;
    const server = await serve(sock, (buf) => {
      if (!buf.includes('"type":"user"')) return undefined;
      posts += 1;
      return '';
    });
    try {
      const settingsDir = path.join(sb.home, 'delay', '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(path.join(settingsDir, 'settings.local.json'), JSON.stringify({ crossSessionInbound: 'hold' }));
      const peer = pair('delay');
      recordClaudeSocket(peer.id, { CLAUDE_CODE_MESSAGING_SOCKET: sock });
      stop = startClaudeSocketWatcher(peer.id);
      const held = await sendMessage(peer.from, peer.address, 'already in the transcript');
      assert.equal(held.ok, true);
      if (!held.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(posts, 0);
      assert.equal(fs.existsSync(path.join(inboxDir(peer.id), `${held.message.id}.json`)), true);
      fs.writeFileSync(path.join(transcript, 'session.jsonl'), `telepathy-id:${held.message.id}\n`);
      fs.rmSync(path.join(settingsDir, 'settings.local.json'));
      process.env.TELEPATHY_HOLD_REPOST_DELAY_MS = '1';
      await waitFor(() => (fs.existsSync(path.join(sb.home, 'peers', peer.id, 'archive', `${held.message.id}.json`)) ? true : undefined));
      assert.equal(posts, 0, 'the marker is the release; do not post');
      assert.equal(fs.existsSync(path.join(inboxDir(peer.id), `${held.message.id}.json`)), false);
      assert.equal(fs.existsSync(path.join(sb.home, 'peers', peer.id, 'archive', `${held.message.id}.json`)), true);
    } finally {
      server.close();
      fs.rmSync(path.join(sb.home, 'delay', '.claude'), { recursive: true, force: true });
      stop?.();
      stop = undefined;
      delete process.env.TELEPATHY_HOLD_REPOST_DELAY_MS;
      delete process.env.TELEPATHY_TRANSCRIPT_DIR;
    }
  });

  test('crossSessionInbound lets a stricter project value beat managed, and ignores a looser one', () => {
    const managed = path.join(sb.home, 'managed-policy');
    fs.mkdirSync(path.join(managed, 'managed-settings.d'), { recursive: true });
    process.env.TELEPATHY_MANAGED_SETTINGS_DIR = managed;
    const peer = pair('policy');
    const cwd = path.join(sb.home, 'policy');
    const project = path.join(cwd, '.claude');
    fs.mkdirSync(project, { recursive: true });
    const user = path.join(sb.env.CLAUDE_CONFIG_DIR, 'settings.json');
    try {
      fs.writeFileSync(user, JSON.stringify({ crossSessionInbound: 'hold' }));
      fs.writeFileSync(path.join(project, 'settings.local.json'), JSON.stringify({ crossSessionInbound: 'accept' }));
      assert.equal(crossSessionInbound(readPeer(peer.id)), 'hold');

      fs.rmSync(path.join(project, 'settings.local.json'));
      fs.writeFileSync(path.join(project, 'settings.json'), JSON.stringify({ crossSessionInbound: 'refuse' }));
      assert.equal(crossSessionInbound(readPeer(peer.id)), 'refuse');

      fs.writeFileSync(path.join(managed, 'managed-settings.json'), JSON.stringify({ crossSessionInbound: 'accept' }));
      fs.writeFileSync(path.join(managed, 'managed-settings.d', '20-lock.json'), JSON.stringify({ crossSessionInbound: 'refuse' }));
      fs.writeFileSync(path.join(project, 'settings.local.json'), JSON.stringify({ crossSessionInbound: 'hold' }));
      assert.equal(crossSessionInbound(readPeer(peer.id)), 'refuse');

      fs.rmSync(path.join(managed, 'managed-settings.d', '20-lock.json'));
      fs.writeFileSync(path.join(project, 'settings.json'), JSON.stringify({ crossSessionInbound: 'refuse' }));
      assert.equal(crossSessionInbound(readPeer(peer.id)), 'hold');
    } finally {
      delete process.env.TELEPATHY_MANAGED_SETTINGS_DIR;
      fs.rmSync(user, { force: true });
      fs.rmSync(managed, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  test('only the delivery owner publishes its socket path', () => {
    const owner = fakeAgent();
    const other = fakeAgent();
    agents.push(owner, other);
    const cwd = path.join(sb.home, 'two-windows');
    const id = 'claude-two-windows';
    registerSession('claude', owner.pid, { sessionId: 'two-windows', cwd, source: 'hook' });
    registerSession('claude', other.pid, { sessionId: 'two-windows', cwd, source: 'hook' });
    assert.equal(isDeliveryOwner(id, owner.pid), true);
    assert.equal(isDeliveryOwner(id, other.pid), false);
    const ownerPath = path.join(sb.home, 'owner.sock');
    recordClaudeSocket(id, { CLAUDE_CODE_MESSAGING_SOCKET: ownerPath }, owner.pid);
    assert.equal(recordClaudeSocket(id, { CLAUDE_CODE_MESSAGING_SOCKET: path.join(sb.home, 'other.sock') }, other.pid), undefined);
    assert.equal(readClaudeSocket(id)?.path, ownerPath);
  });
});

describe('webhook and command wake', () => {
  let sb: Sandbox;
  const agents: ReturnType<typeof fakeAgent>[] = [];

  before(() => {
    sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.TELEPATHY_DEBUG = '1';
    process.env.TELEPATHY_WAKE_DEBOUNCE_MS = '1';
    delete process.env.TELEPATHY_NAME;
    fs.mkdirSync(sb.home, { recursive: true });
  });

  after(async () => {
    await flushPendingWakes();
    await Promise.all(agents.map((a) => killAndWait(a)));
    sb.cleanup();
    delete process.env.TELEPATHY_WAKE_DEBOUNCE_MS;
  });

  const grok = (name: string) => {
    const proc = fakeAgent();
    agents.push(proc);
    const cwd = `/work/${name}`;
    registerPresence('grok', proc.pid, { cwd });
    registerSession('grok', proc.pid, { cwd, source: 'hook' });
    registerStableName('grok', `grok-${proc.pid}`, name);
    const other = fakeAgent();
    agents.push(other);
    registerPresence('claude', other.pid, { cwd: '/work/me' });
    registerSession('claude', other.pid, { cwd: '/work/me', source: 'hook' });
    const from = readPeer(`claude-${other.pid}`);
    const to = readPeer(`grok-${proc.pid}`);
    assert.ok(from && to);
    return { from, to };
  };

  test('posts a wake without the message text, leaves the inbox, and does not log the secret', async () => {
    let body = '';
    let auth = '';
    const server = createHttp((req, res) => {
      auth = req.headers.authorization ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      fs.writeFileSync(
        deliveryConfigPath(),
        JSON.stringify({
          name: 'wake-bot',
          webhook: {
            url: `http://127.0.0.1:${port}/hook?key=query-secret`,
            headers: { Authorization: 'Bearer header-secret', 'X-Automation-Key': 'header-secret-2' },
            timeoutMs: 2000,
          },
        }),
        { mode: 0o600 },
      );
      const { from, to } = grok('wake-bot');
      assert.equal(to.address, 'grok:wake-bot');
      const result = await sendMessage(from, 'grok:wake-bot', 'the real message');
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.delivery.confirmed, false);
      assert.match(result.status, /A webhook wake for grok:wake-bot \[grok-\d+\] is scheduled/);
      assert.match(result.status, /must be treated as untrusted/);
      await flushPendingWakes();
      assert.equal(auth, 'Bearer header-secret');
      const posted = JSON.parse(body) as { id: string; ids: string[]; from: string; count: number; at: string; message?: string };
      assert.equal(posted.id, result.message.id);
      assert.deepEqual(posted.ids, [result.message.id]);
      assert.equal(posted.from, from.address);
      assert.equal(posted.count, 1);
      assert.equal(posted.at, result.message.sentAt);
      assert.equal(posted.message, undefined);
      assert.equal(fs.existsSync(path.join(inboxDir(to.id), `${result.message.id}.json`)), true);
      const log = fs.readFileSync(path.join(sb.home, 'debug.log'), 'utf8');
      assert.equal(log.includes('header-secret'), false);
      assert.equal(log.includes('query-secret'), false);
    } finally {
      server.close();
    }
  });

  test('a failed webhook keeps the message and a loose config file is ignored', async () => {
    fs.writeFileSync(
      deliveryConfigPath(),
      JSON.stringify({
        name: 'fail-bot',
        webhook: { url: 'http://127.0.0.1:1/nope?key=query-secret', key: 'header-secret', timeoutMs: 200 },
      }),
      { mode: 0o600 },
    );
    const { from, to } = grok('fail-bot');
    const failed = await sendMessage(from, to.address, 'still here');
    assert.equal(failed.ok, true);
    if (!failed.ok) return;
    assert.match(failed.status, /webhook wake for/);
    await flushPendingWakes();
    assert.equal(fs.existsSync(path.join(inboxDir(to.id), `${failed.message.id}.json`)), true);
    const wakeLog = fs.readFileSync(wakeLogPath(), 'utf8');
    assert.match(wakeLog, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z webhook 127\.0\.0\.1:1 failed:/m);
    assert.equal(wakeLog.includes('still here'), false);
    assert.equal(wakeLog.includes('header-secret'), false);
    assert.equal(wakeLog.includes('query-secret'), false);

    fs.chmodSync(deliveryConfigPath(), 0o644);
    const ignored = await sendMessage(from, to.address, 'no wake');
    assert.equal(ignored.ok, true);
    if (!ignored.ok) return;
    assert.doesNotMatch(ignored.status, /webhook/);
  });

  test('a command gets the wake on stdin when no webhook is set', async () => {
    const out = path.join(sb.home, 'command-out.txt');
    fs.writeFileSync(
      deliveryConfigPath(),
      JSON.stringify({
        name: 'cmd-bot',
        command: [
          process.execPath,
          '-e',
          "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.env.WAKE_OUT,d))",
        ],
      }),
      { mode: 0o600 },
    );
    fs.chmodSync(deliveryConfigPath(), 0o600);
    process.env.WAKE_OUT = out;
    const { from, to } = grok('cmd-bot');
    const result = await sendMessage(from, to.address, 'ping');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.status, /delivery command wake for/);
    await flushPendingWakes();
    const wrote = JSON.parse(fs.readFileSync(out, 'utf8')) as { id: string };
    assert.equal(wrote.id, result.message.id);
    assert.equal(fs.existsSync(path.join(inboxDir(to.id), `${result.message.id}.json`)), true);
  });

  test('a burst of messages is one POST, and the default key is sent on both auth headers', async () => {
    process.env.TELEPATHY_WAKE_DEBOUNCE_MS = '500';
    const seen: { body: string; auth: string; automation: string; type: string }[] = [];
    const server = createHttp((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          body: Buffer.concat(chunks).toString('utf8'),
          auth: req.headers.authorization ?? '',
          automation: String(req.headers['x-automation-key'] ?? ''),
          type: String(req.headers['content-type'] ?? ''),
        });
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      fs.writeFileSync(
        deliveryConfigPath(),
        JSON.stringify({
          name: 'batch-bot',
          webhook: { url: `http://127.0.0.1:${port}/hook`, key: 'bot-key', timeoutMs: 2000 },
        }),
        { mode: 0o600 },
      );
      const { from, to } = grok('batch-bot');
      const [first, second] = await Promise.all([
        sendMessage(from, to.address, 'one'),
        sendMessage(from, to.address, 'two'),
      ]);
      assert.equal(first.ok && second.ok, true);
      if (!first.ok || !second.ok) return;
      await flushPendingWakes();
      assert.equal(seen.length, 1);
      const posted = JSON.parse(seen[0].body) as { id: string; ids: string[]; count: number; message?: string };
      assert.equal(posted.count, 2);
      assert.deepEqual([...posted.ids].sort(), [first.message.id, second.message.id].sort());
      assert.equal(posted.id, posted.ids[posted.ids.length - 1]);
      assert.equal(posted.message, undefined);
      assert.equal(seen[0].auth, 'Bearer bot-key');
      assert.equal(seen[0].automation, 'bot-key');
      assert.match(seen[0].type, /application\/json/);
      const log = fs.existsSync(path.join(sb.home, 'debug.log')) ? fs.readFileSync(path.join(sb.home, 'debug.log'), 'utf8') : '';
      assert.equal(log.includes('bot-key'), false);
    } finally {
      process.env.TELEPATHY_WAKE_DEBOUNCE_MS = '1';
      server.close();
    }
  });

  test('authHeaders replaces the default pair, and a probe posts only the probe event', async () => {
    let body = '';
    let auth = '';
    let automation = '';
    let custom = '';
    const server = createHttp((req, res) => {
      auth = req.headers.authorization ?? '';
      automation = String(req.headers['x-automation-key'] ?? '');
      custom = String(req.headers['x-custom-key'] ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      fs.writeFileSync(
        deliveryConfigPath(),
        JSON.stringify({
          name: 'probe-bot',
          webhook: {
            url: `http://127.0.0.1:${port}/hook?token=query-secret`,
            key: 'probe-key',
            authHeaders: ['X-Custom-Key'],
            timeoutMs: 2000,
          },
        }),
        { mode: 0o600 },
      );
      const probed = await probeDelivery();
      assert.equal(probed.error, undefined);
      assert.equal(probed.reports.length, 1);
      assert.equal(probed.reports[0].ok, true);
      assert.equal(probed.reports[0].status, 200);
      assert.equal(probed.reports[0].target, `127.0.0.1:${port}`);
      assert.equal(body, '{"event":"probe"}');
      assert.equal(custom, 'probe-key');
      assert.equal(auth, '');
      assert.equal(automation, '');
      const cli = await runDeliveryCli(['test', 'probe-bot']);
      assert.equal(cli.code, 0);
      assert.equal(cli.stdout, `webhook 127.0.0.1:${port} HTTP 200\n`);
      assert.equal(cli.stderr, '');
      const log = [path.join(sb.home, 'debug.log'), wakeLogPath()]
        .filter((file) => fs.existsSync(file))
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n');
      assert.equal(log.includes('probe-key'), false);
      assert.equal(log.includes('query-secret'), false);
    } finally {
      server.close();
    }
  });

  test('a failed command is logged without the message text', async () => {
    fs.writeFileSync(
      deliveryConfigPath(),
      JSON.stringify({
        name: 'bad-cmd',
        command: [process.execPath, '-e', 'process.exit(2)'],
      }),
      { mode: 0o600 },
    );
    fs.chmodSync(deliveryConfigPath(), 0o600);
    const { from, to } = grok('bad-cmd');
    const result = await sendMessage(from, to.address, 'secret body');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    await flushPendingWakes();
    const wakeLog = fs.readFileSync(wakeLogPath(), 'utf8');
    assert.match(wakeLog, new RegExp(`command ${path.basename(process.execPath)} exited 2`));
    assert.equal(wakeLog.includes('secret body'), false);
    assert.equal(fs.existsSync(path.join(inboxDir(to.id), `${result.message.id}.json`)), true);
  });
});

describe('stable name and duplicate sessions', () => {
  let sb: Sandbox;
  const agents: ReturnType<typeof fakeAgent>[] = [];

  before(() => {
    sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    delete process.env.TELEPATHY_NAME;
  });

  after(async () => {
    await Promise.all(agents.map((a) => killAndWait(a)));
    sb.cleanup();
  });

  test('a configured name survives a new process and keeps unread messages', async () => {
    const first = fakeAgent();
    agents.push(first);
    registerPresence('grok', first.pid, { cwd: '/work/app' });
    registerSession('grok', first.pid, { cwd: '/work/app', source: 'hook' });
    registerStableName('grok', `grok-${first.pid}`, 'my-bot');
    const old = readPeer(`grok-${first.pid}`);
    assert.equal(old?.address, 'grok:my-bot');
    fs.mkdirSync(inboxDir(`grok-${first.pid}`), { recursive: true });
    fs.writeFileSync(
      path.join(inboxDir(`grok-${first.pid}`), 'm-000000001-aabbcc.json'),
      JSON.stringify({
        id: 'm-000000001-aabbcc',
        from: { id: 'claude-1', agent: 'claude', name: 'me', address: 'claude:me' },
        to: { id: old?.id, agent: 'grok', name: 'my-bot', address: 'grok:my-bot' },
        body: 'still unread',
        sentAt: new Date().toISOString(),
      }),
    );
    await killAndWait(first);
    const second = fakeAgent();
    agents.push(second);
    registerPresence('grok', second.pid, { cwd: '/work/app' });
    registerSession('grok', second.pid, { cwd: '/work/app', source: 'hook' });
    registerStableName('grok', `grok-${second.pid}`, 'my-bot');
    const next = readPeer(`grok-${second.pid}`);
    assert.equal(next?.address, 'grok:my-bot');
    assert.equal(next?.id === old?.id, false);
    const read = readMessagesTool(`grok-${second.pid}`, {});
    assert.equal(read.structured?.messages[0]?.id, 'm-000000001-aabbcc');
    assert.equal(read.structured?.messages[0]?.body, 'still unread');
  });

  test('two live sessions with the same name are flagged', () => {
    const a = fakeAgent();
    const b = fakeAgent();
    agents.push(a, b);
    for (const proc of [a, b]) {
      registerPresence('grok', proc.pid, { cwd: '/work/dup' });
      registerSession('grok', proc.pid, { cwd: '/work/dup', source: 'hook' });
      registerStableName('grok', `grok-${proc.pid}`, 'same-bot');
    }
    const self = readPeer(`grok-${a.pid}`);
    const other = readPeer(`grok-${b.pid}`);
    assert.ok(self && other);
    assert.match(setupNotes(self).join('\n'), /2 live sessions share the name grok:same-bot/);
    assert.match(formatPeerList(self, [other]), /duplicate session/);
    assert.match(formatPeerList(self, [other]), /Use the \[ref\] to pick one/);
  });

  test('setup warns with the Codex bridge timeout key when it is missing or below 110', () => {
    const proc = fakeAgent();
    agents.push(proc);
    registerPresence('codex', proc.pid, { cwd: '/work/cx', codexHome: sb.codexHome });
    registerSession('codex', proc.pid, { sessionId: 'thread-timeout', cwd: '/work/cx', source: 'hook', codexHome: sb.codexHome });
    const self = readPeer('codex-thread-timeout');
    assert.ok(self);
    const config = path.join(sb.codexHome, 'config.toml');
    const key = 'plugins."telepathy@telepathy".mcp_servers.bridge.tool_timeout_sec';
    fs.writeFileSync(config, 'model = "m"\n');
    assert.equal(codexBridgeTimeoutSec(fs.readFileSync(config, 'utf8')), undefined);
    assert.match(setupNotes(self).join('\n'), /Could not verify/);
    assert.match(setupNotes(self).join('\n'), new RegExp(key.replace(/[.]/g, '\\.')));
    assert.doesNotMatch(setupNotes(self).join('\n'), /unset/);
    fs.writeFileSync(config, `[plugins."telepathy@telepathy".mcp_servers.bridge]\ntool_timeout_sec = 60\n`);
    assert.equal(codexBridgeTimeoutSec(fs.readFileSync(config, 'utf8')), 60);
    assert.match(setupNotes(self).join('\n'), /60s/);
    fs.appendFileSync(config, `\n${key} = 180\n`);
    assert.equal(codexBridgeTimeoutSec(fs.readFileSync(config, 'utf8')), 180);
    assert.doesNotMatch(setupNotes(self).join('\n'), /tool_timeout_sec/);
    const argv = `codex -c '${key}=150'`;
    assert.equal(codexBridgeTimeoutFromCommandLine(argv), 150);
    assert.equal(codexBridgeTimeoutFromCommandLine(`${argv} -c '${key}=90'`), 90);
    fs.rmSync(config, { force: true });
  });

  test('a Codex session whose hooks have fired is not warned that they are unapproved', () => {
    const ran = fakeAgent();
    const quiet = fakeAgent();
    agents.push(ran, quiet);
    registerPresence('codex', ran.pid, { cwd: '/work/ran', codexHome: sb.codexHome });
    registerSession('codex', ran.pid, { sessionId: 'thread-ran', cwd: '/work/ran', source: 'hook', codexHome: sb.codexHome });
    registerPresence('codex', quiet.pid, { cwd: '/work/quiet', codexHome: sb.codexHome });
    registerSession('codex', quiet.pid, { sessionId: 'thread-quiet', cwd: '/work/quiet', source: 'meta', codexHome: sb.codexHome });
    const hooked = readPeer('codex-thread-ran');
    const unhooked = readPeer('codex-thread-quiet');
    assert.ok(hooked && unhooked);
    fs.writeFileSync(path.join(sb.codexHome, 'config.toml'), 'model = "m"\n');
    assert.doesNotMatch(setupNotes(hooked).join('\n'), /hook/);
    assert.match(setupNotes(unhooked).join('\n'), /No telepathy hook has fired/);
    const first = unseenSetupNotes(unhooked);
    assert.match(first.join('\n'), /No telepathy hook has fired/);
    assert.deepEqual(unseenSetupNotes(unhooked), []);
    fs.rmSync(path.join(sb.codexHome, 'config.toml'), { force: true });
  });

  test('an idle Claude with an inbox socket is listed as seeing messages through it', () => {
    const claude = fakeAgent();
    agents.push(claude);
    const cwd = path.join(sb.home, 'sockhint');
    fs.mkdirSync(cwd, { recursive: true });
    registerPresence('claude', claude.pid, { cwd }, 'claude-sockhint');
    registerSession('claude', claude.pid, { sessionId: 'sockhint', cwd, source: 'hook' });
    recordClaudeSocket('claude-sockhint', { CLAUDE_CODE_MESSAGING_SOCKET: path.join(sb.home, 'hint.sock') });
    const listed = readPeer('claude-sockhint');
    assert.ok(listed);
    assert.match(describePeer(listed), /sees messages through its inbox socket/);
    assert.doesNotMatch(describePeer(listed), /next turn/);
    const local = path.join(cwd, '.claude');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'settings.local.json'), JSON.stringify({ crossSessionInbound: 'hold' }));
    const held = readPeer('claude-sockhint');
    assert.ok(held);
    assert.match(describePeer(held), /sees messages at its next turn/);
    assert.doesNotMatch(describePeer(held), /inbox socket/);
  });

  test('copilot under the host is not listed as waiting for its next turn', () => {
    const proc = fakeAgent();
    agents.push(proc);
    registerPresence('copilot', proc.pid, { cwd: '/work/cp' }, 'copilot-sess-list');
    registerSession('copilot', proc.pid, { sessionId: 'sess-list', cwd: '/work/cp', source: 'hook' });
    const idle = readPeer('copilot-sess-list');
    assert.ok(idle);
    assert.match(describePeer(idle), /sees messages at its next turn/);
    registerListener('copilot', proc.pid, 'copilot-sess-list');
    const hosted = readPeer('copilot-sess-list');
    assert.ok(hosted);
    assert.match(describePeer(hosted), /the host delivers messages as they arrive/);
    assert.doesNotMatch(describePeer(hosted), /next turn/);
  });

  test('read_messages with nothing waiting is an empty array, not a message', () => {
    const proc = fakeAgent();
    agents.push(proc);
    registerPresence('grok', proc.pid, { cwd: '/work/empty' });
    const read = readMessagesTool(`grok-${proc.pid}`, {});
    assert.equal(read.text, 'No messages received yet.');
    assert.deepEqual(read.structured, { messages: [] });
  });
});
