import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { agentAuthMethod } from '../src/acp/host.ts';
import { autoMode, cheapestModel, readOnlyMode, pickModel } from '../src/agent/configure.ts';
import { allowedBy, requestInfo, simpleCommands, suggestPrefixes } from '../src/agent/policy.ts';
import { parseVerdict } from '../src/agent/reviewer.ts';
import { explainStartError } from '../src/agent/host.ts';
import { limitNotice } from '../src/agent/task.ts';
import { sendMessage } from '../src/core/deliver.ts';
import { claimSessionOwner, isDeliveryOwner, isPeerAlive, readPeer, sessionOwners } from '../src/core/peers.ts';
import { connectServer, fakeAgent, killAndWait, makeSandbox, ROOT, runHook, type Sandbox, toolText, waitFor } from './helpers.ts';

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-harness.mjs');

describe('choosing mode and model', () => {
  test('auto mode is auto, then Copilot\'s autopilot, then Devin\'s smart, never yolo or bypass', () => {
    assert.equal(autoMode([{ value: 'default' }, { value: 'auto-edit' }, { value: 'auto' }, { value: 'yolo' }]), 'auto');
    const copilot = 'https://agentclientprotocol.com/protocol/session-modes#autopilot';
    assert.equal(autoMode([{ value: 'https://agentclientprotocol.com/protocol/session-modes#agent' }, { value: copilot }]), copilot);
    assert.equal(autoMode([{ value: 'accept-edits' }, { value: 'smart' }, { value: 'bypass' }]), 'smart');
    assert.equal(autoMode([{ value: 'build' }, { value: 'plan' }, { value: 'yolo' }]), undefined);
    // Codex (@agentclientprotocol/codex-acp): `agent` is "Auto review"; Cursor's `agent` is not an auto mode.
    const codex = [{ value: 'read-only', name: 'Read-only' }, { value: 'agent', name: 'Auto review' }, { value: 'agent-full-access', name: 'Full access' }];
    assert.equal(autoMode(codex), 'agent');
    assert.equal(autoMode([{ value: 'agent', name: 'Agent' }, { value: 'plan', name: 'Plan' }, { value: 'ask', name: 'Ask' }]), undefined);
  });

  test('only a single sign-in the agent runs itself is called; a terminal login is left to the user', () => {
    assert.equal(agentAuthMethod({ authMethods: [{ id: 'grok.com', name: 'Grok' }] }), 'grok.com');
    const terminal = { id: 'login', type: 'terminal', _meta: { 'terminal-auth': { command: 'kimi' } } };
    assert.equal(agentAuthMethod({ authMethods: [terminal] }), undefined);
    assert.equal(agentAuthMethod({ authMethods: [{ id: 'copilot-login', _meta: { 'terminal-auth': { command: 'copilot' } } }] }), undefined);
    assert.equal(agentAuthMethod({ authMethods: [{ id: 'a' }, { id: 'b' }] }), undefined, 'two choices are not ours to make');
    assert.equal(agentAuthMethod({}), undefined);
  });

  test('a model is matched by id, by a unique part, and Cursor variants by effort', () => {
    const models = ['openai/gpt-5.4', 'openai/gpt-5.5', 'anthropic/claude-opus-5-5'].map((value) => ({ value }));
    assert.deepEqual(pickModel(models, 'openai/gpt-5.5'), { value: 'openai/gpt-5.5' });
    assert.deepEqual(pickModel(models, 'opus'), { value: 'anthropic/claude-opus-5-5' });
    assert.deepEqual(pickModel(models, 'gpt'), { ambiguous: ['openai/gpt-5.4', 'openai/gpt-5.5'] });
    assert.deepEqual(pickModel(models, 'gemini'), {});
    const cursor = ['claude-opus-5-5[effort=medium,fast=false]', 'claude-opus-5-5[effort=high,fast=false]', 'gpt-5.5[reasoning=medium]'].map((value) => ({ value }));
    assert.deepEqual(pickModel(cursor, 'claude-opus-5-5', 'high'), { value: 'claude-opus-5-5[effort=high,fast=false]' });
  });
});

