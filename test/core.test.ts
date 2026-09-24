import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { after, before, describe, test } from 'node:test';
import { type Agent, isAgentProcess, parseAgent } from '../src/core/agents.ts';
import { codexActivity } from '../src/core/codex-activity.ts';
import { formatAgo } from '../src/core/listing.ts';
import { formatAsUserTurn, formatMonitorLine, type Message, newMessageId } from '../src/core/messages.ts';
import { peerDir } from '../src/core/paths.ts';
import { listPeers, type Peer, registerPresence, registerSession, resolvePeer, slugify } from '../src/core/peers.ts';
import { fakeAgent, killAndWait, makeSandbox, type Sandbox } from './helpers.ts';

const peer = (agent: Agent, pid: number, name: string): Peer => ({
  id: `${agent}-${pid}`,
  agent,
  pid,
  name,
  address: `${agent}:${slugify(name)}`,
  hasListener: true,
  hasServer: true,
});

describe('slugify', () => {
  test('turns titles into addressable names', () => {
    assert.equal(slugify('Fix the Login Bug!'), 'fix-the-login-bug');
    assert.equal(slugify('  telepathy-46 '), 'telepathy-46');
    assert.equal(slugify('Résumé parser'), 'resume-parser');
    assert.equal(slugify('日本語のスレッド'), '日本語のスレッド');
    assert.equal(slugify('!!!'), '');
    assert.ok(slugify('x'.repeat(100)).length <= 40);
  });
});

describe('resolvePeer', () => {
  const peers = [
    peer('codex', 101, 'Fix auth flow'),
    peer('codex', 102, 'Fix auth flow'),
    peer('codex', 103, 'Billing migration'),
    peer('claude', 201, 'billing-review'),
    peer('claude', 202, 'pi-server'),
    peer('gemini', 301, 'docs'),
    peer('pi', 401, 'ui'),
  ];
  const ok = (to: string) => {
    const r = resolvePeer(to, peers);
    assert.ok('peer' in r, `expected ${to} to resolve, got ${'error' in r ? r.error : ''}`);
    return r.peer.id;
  };

  test('by ref, address, listing form, bare name and prefix', () => {
    assert.equal(ok('codex-103'), 'codex-103');
    assert.equal(ok('codex:billing-migration'), 'codex-103');
    assert.equal(ok('codex:fix-auth-flow [codex-102]'), 'codex-102');
    assert.equal(ok('"codex:billing-migration"'), 'codex-103');
    assert.equal(ok('Billing migration'), 'codex-103');
    assert.equal(ok('claude:billing'), 'claude-201');
    assert.equal(ok('billing-r'), 'claude-201');
    assert.equal(ok('gemini:docs'), 'gemini-301');
    assert.equal(ok('pi-401'), 'pi-401');
    assert.equal(ok('pi:ui'), 'pi-401');
  });

  test('a name that starts like an agent id is still just a name', () => {
    assert.equal(ok('pi-server'), 'claude-202');
    assert.equal(ok('pi-serv'), 'claude-202');
  });

  test('reports ambiguity with refs instead of guessing', () => {
    const r = resolvePeer('codex:fix-auth-flow', peers);
    assert.ok('error' in r);
    assert.match(r.error, /codex-101/);
    assert.match(r.error, /codex-102/);
    const prefix = resolvePeer('billing', peers);
    assert.ok('error' in prefix, 'a prefix shared by two agents must not resolve');
  });

  test('explains what is reachable when nothing matches', () => {
    const r = resolvePeer('codex:nope', peers);
    assert.ok('error' in r);
    assert.match(r.error, /No reachable session matches/);
    assert.match(r.error, /codex:billing-migration \[codex-103\]/);
  });
});

