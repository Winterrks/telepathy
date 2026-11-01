import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { agentAuthMethod } from '../src/acp/host.ts';
import { autoMode, pickModel } from '../src/agent/configure.ts';
import { connectServer, fakeAgent, killAndWait, makeSandbox, ROOT, runHook, type Sandbox, toolText, waitFor } from './helpers.ts';

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-harness.mjs');

describe('choosing mode and model', () => {
  test('auto mode is auto, then Copilot\'s autopilot, then Devin\'s smart, never yolo or bypass', () => {
    assert.equal(autoMode([{ value: 'default' }, { value: 'auto-edit' }, { value: 'auto' }, { value: 'yolo' }]), 'auto');
    const copilot = 'https://agentclientprotocol.com/protocol/session-modes#autopilot';
    assert.equal(autoMode([{ value: 'https://agentclientprotocol.com/protocol/session-modes#agent' }, { value: copilot }]), copilot);
    assert.equal(autoMode([{ value: 'accept-edits' }, { value: 'smart' }, { value: 'bypass' }]), 'smart');
    assert.equal(autoMode([{ value: 'build' }, { value: 'plan' }, { value: 'yolo' }]), undefined);
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

  test('without an auto mode, a permission request goes to the parent and its answer is used', async () => {
    const client = await connectServer(sb, 'qwen', parent.pid, ROOT, undefined, env({ FAKE_ACP_NO_AUTO: '1', FAKE_ACP_PERMISSION: '1' }));
    try {
      const started = toolText(await client.callTool({ name: 'start_agent', arguments: { harness: 'kimi', description: 'Tidy logs', prompt: 'Tidy the logs.' } }));
      assert.match(started, /^Started kimi:tidy-logs \[kimi-h-tidy-logs\], Kimi Code in .+, with its default settings\./);
      assert.match(started, /This harness has no auto mode, so each permission request it makes comes to you\./);

      const ask = await waitFor(() => results().find((m) => m.kind === 'permission' && m.from.address === 'kimi:tidy-logs'), 20_000);
      const request = /request "([^"]+)"/.exec(ask.body)![1];
      assert.match(ask.body, /^kimi:tidy-logs asks for permission: shell/);
      const wrong = await client.callTool({ name: 'answer_permission', arguments: { agent: 'kimi:tidy-logs', request: 'p-nope', allow: true } });
      assert.equal(wrong.isError, true);
      assert.equal(
        toolText(await client.callTool({ name: 'answer_permission', arguments: { agent: 'kimi:tidy-logs', request, allow: true } })),
        `Allowed request ${request} for kimi:tidy-logs.`,
      );
      const done = await waitFor(() => results().find((m) => m.kind === 'agent-result' && m.from.address === 'kimi:tidy-logs'), 20_000);
      assert.match(done.body, /^Final report 1: /);
      await client.callTool({ name: 'stop_agent', arguments: { name: 'kimi:tidy-logs' } });
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
      assert.match(toolText(codex), /^Not started: Codex needs `codex-acp` on PATH for ACP, and it is not there\. Install it with `npm install -g @zed-industries\/codex-acp`\./);
    } finally {
      await client.close();
    }
  });
});
