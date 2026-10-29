import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { after, before, describe, test } from 'node:test';
import { type Agent, isAgentProcess, parseAgent } from '../src/core/agents.ts';
import { codexActivity } from '../src/core/codex-activity.ts';
import { findInstalls, isNewer } from '../src/core/installs.ts';
import { clearCodexTuiCache, codexTuiLaunch, codexTuiProcesses, isCodexExecCommand } from '../src/core/codex-launch.ts';
import { formatAgo, describePeer } from '../src/core/listing.ts';
import { formatAsUserTurn, formatForClaudeSocket, formatMonitorLine, type Message, newMessageId, writeToInbox } from '../src/core/messages.ts';
import { clearProcessListCache, processTable } from '../src/core/proc.ts';
import { ignoredShellChild, peerStatus, shellIsTelepathyMonitorOnly, statusText } from '../src/core/status.ts';
import { inboxDir, peerDir } from '../src/core/paths.ts';
import { isDeliveryOwner, listPeers, type Peer, readPeer, registerPresence, registerSession, registerStableName, resolvePeer, slugify } from '../src/core/peers.ts';
import { fakeAgent, fakeCodexHost, hostReady, killAndWait, makeSandbox, named, setCodexProcs, type Sandbox } from './helpers.ts';

const peer = (agent: Agent, pid: number, name: string): Peer => ({
  id: `${agent}-${pid}`,
  agent,
  pid,
  name,
  address: `${agent}:${slugify(name)}`,
  hasListener: true,
  hasServer: true,
});

