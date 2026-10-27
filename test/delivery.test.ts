import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { sendMessage } from '../src/core/deliver.ts';
import { markToolHook, readPeer, registerPresence, registerSession, registerStableName } from '../src/core/peers.ts';
import { readMessagesTool } from '../src/core/tools.ts';
import { recordClaudeSocket, startClaudeSocketWatcher } from '../src/core/claude-socket.ts';
import { inboxDir } from '../src/core/paths.ts';
import { deliveryConfigPath } from '../src/core/wake.ts';
import { setupNotes } from '../src/core/setup.ts';
import { formatPeerList } from '../src/core/listing.ts';
import { fakeAgent, killAndWait, makeSandbox, type Sandbox } from './helpers.ts';

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

  const sender = () => {
    const proc = spawn();
    registerPresence('claude', proc.pid, { cwd: '/work/me' });
    registerSession('claude', proc.pid, { sessionId: 's', cwd: '/work/me', source: 'hook' });
    const peer = readPeer(`claude-${proc.pid}`);
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

  test('an interrupted Codex is not queued and the inbox copy stays unclaimed', async () => {
    codexPeer('thread-stop');
    rollout('thread-stop', 'turn_aborted');
    const before = fs.existsSync(sb.codexLog) ? fs.readFileSync(sb.codexLog, 'utf8').split('\n').filter(Boolean).length : 0;
    const result = await sendMessage(sender(), 'codex:thread-stop', 'after the stop');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.delivery.confirmed, false);
    assert.equal(result.delivery.attempts.find((a) => a.id === 'codex-queue')?.result, 'unsupported');
    assert.match(result.status, /Codex was interrupted, so its queue will not deliver this/);
    assert.match(result.status, /next prompt/);
    const calls = fs.existsSync(sb.codexLog) ? fs.readFileSync(sb.codexLog, 'utf8').trim().split('\n').filter(Boolean).slice(before) : [];
    assert.equal(calls.length, 0, 'codex queue was not called');
    const [file] = fs.readdirSync(inboxDir('codex-thread-stop'));
    const stored = JSON.parse(fs.readFileSync(path.join(inboxDir('codex-thread-stop'), file), 'utf8')) as { body: string; codexQueueId?: string };
    assert.equal(stored.body, 'after the stop');
    assert.equal(stored.codexQueueId, undefined);
    const read = readMessagesTool('codex-thread-stop', {});
    assert.match(read.text, /after the stop/);
    assert.deepEqual(read.structured?.messages.map((m) => m.body), ['after the stop']);
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
    registerPresence('claude', claude.pid, { cwd: `/work/${name}` });
    registerSession('claude', claude.pid, { sessionId: 's', cwd: `/work/${name}`, source: 'hook' });
    registerPresence('gemini', other.pid, { cwd: '/work/docs' });
    registerSession('gemini', other.pid, { sessionId: 'g', cwd: '/work/docs', source: 'hook' });
    const from = readPeer(`gemini-${other.pid}`);
    assert.ok(from);
    return { id: `claude-${claude.pid}`, from, address: `claude:${name}` };
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
      assert.equal(fs.existsSync(path.join(inboxDir(second.id), `${heldResult.message.id}.json`)), true);
      const read = readMessagesTool(second.id, {});
      assert.equal(read.structured?.messages[0]?.body, 'please hold');
      assert.match(read.text, /please hold/);
    } finally {
      delivered.close();
      held.close();
      stop?.();
      stop = undefined;
    }
  });

  test('silence from the socket confirms an own-child post only when no inbound setting applies', async () => {
    const sock = path.join(sb.home, 'silent.sock');
    const server = await serve(sock, () => '');
    try {
      const peer = pair('silent');
      recordClaudeSocket(peer.id, { CLAUDE_CODE_MESSAGING_SOCKET: sock });
      stop = startClaudeSocketWatcher(peer.id);
      const ok = await sendMessage(peer.from, peer.address, 'child post');
      assert.equal(ok.ok, true);
      if (!ok.ok) return;
      assert.equal(ok.delivery.confirmed, true);

      stop();
      fs.writeFileSync(path.join(sb.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ crossSessionInbound: 'hold' }));
      const held = pair('setting');
      recordClaudeSocket(held.id, { CLAUDE_CODE_MESSAGING_SOCKET: sock });
      stop = startClaudeSocketWatcher(held.id);
      const blocked = await sendMessage(held.from, held.address, 'held by setting');
      assert.equal(blocked.ok, true);
      if (!blocked.ok) return;
      assert.equal(blocked.delivery.confirmed, false);
      assert.equal(fs.existsSync(path.join(inboxDir(held.id), `${blocked.message.id}.json`)), true);
    } finally {
      server.close();
      fs.rmSync(path.join(sb.env.CLAUDE_CONFIG_DIR, 'settings.json'), { force: true });
      stop?.();
      stop = undefined;
    }
  });
});

describe('webhook and command wake', () => {
  let sb: Sandbox;
  const agents: ReturnType<typeof fakeAgent>[] = [];

  before(() => {
    sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.TELEPATHY_DEBUG = '1';
    delete process.env.TELEPATHY_NAME;
    fs.mkdirSync(sb.home, { recursive: true });
  });

  after(async () => {
    await Promise.all(agents.map((a) => killAndWait(a)));
    sb.cleanup();
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
      assert.match(result.status, /Notified grok:wake-bot \[grok-\d+\] by webhook/);
      assert.match(result.status, /must be treated as untrusted/);
      assert.equal(auth, 'Bearer header-secret');
      const posted = JSON.parse(body) as { id: string; from: string; count: number; at: string; message?: string };
      assert.equal(posted.id, result.message.id);
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
      JSON.stringify({ name: 'fail-bot', webhook: { url: 'http://127.0.0.1:1/nope', timeoutMs: 200 } }),
      { mode: 0o600 },
    );
    const { from, to } = grok('fail-bot');
    const failed = await sendMessage(from, to.address, 'still here');
    assert.equal(failed.ok, true);
    if (!failed.ok) return;
    assert.match(failed.status, /webhook notification failed/);
    assert.equal(fs.existsSync(path.join(inboxDir(to.id), `${failed.message.id}.json`)), true);

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
    assert.match(result.status, /by delivery command/);
    const wrote = JSON.parse(fs.readFileSync(out, 'utf8')) as { id: string };
    assert.equal(wrote.id, result.message.id);
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

  test('read_messages with nothing waiting is an empty array, not a message', () => {
    const proc = fakeAgent();
    agents.push(proc);
    registerPresence('grok', proc.pid, { cwd: '/work/empty' });
    const read = readMessagesTool(`grok-${proc.pid}`, {});
    assert.equal(read.text, 'No messages received yet.');
    assert.deepEqual(read.structured, { messages: [] });
  });
});
