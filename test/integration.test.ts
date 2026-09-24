import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/client';
import {
  codexCalls,
  connectServer,
  DIST,
  fakeAgent,
  killAndWait,
  makeSandbox,
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
  const spawnAgent = () => {
    const a = fakeAgent();
    agents.push(a);
    return a;
  };
  const connect = async (agent: 'claude' | 'codex', pid: number) => {
    const c = await connectServer(sb, agent, pid);
    clients.push(c);
    return c;
  };
  const call = async (client: Client, name: string, args: object = {}, meta?: Record<string, unknown>) =>
    client.callTool({ name, arguments: args as Record<string, unknown>, ...(meta ? { _meta: meta } : {}) });

  before(() => {
    sb = makeSandbox();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await Promise.all(agents.splice(0).map(killAndWait));
    fs.rmSync(sb.home, { recursive: true, force: true });
    fs.rmSync(sb.codexLog, { force: true });
  });
  after(() => sb.cleanup());

  test('exposes the same three tools to both agents', async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const client = await connect(agent, spawnAgent().pid);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ['list_peers', 'read_messages', 'send_message']);
      assert.match(client.getInstructions() ?? '', /not from your user/);
    }
  });

  test('Claude → Codex goes through `codex queue` with the thread id from the SessionStart hook', async () => {
    const claudeAgent = spawnAgent();
    const codexAgent = spawnAgent();
    assert.equal(runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 'claude-s1', cwd: '/w/api' }).status, 0);
    assert.equal(runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 'thread-abc', cwd: '/w/auth-fix' }).status, 0);

    const claude = await connect('claude', claudeAgent.pid);
    const list = toolText(await call(claude, 'list_peers'));
    assert.match(list, new RegExp(`This session is claude:api \\[claude-${claudeAgent.pid}\\]`));
    assert.match(list, new RegExp(`codex:auth-fix \\[codex-${codexAgent.pid}\\] · Codex · cwd /w/auth-fix`));

    const sent = await call(claude, 'send_message', { to: 'codex:auth-fix', message: 'Schema migration finished.\n--flags stay literal' });
    assert.equal(sent.isError, undefined, toolText(sent));
    assert.equal(toolText(sent), `Message queued for delivery to codex:auth-fix [codex-${codexAgent.pid}].`);

    const [queued] = codexCalls(sb);
    assert.equal(queued.argv[0], 'queue');
    assert.equal(queued.argv[1], '--thread=thread-abc');
    assert.equal(queued.codexHome, sb.codexHome);
    const text = queued.argv[2].replace(/^--message=/, '');
    assert.match(text, new RegExp(`^\\[telepathy\\] Message from Claude Code session claude:api \\[claude-${claudeAgent.pid}\\]`));
    assert.match(text, /to: "claude:api"/);
    assert.ok(text.endsWith('Schema migration finished.\n--flags stay literal'));
  });

  test('Codex without an approved hook becomes reachable from the thread id in tool-call _meta', async () => {
    const codexAgent = spawnAgent();
    const claudeAgent = spawnAgent();
    const codex = await connect('codex', codexAgent.pid);
    const claude = await connect('claude', claudeAgent.pid);

    const before = await call(claude, 'send_message', { to: `codex-${codexAgent.pid}`, message: 'hi' });
    assert.equal(before.isError, true);
    assert.match(toolText(before), /hasn't reported its thread id yet/);

    await call(codex, 'list_peers', {}, { threadId: 'thread-from-meta', sessionId: 'thread-from-meta' });
    const afterMeta = await call(claude, 'send_message', { to: `codex-${codexAgent.pid}`, message: 'hi again' });
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

    // No listener yet: the sender is told the message waits for read_messages.
    const stored = await call(codex, 'send_message', { to: 'claude:web', message: 'first' });
    assert.match(toolText(stored), /^Message stored for claude:web \[claude-\d+\]\. It has no listener/);

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
      assert.equal(toolText(delivered), `Message delivered to claude:web [claude-${claudeAgent.pid}].`);

      await waitFor(() => out.includes('Ship it?'));
      const lines = out.trim().split('\n');
      assert.equal(lines.length, 2, 'one line per message');
      assert.match(lines[1], new RegExp(`from Codex session codex:backend \\[codex-${codexAgent.pid}\\], sent by another AI agent`));
      assert.match(lines[1], /Tests pass on my side\.\\nShip it\?/);

      const id = /New message (m-[0-9a-z]+-[0-9a-f]+)/.exec(lines[1])![1];
      const read = toolText(await call(claude, 'read_messages', { id }));
      assert.match(read, /Tests pass on my side\.\nShip it\?/);
      assert.match(read, /reply with send_message to: "codex:backend"/);
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
    await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('monitor did not exit')), 6000))]);
  });

  test('read_messages without a monitor claims pending messages', async () => {
    const claudeAgent = spawnAgent();
    const codexAgent = spawnAgent();
    runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/web' });
    const codex = await connect('codex', codexAgent.pid);
    const claude = await connect('claude', claudeAgent.pid);
    await call(codex, 'send_message', { to: `claude-${claudeAgent.pid}`, message: 'pending one' });
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
      assert.equal(res.isError, true);
      assert.match(toolText(res), /codex queue failed: Error: thread not found/);
    } finally {
      if (transportEnvBackup === undefined) delete sb.env.FAKE_CODEX_FAIL;
      else sb.env.FAKE_CODEX_FAIL = transportEnvBackup;
    }
  });

  test('SessionStart loads the using-telepathy skill into new sessions of both agents, not resumed ones', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'plugin', 'skills', 'using-telepathy', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: using-telepathy\ndescription: Use when .+\n---\n/);
    const registered = (agent: string, pid: number) => fs.existsSync(path.join(sb.home, 'peers', `${agent}-${pid}`, 'session.json'));
    for (const agent of ['claude', 'codex'] as const) {
      for (const source of ['startup', 'clear', 'compact', undefined]) {
        const { pid } = spawnAgent();
        const res = runHook(sb, agent, pid, 'session-start', { session_id: 's', cwd: '/w/x', ...(source ? { source } : {}) });
        const out = JSON.parse(res.stdout).hookSpecificOutput;
        assert.equal(out.hookEventName, 'SessionStart');
        assert.match(out.additionalContext, /^The telepathy plugin is installed in this session\. This is its telepathy:using-telepathy skill/);
        assert.match(out.additionalContext, /\n# Using telepathy\n/);
        assert.doesNotMatch(out.additionalContext, /^name: using-telepathy$/m, 'frontmatter is stripped');
        // Claude Code caps hook context at 10,000 characters; Codex spills anything over about 2,500 tokens to a file.
        assert.ok(out.additionalContext.length < 8000, `skill context is ${out.additionalContext.length} characters`);
        assert.ok(registered(agent, pid));
      }
      for (const source of ['resume', 'fork']) {
        const { pid } = spawnAgent();
        const res = runHook(sb, agent, pid, 'session-start', { session_id: 's', cwd: '/w/x', source });
        assert.equal(res.stdout, '', `a ${source}d conversation already has the skill`);
        assert.ok(registered(agent, pid), 'a resumed session is a new process and must register again');
      }
    }
  });

  describe('Claude Code hooks', () => {
    test('ListAgents gets the Codex sessions added to its listing, as rows in its own shape', () => {
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
      assert.ok(rewritten.startsWith(`${listing}\n\nCodex sessions (1), reachable through the telepathy plugin `));
      const added = rewritten.slice(listing.length);
      assert.match(added, /with SendMessage or its send_message tool/);
      // No rollout log for thread "t" in this sandbox, so the status column is left out.
      assert.match(added, new RegExp(`\\n  codex:auth \\[codex-${codexAgent.pid}\\]  ·  interactive  ·  started \\d+s ago$`));
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
    });

    test('ListAgents output of an unknown shape gets the Codex sessions as a note instead', () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/auth' });
      const res = runHook(sb, 'claude', claudeAgent.pid, 'list-agents', { tool_name: 'ListAgents', tool_response: 'text' });
      const out = JSON.parse(res.stdout).hookSpecificOutput;
      assert.equal(out.updatedToolOutput, undefined);
      assert.match(out.additionalContext, new RegExp(`codex:auth \\[codex-${codexAgent.pid}\\]`));
    });

    test('SendMessage to a Codex address is delivered by the hook and the call is stopped', () => {
      const claudeAgent = spawnAgent();
      const codexAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/me' });
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 'thread-x', cwd: '/w/auth' });

      const res = runHook(sb, 'claude', claudeAgent.pid, 'send-message', {
        tool_name: 'SendMessage',
        tool_input: { to: `codex:auth [codex-${codexAgent.pid}]`, message: 'Please rerun the auth tests.' },
      });
      const out = JSON.parse(res.stdout).hookSpecificOutput;
      assert.equal(out.permissionDecision, 'deny');
      assert.equal(
        out.permissionDecisionReason,
        `Delivered by telepathy to codex:auth [codex-${codexAgent.pid}]. SendMessage can't reach Codex, so this shows as an error. Don't resend.`,
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
        tool_input: { to: `codex-${codexAgent.pid}`, message: 'by ref' },
      });
      assert.match(JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason, /^Delivered by telepathy to codex:/);
      assert.equal(codexCalls(sb)[0].argv[1], '--thread=thread-r');
    });

    test('a failing hook never blocks the agent', () => {
      const res = runHook(sb, 'claude', 1, 'bogus-event', {});
      assert.equal(res.status, 0);
      assert.match(res.stderr, /unknown hook event/);
    });
  });
});
