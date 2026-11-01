import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { resolveArgvPath } from '../cli/entry.ts';
import { beginToolCall, confirmAbortMs, confirmGraceMs } from '../core/confirm.ts';
import { deliverLocal } from '../core/deliver.ts';
import { formatAgo } from '../core/listing.ts';
import type { Party } from '../core/messages.ts';
import { ensureDir, readJson, writeJsonAtomic } from '../core/paths.ts';
import { listPeers, peerRef } from '../core/peers.ts';
import { peerStatus, statusText } from '../core/status.ts';
import { hello, pairCall } from './client.ts';
import { commitment, confirmMac, macEqual, newKeyPair, pairKey, randomNonce, shortCode, type PairTranscript } from './crypto.ts';
import { readDaemon, readSettings, runDaemon, writeSettings } from './daemon.ts';
import {
  bridgeDir,
  bridgePort,
  deviceIdentity,
  forgetDevice,
  isOnline,
  manualHosts,
  pairingDir,
  readRemoteState,
  recentEvents,
  renameDevice,
  safeName,
  setManualHosts,
  trustDevice,
  trustedDevices,
} from './state.ts';

export const BRIDGE_HELP = `telepathy bridge: reach agent sessions on your other devices.

  telepathy bridge start [--no-lan] [--no-tailscale] [--no-mdns]
  telepathy bridge stop
  telepathy bridge status            this device, and the devices it can reach
  telepathy bridge watch [--once]    live view of devices, sessions and messages
  telepathy bridge pair              accept a pairing on this device
  telepathy bridge pair <device|host[:port]>
  telepathy bridge forget <device>
  telepathy bridge add <host[:port]> / remove <host[:port]>
  telepathy bridge name <name>       what other devices call this one

Devices of your own Tailscale user are trusted as soon as both run the bridge. Other devices, such as one on
the same Wi-Fi, are paired once: both screens show the same 6-digit code and you confirm it on each.
A session on another device is addressed as <agent>:<name>@<device>, for example codex:api-c3f@laptop.`;

export async function bridgeCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'status':
      console.log(render(false));
      return 0;
    case 'start':
      return start(rest);
    case 'stop':
      return stop();
    case 'run':
      return runDaemon();
    case 'watch':
      return watch(rest.includes('--once'));
    case 'pair':
      return rest[0] ? pairWith(rest[0]) : acceptPairing();
    case 'forget':
      return forget(rest[0]);
    case 'add':
    case 'remove':
      return hosts(sub, rest[0]);
    case 'name':
      if (!rest[0]) return usage();
      console.log(`This device is now called ${renameDevice(rest[0]).name}. Restart the bridge so others see it.`);
      return 0;
    case 'deliver':
      return deliverFromStdin();
    case '--help':
    case 'help':
      console.log(BRIDGE_HELP);
      return 0;
    default:
      return usage();
  }
}

function usage(): number {
  console.error(BRIDGE_HELP);
  return 1;
}

const selfCommand = (...args: string[]) => ({
  cmd: process.execPath,
  args: [...process.execArgv, resolveArgvPath(process.argv[1] ?? ''), ...args],
});

