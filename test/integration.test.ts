import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../src/core/agents.ts';
import { readPeer } from '../src/core/peers.ts';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/client';
import {
  codexCalls,
  connectServer,
  DIST,
  fakeAgent,
  killAndWait,
  makeSandbox,
  named,
  ROOT,
  runHook,
  type Sandbox,
  toolText,
  waitFor,
} from './helpers.ts';

/**
 * End-to-end over the built plugin (plugin/dist): real MCP servers spoken to with the official MCP client,
 * real hook and monitor processes, fake agent processes standing in for `claude` / `codex`, and a fake
 * `codex` binary recording what `codex queue` would have received.
 */
describe('telepathy plugin', () => {
  let sb: Sandbox;
  const agents: ReturnType<typeof fakeAgent>[] = [];
  const clients: Client[] = [];
  const spawnAgent = (...args: string[]) => {
    const a = fakeAgent(...args);
    agents.push(a);
    return a;
  };
  const connect = async (
    agent: Agent,
    pid: number,
    options?: ConstructorParameters<typeof Client>[1],
    extraEnv?: Record<string, string>,
  ) => {
    const c = await connectServer(sb, agent, pid, ROOT, options, extraEnv);
    clients.push(c);
    return c;
  };
  const call = async (
    client: Client,
    name: string,
    args: object = {},
    meta?: Record<string, unknown>,
    options?: Parameters<Client['callTool']>[1],
  ) => client.callTool({ name, arguments: args as Record<string, unknown>, ...(meta ? { _meta: meta } : {}) }, options);
  /** The row ListAgents gets for the session keyed `key` (its pid, or a Codex thread), as seen from a Claude session. */
  const rowFor = (viewer: number, key: number | string) => {
    const input = { tool_name: 'ListAgents', tool_response: { listing: 'Peer sessions (0):' } };
    const { stdout } = runHook(sb, 'claude', viewer, 'list-agents', input);
    if (!stdout) return ''; // no other agents' sessions at all
    const out = JSON.parse(stdout).hookSpecificOutput;
    return (out.updatedToolOutput.listing as string).split('\n').find((l) => l.includes(`-${key}]`)) ?? '';
  };

  before(() => {
    sb = makeSandbox();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await Promise.all(
      agents.splice(0).map(async (child) => {
        // A detached parent (the OpenCode argv wrapper) leads a group. Killing only that pid leaves the
        // driver holding the test's stdout pipe, and the file never finishes.
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // not a process-group leader
          }
        }
        await killAndWait(child);
      }),
    );
    fs.rmSync(sb.home, { recursive: true, force: true });
    fs.rmSync(sb.codexLog, { force: true });
    fs.rmSync(`${sb.codexLog}.queue.json`, { force: true });
  });
  after(() => sb.cleanup());

  test('exposes the same three tools to both agents', async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const client = await connect(agent, spawnAgent().pid);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ['list_peers', 'read_messages', 'send_message']);
      assert.equal(client.getServerCapabilities()?.resources, undefined);
      assert.equal(client.getServerCapabilities()?.logging, undefined);
      const instructions = client.getInstructions() ?? '';
      assert.match(instructions, /come from another AI agent, not your user/);
      assert.match(instructions, /telepathy:using-telepathy skill/);
      if (agent === 'claude') assert.match(instructions, /ListAgents/);
      else assert.doesNotMatch(instructions, /ListAgents|SendMessage/);
    }
  });

  test('Claude → Codex goes through `codex queue` with the thread id from the SessionStart hook', async () => {
    const claudeAgent = spawnAgent();
    const codexAgent = spawnAgent();
    assert.equal(runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'claude-s1', cwd: '/w/api' }).status, 0);
    assert.equal(runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 'thread-abc', cwd: '/w/auth-fix' }).status, 0);

    const claude = await connect('claude', claudeAgent.pid);
    const list = toolText(await call(claude, 'list_peers'));
    assert.match(list, /This session is claude:api \[claude-claude-s1\]/);
    assert.match(list, new RegExp(`${named('codex', 'auth-fix', 'thread-abc')} \\[codex-thread-abc\\] · cwd /w/auth-fix`));

    const sent = await call(claude, 'send_message', { to: 'codex:auth-fix', message: 'Schema migration finished.\n--flags stay literal' });
    assert.equal(sent.isError, undefined, toolText(sent));
    assert.equal(toolText(sent), `Message queued for delivery to ${named('codex', 'auth-fix', 'thread-abc')} [codex-thread-abc].`);

    const [queued] = codexCalls(sb);
    assert.equal(queued.argv[0], 'queue');
    assert.equal(queued.argv[1], '--thread=thread-abc');
    assert.equal(queued.codexHome, sb.codexHome);
    const text = queued.argv[2].replace(/^--message=/, '');
    assert.match(text, /^\[telepathy\] Message from Claude Code session claude:api \[claude-claude-s1\]/);
    assert.match(text, /to: "claude:api"/);
    assert.ok(text.endsWith('Schema migration finished.\n--flags stay literal'));
  });

  test('read_messages in Codex takes unread messages back out of its queue, and skips ones it already got as a turn', async () => {
    const claudeAgent = spawnAgent();
    const codexAgent = spawnAgent();
    runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/api' });
    runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 'thread-q', cwd: '/w/auth' });
    const claude = await connect('claude', claudeAgent.pid);
    const codex = await connect('codex', codexAgent.pid);
    for (const message of ['already a turn', 'still queued']) {
      assert.equal((await call(claude, 'send_message', { to: 'codex:auth', message })).isError, undefined);
    }
    const queueFile = `${sb.codexLog}.queue.json`;
    const [delivered, waiting] = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    // Codex started a turn with the first one, which takes it off the queue.
    fs.writeFileSync(queueFile, JSON.stringify([waiting]));

    const read = toolText(await call(codex, 'read_messages'));
    assert.match(read, /^1 new message\(s\):/);
    assert.match(read, /still queued/);
    assert.doesNotMatch(read, /already a turn/);
    assert.deepEqual(JSON.parse(fs.readFileSync(queueFile, 'utf8')), [], 'the read one no longer comes back as a turn');
    const deletes = codexCalls(sb).filter((c) => c.argv[0] === 'app-server');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].codexHome, sb.codexHome);
    assert.ok(delivered);

    assert.match(toolText(await call(codex, 'read_messages')), /^No new messages\./);
    assert.equal(codexCalls(sb).filter((c) => c.argv[0] === 'app-server').length, 1, 'nothing left to take back');
  });

  test('Codex without an approved hook becomes reachable from the thread id in tool-call _meta', async () => {
    const codexAgent = spawnAgent();
    const claudeAgent = spawnAgent();
    const codex = await connect('codex', codexAgent.pid);
    const claude = await connect('claude', claudeAgent.pid);

    const before = await call(claude, 'send_message', { to: `codex-${codexAgent.pid}`, message: 'hi' });
    assert.equal(before.isError, true);
    assert.match(toolText(before), /No reachable session matches/, 'a Codex session is reachable only once its thread is known');

    await call(codex, 'list_peers', {}, { threadId: 'thread-from-meta', sessionId: 'thread-from-meta' });
    const afterMeta = await call(claude, 'send_message', { to: 'codex-thread-from-meta', message: 'hi again' });
    assert.equal(afterMeta.isError, undefined, toolText(afterMeta));
    assert.equal(codexCalls(sb)[0].argv[1], '--thread=thread-from-meta');
  });

  test('Codex → Claude lands in the inbox, the monitor announces it, read_messages returns it', async () => {
    const claudeAgent = spawnAgent();
    const codexAgent = spawnAgent();
    runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/web' });
    runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/backend' });
    const codex = await connect('codex', codexAgent.pid);
    const claude = await connect('claude', claudeAgent.pid);

    // No monitor yet: the sender is told the message waits for Claude's next turn (its hooks hand it over).
    const stored = await call(codex, 'send_message', { to: 'claude:web', message: 'first' });
    assert.match(toolText(stored), /^Message stored for claude:web \[claude-s\]\. It can't be woken while idle/);

    const monitor = spawn(process.execPath, [path.join(DIST, 'monitor.mjs'), '--agent', 'claude'], {
      env: { ...sb.env, TELEPATHY_AGENT_PID: String(claudeAgent.pid) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    monitor.stdout.on('data', (d) => (out += d));
    try {
      // The message sent before the monitor started is delivered as soon as it starts.
      await waitFor(() => out.includes('first'));

      const peers = toolText(await call(codex, 'list_peers'));
      assert.doesNotMatch(peers, /no listener/, 'the monitor registers itself as the listener');
      const delivered = await call(codex, 'send_message', { to: 'claude:web', message: 'Tests pass on my side.\nShip it?' });
      assert.equal(toolText(delivered), 'Message delivered to claude:web [claude-s].');

      await waitFor(() => out.includes('Ship it?'));
      const lines = out.trim().split('\n');
      assert.equal(lines.length, 2, 'one line per message');
      assert.match(lines[1], new RegExp(`from Codex session ${named('codex', 'backend', 't')} \\[codex-t\\], sent by another AI agent`));
      assert.match(lines[1], /Tests pass on my side\.\\nShip it\?/);

      const id = /New message (m-[0-9a-z]+-[0-9a-f]+)/.exec(lines[1])![1];
      const read = toolText(await call(claude, 'read_messages', { id }));
      assert.match(read, /Tests pass on my side\.\nShip it\?/);
      assert.match(read, new RegExp(`reply with send_message to: "${named('codex', 'backend', 't')}"`));
      assert.match(toolText(await call(claude, 'read_messages')), /No new messages\. Most recent received:/);
    } finally {
      await killAndWait(monitor);
    }
  });

  test('the monitor exits when its Claude session ends', async () => {
    const claudeAgent = spawnAgent();
    const monitor = spawn(process.execPath, [path.join(DIST, 'monitor.mjs'), '--agent', 'claude'], {
      env: { ...sb.env, TELEPATHY_AGENT_PID: String(claudeAgent.pid) },
      stdio: 'ignore',
    });
    const exited = new Promise((r) => monitor.once('exit', r));
    await killAndWait(claudeAgent);
    await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('monitor did not exit')), 15_000))]);
  });

  test('session start does not ask for a monitor, and the idle-wake hook is not the plugin manifest', () => {
    const claudeAgent = spawnAgent();
    sb.env.CLAUDE_CODE_MESSAGING_SOCKET = path.join(sb.home, 'inbox.sock');
    try {
      const withSocket = runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'sock', cwd: '/w/web' });
      assert.equal(withSocket.stdout, '');
    } finally {
      delete sb.env.CLAUDE_CODE_MESSAGING_SOCKET;
    }
    const without = runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'plain', cwd: '/w/web' });
    assert.equal(without.stdout, '');
    assert.equal(fs.readFileSync(path.join(ROOT, 'plugin', 'monitors', 'monitors.json'), 'utf8').trim(), '[]');
    const hooks = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'claude-hooks.json'), 'utf8');
    assert.match(hooks, /monitor\.mjs\\" --agent claude --rewake/);
    assert.match(hooks, /"asyncRewake": true/);
  });

  test('the monitor exits immediately when the session exported an inbox socket', async () => {
    const claudeAgent = spawnAgent();
    runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/web' });
    const monitor = spawn(process.execPath, [path.join(DIST, 'monitor.mjs'), '--agent', 'claude'], {
      env: {
        ...sb.env,
        TELEPATHY_AGENT_PID: String(claudeAgent.pid),
        CLAUDE_CODE_MESSAGING_SOCKET: path.join(sb.home, 'inbox.sock'),
      },
      stdio: 'ignore',
    });
    const code = await new Promise((resolve) => {
      if (monitor.exitCode !== null) resolve(monitor.exitCode);
      else monitor.once('exit', resolve);
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(sb.home, 'peers', 'claude-s', 'listener.json')), false);
  });

  test('read_messages without a monitor claims pending messages', async () => {
    const claudeAgent = spawnAgent();
    const codexAgent = spawnAgent();
    runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/web' });
    const codex = await connect('codex', codexAgent.pid);
    const claude = await connect('claude', claudeAgent.pid);
    await call(codex, 'send_message', { to: 'claude-s', message: 'pending one' });
    const read = toolText(await call(claude, 'read_messages'));
    assert.match(read, /^1 new message\(s\):/);
    assert.match(read, /pending one/);
  });

  test('refuses self-sends, unknown targets, duplicates and floods', async () => {
    const claudeAgent = spawnAgent();
    const codexAgent = spawnAgent();
    runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/me' });
    runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/other' });
    const claude = await connect('claude', claudeAgent.pid);

    assert.match(toolText(await call(claude, 'send_message', { to: 'claude:me', message: 'x' })), /is this session itself/);
    const unknown = await call(claude, 'send_message', { to: 'codex:ghost', message: 'x' });
    assert.equal(unknown.isError, true);
    assert.match(toolText(unknown), /Reachable: codex:other/);

    assert.equal((await call(claude, 'send_message', { to: 'codex:other', message: 'same' })).isError, undefined);
    assert.match(toolText(await call(claude, 'send_message', { to: 'codex:other', message: 'same' })), /already sent/);

    for (let i = 0; i < 19; i++) await call(claude, 'send_message', { to: 'codex:other', message: `n${i}` });
    const flood = await call(claude, 'send_message', { to: 'codex:other', message: 'one too many' });
    assert.match(toolText(flood), /Rate limit/);
    assert.equal(codexCalls(sb).length, 20);
  });

  test('reports codex queue failures instead of claiming delivery', async () => {
    const claudeAgent = spawnAgent();
    const codexAgent = spawnAgent();
    runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/other' });
    const transportEnvBackup = sb.env.FAKE_CODEX_FAIL;
    sb.env.FAKE_CODEX_FAIL = '1';
    try {
      const claude = await connect('claude', claudeAgent.pid);
      const res = await call(claude, 'send_message', { to: 'codex:other', message: 'x' });
      assert.equal(res.isError, undefined, 'a queue failure is not a lost message');
      assert.match(toolText(res), /codex queue failed: Error: thread not found/);
      assert.match(toolText(res), /stays in the inbox/);
      assert.equal(fs.readdirSync(path.join(sb.home, 'peers', 'codex-t', 'inbox')).length, 1);
    } finally {
      if (transportEnvBackup === undefined) delete sb.env.FAKE_CODEX_FAIL;
      else sb.env.FAKE_CODEX_FAIL = transportEnvBackup;
    }
  });

  test('SessionStart registers the session and prints nothing', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'plugin', 'skills', 'using-telepathy', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: using-telepathy\ndescription: Use when .+\n---\n/);
    for (const agent of ['claude', 'codex'] as const) {
      for (const source of ['startup', 'resume', 'clear', 'compact', undefined]) {
        const { pid } = spawnAgent();
        const res = runHook(sb, agent, pid, 'session-start', { session_id: 's', cwd: '/w/x', ...(source ? { source } : {}) });
        assert.equal(res.stdout, '', 'SessionStart does not ask the model to start a monitor');
        // Both agents are keyed by the harness session id, so a resume keeps the directory.
        assert.ok(fs.existsSync(path.join(sb.home, 'peers', `${agent}-s`, 'session.json')));
      }
    }
  });

  test('an exited session keeps in-flight mail and refuses a new send', async () => {
    const senderAgent = spawnAgent();
    runHook(sb, 'codex', senderAgent.pid, 'session-start', { session_id: 't-send', cwd: '/w/sender' });
    const sender = await connect('codex', senderAgent.pid);
    const first = spawnAgent();
    runHook(sb, 'claude', first.pid, 'session-start', { session_id: 'claude-sess', cwd: '/w/app' });
    assert.equal((await call(sender, 'send_message', { to: 'claude:app', message: 'kept for the resume' })).isError, undefined);
    await killAndWait(first);

    // Listing drops the exited session. Mail written while it was live stays. A send after exit does not.
    const inbox = path.join(sb.home, 'peers', 'claude-claude-sess', 'inbox');
    assert.doesNotMatch(toolText(await call(sender, 'list_peers')), /claude-claude-sess/);
    assert.equal(fs.readdirSync(inbox).length, 1);
    const offline = await call(sender, 'send_message', { to: 'claude:app', message: 'sent while offline' });
    assert.equal(offline.isError, true);
    assert.match(toolText(offline), /Message failed: claude:app \[claude-claude-sess\] is offline \(session not running\)\. Nothing was left in its inbox\./);
    assert.equal(fs.readdirSync(inbox).length, 1);
    const exited = JSON.parse(fs.readFileSync(path.join(sb.home, 'peers', 'claude-claude-sess', 'session.json'), 'utf8')) as { exitedAt?: string };
    assert.ok(exited.exitedAt);
    const planted = {
      id: 'm-000000099-aabbcc',
      from: { id: 'codex-t-send', agent: 'codex', name: 'sender', address: 'codex:sender' },
      to: { id: 'claude-claude-sess', agent: 'claude', name: 'app', address: 'claude:app' },
      body: 'stale after exit',
      sentAt: new Date(Date.parse(exited.exitedAt) + 5000).toISOString(),
    };
    fs.writeFileSync(path.join(inbox, `${planted.id}.json`), JSON.stringify(planted));
    // A new session in the same folder is a different conversation: it doesn't get it.
    const fresh = spawnAgent();
    runHook(sb, 'claude', fresh.pid, 'session-start', { session_id: 'new-sess', cwd: '/w/app' });
    assert.equal(runHook(sb, 'claude', fresh.pid, 'inbox', { session_id: 'new-sess' }, 'UserPromptSubmit').stdout, '');
    // The resumed session reclaims the same id and name. Mail written after the exit is dropped.
    const resumed = spawnAgent();
    fs.mkdirSync(path.join(sb.env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(sb.env.CLAUDE_CONFIG_DIR, 'sessions', `${resumed.pid}.json`), JSON.stringify({ name: 'renamed-on-resume-ab' }));
    runHook(sb, 'claude', resumed.pid, 'session-start', { session_id: 'claude-sess', cwd: '/w/app' });
    assert.ok(!fs.existsSync(path.join(sb.home, 'peers', `claude-${first.pid}`)));
    const listed = toolText(await call(sender, 'list_peers'));
    assert.match(listed, /claude:app \[claude-claude-sess\]/);
    assert.doesNotMatch(listed, /renamed-on-resume/);
    const res = runHook(sb, 'claude', resumed.pid, 'inbox', { session_id: 'claude-sess' }, 'UserPromptSubmit');
    const handed = JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string;
    assert.match(handed, /kept for the resume/);
    assert.doesNotMatch(handed, /sent while offline/);
    assert.doesNotMatch(handed, /stale after exit/);

    // A session-keyed record outlives the old one-hour inbox hold, then drops after a day.
    const gone = spawnAgent();
    runHook(sb, 'claude', gone.pid, 'session-start', { session_id: 'old', cwd: '/w/old' });
    await call(sender, 'send_message', { to: 'claude:old', message: 'stale' });
    await killAndWait(gone);
    const dir = path.join(sb.home, 'peers', 'claude-old');
    const stale = path.join(dir, 'inbox');
    const hourAgo = new Date(Date.now() - 61 * 60_000);
    for (const f of fs.readdirSync(stale)) fs.utimesSync(path.join(stale, f), hourAgo, hourAgo);
    await call(sender, 'list_peers');
    assert.ok(fs.existsSync(dir), 'the session id is kept for a day so a resume can reclaim it');
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000);
    const sessionFile = path.join(dir, 'session.json');
    const record = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { updatedAt: string };
    record.updatedAt = dayAgo.toISOString();
    fs.writeFileSync(sessionFile, JSON.stringify(record));
    for (const f of fs.readdirSync(stale)) fs.utimesSync(path.join(stale, f), dayAgo, dayAgo);
    await call(sender, 'list_peers');
    assert.ok(!fs.existsSync(dir));
  });

  test('a second live process on the same session does not take the inbox', async () => {
    const senderAgent = spawnAgent();
    runHook(sb, 'codex', senderAgent.pid, 'session-start', { session_id: 't-dup', cwd: '/w/sender' });
    const sender = await connect('codex', senderAgent.pid);
    const first = spawnAgent();
    const second = spawnAgent();
    runHook(sb, 'claude', first.pid, 'session-start', { session_id: 'dup', cwd: '/w/dup' });
    runHook(sb, 'claude', second.pid, 'session-start', { session_id: 'dup', cwd: '/w/dup' });
    assert.match(toolText(await call(sender, 'list_peers')), /claude:dup \[claude-dup\].*duplicate session/);
    assert.equal((await call(sender, 'send_message', { to: 'claude:dup', message: 'only the first' })).isError, undefined);
    assert.equal(runHook(sb, 'claude', second.pid, 'inbox', { session_id: 'dup' }, 'UserPromptSubmit').stdout, '');
    const kept = runHook(sb, 'claude', first.pid, 'inbox', { session_id: 'dup' }, 'UserPromptSubmit');
    assert.match(JSON.parse(kept.stdout).hookSpecificOutput.additionalContext, /only the first/);
  });

  test('a resumed Codex gets what was sent before the restart once, and it leaves the old queue item', async () => {
    const claudeAgent = spawnAgent();
    runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/api' });
    const claude = await connect('claude', claudeAgent.pid);
    const beforeRestart = spawnAgent();
    runHook(sb, 'codex', beforeRestart.pid, 'session-start', { session_id: 'thread-r', cwd: '/w/cx' });
    assert.equal((await call(claude, 'send_message', { to: 'codex:cx', message: 'while you restart' })).isError, undefined);
    await killAndWait(beforeRestart);

    const afterRestart = spawnAgent();
    runHook(sb, 'codex', afterRestart.pid, 'session-start', { session_id: 'thread-r', cwd: '/w/cx' });
    const res = runHook(sb, 'codex', afterRestart.pid, 'inbox', { session_id: 'thread-r' }, 'UserPromptSubmit');
    assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /while you restart$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${sb.codexLog}.queue.json`, 'utf8')), []);
  });

  test('setup notes tell the agent what its user has to fix: unapproved Codex hooks, an outdated session', async () => {
    const codexAgent = spawnAgent();
    runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't-n', cwd: '/w/n' });
    const config = path.join(sb.codexHome, 'config.toml');
    const approve = (event: string) => `[hooks.state."telepathy@telepathy:hooks/codex-hooks.json:${event}:0:0"]\ntrusted_hash = "x"\n\n`;
    fs.writeFileSync(
      config,
      `model = "m"\n\n[plugins."telepathy@telepathy".mcp_servers.bridge]\ntool_timeout_sec = 180\n\n[hooks.state]\n\n${approve('session_start')}`,
    );
    try {
      const codex = await connect('codex', codexAgent.pid);
      assert.doesNotMatch(toolText(await call(codex, 'list_peers')), /hasn't approved|No telepathy hook has fired/);
      assert.doesNotMatch(toolText(await call(codex, 'list_peers')), /telepathy setup/);

      // A busy Codex is not described as missing a hook that this process cannot prove is untrusted.
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/me' });
      const claude = await connect('claude', claudeAgent.pid);
      const day = path.join(sb.codexHome, 'sessions', '2026', '09', '25');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, 'rollout-2026-09-25T11-00-00-t-n.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
      const busy = toolText(await call(claude, 'send_message', { to: 'codex:n', message: 'x' }));
      assert.match(busy, /only after that turn ends\.$/);
      assert.doesNotMatch(busy, /isn't approved/);

      fs.appendFileSync(config, approve('post_tool_use') + approve('user_prompt_submit'));
      assert.doesNotMatch(toolText(await call(codex, 'read_messages')), /telepathy setup/);

      // Another session on a newer telepathy means this one still runs an old build.
      const presence = path.join(sb.home, 'peers', 'claude-s', 'presence.json');
      fs.writeFileSync(presence, JSON.stringify({ ...JSON.parse(fs.readFileSync(presence, 'utf8')), version: '99.0.0' }));
      assert.match(
        toolText(await call(codex, 'read_messages')),
        /\[telepathy setup\] This session runs telepathy \d+\.\d+\.\d+, but another session runs 99\.0\.0, so messages may not reach this session as they should\. Tell your user to update telepathy in this agent and restart this session\.$/,
      );
      fs.writeFileSync(presence, JSON.stringify({ ...JSON.parse(fs.readFileSync(presence, 'utf8')), version: undefined }));

      // A newer copy installed for this agent: a restart loads it. Older copies elsewhere: update-all fixes them.
      fs.mkdirSync(path.join(sb.codexHome, 'plugins', 'cache', 'telepathy', 'telepathy', '99.1.0'), { recursive: true });
      const qwen = path.join(sb.env.HOME, '.qwen', 'extensions', 'telepathy');
      fs.mkdirSync(qwen, { recursive: true });
      fs.writeFileSync(path.join(qwen, 'qwen-extension.json'), JSON.stringify({ name: 'telepathy', version: '0.1.0' }));
      const notes = toolText(await call(codex, 'read_messages')).split('\n').filter((l) => l.startsWith('[telepathy setup]'));
      assert.deepEqual(notes, [
        `[telepathy setup] This session runs telepathy ${notes[0].match(/runs telepathy ([\d.]+)/)?.[1]}, but 99.1.0 is installed, so messages may not reach this session as they should. Tell your user to restart this session to load the update.`,
        `[telepathy setup] Some agents have an older telepathy installed than 99.1.0: Qwen Code 0.1.0. Tell your user; with their OK, you can update them all with: node "${path.join(DIST, 'update-all.mjs')}"`,
      ]);
    } finally {
      fs.rmSync(config, { force: true });
      fs.rmSync(path.join(sb.codexHome, 'sessions'), { recursive: true, force: true });
      fs.rmSync(path.join(sb.codexHome, 'plugins'), { recursive: true, force: true });
      fs.rmSync(sb.env.HOME, { recursive: true, force: true });
    }
  });

  test('update-all updates each installed copy with its agent\'s own command and reports what changed', () => {
    const home = sb.env.HOME;
    const bin = path.join(path.dirname(sb.home), 'fake-bin');
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const manifest = (version: string) => JSON.stringify({ name: 'telepathy', version });
    const leftover = path.join(home, '.gemini', 'extensions', 'telepathy', 'gemini-extension.json');
    const agyBundle = path.join(home, '.gemini', 'config', 'plugins', 'telepathy', 'dist', 'server.mjs');
    const opencodePkg = path.join(home, '.cache', 'opencode', 'packages', 'telepathy@git+https:', 'github.com', 'Winterrks', 'telepathy.git', 'node_modules', 'telepathy', 'package.json');
    const kiloPkg = path.join(home, '.cache', 'kilo', 'packages', 'git', 'git_github.com_Winterrks_telepathy-abc', 'package.json');
    write(leftover, manifest('0.4.4'));
    write(agyBundle, 'var VERSION = true ? "0.4.4" : "0.0.0-dev";\n');
    write(opencodePkg, manifest('0.2.0'));
    write(kiloPkg, manifest('0.1.0'));
    write(path.join(home, '.local', 'share', 'devin', 'cli', 'plugins', 'cache', 'github.com_Winterrks_telepathy_plugin-1', '0.4.1', '.devin-plugin', 'plugin.json'), manifest('0.4.1'));
    // Antigravity reinstalls by rewriting the bundled version; OpenCode reinstalls into its emptied cache;
    // Kilo's config load doesn't reinstall anything; Devin isn't on PATH. The leftover Gemini extension is not updated.
    const script = (body: string) => `#!/usr/bin/env node\nconst fs = require('node:fs');\n${body}\n`;
    write(path.join(bin, 'agy'), script(`let text = fs.readFileSync(${JSON.stringify(agyBundle)}, 'utf8'); fs.writeFileSync(${JSON.stringify(agyBundle)}, text.replace('0.4.4', '0.6.0'));`));
    write(path.join(bin, 'opencode'), script(`fs.mkdirSync(${JSON.stringify(path.dirname(opencodePkg))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(opencodePkg)}, ${JSON.stringify(manifest('0.6.0'))});`));
    write(path.join(bin, 'kilo'), script(''));
    for (const f of fs.readdirSync(bin)) fs.chmodSync(path.join(bin, f), 0o755);
    const env = { ...sb.env, PATH: `${bin}:${path.dirname(process.execPath)}` };
    try {
      const dry = spawnSync(process.execPath, [path.join(DIST, 'update-all.mjs'), '--dry-run'], { env, encoding: 'utf8' });
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /^telepathy is installed in: Devin CLI 0\.4\.1, Antigravity 0\.4\.4, OpenCode 0\.2\.0, Kilo Code 0\.1\.0\.\n/);
      assert.match(dry.stdout, /- Antigravity: `agy plugin install https:\/\/github.com\/Winterrks\/telepathy\/tree\/main\/antigravity`\n/);
      assert.doesNotMatch(dry.stdout, /Would remove/);
      assert.match(dry.stdout, /- OpenCode: clear its package cache and run `opencode debug config` to reinstall\n/);
      assert.equal(fs.existsSync(leftover), true, 'a dry run leaves the Gemini extension');
      assert.match(fs.readFileSync(agyBundle, 'utf8'), /0\.4\.4/);

      const res = spawnSync(process.execPath, [path.join(DIST, 'update-all.mjs')], { env, encoding: 'utf8' });
      assert.equal(res.status, 1, 'Kilo and Devin were not updated');
      assert.match(res.stdout, /Updating Antigravity… done\n/);
      assert.doesNotMatch(res.stdout, /Removed leftover/);
      assert.equal(fs.existsSync(leftover), true);
      assert.match(res.stdout, /Updating Devin CLI… failed: `devin` is not on PATH\n/);
      assert.match(res.stdout, /Updating Kilo Code… failed: it didn't reinstall telepathy, so the old copy was kept\./);
      assert.match(res.stdout, /Installed versions:\n- Devin CLI: 0\.4\.1\n- Antigravity: 0\.4\.4 → 0\.6\.0\n- OpenCode: 0\.2\.0 → 0\.6\.0\n- Kilo Code: 0\.1\.0\n/);
      assert.match(res.stdout, /Not updated: Devin CLI, Kilo Code\./);
      assert.equal(fs.readFileSync(kiloPkg, 'utf8'), manifest('0.1.0'));
      assert.deepEqual(fs.readdirSync(path.join(home, '.cache', 'opencode', 'packages')), ['telepathy@git+https:'], 'the old OpenCode copy is removed');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  describe('Claude Code hooks', () => {
    test('ListAgents gets other agents\' sessions added to its listing, as rows in its own shape', () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      const listing =
        'This session is me-12 [0a1b2c] — the name other sessions use to message it.\n\n' +
        'Peer sessions (1):\n  api-worker [3fa9c1]  ·  interactive  ·  idle  ·  started 2h ago';
      const input = { tool_name: 'ListAgents', tool_input: {}, tool_response: { listing } };
      assert.equal(runHook(sb, 'claude', claudeAgent.pid, 'list-agents', input).stdout, '');

      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/me' });
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/auth' });
      const out = JSON.parse(runHook(sb, 'claude', claudeAgent.pid, 'list-agents', input).stdout).hookSpecificOutput;
      assert.equal(out.hookEventName, 'PostToolUse');
      assert.equal(out.additionalContext, undefined);
      const rewritten: string = out.updatedToolOutput.listing;
      assert.ok(rewritten.startsWith(`${listing}\n\nOther agents' sessions (1), reachable through the telepathy plugin `));
      const added = rewritten.slice(listing.length);
      assert.match(added, /with send_message/);
      // No rollout log for thread "t" in this sandbox, so the status column is left out.
      assert.match(added, new RegExp(`\\n  ${named('codex', 'auth', 't')} \\[codex-t\\]  ·  interactive  ·  started \\d+s ago$`));
      assert.doesNotMatch(added, /claude:me/);
    });

    test('ListAgents rows show whether Codex is busy or idle, from its rollout log', () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 'thread-9', cwd: '/w/auth' });
      const day = path.join(sb.codexHome, 'sessions', '2026', '09', '24');
      fs.mkdirSync(day, { recursive: true });
      const rollout = path.join(day, 'rollout-2026-09-24T08-03-04-thread-9.jsonl');
      const event = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n';
      const row = () => {
        const input = { tool_name: 'ListAgents', tool_response: { listing: 'Peer sessions (0):' } };
        const out = JSON.parse(runHook(sb, 'claude', claudeAgent.pid, 'list-agents', input).stdout).hookSpecificOutput;
        return out.updatedToolOutput.listing.split('\n').at(-1);
      };
      fs.writeFileSync(rollout, event('task_started') + JSON.stringify({ type: 'response_item', payload: {} }) + '\n');
      assert.match(row(), /  ·  interactive  ·  busy  ·  started /);
      fs.appendFileSync(rollout, event('task_complete') + event('token_count'));
      assert.match(row(), /  ·  interactive  ·  idle  ·  started /);
      fs.appendFileSync(rollout, event('task_started') + event('turn_aborted'));
      assert.match(row(), /  ·  interactive  ·  interrupted: a send fails until its user prompts it  ·  started /);
    });

    test('Sending to a busy or interrupted Codex says when it will see the message', async () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/me' });
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 'thread-7', cwd: '/w/auth' });
      const day = path.join(sb.codexHome, 'sessions', '2026', '09', '25');
      fs.mkdirSync(day, { recursive: true });
      const rollout = path.join(day, 'rollout-2026-09-25T08-51-02-thread-7.jsonl');
      const event = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n';
      const ref = `${named('codex', 'auth', 'thread-7')} [codex-thread-7]`;
      const claude = await connect('claude', claudeAgent.pid);

      fs.writeFileSync(rollout, event('task_started'));
      assert.equal(
        toolText(await call(claude, 'send_message', { to: 'codex:auth', message: 'one' })),
        `Message queued for ${ref}. It's in the middle of a turn, so the message is delivered only after that turn ends.`,
      );
      fs.appendFileSync(rollout, event('turn_aborted'));
      assert.equal(
        toolText(await call(claude, 'send_message', { to: 'codex:auth', message: 'two' })),
        `Message failed: ${ref} is interrupted, so its queue will not run this. Nothing was left for a later prompt.`,
      );
      assert.match(toolText(await call(claude, 'list_peers')), /· cwd \/w\/auth · interrupted: a send fails until its user prompts it/);
      assert.equal(codexCalls(sb).length, 1, 'the interrupted message is not queued');
      const held = fs.readdirSync(path.join(sb.home, 'peers', 'codex-thread-7', 'inbox')).map((f) => JSON.parse(fs.readFileSync(path.join(sb.home, 'peers', 'codex-thread-7', 'inbox', f), 'utf8')) as { body: string });
      assert.equal(held.some((m) => m.body === 'two'), false);
    });

    test('ListAgents output of an unknown shape gets the Codex sessions as a note instead', () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/auth' });
      const res = runHook(sb, 'claude', claudeAgent.pid, 'list-agents', { tool_name: 'ListAgents', tool_response: 'text' });
      const out = JSON.parse(res.stdout).hookSpecificOutput;
      assert.equal(out.updatedToolOutput, undefined);
      assert.match(out.additionalContext, new RegExp(`${named('codex', 'auth', 't')} \\[codex-t\\]`));
    });

    test('SendMessage to a Codex address is delivered by the hook and the call is stopped', () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/me' });
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 'thread-x', cwd: '/w/auth' });

      const res = runHook(sb, 'claude', claudeAgent.pid, 'send-message', {
        tool_name: 'SendMessage',
        tool_input: { to: `codex:auth [codex-thread-x]`, message: 'Please rerun the auth tests.' },
      });
      const out = JSON.parse(res.stdout).hookSpecificOutput;
      assert.equal(out.permissionDecision, 'deny');
      assert.equal(
        out.permissionDecisionReason,
        `Message queued for delivery to ${named('codex', 'auth', 'thread-x')} [codex-thread-x]. (Sent by telepathy: SendMessage can't reach Codex, so this shows as an error. Don't resend.)`,
      );
      const [queued] = codexCalls(sb);
      assert.equal(queued.argv[1], '--thread=thread-x');
      assert.ok(queued.argv[2].endsWith('Please rerun the auth tests.'));
    });

    test('SendMessage to anything else is left alone, including Claude sessions named codex-…', () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/codex-review' });
      // Claude names sessions after their folder, so "codex-46" or "codex-review" can be a Claude session.
      for (const to of ['api-worker', 'researcher', 'claude:me', 'main', 'codex-46', 'codex-review', 'codex-review [a1b2c3]']) {
        const res = runHook(sb, 'claude', claudeAgent.pid, 'send-message', { tool_input: { to, message: 'x' } });
        assert.equal(res.stdout, '', `hook must not touch SendMessage to ${to}`);
        assert.equal(res.status, 0);
      }
      assert.equal(codexCalls(sb).length, 0);
    });

    test('SendMessage to an unknown codex: address is stopped with the reason', () => {
      const claudeAgent = spawnAgent();
      const res = runHook(sb, 'claude', claudeAgent.pid, 'send-message', { tool_input: { to: 'codex:nobody', message: 'x' } });
      const out = JSON.parse(res.stdout).hookSpecificOutput;
      assert.equal(out.permissionDecision, 'deny');
      assert.match(out.permissionDecisionReason, /^Not delivered: No reachable session matches/);
    });

    test('SendMessage to the bare ref of a live Codex session is delivered', () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/me' });
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 'thread-r', cwd: '/w/auth' });
      const res = runHook(sb, 'claude', claudeAgent.pid, 'send-message', {
        tool_input: { to: `codex-thread-r`, message: 'by ref' },
      });
      assert.match(JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason, /^Message queued for delivery to codex:/);
      assert.equal(codexCalls(sb)[0].argv[1], '--thread=thread-r');
    });

    test('a failing hook never blocks the agent', () => {
      const res = runHook(sb, 'claude', 1, 'bogus-event', {});
      assert.equal(res.status, 0);
      assert.match(res.stderr, /unknown hook action/);
    });
  });

  describe('statuses: busy, shell, idle, waiting on a permission prompt, interrupted', () => {
    test('Claude sessions: from Claude Code\'s own session record, all four statuses', async () => {
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/sdk' });
      const record = path.join(sb.env.CLAUDE_CONFIG_DIR, 'sessions', `${claudeAgent.pid}.json`);
      fs.mkdirSync(path.dirname(record), { recursive: true });
      const codexAgent = spawnAgent();
      const codex = await connect('codex', codexAgent.pid);
      for (const status of ['busy', 'shell', 'idle', 'waiting']) {
        fs.writeFileSync(record, JSON.stringify({ pid: claudeAgent.pid, name: 'sdk', status, statusUpdatedAt: Date.now() }));
        const expected = { waiting: 'waiting on a permission prompt for its user', shell: 'shell \\(not generating, but a command it started is still running\\)' }[status] ?? status;
        assert.match(toolText(await call(codex, 'list_peers')), new RegExp(`claude:sdk \\[claude-s\\] · cwd /w/sdk · ${expected} · sees messages at its next turn\n`));
      }
      assert.match(
        toolText(await call(codex, 'send_message', { to: 'claude:sdk', message: 'can you add the endpoint?' })),
        /^Message stored for claude:sdk \[claude-s\], but it's waiting on a permission prompt for its user, so it gets to your message only after its user answers\. Tell your user if it's urgent; don't resend\.$/,
      );
    });

    test('Codex: waiting from its PermissionRequest hook (which prints nothing), until Codex writes again', async () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/sdk' });
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 'thread-p', cwd: '/w/ui' });
      const day = path.join(sb.codexHome, 'sessions', '2026', '09', '26');
      fs.mkdirSync(day, { recursive: true });
      const rollout = path.join(day, 'rollout-2026-09-26T09-00-00-thread-p.jsonl');
      const line = (type: string, at?: number, kind = 'event_msg') =>
        JSON.stringify({ ...(at ? { timestamp: new Date(at).toISOString() } : {}), type: kind, payload: { type } }) + '\n';
      fs.writeFileSync(rollout, line('task_started'));
      assert.match(rowFor(claudeAgent.pid, 'thread-p'), /  ·  interactive  ·  busy  ·  /);

      const hook = runHook(sb, 'codex', codexAgent.pid, 'status', { session_id: 'thread-p', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }, 'waiting');
      assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, '', ''], 'a PermissionRequest hook must never answer the prompt');
      assert.match(rowFor(claudeAgent.pid, 'thread-p'), /  ·  interactive  ·  waiting on a permission prompt for its user  ·  /);
      const claude = await connect('claude', claudeAgent.pid);
      assert.match(toolText(await call(claude, 'send_message', { to: 'codex:ui', message: 'x' })), /^Message queued for codex:ui-c[0-9a-f]{2} \[codex-thread-p\], but it's waiting on a permission prompt/);

      // While the prompt is open, Codex logs only bookkeeping, which doesn't end it.
      fs.appendFileSync(rollout, line('token_count', Date.now() + 2000) + line('item_completed', Date.now() + 3000));
      assert.match(rowFor(claudeAgent.pid, 'thread-p'), /  ·  interactive  ·  waiting on a permission prompt for its user  ·  /);
      // The user answers: Codex logs the tool's output (or, after a denial, the model goes on).
      fs.appendFileSync(rollout, line('custom_tool_call_output', Date.now() + 5000, 'response_item'));
      assert.match(rowFor(claudeAgent.pid, 'thread-p'), /  ·  interactive  ·  busy  ·  /);
      // A telepathy hook after the prompt (the tool call's PostToolUse) also ends it.
      runHook(sb, 'codex', codexAgent.pid, 'status', { session_id: 'thread-p' }, 'waiting');
      runHook(sb, 'codex', codexAgent.pid, 'inbox', { session_id: 'thread-p', hook_event_name: 'PostToolUse' }, 'PostToolUse');
      fs.appendFileSync(rollout, line('task_complete', Date.now() + 6000));
      assert.match(rowFor(claudeAgent.pid, 'thread-p'), /  ·  interactive  ·  idle  ·  /);
    });

    test('hook-only agents: idle at start, busy from a prompt or tool call, waiting on a permission notification, idle at turn end', () => {
      const claudeAgent = spawnAgent();
      const qwen = spawnAgent();
      const row = () => rowFor(claudeAgent.pid, 'g');
      runHook(sb, 'qwen', qwen.pid, 'session-start', { session_id: 'g', cwd: '/w/docs' });
      assert.match(row(), /  ·  interactive  ·  idle  ·  /);
      runHook(sb, 'qwen', qwen.pid, 'inbox', { session_id: 'g' }, 'BeforeAgent');
      assert.match(row(), /  ·  interactive  ·  busy  ·  /);
      const notified = runHook(sb, 'qwen', qwen.pid, 'status', { session_id: 'g', notification_type: 'ToolPermission', message: 'Allow shell?' }, 'waiting');
      assert.equal(notified.stdout, '');
      assert.match(row(), /  ·  interactive  ·  waiting on a permission prompt for its user  ·  /);
      runHook(sb, 'qwen', qwen.pid, 'inbox', { session_id: 'g', tool_name: 'run_shell_command', tool_input: { command: 'ls' } }, 'AfterTool');
      assert.match(row(), /  ·  interactive  ·  busy  ·  /);
      runHook(sb, 'qwen', qwen.pid, 'turn-end', { session_id: 'g' });
      assert.match(row(), /  ·  interactive  ·  idle  ·  /);
      runHook(sb, 'qwen', qwen.pid, 'status', { session_id: 'g', notification_type: 'SomethingElse' }, 'waiting');
      assert.match(row(), /  ·  interactive  ·  idle  ·  /, 'only permission notifications mean waiting');

      // An interrupt often runs no hook, so a busy status with no hook activity for a while is shown as uncertain.
      fs.writeFileSync(path.join(sb.home, 'peers', 'qwen-g', 'status.json'), JSON.stringify({ status: 'busy', at: new Date(Date.now() - 20 * 60_000).toISOString() }));
      assert.match(row(), /  ·  interactive  ·  busy\? \(no activity for 20m\)  ·  /);
    });
  });

  describe('files another session is editing', () => {
    const noteOf = (res: ReturnType<typeof runHook>) => (res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.additionalContext : '');
    const claudeEdit = (pid: number, tool: string, file: string) =>
      runHook(sb, 'claude', pid, 'files', { session_id: 's', cwd: '/w/app', tool_name: tool, tool_input: { file_path: file } });
    const codexPatch = (pid: number, ...files: string[]) =>
      runHook(
        sb,
        'codex',
        pid,
        'inbox',
        {
          session_id: 'thread-ui',
          cwd: '/w/app',
          hook_event_name: 'PostToolUse',
          tool_name: 'apply_patch',
          tool_input: { command: ['*** Begin Patch', ...files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`), '*** End Patch'].join('\n') },
        },
        'PostToolUse',
      );

    test('an agent that steps into files another session is editing is told who, once per folder', () => {
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/app' });
      assert.equal(claudeEdit(claudeAgent.pid, 'Edit', '/w/app/daemon/server.ts').stdout, '', 'nobody else is editing');

      const codex = spawnAgent();
      runHook(sb, 'codex', codex.pid, 'session-start', { session_id: 'thread-ui', cwd: '/w/app' });
      assert.equal(codexPatch(codex.pid, 'ui/glass.swift').stdout, '', 'its own area');
      const note = noteOf(codexPatch(codex.pid, 'daemon/server.ts'));
      assert.match(
        note,
        new RegExp(
          `^\\[telepathy note\\] Another session, claude:app \\[claude-s\\], edited daemon/server\\.ts \\d+s ago, so it may be working in this area\\. ` +
            'If you need changes there, consider reaching out to it with send_message\\.$',
        ),
      );
      assert.equal(codexPatch(codex.pid, 'daemon/routes.ts').stdout, '', 'the same session and folder is mentioned once');

      // Claude reads a file in the folder Codex edited, before editing it: the note says how Claude reaches Codex.
      const read = noteOf(claudeEdit(claudeAgent.pid, 'Read', '/w/app/ui/glass.swift'));
      assert.match(read, new RegExp(`${named('codex', 'app', 'thread-ui')} \\[codex-thread-ui\\], edited ui/glass\\.swift .*\\. If you need changes there, consider reaching out to it with SendMessage or send_message\\.$`));
    });

    test('edits of a session that ended no longer count; shell commands and odd inputs touch nothing', async () => {
      const codex = spawnAgent();
      runHook(sb, 'codex', codex.pid, 'session-start', { session_id: 'thread-ui', cwd: '/w/app' });
      codexPatch(codex.pid, 'daemon/server.ts');
      await killAndWait(codex);
      const claudeAgent = spawnAgent();
      assert.equal(claudeEdit(claudeAgent.pid, 'Edit', '/w/app/daemon/server.ts').stdout, '');

      const other = spawnAgent();
      claudeEdit(other.pid, 'Write', '/w/app/api/a.ts');
      for (const input of [
        { tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ /w/app/api/a.ts' } },
        { tool_name: 'Edit', tool_input: 'not an object' },
        { tool_name: 'Edit', tool_input: { file_path: 42 } },
        { tool_name: 'Read', tool_input: { file_path: 'relative.ts' } },
        { tool_name: 'Read' },
      ]) {
        const res = runHook(sb, 'claude', claudeAgent.pid, 'files', { session_id: 's', ...input });
        assert.deepEqual([res.status, res.stdout, res.stderr], [0, '', ''], JSON.stringify(input));
      }
    });

    test('reading through the shell or listing a folder counts too, for paths that exist', () => {
      const proj = path.join(path.dirname(sb.home), 'proj');
      fs.mkdirSync(path.join(proj, 'daemon'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'daemon', 'server.ts'), '');
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: proj });
      runHook(sb, 'claude', claudeAgent.pid, 'files', { session_id: 's', cwd: proj, tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'daemon', 'server.ts') } });

      const codexShell = (pid: number, command: string) =>
        runHook(sb, 'codex', pid, 'inbox', { session_id: `t-${pid}`, cwd: proj, tool_name: 'Bash', tool_input: { command } }, 'PostToolUse');
      const reads: [string, boolean][] = [
        ['npm test && git status', false],
        ["rg -n 'daemon/missing.ts' src", false],
        ["sed -n '1,80p' daemon/server.ts", true],
        ['ls -la daemon', true],
        [`cat "${path.join(proj, 'daemon', 'server.ts')}" | head`, true],
      ];
      for (const [command, noted] of reads) {
        const codex = spawnAgent(); // a fresh session each time: a session hears about a folder once
        runHook(sb, 'codex', codex.pid, 'session-start', { session_id: `t-${codex.pid}`, cwd: proj });
        const note = noteOf(codexShell(codex.pid, command));
        if (noted) assert.match(note, /^\[telepathy note\] Another session, claude:proj \[claude-s\], edited daemon\/server\.ts /, command);
        else assert.equal(note, '', command);
      }

      const claudeReader = spawnAgent();
      const grep = runHook(sb, 'claude', claudeReader.pid, 'files', { session_id: 'r', cwd: proj, tool_name: 'Grep', tool_input: { pattern: 'port', path: path.join(proj, 'daemon') } });
      assert.match(noteOf(grep), /edited daemon\/server\.ts /);
    });

    test('each agent\'s own tool shapes: Copilot\'s JSON toolArgs, Qwen\'s read_file', () => {
      const copilot = spawnAgent();
      runHook(sb, 'copilot', copilot.pid, 'session-start', { sessionId: 'cp', cwd: '/w/app' });
      runHook(sb, 'copilot', copilot.pid, 'inbox', { sessionId: 'cp', toolName: 'edit', toolArgs: JSON.stringify({ path: '/w/app/sdk/client.ts' }) }, 'postToolUse');

      const qwen = spawnAgent();
      runHook(sb, 'qwen', qwen.pid, 'session-start', { session_id: 'g', cwd: '/w/app' });
      const res = runHook(sb, 'qwen', qwen.pid, 'inbox', { session_id: 'g', tool_name: 'read_file', tool_input: { absolute_path: '/w/app/sdk/client.ts' } }, 'AfterTool');
      assert.match(noteOf(res), new RegExp(`^\\[telepathy note\\] Another session, ${named('copilot', 'app', 'cp')} \\[copilot-cp\\], edited sdk/client\\.ts `));
    });
  });

  describe('OpenCode and Kilo Code plugin', () => {
    /** Runs the built plugin in its own process (its pid is the session identity) with a fake SDK client. */
    function startOpenCode(directory: string, extraEnv: Record<string, string> = {}) {
      const child = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'opencode-driver.mjs'), path.join(DIST, 'opencode.mjs'), directory], {
        env: { ...sb.env, ...extraEnv },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      agents.push(child as ReturnType<typeof fakeAgent>);
      const lines: Record<string, unknown>[] = [];
      let buf = '';
      child.stdout!.on('data', (chunk) => {
        buf += chunk;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      });
      const send = (cmd: object) => child.stdin!.write(JSON.stringify(cmd) + '\n');
      const next = (key: string) => waitFor(() => lines.find((l) => key in l && !(l as { seen?: boolean }).seen));
      const take = async (key: string) => {
        const line = await next(key);
        (line as { seen?: boolean }).seen = true;
        return line as Record<string, any>;
      };
      return { child, send, take, lines };
    }

    test('registers native tools, and wakes the active session with promptAsync once it is idle', async () => {
      const oc = startOpenCode('/w/ui');
      const ready = await oc.take('ready');
      assert.deepEqual(ready.tools, ['telepathy_list_peers', 'telepathy_send_message', 'telepathy_read_messages']);
      const pid = ready.ready as number;

      oc.send({ op: 'chat', sessionID: 'ses_main' });
      oc.send({ op: 'event', event: { type: 'session.status', properties: { sessionID: 'ses_main', status: { type: 'busy' } } } });
      await oc.take('done');
      await oc.take('done');

      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/sdk' });
      const res = runHook(sb, 'claude', claudeAgent.pid, 'send-message', { tool_input: { to: 'opencode:ui', message: 'new daemon API is in' } });
      process.env.TELEPATHY_HOME = sb.home;
      const bound = readPeer('opencode-ses_main');
      assert.equal(bound?.name, readPeer(`opencode-${pid}`)?.name);
      assert.match(JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason, new RegExp(`^Message delivered to ${bound?.address} \\[opencode-ses_main\\]\\.`));

      await new Promise((r) => setTimeout(r, 400));
      assert.ok(!oc.lines.some((l) => 'prompt' in l), 'must not prompt a busy session');

      oc.send({ op: 'event', event: { type: 'session.idle', properties: { sessionID: 'ses_main' } } });
      const { prompt } = await oc.take('prompt');
      assert.equal(prompt.path.id, 'ses_main');
      assert.equal(prompt.body.agent, 'build');
      assert.match(prompt.body.parts[0].text, /^\[telepathy\] Message from Claude Code session claude:sdk/);
      assert.match(prompt.body.parts[0].text, /new daemon API is in$/);
    });

    test('records the files its tools edit, and adds a note to a tool result that touches another session\'s files', async () => {
      const oc = startOpenCode('/w/app');
      await oc.take('ready');
      oc.send({ op: 'run', name: 'edit', args: { filePath: '/w/app/ui/glass.swift' }, sessionID: 'ses_ui' });
      assert.equal((await oc.take('ran')).output, 'ok');

      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/app' });
      const res = runHook(sb, 'claude', claudeAgent.pid, 'files', { session_id: 's', cwd: '/w/app', tool_name: 'Edit', tool_input: { file_path: '/w/app/ui/glass.swift' } });
      assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /^\[telepathy note\] Another session, opencode:app-o[0-9a-f]{2} \[opencode-\d+\], edited ui\/glass\.swift /);

      oc.send({ op: 'run', name: 'read', args: { filePath: 'ui/glass.swift' }, sessionID: 'ses_ui' });
      assert.match(
        (await oc.take('ran')).output,
        /^ok\n\n\[telepathy note\] Another session, claude:app \[claude-s\], edited ui\/glass\.swift .* telepathy_send_message/,
      );
    });

    test('reports busy, idle and waiting from OpenCode\'s own events', async () => {
      const oc = startOpenCode('/w/oc-status');
      const pid = (await oc.take('ready')).ready as number;
      const claudeAgent = spawnAgent();
      const row = (key: number | string = pid) => rowFor(claudeAgent.pid, key);
      assert.match(row(), /  ·  interactive  ·  idle  ·  /);
      oc.send({ op: 'chat', sessionID: 'ses_main' });
      oc.send({ op: 'event', event: { type: 'session.status', properties: { sessionID: 'ses_main', status: { type: 'busy' } } } });
      await oc.take('done');
      await oc.take('done');
      assert.match(row('ses_main'), /  ·  interactive  ·  busy  ·  /);
      oc.send({ op: 'event', event: { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_child', permission: 'bash' } } });
      await oc.take('done');
      assert.match(row('ses_main'), /  ·  interactive  ·  waiting on a permission prompt for its user  ·  /);
      oc.send({ op: 'event', event: { type: 'permission.replied', properties: { sessionID: 'ses_child', permissionID: 'per_1', response: 'once' } } });
      await oc.take('done');
      assert.match(row('ses_main'), /  ·  interactive  ·  busy  ·  /);
      oc.send({ op: 'event', event: { type: 'session.idle', properties: { sessionID: 'ses_main' } } });
      await oc.take('done');
      assert.match(row('ses_main'), /  ·  interactive  ·  idle  ·  /);
    });

    test('tools and the system-prompt guide work like the MCP server\'s', async () => {
      const oc = startOpenCode('/w/ui2');
      await oc.take('ready');
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/api' });
      oc.send({ op: 'tool', name: 'telepathy_list_peers', sessionID: 'ses_x' });
      assert.match((await oc.take('tool')).output, /claude:api \[claude-s\]/);
      oc.send({ op: 'tool', name: 'telepathy_send_message', args: { to: 'claude:api', message: 'hi from opencode' }, sessionID: 'ses_x' });
      assert.match((await oc.take('tool')).output, /^Message stored for claude:api/);
      oc.send({ op: 'system' });
      assert.match((await oc.take('system')).system[0], /^telepathy: message other coding-agent sessions/);
    });

    test('keeps the pid-era name when a session id arrives, and resume rebinds that peer', async () => {
      const first = startOpenCode('/w/resume');
      const ready = await first.take('ready');
      const pid = ready.ready as number;
      process.env.TELEPATHY_HOME = sb.home;
      const pidName = readPeer(`opencode-${pid}`)?.name;
      assert.ok(pidName);
      first.send({ op: 'event', event: { type: 'session.created', properties: { info: { id: 'ses_resume' } } } });
      await first.take('done');
      const bound = readPeer('opencode-ses_resume');
      assert.equal(bound?.name, pidName);
      assert.equal(bound?.hasListener, true);
      assert.equal(bound?.sessionId, 'ses_resume');
      await killAndWait(first.child);

      const resumed = startOpenCode('/w/resume', { OPENCODE_TEST_SESSION: 'ses_resume' });
      await resumed.take('ready');
      const again = readPeer('opencode-ses_resume');
      assert.equal(again?.name, pidName);
      assert.equal(again?.id, 'opencode-ses_resume');
      assert.equal(again?.hasListener, true);
      assert.notEqual(again?.pid, pid);
    });

    test('a listed session is not bound unless this launch continued one', async () => {
      const oc = startOpenCode('/w/listed', { OPENCODE_TEST_LIST: 'ses_old:1,ses_new:9' });
      const ready = await oc.take('ready');
      const pid = ready.ready as number;
      process.env.TELEPATHY_HOME = sb.home;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(readPeer('opencode-ses_new'), undefined);
      assert.equal(readPeer(`opencode-${pid}`)?.hasListener, true);
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/api' });
      const claude = await connect('claude', claudeAgent.pid);
      assert.match(toolText(await call(claude, 'list_peers')), /no session yet, sees messages at its first prompt/);
    });

    test('a parent --session binds before the first prompt, and --continue binds the newest session', async () => {
      const parent = path.join(ROOT, 'test', 'fixtures', 'opencode-parent.mjs');
      const driver = path.join(ROOT, 'test', 'fixtures', 'opencode-driver.mjs');
      const plugin = path.join(DIST, 'opencode.mjs');
      const lines: Record<string, unknown>[] = [];
      const child = spawn(process.execPath, [parent, '--session', 'ses_from_parent', '--', driver, plugin, '/w/parent'], {
        env: sb.env,
        stdio: ['pipe', 'pipe', 'inherit'],
        detached: true,
      });
      agents.push(child as ReturnType<typeof fakeAgent>);
      let buf = '';
      child.stdout!.on('data', (chunk) => {
        buf += chunk;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      });
      await waitFor(() => lines.find((l) => 'ready' in l));
      process.env.TELEPATHY_HOME = sb.home;
      const bound = readPeer('opencode-ses_from_parent');
      assert.equal(bound?.sessionId, 'ses_from_parent');
      assert.equal(bound?.hasListener, true);
      child.kill('SIGKILL');

      const continued = spawn(process.execPath, [parent, '--continue', '--', driver, plugin, '/w/continue'], {
        env: { ...sb.env, OPENCODE_TEST_LIST: 'ses_old:1,ses_new:9' },
        stdio: ['pipe', 'pipe', 'inherit'],
        detached: true,
      });
      agents.push(continued as ReturnType<typeof fakeAgent>);
      const more: Record<string, unknown>[] = [];
      let buf2 = '';
      continued.stdout!.on('data', (chunk) => {
        buf2 += chunk;
        for (let i = buf2.indexOf('\n'); i >= 0; i = buf2.indexOf('\n')) {
          more.push(JSON.parse(buf2.slice(0, i)));
          buf2 = buf2.slice(i + 1);
        }
      });
      await waitFor(() => more.find((l) => 'ready' in l));
      const newest = await waitFor(() => {
        const peer = readPeer('opencode-ses_new');
        return peer?.hasListener ? peer : undefined;
      });
      assert.equal(newest.hasListener, true);
      assert.equal(readPeer('opencode-ses_old'), undefined);
    });

    test('ps args on this process bind --session and --continue when argv dropped the flag', async () => {
      const driver = path.join(ROOT, 'test', 'fixtures', 'opencode-driver.mjs');
      const plugin = path.join(DIST, 'opencode.mjs');
      const lines: Record<string, unknown>[] = [];
      const child = spawn(process.execPath, [driver, plugin, '/w/ps-self', '--session', 'ses_from_ps'], {
        env: { ...sb.env, OPENCODE_TEST_HIDE_ARGV: '1' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      agents.push(child as ReturnType<typeof fakeAgent>);
      let buf = '';
      child.stdout!.on('data', (chunk) => {
        buf += chunk;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      });
      await waitFor(() => lines.find((l) => 'ready' in l));
      process.env.TELEPATHY_HOME = sb.home;
      const bound = readPeer('opencode-ses_from_ps');
      assert.equal(bound?.sessionId, 'ses_from_ps');
      assert.equal(bound?.hasListener, true);
      child.kill('SIGKILL');

      const continued = spawn(process.execPath, [driver, plugin, '/w/ps-cont', '--continue'], {
        env: { ...sb.env, OPENCODE_TEST_HIDE_ARGV: '1', OPENCODE_TEST_LIST: 'ses_old:1,ses_new:9' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      agents.push(continued as ReturnType<typeof fakeAgent>);
      const more: Record<string, unknown>[] = [];
      let buf2 = '';
      continued.stdout!.on('data', (chunk) => {
        buf2 += chunk;
        for (let i = buf2.indexOf('\n'); i >= 0; i = buf2.indexOf('\n')) {
          more.push(JSON.parse(buf2.slice(0, i)));
          buf2 = buf2.slice(i + 1);
        }
      });
      await waitFor(() => more.find((l) => 'ready' in l));
      const newest = await waitFor(() => {
        const peer = readPeer('opencode-ses_new');
        return peer?.hasListener ? peer : undefined;
      });
      assert.equal(newest.hasListener, true);
      assert.equal(readPeer('opencode-ses_old'), undefined);
    });

    test('mail that arrives before a session exists creates one and prompts it', async () => {
      const oc = startOpenCode('/w/fresh', { OPENCODE_TEST_CREATE: 'ses_made' });
      const ready = await oc.take('ready');
      const pid = ready.ready as number;
      process.env.TELEPATHY_HOME = sb.home;
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/api' });
      const claude = await connect('claude', claudeAgent.pid);
      const sent = await call(claude, 'send_message', { to: `opencode-${pid}`, message: 'before your first prompt' });
      assert.equal(sent.isError, undefined, toolText(sent));
      const published = await oc.take('published');
      assert.deepEqual(published.published, { type: 'tui.session.select', properties: { sessionID: 'ses_made' } });
      assert.equal(oc.lines.some((line) => 'selected' in line), false);
      const prompt = await oc.take('prompt');
      assert.match(prompt.prompt.body.parts[0].text, /before your first prompt/);
      const made = await waitFor(() => {
        const peer = readPeer('opencode-ses_made');
        return peer?.hasListener ? peer : undefined;
      });
      assert.equal(made.hasListener, true);
      assert.equal(made?.name, readPeer(`opencode-${pid}`)?.name);
    });

    test('tui.selectSession is preferred when the client has it', async () => {
      const oc = startOpenCode('/w/select', { OPENCODE_TEST_CREATE: 'ses_pick', OPENCODE_TEST_SELECT: '1' });
      const ready = await oc.take('ready');
      const pid = ready.ready as number;
      process.env.TELEPATHY_HOME = sb.home;
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/api' });
      const claude = await connect('claude', claudeAgent.pid);
      const sent = await call(claude, 'send_message', { to: `opencode-${pid}`, message: 'show this session' });
      assert.equal(sent.isError, undefined, toolText(sent));
      const picked = await oc.take('selectSession');
      assert.equal(picked.selectSession.sessionID, 'ses_pick');
      assert.deepEqual(picked.selectSession.body, { sessionID: 'ses_pick' });
      assert.equal(oc.lines.some((line) => 'published' in line), false);
      const prompt = await oc.take('prompt');
      assert.match(prompt.prompt.body.parts[0].text, /show this session/);
    });

    test('plugin init returns without awaiting client.session.list', async () => {
      const oc = startOpenCode('/w/hang', { OPENCODE_TEST_LIST: 'hang' });
      const ready = await Promise.race([
        oc.take('ready'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('init awaited session.list')), 8_000)),
      ]);
      assert.equal(typeof ready.ready, 'number');
    });
  });

  describe('OpenCode 2 plugin', () => {
    /** Runs the built plugin's OpenCode 2 `setup` once per directory in one process, as OpenCode's service does. */
    function startService(directories: string[], knownSessions: string[] = []) {
      const child = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'opencode2-driver.mjs'), path.join(DIST, 'opencode.mjs'), ...directories], {
        env: { ...sb.env, FAKE_OPENCODE_SESSIONS: knownSessions.join(',') },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      agents.push(child as ReturnType<typeof fakeAgent>);
      const lines: Record<string, any>[] = [];
      let buf = '';
      child.stdout!.on('data', (chunk) => {
        buf += chunk;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      });
      const send = (cmd: object) => child.stdin!.write(JSON.stringify(cmd) + '\n');
      const take = async (key: string) => {
        const line = await waitFor(() => lines.find((l) => key in l && !l.seen));
        line.seen = true;
        return line;
      };
      /** Sends a command and waits until the driver has handled it. */
      const run = async (cmd: object) => {
        send(cmd);
        await take('done');
      };
      return { child, send, take, run, lines };
    }

    test('each session of the service is a peer of its own, woken through session.prompt', async () => {
      const oc = startService(['/w/api', '/w/web']);
      const ready = await oc.take('ready');
      assert.deepEqual(ready.tools, ['telepathy_list_peers', 'telepathy_send_message', 'telepathy_read_messages']);
      assert.deepEqual(ready.skills, ['using-telepathy']);
      await oc.run({ op: 'prompt', sessionID: 'ses_A', directory: '/w/api' });
      await oc.run({ op: 'prompt', sessionID: 'ses_B', directory: '/w/web' });

      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/sdk' });
      assert.match(rowFor(claudeAgent.pid, 'ses_A'), new RegExp(`^  ${named('opencode', 'api', 'ses_A')} \\[opencode-ses_A\\]  ·  interactive  ·  idle  ·  started`));
      assert.match(rowFor(claudeAgent.pid, 'ses_B'), new RegExp(`^  ${named('opencode', 'web', 'ses_B')} \\[opencode-ses_B\\]`));

      const res = runHook(sb, 'claude', claudeAgent.pid, 'send-message', { tool_input: { to: 'opencode:web', message: 'the API changed' } });
      assert.match(JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason, /^Message delivered to opencode:web-o[0-9a-f]{2} \[opencode-ses_B\]\./);
      const { prompt } = await oc.take('prompt');
      assert.equal(prompt.sessionID, 'ses_B');
      assert.equal(prompt.delivery, 'steer', 'it starts a turn, or joins the running one');
      assert.match(prompt.text, /^\[telepathy\] Message from Claude Code session claude:sdk/);
      assert.match(prompt.text, /the API changed$/);

      oc.send({ op: 'tool', name: 'telepathy_list_peers', sessionID: 'ses_A', directory: '/w/api' });
      const listed = (await oc.take('tool')).output as string;
      assert.match(listed, new RegExp(`^This session is ${named('opencode', 'api', 'ses_A')} \\[opencode-ses_A\\]\\.`));
      assert.match(listed, /opencode:web-o[0-9a-f]{2} \[opencode-ses_B\]/);
      oc.send({ op: 'context', sessionID: 'ses_A', directory: '/w/api' });
      assert.match((await oc.take('system')).system[0].text, /^telepathy: message other coding-agent sessions/);

      // Statuses from the session's events; a subagent's permission prompt stops its parent.
      await oc.run({ op: 'event', event: { type: 'session.execution.started', data: { sessionID: 'ses_A' } } });
      assert.match(rowFor(claudeAgent.pid, 'ses_A'), /  ·  interactive  ·  busy  ·  /);
      await oc.run({ op: 'event', event: { type: 'session.created', data: { sessionID: 'ses_A_child', parentID: 'ses_A' } } });
      await oc.run({ op: 'event', event: { type: 'permission.asked', data: { sessionID: 'ses_A_child', action: 'bash' } } });
      assert.match(rowFor(claudeAgent.pid, 'ses_A'), /  ·  interactive  ·  waiting on a permission prompt for its user  ·  /);
      await oc.run({ op: 'event', event: { type: 'permission.replied', data: { sessionID: 'ses_A_child' } } });
      await oc.run({ op: 'event', event: { type: 'session.execution.succeeded', data: { sessionID: 'ses_A_child' } } });
      assert.match(rowFor(claudeAgent.pid, 'ses_A'), /  ·  interactive  ·  busy  ·  /, "a subagent finishing doesn't make its parent idle");
      await oc.run({ op: 'event', event: { type: 'session.execution.succeeded', data: { sessionID: 'ses_A' } } });
      assert.match(rowFor(claudeAgent.pid, 'ses_A'), /  ·  interactive  ·  idle  ·  /);
      assert.equal(rowFor(claudeAgent.pid, 'ses_A_child'), '', 'a subagent is no peer of its own');

      await oc.run({ op: 'event', event: { type: 'session.deleted', data: { sessionID: 'ses_B' } } });
      assert.equal(rowFor(claudeAgent.pid, 'ses_B'), '');
    });

    test('a restarted service takes its sessions back before they are prompted again', async () => {
      const first = startService(['/w/api']);
      await first.take('ready');
      await first.run({ op: 'prompt', sessionID: 'ses_A' });
      await first.run({ op: 'prompt', sessionID: 'ses_gone' });
      await killAndWait(first.child);

      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/sdk' });
      assert.equal(rowFor(claudeAgent.pid, 'ses_A'), '', 'not reachable while the service is down');

      const second = startService(['/w/api'], ['ses_A']); // ses_gone was deleted meanwhile
      const pid = (await second.take('ready')).ready as number;
      const row = await waitFor(() => rowFor(claudeAgent.pid, 'ses_A') || undefined);
      assert.match(row, /\[opencode-ses_A\]  ·  interactive  ·  idle/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(sb.home, 'peers', 'opencode-ses_A', 'session.json'), 'utf8')).pid, pid);
      await waitFor(() => !fs.existsSync(path.join(sb.home, 'peers', 'opencode-ses_gone')) || undefined);
    });

    test('records the files its tools edit, and notes a tool result that touches another session\'s files', async () => {
      const oc = startService(['/w/app']);
      await oc.take('ready');
      await oc.run({ op: 'prompt', sessionID: 'ses_ui' });
      oc.send({ op: 'run', name: 'edit', args: { filePath: '/w/app/ui/glass.swift' }, sessionID: 'ses_ui' });
      assert.equal((await oc.take('ran')).output, 'ok');
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/app' });
      const res = runHook(sb, 'claude', claudeAgent.pid, 'files', { session_id: 's', cwd: '/w/app', tool_name: 'Read', tool_input: { file_path: '/w/app/ui/glass.swift' } });
      assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /Another session, opencode:app-o[0-9a-f]{2} \[opencode-ses_ui\], edited ui\/glass\.swift/);
    });
  });

  describe('delivery through hooks, for agents nothing can wake while idle', () => {
    /** Claude sends `text` to `to` through its SendMessage hook; returns the stated delivery status. */
    const sendFromClaude = (to: string, text: string) => {
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/web' });
      const res = runHook(sb, 'claude', claudeAgent.pid, 'send-message', { tool_input: { to, message: text } });
      return JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason as string;
    };

    test('Qwen gets messages as context at its next prompt or tool call, once', () => {
      const qwen = spawnAgent();
      runHook(sb, 'qwen', qwen.pid, 'session-start', { session_id: 'g-1', cwd: '/w/docs', hook_event_name: 'SessionStart' });
      const status = sendFromClaude('qwen:docs', 'Is the API reference current?');
      assert.equal(
        status,
        `Message stored for ${named('qwen', 'docs', 'g-1')} [qwen-g-1]. It can't be woken while idle, so it will see it at its next turn. ` +
          "(Sent by telepathy: SendMessage can't reach Qwen Code, so this shows as an error. Don't resend.)",
      );
      const res = runHook(sb, 'qwen', qwen.pid, 'inbox', { session_id: 'g-1', hook_event_name: 'AfterTool' }, 'AfterTool');
      const out = JSON.parse(res.stdout).hookSpecificOutput;
      assert.equal(out.hookEventName, 'AfterTool');
      assert.match(out.additionalContext, /^\[telepathy\] A new message from another AI agent session \(not your user\)/);
      assert.match(out.additionalContext, /\[telepathy\] Message from Claude Code session claude:web/);
      assert.match(out.additionalContext, /Is the API reference current\?$/);
      assert.equal(runHook(sb, 'qwen', qwen.pid, 'inbox', { session_id: 'g-1' }, 'BeforeAgent').stdout, '');
    });

    test('Codex gets queued messages after a tool call or with the next prompt, and they leave its queue', () => {
      const codex = spawnAgent();
      runHook(sb, 'codex', codex.pid, 'session-start', { session_id: 'thread-h', cwd: '/w/cx' });
      const day = path.join(sb.codexHome, 'sessions', '2026', '09', '25');
      fs.mkdirSync(day, { recursive: true });
      const event = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n';
      fs.writeFileSync(path.join(day, 'rollout-2026-09-25T10-00-00-thread-h.jsonl'), event('task_started'));
      const ref = `${named('codex', 'cx', 'thread-h')} [codex-thread-h]`;
      const tail = " (Sent by telepathy: SendMessage can't reach Codex, so this shows as an error. Don't resend.)";

      // Until its after-tool-call hook has run (it needs approval in /hooks), a busy Codex waits for the turn to end.
      assert.equal(
        sendFromClaude('codex:cx', 'first'),
        `Message queued for ${ref}. It's in the middle of a turn, so the message is delivered only after that turn ends.${tail}`,
      );
      const queueFile = `${sb.codexLog}.queue.json`;
      assert.equal(JSON.parse(fs.readFileSync(queueFile, 'utf8')).length, 1);
      const res = runHook(sb, 'codex', codex.pid, 'inbox', { session_id: 'thread-h', hook_event_name: 'PostToolUse' }, 'PostToolUse');
      const out = JSON.parse(res.stdout).hookSpecificOutput;
      assert.equal(out.hookEventName, 'PostToolUse');
      assert.match(out.additionalContext, /\[telepathy\] Message from Claude Code session claude:web/);
      assert.match(out.additionalContext, /first$/);
      assert.deepEqual(JSON.parse(fs.readFileSync(queueFile, 'utf8')), [], 'no second copy as a turn');

      assert.equal(
        sendFromClaude('codex:cx', 'second'),
        `Message delivered to ${ref}. It's in the middle of a turn and gets it after its next tool call, or when the turn ends.${tail}`,
      );
      const prompt = runHook(sb, 'codex', codex.pid, 'inbox', { session_id: 'thread-h' }, 'UserPromptSubmit');
      assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /second$/);
      assert.equal(runHook(sb, 'codex', codex.pid, 'inbox', { session_id: 'thread-h' }, 'PostToolUse').stdout, '');
    });

    test('a turn that ends with messages pending goes on with them, in each agent\'s own shape', () => {
      const cases: [Agent, (res: ReturnType<typeof runHook>) => string][] = [
        ['qwen', (r) => JSON.parse(r.stdout).decision === 'block' && JSON.parse(r.stdout).reason],
        ['grok', (r) => JSON.parse(r.stdout).decision === 'block' && JSON.parse(r.stdout).reason],
        ['devin', (r) => JSON.parse(r.stdout).decision === 'block' && JSON.parse(r.stdout).reason],
        ['copilot', (r) => JSON.parse(r.stdout).decision === 'block' && JSON.parse(r.stdout).reason],
        ['cursor', (r) => JSON.parse(r.stdout).followup_message],
        ['antigravity', (r) => JSON.parse(r.stdout).decision === 'continue' && JSON.parse(r.stdout).reason],
        ['kimi', (r) => (r.status === 2 && r.stdout === '' ? r.stderr : '')],
      ];
      for (const [agent, delivered] of cases) {
        const proc = spawnAgent();
        runHook(sb, agent, proc.pid, 'session-start', { session_id: `${agent}-s`, cwd: `/w/${agent}-proj` });
        sendFromClaude(`${agent}:${agent}-proj`, `ping ${agent}`);
        const res = runHook(sb, agent, proc.pid, 'turn-end', { session_id: `${agent}-s`, status: 'completed' });
        assert.match(delivered(res) || '', new RegExp(`ping ${agent}$`), `${agent}: ${JSON.stringify(res)}`);
        const again = runHook(sb, agent, proc.pid, 'turn-end', { session_id: `${agent}-s`, status: 'completed' });
        assert.deepEqual([again.stdout, again.status], ['', 0], `${agent} must stop once the inbox is empty`);
      }
    });

    test('context shapes: Copilot and Cursor use their own fields, Kimi plain text, Antigravity a user message', () => {
      const expect: [Agent, (stdout: string) => string][] = [
        ['copilot', (o) => JSON.parse(o).additionalContext],
        ['cursor', (o) => JSON.parse(o).additional_context],
        ['kimi', (o) => o],
        ['antigravity', (o) => JSON.parse(o).injectSteps[0].userMessage],
      ];
      for (const [agent, text] of expect) {
        const proc = spawnAgent();
        runHook(sb, agent, proc.pid, 'session-start', { session_id: `${agent}-c`, cwd: `/w/${agent}-ctx` });
        sendFromClaude(`${agent}:${agent}-ctx`, `hello ${agent}`);
        const res = runHook(sb, agent, proc.pid, 'inbox', { session_id: `${agent}-c` });
        assert.match(text(res.stdout), new RegExp(`hello ${agent}$`), agent);
      }
    });

    test('Claude without a monitor (the Claude app, claude -p) gets messages from its hooks; with one, they stay out', async () => {
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'app', cwd: '/w/app' });
      const codexAgent = spawnAgent();
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/api' });
      const codex = await connect('codex', codexAgent.pid);
      await call(codex, 'send_message', { to: 'claude:app', message: 'schema is migrated' });
      const res = runHook(sb, 'claude', claudeAgent.pid, 'turn-end', { session_id: 'app', hook_event_name: 'Stop' });
      assert.equal(JSON.parse(res.stdout).decision, 'block');
      assert.match(JSON.parse(res.stdout).reason, /schema is migrated$/);

      const monitor = spawn(process.execPath, [path.join(DIST, 'monitor.mjs'), '--agent', 'claude'], {
        env: { ...sb.env, TELEPATHY_AGENT_PID: String(claudeAgent.pid) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      monitor.stdout.on('data', (d) => (out += d));
      try {
        await waitFor(() => fs.existsSync(path.join(sb.home, 'peers', 'claude-app', 'listener.json')));
        await call(codex, 'send_message', { to: 'claude:app', message: 'for the monitor' });
        await waitFor(() => out.includes('for the monitor'));
        const prompt = runHook(sb, 'claude', claudeAgent.pid, 'inbox', { session_id: 'app' }, 'UserPromptSubmit');
        const stop = runHook(sb, 'claude', claudeAgent.pid, 'turn-end', { session_id: 'app' });
        assert.deepEqual([prompt.stdout, stop.stdout], ['', ''], 'hooks stay quiet while the monitor delivers');
      } finally {
        await killAndWait(monitor);
      }
    });

    test('a stream-json session without a socket is told to keep a one-shot waiter running; a socket or a terminal session is not', async () => {
      const app = spawnAgent('--output-format', 'stream-json', '--input-format', 'stream-json');
      const appClient = await connect('claude', app.pid);
      assert.match(appClient.getInstructions() ?? '', /run this with your Bash tool in the background \(run_in_background: true\): node ".*monitor\.mjs" --agent claude --once/);
      sb.env.CLAUDE_CODE_MESSAGING_SOCKET = path.join(sb.home, 'inbox.sock');
      try {
        const socketApp = spawnAgent('--output-format', 'stream-json', '--input-format', 'stream-json');
        const socketClient = await connect('claude', socketApp.pid);
        assert.doesNotMatch(socketClient.getInstructions() ?? '', /--once/);
      } finally {
        delete sb.env.CLAUDE_CODE_MESSAGING_SOCKET;
      }
      const terminal = spawnAgent();
      const terminalClient = await connect('claude', terminal.pid);
      assert.doesNotMatch(terminalClient.getInstructions() ?? '', /--once/);
    });

    test('the one-shot waiter prints the next message and exits, so its completion wakes the session', async () => {
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'app', cwd: '/w/app2' });
      const waiter = spawn(process.execPath, [path.join(DIST, 'monitor.mjs'), '--agent', 'claude', '--once'], {
        env: { ...sb.env, TELEPATHY_AGENT_PID: String(claudeAgent.pid) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      waiter.stdout.on('data', (d) => (out += d));
      const exited = new Promise<number | null>((resolve) => waiter.once('exit', (code) => resolve(code)));
      const listener = path.join(sb.home, 'peers', 'claude-app', 'listener.json');
      await waitFor(() => fs.existsSync(listener));
      const codexAgent = spawnAgent();
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/api2' });
      const codex = await connect('codex', codexAgent.pid);
      assert.match(toolText(await call(codex, 'send_message', { to: 'claude:app2', message: 'wake up' })), /^Message delivered to/);
      assert.equal(await exited, 0);
      assert.match(out, /\[telepathy\] New message .*wake up$/m);
      assert.ok(!fs.existsSync(listener), 'the waiter removes its listener registration, so the hooks take over until it restarts');
    });

    test('rewake exits immediately when a socket is set, and exits 2 after a message when it is not', async () => {
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'rw', cwd: '/w/rw' });
      const quiet = spawn(process.execPath, [path.join(DIST, 'monitor.mjs'), '--agent', 'claude', '--rewake'], {
        env: {
          ...sb.env,
          TELEPATHY_AGENT_PID: String(claudeAgent.pid),
          CLAUDE_CODE_MESSAGING_SOCKET: path.join(sb.home, 'inbox.sock'),
        },
        stdio: 'ignore',
      });
      const quietCode = await new Promise((resolve) => quiet.once('exit', resolve));
      assert.equal(quietCode, 0);
      assert.equal(fs.existsSync(path.join(sb.home, 'peers', 'claude-rw', 'listener.json')), false);

      const waiter = spawn(process.execPath, [path.join(DIST, 'monitor.mjs'), '--agent', 'claude', '--rewake'], {
        env: { ...sb.env, TELEPATHY_AGENT_PID: String(claudeAgent.pid) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      waiter.stdout.on('data', (d) => (out += d));
      const exited = new Promise<number | null>((resolve) => waiter.once('exit', (code) => resolve(code)));
      await waitFor(() => fs.existsSync(path.join(sb.home, 'peers', 'claude-rw', 'listener.json')));
      const codexAgent = spawnAgent();
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't-rw', cwd: '/w/api-rw' });
      const codex = await connect('codex', codexAgent.pid);
      await call(codex, 'send_message', { to: 'claude:rw', message: 'wake the rewake' });
      assert.equal(await exited, 2);
      assert.match(out, /wake the rewake/);
    });

    test('an interrupted turn does not take the messages; the next one does', () => {
      const cursor = spawnAgent();
      runHook(sb, 'cursor', cursor.pid, 'session-start', { conversation_id: 'c-9', workspace_roots: ['/w/site'] });
      sendFromClaude('cursor:site', 'after the interrupt');
      assert.equal(runHook(sb, 'cursor', cursor.pid, 'turn-end', { conversation_id: 'c-9', status: 'aborted' }).stdout, '');
      const res = runHook(sb, 'cursor', cursor.pid, 'turn-end', { conversation_id: 'c-9', status: 'completed' });
      assert.match(JSON.parse(res.stdout).followup_message, /after the interrupt$/);
    });

    test('an agent without a session-start event registers from its first hook', () => {
      const agy = spawnAgent();
      runHook(sb, 'antigravity', agy.pid, 'inbox', { conversationId: 'conv-1', workspacePaths: ['/w/infra'] }, 'PreInvocation');
      const status = sendFromClaude('antigravity:infra', 'hi');
      assert.match(status, new RegExp(`^Message stored for ${named('antigravity', 'infra', 'conv-1')} \\[antigravity-conv-1\\]\\. It can't be woken while idle`));
    });

    test('Grok lists wait_for_messages and is told which product uses it', async () => {
      const client = await connect('grok', spawnAgent().pid);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ['list_peers', 'read_messages', 'send_message', 'wait_for_messages']);
      const caps = client.getServerCapabilities();
      assert.equal(caps?.resources?.subscribe, true);
      assert.ok(caps?.logging);
      const instructions = client.getInstructions() ?? '';
      assert.match(instructions, /monitor tool \(persistent: true/);
      assert.match(instructions, /Do not also call wait_for_messages/);
      assert.match(instructions, /on Grok Bot there is no monitor tool/);
      assert.match(instructions, /timeoutMs 300000/);
      const listed = await client.listResources();
      assert.ok(listed.resources.some((r) => r.uri === 'telepathy://inbox'));
    });

    test('a parked wait_for_messages returns a message sent while it waits, and hooks stay quiet', async () => {
      const grokAgent = spawnAgent();
      const claudeAgent = spawnAgent();
      runHook(sb, 'grok', grokAgent.pid, 'session-start', { session_id: 'g', cwd: '/w/bot' });
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'c', cwd: '/w/web' });
      const grok = await connect('grok', grokAgent.pid);
      const claude = await connect('claude', claudeAgent.pid);
      const listener = path.join(sb.home, 'peers', 'grok-g', 'listener.json');
      const progress: string[] = [];
      const waiting = call(grok, 'wait_for_messages', { timeoutMs: 8_000 }, undefined, {
        timeout: 20_000,
        onprogress: (p) => progress.push(p.message ?? ''),
      });
      await waitFor(() => (fs.existsSync(listener) ? listener : undefined));
      assert.doesNotMatch(toolText(await call(claude, 'list_peers')), /no listener/);

      const sent = await call(claude, 'send_message', { to: 'grok-g', message: 'hello from claude' });
      assert.equal(toolText(sent), `Message delivered to ${named('grok', 'bot', 'g')} [grok-g].`);
      const hook = runHook(sb, 'grok', grokAgent.pid, 'turn-end', { session_id: 'g', status: 'completed' });
      assert.equal(hook.stdout, '', 'hooks stay quiet while a wait is delivering');

      const got = toolText(await waiting);
      assert.match(got, /^1 new message\(s\):/);
      assert.match(got, /hello from claude$/);
      assert.ok(progress.some((m) => m.includes('Waiting for telepathy messages')));
      assert.equal(fs.existsSync(listener), false, 'the wait clears its listener when it returns');
      assert.match(toolText(await call(grok, 'read_messages')), /^No new messages/);
      assert.match(toolText(await call(claude, 'list_peers')), /no listener: Grok Bot receives via wait_for_messages/);
    });

    test('a parked wait confirms delivery, and a missed wait leaves nothing behind', async () => {
      const confirmEnv = {
        TELEPATHY_CONFIRM_WAIT: '1',
        TELEPATHY_CONFIRM_ABORT_MS: '4000',
        TELEPATHY_CONFIRM_GRACE_MS: '500',
        TELEPATHY_CONFIRM_POLL_MS: '25',
      };
      const grokAgent = spawnAgent();
      const claudeAgent = spawnAgent();
      runHook(sb, 'grok', grokAgent.pid, 'session-start', { session_id: 'g-ok', cwd: '/w/bot' });
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'c-ok', cwd: '/w/web' });
      const grok = await connect('grok', grokAgent.pid);
      const claude = await connect('claude', claudeAgent.pid, undefined, confirmEnv);
      const waiting = call(grok, 'wait_for_messages', { timeoutMs: 8_000 }, undefined, { timeout: 20_000 });
      await waitFor(() => (fs.existsSync(path.join(sb.home, 'peers', 'grok-g-ok', 'listener.json')) ? 'parked' : undefined));
      const sent = await call(claude, 'send_message', { to: 'grok-g-ok', message: 'confirmed hello' });
      assert.equal(sent.isError, undefined, toolText(sent));
      assert.match(toolText(sent), /transcript shows telepathy-id:m-/);
      const got = toolText(await waiting);
      assert.match(got, /confirmed hello$/);
      assert.match(got, /telepathy-id:m-/);
      const deliveredInbox = path.join(sb.home, 'peers', 'grok-g-ok', 'inbox');
      assert.equal(fs.existsSync(deliveredInbox) && fs.readdirSync(deliveredInbox).some((name) => name.endsWith('.json')), false);
      const transcript = fs.readFileSync(path.join(sb.home, 'peers', 'grok-g-ok', 'delivery-transcript.jsonl'), 'utf8');
      assert.match(transcript, /telepathy-id:m-/);
      assert.match(transcript, /confirmed hello/);

      const lateGrok = spawnAgent();
      const lateClaude = spawnAgent();
      runHook(sb, 'grok', lateGrok.pid, 'session-start', { session_id: 'g-late', cwd: '/w/late' });
      runHook(sb, 'claude', lateClaude.pid, 'session-start', { session_id: 'c-late', cwd: '/w/web2' });
      const late = await connect('grok', lateGrok.pid);
      const sender = await connect('claude', lateClaude.pid, undefined, {
        TELEPATHY_CONFIRM_WAIT: '1',
        TELEPATHY_CONFIRM_ABORT_MS: '300',
        TELEPATHY_CONFIRM_GRACE_MS: '200',
        TELEPATHY_CONFIRM_POLL_MS: '25',
      });
      const failed = await call(sender, 'send_message', { to: 'grok-g-late', message: 'too late' });
      assert.equal(failed.isError, true);
      assert.match(toolText(failed), /Message failed/);
      assert.match(toolText(failed), /withdrawn/);
      const after = toolText(await call(late, 'wait_for_messages', { timeoutMs: 0 }));
      assert.match(after, /No messages waiting/);
      assert.doesNotMatch(after, /too late/);
      const inbox = path.join(sb.home, 'peers', 'grok-g-late', 'inbox');
      assert.equal(fs.existsSync(inbox) && fs.readdirSync(inbox).some((f) => f.endsWith('.json')), false);
    });

    test('wait_for_messages times out without a message, and timeout 0 claims one that is already waiting', async () => {
      const grokAgent = spawnAgent();
      const claudeAgent = spawnAgent();
      runHook(sb, 'grok', grokAgent.pid, 'session-start', { session_id: 'g', cwd: '/w/bot' });
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'c', cwd: '/w/web' });
      const grok = await connect('grok', grokAgent.pid);
      const claude = await connect('claude', claudeAgent.pid);
      const listener = path.join(sb.home, 'peers', 'grok-g', 'listener.json');

      const timed = toolText(await call(grok, 'wait_for_messages', { timeoutMs: 200 }, undefined, { timeout: 10_000 }));
      assert.match(timed, /No messages arrived within 200ms\. Call wait_for_messages again to keep listening\./);
      assert.equal(fs.existsSync(listener), false);

      const stored = await call(claude, 'send_message', { to: 'grok-g', message: 'already there' });
      assert.match(toolText(stored), /No wait_for_messages call is parked/);
      assert.match(toolText(stored), /wait_for_messages/);
      const got = toolText(await call(grok, 'wait_for_messages', { timeoutMs: 0 }));
      assert.match(got, /^1 new message\(s\):/);
      assert.match(got, /already there$/);
      assert.match(toolText(await call(grok, 'read_messages')), /^No new messages/);
    });

    test('cancelling a wait removes its listener', async () => {
      const grokAgent = spawnAgent();
      const grok = await connect('grok', grokAgent.pid);
      const listener = path.join(sb.home, 'peers', `grok-${grokAgent.pid}`, 'listener.json');
      const ac = new AbortController();
      const pending = call(grok, 'wait_for_messages', { timeoutMs: 30_000 }, undefined, { signal: ac.signal, timeout: 20_000 });
      await waitFor(() => (fs.existsSync(listener) ? listener : undefined));
      ac.abort();
      let outcome = '';
      try {
        outcome = toolText(await pending);
      } catch {
        outcome = 'aborted';
      }
      assert.ok(outcome === 'aborted' || /Wait cancelled before a message arrived/.test(outcome), outcome);
      await waitFor(() => (fs.existsSync(listener) ? undefined : 'cleared'));
    });

    test('a foreign listener is left in place and its messages are not claimed', async () => {
      const grokAgent = spawnAgent();
      const monitor = spawnAgent();
      const claudeAgent = spawnAgent();
      runHook(sb, 'grok', grokAgent.pid, 'session-start', { session_id: 'g', cwd: '/w/bot' });
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'c', cwd: '/w/web' });
      const grok = await connect('grok', grokAgent.pid);
      const claude = await connect('claude', claudeAgent.pid);
      const file = path.join(sb.home, 'peers', 'grok-g', 'listener.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pid: monitor.pid, startedAt: new Date().toISOString() }));

      await call(claude, 'send_message', { to: 'grok-g', message: 'for the monitor' });
      const refused = toolText(await call(grok, 'wait_for_messages', { timeoutMs: 5_000 }, undefined, { timeout: 10_000 }));
      assert.match(refused, /A listener is already delivering this session's messages/);
      assert.doesNotMatch(refused, /for the monitor/);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, monitor.pid);
      assert.match(toolText(await call(grok, 'read_messages')), /for the monitor/);
    });

    test('with nobody waiting, a new message is announced and left unclaimed until read_messages', async () => {
      const grokAgent = spawnAgent();
      const claudeAgent = spawnAgent();
      runHook(sb, 'grok', grokAgent.pid, 'session-start', { session_id: 'g', cwd: '/w/bot' });
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'c', cwd: '/w/web' });
      const grok = await connect('grok', grokAgent.pid);
      const notes: string[] = [];
      const updates: string[] = [];
      grok.setNotificationHandler('notifications/message', (notification) => {
        const data = notification.params.data;
        notes.push(typeof data === 'string' ? data : JSON.stringify(data));
      });
      grok.setNotificationHandler('notifications/resources/updated', (notification) => {
        updates.push(notification.params.uri);
      });
      await grok.setLoggingLevel('debug');
      await grok.subscribeResource({ uri: 'telepathy://inbox' });

      const claude = await connect('claude', claudeAgent.pid);
      const sent = await call(claude, 'send_message', { to: 'grok-g', message: 'ping the bot' });
      assert.match(toolText(sent), /No wait_for_messages call is parked/);
      await waitFor(() => (notes.some((n) => n.includes('wait_for_messages')) && updates.includes('telepathy://inbox') ? 'announced' : undefined));

      const peek = await grok.readResource({ uri: 'telepathy://inbox' });
      const peeked = peek.contents.map((c) => ('text' in c ? c.text : '') ?? '').join('\n');
      assert.match(peeked, /ping the bot/);
      assert.match(toolText(await call(grok, 'read_messages')), /ping the bot/);
      const after = await grok.readResource({ uri: 'telepathy://inbox' });
      assert.doesNotMatch(after.contents.map((c) => ('text' in c ? c.text : '') ?? '').join('\n'), /ping the bot/);
    });

    test('Copilot and Cursor get the guide at session start, since they don\'t show MCP instructions', () => {
      const copilot = spawnAgent();
      const guide = JSON.parse(runHook(sb, 'copilot', copilot.pid, 'session-start', { sessionId: 'x', cwd: '/w/a' }).stdout);
      assert.match(guide.additionalContext, /^telepathy: message other coding-agent sessions/);
      const cursor = spawnAgent();
      const cguide = JSON.parse(runHook(sb, 'cursor', cursor.pid, 'session-start', { conversation_id: 'y' }).stdout);
      assert.match(cguide.additional_context, /come from another AI agent, not your user/);
      const agy = spawnAgent();
      const aguide = JSON.parse(runHook(sb, 'antigravity', agy.pid, 'session-start', { conversationId: 'z', workspacePaths: ['/w/a'] }).stdout);
      assert.match(aguide.injectSteps[0].systemMessage.systemMessage, /come from another AI agent, not your user/);
    });
  });
});