/** A live process whose children have the given trailing argv, so Claude's process tree can be classified. */
function sessionWithChildren(commands: string[][]): ReturnType<typeof spawn> & { pid: number } {
  const script = `
    const { spawn } = require('node:child_process');
    for (const args of ${JSON.stringify(commands)}) {
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', '--', ...args], { stdio: 'ignore' });
    }
    setInterval(() => {}, 1 << 30);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', detached: true });
  return child as ReturnType<typeof spawn> & { pid: number };
}

function descendantCount(root: number): number {
  const table = processTable(0);
  const byParent = new Map<number, number[]>();
  for (const info of table.values()) {
    const kids = byParent.get(info.ppid);
    if (kids) kids.push(info.pid);
    else byParent.set(info.ppid, [info.pid]);
  }
  let count = 0;
  const stack = [...(byParent.get(root) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    count += 1;
    for (const child of byParent.get(pid) ?? []) stack.push(child);
  }
  return count;
}

/** Writes Claude's session file as shell and returns the listing once that many children are visible. */
async function shellListing(pid: number, children: number): Promise<string | undefined> {
  const record = path.join(process.env.CLAUDE_CONFIG_DIR ?? '', 'sessions', `${pid}.json`);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ status: 'shell', statusUpdatedAt: Date.now() }));
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (descendantCount(pid) >= children) return statusText(peerStatus(peer('claude', pid, 'sdk')));
    if (Date.now() > deadline) return statusText(peerStatus(peer('claude', pid, 'sdk')));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe('opencode launch command line', () => {
  // Importing the plugin starts the wake flusher. Point it at a temp home first so the real ~/.telepathy is untouched.
  let home = '';
  let opencodeLaunchFromAncestors: typeof import('../src/opencode.ts').opencodeLaunchFromAncestors;

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepathy-opencode-'));
    process.env.TELEPATHY_HOME = home;
    ({ opencodeLaunchFromAncestors } = await import('../src/opencode.ts'));
  });

  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('reads --session from this process before its parent', () => {
    const args = new Map<number, string>([
      [42, 'node /usr/local/bin/opencode --session ses_self'],
      [7, 'opencode --continue --session ses_parent'],
    ]);
    const launch = opencodeLaunchFromAncestors(42, (pid) => args.get(pid), (pid) => (pid === 42 ? 7 : 1));
    assert.equal(launch.sessionID, 'ses_self');
    assert.equal(launch.continueLast, false);
  });

  test('reads --continue from the parent when this process has no flag', () => {
    const launch = opencodeLaunchFromAncestors(
      42,
      (pid) => (pid === 42 ? 'node plugin.js' : 'opencode --continue'),
      (pid) => (pid === 42 ? 7 : 1),
    );
    assert.equal(launch.sessionID, undefined);
    assert.equal(launch.continueLast, true);
  });
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
    const bare = resolvePeer('codex:', peers);
    assert.ok('error' in bare);
    assert.match(bare.error, /3 sessions/);
    const only = resolvePeer('codex:', [peer('codex', 101, 'solo')]);
    assert.ok('peer' in only && only.peer.id === 'codex-101');
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
    const start = Date.now();
    while (Date.now() === start) await new Promise((r) => setTimeout(r, 2));
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

  test('the Claude socket names the real sender, including Codex and OpenCode', () => {
    const codex = formatForClaudeSocket({ ...msg, from: { id: 'codex-9', agent: 'codex', name: 'api', address: 'codex:api' } });
    assert.match(codex, /from-name="Codex session codex:api \[codex-9\]"/);
    assert.match(codex, /Message from Codex session codex:api \[codex-9\]/);
    assert.ok(codex.startsWith('<cross-session-message '));
    assert.ok(codex.endsWith('</cross-session-message>'));
    const opencode = formatForClaudeSocket({
      ...msg,
      from: { id: 'opencode-4', agent: 'opencode', name: 'web', address: 'opencode:web' },
    });
    assert.match(opencode, /from-name="OpenCode session opencode:web \[opencode-4\]"/);
    assert.doesNotMatch(opencode, /Another Claude session/);
  });

  test('a telepathy monitor is not a shell command, and any other command is', () => {
    const monitor = 'node /plugins/telepathy/dist/monitor.mjs --agent claude';
    const server = 'node /plugins/telepathy/dist/server.mjs --agent claude';
    assert.equal(shellIsTelepathyMonitorOnly([monitor]), true);
    assert.equal(shellIsTelepathyMonitorOnly([server, monitor]), true);
    assert.equal(shellIsTelepathyMonitorOnly([monitor, 'sleep 30']), false);
    assert.equal(shellIsTelepathyMonitorOnly([server]), false);
    assert.equal(shellIsTelepathyMonitorOnly([]), false);
    assert.equal(ignoredShellChild('ps aux', 10_000), true);
    assert.equal(ignoredShellChild('"/usr/bin/ps"', 10_000), true);
    assert.equal(ignoredShellChild('(ps)', undefined), true);
    assert.equal(ignoredShellChild('node server.js', 100), true);
    assert.equal(ignoredShellChild('node server.js', 5_000), false);
    assert.equal(ignoredShellChild('node /plugins/telepathy/dist/monitor.mjs --agent claude', 100), false);
  });

  test('list_peers reports idle when the only live command is the telepathy monitor', async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    const prevTransient = process.env.TELEPATHY_TRANSIENT_CHILD_MS;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-claude-'));
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.TELEPATHY_TRANSIENT_CHILD_MS = '1';
    const monitor = sessionWithChildren([['monitor.mjs', '--agent', 'claude']]);
    const other = sessionWithChildren([['sleep', '30']]);
    const both = sessionWithChildren([
      ['monitor.mjs', '--agent', 'claude'],
      ['sleep', '30'],
    ]);
    try {
      assert.equal(await shellListing(monitor.pid, 1), 'idle');
      assert.equal(await shellListing(other.pid, 1), 'shell (not generating, but a command it started is still running)');
      assert.equal(await shellListing(both.pid, 2), 'shell (not generating, but a command it started is still running)');
    } finally {
      for (const child of [monitor, other, both]) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      if (prevTransient === undefined) delete process.env.TELEPATHY_TRANSIENT_CHILD_MS;
      else process.env.TELEPATHY_TRANSIENT_CHILD_MS = prevTransient;
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    try {
      registerSession('codex', live.pid, { sessionId: 'thread-live', cwd: '/work/alpha', source: 'hook' });
      registerPresence('claude', dead.pid, { cwd: '/work/beta' });
      await killAndWait(dead);

      const peers = listPeers();
      assert.deepEqual(
        peers.map((p) => [p.id, p.address, p.sessionId]),
        [['codex-thread-live', named('codex', 'alpha', 'thread-live'), 'thread-live']],
      );
      assert.equal(fs.existsSync(peerDir(`claude-${dead.pid}`)), false);
    } finally {
      await killAndWait(live);
    }
    assert.equal(listPeers().length, 0, 'without writer locks, a Codex thread lives as long as its process');
  });

  test('a reused pid is not mistaken for the old session', async () => {
    const agent = fakeAgent();
    try {
      registerSession('gemini', agent.pid, { sessionId: 't', cwd: '/w/x', source: 'hook' });
      const stale = 'Mon Jan  1 00:00:00 2001';
      const sessionFile = path.join(peerDir('gemini-t'), 'session.json');
      const record = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { procStart?: string };
      record.procStart = stale;
      fs.writeFileSync(sessionFile, JSON.stringify(record));
      const ownersFile = path.join(peerDir('gemini-t'), 'owners.json');
      const owners = JSON.parse(fs.readFileSync(ownersFile, 'utf8')) as { procStart?: string }[];
      owners[0].procStart = stale;
      fs.writeFileSync(ownersFile, JSON.stringify(owners));
      assert.equal(listPeers().length, 0);
    } finally {
      await killAndWait(agent);
    }
  });

  test('a session is named after its folder, and the bare folder name and a Codex thread title reach it too', async () => {
    const agent = fakeAgent();
    try {
      registerSession('codex', agent.pid, { sessionId: 'thread-9', cwd: '/w/repo', source: 'hook' });
      fs.writeFileSync(
        path.join(sb.codexHome, 'session_index.jsonl'),
        JSON.stringify({ id: 'thread-9', thread_name: 'Refactor payments API', updated_at: 'x' }) + '\n',
      );
      const peers = listPeers();
      assert.match(peers[0]?.address ?? '', /^codex:repo-c[0-9a-f]{2}$/, 'the agent\'s first letter and two hex characters');
      assert.equal(peers[0]?.address, named('codex', 'repo', 'thread-9'));
      for (const to of ['codex:repo', 'codex:refactor-payments-api', peers[0].address]) {
        const r = resolvePeer(to, peers);
        assert.ok('peer' in r && r.peer.id === 'codex-thread-9', to);
      }
    } finally {
      await killAndWait(agent);
    }
  });

  test('a resumed session reclaims the same id, name, and inbox', async () => {
    const first = fakeAgent();
    const second = fakeAgent();
    try {
      registerSession('claude', first.pid, { sessionId: 'claude-sess', cwd: '/w/app', source: 'hook' });
      const id = 'claude-claude-sess';
      const firstPeer = readPeer(id);
      assert.equal(firstPeer?.address, 'claude:app');
      writeToInbox({
        id: 'm-resume',
        from: { id: 'codex-t', agent: 'codex', name: 'sender', address: 'codex:sender' },
        to: { id, agent: 'claude', name: 'app', address: 'claude:app' },
        body: 'waiting',
        sentAt: new Date().toISOString(),
      });
      await killAndWait(first);
      assert.equal(listPeers().some((p) => p.id === id), false);
      assert.equal(fs.readdirSync(inboxDir(id)).length, 1);

      fs.mkdirSync(path.join(sb.env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(sb.env.CLAUDE_CONFIG_DIR, 'sessions', `${second.pid}.json`), JSON.stringify({ name: 'other-name-ab' }));
      registerSession('claude', second.pid, { sessionId: 'claude-sess', cwd: '/w/elsewhere', source: 'hook' });
      const again = readPeer(id);
      assert.equal(again?.name, 'app');
      assert.equal(again?.address, 'claude:app');
      assert.equal(again?.pid, second.pid);
      assert.equal(fs.readdirSync(inboxDir(id)).length, 1);
      assert.equal(isDeliveryOwner(id, second.pid), true);
    } finally {
      await killAndWait(first);
      await killAndWait(second);
    }
  });

  test('two live processes on one session: the first owns delivery, and TELEPATHY_NAME still wins', async () => {
    const a = fakeAgent();
    const b = fakeAgent();
    const prev = process.env.TELEPATHY_NAME;
    try {
      registerSession('claude', a.pid, { sessionId: 'same', cwd: '/w/a', source: 'hook' });
      registerSession('claude', b.pid, { sessionId: 'same', cwd: '/w/b', source: 'hook' });
      const peers = listPeers().filter((p) => p.sessionId === 'same');
      assert.equal(peers.length, 1);
      assert.equal(peers[0]?.duplicate, true);
      assert.equal(peers[0]?.id, 'claude-same');
      assert.equal(isDeliveryOwner('claude-same', a.pid), true);
      assert.equal(isDeliveryOwner('claude-same', b.pid), false);
      process.env.TELEPATHY_NAME = 'chosen';
      registerStableName('claude', 'claude-same');
      assert.equal(readPeer('claude-same')?.address, 'claude:chosen');
    } finally {
      if (prev === undefined) delete process.env.TELEPATHY_NAME;
      else process.env.TELEPATHY_NAME = prev;
      await killAndWait(a);
      await killAndWait(b);
    }
  });

});

describe('Codex threads in a shared host process', () => {
  let sb: Sandbox;
  before(() => {
    sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CLAUDE_CONFIG_DIR = sb.env.CLAUDE_CONFIG_DIR;
    process.env.CODEX_HOME = sb.codexHome;
  });
  after(() => sb.cleanup());

  const A = '01a1176e-84cc-76c3-b84c-8e4da4d38c36';
  const B = '01a0b3be-0955-74c0-a260-f68625685956';
  const C = '01a11b03-f89f-7273-a33b-f530a64cc9c0';

  test('each thread is its own session, and stays one when Codex replaces the daemon', async () => {
    const daemon = fakeCodexHost(sb.codexHome, A, B);
    let next: ReturnType<typeof fakeCodexHost> | undefined;
    try {
      await hostReady(daemon);
      registerSession('codex', daemon.pid, { sessionId: A, cwd: '/w/norma v2', source: 'hook' });
      registerSession('codex', daemon.pid, { sessionId: B, cwd: '/w/waifus', source: 'hook' });
      assert.deepEqual(listPeers().map((p) => [p.id, p.address]).sort(), [
        [`codex-${B}`, named('codex', 'waifus', B)],
        [`codex-${A}`, named('codex', 'norma-v2', A)],
      ]);
      const r = resolvePeer(`codex-${A}`, listPeers());
      assert.ok('peer' in r && r.peer.sessionId === A, 'a thread ref resolves');

      // An update: the new daemon takes over the threads' locks, and the old one exits.
      next = fakeCodexHost(sb.codexHome, A);
      await hostReady(next);
      await killAndWait(daemon);
      fs.rmSync(path.join(sb.codexHome, 'thread-writer-locks', `${B}.lock`)); // B was not resumed
      assert.deepEqual(listPeers().map((p) => p.id), [`codex-${A}`]);
    } finally {
      await killAndWait(daemon);
      if (next) await killAndWait(next);
    }
    // A lock file that no process holds (Codex crashed) is no session either, once the lsof result cached for a second expires.
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(listPeers().length, 0);
  });

  test('a thread that no process runs is hidden but kept, and is back as soon as a process loads it', async () => {
    const D = '01a12026-d630-7370-90eb-ec83c96df383';
    const daemon = fakeCodexHost(sb.codexHome, D);
    let next: ReturnType<typeof fakeCodexHost> | undefined;
    try {
      await hostReady(daemon);
      registerSession('codex', daemon.pid, { sessionId: D, cwd: '/w/kept', source: 'hook' });
      await killAndWait(daemon);
      fs.rmSync(path.join(sb.codexHome, 'thread-writer-locks', `${D}.lock`));
      assert.deepEqual(listPeers().map((p) => p.id), []);
      assert.ok(fs.existsSync(path.join(peerDir(`codex-${D}`), 'session.json')), 'the record outlives the process');
      next = fakeCodexHost(sb.codexHome, D); // a new daemon, or `codex resume`, loads it again: no hook has run yet
      await hostReady(next);
      assert.deepEqual(listPeers().map((p) => [p.id, p.address]), [[`codex-${D}`, named('codex', 'kept', D)]]);
    } finally {
      await killAndWait(daemon);
      if (next) await killAndWait(next);
    }
  });

  test('a registration by the daemon\'s pid is hidden when its thread registered by itself', async () => {
    const daemon = fakeCodexHost(sb.codexHome, C);
    try {
      await hostReady(daemon);
      registerSession('codex', daemon.pid, { sessionId: C, cwd: '/w/norma v2', source: 'hook' });
      // What telepathy 0.8 wrote for the same daemon: one record for all its threads, plus a server without one.
      fs.mkdirSync(peerDir(`codex-${daemon.pid}`), { recursive: true });
      fs.writeFileSync(
        path.join(peerDir(`codex-${daemon.pid}`), 'session.json'),
        JSON.stringify({ agent: 'codex', pid: daemon.pid, sessionId: C, cwd: '/w/norma v2', source: 'hook' }),
      );
      assert.deepEqual(listPeers().map((p) => p.id), [`codex-${C}`]);
    } finally {
      await killAndWait(daemon);
    }
  });
});

describe('Codex TUI launch', () => {
  const T = '01a1176e-84cc-76c3-b84c-8e4da4d38c36';

  test('an interactive command is a TUI, and resume keeps an explicit thread id', () => {
    assert.deepEqual(codexTuiLaunch('/usr/local/bin/codex'), {});
    assert.deepEqual(codexTuiLaunch('codex --sandbox workspace-write'), {});
    assert.deepEqual(codexTuiLaunch('codex -m gpt-5.4 "look at the queue"'), {});
    assert.deepEqual(codexTuiLaunch('codex resume'), {});
    assert.deepEqual(codexTuiLaunch('codex resume --last'), {});
    assert.deepEqual(codexTuiLaunch(`codex resume ${T}`), { threadId: T });
    assert.deepEqual(codexTuiLaunch(`codex --remote unix:///tmp/codex.sock resume ${T}`), { threadId: T });
    assert.deepEqual(codexTuiLaunch(`node /usr/local/bin/codex.js`), {});
    assert.deepEqual(codexTuiLaunch(`codex fork ${T}`), {});
    assert.equal(codexTuiLaunch('codex app-server --listen stdio'), undefined);
    assert.equal(codexTuiLaunch('codex exec --full-auto hello'), undefined);
    assert.equal(codexTuiLaunch('codex e hello'), undefined);
    assert.equal(codexTuiLaunch('codex queue --thread abc'), undefined);
    assert.equal(codexTuiLaunch('codex login'), undefined);
    assert.equal(codexTuiLaunch('codex plugin add telepathy@telepathy'), undefined);
    assert.equal(codexTuiLaunch('codex mcp-server'), undefined);
    assert.equal(codexTuiLaunch('codex cloud'), undefined);
    assert.equal(codexTuiLaunch('codex hello'), undefined);
    assert.deepEqual(codexTuiLaunch('codex "Fix the bug"'), {});
    const chatgpt =
      '/Applications/ChatGPT.app/Contents/Resources/codex -c forced_login_method="chatgpt" exec-server --remote https://codex-cloud-environments.chatgpt.com/api';
    assert.equal(codexTuiLaunch(chatgpt), undefined);
    assert.equal(isCodexExecCommand('codex exec --full-auto hello'), true);
    assert.equal(isCodexExecCommand('codex e hello'), true);
    assert.equal(isCodexExecCommand(`codex exec resume ${T}`), true);
    assert.equal(isCodexExecCommand('codex app-server --listen stdio'), false);
    assert.equal(isCodexExecCommand(chatgpt), false);
    assert.equal(isCodexExecCommand('codex'), false);
    assert.equal(codexTuiLaunch('node /opt/telepathy/dist/server.mjs --agent codex'), undefined);
    assert.equal(codexTuiLaunch('bash -c codex'), undefined);
  });

  test('a launched Codex with no thread stays its own row when another session appears', async () => {
    const sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CODEX_HOME = sb.codexHome;
    const tui = fakeAgent();
    const daemon = fakeAgent();
    const thread = '01a12026-d630-7370-90eb-ec83c96df383';
    try {
      setCodexProcs(sb, [{ pid: tui.pid, args: '/usr/local/bin/codex', cwd: '/work/app' }]);
      const listed = listPeers().find((p) => p.id === `codex-${tui.pid}`);
      assert.ok(listed);
      assert.equal(listed.sessionId, undefined);
      assert.equal(listed.address, named('codex', 'app', tui.pid));
      assert.match(describePeer(listed), /no thread yet/);
      assert.equal(listPeers().some((p) => p.sessionId === thread), false);

      registerSession('codex', daemon.pid, { sessionId: thread, cwd: '/work/app', source: 'hook', codexHome: sb.codexHome });
      const after = listPeers();
      assert.ok(after.some((p) => p.id === `codex-${tui.pid}`));
      const bound = after.find((p) => p.id === `codex-${thread}`);
      assert.ok(bound);
      assert.notEqual(bound.address, listed.address);
      assert.equal(fs.existsSync(path.join(sb.home, 'peers', `codex-${tui.pid}`, 'link.json')), false);
    } finally {
      setCodexProcs(sb, []);
      await killAndWait(tui);
      await killAndWait(daemon);
      sb.cleanup();
    }
  });

  test('two unprompted Codex windows in one directory stay two rows when a thread appears', async () => {
    const sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CODEX_HOME = sb.codexHome;
    const a = fakeAgent();
    const b = fakeAgent();
    const daemon = fakeAgent();
    const thread = '01a0b3be-0955-74c0-a260-f68625685956';
    try {
      setCodexProcs(sb, [
        { pid: a.pid, args: 'codex', cwd: '/work/app' },
        { pid: b.pid, args: 'codex', cwd: '/work/app' },
      ]);
      assert.equal(listPeers().filter((p) => p.agent === 'codex' && !p.sessionId).length, 2);
      registerSession('codex', daemon.pid, { sessionId: thread, cwd: '/work/app', source: 'hook', codexHome: sb.codexHome });
      const after = listPeers();
      assert.equal(after.filter((p) => !p.sessionId).length, 2);
      const bound = after.find((p) => p.sessionId === thread);
      assert.ok(bound);
      assert.notEqual(bound.address, named('codex', 'app', a.pid));
      assert.notEqual(bound.address, named('codex', 'app', b.pid));
    } finally {
      setCodexProcs(sb, []);
      await killAndWait(a);
      await killAndWait(b);
      await killAndWait(daemon);
      sb.cleanup();
    }
  });

  test('a window in another directory is not treated as the new thread', async () => {
    const sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CODEX_HOME = sb.codexHome;
    const tui = fakeAgent();
    const daemon = fakeAgent();
    const thread = '01a11b03-f89f-7273-a33b-f530a64cc9c0';
    try {
      setCodexProcs(sb, [{ pid: tui.pid, args: 'codex', cwd: '/work/other' }]);
      listPeers();
      registerSession('codex', daemon.pid, { sessionId: thread, cwd: '/work/app', source: 'hook', codexHome: sb.codexHome });
      const after = listPeers();
      assert.ok(after.some((p) => p.id === `codex-${tui.pid}`));
      assert.ok(after.some((p) => p.id === `codex-${thread}`));
    } finally {
      setCodexProcs(sb, []);
      await killAndWait(tui);
      await killAndWait(daemon);
      sb.cleanup();
    }
  });

  test('codex resume of an id is that thread before a hook, and the name survives the next resume', async () => {
    const sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CODEX_HOME = sb.codexHome;
    fs.mkdirSync(path.join(sb.codexHome, 'thread-writer-locks'), { recursive: true });
    const thread = '01a13000-aaaa-7000-8000-000000000001';
    const first = fakeAgent();
    try {
      setCodexProcs(sb, [{ pid: first.pid, args: `codex resume ${thread}`, cwd: '/work/kept' }]);
      const listed = listPeers();
      assert.deepEqual(listed.map((p) => p.id), [`codex-${thread}`]);
      assert.equal(listed[0]?.address, named('codex', 'kept', thread));
      assert.equal(listed[0]?.sessionId, thread);
      const address = listed[0]?.address;

      const second = fakeAgent();
      try {
        setCodexProcs(sb, [{ pid: second.pid, args: `codex resume ${thread}`, cwd: '/work/elsewhere' }]);
        await killAndWait(first);
        const again = listPeers();
        assert.deepEqual(again.map((p) => p.id), [`codex-${thread}`]);
        assert.equal(again[0]?.address, address);
      } finally {
        await killAndWait(second);
      }
    } finally {
      setCodexProcs(sb, []);
      await killAndWait(first);
      sb.cleanup();
    }
  });

  test('the ChatGPT helper and an app-bundle parent are hidden, and a foreign CODEX_HOME is still listed', async () => {
    const sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    delete process.env.CODEX_HOME;
    const helper = fakeAgent();
    const bundled = fakeAgent();
    const foreign = fakeAgent();
    const own = fakeAgent();
    const chatgpt =
      '/Applications/ChatGPT.app/Contents/Resources/codex -c forced_login_method="chatgpt" exec-server --remote https://codex-cloud-environments.chatgpt.com/api';
    const foreignHome = '/tmp/other-codex-home';
    try {
      setCodexProcs(sb, [
        { pid: helper.pid, args: chatgpt, cwd: '/Users/example' },
        { pid: bundled.pid, args: 'codex', cwd: '/Users/example', parent: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
        { pid: foreign.pid, args: 'codex', cwd: '/work/foreign', codexHome: foreignHome },
        { pid: own.pid, args: 'codex', cwd: '/work/own', parent: '/bin/zsh', codexHome: sb.codexHome },
      ]);
      const ids = () => listPeers().map((p) => p.id);
      assert.equal(ids().includes(`codex-${helper.pid}`), false);
      assert.equal(ids().includes(`codex-${bundled.pid}`), false);
      assert.equal(ids().includes(`codex-${foreign.pid}`), true);
      assert.equal(ids().includes(`codex-${own.pid}`), true);
      const foreignSession = JSON.parse(
        fs.readFileSync(path.join(sb.home, 'peers', `codex-${foreign.pid}`, 'session.json'), 'utf8'),
      ) as { codexHome?: string };
      assert.equal(foreignSession.codexHome, foreignHome);
      process.env.CODEX_HOME = sb.codexHome;
      assert.equal(ids().includes(`codex-${foreign.pid}`), true);
      assert.equal(readPeer(`codex-${foreign.pid}`)?.codexHome, foreignHome);
      for (const pid of [helper.pid, bundled.pid]) {
        assert.equal(fs.existsSync(path.join(sb.home, 'peers', `codex-${pid}`, 'session.json')), false);
      }
    } finally {
      setCodexProcs(sb, []);
      process.env.CODEX_HOME = sb.codexHome;
      await killAndWait(helper);
      await killAndWait(bundled);
      await killAndWait(foreign);
      await killAndWait(own);
      sb.cleanup();
    }
  });

  test('a busy process table does not spawn ps once per process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-ps-'));
    const log = path.join(dir, 'ps.log');
    const bin = path.join(dir, 'ps');
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.PS_LOG, JSON.stringify(argv) + '\\n');
const joined = argv.join(' ');
const noise = 600;
if (joined.includes('pid=,args=')) {
  let out = '2500000 codex\\n2500001 codex\\n10 /bin/zsh\\n11 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\\n';
  for (let i = 0; i < noise; i++) out += (3000000 + i) + ' node worker-' + i + '\\n';
  process.stdout.write(out);
} else if (joined.includes('lstart')) {
  let out = '2500000 10 Wed Oct 28 12:00:00 2026 codex\\n2500001 11 Wed Oct 28 12:00:00 2026 codex\\n10 1 Wed Oct 28 12:00:00 2026 /bin/zsh\\n11 1 Wed Oct 28 12:00:00 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\\n';
  for (let i = 0; i < noise; i++) out += (3000000 + i) + ' 1 Wed Oct 28 12:00:00 2026 node\\n';
  process.stdout.write(out);
} else if (joined.includes('-E')) {
  process.stdout.write('2500000 CODEX_HOME=/tmp/codex-from-ps /usr/local/bin/codex\\n');
} else {
  process.stderr.write('unexpected ps ' + joined + '\\n');
  process.exit(1);
}
`,
    );
    fs.chmodSync(bin, 0o755);
    const prevPs = process.env.TELEPATHY_PS_BIN;
    const prevProcs = process.env.TELEPATHY_CODEX_PROCS;
    const prevLog = process.env.PS_LOG;
    delete process.env.TELEPATHY_CODEX_PROCS;
    process.env.TELEPATHY_PS_BIN = bin;
    process.env.PS_LOG = log;
    clearProcessListCache();
    clearCodexTuiCache();
    try {
      const procs = codexTuiProcesses();
      assert.equal(procs.length, 1);
      assert.equal(procs[0]?.pid, 2500000);
      assert.equal(procs[0]?.codexHome, '/tmp/codex-from-ps');
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
      assert.ok(calls.length <= 4, calls.join('\n'));
      const envCalls = calls.filter((call) => call.includes('-E'));
      assert.equal(envCalls.length, 1);
      assert.match(envCalls[0] ?? '', /2500000/);
      assert.doesNotMatch(envCalls[0] ?? '', /2500001/);
      assert.doesNotMatch(envCalls[0] ?? '', /3000000/);
      codexTuiProcesses();
      const again = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(again.length, calls.length);
    } finally {
      clearProcessListCache();
      clearCodexTuiCache();
      if (prevPs === undefined) delete process.env.TELEPATHY_PS_BIN;
      else process.env.TELEPATHY_PS_BIN = prevPs;
      if (prevProcs === undefined) delete process.env.TELEPATHY_CODEX_PROCS;
      else process.env.TELEPATHY_CODEX_PROCS = prevProcs;
      if (prevLog === undefined) delete process.env.PS_LOG;
      else process.env.PS_LOG = prevLog;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a hook-registered codex exec is reachable without a writer lock, and offline once it exits', async () => {
    const sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CODEX_HOME = sb.codexHome;
    fs.mkdirSync(path.join(sb.codexHome, 'thread-writer-locks'), { recursive: true });
    const bin = path.join(path.dirname(sb.home), 'codex');
    fs.writeFileSync(bin, '#!/bin/sh\nsleep 30\n');
    fs.chmodSync(bin, 0o755);
    const thread = '01a14000-bbbb-7000-8000-000000000002';
    const helperThread = '01a14000-bbbb-7000-8000-000000000004';
    const exec = spawn(bin, ['exec', '--full-auto', 'ship it'], { stdio: 'ignore' });
    const daemon = spawn(bin, ['app-server'], { stdio: 'ignore' });
    const helper = spawn(bin, ['exec-server', '--remote', 'https://codex-cloud-environments.chatgpt.com/api'], { stdio: 'ignore' });
    try {
      registerSession('codex', exec.pid!, { sessionId: thread, cwd: '/work/execd', source: 'hook', codexHome: sb.codexHome });
      const listed = listPeers().find((p) => p.id === `codex-${thread}`);
      assert.ok(listed, 'exec stays listed while its process holds the thread');
      assert.equal(listed?.sessionId, thread);
      registerSession('codex', daemon.pid!, {
        sessionId: '01a14000-bbbb-7000-8000-000000000003',
        cwd: '/work/execd',
        source: 'hook',
        codexHome: sb.codexHome,
      });
      registerSession('codex', helper.pid!, {
        sessionId: helperThread,
        cwd: '/work/execd',
        source: 'hook',
        codexHome: sb.codexHome,
      });
      assert.equal(
        listPeers().some((p) => p.sessionId === '01a14000-bbbb-7000-8000-000000000003'),
        false,
        'app-server without a writer lock is not a live thread',
      );
      assert.equal(
        listPeers().some((p) => p.sessionId === helperThread),
        false,
        'exec-server is not an exec thread',
      );
    } finally {
      await killAndWait(exec);
      await killAndWait(daemon);
      await killAndWait(helper);
    }
    assert.equal(listPeers().some((p) => p.id === `codex-${thread}`), false);
    sb.cleanup();
  });

  test('app-server and exec are not sessions', async () => {
    const sb = makeSandbox();
    process.env.TELEPATHY_HOME = sb.home;
    process.env.CODEX_HOME = sb.codexHome;
    const daemon = fakeAgent();
    const exec = fakeAgent();
    try {
      setCodexProcs(sb, [
        { pid: daemon.pid, args: 'codex app-server --listen stdio' },
        { pid: exec.pid, args: 'codex exec --full-auto ship it' },
      ]);
      assert.deepEqual(listPeers(), []);
    } finally {
      setCodexProcs(sb, []);
      await killAndWait(daemon);
      await killAndWait(exec);
      sb.cleanup();
    }
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

  test('Codex busy/idle/interrupted comes from the last turn event in the thread\'s rollout log', () => {
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
      assert.equal(codexActivity(codexHome, 'abc'), 'interrupted');
      // A huge item after the turn started must not hide that it's running: reading goes further back.
      fs.appendFileSync(file, event('task_started') + JSON.stringify({ type: 'response_item', payload: { output: 'x'.repeat(2_000_000) } }) + '\n');
      assert.equal(codexActivity(codexHome, 'abc'), 'busy');
      fs.appendFileSync(file, event('token_count'));
      assert.equal(codexActivity(codexHome, 'abc'), 'busy');
      fs.appendFileSync(file, event('task_started') + event('item_completed'));
      assert.equal(codexActivity(codexHome, 'abc'), 'busy');
      fs.appendFileSync(file, 'not json\n' + event('task_complete'));
      assert.equal(codexActivity(codexHome, 'abc'), 'idle');
      fs.appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_sta');
      assert.equal(codexActivity(codexHome, 'abc'), 'idle', 'a half-written last line is skipped');
      assert.equal(codexActivity(codexHome, 'other'), 'busy');
      // A long thread goes on in a segment file named after the thread plus a segment id; the newest one counts.
      fs.writeFileSync(path.join(newer, 'rollout-2026-09-02T10-00-00-abc_seg1.jsonl'), event('task_started'));
      assert.equal(codexActivity(codexHome, 'abc'), 'busy');
      fs.writeFileSync(path.join(newer, 'rollout-2026-09-02T11-00-00-abc_seg2.jsonl'), event('turn_aborted'));
      assert.equal(codexActivity(codexHome, 'abc'), 'interrupted');
      assert.equal(codexActivity(codexHome, 'ab'), undefined, 'a thread id that is only a prefix does not match');
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe('installed copies', () => {
  test('each agent\'s install is found where that agent keeps it, with its version', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'um-installs-'));
    const saved = Object.fromEntries(['HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map((k) => [k, process.env[k]]));
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
      fs.writeFileSync(path.join(base, file), content);
    };
    const manifest = (version: string) => JSON.stringify({ name: 'telepathy', version });
    try {
      Object.assign(process.env, {
        HOME: base,
        XDG_CACHE_HOME: path.join(base, '.cache'),
        XDG_DATA_HOME: path.join(base, '.local', 'share'),
        CLAUDE_CONFIG_DIR: path.join(base, '.claude'),
        CODEX_HOME: path.join(base, '.codex'),
      });
      assert.deepEqual(findInstalls(), []);
      write(
        '.claude/plugins/installed_plugins.json',
        JSON.stringify({ version: 2, plugins: { 'telepathy@telepathy': [{ version: '0.6.0', installPath: '/c/0.6.0' }], 'other@x': [{ version: '9.9.9', installPath: '/o' }] } }),
      );
      write('.codex/plugins/cache/telepathy/telepathy/0.5.1/x', '');
      write('.codex/plugins/cache/telepathy/telepathy/0.10.0/x', '');
      write('.gemini/extensions/telepathy/gemini-extension.json', manifest('0.4.4'));
      write('.qwen/extensions/telepathy/qwen-extension.json', manifest('0.4.3'));
      write('.copilot/installed-plugins/telepathy/telepathy/.github/plugin/plugin.json', manifest('0.4.2'));
      write('.local/share/devin/cli/plugins/cache/github.com_Winterrks_telepathy_plugin-1/0.4.1/.devin-plugin/plugin.json', manifest('0.4.1'));
      write('.gemini/config/plugins/telepathy/dist/server.mjs', 'var x = 1;\nvar VERSION = true ? "0.3.0" : "0.0.0-dev";\n');
      write('.cache/opencode/packages/telepathy@git+https:/github.com/Winterrks/telepathy.git/node_modules/telepathy/package.json', manifest('0.2.0'));
      write('.cache/kilo/packages/git/git_github.com_Winterrks_telepathy-abc/package.json', manifest('0.1.0'));
      write('.cache/kilo/packages/git/git_github.com_Winterrks_telepathy-abc.json', '{}');

      const found = Object.fromEntries(findInstalls().map((i) => [i.agent, `${i.version}${i.marketplace ? `@${i.marketplace}` : ''}`]));
      assert.deepEqual(found, {
        claude: '0.6.0@telepathy',
        codex: '0.10.0@telepathy', // the newest folder, compared as versions, not text
        gemini: '0.4.4',
        qwen: '0.4.3',
        copilot: '0.4.2@telepathy',
        devin: '0.4.1',
        antigravity: '0.3.0',
        opencode: '0.2.0',
        kilo: '0.1.0',
      });
      assert.ok(isNewer('0.10.0', '0.9.9') && !isNewer('0.6.0', '0.6.0') && isNewer('1.0.0', '0.99.0'));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