describe('agents', () => {
  const none = () => undefined;
  test('recognizes native binaries by name, scripts by command line, generic names by path', () => {
    assert.ok(isAgentProcess('codex', '/opt/homebrew/bin/codex', none));
    assert.ok(isAgentProcess('claude', 'claude', none));
    assert.ok(isAgentProcess('gemini', '/opt/homebrew/opt/node/bin/node', () => 'node /opt/homebrew/bin/gemini --yolo'));
    assert.ok(isAgentProcess('qwen', 'node', () => 'node /opt/homebrew/lib/node_modules/@qwen-code/qwen-code/cli.js'));
    assert.ok(isAgentProcess('kimi', 'kimi-code', none)); // Kimi Code sets its process title
    assert.ok(isAgentProcess('cursor', 'node', () => 'node /Users/me/.local/share/cursor-agent/versions/2026.09.18/index.js'));
    // Cursor's wrapper runs `exec -a "$0" node …`: ps shows a truncated argv[0], the kernel still says node.
    const cursorArgs = () => '/opt/homebrew/bin/cursor-agent --use-system-ca /opt/homebrew/Caskroom/cursor-cli/x/dist-package/index.js';
    assert.ok(isAgentProcess('cursor', '/opt/homebrew/bi', cursorArgs, () => 'node'));
    assert.ok(!isAgentProcess('cursor', '/opt/homebrew/bi', cursorArgs, () => 'bash'));
    assert.ok(isAgentProcess('grok', '/Users/me/.grok/bin/agent', none));
    assert.ok(!isAgentProcess('cursor', '/Users/me/.grok/bin/agent', none));
    assert.ok(!isAgentProcess('gemini', 'node', () => 'node /usr/lib/node_modules/some-mcp-server/index.js'));
    assert.ok(!isAgentProcess('pi', 'node', () => 'node /tmp/pipeline.js'));
  });

  test('--agent accepts only known ids', () => {
    assert.equal(parseAgent('opencode'), 'opencode');
    assert.throws(() => parseAgent('vim'), /--agent must be one of/);
  });
});

describe('message formatting', () => {
  const msg: Message = {
    id: newMessageId(),
    from: { id: 'claude-1', agent: 'claude', name: 'api-worker', address: 'claude:api-worker' },
    to: { id: 'codex-2', agent: 'codex', name: 'fix-auth', address: 'codex:fix-auth' },
    body: 'Schema migration finished.\nRebase on main is safe now.',
    sentAt: new Date().toISOString(),
  };

  test('ids sort by send time', async () => {
    const a = newMessageId();
    await new Promise((r) => setTimeout(r, 5));
    const b = newMessageId();
    assert.ok(a < b);
  });

  test('Codex text says who sent it, that it is not the user, and how to reply', () => {
    const text = formatAsUserTurn(msg);
    assert.match(text, /^\[telepathy\] Message from Claude Code session claude:api-worker \[claude-1\]/);
    assert.match(text, /not typed by your user/);
    assert.match(text, /to: "claude:api-worker"/);
    assert.ok(text.endsWith(msg.body));
  });

  test('monitor line is a single line with the full text when short', () => {
    const line = formatMonitorLine(msg);
    assert.ok(!line.includes('\n'));
    assert.match(line, /Schema migration finished\.\\nRebase on main is safe now\./);
    assert.match(line, /not your user/);
  });

  test('monitor line points long messages to read_messages', () => {
    const line = formatMonitorLine({ ...msg, body: 'x'.repeat(5000) });
    assert.ok(!line.includes('\n'));
    assert.match(line, new RegExp(`read_messages with id "${msg.id}"`));
    assert.ok(line.length < 2500);
  });
});

