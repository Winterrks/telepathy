import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { makeSandbox, ROOT, type Sandbox, waitFor } from './helpers.ts';

/** Two or more sandboxed devices, each with its own bridge, for tests across devices. */

export const CLI = path.join(ROOT, 'src', 'cli.ts');

export async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export interface Device {
  name: string;
  sb: Sandbox;
  port: number;
  env: NodeJS.ProcessEnv;
  daemon?: ChildProcess;
}

export async function device(name: string, extra: NodeJS.ProcessEnv = {}): Promise<Device> {
  const sb = makeSandbox();
  const port = await freePort();
  const env = {
    ...sb.env,
    TELEPATHY_BRIDGE_PORT: String(port),
    TELEPATHY_TAILSCALE_BIN: '',
    TELEPATHY_BRIDGE_MDNS: '0',
    TELEPATHY_BRIDGE_POLL_MS: '200',
    TELEPATHY_BRIDGE_ONLINE_MS: '4000',
    ...extra,
  };
  fs.mkdirSync(path.join(sb.home, 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, 'bridge', 'settings.json'), JSON.stringify({ lan: false, tailscale: false, mdns: false }));
  assert.equal(cli(env, 'bridge', 'name', name).status, 0);
  return { name, sb, port, env };
}

export const cli = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

export function spawnCli(env: NodeJS.ProcessEnv, ...args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (out += chunk));
  const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, done, out: () => out };
}

export async function startDaemon(d: Device): Promise<void> {
  const run = spawnCli(d.env, 'bridge', 'run');
  d.daemon = run.child;
  await waitFor(() => (run.out().includes('listening on') ? true : undefined), 15_000);
}

export const remoteState = (d: Device) =>
  JSON.parse(fs.readFileSync(path.join(d.sb.home, 'bridge', 'remote.json'), 'utf8')) as {
    devices: { slug: string; trusted: boolean; lastSeen: string; peers: { address: string }[] }[];
  };

export async function pair(initiator: Device, responder: Device): Promise<void> {
  const accept = spawnCli(responder.env, 'bridge', 'pair');
  await waitFor(() => (accept.out().includes('Pairing is open') ? true : undefined));
  const ask = spawnCli(initiator.env, 'bridge', 'pair', `127.0.0.1:${responder.port}`);
  try {
    const askCode = await waitFor(() => /Code: (\d{3} \d{3})/.exec(ask.out())?.[1]);
    ask.child.stdin.write('y\n');
    const acceptCode = await waitFor(() => /asks to pair\.\n\s+Code: (\d{3} \d{3})/.exec(accept.out())?.[1]);
    assert.equal(askCode, acceptCode, 'both screens show the same code');
    accept.child.stdin.write('y\n');
    assert.equal(await ask.done, 0, ask.out());
    assert.equal(await accept.done, 0, accept.out());
  } finally {
    // A prompt that never matched leaves both waiting on stdin, which would hold the test run open.
    for (const run of [ask, accept]) if (run.child.exitCode === null) run.child.kill();
  }
}