describe('permission policy', () => {
  const ask = (allow: string[]) => ({ mode: 'ask' as const, allow });
  const run = (command: string) => ({ kind: 'execute', title: command, command });

  test('a command is allowed only when every part of it is, by whole words', () => {
    assert.deepEqual(simpleCommands('cd "a b" && git -C x status 2>/dev/null | head -c 80; ls'), [['cd', 'a b'], ['git', '-C', 'x', 'status'], ['head', '-c', '80'], ['ls']]);
    for (const line of ['echo hi > out.txt', 'ls $(pwd)', 'ls `pwd`', 'sleep 1 &', 'cat <<EOF', 'diff <(ls) x', 'echo "unclosed']) {
      assert.equal(simpleCommands(line), undefined, line);
    }
    const policy = ask(['git status', 'git log', 'head']);
    assert.equal(allowedBy(policy, run('cd "/r" && git -C /r status && git log -5 | head -50')), 'git status, git log, head');
    assert.equal(allowedBy(policy, run('git status && git push')), undefined);
    assert.equal(allowedBy(policy, run('git statusx')), undefined);
    assert.equal(allowedBy(policy, run('git status > notes.txt')), undefined);
    assert.equal(allowedBy(ask(['Bash(npm test:*)']), run('npm test -- --watch=false')), 'npm test');
    assert.equal(allowedBy(ask(['Edit']), { kind: 'edit', title: 'Edit a.ts' }), 'Edit');
    assert.equal(allowedBy(ask(['Edit']), run('rm -rf /')), undefined);
    const edit = (file: string) => ({ kind: 'edit', title: 'Edit', paths: [file] });
    assert.equal(allowedBy(ask(['Edit']), edit('/r/src/a.ts'), ['/r']), 'Edit');
    assert.equal(allowedBy(ask(['Edit']), edit('src/a.ts'), ['/r']), 'Edit');
    assert.equal(allowedBy(ask(['Edit']), edit('/home/u/.telepathy/agents/x/policy.json'), ['/r']), undefined);
    assert.equal(allowedBy(ask(['Edit']), edit('/r/../etc/x'), ['/r']), undefined);
    assert.equal(simpleCommands('ls >&1x'), undefined);
  });

  test('always remembers the prefixes a request uses, never a word that runs anything', () => {
    assert.deepEqual(suggestPrefixes(run('cd /r && git status -s && npm run build && ls -la')), ['git status', 'npm run build', 'ls']);
    assert.deepEqual(suggestPrefixes(run('sleep 8 && gh run list --repo x')), ['sleep', 'gh run list']);
    for (const line of ['node build.js', 'bash -c "ls"', 'FOO=1 npm test', 'git -c core.pager=x log', 'ls $(pwd)', 'gh pr', 'npm exec foo', 'pnpm dlx x', 'uv run python x.py', 'docker exec c sh', 'npm run']) {
      assert.deepEqual(suggestPrefixes(run(line)), [], line);
    }
  });

  test("Cursor's request puts the command in the title, in backticks", () => {
    const info = requestInfo(
      { toolCall: { title: '`git status && echo \\`x\\``', kind: 'execute', content: [{ type: 'content', content: { type: 'text', text: 'check the tree' } }] } },
      'label',
    );
    assert.deepEqual(info, { kind: 'execute', title: '`git status && echo \\`x\\``', command: 'git status && echo `x`', reason: 'check the tree' });
  });

  test("the reviewer's verdict is its first ALLOW or ASK line; anything else is not an approval", () => {
    assert.deepEqual(parseVerdict('**ALLOW**: routine test run'), { allow: true, reason: 'routine test run' });
    assert.deepEqual(parseVerdict('Looking at it.\nASK - pushes to main'), { allow: false, reason: 'pushes to main' });
    assert.deepEqual(parseVerdict('Upgrade your plan to continue'), { allow: false, reason: 'it gave no verdict ("Upgrade your plan to continue")' });
    assert.deepEqual(parseVerdict(''), { allow: false, reason: 'it gave no verdict' });
  });

  test("the reviewer takes the cheapest model by name and a read-only mode", () => {
    const cursor = ['default[]', 'composer-2.5[fast=true]', 'claude-opus-5-5[effort=high]', 'gemini-3.8-flash[reasoning_effort=high]', 'gpt-5.4-mini[reasoning=medium]', 'gemini-3.1-pro[]'];
    assert.equal(cheapestModel(cursor.map((value) => ({ value }))), 'gemini-3.8-flash[reasoning_effort=high]');
    assert.equal(cheapestModel(['openai/gpt-5.4', 'openai/gpt-5.4-mini', 'openai/gpt-5-nano'].map((value) => ({ value }))), 'openai/gpt-5-nano');
    assert.equal(cheapestModel(['openai/gpt-5.4', 'anthropic/claude-opus-5-5'].map((value) => ({ value }))), undefined);
    assert.equal(readOnlyMode(['agent', 'plan', 'ask'].map((value) => ({ value }))), 'ask');
    assert.equal(readOnlyMode(['build', 'plan'].map((value) => ({ value }))), 'plan');
    assert.equal(readOnlyMode(['default', 'auto'].map((value) => ({ value }))), undefined);
  });
});

