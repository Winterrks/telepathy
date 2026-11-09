import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { cli, type Device, device, pair, remoteState, startDaemon } from './bridge-helpers.ts';
import { claudeConnection } from './claude-connection.ts';
import { connectServer, fakeAgent, killAndWait, ROOT, runHook, toolText, waitFor } from './helpers.ts';

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-harness.mjs');

describe('start_agent on another device', () => {
  let alpha: Device;
  let beta: Device;
  let bin: string;
  let boss: ChildProcess & { pid: number };

  before(async () => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-remote-bins-'));
    // kimi asks for permission; opencode doesn't.
    const wrappers: Record<string, string> = {
      opencode: '',
      kimi: "process.env.FAKE_ACP_NO_AUTO = '1'; process.env.FAKE_ACP_PERMISSION = '1';",
    };
    for (const [name, extra] of Object.entries(wrappers)) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.env.FAKE_ARGV0 = ${JSON.stringify(name)};\n${extra}\nimport(process.env.FAKE_HARNESS_FILE);\n`);
      fs.chmodSync(file, 0o755);
    }
    alpha = await device('alpha');
    // The agents run on beta, spawned by its bridge, so its bridge has the harnesses on PATH.
    beta = await device('beta', {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_HARNESS_FILE: FAKE,
      FAKE_HARNESS_LOG: path.join(bin, 'harness.jsonl'),
      FAKE_ACP_AGENT: '1',
      TELEPATHY_AGENT_ORPHAN_MS: '1500',
    });
    await startDaemon(alpha);
    await startDaemon(beta);
    assert.equal(cli(alpha.env, 'bridge', 'add', `127.0.0.1:${beta.port}`).status, 0);
    await waitFor(() => (remoteState(alpha).devices.some((d) => d.slug === 'beta') ? true : undefined));
    await pair(alpha, beta);
    boss = fakeAgent();
    runHook(alpha.sb, 'claude', boss.pid, 'session-start', { session_id: 'boss', cwd: ROOT });
    await waitFor(() => (remoteState(beta).devices.some((d) => d.slug === 'alpha' && d.peers.some((p) => p.address.startsWith('claude:'))) ? true : undefined));
  });

  after(async () => {
    await killAndWait(boss);
    const agents = path.join(beta.sb.home, 'agents');
    for (const dir of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
      try {
        process.kill(JSON.parse(fs.readFileSync(path.join(agents, dir, 'state.json'), 'utf8')).pid, 'SIGKILL');
      } catch {
        // stopped already
      }
    }
    for (const d of [alpha, beta]) if (d?.daemon) await killAndWait(d.daemon as ChildProcess & { pid: number });
    alpha?.sb.cleanup();
    beta?.sb.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => ({ ...(alpha.env as Record<string, string>), TELEPATHY_AGENT_PID: String(boss.pid), ...extra });
  const inbox = () => path.join(alpha.sb.home, 'peers', 'claude-boss', 'inbox');
  const messages = () =>
    (fs.existsSync(inbox()) ? fs.readdirSync(inbox()) : []).sort().map((file) => JSON.parse(fs.readFileSync(path.join(inbox(), file), 'utf8')));
  const state = (slug: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(beta.sb.home, 'agents', slug, 'state.json'), 'utf8'));
    } catch {
      return undefined;
    }
  };

  test('a device starts agents only for devices its user allowed', async () => {
    const client = await connectServer(alpha.sb, 'claude', boss.pid, ROOT, undefined, env());
    try {
      const refused = await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description: 'Too early', prompt: 'x', device: 'beta' } });
      assert.equal(refused.isError, true);
      assert.match(toolText(refused), /^Not started: beta does not let alpha start agents\. To allow it, run `telepathy bridge allow-agents alpha` on beta\.$/);
      assert.equal(fs.existsSync(path.join(beta.sb.home, 'agents', 'opencode-too-early')), false);
      const nowhere = await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description: 'x', prompt: 'x', device: 'gamma' } });
      assert.match(toolText(nowhere), /^Not started: no device named "gamma"\. Your devices: beta\.$/);
    } finally {
      await client.close();
    }
    const allowed = cli(beta.env, 'bridge', 'allow-agents', 'alpha');
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /^Sessions on alpha can now start agents on this device with start_agent\./);
    assert.match(cli(beta.env, 'bridge', 'status').stdout, /alpha · paired · .* · may start agents here/);
  });

  test('outside a task: it starts there, its report comes back as a message, and stop_agent stops it', async () => {
    const client = await connectServer(alpha.sb, 'claude', boss.pid, ROOT, undefined, env());
    try {
      const nowhere = await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description: 'x', prompt: 'x', device: 'beta', cwd: '/no/such/folder' } });
      assert.match(toolText(nowhere), /^Not started: \/no\/such\/folder is not a folder on beta\. Pass cwd, a folder on beta\./);

      const started = toolText(await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description: 'Remote check', prompt: 'Check it.', device: 'beta' } }));
      assert.match(started, /^Started opencode:remote-check@beta \[opencode-h-remote-check@beta\], OpenCode in .+ on beta, with /);
      assert.match(started, /\nTranscript: .+transcript\.md on beta\n/);
      const spec = JSON.parse(fs.readFileSync(path.join(beta.sb.home, 'agents', 'opencode-remote-check', 'spec.json'), 'utf8'));
      assert.equal(spec.parent.address.endsWith('@alpha'), true, 'beta knows its parent by its @alpha address');
      assert.equal(spec.cwd, ROOT, 'the caller\'s folder, which exists on beta too');

      const report = await waitFor(() => messages().find((m) => m.kind === 'agent-result' && m.body.startsWith('Final report 1')), 20_000);
      assert.equal(report.from.address, 'opencode:remote-check@beta');
      assert.match(report.transcript, /transcript\.md on beta$/);

      const stopped = toolText(await client.callTool({ name: 'stop_agent', arguments: { name: 'opencode:remote-check@beta' } }));
      assert.match(stopped, /^Stopped opencode:remote-check@beta\. Transcript: .+transcript\.md on beta\.$/);
      assert.equal(state('opencode-remote-check').status, 'stopped');
    } finally {
      await client.close();
    }
  });

  test('as an MCP task: the report is the result, a follow-up is a task, and TaskStop stops it there', async () => {
    const session = claudeConnection(env());
    try {
      await session.request('server/discover');
      const started = await session.call('start_agent', { harness: 'opencode', description: 'Remote task', prompt: 'x', device: 'beta' });
      assert.equal(started.result?.resultType, 'task');
      assert.equal(started.result?.taskId, 'opencode:remote-task@beta');
      assert.match(started.result?.statusMessage, /^OpenCode is starting on beta: Remote task$/);
      const first = await session.settle('opencode:remote-task@beta');
      assert.equal(first.status, 'completed', JSON.stringify(first));
      assert.match(first.result.content[0].text, /^Final report 1: .+\n\n\(OpenCode agent opencode:remote-task@beta; transcript: .+transcript\.md on beta\)$/);

      const again = await session.call('send_message', { to: 'opencode:remote-task@beta', message: 'Once more.' });
      assert.equal(again.result?.taskId, 'opencode:remote-task@beta#2');
      const second = await session.settle('opencode:remote-task@beta#2');
      assert.match(second.result.content[0].text, /^Final report 2: /);
      assert.deepEqual(messages().filter((m) => m.from?.address === 'opencode:remote-task@beta'), [], 'the reports went to the tasks');

      // The next follow-up is still working when TaskStop comes.
      const third = await session.call('send_message', { to: 'opencode:remote-task@beta', message: 'And a slow one.' });
      assert.equal(third.result?.taskId, 'opencode:remote-task@beta#3');
      await session.request('tasks/cancel', { taskId: 'opencode:remote-task@beta#3' });
      await waitFor(() => (state('opencode-remote-task')?.status === 'stopped' ? true : undefined), 20_000);
      assert.equal((await session.request('tasks/get', { taskId: 'opencode:remote-task@beta#3' })).result?.status, 'cancelled');
    } finally {
      await session.close();
    }
  });

  test('a permission request from an agent there is the task\'s dialog here', async () => {
    const session = claudeConnection(env());
    try {
      await session.request('server/discover');
      await session.call('start_agent', { harness: 'kimi', description: 'Remote tidy', prompt: 'Tidy.', device: 'beta', permissions: { mode: 'ask' } });
      const asking = await session.settle('kimi:remote-tidy@beta');
      assert.equal(asking.status, 'input_required', JSON.stringify(asking));
      const [[request, input]] = Object.entries(asking.inputRequests as Record<string, { params: Record<string, any> }>);
      assert.match(input.params.message, /^kimi:remote-tidy asks for permission: shell/);
      await session.request('tasks/update', { taskId: 'kimi:remote-tidy@beta', inputResponses: { [request]: { action: 'accept', content: { allow: true } } } });
      const done = await session.settle('kimi:remote-tidy@beta');
      assert.equal(done.status, 'completed', JSON.stringify(done));
      assert.match(done.result.content[0].text, /^Final report 1: /);
      const answer = fs.readdirSync(path.join(beta.sb.home, 'agents', 'kimi-remote-tidy', 'permissions')).find((f) => f.endsWith('.answer.json'));
      assert.equal(JSON.parse(fs.readFileSync(path.join(beta.sb.home, 'agents', 'kimi-remote-tidy', 'permissions', answer!), 'utf8')).allow, true);
      await session.call('stop_agent', { name: 'kimi:remote-tidy@beta' });
    } finally {
      await session.close();
    }
  });

  test('an agent there stops when the session here that started it ends', async () => {
    const owner = fakeAgent();
    runHook(alpha.sb, 'claude', owner.pid, 'session-start', { session_id: 'owner', cwd: ROOT });
    await waitFor(() => (remoteState(beta).devices.some((d) => d.slug === 'alpha' && d.peers.some((p) => (p as { id?: string }).id === 'claude-owner')) ? true : undefined));
    const client = await connectServer(alpha.sb, 'claude', owner.pid, ROOT, undefined, env({ TELEPATHY_AGENT_PID: String(owner.pid) }));
    try {
      const started = toolText(await client.callTool({ name: 'start_agent', arguments: { harness: 'opencode', description: 'Orphaned', prompt: 'x', device: 'beta' } }));
      assert.match(started, /^Started opencode:orphaned@beta /);
    } finally {
      await client.close();
    }
    await killAndWait(owner);
    await waitFor(() => (state('opencode-orphaned')?.status === 'stopped' ? true : undefined), 20_000);
    assert.match(fs.readFileSync(path.join(beta.sb.home, 'agents', 'opencode-orphaned', 'transcript.md'), 'utf8'), /— stopped: claude:[^ ]+@alpha has been gone for 2 seconds\n/);

    const denied = cli(beta.env, 'bridge', 'deny-agents', 'alpha');
    assert.equal(denied.status, 0, denied.stderr);
    assert.doesNotMatch(cli(beta.env, 'bridge', 'status').stdout, /may start agents here/);
  });
});
