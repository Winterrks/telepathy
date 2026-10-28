import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { sendMessage } from '../src/core/deliver.ts';
import { messageMarker } from '../src/core/messages.ts';
import { inboxDir, withdrawnDir } from '../src/core/paths.ts';
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
});
