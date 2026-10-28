import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { confirmAbortMs, confirmDelivery, confirmGraceMs } from '../src/core/confirm.ts';
import { sendMessage } from '../src/core/deliver.ts';
import { messageMarker } from '../src/core/messages.ts';
import { archiveDir, inboxDir, withdrawnDir } from '../src/core/paths.ts';
import { readPeer, registerPresence, registerSession } from '../src/core/peers.ts';
import { fakeAgent, killAndWait, makeSandbox, type Sandbox, waitFor } from './helpers.ts';

describe('transcript confirmation', () => {
  let sb: Sandbox;
  const agents: ReturnType<typeof fakeAgent>[] = [];
  let n = 0;

  before(() => {
    sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CLAUDE_CONFIG_DIR = sb.env.CLAUDE_CONFIG_DIR;
    process.env.CODEX_HOME = sb.codexHome;
  });

  after(async () => {
    process.env.TELEPATHY_CONFIRM_WAIT = '0';
    delete process.env.TELEPATHY_CONFIRM_ABORT_MS;
    delete process.env.TELEPATHY_CONFIRM_GRACE_MS;
    delete process.env.TELEPATHY_CONFIRM_POLL_MS;
    delete process.env.TELEPATHY_TRANSCRIPT_DIR;
    await Promise.all(agents.map((agent) => killAndWait(agent)));
    sb.cleanup();
  });

  const arm = (abort: string, grace: string) => {
    process.env.TELEPATHY_CONFIRM_WAIT = '1';
    process.env.TELEPATHY_CONFIRM_ABORT_MS = abort;
    process.env.TELEPATHY_CONFIRM_GRACE_MS = grace;
    process.env.TELEPATHY_CONFIRM_POLL_MS = '20';
    const dir = path.join(sb.home, `tx-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    process.env.TELEPATHY_TRANSCRIPT_DIR = dir;
    return dir;
  };

  const pair = () => {
    const fromProc = fakeAgent();
    const toProc = fakeAgent();
    agents.push(fromProc, toProc);
    const key = `g${n++}`;
    registerPresence('codex', fromProc.pid, { cwd: '/w/from' }, 'codex-thread-tx');
    registerSession('codex', fromProc.pid, { sessionId: 'thread-tx', cwd: '/w/from', source: 'hook', codexHome: sb.codexHome });
    registerPresence('gemini', toProc.pid, { cwd: '/w/docs' }, `gemini-${key}`);
    registerSession('gemini', toProc.pid, { sessionId: key, cwd: '/w/docs', source: 'hook' });
    const from = readPeer('codex-thread-tx');
    const to = readPeer(`gemini-${key}`);
    assert.ok(from && to);
    return { from, to };
  };

  test('the default wait is 105s plus 10s, under Claude\'s background move', () => {
    delete process.env.TELEPATHY_CONFIRM_ABORT_MS;
    delete process.env.TELEPATHY_CONFIRM_GRACE_MS;
    assert.equal(confirmAbortMs(), 105_000);
    assert.equal(confirmGraceMs(), 10_000);
    assert.ok(confirmAbortMs() + confirmGraceMs() < 120_000);
  });

  test('success is the marker in the transcript', async () => {
    const dir = arm('2000', '200');
    const { from, to } = pair();
    const pending = sendMessage(from, to.id, 'hello confirm');
    const file = await waitFor(() => {
      try {
        return fs.readdirSync(inboxDir(to.id))[0];
      } catch {
        return undefined;
      }
    });
    const msg = JSON.parse(fs.readFileSync(path.join(inboxDir(to.id), file), 'utf8')) as { id: string };
    fs.writeFileSync(path.join(dir, 'session.jsonl'), `${messageMarker(msg.id)}\n`);
    const result = await pending;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.status, new RegExp(`The transcript shows ${messageMarker(msg.id)}`));
  });

  test('a timeout withdraws the inbox and is not success', async () => {
    arm('200', '80');
    const { from, to } = pair();
    const result = await sendMessage(from, to.id, 'never confirmed');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /^Message failed:/);
    assert.match(result.error, /unconfirmed/);
    assert.equal(fs.existsSync(inboxDir(to.id)) && fs.readdirSync(inboxDir(to.id)).length > 0, false);
    assert.equal(fs.readdirSync(withdrawnDir(to.id)).length, 1);
  });

  test('a marker during the grace period is still success', async () => {
    const dir = arm('180', '2000');
    const { from, to } = pair();
    const pending = sendMessage(from, to.id, 'late but delivered');
    const name = await waitFor(() => {
      try {
        return fs.readdirSync(withdrawnDir(to.id))[0];
      } catch {
        return undefined;
      }
    }, 4000);
    const msg = JSON.parse(fs.readFileSync(path.join(withdrawnDir(to.id), name), 'utf8')) as { id: string };
    fs.writeFileSync(path.join(dir, 'late.jsonl'), `${messageMarker(msg.id)}\n`);
    const result = await pending;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.status, /The transcript shows telepathy-id:/);
    assert.equal(fs.existsSync(path.join(withdrawnDir(to.id), name)), false);
    assert.equal(fs.existsSync(path.join(archiveDir(to.id), name)), true);
  });

  test('a claim without the marker is not success', async () => {
    arm('500', '150');
    const { from, to } = pair();
    const pending = sendMessage(from, to.id, 'claimed only');
    const file = await waitFor(() => {
      try {
        return fs.readdirSync(inboxDir(to.id))[0];
      } catch {
        return undefined;
      }
    });
    const archive = path.join(sb.home, 'peers', to.id, 'archive');
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(path.join(inboxDir(to.id), file), path.join(archive, file));
    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /^Message failed:/);
    assert.match(result.error, /already claimed/);
  });

  test('a session that is not running stores nothing', async () => {
    arm('5000', '5000');
    const fromProc = fakeAgent();
    const toProc = fakeAgent();
    agents.push(fromProc, toProc);
    const key = `closed${n++}`;
    registerPresence('codex', fromProc.pid, { cwd: '/w/from' }, 'codex-thread-closed');
    registerSession('codex', fromProc.pid, { sessionId: 'thread-closed', cwd: '/w/from', source: 'hook', codexHome: sb.codexHome });
    registerPresence('opencode', toProc.pid, { cwd: '/w/ui' }, `opencode-${key}`);
    registerSession('opencode', toProc.pid, { sessionId: key, cwd: '/w/ui', source: 'plugin' });
    const from = readPeer('codex-thread-closed');
    const to = readPeer(`opencode-${key}`);
    assert.ok(from && to);
    await killAndWait(toProc);
    const result = await sendMessage(from, to.address, 'while you are closed');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /^Message failed:/);
    assert.match(result.error, /is offline \(session not running\), so nothing was stored\./);
    assert.equal(fs.existsSync(inboxDir(to.id)) ? fs.readdirSync(inboxDir(to.id)).length : 0, 0);
  });

  test('mail written while the session was live stays when it goes offline during the wait', async () => {
    arm('5000', '5000');
    const fromProc = fakeAgent();
    const toProc = fakeAgent();
    agents.push(fromProc, toProc);
    registerPresence('codex', fromProc.pid, { cwd: '/w/from' }, 'codex-thread-inflight');
    registerSession('codex', fromProc.pid, { sessionId: 'thread-inflight', cwd: '/w/from', source: 'hook', codexHome: sb.codexHome });
    registerPresence('claude', toProc.pid, { cwd: '/w/live' }, 'claude-live');
    registerSession('claude', toProc.pid, { sessionId: 'live', cwd: '/w/live', source: 'hook' });
    const from = readPeer('codex-thread-inflight');
    const to = readPeer('claude-live');
    assert.ok(from && to);
    const pending = sendMessage(from, to.id, 'already handed over');
    const file = await waitFor(() => {
      try {
        return fs.readdirSync(inboxDir(to.id))[0];
      } catch {
        return undefined;
      }
    });
    await killAndWait(toProc);
    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /^Message failed:/);
    assert.match(result.error, /A copy already in its inbox stays/);
    assert.equal(fs.existsSync(path.join(inboxDir(to.id), file)), true);
  });

  test('a held socket result is not a clean failure, and an interrupt withdraw does not say the inbox stays', async () => {
    arm('120', '40');
    const { from, to } = pair();
    const held = await confirmDelivery(
      to,
      { id: 'm-000000002-aabbcc', from: from, to, body: 'held copy', sentAt: new Date().toISOString() },
      'Message not confirmed for gemini:x. Claude reported the inbox-socket post as held. That copy cannot be recalled and may still be delivered if the hold is released. The inbox copy was withdrawn so a later turn does not also show it.',
    );
    assert.equal(held.confirmed, false);
    assert.match(held.status, /cannot be recalled/);
    assert.doesNotMatch(held.status, /^Message failed:/);

    const interruptedMessage = {
      id: 'm-000000003-bbccdd',
      from,
      to,
      body: 'interrupted',
      sentAt: new Date().toISOString(),
    };
    fs.mkdirSync(inboxDir(to.id), { recursive: true });
    fs.writeFileSync(path.join(inboxDir(to.id), `${interruptedMessage.id}.json`), JSON.stringify(interruptedMessage));
    const interrupted = await confirmDelivery(
      to,
      { id: 'm-000000003-bbccdd', from: from, to, body: 'interrupted', sentAt: new Date().toISOString() },
      'Message stored for gemini:x. Codex was interrupted, so its queue will not deliver this. It stays in the inbox for the next prompt, or until the session calls read_messages.',
    );
    assert.equal(interrupted.confirmed, false);
    assert.match(interrupted.status, /^Message failed:/);
    assert.match(interrupted.status, /The inbox copy was withdrawn, so the next prompt will not see it/);
    assert.doesNotMatch(interrupted.status, /It stays in the inbox/);
  });

  test('a hold that posts nothing fails by saying the receiver is holding, not that it has no listener', async () => {
    arm('80', '40');
    const fromProc = fakeAgent();
    const toProc = fakeAgent();
    agents.push(fromProc, toProc);
    registerPresence('codex', fromProc.pid, { cwd: '/w/from' }, 'codex-thread-hold');
    registerSession('codex', fromProc.pid, { sessionId: 'thread-hold', cwd: '/w/from', source: 'hook', codexHome: sb.codexHome });
    registerPresence('claude', toProc.pid, { cwd: '/w/held' }, 'claude-held');
    registerSession('claude', toProc.pid, { sessionId: 'held', cwd: '/w/held', source: 'hook' });
    fs.mkdirSync(sb.env.CLAUDE_CONFIG_DIR, { recursive: true });
    const settings = path.join(sb.env.CLAUDE_CONFIG_DIR, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'hold' }));
    const from = readPeer('codex-thread-hold');
    const to = readPeer('claude-held');
    assert.ok(from && to);
    const result = await sendMessage(from, to.id, 'while you hold');
    fs.rmSync(settings, { force: true });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Nothing was posted to .+: that session is holding peer messages \(crossSessionInbound is hold\)\. The inbox copy was withdrawn\./);
    assert.doesNotMatch(result.error, /Message stored/);
    assert.doesNotMatch(result.error, /\bdelivered\b/i);
    assert.doesNotMatch(result.error, /no listener/);
    assert.doesNotMatch(result.error, /It has no listener/);
  });

  test('a failed confirm does not call an unconfirmed handoff delivered', async () => {
    arm('40', '20');
    const { from, to } = pair();
    const result = await confirmDelivery(
      to,
      { id: 'm-000000004-ccddee', from, to, body: 'listener only', sentAt: new Date().toISOString() },
      'Message delivered to opencode:app [opencode-ses_x].',
    );
    assert.equal(result.confirmed, false);
    assert.match(result.status, /Strongest signal: Unconfirmed handoff to opencode:app \[opencode-ses_x\]\./);
    assert.doesNotMatch(result.status, /\bdelivered\b/i);
  });
});
