import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureAgyApiKey } from '../src/cli/agy-auth.ts';
import { installAll } from '../src/cli/install.ts';
import { statusReport } from '../src/cli/status.ts';
import {
  ANTIGRAVITY_SIDECAR_ID,
  antigravitySurface,
  enableAntigravitySidecar,
  expandHomePath,
} from '../src/core/antigravity.ts';
import { inspectTranscript } from '../src/core/confirm.ts';
import { messageMarker, withdrawEverywhere, writeToInbox, type Message } from '../src/core/messages.ts';
import { archiveDir, inboxDir, withdrawnDir } from '../src/core/paths.ts';
import { readPeer, readSession, registerListener, sessionPeerId } from '../src/core/peers.ts';
import { agentApiInvocation, nextSidecarDelayMs, pollSidecar } from '../src/sidecar.ts';
import { ROOT, fakeAgent, killAndWait, makeSandbox, runHook, type Sandbox } from './helpers.ts';

const CONV = '11111111-2222-4333-8444-555555555555';
const FORK = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const APP = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

describe('antigravity plugin', () => {
  test('the plugin manifest, hooks, MCP config, sidecar, and skill are the native shape', () => {
    const dir = path.join(ROOT, 'antigravity');
    const plugin = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as {
      name: string;
      description: string;
      version?: string;
    };
    assert.equal(plugin.name, 'telepathy');
    assert.match(plugin.name, /^[a-zA-Z0-9-_]+$/);
    assert.equal(plugin.version, undefined);
    assert.match(plugin.description, /App, CLI, and IDE/);

    const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8')) as {
      telepathy: Record<string, { command: string }[]>;
    };
    for (const event of ['SessionStart', 'PreInvocation', 'Stop'] as const) {
      const command = hooks.telepathy[event]?.[0]?.command ?? '';
      assert.match(command, /node \.\/dist\/hook\.mjs/);
      assert.doesNotMatch(command, /PLUGIN_ROOT/);
      assert.match(command, /--agent antigravity/);
    }
    assert.match(hooks.telepathy.SessionStart[0].command, /session-start/);
    assert.match(hooks.telepathy.PreInvocation[0].command, /inbox PreInvocation/);
    assert.match(hooks.telepathy.Stop[0].command, /turn-end/);

    const mcp = fs.readFileSync(path.join(dir, 'mcp_config.json'), 'utf8');
    assert.match(mcp, /\$\{PLUGIN_ROOT\}\/dist\/server\.mjs/);
    assert.doesNotMatch(mcp, /TELEPATHY_/);

    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'sidecars', 'telepathy-wake', 'sidecar.json'), 'utf8')) as {
      command: string;
      args: string[];
      restart_policy: string;
    };
    assert.equal(sidecar.command, 'node');
    assert.deepEqual(sidecar.args, ['../../dist/sidecar.mjs']);
    assert.equal(sidecar.restart_policy, 'on-failure');

    const skill = fs.readFileSync(path.join(ROOT, 'plugin', 'skills', 'using-telepathy', 'SKILL.md'), 'utf8');
    assert.match(skill, /Antigravity/);
    assert.doesNotMatch(skill, /Gemini CLI/);
    assert.equal(fs.existsSync(path.join(ROOT, 'gemini-extension.json')), false);
    assert.equal(fs.existsSync(path.join(ROOT, 'hooks', 'hooks.json')), false);
  });

  test('the transcript directory names the surface, and a tilde path expands', () => {
    assert.equal(antigravitySurface('/home/u/.gemini/antigravity-cli/brain/x/transcript.jsonl'), 'cli');
    assert.equal(antigravitySurface('/home/u/.gemini/antigravity-ide/brain/x/transcript.jsonl'), 'ide');
    assert.equal(antigravitySurface('/home/u/.gemini/antigravity/brain/x/transcript.jsonl'), 'app');
    assert.equal(antigravitySurface(undefined), undefined);
    const home = process.env.HOME || '/home/u';
    assert.equal(expandHomePath('~/brain/x'), path.join(home, 'brain/x'));
  });
});

