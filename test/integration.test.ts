import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../src/core/agents.ts';
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

    // No monitor yet: the sender is told the message waits for Claude's next turn (its hooks hand it over).
    const stored = await call(codex, 'send_message', { to: 'claude:web', message: 'first' });
    assert.match(toolText(stored), /^Message stored for claude:web \[claude-\d+\]\. It can't be woken while idle/);

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

  test('SessionStart registers the session and prints nothing; the skill is a normal on-demand skill', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'plugin', 'skills', 'using-telepathy', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: using-telepathy\ndescription: Use when .+\n---\n/);
    for (const agent of ['claude', 'codex'] as const) {
      for (const source of ['startup', 'resume', 'clear', 'compact', undefined]) {
        const { pid } = spawnAgent();
        const res = runHook(sb, agent, pid, 'session-start', { session_id: 's', cwd: '/w/x', ...(source ? { source } : {}) });
        assert.equal(res.stdout, '', 'both agents add SessionStart stdout to context');
        assert.ok(fs.existsSync(path.join(sb.home, 'peers', `${agent}-${pid}`, 'session.json')));
      }
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
        `Message queued for delivery to codex:auth [codex-${codexAgent.pid}]. (Sent by telepathy: SendMessage can't reach Codex, so this shows as an error. Don't resend.)`,
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
      assert.match(JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason, /^Message queued for delivery to codex:/);
      assert.equal(codexCalls(sb)[0].argv[1], '--thread=thread-r');
    });

    test('a failing hook never blocks the agent', () => {
      const res = runHook(sb, 'claude', 1, 'bogus-event', {});
      assert.equal(res.status, 0);
      assert.match(res.stderr, /unknown hook action/);
    });
  });

  describe('OpenCode and Kilo Code plugin', () => {
    /** Runs the built plugin in its own process (its pid is the session identity) with a fake SDK client. */
    function startOpenCode(directory: string) {
      const child = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'opencode-driver.mjs'), path.join(DIST, 'opencode.mjs'), directory], {
        env: sb.env,
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
      assert.match(JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason, new RegExp(`^Message delivered to opencode:ui \\[opencode-${pid}\\]\\.`));

      await new Promise((r) => setTimeout(r, 400));
      assert.ok(!oc.lines.some((l) => 'prompt' in l), 'must not prompt a busy session');

      oc.send({ op: 'event', event: { type: 'session.idle', properties: { sessionID: 'ses_main' } } });
      const { prompt } = await oc.take('prompt');
      assert.equal(prompt.path.id, 'ses_main');
      assert.equal(prompt.body.agent, 'build');
      assert.match(prompt.body.parts[0].text, /^\[telepathy\] Message from Claude Code session claude:sdk/);
      assert.match(prompt.body.parts[0].text, /new daemon API is in$/);
    });

    test('tools and the system-prompt guide work like the MCP server\'s', async () => {
      const oc = startOpenCode('/w/ui2');
      await oc.take('ready');
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/api' });
      oc.send({ op: 'tool', name: 'telepathy_list_peers', sessionID: 'ses_x' });
      assert.match((await oc.take('tool')).output, /claude:api \[claude-\d+\]/);
      oc.send({ op: 'tool', name: 'telepathy_send_message', args: { to: 'claude:api', message: 'hi from opencode' }, sessionID: 'ses_x' });
      assert.match((await oc.take('tool')).output, /^Message stored for claude:api/);
      oc.send({ op: 'system' });
      assert.match((await oc.take('system')).system[0], /^telepathy: message other coding-agent sessions/);
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

    test('Gemini gets messages as context at its next prompt or tool call, once', () => {
      const gemini = spawnAgent();
      runHook(sb, 'gemini', gemini.pid, 'session-start', { session_id: 'g-1', cwd: '/w/docs', hook_event_name: 'SessionStart' });
      const status = sendFromClaude('gemini:docs', 'Is the API reference current?');
      assert.equal(
        status,
        `Message stored for gemini:docs [gemini-${gemini.pid}]. It can't be woken while idle, so it will see it at its next turn. ` +
          "(Sent by telepathy: SendMessage can't reach Gemini CLI, so this shows as an error. Don't resend.)",
      );
      const res = runHook(sb, 'gemini', gemini.pid, 'inbox', { session_id: 'g-1', hook_event_name: 'AfterTool' }, 'AfterTool');
      const out = JSON.parse(res.stdout).hookSpecificOutput;
      assert.equal(out.hookEventName, 'AfterTool');
      assert.match(out.additionalContext, /^\[telepathy\] A new message from another AI agent session \(not your user\)/);
      assert.match(out.additionalContext, /\[telepathy\] Message from Claude Code session claude:web/);
      assert.match(out.additionalContext, /Is the API reference current\?$/);
      assert.equal(runHook(sb, 'gemini', gemini.pid, 'inbox', { session_id: 'g-1' }, 'BeforeAgent').stdout, '');
    });

    test('a turn that ends with messages pending goes on with them, in each agent\'s own shape', () => {
      const cases: [Agent, (res: ReturnType<typeof runHook>) => string][] = [
        ['gemini', (r) => JSON.parse(r.stdout).decision === 'block' && JSON.parse(r.stdout).reason],
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
        await waitFor(() => fs.existsSync(path.join(sb.home, 'peers', `claude-${claudeAgent.pid}`, 'listener.json')));
        await call(codex, 'send_message', { to: 'claude:app', message: 'for the monitor' });
        await waitFor(() => out.includes('for the monitor'));
        const prompt = runHook(sb, 'claude', claudeAgent.pid, 'inbox', { session_id: 'app' }, 'UserPromptSubmit');
        const stop = runHook(sb, 'claude', claudeAgent.pid, 'turn-end', { session_id: 'app' });
        assert.deepEqual([prompt.stdout, stop.stdout], ['', ''], 'hooks stay quiet while the monitor delivers');
      } finally {
        await killAndWait(monitor);
      }
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
      assert.match(status, new RegExp(`^Message stored for antigravity:infra \\[antigravity-${agy.pid}\\]\\. It can't be woken while idle`));
    });

    test('Copilot and Cursor get the guide at session start, since they don\'t show MCP instructions', () => {
      const copilot = spawnAgent();
      const guide = JSON.parse(runHook(sb, 'copilot', copilot.pid, 'session-start', { sessionId: 'x', cwd: '/w/a' }).stdout);
      assert.match(guide.additionalContext, /^telepathy: message other coding-agent sessions/);
      const cursor = spawnAgent();
      const cguide = JSON.parse(runHook(sb, 'cursor', cursor.pid, 'session-start', { conversation_id: 'y' }).stdout);
      assert.match(cguide.additional_context, /come from another AI agent, not your user/);
      const gemini = spawnAgent();
      assert.equal(runHook(sb, 'gemini', gemini.pid, 'session-start', { session_id: 'z' }).stdout, '');
    });
  });
});
