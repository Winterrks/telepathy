import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { claimResumedCopilot, copilotLaunchFlags, detectResumedCopilotSession } from '../src/core/copilot-resume.ts';
import { sendMessage } from '../src/core/deliver.ts';
import { describePeer } from '../src/core/listing.ts';
import { messageMarker } from '../src/core/messages.ts';
import { inboxDir, peerDir, withdrawnDir } from '../src/core/paths.ts';
import { listPeers, readPeer, registerPresence, registerSession } from '../src/core/peers.ts';
import { processCwd } from '../src/core/codex-launch.ts';
import { clearProcessListCache } from '../src/core/proc.ts';
import { fakeAgent, killAndWait, makeSandbox, ROOT, type Sandbox } from './helpers.ts';

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function plant(
  home: string,
  id: string,
  opts: { cwd: string; name?: string; resumeAt?: string; workspaceAt?: Date; eventCwd?: string; inusePid?: number },
): void {
  const dir = path.join(home, 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session.start', timestamp: '2020-01-01T00:00:00.000Z', data: { context: { cwd: opts.cwd } } }),
  ];
  if (opts.resumeAt) {
    lines.push(
      JSON.stringify({
        type: 'session.resume',
        timestamp: opts.resumeAt,
        data: { resumeTime: opts.resumeAt, context: { cwd: opts.eventCwd ?? opts.cwd } },
      }),
    );
  }
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  const yaml = [`id: ${id}`, `cwd: ${opts.cwd}`, opts.name ? `name: ${opts.name}` : ''].filter(Boolean).join('\n') + '\n';
  const workspace = path.join(dir, 'workspace.yaml');
  fs.writeFileSync(workspace, yaml);
  if (opts.workspaceAt) fs.utimesSync(workspace, opts.workspaceAt, opts.workspaceAt);
  if (opts.inusePid) fs.writeFileSync(path.join(dir, `inuse.${opts.inusePid}.lock`), '');
}