describe('registry', () => {
  let sb: Sandbox;
  before(() => {
    sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CLAUDE_CONFIG_DIR = sb.env.CLAUDE_CONFIG_DIR;
    process.env.CODEX_HOME = sb.codexHome;
  });
  after(() => sb.cleanup());

  test('lists live sessions and removes the registrations of exited ones', async () => {
    const live = fakeAgent();
    const dead = fakeAgent();
    registerSession('codex', live.pid, { sessionId: 'thread-live', cwd: '/work/alpha', source: 'hook' });
    registerPresence('claude', dead.pid, { cwd: '/work/beta' });
    await killAndWait(dead);

    const peers = listPeers();
    assert.deepEqual(
      peers.map((p) => [p.id, p.address, p.sessionId]),
      [[`codex-${live.pid}`, 'codex:alpha', 'thread-live']],
    );
    assert.equal(fs.existsSync(peerDir(`claude-${dead.pid}`)), false);
    await killAndWait(live);
  });

  test('a reused pid is not mistaken for the old session', async () => {
    const agent = fakeAgent();
    registerSession('codex', agent.pid, { sessionId: 't', cwd: '/w/x', source: 'hook' });
    const file = path.join(peerDir(`codex-${agent.pid}`), 'session.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.procStart = 'Mon Jan  1 00:00:00 2001';
    fs.writeFileSync(file, JSON.stringify(record));
    assert.equal(listPeers().length, 0);
    await killAndWait(agent);
  });

  test('names come from the Codex thread index, and the folder-name address keeps working', async () => {
    const agent = fakeAgent();
    registerSession('codex', agent.pid, { sessionId: 'thread-9', cwd: '/w/repo', source: 'hook' });
    assert.equal(listPeers()[0]?.address, 'codex:repo');

    // Codex titles the thread later; an agent still holding the old address must still reach it.
    fs.writeFileSync(
      path.join(sb.codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: 'thread-9', thread_name: 'Refactor payments API', updated_at: 'x' }) + '\n',
    );
    const peers = listPeers();
    assert.equal(peers[0]?.address, 'codex:refactor-payments-api');
    const r = resolvePeer('codex:repo', peers);
    assert.ok('peer' in r && r.peer.id === `codex-${agent.pid}`);
    await killAndWait(agent);
  });
});

describe('ListAgents rows', () => {
  test('relative start times read like ListAgents', () => {
    assert.equal(formatAgo(-5), '0s ago');
    assert.equal(formatAgo(45_000), '45s ago');
    assert.equal(formatAgo(14 * 60_000 + 59_000), '14m ago');
    assert.equal(formatAgo(10 * 3_600_000), '10h ago');
    assert.equal(formatAgo(36 * 3_600_000), '1d ago');
  });

  test('Codex busy/idle comes from the last turn event in the thread\'s rollout log', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'um-rollout-'));
    try {
      assert.equal(codexActivity(codexHome, 'abc'), undefined);
      const older = path.join(codexHome, 'sessions', '2026', '08', '30');
      const newer = path.join(codexHome, 'sessions', '2026', '09', '02');
      fs.mkdirSync(older, { recursive: true });
      fs.mkdirSync(newer, { recursive: true });
      const event = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n';
      // A resumed thread keeps its file in the folder of the day it began.
      const file = path.join(older, 'rollout-2026-08-30T10-00-00-abc.jsonl');
      fs.writeFileSync(path.join(newer, 'rollout-2026-09-02T09-00-00-other.jsonl'), event('task_started'));
      fs.writeFileSync(file, event('task_started') + event('turn_aborted'));
      assert.equal(codexActivity(codexHome, 'abc'), 'idle');
      // Only the last megabyte is read; a huge item after the turn started must not hide that it's running.
      fs.appendFileSync(file, event('task_started') + JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(2_000_000) } }) + '\n');
      assert.equal(codexActivity(codexHome, 'abc'), undefined);
      fs.appendFileSync(file, event('token_count'));
      assert.equal(codexActivity(codexHome, 'abc'), undefined);
      fs.appendFileSync(file, event('task_started') + event('item_completed'));
      assert.equal(codexActivity(codexHome, 'abc'), 'busy');
      fs.appendFileSync(file, 'not json\n' + event('task_complete'));
      assert.equal(codexActivity(codexHome, 'abc'), 'idle');
      fs.appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_sta');
      assert.equal(codexActivity(codexHome, 'abc'), 'idle', 'a half-written last line is skipped');
      assert.equal(codexActivity(codexHome, 'other'), 'busy');
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