async function start(flags: string[]): Promise<number> {
  const settings = readSettings();
  if (flags.includes('--no-lan')) settings.lan = false;
  if (flags.includes('--no-tailscale')) settings.tailscale = false;
  if (flags.includes('--no-mdns')) settings.mdns = false;
  writeSettings(settings);
  if (readDaemon()) {
    console.log(render(false));
    return 0;
  }
  ensureDir(bridgeDir());
  const log = fs.openSync(path.join(bridgeDir(), 'daemon.log'), 'a', 0o600);
  const { cmd, args } = selfCommand('bridge', 'run');
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  fs.closeSync(log);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (readDaemon()) {
      console.log(render(false));
      return 0;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error(`telepathy bridge: the daemon did not start. See ${path.join(bridgeDir(), 'daemon.log')}.`);
  return 1;
}

async function stop(): Promise<number> {
  const daemon = readDaemon();
  if (!daemon) {
    console.log('telepathy bridge is not running.');
    return 0;
  }
  process.kill(daemon.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && readDaemon()) await new Promise((resolve) => setTimeout(resolve, 100));
  console.log('telepathy bridge stopped.');
  return 0;
}

function forget(name: string | undefined): number {
  if (!name) return usage();
  const q = name.toLowerCase();
  const device =
    readRemoteState()?.devices.find((d) => d.slug === q || d.name.toLowerCase() === q || d.id === q) ??
    Object.values(trustedDevices()).find((d) => d.name.toLowerCase() === q || d.id === q);
  if (!device || !forgetDevice(device.id)) {
    console.error(`No paired device named "${name}".`);
    return 1;
  }
  console.log(`Forgot ${device.name}. It can no longer reach this device unless it is on your tailnet.`);
  return 0;
}

function hosts(sub: 'add' | 'remove', host: string | undefined): number {
  if (!host) return usage();
  const list = manualHosts();
  setManualHosts(sub === 'add' ? [...list, host] : list.filter((h) => h !== host));
  console.log(sub === 'add' ? `The bridge will look for a device at ${host}.` : `Removed ${host}.`);
  return 0;
}

/** This side shows the code, asks its user, and proves it to the device that asked. */
async function acceptPairing(): Promise<number> {
  if (!readDaemon()) {
    console.error('Start the bridge first: telepathy bridge start');
    return 1;
  }
  const self = deviceIdentity();
  const dir = ensureDir(pairingDir());
  const openFile = path.join(dir, 'open.json');
  const keepOpen = () => writeJsonAtomic(openFile, { until: Date.now() + 120_000 });
  keepOpen();
  console.log(`Pairing is open on ${self.name} for 2 minutes. On the other device run: telepathy bridge pair ${self.name}`);
  const asked = new Set<string>();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const deadline = Date.now() + 120_000;
  try {
    while (Date.now() < deadline) {
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'open.json')) {
        const id = file.slice(0, -5);
        const state = readJson<{ name: string; addr: string; code: string; state: string }>(path.join(dir, file));
        if (!state) continue;
        // The name is the other side's claim. The code goes on a line of its own the name can't reach.
        state.name = safeName(state.name);
        if (state.state === 'asking' && !asked.has(id)) {
          asked.add(id);
          const answer = await rl.question(
            `A device at ${state.addr} asks to pair.\n  Code: ${state.code}\n` +
              `It calls itself "${state.name}". Does that device show exactly this code? [y/N] `,
          );
          fs.writeFileSync(path.join(dir, `${id}.decision`), /^y(es)?$/i.test(answer.trim()) ? 'yes' : 'no');
          continue;
        }
        if (asked.has(id) && (state.state === 'paired' || state.state === 'declined')) {
          fs.rmSync(path.join(dir, file), { force: true });
          if (state.state === 'paired') {
            console.log(`Paired with ${state.name}. Its sessions appear in list_peers within a few seconds.`);
            return 0;
          }
          console.log(`Not paired with ${state.name}.`);
          return 1;
        }
      }
      keepOpen();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    console.log('Pairing closed: no device asked in time.');
    return 1;
  } finally {
    rl.close();
    fs.rmSync(openFile, { force: true });
  }
}