describe('antigravity sessions', () => {
  let sb: Sandbox;
  const agents: ReturnType<typeof fakeAgent>[] = [];
  const saved: Record<string, string | undefined> = {};

  before(() => {
    sb = makeSandbox();
    for (const key of ['HOME', 'TELEPATHY_HOME', 'GEMINI_API_KEY', 'TELEPATHY_LATEST_VERSION', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
      saved[key] = process.env[key];
    }
    process.env.HOME = sb.env.HOME;
    process.env.TELEPATHY_HOME = sb.home;
    process.env.XDG_CACHE_HOME = sb.env.XDG_CACHE_HOME;
    process.env.XDG_DATA_HOME = sb.env.XDG_DATA_HOME;
    process.env.TELEPATHY_LATEST_VERSION = '0.9.0';
    delete process.env.GEMINI_API_KEY;
  });

  after(async () => {
    for (const agent of agents) await killAndWait(agent);
    sb.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const spawn = () => {
    const agent = fakeAgent();
    agents.push(agent);
    return agent;
  };

  const transcript = (surface: 'antigravity' | 'antigravity-cli' | 'antigravity-ide', id: string) =>
    `~/.gemini/${surface}/brain/${id}/.system_generated/logs/transcript.jsonl`;

  const payload = (id: string, surface: 'antigravity' | 'antigravity-cli' | 'antigravity-ide', cwd: string) => ({
    conversationId: id,
    cwd,
    transcriptPath: transcript(surface, id),
    terminationReason: 'model_stop',
    fullyIdle: true,
  });

  function plant(peerId: string, body: string): Message {
    const peer = readPeer(peerId);
    assert.ok(peer);
    const msg: Message = {
      id: `m-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`,
      from: { id: 'claude-1', agent: 'claude', name: 'web', address: 'claude:web' },
      to: { id: peer.id, agent: 'antigravity', name: peer.name, address: peer.address },
      body,
      sentAt: new Date().toISOString(),
    };
    writeToInbox(msg);
    return msg;
  }

  test('the same conversation id keeps the peer and its name; a fork is a new peer', () => {
    const cwd = path.join(sb.env.HOME as string, 'docs');
    const first = spawn();
    const started = runHook(sb, 'antigravity', first.pid, 'session-start', payload(CONV, 'antigravity-cli', cwd));
    const guide = JSON.parse(started.stdout) as { injectSteps: { systemMessage: { systemMessage: string } }[] };
    assert.match(guide.injectSteps[0].systemMessage.systemMessage, /another AI agent/);
    const id = sessionPeerId('antigravity', first.pid, CONV);
    const original = readPeer(id);
    assert.ok(original);
    const session = readSession(id);
    assert.equal(session?.surface, 'cli');
    assert.equal(session?.transcriptPath, expandHomePath(transcript('antigravity-cli', CONV)));

    const resumed = spawn();
    runHook(sb, 'antigravity', resumed.pid, 'session-start', payload(CONV, 'antigravity-cli', path.join(sb.env.HOME as string, 'other')));
    const again = readPeer(id);
    assert.equal(again?.id, original.id);
    assert.equal(again?.name, original.name);
    assert.equal(readSession(id)?.surface, 'cli');

    runHook(sb, 'antigravity', resumed.pid, 'inbox', payload(CONV, 'antigravity-cli', cwd), 'PreInvocation');
    const omitted = runHook(sb, 'antigravity', resumed.pid, 'inbox', { conversationId: CONV, cwd }, 'PreInvocation');
    assert.equal(omitted.stdout, '');
    assert.equal(readSession(id)?.transcriptPath, session?.transcriptPath);

    const forkId = sessionPeerId('antigravity', resumed.pid, FORK);
    runHook(sb, 'antigravity', resumed.pid, 'session-start', payload(FORK, 'antigravity-ide', cwd));
    assert.notEqual(forkId, id);
    assert.notEqual(readPeer(forkId)?.name, original.name);
    assert.equal(readSession(forkId)?.surface, 'ide');
    assert.ok(readPeer(id));
  });

  test('PreInvocation injects and Stop continues, and an empty inbox prints nothing', () => {
    const cwd = path.join(sb.env.HOME as string, 'docs');
    const turn = '12121212-3434-4545-8686-787878787878';
    const agent = spawn();
    runHook(sb, 'antigravity', agent.pid, 'session-start', payload(turn, 'antigravity-cli', cwd));
    const id = sessionPeerId('antigravity', agent.pid, turn);
    const msg = plant(id, 'ping-from-codex');
    const injected = runHook(sb, 'antigravity', agent.pid, 'inbox', payload(turn, 'antigravity-cli', cwd), 'PreInvocation');
    const step = JSON.parse(injected.stdout) as { injectSteps: { userMessage: string }[] };
    assert.match(step.injectSteps[0].userMessage, new RegExp(messageMarker(msg.id)));
    assert.match(step.injectSteps[0].userMessage, /ping-from-codex/);
    assert.equal(fs.existsSync(path.join(inboxDir(id), `${msg.id}.json`)), false);

    const next = plant(id, 'keep-going');
    const continued = runHook(sb, 'antigravity', agent.pid, 'turn-end', payload(turn, 'antigravity-cli', cwd));
    const stop = JSON.parse(continued.stdout) as { decision: string; reason: string };
    assert.equal(stop.decision, 'continue');
    assert.match(stop.reason, /keep-going/);
    assert.match(stop.reason, new RegExp(messageMarker(next.id)));

    const quiet = runHook(sb, 'antigravity', agent.pid, 'turn-end', payload(turn, 'antigravity-cli', cwd));
    assert.equal(quiet.stdout, '');
  });

  test('a live sidecar listener keeps the hooks from injecting', () => {
    const cwd = path.join(sb.env.HOME as string, 'docs');
    const held = '23232323-4545-4676-8787-898989898989';
    const agent = spawn();
    runHook(sb, 'antigravity', agent.pid, 'session-start', payload(held, 'antigravity-cli', cwd));
    const id = sessionPeerId('antigravity', agent.pid, held);
    registerListener('antigravity', agent.pid, id);
    const msg = plant(id, 'held-for-the-sidecar');
    const injected = runHook(sb, 'antigravity', agent.pid, 'inbox', payload(held, 'antigravity-cli', cwd), 'PreInvocation');
    assert.equal(injected.stdout, '');
    assert.equal(fs.existsSync(path.join(inboxDir(id), `${msg.id}.json`)), true);
  });

  test('the App sidecar calls agentapi and puts the inbox back when that fails', async () => {
    const cwd = path.join(sb.env.HOME as string, 'app');
    const appProc = spawn();
    const cliProc = spawn();
    runHook(sb, 'antigravity', appProc.pid, 'session-start', payload(APP, 'antigravity', cwd));
    const cliId = '99999999-8888-4777-8666-555555555555';
    runHook(sb, 'antigravity', cliProc.pid, 'session-start', payload(cliId, 'antigravity-cli', cwd));
    const appPeer = sessionPeerId('antigravity', appProc.pid, APP);
    const cliPeer = sessionPeerId('antigravity', cliProc.pid, cliId);
    const msg = plant(appPeer, 'wake-the-app');
    plant(cliPeer, 'not-the-app');

    const bin = path.join(path.dirname(sb.home), 'agentapi-bin');
    const log = path.join(path.dirname(sb.home), 'agentapi.log');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'agentapi'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.AGENTAPI_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.AGENTAPI_CODE || 0));
`,
    );
    fs.chmodSync(path.join(bin, 'agentapi'), 0o755);
    const envFor = (code: string) => ({
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      AGENTAPI_LOG: log,
      AGENTAPI_CODE: code,
    });

    assert.deepEqual(await pollSidecar(envFor('1')), { sent: 0, failed: true });
    assert.equal(fs.existsSync(path.join(inboxDir(appPeer), `${msg.id}.json`)), true, 'a failed send puts the inbox back');

    assert.deepEqual(await pollSidecar(envFor('0')), { sent: 1, failed: false });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    assert.equal(lines.length, 2);
    const sent = lines[1];
    assert.deepEqual(sent.slice(0, 2), ['send-message', APP]);
    assert.match(sent[2], new RegExp(messageMarker(msg.id)));
    assert.match(sent[2], /wake-the-app/);
    assert.equal(fs.existsSync(path.join(archiveDir(appPeer), `${msg.id}.json`)), true);
    assert.equal(fs.readdirSync(inboxDir(cliPeer)).length, 1);

    const languageServer = path.join(bin, 'language_server');
    fs.copyFileSync(path.join(bin, 'agentapi'), languageServer);
    plant(appPeer, 'wake-again');
    const customEnv = {
      ...envFor('0'),
      PATH: path.dirname(process.execPath),
      ANTIGRAVITY_AGENTAPI_EXE: languageServer,
    };
    assert.deepEqual(await pollSidecar(customEnv), { sent: 1, failed: false });
    const after = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    assert.equal(after.length, 3);
    assert.deepEqual(after[2].slice(0, 2), ['agentapi', 'send-message']);

    const wrapper = path.join(bin, 'agentapi');
    plant(appPeer, 'wake-via-wrapper');
    const wrapperEnv = { ...envFor('0'), PATH: path.dirname(process.execPath), ANTIGRAVITY_AGENTAPI_EXE: wrapper };
    assert.deepEqual(await pollSidecar(wrapperEnv), { sent: 1, failed: false });
    const wrapped = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    assert.equal(wrapped[3][0], 'send-message');
    assert.notEqual(wrapped[3][0], 'agentapi');
  });

  test('a failing sidecar exec backs off instead of retrying every second', () => {
    assert.equal(nextSidecarDelayMs(1_000, false), 1_000);
    assert.equal(nextSidecarDelayMs(1_000, true), 2_000);
    assert.equal(nextSidecarDelayMs(2_000, true), 4_000);
    assert.equal(nextSidecarDelayMs(16_000, true), 30_000);
    assert.equal(nextSidecarDelayMs(30_000, true), 30_000);
    assert.equal(nextSidecarDelayMs(30_000, false), 1_000);
    assert.deepEqual(agentApiInvocation({}), { command: 'agentapi', args: ['send-message'] });
    assert.deepEqual(agentApiInvocation({ ANTIGRAVITY_AGENTAPI_EXE: '${ANTIGRAVITY_AGENTAPI_EXE}' }), {
      command: 'agentapi',
      args: ['send-message'],
    });
    assert.deepEqual(agentApiInvocation({ ANTIGRAVITY_AGENTAPI_EXE: '/Applications/Antigravity.app/language_server' }), {
      command: '/Applications/Antigravity.app/language_server',
      args: ['agentapi', 'send-message'],
    });
    assert.deepEqual(agentApiInvocation({ ANTIGRAVITY_AGENTAPI_EXE: '/Users/me/.gemini/antigravity/bin/agentapi' }), {
      command: '/Users/me/.gemini/antigravity/bin/agentapi',
      args: ['send-message'],
    });
  });

  test('a withdrawn or expired message is not sent, even after agentapi starts working', async () => {
    const cwd = path.join(sb.env.HOME as string, 'late');
    const appProc = spawn();
    const other = spawn();
    const otherId = 'dddddddd-eeee-4fff-8999-aaaaaaaaaaaa';
    runHook(sb, 'antigravity', appProc.pid, 'session-start', payload(APP, 'antigravity', cwd));
    runHook(sb, 'antigravity', other.pid, 'session-start', payload(otherId, 'antigravity', cwd));
    const appPeer = sessionPeerId('antigravity', appProc.pid, APP);
    const otherPeer = sessionPeerId('antigravity', other.pid, otherId);
    const msg = plant(appPeer, 'do-not-deliver-late');
    const held = path.join(path.dirname(sb.home), 'agentapi-hold');
    const log = path.join(path.dirname(sb.home), 'agentapi-late.log');
    const bin = path.join(path.dirname(sb.home), 'agentapi-late-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'agentapi'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.AGENTAPI_LOG, JSON.stringify(argv) + '\\n');
if (process.env.AGENTAPI_HANG_FOR && argv.includes(process.env.AGENTAPI_HANG_FOR)) {
  const start = Date.now();
  const timer = setInterval(() => { if (Date.now() - start > 3000) { clearInterval(timer); process.exit(2); } }, 50);
} else if (process.env.AGENTAPI_HOLD) {
  const start = Date.now();
  while (!fs.existsSync(process.env.AGENTAPI_HOLD)) {
    if (Date.now() - start > 8000) process.exit(3);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  process.exit(Number(process.env.AGENTAPI_CODE || 0));
} else process.exit(Number(process.env.AGENTAPI_CODE || 0));
`,
    );
    fs.chmodSync(path.join(bin, 'agentapi'), 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      AGENTAPI_LOG: log,
      AGENTAPI_HOLD: held,
      TELEPATHY_AGENTAPI_TIMEOUT_MS: '5000',
    };
    const pending = pollSidecar(env);
    const started = Date.now();
    while (!fs.existsSync(log) && Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    withdrawEverywhere(appPeer, msg.id);
    const first = await pending;
    assert.equal(first.sent, 0);
    assert.equal(fs.existsSync(path.join(withdrawnDir(appPeer), `${msg.id}.json`)), true);
    assert.equal(fs.existsSync(path.join(inboxDir(appPeer), `${msg.id}.json`)), false);
    const before = fs.readFileSync(log, 'utf8').trim().split('\n').length;
    fs.writeFileSync(held, 'go');
    const again = await pollSidecar({ ...env, AGENTAPI_CODE: '0', AGENTAPI_HOLD: '' });
    assert.equal(again.sent, 0);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, before);

    const late = plant(appPeer, 'already-expired');
    const expired = { ...late, deliverBy: Date.now() - 1 };
    writeToInbox(expired);
    const quiet = path.join(path.dirname(sb.home), 'agentapi-quiet.log');
    const skipped = await pollSidecar({ ...env, AGENTAPI_LOG: quiet, AGENTAPI_HOLD: '', AGENTAPI_CODE: '0' });
    assert.equal(skipped.sent, 0);
    assert.equal(fs.existsSync(quiet), false);
    assert.equal(fs.existsSync(path.join(withdrawnDir(appPeer), `${late.id}.json`)), true);

    const okMsg = plant(appPeer, 'the-free-conversation');
    const hung = plant(otherPeer, 'the-hung-conversation');
    const hangLog = path.join(path.dirname(sb.home), 'agentapi-hang.log');
    const began = Date.now();
    const both = await pollSidecar({
      ...env,
      AGENTAPI_LOG: hangLog,
      AGENTAPI_HOLD: '',
      AGENTAPI_HANG_FOR: otherId,
      AGENTAPI_CODE: '0',
      TELEPATHY_AGENTAPI_TIMEOUT_MS: '400',
    });
    assert.ok(Date.now() - began < 2000, 'a hung agentapi does not stall the other conversation past its timeout');
    assert.equal(both.sent, 1);
    assert.equal(fs.existsSync(path.join(archiveDir(appPeer), `${okMsg.id}.json`)), true);
    assert.equal(fs.existsSync(path.join(inboxDir(otherPeer), `${hung.id}.json`)), true);
    assert.match(fs.readFileSync(hangLog, 'utf8'), new RegExp(okMsg.id));
  });

  test('confirm reads the brain transcript, preferring the path the hook recorded', () => {
    const id = sessionPeerId('antigravity', 1, APP);
    const recorded = readSession(id)?.transcriptPath;
    assert.ok(recorded);
    fs.mkdirSync(path.dirname(recorded), { recursive: true });
    fs.writeFileSync(recorded, `noise\n${messageMarker('m-app')}\n`);
    const peer = readPeer(id);
    assert.ok(peer);
    assert.deepEqual(inspectTranscript(peer, messageMarker('m-app')), { located: true, found: true });
    assert.deepEqual(inspectTranscript(peer, messageMarker('m-missing')), { located: true, found: false });

    const other = 'cccccccc-dddd-4eee-8fff-000000000001';
    const bare = path.join(
      sb.env.HOME as string,
      '.gemini',
      'antigravity-ide',
      'brain',
      other,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    const ide = spawn();
    runHook(sb, 'antigravity', ide.pid, 'session-start', {
      conversationId: other,
      cwd: path.join(sb.env.HOME as string, 'ide'),
    });
    const ideId = sessionPeerId('antigravity', ide.pid, other);
    const idePeer = readPeer(ideId);
    assert.ok(idePeer);
    assert.deepEqual(inspectTranscript(idePeer, messageMarker('m-app')), { located: false, found: false });
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    fs.writeFileSync(bare, `${messageMarker('m-ide')}\n`);
    assert.deepEqual(inspectTranscript(idePeer, messageMarker('m-ide')), { located: true, found: true });

    const previous = process.env.TELEPATHY_TRANSCRIPT_DIR;
    process.env.TELEPATHY_TRANSCRIPT_DIR = '${TELEPATHY_TRANSCRIPT_DIR}';
    try {
      assert.deepEqual(inspectTranscript(idePeer, messageMarker('m-ide')), { located: true, found: true });
      const empty = path.join(sb.home, 'empty-transcripts');
      fs.mkdirSync(empty, { recursive: true });
      process.env.TELEPATHY_TRANSCRIPT_DIR = empty;
      assert.deepEqual(inspectTranscript(idePeer, messageMarker('m-ide')), { located: true, found: true });
    } finally {
      if (previous === undefined) delete process.env.TELEPATHY_TRANSCRIPT_DIR;
      else process.env.TELEPATHY_TRANSCRIPT_DIR = previous;
    }
  });

  test('doctor reports a leftover Gemini extension and a disabled sidecar without deleting either', async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = path.dirname(process.execPath);
    try {
    const leftover = path.join(sb.env.HOME as string, '.gemini', 'extensions', 'telepathy', 'gemini-extension.json');
    fs.mkdirSync(path.dirname(leftover), { recursive: true });
    fs.writeFileSync(leftover, JSON.stringify({ name: 'telepathy', version: '0.4.4' }));
    const report = await statusReport({ doctor: true });
    assert.match(report.text, /not enabled in ~\/\.gemini\/config\/config\.json/);
    assert.match(report.text, new RegExp(ANTIGRAVITY_SIDECAR_ID));
    assert.match(report.text, /Leftover Gemini CLI extension/);
    assert.match(report.text, /install --remove-legacy/);
    assert.equal(fs.existsSync(leftover), true);

    const lines: string[] = [];
    const dry = await installAll({ dryRun: true, only: ['antigravity'], log: (line) => lines.push(line) });
    assert.equal(dry, 0);
    assert.doesNotMatch(lines.join('\n'), /OpenCode|Claude Code|Kilo/);
    assert.doesNotMatch(lines.join('\n'), /Would remove/);
    assert.equal(fs.existsSync(leftover), true);

    const kept: string[] = [];
    const live = await installAll({ only: ['antigravity'], log: (line) => kept.push(line) });
    assert.equal(live, 1);
    assert.doesNotMatch(kept.join('\n'), /Removed leftover/);
    assert.equal(fs.existsSync(leftover), true);

    const removed: string[] = [];
    const legacy = await installAll({ only: ['antigravity'], removeLegacy: true, log: (line) => removed.push(line) });
    assert.equal(legacy, 1);
    assert.match(removed.join('\n'), /Removed leftover Gemini CLI extension/);
    assert.equal(fs.existsSync(leftover), false);

    const config = path.join(sb.env.HOME as string, '.gemini', 'config', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(
      config,
      JSON.stringify({ theme: 'dark', sidecars: { [ANTIGRAVITY_SIDECAR_ID]: { projectId: 'proj-1' }, other: { enabled: false } } }),
    );
    enableAntigravitySidecar();
    const json = JSON.parse(fs.readFileSync(config, 'utf8')) as {
      theme: string;
      sidecars: Record<string, { enabled?: boolean; projectId?: string }>;
    };
    assert.equal(json.theme, 'dark');
    assert.equal(json.sidecars[ANTIGRAVITY_SIDECAR_ID].enabled, true);
    assert.equal(json.sidecars[ANTIGRAVITY_SIDECAR_ID].projectId, 'proj-1');
    assert.equal(json.sidecars.other.enabled, false);
    const afterEnable = await statusReport({ doctor: true });
    assert.match(afterEnable.text, new RegExp(`${ANTIGRAVITY_SIDECAR_ID}\\): enabled`));
    assert.doesNotMatch(afterEnable.text, /Leftover Gemini CLI extension/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test('headless auth follows the login type and does not write settings', () => {
    const file = path.join(sb.env.HOME as string, '.gemini', 'antigravity-cli', 'settings.json');
    const refused = ensureAgyApiKey({ ...process.env, HOME: sb.env.HOME, GEMINI_API_KEY: 'test-key' });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.warning, /consumer login/);
    assert.equal(fs.existsSync(file), false);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ modelProvider: 'gemini' }));
    const missing = ensureAgyApiKey({ ...process.env, HOME: sb.env.HOME, GEMINI_API_KEY: '' });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.warning, /GEMINI_API_KEY/);
    assert.equal(ensureAgyApiKey({ ...process.env, HOME: sb.env.HOME, GEMINI_API_KEY: 'test-key' }).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { modelProvider: 'gemini' });
  });
});