describe('resumed copilot is claimed before the first prompt', () => {
  let sb: Sandbox;
  let home: string;
  const cwd = '/work/api';
  const start = Date.parse('2026-10-30T12:00:00.000Z');
  const fresh = '2026-10-30T12:00:18.700Z';
  const freshMtime = new Date('2026-10-30T12:00:20.000Z');
  const oldMtime = new Date('2020-06-01T00:00:00.000Z');

  before(() => {
    sb = makeSandbox();
    home = path.join(sb.home, 'copilot-home');
    process.env.TELEPATHY_HOME = sb.home;
    process.env.COPILOT_HOME = home;
    delete process.env.TELEPATHY_NAME;
  });

  beforeEach(() => {
    fs.rmSync(path.join(home, 'session-state'), { recursive: true, force: true });
  });

  after(() => {
    delete process.env.COPILOT_HOME;
    sb.cleanup();
  });

  const look = (argv: string, dir = home, at = cwd) =>
    detectResumedCopilotSession({ argv, cwd: at, processStartMs: start, copilotHome: dir });

  test('parses --resume=<id>, --resume <id>, and --continue, and ignores a prompt after --', () => {
    assert.equal(copilotLaunchFlags('copilot --resume=sess-keep').resume, 'sess-keep');
    assert.equal(copilotLaunchFlags('node /usr/local/bin/copilot --resume sess-keep --model gpt').resume, 'sess-keep');
    assert.equal(copilotLaunchFlags('copilot --resume="my feature"').resume, 'my feature');
    assert.equal(copilotLaunchFlags('copilot --continue').continue, true);
    assert.equal(copilotLaunchFlags('copilot --resume').resume, undefined);
    assert.equal(copilotLaunchFlags('copilot --resume').resumeFlag, true);
    assert.equal(copilotLaunchFlags('copilot -- --resume=not-a-flag').resumeFlag, false);
    assert.equal(copilotLaunchFlags('copilot --resume=a --continue').conflict, true);
  });

  test('a fresh copilot is not bound, even when another session just resumed', () => {
    plant(home, SESSION, { cwd, resumeAt: fresh, workspaceAt: freshMtime });
    assert.deepEqual(look('copilot'), { state: 'skip' });
  });

  test('--resume=<id> claims that session when the event and workspace.yaml are newer than the process', () => {
    plant(home, SESSION, { cwd, name: 'api work', resumeAt: fresh, workspaceAt: freshMtime });
    assert.deepEqual(look(`copilot --resume=${SESSION}`), { state: 'resume', sessionId: SESSION });
    assert.deepEqual(look(`copilot --resume ${SESSION}`), { state: 'resume', sessionId: SESSION });
    assert.deepEqual(look('copilot --resume="api work"'), { state: 'resume', sessionId: SESSION });
  });

  test('an old session.resume does not count, and an inuse lock is not a signal', () => {
    plant(home, SESSION, { cwd, resumeAt: '2020-01-02T00:00:00.000Z', workspaceAt: oldMtime, inusePid: 4242 });
    fs.appendFileSync(path.join(home, 'session-state', SESSION, 'events.jsonl'), '\n');
    assert.deepEqual(look('copilot --resume=' + SESSION), { state: 'pending' });
    assert.deepEqual(look('copilot --continue'), { state: 'pending' });
  });

  test('a cwd that does not match is not the resumed session', () => {
    plant(home, SESSION, { cwd: '/elsewhere', resumeAt: fresh, workspaceAt: freshMtime, eventCwd: '/elsewhere' });
    assert.deepEqual(look(`copilot --resume=${SESSION}`), { state: 'pending' });
    assert.deepEqual(look('copilot --continue'), { state: 'pending' });
  });

  test('--continue takes the one session for this cwd that was touched after the process started', () => {
    plant(home, OTHER, { cwd, resumeAt: '2020-01-02T00:00:00.000Z', workspaceAt: oldMtime });
    plant(home, SESSION, { cwd, resumeAt: fresh, workspaceAt: freshMtime });
    assert.deepEqual(look('copilot --continue'), { state: 'resume', sessionId: SESSION });
    assert.deepEqual(look('copilot --resume'), { state: 'resume', sessionId: SESSION });
  });

  test('two post-start sessions, or an event and workspace that disagree, are not guessed', () => {
    plant(home, SESSION, { cwd, resumeAt: fresh, workspaceAt: freshMtime });
    plant(home, OTHER, { cwd, resumeAt: fresh, workspaceAt: freshMtime });
    assert.deepEqual(look('copilot --continue'), { state: 'skip' });
    fs.rmSync(path.join(home, 'session-state', OTHER), { recursive: true, force: true });
    plant(home, OTHER, { cwd: '/elsewhere', resumeAt: fresh, workspaceAt: freshMtime, eventCwd: '/elsewhere' });
    // SESSION is the only cwd match, so this is still that resume.
    assert.deepEqual(look('copilot --continue'), { state: 'resume', sessionId: SESSION });
    fs.rmSync(path.join(home, 'session-state'), { recursive: true, force: true });
    plant(home, SESSION, { cwd, resumeAt: fresh, workspaceAt: oldMtime });
    plant(home, OTHER, { cwd, resumeAt: '2020-01-02T00:00:00.000Z', workspaceAt: freshMtime });
    assert.deepEqual(look(`copilot --resume=${SESSION}`), { state: 'skip' });
    assert.deepEqual(look('copilot --continue'), { state: 'skip' });
  });

  test('a resume token that matches two sessions is not resolved by the event', () => {
    const prefix = '11111111';
    plant(home, SESSION, { cwd, resumeAt: fresh, workspaceAt: freshMtime });
    plant(home, '11111111-9999-4333-8444-555555555555', { cwd: '/elsewhere', resumeAt: '2020-01-02T00:00:00.000Z', workspaceAt: oldMtime });
    assert.equal(SESSION.startsWith(prefix), true);
    assert.deepEqual(look(`copilot --resume=${prefix}`), { state: 'skip' });
  });

  test('a unique prefix still claims when the signals agree', () => {
    plant(home, SESSION, { cwd, resumeAt: fresh, workspaceAt: freshMtime });
    assert.deepEqual(look('copilot --resume=11111111-2222'), { state: 'resume', sessionId: SESSION });
  });

  test('claim keeps the previous name, and the sessionStart hook binds the same id once', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cwd-'));
    const script = path.join(work, 'sleep.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1 << 30);\n');
    const first = spawn(process.execPath, [script], { cwd: work, stdio: 'ignore' });
    const second = spawn(process.execPath, [script, '--resume', SESSION], { cwd: work, stdio: 'ignore' });
    try {
      registerSession('copilot', first.pid as number, { sessionId: SESSION, cwd: work, source: 'hook' });
      const id = `copilot-${SESSION}`;
      const name = readPeer(id)?.name;
      assert.ok(name);
      await killAndWait(first);
      clearProcessListCache();
      const seen = processCwd(second.pid as number) ?? work;
      const at = new Date(Date.now() + 5000).toISOString();
      plant(home, SESSION, { cwd: seen, resumeAt: at, workspaceAt: new Date(Date.now() + 5000) });
      const claimed = claimResumedCopilot(second.pid as number);
      assert.deepEqual(claimed, { state: 'claimed', sessionId: SESSION });
      assert.deepEqual(claimResumedCopilot(second.pid as number), { state: 'claimed', sessionId: SESSION });
      const peer = readPeer(id);
      assert.equal(peer?.name, name);
      assert.equal(peer?.sessionId, SESSION);
      assert.equal(peer?.pid, second.pid);
      assert.deepEqual(
        listPeers()
          .filter((p) => p.agent === 'copilot')
          .map((p) => p.id),
        [id],
      );
      const owners = JSON.parse(fs.readFileSync(path.join(peerDir(id), 'owners.json'), 'utf8')) as { pid: number }[];
      assert.deepEqual(owners.map((owner) => owner.pid), [second.pid]);
      const link = JSON.parse(fs.readFileSync(path.join(peerDir(`copilot-${second.pid}`), 'link.json'), 'utf8')) as { id?: string };
      assert.equal(link.id, id);

      const hook = spawnSync(process.execPath, [path.join(ROOT, 'src', 'hook.ts'), '--agent', 'copilot', 'session-start', 'sessionStart'], {
        input: JSON.stringify({ sessionId: SESSION, cwd: seen }),
        env: { ...process.env, TELEPATHY_HOME: sb.home, COPILOT_HOME: home, TELEPATHY_AGENT_PID: String(second.pid) },
        encoding: 'utf8',
      });
      assert.equal(hook.status, 0, hook.stderr);
      const after = JSON.parse(fs.readFileSync(path.join(peerDir(id), 'owners.json'), 'utf8')) as { pid: number }[];
      assert.deepEqual(after.map((owner) => owner.pid), [second.pid]);
      const rebound = readPeer(id);
      assert.equal(rebound?.name, name);
      assert.equal(rebound?.sessionId, SESSION);
      assert.equal(rebound?.hookRan, true);
      assert.equal(rebound?.duplicate, false);
    } finally {
      first.kill('SIGKILL');
      second.kill('SIGKILL');
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test('a message sent before the first prompt confirms from the transcript, or fails and is withdrawn', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cwd-'));
    const script = path.join(work, 'sleep.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1 << 30);\n');
    const proc = spawn(process.execPath, [script, '--continue'], { cwd: work, stdio: 'ignore' });
    const prevWait = process.env.TELEPATHY_CONFIRM_WAIT;
    const prevAbort = process.env.TELEPATHY_CONFIRM_ABORT_MS;
    const prevGrace = process.env.TELEPATHY_CONFIRM_GRACE_MS;
    const prevPoll = process.env.TELEPATHY_CONFIRM_POLL_MS;
    process.env.TELEPATHY_CONFIRM_WAIT = '1';
    process.env.TELEPATHY_CONFIRM_ABORT_MS = '400';
    process.env.TELEPATHY_CONFIRM_GRACE_MS = '150';
    process.env.TELEPATHY_CONFIRM_POLL_MS = '20';
    try {
      clearProcessListCache();
      const seen = processCwd(proc.pid as number) ?? work;
      const at = new Date(Date.now() + 5000).toISOString();
      plant(home, SESSION, { cwd: seen, resumeAt: at, workspaceAt: new Date(Date.now() + 5000) });
      assert.equal(claimResumedCopilot(proc.pid as number).state, 'claimed');
      registerSession('claude', process.pid, { sessionId: 'sender-copilot', cwd: '/work/sender', source: 'hook' });
      const self = readPeer('claude-sender-copilot');
      assert.ok(self);
      const id = `copilot-${SESSION}`;
      const missed = await sendMessage(self, readPeer(id)?.address ?? '', 'before the prompt');
      assert.equal(missed.ok, false);
      if (missed.ok) return;
      assert.match(missed.error, /did not show telepathy-id:/);
      assert.equal(fs.readdirSync(inboxDir(id)).length, 0);
      assert.equal(fs.readdirSync(withdrawnDir(id)).length, 1);

      const log = path.join(home, 'session-state', SESSION, 'events.jsonl');
      const pending = sendMessage(self, readPeer(id)?.address ?? '', 'lands on the next turn');
      await new Promise((resolve) => setTimeout(resolve, 40));
      const inbox = fs.readdirSync(inboxDir(id)).find((name) => name.endsWith('.json'));
      assert.ok(inbox);
      const messageId = inbox.slice(0, -'.json'.length);
      fs.appendFileSync(log, JSON.stringify({ type: 'user.message', data: { content: messageMarker(messageId) } }) + '\n');
      const hit = await pending;
      assert.equal(hit.ok, true, hit.ok ? '' : hit.error);
      assert.match(hit.ok ? hit.status : '', new RegExp(messageMarker(messageId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      proc.kill('SIGKILL');
      fs.rmSync(work, { recursive: true, force: true });
      if (prevWait === undefined) delete process.env.TELEPATHY_CONFIRM_WAIT;
      else process.env.TELEPATHY_CONFIRM_WAIT = prevWait;
      if (prevAbort === undefined) delete process.env.TELEPATHY_CONFIRM_ABORT_MS;
      else process.env.TELEPATHY_CONFIRM_ABORT_MS = prevAbort;
      if (prevGrace === undefined) delete process.env.TELEPATHY_CONFIRM_GRACE_MS;
      else process.env.TELEPATHY_CONFIRM_GRACE_MS = prevGrace;
      if (prevPoll === undefined) delete process.env.TELEPATHY_CONFIRM_POLL_MS;
      else process.env.TELEPATHY_CONFIRM_POLL_MS = prevPoll;
    }
  });
});

describe('plain copilot before the first prompt', () => {
  let sb: Sandbox;
  const agents: ReturnType<typeof fakeAgent>[] = [];

  before(() => {
    sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.TELEPATHY_CONFIRM_WAIT = '0';
    delete process.env.TELEPATHY_NAME;
  });

  after(async () => {
    await Promise.all(agents.map((agent) => killAndWait(agent)));
    sb.cleanup();
  });

  test('the row says the hooks deliver at the next turn', async () => {
    const proc = fakeAgent();
    agents.push(proc);
    registerPresence('copilot', proc.pid, { cwd: '/work/api' });
    const peer = readPeer(`copilot-${proc.pid}`);
    assert.ok(peer);
    assert.equal(peer.hookRan, false);
    assert.match(describePeer(peer), /sees messages at its next turn/);
    assert.doesNotMatch(describePeer(peer), /read_messages/);
    registerSession('claude', process.pid, { sessionId: 'sender-row', cwd: '/work/sender', source: 'hook' });
    const self = readPeer('claude-sender-row');
    assert.ok(self);
    const sent = await sendMessage(self, peer.address, 'before the first prompt');
    assert.equal(sent.ok, true, sent.ok ? '' : sent.error);
    assert.match(sent.ok ? sent.status : '', /next turn/);
    assert.doesNotMatch(sent.ok ? sent.status : '', /read_messages/);
  });
});
