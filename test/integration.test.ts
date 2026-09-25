import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  const spawnAgent = (...args: string[]) => {
    const a = fakeAgent(...args);
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
    fs.rmSync(`${sb.codexLog}.queue.json`, { force: true });
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

  test('unread messages of an exited session wait an hour for the session to be resumed', async () => {
    const senderAgent = spawnAgent();
    runHook(sb, 'codex', senderAgent.pid, 'session-start', { session_id: 't-send', cwd: '/w/sender' });
    const sender = await connect('codex', senderAgent.pid);
    const first = spawnAgent();
    runHook(sb, 'claude', first.pid, 'session-start', { session_id: 'claude-sess', cwd: '/w/app' });
    assert.equal((await call(sender, 'send_message', { to: 'claude:app', message: 'kept for the resume' })).isError, undefined);
    await killAndWait(first);

    // Listing drops the exited session but keeps its unread mail.
    assert.doesNotMatch(toolText(await call(sender, 'list_peers')), new RegExp(`claude-${first.pid}`));
    assert.equal(fs.readdirSync(path.join(sb.home, 'peers', `claude-${first.pid}`, 'inbox')).length, 1);
    // A new session in the same folder is a different conversation: it doesn't get it.
    const fresh = spawnAgent();
    runHook(sb, 'claude', fresh.pid, 'session-start', { session_id: 'new-sess', cwd: '/w/app' });
    assert.equal(runHook(sb, 'claude', fresh.pid, 'inbox', { session_id: 'new-sess' }, 'UserPromptSubmit').stdout, '');
    // The resumed session does.
    const resumed = spawnAgent();
    runHook(sb, 'claude', resumed.pid, 'session-start', { session_id: 'claude-sess', cwd: '/w/app' });
    assert.ok(!fs.existsSync(path.join(sb.home, 'peers', `claude-${first.pid}`)));
    const res = runHook(sb, 'claude', resumed.pid, 'inbox', { session_id: 'claude-sess' }, 'UserPromptSubmit');
    assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /kept for the resume$/);

    // After an hour, unread mail of an exited session is dropped with it.
    const gone = spawnAgent();
    runHook(sb, 'claude', gone.pid, 'session-start', { session_id: 'old', cwd: '/w/old' });
    await call(sender, 'send_message', { to: 'claude:old', message: 'stale' });
    await killAndWait(gone);
    const inbox = path.join(sb.home, 'peers', `claude-${gone.pid}`, 'inbox');
    const hourAgo = new Date(Date.now() - 61 * 60_000);
    for (const f of fs.readdirSync(inbox)) fs.utimesSync(path.join(inbox, f), hourAgo, hourAgo);
    await call(sender, 'list_peers');
    assert.ok(!fs.existsSync(path.join(sb.home, 'peers', `claude-${gone.pid}`)));
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
    fs.writeFileSync(config, `model = "m"\n\n[hooks.state]\n\n${approve('session_start')}`);
    try {
      const codex = await connect('codex', codexAgent.pid);
      assert.match(
        toolText(await call(codex, 'list_peers')),
        /\n\n\[telepathy setup\] Codex hasn't approved telepathy's PostToolUse and UserPromptSubmit hooks, so messages sent while you work reach you only when your turn ends; after an interrupted turn, messages wait for a later turn\. Tell your user: open \/hooks in this session and trust them \(press t\)\.$/,
      );
      assert.doesNotMatch(toolText(await call(codex, 'list_peers')), /telepathy setup/, 'not again for ten minutes');
      assert.match(toolText(await call(codex, 'read_messages')), /telepathy setup/, 'read_messages always says it');

      // A sender learns why a busy Codex gets the message late.
      const claudeAgent = spawnAgent();
      runHook(sb, 'claude', claudeAgent.pid, 'session-start', { session_id: 's', cwd: '/w/me' });
      const claude = await connect('claude', claudeAgent.pid);
      const day = path.join(sb.codexHome, 'sessions', '2026', '09', '25');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, 'rollout-2026-09-25T11-00-00-t-n.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
      assert.match(
        toolText(await call(claude, 'send_message', { to: 'codex:n', message: 'x' })),
        /only after that turn ends \(telepathy's PostToolUse hook isn't approved there; its user can trust it with \/hooks in that session\)\.$/,
      );

      fs.appendFileSync(config, approve('post_tool_use') + approve('user_prompt_submit'));
      assert.doesNotMatch(toolText(await call(codex, 'read_messages')), /telepathy setup/);

      // Another session on a newer telepathy means this one still runs an old build.
      const presence = path.join(sb.home, 'peers', `claude-${claudeAgent.pid}`, 'presence.json');
      fs.writeFileSync(presence, JSON.stringify({ ...JSON.parse(fs.readFileSync(presence, 'utf8')), version: '99.0.0' }));
      assert.match(
        toolText(await call(codex, 'read_messages')),
        /\[telepathy setup\] This session runs telepathy \d+\.\d+\.\d+, but another session runs 99\.0\.0, so messages may not reach this session as they should\. Tell your user to update telepathy in this agent and restart this session\.$/,
      );
      fs.writeFileSync(presence, JSON.stringify({ ...JSON.parse(fs.readFileSync(presence, 'utf8')), version: undefined }));

      // A newer copy installed for this agent: a restart loads it. Older copies elsewhere: update-all fixes them.
      fs.mkdirSync(path.join(sb.codexHome, 'plugins', 'cache', 'telepathy', 'telepathy', '99.1.0'), { recursive: true });
      const gemini = path.join(sb.env.HOME, '.gemini', 'extensions', 'telepathy');
      fs.mkdirSync(gemini, { recursive: true });
      fs.writeFileSync(path.join(gemini, 'gemini-extension.json'), JSON.stringify({ name: 'telepathy', version: '0.1.0' }));
      const notes = toolText(await call(codex, 'read_messages')).split('\n').filter((l) => l.startsWith('[telepathy setup]'));
      assert.deepEqual(notes, [
        `[telepathy setup] This session runs telepathy ${notes[0].match(/runs telepathy ([\d.]+)/)?.[1]}, but 99.1.0 is installed, so messages may not reach this session as they should. Tell your user to restart this session to load the update.`,
        `[telepathy setup] Some agents have an older telepathy installed than 99.1.0: Gemini CLI 0.1.0. Tell your user; with their OK, you can update them all with: node "${path.join(DIST, 'update-all.mjs')}"`,
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
    const geminiManifest = path.join(home, '.gemini', 'extensions', 'telepathy', 'gemini-extension.json');
    const opencodePkg = path.join(home, '.cache', 'opencode', 'packages', 'telepathy@git+https:', 'github.com', 'Winterrks', 'telepathy.git', 'node_modules', 'telepathy', 'package.json');
    const kiloPkg = path.join(home, '.cache', 'kilo', 'packages', 'git', 'git_github.com_Winterrks_telepathy-abc', 'package.json');
    write(geminiManifest, manifest('0.4.4'));
    write(opencodePkg, manifest('0.2.0'));
    write(kiloPkg, manifest('0.1.0'));
    write(path.join(home, '.local', 'share', 'devin', 'cli', 'plugins', 'cache', 'github.com_Winterrks_telepathy_plugin-1', '0.4.1', '.devin-plugin', 'plugin.json'), manifest('0.4.1'));
    // Gemini updates only once its confirmation prompt gets a "y"; OpenCode reinstalls into its emptied cache;
    // Kilo's config load doesn't reinstall anything; Devin isn't on PATH.
    const script = (body: string) => `#!/usr/bin/env node\nconst fs = require('node:fs');\n${body}\n`;
    write(path.join(bin, 'gemini'), script(`let input = ''; process.stdin.on('data', (d) => (input += d)).on('end', () => { process.stdout.write('Do you want to continue? [Y/n]: '); if (input.startsWith('y')) fs.writeFileSync(${JSON.stringify(geminiManifest)}, ${JSON.stringify(manifest('0.6.0'))}); });`));
    write(path.join(bin, 'opencode'), script(`fs.mkdirSync(${JSON.stringify(path.dirname(opencodePkg))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(opencodePkg)}, ${JSON.stringify(manifest('0.6.0'))});`));
    write(path.join(bin, 'kilo'), script(''));
    for (const f of fs.readdirSync(bin)) fs.chmodSync(path.join(bin, f), 0o755);
    const env = { ...sb.env, PATH: `${bin}:${path.dirname(process.execPath)}` };
    try {
      const dry = spawnSync(process.execPath, [path.join(DIST, 'update-all.mjs'), '--dry-run'], { env, encoding: 'utf8' });
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /^telepathy is installed in: Gemini CLI 0\.4\.4, Devin CLI 0\.4\.1, OpenCode 0\.2\.0, Kilo Code 0\.1\.0\.\n/);
      assert.match(dry.stdout, /- Gemini CLI: `gemini extensions update telepathy`\n/);
      assert.match(dry.stdout, /- OpenCode: clear its package cache and run `opencode debug config` to reinstall\n/);
      assert.equal(fs.readFileSync(geminiManifest, 'utf8'), manifest('0.4.4'), 'a dry run changes nothing');

      const res = spawnSync(process.execPath, [path.join(DIST, 'update-all.mjs')], { env, encoding: 'utf8' });
      assert.equal(res.status, 1, 'Kilo and Devin were not updated');
      assert.match(res.stdout, /Updating Gemini CLI… done\n/);
      assert.match(res.stdout, /Updating Devin CLI… failed: `devin` is not on PATH\n/);
      assert.match(res.stdout, /Updating Kilo Code… failed: it didn't reinstall telepathy, so the old copy was kept\./);
      assert.match(res.stdout, /Installed versions:\n- Gemini CLI: 0\.4\.4 → 0\.6\.0\n- Devin CLI: 0\.4\.1\n- OpenCode: 0\.2\.0 → 0\.6\.0\n- Kilo Code: 0\.1\.0\n/);
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
      fs.appendFileSync(rollout, event('task_started') + event('turn_aborted'));
      assert.match(row(), /  ·  interactive  ·  idle after an interrupted turn: gets messages only after its user sends it a prompt  ·  started /);
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
      const ref = `codex:auth [codex-${codexAgent.pid}]`;
      const claude = await connect('claude', claudeAgent.pid);

      fs.writeFileSync(rollout, event('task_started'));
      assert.equal(
        toolText(await call(claude, 'send_message', { to: 'codex:auth', message: 'one' })),
        `Message queued for ${ref}. It's in the middle of a turn, so the message is delivered only after that turn ends.`,
      );
      fs.appendFileSync(rollout, event('turn_aborted'));
      assert.equal(
        toolText(await call(claude, 'send_message', { to: 'codex:auth', message: 'two' })),
        `Message queued for ${ref}, but Codex is holding it: its last turn was interrupted, and it doesn't start ` +
          `queued messages until its user sends that session a prompt. Tell your user if it's urgent; don't resend.`,
      );
      assert.match(toolText(await call(claude, 'list_peers')), /· cwd \/w\/auth · idle after an interrupted turn/);
      assert.equal(codexCalls(sb).length, 2, 'both are still queued');
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

    test('Codex gets queued messages after a tool call or with the next prompt, and they leave its queue', () => {
      const codex = spawnAgent();
      runHook(sb, 'codex', codex.pid, 'session-start', { session_id: 'thread-h', cwd: '/w/cx' });
      const day = path.join(sb.codexHome, 'sessions', '2026', '09', '25');
      fs.mkdirSync(day, { recursive: true });
      const event = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n';
      fs.writeFileSync(path.join(day, 'rollout-2026-09-25T10-00-00-thread-h.jsonl'), event('task_started'));
      const ref = `codex:cx [codex-${codex.pid}]`;
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

    test('a Claude app session (stream-json) is told to keep a one-shot waiter running; a terminal session is not', async () => {
      const app = spawnAgent('--output-format', 'stream-json', '--input-format', 'stream-json');
      const appClient = await connect('claude', app.pid);
      assert.match(appClient.getInstructions() ?? '', /run this with your Bash tool in the background \(run_in_background: true\): node ".*monitor\.mjs" --agent claude --once/);
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
      const listener = path.join(sb.home, 'peers', `claude-${claudeAgent.pid}`, 'listener.json');
      await waitFor(() => fs.existsSync(listener));
      const codexAgent = spawnAgent();
      runHook(sb, 'codex', codexAgent.pid, 'session-start', { session_id: 't', cwd: '/w/api2' });
      const codex = await connect('codex', codexAgent.pid);
      assert.match(toolText(await call(codex, 'send_message', { to: 'claude:app2', message: 'wake up' })), /^Message delivered to/);
      assert.equal(await exited, 0);
      assert.match(out, /\[telepathy\] New message .*wake up$/m);
      assert.ok(!fs.existsSync(listener), 'the waiter removes its listener registration, so the hooks take over until it restarts');
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
