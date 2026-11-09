import assert from 'node:assert/strict';
import { type ChildProcess, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { claudeConnection } from './claude-connection.ts';
import { DIST, fakeAgent, killAndWait, makeSandbox, ROOT, runHook, type Sandbox, waitFor } from './helpers.ts';

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-harness.mjs');

describe('start_agent as an MCP task (Claude Code)', () => {
  let sb: Sandbox;
  let bin: string;
  let parent: ChildProcess & { pid: number };

  before(() => {
    sb = makeSandbox();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-task-bins-'));
    for (const name of ['opencode', 'kimi']) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.env.FAKE_ARGV0 = ${JSON.stringify(name)};\nimport(process.env.FAKE_HARNESS_FILE);\n`);
      fs.chmodSync(file, 0o755);
    }
    parent = fakeAgent();
    runHook(sb, 'claude', parent.pid, 'session-start', { session_id: 'boss', cwd: ROOT });
  });

  after(async () => {
    await killAndWait(parent);
    const agents = path.join(sb.home, 'agents');
    for (const dir of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
      try {
        process.kill(JSON.parse(fs.readFileSync(path.join(agents, dir, 'state.json'), 'utf8')).pid, 'SIGKILL');
      } catch {
        // stopped already, or never started
      }
    }
    sb.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => ({
    ...sb.env,
    TELEPATHY_AGENT_PID: String(parent.pid),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_HARNESS_FILE: FAKE,
    FAKE_HARNESS_LOG: path.join(bin, 'harness.jsonl'),
    FAKE_ACP_AGENT: '1',
    ...extra,
  });
  const inbox = () => path.join(sb.home, 'peers', 'claude-boss', 'inbox');
  const messages = () =>
    (fs.existsSync(inbox()) ? fs.readdirSync(inbox()) : []).sort().map((file) => JSON.parse(fs.readFileSync(path.join(inbox(), file), 'utf8')));
  const state = (address: string) => JSON.parse(fs.readFileSync(path.join(sb.home, 'agents', address.replace(':', '-'), 'state.json'), 'utf8'));

  test('the report is the task\'s result, a follow-up is a task of its own, and no message is sent', async () => {
    const session = claudeConnection(env());
    try {
      const discover = await session.request('server/discover');
      assert.ok(discover.result?.supportedVersions.includes('2026-07-28'));
      assert.match(discover.result?.instructions, /use telepathy's start_agent \(on this machine: [^)]*opencode/);

      const started = await session.call('start_agent', { harness: 'opencode', description: 'Check auth tests', prompt: 'Run the auth tests.' });
      assert.equal(started.result?.resultType, 'task');
      assert.equal(started.result?.taskId, 'opencode:check-auth-tests');
      assert.equal(started.result?.status, 'working');
      assert.match(started.result?.statusMessage, /^OpenCode is starting: Check auth tests$/);

      const first = await session.settle('opencode:check-auth-tests');
      assert.equal(first.status, 'completed');
      assert.match(first.result.content[0].text, /^Final report 1: all 12 auth tests pass\.\n\n\(OpenCode agent opencode:check-auth-tests; transcript: .+transcript\.md\)$/);

      const again = await session.call('send_message', { to: 'opencode:check-auth-tests', message: 'Now the billing tests.' });
      assert.equal(again.result?.resultType, 'task');
      assert.equal(again.result?.taskId, 'opencode:check-auth-tests#2');
      const second = await session.settle('opencode:check-auth-tests#2');
      assert.match(second.result.content[0].text, /^Final report 2: /);
      assert.deepEqual(messages().filter((m) => m.kind === 'agent-result'), [], 'the reports went to the tasks, not the inbox');

      // A report with no task open goes to the parent as a message, as start_agent's always did.
      await session.call('send_message', { to: 'opencode:check-auth-tests', message: 'One more.' }, false);
      const third = await waitFor(() => messages().find((m) => m.kind === 'agent-result' && m.body.startsWith('Final report 3')), 20_000);
      assert.equal(third.from.address, 'opencode:check-auth-tests');

      assert.equal((await session.request('tasks/get', { taskId: 'nope' })).error?.code, -32602);
      await session.call('stop_agent', { name: 'opencode:check-auth-tests' });
    } finally {
      await session.close();
    }
  });

  test('without the tasks extension, start_agent returns at once as before', async () => {
    const session = claudeConnection(env());
    try {
      await session.request('server/discover', {}, false);
      const started = await session.call('start_agent', { harness: 'opencode', description: 'Plain start', prompt: 'x' }, false);
      assert.equal(started.result?.resultType, 'complete');
      assert.match(started.result?.content[0].text, /^Started opencode:plain-start \[opencode-h-plain-start\]/);
      await waitFor(() => messages().find((m) => m.kind === 'agent-result' && m.from.address === 'opencode:plain-start'), 20_000);
      await session.call('stop_agent', { name: 'opencode:plain-start' }, false);
    } finally {
      await session.close();
    }
  });

  test('TaskStop cancels the task and stops the agent', async () => {
    const session = claudeConnection(env({ FAKE_ACP_DELAY_MS: '60000' }));
    try {
      await session.request('server/discover');
      await session.call('start_agent', { harness: 'opencode', description: 'Long job', prompt: 'Take your time.' });
      await waitFor(() => fs.existsSync(path.join(sb.home, 'agents', 'opencode-long-job', 'state.json')) && state('opencode:long-job').status === 'ready', 20_000);
      assert.match((await session.request('tasks/get', { taskId: 'opencode:long-job' })).result?.statusMessage, /^OpenCode is working: Long job$/);
      assert.equal((await session.request('tasks/cancel', { taskId: 'opencode:long-job' })).result?.resultType, 'complete');
      await waitFor(() => state('opencode:long-job').status === 'stopped', 20_000);
      const cancelled = (await session.request('tasks/get', { taskId: 'opencode:long-job' })).result!;
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.statusMessage, 'Stopped opencode:long-job.');
      assert.deepEqual(messages().filter((m) => m.from?.address === 'opencode:long-job'), [], 'a stopped turn reports nothing');
    } finally {
      await session.close();
    }
  });

  test('a plugin reload keeps the agent and its task; the session ending stops it', async () => {
    const owner = fakeAgent();
    runHook(sb, 'claude', owner.pid, 'session-start', { session_id: 'owner', cwd: ROOT });
    const ownerEnv = (extra: Record<string, string> = {}) => env({ TELEPATHY_AGENT_PID: String(owner.pid), TELEPATHY_AGENT_ORPHAN_MS: '1000', ...extra });
    try {
      // A quick one: the server restarts while it works, and the new server's task gets the report.
      const first = claudeConnection(ownerEnv({ FAKE_ACP_DELAY_MS: '2500' }));
      await first.request('server/discover');
      await first.call('start_agent', { harness: 'opencode', description: 'Survives reload', prompt: 'x' });
      await first.close();
      const second = claudeConnection(ownerEnv());
      try {
        await second.request('server/discover');
        const done = await second.settle('opencode:survives-reload');
        assert.equal(done.status, 'completed');
        assert.match(done.result.content[0].text, /^Final report 1: /);

        // A long one: still running after its server is gone, and stopped once the session's process ends.
        await second.call('start_agent', { harness: 'opencode', description: 'Session ends', prompt: 'x' }).then(() => undefined);
        await waitFor(() => fs.existsSync(path.join(sb.home, 'agents', 'opencode-session-ends', 'state.json')) && state('opencode:session-ends').status === 'ready', 20_000);
      } finally {
        await second.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      assert.equal(state('opencode:session-ends').status, 'ready', 'a server going away is not the session ending');
    } finally {
      await killAndWait(owner);
    }
    await waitFor(() => state('opencode:session-ends').status === 'stopped', 20_000);
    assert.match(fs.readFileSync(path.join(sb.home, 'agents', 'opencode-session-ends', 'transcript.md'), 'utf8'), /— stopped: claude:[^ ]+ has been gone for 1 second\n/);
  });

  test('a permission request is the task\'s input request, answered in the dialog', async () => {
    const session = claudeConnection(env({ FAKE_ACP_NO_AUTO: '1', FAKE_ACP_PERMISSION: '1' }));
    try {
      await session.request('server/discover');
      await session.call('start_agent', { harness: 'kimi', description: 'Tidy logs', prompt: 'Tidy the logs.', permissions: { mode: 'ask' } });
      const asking = await session.settle('kimi:tidy-logs');
      assert.equal(asking.status, 'input_required');
      const [[request, input]] = Object.entries(asking.inputRequests as Record<string, { method: string; params: Record<string, any> }>);
      assert.equal(input.method, 'elicitation/create');
      assert.match(input.params.message, /^kimi:tidy-logs asks for permission: shell/);
      assert.deepEqual(Object.keys(input.params.requestedSchema.properties), ['allow', 'always']);
      assert.equal(input.params.requestedSchema.properties.always.title, "Don't ask again for ls");
      await session.request('tasks/update', { taskId: 'kimi:tidy-logs', inputResponses: { [request]: { action: 'accept', content: { allow: true, always: true } } } });
      const done = await session.settle('kimi:tidy-logs');
      assert.equal(done.status, 'completed');
      assert.match(done.result.content[0].text, /^Final report 1: /);
      assert.deepEqual(messages().filter((m) => m.from?.address === 'kimi:tidy-logs'), [], 'nothing came as a message');
      const policy = JSON.parse(fs.readFileSync(path.join(sb.home, 'agents', 'kimi-tidy-logs', 'policy.json'), 'utf8'));
      assert.deepEqual(policy.allow, ['ls'], '"always" in the dialog allows it from now on');
      await session.call('stop_agent', { name: 'kimi:tidy-logs' });
    } finally {
      await session.close();
    }
  });

  test('a task lost to a server Claude Code no longer polls: its request waits, comes as a message, and answering it follows the agent again', async () => {
    const lostEnv = env({ FAKE_ACP_NO_AUTO: '1', FAKE_ACP_PERMISSION: '1', FAKE_ACP_PERMISSION_DELAY_MS: '1500', TELEPATHY_TASK_PICKUP_MS: '1500' });
    const first = claudeConnection(lostEnv);
    await first.request('server/discover');
    await first.call('start_agent', { harness: 'kimi', description: 'Lost task', prompt: 'x', permissions: { mode: 'ask' } });
    await waitFor(() => fs.existsSync(path.join(sb.home, 'agents', 'kimi-lost-task', 'state.json')) && state('kimi:lost-task').status === 'ready', 20_000);
    // A plugin update restarts the server under a new path: Claude Code stops polling the task, and no server adopts it.
    await first.close();
    const ask = await waitFor(() => messages().find((m) => m.kind === 'permission' && m.from.address === 'kimi:lost-task'), 20_000);
    const transcript = () => fs.readFileSync(path.join(sb.home, 'agents', 'kimi-lost-task', 'transcript.md'), 'utf8');
    assert.match(transcript(), /> Its task in claude:[^ ]+ was lost when that session's telepathy server restarted; this went as a message\./);
    const request = /request "([^"]+)"/.exec(ask.body)![1];

    const second = claudeConnection(lostEnv);
    try {
      await second.request('server/discover');
      const answered = await second.call('answer_permission', { agent: 'kimi:lost-task', request, allow: true });
      assert.equal(answered.result?.resultType, 'task');
      assert.equal(answered.result?.taskId, 'kimi:lost-task');
      assert.match(
        answered.result?._meta?.['com.anthropic/agent-task']?.modelImmediateResponse,
        new RegExp(`^Allowed request ${request} for kimi:lost-task\\.\\nkimi:lost-task is a background task again: its next permission request goes to your user in a dialog, and its report is this task's result\\.$`),
      );
      const done = await second.settle('kimi:lost-task');
      assert.equal(done.status, 'completed');
      assert.match(done.result.content[0].text, /^Final report 1: /);
      assert.deepEqual(messages().filter((m) => m.kind === 'agent-result' && m.from.address === 'kimi:lost-task'), [], 'the report went to the task');

      // An idle agent, or one a task already follows, is answered the usual way.
      const set = await second.call('set_permission_mode', { agent: 'kimi:lost-task', mode: 'auto' });
      assert.equal(set.result?.resultType, 'complete');
      assert.match(set.result?.content[0].text, /^kimi:lost-task: it has no auto mode over ACP, so telepathy's is on: a reviewer session of Kimi Code/);
      await second.call('stop_agent', { name: 'kimi:lost-task' });
    } finally {
      await second.close();
    }
  });

  test('sessions starting agents at once get names of their own', async () => {
    const sessions = [1, 2, 3].map(() => claudeConnection(env()));
    try {
      await Promise.all(sessions.map((s) => s.request('server/discover')));
      const started = await Promise.all(sessions.map((s) => s.call('start_agent', { harness: 'opencode', description: 'Same task', prompt: 'x' })));
      assert.deepEqual(started.map((r) => r.result?.taskId).sort(), ['opencode:same-task', 'opencode:same-task-2', 'opencode:same-task-3']);
      for (const name of ['same-task', 'same-task-2', 'same-task-3']) await sessions[0].call('stop_agent', { name: `opencode:${name}` });
    } finally {
      await Promise.all(sessions.map((s) => s.close()));
    }
  });

  test('the Agent tool naming another harness is pointed to start_agent', () => {
    const hook = (subagent_type: string) => {
      const res = spawnSync(process.execPath, [path.join(DIST, 'hook.mjs'), '--agent', 'claude', 'agent'], {
        input: JSON.stringify({ session_id: 'boss', cwd: ROOT, tool_name: 'Agent', tool_input: { subagent_type, description: 'x', prompt: 'x' } }),
        env: env(),
        encoding: 'utf8',
      });
      return res.stdout.trim() ? JSON.parse(res.stdout).hookSpecificOutput : undefined;
    };
    const denied = hook('telepathy:opencode');
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /^Not started: OpenCode isn't a Claude agent type\. Start it with telepathy's start_agent \(harness "opencode",/);
    assert.match(hook('codex:fix-auth').permissionDecisionReason, /harness "codex", name "fix-auth"/);
    for (const type of ['general-purpose', 'claude', 'telepathy:claude', 'pi', 'Explore']) assert.equal(hook(type), undefined, type);
    const config = sb.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(path.join(config, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(config, 'agents', 'codex.md'), '---\nname: codex\n---\n');
    try {
      assert.equal(hook('codex'), undefined, "the user's own agent keeps its name");
    } finally {
      fs.rmSync(path.join(config, 'agents'), { recursive: true, force: true });
    }
  });

  test('a failed turn settles the task as failed, a mid-turn send_message does not open a duplicate task, and SendMessage points to send_message', async () => {
    const failing = claudeConnection(env({ FAKE_ACP_REJECT: '1' }));
    try {
      await failing.request('server/discover');
      const started = await failing.call('start_agent', { harness: 'opencode', description: 'Rejecting turn', prompt: 'x' });
      assert.equal(started.result?.taskId, 'opencode:rejecting-turn');
      const settled = await failing.settle('opencode:rejecting-turn');
      assert.equal(settled.status, 'failed');
      assert.match(settled.statusMessage, /^opencode:rejecting-turn failed\.$/);
      assert.match(settled.error?.message, /The turn failed: rejected\./);
      await failing.call('stop_agent', { name: 'opencode:rejecting-turn' });
    } finally {
      await failing.close();
    }

    const session = claudeConnection(env({ FAKE_ACP_DELAY_MS: '1500' }));
    try {
      await session.request('server/discover');
      await session.call('start_agent', { harness: 'opencode', description: 'Busy steer', prompt: 'Work on part 1.' });
      await waitFor(() => fs.existsSync(path.join(sb.home, 'agents', 'opencode-busy-steer', 'state.json')) && state('opencode:busy-steer').status === 'ready', 20_000);

      // Claude's native SendMessage to a start_agent subagent is denied without sending so Claude uses telepathy's send_message.
      const nativeSend = spawnSync(process.execPath, [path.join(DIST, 'hook.mjs'), '--agent', 'claude', 'send-message'], {
        input: JSON.stringify({ session_id: 'boss', cwd: ROOT, tool_name: 'SendMessage', tool_input: { to: 'opencode:busy-steer', message: 'hi' } }),
        env: env(),
        encoding: 'utf8',
      });
      const out = JSON.parse(nativeSend.stdout).hookSpecificOutput;
      assert.equal(out.permissionDecision, 'deny');
      assert.match(
        out.permissionDecisionReason,
        /^Not sent: opencode:busy-steer is an agent you started with start_agent\. Call telepathy's send_message tool \(to: "opencode:busy-steer"\) so its turn runs as a background task\.$/,
      );

      // While task #1 is still open on the running turn, send_message delivers without opening a competing #2 task.
      const midTurn = await session.call('send_message', { to: 'opencode:busy-steer', message: 'Also check part 2.' });
      assert.equal(midTurn.result?.resultType, 'complete');
      assert.match(midTurn.result?.content[0].text, /^Message delivered to opencode:busy-steer/);
      const first = await session.settle('opencode:busy-steer');
      assert.equal(first.status, 'completed');
      await session.call('stop_agent', { name: 'opencode:busy-steer' });
    } finally {
      await session.close();
    }
  });
});