/** This side commits to its key, compares the code with its user, then proves it holds the key. */
async function pairWith(target: string): Promise<number> {
  const q = target.toLowerCase();
  const known = readRemoteState()?.devices.find((d) => d.slug === q || d.name.toLowerCase() === q || d.id === q);
  const addr = known?.addr ?? (target.includes(':') ? target : `${target}:${bridgePort()}`);
  const there = await hello(addr, 3000);
  if (!there) {
    console.error(`No telepathy bridge answered at ${addr}. Start it there with: telepathy bridge start`);
    return 1;
  }
  if (Object.hasOwn(trustedDevices(), there.id)) {
    console.log(`Already paired with ${there.name}.`);
    return 0;
  }
  if (!there.pairing) {
    console.error(`Pairing is not open on ${there.name}. Run \`telepathy bridge pair\` there first, then run this again.`);
    return 1;
  }
  const self = deviceIdentity();
  const keys = newKeyPair();
  const nonce = randomNonce();
  try {
    const started = await pairCall<{ session: string; id: string; name: string; publicKey: string; nonce: string }>(
      addr,
      '/v1/pair/start',
      { id: self.id, name: self.name, commit: commitment(keys.publicKey, nonce) },
      5000,
    );
    if (started.id !== there.id) throw new Error('the device changed during pairing');
    await pairCall(addr, '/v1/pair/reveal', { session: started.session, publicKey: keys.publicKey, nonce }, 5000);
    const transcript: PairTranscript = {
      initiatorId: self.id,
      responderId: started.id,
      initiatorKey: keys.publicKey,
      responderKey: started.publicKey,
      initiatorNonce: nonce,
      responderNonce: started.nonce,
    };
    const key = pairKey(keys, started.publicKey, transcript);
    const code = shortCode(transcript);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await rl.question(
        `Pairing with the device at ${addr}.\n  Code: ${code}\nIt calls itself "${safeName(started.name)}". Does it show exactly this code? [y/N] `,
      );
    } finally {
      rl.close();
    }
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Not paired.');
      return 1;
    }
    console.log(`Waiting for ${safeName(started.name)} to confirm…`);
    const done = await pairCall<{ mac: string }>(
      addr,
      '/v1/pair/confirm',
      { session: started.session, mac: confirmMac(key, 'initiator'), port: bridgePort() },
      130_000,
    );
    if (!macEqual(done.mac, confirmMac(key, 'responder'))) throw new Error('the other device could not prove the code');
    trustDevice({ id: started.id, name: safeName(started.name), key, pairedAt: new Date().toISOString(), addr });
    console.log(`Paired with ${safeName(started.name)}. Its sessions appear in list_peers within a few seconds.`);
    return 0;
  } catch (err) {
    console.error(`Pairing failed: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * `bridge deliver`: one message a trusted device relayed, read from stdin, delivered here under the confirm
 * rules with the sender's remaining time. Prints one JSON line for the daemon.
 */
async function deliverFromStdin(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { from: Party; to: string; body: string; budgetMs: number };
  // The confirm clock ends at the sender's deadline less the network margin, not 110s from now.
  beginToolCall(Date.now() + input.budgetMs - (confirmAbortMs() + confirmGraceMs()));
  const result = await deliverLocal(input.from, input.to, input.body);
  const out = result.ok
    ? {
        ok: true,
        status: result.status,
        messageId: result.message.id,
        recipient: { id: result.recipient.id, agent: result.recipient.agent, name: result.recipient.name, address: result.recipient.address },
      }
    : { ok: false, error: result.error };
  process.stdout.write(JSON.stringify(out) + '\n');
  return 0;
}

async function watch(once: boolean): Promise<number> {
  if (once || !process.stdout.isTTY) {
    console.log(render(true));
    return 0;
  }
  const draw = () => process.stdout.write(`\x1b[2J\x1b[H${render(true)}\n\n(Ctrl-C to quit)`);
  draw();
  const timer = setInterval(draw, 1000);
  return await new Promise<number>((resolve) => {
    process.once('SIGINT', () => {
      clearInterval(timer);
      process.stdout.write('\n');
      resolve(0);
    });
  });
}

/** Status and the live view: this device, its sessions, every device the daemon has seen, and recent messages. */
function render(withMessages: boolean, now = Date.now()): string {
  const self = deviceIdentity();
  const daemon = readDaemon();
  const lines: string[] = [];
  lines.push(
    daemon
      ? `telepathy bridge · ${self.name} · listening on ${daemon.listening.join(', ')}`
      : `telepathy bridge · ${self.name} · not running (telepathy bridge start)`,
  );
  const local = listPeers();
  lines.push('', `This device, ${local.length} session${local.length === 1 ? '' : 's'}:`);
  for (const peer of local) {
    const status = statusText(peerStatus(peer), now);
    lines.push(`  ${peerRef(peer)}${status ? ` · ${status}` : ''}`);
  }
  const devices = readRemoteState()?.devices ?? [];
  lines.push('', devices.length ? 'Devices:' : 'Devices: none found yet.');
  for (const device of devices) {
    const online = daemon && isOnline(device, now);
    if (!device.trusted) {
      lines.push(`  ${device.slug} · ${device.route} ${device.addr} · not paired (telepathy bridge pair ${device.slug})`);
      continue;
    }
    const trust = device.trust === 'tailscale' ? 'your tailnet' : 'paired';
    if (!online) {
      lines.push(`  ${device.slug} · ${trust} · offline, last seen ${formatAgo(now - Date.parse(device.lastSeen))}`);
      continue;
    }
    lines.push(`  ${device.slug} · ${trust} · ${device.addr} · ${device.peers.length} session${device.peers.length === 1 ? '' : 's'}`);
    for (const peer of device.peers) {
      lines.push(`    ${peer.address}@${device.slug} [${peer.id}@${device.slug}]${peer.status ? ` · ${peer.status}` : ''}`);
    }
  }
  if (withMessages) {
    const events = recentEvents(15);
    lines.push('', events.length ? 'Messages between devices:' : 'Messages between devices: none yet.');
    for (const event of events) {
      const time = new Date(event.at).toLocaleTimeString();
      const arrow = event.dir === 'out' ? `${event.from} → ${event.to}` : `${event.to} ← ${event.from}`;
      lines.push(`  ${time}  ${event.ok ? '✓' : '✗'} ${arrow}  "${safeName(event.preview, '', 160)}"`);
    }
  }
  return lines.join('\n');
}
