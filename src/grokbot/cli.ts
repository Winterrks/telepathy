import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatPeerList } from '../core/listing.ts';
import { stateDir } from '../core/paths.ts';
import { noteTag } from '../core/tags.ts';
import { listPeers, readPeer, slugify } from '../core/peers.ts';
import { isSameProcess } from '../core/proc.ts';
import { sendMessage } from '../core/deliver.ts';
import { headlessLogPath, readHeadlessRecord } from '../headless/peer.ts';
import { configPath, keyProblem, listConfigs, looseConfigs, readConfig, removeConfig, urlProblem, writeConfig } from './config.ts';
import { cliCommand, grokbotArgv, postContext, runGrokbotHost } from './host.ts';

const HELP = `telepathy grokbot: a Grok Bot routine webhook as a telepathy session.

  telepathy grokbot connect <name> <url> [--no-start]
      Paste the key when asked (or pipe it on stdin). Starts grok:<name>.
  telepathy grokbot start [name]       start the host (all connected Bots without a name)
  telepathy grokbot stop [name]
  telepathy grokbot status
  telepathy grokbot test <name>        wake the Bot once with a test note
  telepathy grokbot send <name> <to> <message | ->
  telepathy grokbot peers <name>
  telepathy grokbot disconnect <name>

Ask the Bot to make a routine with a webhook trigger. Open that routine from the Bot's info pane in the Grok Bot
app; its Webhook section shows the URL and the key. While the host runs, a message to grok:<name> starts one run
of that routine with the message as its context, and the Bot answers with \`telepathy grokbot send\` on this
machine. The key stays in ~/.telepathy/grokbot/<name>.json (mode 600) and is never printed.`;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** A key typed or pasted at a terminal, not echoed. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode?.(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** The host's pid while that same process runs. A pid reused after a reboot is not the host. */
function hostRunning(slug: string): number | undefined {
  const record = readHeadlessRecord('grok', slug);
  return record && isSameProcess(record.pid, record.procStart) ? record.pid : undefined;
}

/** Starts `telepathy grokbot host <name>` detached and waits for it to register. */
async function startHost(slug: string): Promise<{ ok: boolean; text: string }> {
  const pid = hostRunning(slug);
  if (pid) return { ok: true, text: `grok:${slug} is already running (pid ${pid}).` };
  const logFile = headlessLogPath('grok', slug);
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const out = fs.openSync(logFile, 'a', 0o600);
  const [cmd, ...args] = grokbotArgv();
  const home = os.homedir();
  const child = spawn(cmd, [...args, 'host', slug], {
    cwd: fs.existsSync(home) ? home : stateDir(),
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  let spawnError: string | undefined;
  child.on('error', (err) => (spawnError = err.message));
  child.unref();
  fs.closeSync(out);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = readHeadlessRecord('grok', slug);
    if (record && record.pid === child.pid && readPeer(record.peerId)) {
      return { ok: true, text: `grok:${slug} is up (pid ${child.pid}). Log: ${logFile}` };
    }
    if (child.exitCode !== null || spawnError) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Another session started it at the same moment; that host holds the lock and this one stepped aside.
  const other = hostRunning(slug);
  if (other) return { ok: true, text: `grok:${slug} is up (pid ${other}).` };
  return { ok: false, text: `grok:${slug} did not start${spawnError ? ` (${spawnError})` : ''}. See ${logFile}.` };
}

function stopHost(slug: string): string {
  const pid = hostRunning(slug);
  if (!pid) return `grok:${slug} is not running.`;
  process.kill(pid, 'SIGTERM');
  return `Stopped grok:${slug} (pid ${pid}).`;
}

/** Every connected Bot's host that isn't running. The MCP server calls this, so a reboot doesn't leave a Bot offline. */
export async function ensureGrokbotHosts(): Promise<void> {
  for (const config of listConfigs()) {
    if (!hostRunning(config.slug)) await startHost(config.slug);
  }
}

function needName(name: string | undefined, usage: string): string {
  const slug = name ? slugify(name) : '';
  if (!slug) throw new Error(`Usage: ${usage}`);
  return slug;
}

export async function grokbotCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(HELP);
    return 0;
  }
  if (sub === 'host') return runGrokbotHost(needName(rest[0], 'telepathy grokbot host <name>'));

  if (sub === 'connect') {
    const noStart = rest.includes('--no-start');
    const [name, url] = rest.filter((arg) => arg !== '--no-start');
    if (!name || !url) throw new Error('Usage: telepathy grokbot connect <name> <url>');
    const bad = urlProblem(url);
    if (bad) throw new Error(bad);
    const key = (process.stdin.isTTY ? await promptHidden('Routine key (input hidden): ') : await readStdin()).trim();
    const badKey = keyProblem(key);
    if (badKey) throw new Error(badKey);
    const config = writeConfig(name, url, key);
    console.log(`Connected grok:${config.slug} to ${new URL(url).host}. Key saved in ${configPath(config.slug)} (mode 600).`);
    // A key can't be checked without starting a run: the endpoint accepts any JSON body from a valid key.
    console.log(`\`telepathy grokbot test ${config.slug}\` wakes the Bot once to check it.`);
    if (noStart) return 0;
    const started = await startHost(config.slug);
    console.log(started.text);
    return started.ok ? 0 : 1;
  }

  if (sub === 'start') {
    const slugs = rest[0] ? [needName(rest[0], 'telepathy grokbot start [name]')] : listConfigs().map((c) => c.slug);
    if (!slugs.length) {
      console.log('No Grok Bot is connected. Run `telepathy grokbot connect <name> <url>`.');
      return 1;
    }
    let ok = true;
    for (const slug of slugs) {
      if (!readConfig(slug)) {
        console.log(`grok:${slug}: not connected.`);
        ok = false;
        continue;
      }
      const started = await startHost(slug);
      console.log(started.text);
      ok &&= started.ok;
    }
    return ok ? 0 : 1;
  }

  if (sub === 'stop') {
    const slugs = rest[0] ? [needName(rest[0], 'telepathy grokbot stop [name]')] : listConfigs().map((c) => c.slug);
    for (const slug of slugs) console.log(stopHost(slug));
    return 0;
  }

  if (sub === 'status') {
    const configs = listConfigs();
    const loose = looseConfigs();
    if (!configs.length && !loose.length) {
      console.log('No Grok Bot is connected.');
      return 0;
    }
    for (const config of configs) {
      const pid = hostRunning(config.slug);
      console.log(`grok:${config.slug}\t${pid ? `running (pid ${pid})` : 'stopped'}\t${new URL(config.url).host}\tlog ${headlessLogPath('grok', config.slug)}`);
    }
    for (const name of loose) console.log(`${name}: ignored, the file is not mode 600 (chmod 600 it).`);
    return 0;
  }

  if (sub === 'test') {
    const slug = needName(rest[0], 'telepathy grokbot test <name>');
    const config = readConfig(slug);
    if (!config) throw new Error(`grok:${slug} is not connected.`);
    const host = os.hostname().replace(/\.local$/, '');
    const context = noteTag(
      'wake',
      `telepathy test from ${host}: this webhook reaches you. No reply is needed. Messages to grok:${slug} will arrive ` +
        `like this, and you answer them by running on ${host}: ${cliCommand()} send ${slug} <address> "<reply>".`,
    );
    const result = await postContext(config, context);
    if (!result.ok) {
      console.log(`Webhook failed: ${result.detail} (${result.ms}ms).`);
      return 1;
    }
    console.log(`Webhook accepted (HTTP ${result.status}, ${result.ms}ms)${result.runId ? `, run ${result.runId}` : ''}. The Bot runs that routine now.`);
    return 0;
  }

  if (sub === 'send') {
    const [name, to, ...words] = rest;
    const slug = needName(name, 'telepathy grokbot send <name> <to> <message | ->');
    if (!to || !words.length) throw new Error('Usage: telepathy grokbot send <name> <to> <message | ->');
    const record = readHeadlessRecord('grok', slug);
    if (!record || !isSameProcess(record.pid, record.procStart)) throw new Error(`grok:${slug} is not running. Start it with \`telepathy grokbot start ${slug}\`.`);
    const self = readPeer(record.peerId);
    if (!self) throw new Error(`grok:${slug} is not registered yet. Try again in a moment.`);
    const body = words.length === 1 && words[0] === '-' ? await readStdin() : words.join(' ');
    const result = await sendMessage(self, to, body);
    if (!result.ok) {
      console.log(result.error);
      return 1;
    }
    console.log(result.status);
    return 0;
  }

  if (sub === 'peers') {
    const slug = needName(rest[0], 'telepathy grokbot peers <name>');
    const record = readHeadlessRecord('grok', slug);
    const self = record && isSameProcess(record.pid, record.procStart) ? readPeer(record.peerId) : undefined;
    if (!self) throw new Error(`grok:${slug} is not running. Start it with \`telepathy grokbot start ${slug}\`.`);
    console.log(formatPeerList(self, listPeers()));
    return 0;
  }

  if (sub === 'disconnect') {
    const slug = needName(rest[0], 'telepathy grokbot disconnect <name>');
    const stopped = stopHost(slug);
    const removed = removeConfig(slug);
    console.log(removed ? `${stopped} Removed its URL and key.` : `grok:${slug} was not connected.`);
    return removed ? 0 : 1;
  }

  console.error(`Unknown grokbot command ${JSON.stringify(sub)}.\n\n${HELP}`);
  return 1;
}