describe('reports that are not the agent\'s work', () => {
  test("a harness's plan or usage limit, as the whole final message, is a failed turn", () => {
    for (const text of ['Upgrade your plan to continue', 'Free usage limit reached.', 'Rate limit exceeded: free-models-per-day', 'This request would exceed your available credits']) {
      assert.equal(limitNotice(text), true, text);
    }
    for (const text of ['', 'Done. I fixed the usage limit check in billing.ts.', `Upgrade your plan to continue ${'x'.repeat(400)}`]) {
      assert.equal(limitNotice(text), false, text);
    }
  });

  test('a Codex config the adapter cannot read says why', () => {
    const said = explainStartError('codex', '/opt/homebrew/bin/codex-acp', 'agent exited: Error: error loading config: config.toml:557:1: invalid type');
    assert.match(said, /This codex-acp runs a Codex older than your codex CLI/);
    assert.match(said, /npm install -g @agentclientprotocol\/codex-acp/);
    assert.equal(explainStartError('opencode', 'opencode', 'error loading config'), 'error loading config');
  });
});

describe('start_agent', () => {
  let sb: Sandbox;
  let bin: string;
  let log: string;
  let parent: ChildProcess & { pid: number };

  before(() => {
    sb = makeSandbox();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-agent-bins-'));
    log = path.join(bin, 'harness.jsonl');
    for (const name of ['opencode', 'kimi']) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.env.FAKE_ARGV0 = ${JSON.stringify(name)};\nimport(process.env.FAKE_HARNESS_FILE);\n`);
      fs.chmodSync(file, 0o755);
    }
    parent = fakeAgent();
    runHook(sb, 'qwen', parent.pid, 'session-start', { session_id: 'boss', cwd: ROOT });
  });

  after(async () => {
    await killAndWait(parent);
    for (const dir of fs.existsSync(path.join(sb.home, 'agents')) ? fs.readdirSync(path.join(sb.home, 'agents')) : []) {
      const state = JSON.parse(fs.readFileSync(path.join(sb.home, 'agents', dir, 'state.json'), 'utf8'));
      try {
        process.kill(state.pid, 'SIGKILL');
      } catch {
        // stopped already
      }
    }
    sb.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_HARNESS_FILE: FAKE,
    FAKE_HARNESS_LOG: log,
    FAKE_ACP_AGENT: '1',
    ...extra,
  });
  const inbox = () => path.join(sb.home, 'peers', 'qwen-boss', 'inbox');
  const results = () =>
    (fs.existsSync(inbox()) ? fs.readdirSync(inbox()) : [])
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => JSON.parse(fs.readFileSync(path.join(inbox(), file), 'utf8')));
  const calls = (method: string) =>
    fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.method === method);

  test('starts a harness in auto mode with the model and effort, and its final message comes back with the transcript', async () => {
    const client = await connectServer(sb, 'qwen', parent.pid, ROOT, undefined, env());
    try {
      const started = toolText(
        await client.callTool({
          name: 'start_agent',
          arguments: { harness: 'opencode', description: 'Check auth tests', prompt: 'Run the auth tests and report.', model: 'gpt-5.5', effort: 'high' },
        }),
      );
      assert.match(started, /^Started opencode:check-auth-tests \[opencode-h-check-auth-tests\], OpenCode in .+, with mode auto, model openai\/gpt-5\.5, effort high\.\n/);
      const transcript = /Transcript: (\S+)/.exec(started)![1];
      assert.match(started, /kind="agent-result"/);
      assert.deepEqual(
        calls('session/set_config_option').map((c) => [c.params.configId, c.params.value]),
        [['mode', 'auto'], ['model', 'openai/gpt-5.5'], ['effort', 'high']],
      );

      const first = await waitFor(() => results().find((m) => m.kind === 'agent-result'), 20_000);
      assert.equal(first.from.address, 'opencode:check-auth-tests');
      assert.equal(first.body, 'Final report 1: all 12 auth tests pass.', 'only the last run of text, not "Looking into it."');
      assert.equal(first.transcript, transcript);
      const task = calls('session/prompt')[0].params.prompt[0].text as string;
      assert.match(task, /^<telepathy-peer-message id="m-[^"]+" from="qwen:[^"]+ \[qwen-boss\]"/);
      assert.match(task, /Run the auth tests and report\.\n\n\(You are an agent qwen:[^ ]+ started with telepathy's start_agent/);

      const text = fs.readFileSync(transcript, 'utf8');
      assert.match(text, /^# OpenCode agent: Check auth tests\n/);
      assert.match(text, /## Task from qwen:/);
      assert.match(text, /Looking into it\./);
      assert.match(text, /- tool: npm test \(pending\)\n {2}- npm test: completed/);
      assert.match(text, /Final report 1: all 12 auth tests pass\.\n\n— turn ended: end_turn/);

      // Listed like any session, continued with send_message, and each turn reports back.
      assert.match(toolText(await client.callTool({ name: 'list_peers', arguments: {} })), /- opencode:check-auth-tests \[opencode-h-check-auth-tests\]/);
      assert.match(toolText(await client.callTool({ name: 'send_message', arguments: { to: 'opencode:check-auth-tests', message: 'Now the billing tests.' } })), /^Message delivered to opencode:check-auth-tests/);
      const second = await waitFor(() => results().find((m) => m.kind === 'agent-result' && m.body.startsWith('Final report 2')), 20_000);
      assert.equal(second.body, 'Final report 2: all 12 auth tests pass.');

      const stopped = toolText(await client.callTool({ name: 'stop_agent', arguments: { name: 'opencode:check-auth-tests' } }));
      assert.equal(stopped, `Stopped opencode:check-auth-tests. Transcript: ${transcript}.`);
      assert.match(fs.readFileSync(transcript, 'utf8'), /— stopped at /);
      assert.doesNotMatch(toolText(await client.callTool({ name: 'list_peers', arguments: {} })), /opencode:check-auth-tests/);
    } finally {
      await client.close();
    }
  });

  test('a harness that exits on its own is reported to the parent, and a later send says why it is gone', async () => {
    const client = await connectServer(sb, 'qwen', parent.pid, ROOT, undefined, env({ FAKE_ACP_EXIT_ON_PROMPT: '3' }));
    try {
      const started = toolText(await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description: 'Crash early', prompt: 'Do it.' } }));
      assert.match(started, /^Started opencode:crash-early /);
      const report = await waitFor(() => results().find((m) => m.kind === 'agent-result' && m.from.address === 'opencode:crash-early'), 20_000);
      assert.match(report.body, /^opencode:crash-early stopped: its OpenCode process exited with code 3\. Its transcript: /);
      await waitFor(() => JSON.parse(fs.readFileSync(path.join(sb.home, 'agents', 'opencode-crash-early', 'state.json'), 'utf8')).status === 'stopped', 20_000);
      const sent = await client.callTool({ name: 'send_message', arguments: { to: 'opencode:crash-early', message: 'Still there?' } });
      assert.equal(sent.isError, true);
      assert.match(toolText(sent), /^opencode:crash-early is an agent this session started, and it stopped at \S+: its OpenCode process exited with code 3\. Its transcript: .+ Start a new agent/);
    } finally {
      await client.close();
    }
  });

  test("with telepathy's auto mode off, a permission request goes to the parent and its answer is used", async () => {
    const client = await connectServer(sb, 'qwen', parent.pid, ROOT, undefined, env({ FAKE_ACP_NO_AUTO: '1', FAKE_ACP_PERMISSION: '1' }));
    try {
      const started = toolText(
        await client.callTool({ name: 'start_agent', arguments: { harness: 'kimi', description: 'Tidy logs', prompt: 'Tidy the logs.', permissions: { mode: 'ask' } } }),
      );
      assert.match(started, /^Started kimi:tidy-logs \[kimi-h-tidy-logs\], Kimi Code in .+, with its default settings\./);
      assert.match(started, /\nIt has no auto mode over ACP, and telepathy's is off: each permission request it makes comes to you\.\n/);

      const ask = await waitFor(() => results().find((m) => m.kind === 'permission' && m.from.address === 'kimi:tidy-logs'), 20_000);
      const request = /request "([^"]+)"/.exec(ask.body)![1];
      assert.match(ask.body, /^kimi:tidy-logs asks for permission: shell/);
      assert.match(ask.body, /\(with always true, "ls" won't be asked about again\)/);
      const wrong = await client.callTool({ name: 'answer_permission', arguments: { agent: 'kimi:tidy-logs', request: 'p-nope', allow: true } });
      assert.equal(wrong.isError, true);
      assert.equal(
        toolText(await client.callTool({ name: 'answer_permission', arguments: { agent: 'kimi:tidy-logs', request, allow: true, always: true } })),
        `Allowed request ${request} for kimi:tidy-logs. From now on it runs ls without asking (allowed: ls).`,
      );
      const done = await waitFor(() => results().find((m) => m.kind === 'agent-result' && m.from.address === 'kimi:tidy-logs'), 20_000);
      assert.match(done.body, /^Final report 1: /);

      // The same command again goes ahead without asking.
      await client.callTool({ name: 'send_message', arguments: { to: 'kimi:tidy-logs', message: 'Again, please.' } });
      await waitFor(() => results().find((m) => m.kind === 'agent-result' && m.from.address === 'kimi:tidy-logs' && m.body.startsWith('Final report 2')), 20_000);
      assert.equal(results().filter((m) => m.kind === 'permission' && m.from.address === 'kimi:tidy-logs').length, 1);
      const transcript = fs.readFileSync(path.join(sb.home, 'agents', 'kimi-tidy-logs', 'transcript.md'), 'utf8');
      assert.match(transcript, /- allowed without asking: shell \(\{"command":"ls"\}\) \(allowed: ls\)/);
      await client.callTool({ name: 'stop_agent', arguments: { name: 'kimi:tidy-logs' } });
    } finally {
      await client.close();
    }
  });

  test("by default, a harness with no auto mode gets telepathy's: a reviewer of the same harness, without telepathy and in a read-only mode", async () => {
    const client = await connectServer(sb, 'qwen', parent.pid, ROOT, undefined, env({ FAKE_ACP_NO_AUTO: '1', FAKE_ACP_PERMISSION: '1', FAKE_ACP_PERMISSION_COMMAND: 'npm test' }));
    try {
      const started = toolText(await client.callTool({ name: 'start_agent', arguments: { harness: 'kimi', description: 'Run tests', prompt: 'Run the tests.' } }));
      assert.match(
        started,
        /\nIt has no auto mode over ACP, so telepathy's is on: a reviewer session of Kimi Code \(its cheapest model, medium effort\) approves routine permission requests, and the rest come to you\.\n/,
      );
      const done = await waitFor(() => results().find((m) => m.kind === 'agent-result' && m.from.address === 'kimi:run-tests'), 20_000);
      assert.match(done.body, /^Final report 1: /);
      assert.deepEqual(results().filter((m) => m.kind === 'permission' && m.from.address === 'kimi:run-tests'), [], 'the reviewer answered it');
      const transcript = fs.readFileSync(path.join(sb.home, 'agents', 'kimi-run-tests', 'transcript.md'), 'utf8');
      assert.match(transcript, /- reviewing: shell \(\{"command":"npm test"\}\)\n  - allowed by the reviewer: a routine listing/);
      const reviews = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.event === 'review');
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].disabled, '1', 'the reviewer runs without telepathy');
      const reviewer = calls('session/new').at(-1);
      assert.deepEqual(reviewer.params.mcpServers, [], 'and without its MCP server');
      assert.ok(calls('session/set_config_option').some((c) => c.params.configId === 'mode' && c.params.value === 'plan'), 'in a read-only mode');
      assert.doesNotMatch(toolText(await client.callTool({ name: 'list_peers', arguments: {} })), /kimi:(?!run-tests)/, 'and is no session of its own');
      await client.callTool({ name: 'stop_agent', arguments: { name: 'kimi:run-tests' } });
    } finally {
      await client.close();
    }
  });

  test("auto mode: what the reviewer won't approve comes to the parent with its reason; an allow list skips both", async () => {
    const client = await connectServer(
      sb,
      'qwen',
      parent.pid,
      ROOT,
      undefined,
      env({ FAKE_ACP_NO_AUTO: '1', FAKE_ACP_PERMISSION: '1', FAKE_ACP_PERMISSION_COMMAND: 'git push origin main', FAKE_REVIEW_VERDICT: 'Let me see.\nASK: pushes to main' }),
    );
    try {
      const started = toolText(
        await client.callTool({ name: 'start_agent', arguments: { harness: 'kimi', description: 'Ship it', prompt: 'Ship it.', permissions: { allow: ['npm test'], model: 'gpt-5.5' } } }),
      );
      assert.match(started, /reviewer session of Kimi Code \(model gpt-5\.5\) approves routine permission requests, and the rest come to you\. Allowed without asking: npm test\.\n/);
      const ask = await waitFor(() => results().find((m) => m.kind === 'permission' && m.from.address === 'kimi:ship-it'), 20_000);
      assert.match(ask.body, /^kimi:ship-it asks for permission: shell .*\nThe reviewer did not approve it on its own: pushes to main\.\n/);
      assert.match(ask.body, /\(with always true, "git push" won't be asked about again\)/);
      const request = /request "([^"]+)"/.exec(ask.body)![1];
      await client.callTool({ name: 'answer_permission', arguments: { agent: 'kimi:ship-it', request, allow: true } });
      await waitFor(() => results().find((m) => m.kind === 'agent-result' && m.from.address === 'kimi:ship-it'), 20_000);

      const set = toolText(await client.callTool({ name: 'set_permission_mode', arguments: { agent: 'kimi:ship-it', mode: 'ask', allow: ['Bash(git push:*)', 'npm test'] } }));
      assert.equal(set, "kimi:ship-it: it has no auto mode over ACP, and telepathy's is off: each permission request it makes comes to you. Allowed without asking: git push, npm test.");
      await client.callTool({ name: 'send_message', arguments: { to: 'kimi:ship-it', message: 'Once more.' } });
      await waitFor(() => results().find((m) => m.kind === 'agent-result' && m.from.address === 'kimi:ship-it' && m.body.startsWith('Final report 2')), 20_000);
      assert.equal(results().filter((m) => m.kind === 'permission' && m.from.address === 'kimi:ship-it').length, 1);
      const notMine = await client.callTool({ name: 'set_permission_mode', arguments: { agent: 'kimi:nobody', mode: 'auto' } });
      assert.equal(notMine.isError, true);
      await client.callTool({ name: 'stop_agent', arguments: { name: 'kimi:ship-it' } });
    } finally {
      await client.close();
    }
  });

  test("a harness with an auto mode of its own runs in it, and what it still asks goes to the parent unreviewed", async () => {
    const client = await connectServer(sb, 'qwen', parent.pid, ROOT, undefined, env({ FAKE_ACP_PERMISSION: '1', FAKE_ACP_PERMISSION_COMMAND: 'rm -rf build' }));
    try {
      const reviewsBefore = fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('"event":"review"')).length;
      const started = toolText(await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description: 'Own auto', prompt: 'x' } }));
      assert.match(started, /with mode auto\./);
      assert.doesNotMatch(started, /reviewer|telepathy's is/);
      const ask = await waitFor(() => results().find((m) => m.kind === 'permission' && m.from.address === 'opencode:own-auto'), 20_000);
      assert.doesNotMatch(ask.body, /reviewer/);
      assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('"event":"review"')).length, reviewsBefore);
      const set = toolText(await client.callTool({ name: 'set_permission_mode', arguments: { agent: 'opencode:own-auto', allow: ['rm -rf build'] } }));
      assert.equal(set, "opencode:own-auto: its harness's own auto mode decides, and what it still asks about comes to you. Allowed without asking: rm -rf build.");
      await client.callTool({ name: 'stop_agent', arguments: { name: 'opencode:own-auto' } });
    } finally {
      await client.close();
    }
  });

  test('isolation "worktree" gives it a worktree and branch, removed at stop when unchanged and kept when changed', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-agent-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.mkdirSync(path.join(repo, 'pkg'));
    fs.writeFileSync(path.join(repo, 'pkg', 'a.txt'), 'a\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const client = await connectServer(sb, 'qwen', parent.pid, ROOT, undefined, env());
    try {
      const start = async (description: string) => {
        const text = toolText(
          await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description, prompt: 'x', cwd: path.join(repo, 'pkg'), isolation: 'worktree' } }),
        );
        assert.match(text, /It works in its own worktree on branch telepathy\//, text);
        return text;
      };
      const clean = await start('Clean run');
      const tree = path.join(sb.home, 'worktrees', 'opencode-clean-run');
      assert.match(clean, new RegExp(`OpenCode in ${tree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pkg,`));
      assert.match(git('branch', '--list', 'telepathy/clean-run'), /telepathy\/clean-run/);
      assert.match(toolText(await client.callTool({ name: 'stop_agent', arguments: { name: 'opencode:clean-run' } })), /^Stopped opencode:clean-run\. Transcript: .+\.$/);
      assert.equal(fs.existsSync(tree), false);
      assert.equal(git('branch', '--list', 'telepathy/clean-run'), '');

      await start('Dirty run');
      fs.writeFileSync(path.join(sb.home, 'worktrees', 'opencode-dirty-run', 'pkg', 'a.txt'), 'changed\n');
      const stopped = toolText(await client.callTool({ name: 'stop_agent', arguments: { name: 'opencode:dirty-run' } }));
      assert.match(stopped, /Its worktree .+opencode-dirty-run \(branch telepathy\/dirty-run\) has changes and was kept\.$/);
    } finally {
      await client.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a model that does not exist, or a harness without its ACP binary, is not started', async () => {
    const client = await connectServer(sb, 'qwen', parent.pid, ROOT, undefined, env());
    try {
      const bad = await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description: 'Bad model', prompt: 'x', model: 'gemini' } });
      assert.equal(bad.isError, true);
      assert.match(toolText(bad), /^Not started: OpenCode no model matches "gemini"\. Available: openai\/gpt-5\.4, openai\/gpt-5\.5, anthropic\/claude-opus-5-5/);
      const file = path.join(bin, 'harness.jsonl');
      const notDir = await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description: 'x', prompt: 'x', cwd: file } });
      assert.match(toolText(notDir), /^Not started: .+ is not a directory\.$/, 'a file as cwd is refused, and the server lives on');
      const traversal = await client.callTool({
        name: 'answer_permission',
        arguments: { agent: 'opencode:anything', request: '../../claude-other/permissions/p-abc-1234', allow: true },
      });
      assert.equal(traversal.isError, true);
      assert.match(toolText(traversal), /is not a permission request id/);
      const codex = await client.callTool({ name: 'start_agent', arguments: { harness: 'codex', description: 'Review', prompt: 'x' } });
      assert.match(toolText(codex), /^Not started: Codex needs `codex-acp` on PATH for ACP, and it is not there\. Install it with `npm install -g @agentclientprotocol\/codex-acp`\./);
    } finally {
      await client.close();
    }
  });

  test('follow-up messages tell the subagent not to reply with send_message, and a send_message to the parent is held for turn end', async () => {
    const prevHome = process.env.TELEPATHY_HOME;
    process.env.TELEPATHY_HOME = sb.home;
    const client = await connectServer(sb, 'qwen', parent.pid, ROOT, undefined, env());
    try {
      await client.callTool({
        name: 'start_agent',
        arguments: { harness: 'opencode', description: 'Held report', prompt: 'Check the schema.' },
      });
      await waitFor(() => results().find((m) => m.kind === 'agent-result' && m.from.address === 'opencode:held-report'), 20_000);
      const subPeer = readPeer('opencode-h-held-report');
      assert.ok(subPeer, 'subagent peer exists while running');

      // If the subagent calls send_message to its parent before a turn finishes, it is held in parent-report.json rather than delivered twice.
      const held = await sendMessage(subPeer, 'qwen-boss', 'Detailed findings from send_message.');
      assert.equal(held.ok, true);
      if (held.ok) assert.match(held.status, /^Held for turn end:/);

      await client.callTool({ name: 'send_message', arguments: { to: 'opencode:held-report', message: 'Follow up on indexes.' } });
      const second = await waitFor(
        () => results().find((m) => m.kind === 'agent-result' && m.from.address === 'opencode:held-report' && m.body.includes('Final report 2')),
        20_000,
      );
      assert.match(second.body, /^Detailed findings from send_message\.\n\nFinal report 2: all 12 auth tests pass\.$/);
      const prompts = calls('session/prompt').filter((c) => String(c.params?.prompt?.[0]?.text ?? '').includes('Follow up on indexes.'));
      assert.equal(prompts.length, 1);
      assert.match(
        prompts[0].params.prompt[0].text,
        /Do not call send_message to reply to qwen:[^:]+: end your turn with your final report as your last message, and telepathy will deliver it\./,
      );

      // Ancestor/descendant processes claiming the same session collapse to the child owner, and pid <= 1 is never alive.
      const child = fakeAgent();
      try {
        claimSessionOwner('opencode-ses_nested', process.pid);
        claimSessionOwner('opencode-ses_nested', child.pid);
        assert.deepEqual(sessionOwners('opencode-ses_nested').map((o) => o.pid), [child.pid]);
        assert.equal(isDeliveryOwner('opencode-ses_nested', child.pid), true);
        assert.equal(isPeerAlive({ id: 'devin-1', agent: 'devin', pid: 1, name: 'x', address: 'devin:x', startedAt: new Date().toISOString(), hasServer: false, hasListener: false }), false);
      } finally {
        await killAndWait(child);
      }

      await client.callTool({ name: 'stop_agent', arguments: { name: 'opencode:held-report' } });
    } finally {
      await client.close();
      if (prevHome === undefined) delete process.env.TELEPATHY_HOME;
      else process.env.TELEPATHY_HOME = prevHome;
    }
  });
});
