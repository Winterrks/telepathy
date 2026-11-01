import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveArgvPath } from '../cli/entry.ts';
import { deliveryHint } from '../core/listing.ts';
import { ensureDir, envDurationMs, readJson, writeJsonAtomic } from '../core/paths.ts';
import { isAgent } from '../core/agents.ts';
import { listPeers } from '../core/peers.ts';
import { procStart } from '../core/proc.ts';
import { peerStatus, statusText } from '../core/status.ts';
import { VERSION } from '../core/version.ts';
import { call, type Hello, hello, requestAad, responseAad, type WireRequest, type WireResponse } from './client.ts';
import { commitment, confirmMac, type KeyPair, macEqual, newKeyPair, open, pairKey, randomNonce, seal, shortCode, type PairTranscript } from './crypto.ts';
import { startMdns } from './mdns.ts';
import {
  bridgeDir,
  bridgePort,
  DEVICE_ID,
  daemonFile,
  deviceIdentity,
  logEvent,
  manualHosts,
  pairingDir,
  preview,
  PROTOCOL,
  readRemoteState,
  type RemoteDevice,
  type RemotePeerWire,
  type Route,
  safeName,
  trustDevice,
  trustedDevices,
  uniqueSlug,
  writeRemoteState,
} from './state.ts';
import { isTailscaleIp, sameTailnetUser, type Tailnet, tailnet } from './tailscale.ts';

export interface BridgeSettings {
  lan: boolean;
  tailscale: boolean;
  mdns: boolean;
}

const settingsFile = () => path.join(bridgeDir(), 'settings.json');

export function readSettings(): BridgeSettings {
  const stored = readJson<Partial<BridgeSettings>>(settingsFile()) ?? {};
  return {
    lan: stored.lan ?? true,
    tailscale: stored.tailscale ?? true,
    mdns: process.env.TELEPATHY_BRIDGE_MDNS === '0' ? false : (stored.mdns ?? true),
  };
}

export function writeSettings(settings: BridgeSettings): void {
  ensureDir(bridgeDir());
  writeJsonAtomic(settingsFile(), settings);
}

export interface DaemonRecord {
  pid: number;
  procStart?: string;
  port: number;
  startedAt: string;
  listening: string[];
}

export function readDaemon(): DaemonRecord | undefined {
  const record = readJson<DaemonRecord>(daemonFile());
  if (!record) return undefined;
  try {
    process.kill(record.pid, 0);
  } catch {
    return undefined;
  }
  const start = procStart(record.pid);
  return !record.procStart || !start || start === record.procStart ? record : undefined;
}

const pollMs = () => envDurationMs('TELEPATHY_BRIDGE_POLL_MS', 3000);
const SKEW_MS = 120_000;
const MAX_LAN_FOUND = 64;
// A 100,000-character message of multibyte text, sealed and base64-encoded, fits.
const MAX_BODY = 2 * 1024 * 1024;

/** One line, at most `max` characters: what another device says ends up in listings agents read. */
const clean = (value: unknown, max: number) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);

/** An id or address from another device: the characters local addresses use, so it can't break a tag or a quote. */
const ADDRESS = /^[\p{L}\p{N}._:-]{1,200}$/u;

function cleanPeer(raw: RemotePeerWire): RemotePeerWire[] {
  if (!raw || typeof raw !== 'object' || !isAgent(raw.agent)) return [];
  if (typeof raw.id !== 'string' || !ADDRESS.test(raw.id) || typeof raw.address !== 'string' || !ADDRESS.test(raw.address)) return [];
  return [
    {
      id: raw.id,
      agent: raw.agent,
      name: safeName(raw.name, raw.address).slice(0, 120),
      address: raw.address,
      cwd: raw.cwd ? clean(raw.cwd, 300) : undefined,
      status: raw.status ? clean(raw.status, 80) : undefined,
      delivery: raw.delivery ? clean(raw.delivery, 160) : undefined,
      startedAt: raw.startedAt ? clean(raw.startedAt, 40) : undefined,
    },
  ];
}

const isPrivateV4 = (ip: string) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip);

/** Where the bridge listens: loopback, this machine's tailnet address, and its private LAN addresses. Never 0.0.0.0. */
function listenAddresses(settings: BridgeSettings): string[] {
  const out = new Set<string>(['127.0.0.1']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (isTailscaleIp(a.address)) {
        if (settings.tailscale) out.add(a.address);
      } else if (settings.lan && isPrivateV4(a.address)) {
        out.add(a.address);
      }
    }
  }
  return [...out];
}

const lanAddresses = (settings: BridgeSettings) => listenAddresses(settings).filter((ip) => ip !== '127.0.0.1' && !isTailscaleIp(ip));

/** What this device tells a trusted device about its sessions. */
export function localPeersWire(): RemotePeerWire[] {
  return listPeers().map((peer) => ({
    id: peer.id,
    agent: peer.agent,
    name: peer.name,
    address: peer.address,
    cwd: peer.cwd,
    status: statusText(peerStatus(peer)),
    delivery: deliveryHint(peer),
    startedAt: peer.procStart ?? peer.startedAt,
  }));
}

interface PairSession {
  id: string;
  initiator: { id: string; name: string; addr: string };
  commit: string;
  keys: KeyPair;
  nonce: string;
  created: number;
  key?: string;
  code?: string;
}

const pairingOpen = () => {
  const open = readJson<{ until?: number }>(path.join(pairingDir(), 'open.json'));
  return !!open?.until && open.until > Date.now();
};

export async function runDaemon(): Promise<number> {
  const self = deviceIdentity();
  const settings = readSettings();
  const port = bridgePort();
  const running = readDaemon();
  if (running && running.pid !== process.pid) {
    console.error(`telepathy bridge: already running (pid ${running.pid}).`);
    return 1;
  }

  const startedMs = Date.now();
  const seenNonces = new Map<string, number>();
  const pairs = new Map<string, PairSession>();
  let net: Tailnet | undefined;
  let netAt = 0;
  const currentTailnet = async () => {
    if (!settings.tailscale) return undefined;
    if (Date.now() - netAt > 10_000) {
      net = await tailnet();
      netAt = Date.now();
    }
    return net;
  };

  /** A request from a paired device (sealed) or from a device of the same user on the tailnet (plain). */
  const authenticate = async (req: http.IncomingMessage, wire: WireRequest, route: string) => {
    if (typeof wire.device !== 'string' || !DEVICE_ID.test(wire.device)) return { error: 'malformed request' };
    if (wire.sealed) {
      const trusted = trustedDevices();
      const key = Object.hasOwn(trusted, wire.device) ? trusted[wire.device].key : undefined;
      if (!key) return { error: 'not paired with this device' };
      if (typeof wire.sealed.t !== 'number' || Math.abs(Date.now() - wire.sealed.t) > SKEW_MS) {
        return { error: 'request is too old; check both clocks' };
      }
      // The replay cache lives in memory. A request sealed before this daemon started could be a replay it never saw.
      if (wire.sealed.t < startedMs) return { error: 'request predates this bridge; send it again' };
      const replayKey = `${wire.device}:${wire.sealed.n}`;
      if (seenNonces.has(replayKey)) return { error: 'replayed request' };
      let body: unknown;
      try {
        body = open<unknown>(key, requestAad(route, wire.device, self.id), wire.sealed);
      } catch {
        return { error: 'could not open the request' };
      }
      seenNonces.set(replayKey, Date.now());
      return { body, key, nonce: wire.sealed.n };
    }
    const remote = req.socket.remoteAddress ?? '';
    const local = req.socket.localAddress ?? '';
    const tn = await currentTailnet();
    if (!tn || !isTailscaleIp(local) || !isTailscaleIp(remote) || !(await sameTailnetUser(remote.replace(/^::ffff:/, ''), tn.userId))) {
      return { error: 'not trusted: pair with `telepathy bridge pair`, or use a device of the same Tailscale user' };
    }
    return { body: wire.body };
  };

  /** How this device names the sender: its slug from the last discovery pass, or one made from its name now. */
  const senderSlug = (id: string, name: string) => {
    const devices = readRemoteState()?.devices ?? [];
    const known = devices.find((d) => d.id === id);
    if (known) return known.slug;
    return uniqueSlug(name, id, new Set(devices.map((d) => d.slug)));
  };

  const deliver = (payload: unknown, budgetMs: number): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const entry = resolveArgvPath(process.argv[1] ?? '');
      const child = spawn(process.execPath, [...process.execArgv, entry, 'bridge', 'deliver'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.resume();
      const timer = setTimeout(() => child.kill('SIGKILL'), budgetMs + 5000);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `Message failed: the bridge could not start delivery (${err.message}).` });
      });
      // 'close', not 'exit': stdout may still hold the answer when the process exits.
      child.on('close', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '') as Record<string, unknown>);
        } catch {
          resolve({ ok: false, error: 'Message failed: delivery on this device ended without an answer.' });
        }
      });
      child.stdin.end(JSON.stringify(payload));
    });

  const handlers: Record<string, (req: http.IncomingMessage, raw: unknown) => Promise<WireResponse>> = {
    '/v1/peers': async (req, raw) => {
      const wire = raw as WireRequest;
      const auth = await authenticate(req, wire, '/v1/peers');
      if ('error' in auth) return { error: auth.error };
      return reply(auth, wire, '/v1/peers', { peers: localPeersWire() });
    },
    '/v1/send': async (req, raw) => {
      const wire = raw as WireRequest;
      const auth = await authenticate(req, wire, '/v1/send');
      if ('error' in auth) return { error: auth.error };
      const input = (auth.body ?? {}) as { from?: { id?: string; agent?: string; name?: string; address?: string }; to?: unknown; body?: unknown; budgetMs?: unknown };
      const from = input.from;
      const valid =
        typeof from?.id === 'string' && ADDRESS.test(from.id) && typeof from.address === 'string' && ADDRESS.test(from.address);
      if (!valid || !isAgent(from?.agent) || !from?.name || typeof input.to !== 'string' || typeof input.body !== 'string') {
        return reply(auth, wire, '/v1/send', { ok: false, error: 'Message failed: malformed request.' });
      }
      const slug = senderSlug(wire.device, safeName(wire.name));
      const qualified = {
        id: `${from.id}@${slug}`,
        agent: from.agent,
        name: safeName(from.name, from.address).slice(0, 120),
        address: `${from.address}@${slug}`,
      };
      const budgetMs = Math.max(1000, Math.min(110_000, Number(input.budgetMs) || 0));
      const result = await deliver({ from: qualified, to: input.to, body: input.body, budgetMs }, budgetMs);
      const recipient = (result.recipient as { address?: string } | undefined)?.address ?? input.to;
      logEvent({
        dir: 'in',
        device: slug,
        from: qualified.address,
        to: recipient,
        ok: result.ok === true,
        status: String(result.ok ? result.status : result.error),
        preview: preview(input.body),
      });
      return reply(auth, wire, '/v1/send', result);
    },
    '/v1/pair/start': async (req, raw) => {
      const body = raw as { id?: string; name?: string; commit?: string };
      if (!pairingOpen()) return { error: `pairing is not open on ${self.name}; run \`telepathy bridge pair\` there first` };
      if (typeof body.id !== 'string' || !DEVICE_ID.test(body.id) || typeof body.commit !== 'string' || !body.commit) {
        return { error: 'malformed pairing request' };
      }
      if (pairs.size >= 4) return { error: 'too many pairing attempts; try again in a minute' };
      const session: PairSession = {
        id: randomNonce().replace(/[^a-zA-Z0-9]/g, '').slice(0, 16),
        initiator: { id: body.id, name: safeName(body.name), addr: req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '' },
        commit: body.commit,
        keys: newKeyPair(),
        nonce: randomNonce(),
        created: Date.now(),
      };
      pairs.set(session.id, session);
      return { body: { session: session.id, id: self.id, name: self.name, publicKey: session.keys.publicKey, nonce: session.nonce } };
    },
    '/v1/pair/reveal': async (_req, raw) => {
      const body = raw as { session?: string; publicKey?: string; nonce?: string };
      const session = body.session ? pairs.get(body.session) : undefined;
      if (!session || !body.publicKey || !body.nonce) return { error: 'unknown pairing session' };
      if (commitment(body.publicKey, body.nonce) !== session.commit) {
        pairs.delete(session.id);
        return { error: 'the key does not match its commitment' };
      }
      const transcript: PairTranscript = {
        initiatorId: session.initiator.id,
        responderId: self.id,
        initiatorKey: body.publicKey,
        responderKey: session.keys.publicKey,
        initiatorNonce: body.nonce,
        responderNonce: session.nonce,
      };
      try {
        session.key = pairKey(session.keys, body.publicKey, transcript);
      } catch {
        pairs.delete(session.id);
        return { error: 'bad public key' };
      }
      session.code = shortCode(transcript);
      writeJsonAtomic(path.join(ensureDir(pairingDir()), `${session.id}.json`), {
        name: session.initiator.name,
        addr: session.initiator.addr,
        code: session.code,
        state: 'asking',
      });
      return { body: { ok: true } };
    },
    '/v1/pair/confirm': async (_req, raw) => {
      const body = raw as { session?: string; mac?: string; port?: number };
      const session = body.session ? pairs.get(body.session) : undefined;
      if (!session?.key || !body.mac) return { error: 'unknown pairing session' };
      if (!macEqual(body.mac, confirmMac(session.key, 'initiator'))) {
        pairs.delete(session.id);
        return { error: 'pairing proof did not match' };
      }
      const stateFile = path.join(pairingDir(), `${session.id}.json`);
      const decisionFile = path.join(pairingDir(), `${session.id}.decision`);
      const deadline = Date.now() + 120_000;
      let decision: string | undefined;
      while (Date.now() < deadline) {
        try {
          decision = fs.readFileSync(decisionFile, 'utf8').trim();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      pairs.delete(session.id);
      fs.rmSync(decisionFile, { force: true });
      if (decision !== 'yes') {
        writeJsonAtomic(stateFile, { ...readJson<Record<string, unknown>>(stateFile), state: 'declined' });
        return { error: `${self.name} did not confirm the code` };
      }
      const peerPort = Number(body.port) || bridgePort();
      trustDevice({
        id: session.initiator.id,
        name: session.initiator.name,
        key: session.key,
        pairedAt: new Date().toISOString(),
        addr: `${session.initiator.addr}:${peerPort}`,
      });
      writeJsonAtomic(stateFile, { ...readJson<Record<string, unknown>>(stateFile), state: 'paired' });
      return { body: { mac: confirmMac(session.key, 'responder') } };
    },
  };

  function reply(auth: { key?: string; nonce?: string }, wire: WireRequest, route: string, value: unknown): WireResponse {
    if (!auth.key || !auth.nonce) return { body: value };
    return { sealed: seal(auth.key, responseAad(route, wire.device, self.id, auth.nonce), value) };
  }

  const helloBody = (): Hello => ({ protocol: PROTOCOL, id: self.id, name: self.name, version: VERSION, pairing: pairingOpen() });

  const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/v1/hello') return send(200, helloBody());
    const handler = handlers[url];
    if (req.method !== 'POST' || !handler) return send(404, { error: 'not found' });
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        send(413, { error: 'request too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'bad JSON' });
      }
      handler(req, raw).then(
        (out) => send(out.error ? 403 : 200, out),
        (err: Error) => send(500, { error: err.message }),
      );
    });
  };

  const servers = new Map<string, http.Server>();
  const syncListeners = async () => {
    const want = new Set(listenAddresses(settings));
    for (const [addr, server] of servers) {
      if (!want.has(addr)) {
        server.close();
        servers.delete(addr);
      }
    }
    for (const addr of want) {
      if (servers.has(addr)) continue;
      const server = http.createServer(handle);
      server.requestTimeout = 130_000;
      await new Promise<void>((resolve) => {
        server.once('error', () => resolve());
        server.listen(port, addr, () => {
          servers.set(addr, server);
          resolve();
        });
      });
    }
    writeJsonAtomic(daemonFile(), {
      pid: process.pid,
      procStart: procStart(process.pid),
      port,
      startedAt,
      listening: [...servers.keys()].map((addr) => `${addr}:${port}`),
    } satisfies DaemonRecord);
  };

  const startedAt = new Date(startedMs).toISOString();
  ensureDir(bridgeDir());
  await syncListeners();
  if (!servers.has('127.0.0.1')) {
    console.error(`telepathy bridge: port ${port} is in use. Set TELEPATHY_BRIDGE_PORT to another port on every device.`);
    for (const server of servers.values()) server.close();
    fs.rmSync(daemonFile(), { force: true });
    return 1;
  }

  // Devices found on the local network by mDNS, by address.
  const lanFound = new Map<string, { id: string; at: number }>();
  const stopMdns = settings.mdns && settings.lan
    ? startMdns(self, port, () => lanAddresses(settings), (found) => {
        // Anyone on the LAN can answer mDNS. Keep the list bounded; each entry costs a hello per pass.
        if (!lanFound.has(found.addr) && lanFound.size >= MAX_LAN_FOUND) return;
        lanFound.set(found.addr, { id: found.id, at: Date.now() });
      })
    : () => {};

  let discovering = false;
  const discover = async () => {
    if (discovering) return;
    discovering = true;
    try {
      const tn = await currentTailnet();
      const candidates = new Map<string, Route>();
      for (const peer of tn?.peers ?? []) if (peer.online) candidates.set(`${peer.ip}:${port}`, 'tailscale');
      for (const [addr, found] of lanFound) {
        if (Date.now() - found.at > 60_000) lanFound.delete(addr);
        else if (!candidates.has(addr)) candidates.set(addr, 'lan');
      }
      for (const host of manualHosts()) {
        const addr = host.includes(':') ? host : `${host}:${port}`;
        if (!candidates.has(addr)) candidates.set(addr, 'manual');
      }
      for (const device of Object.values(trustedDevices())) {
        if (device.addr && !candidates.has(device.addr)) candidates.set(device.addr, isTailscaleIp(device.addr.split(':')[0]) ? 'tailscale' : 'lan');
      }

      const answers = await Promise.all(
        [...candidates].map(async ([addr, route]) => ({ addr, route, hello: await hello(addr) })),
      );
      const previous = new Map((readRemoteState()?.devices ?? []).map((d) => [d.id, d]));
      const trusted = trustedDevices();
      const byId = new Map<string, { addr: string; route: Route; hello: Hello }>();
      for (const answer of answers) {
        if (!answer.hello || answer.hello.id === self.id) continue;
        const prior = byId.get(answer.hello.id);
        // One device can answer on its tailnet and LAN addresses. The tailnet one is trusted without a key.
        if (!prior || (answer.route === 'tailscale' && prior.route !== 'tailscale')) {
          byId.set(answer.hello.id, { addr: answer.addr, route: answer.route, hello: answer.hello });
        }
      }

      const now = new Date().toISOString();
      const updated = new Map(previous);
      await Promise.all(
        [...byId].map(async ([id, seen]) => {
          const paired = Object.hasOwn(trusted, id);
          const trust: RemoteDevice['trust'] = paired ? 'paired' : seen.route === 'tailscale' ? 'tailscale' : undefined;
          const before = previous.get(id);
          const base: RemoteDevice = {
            id,
            name: seen.hello.name,
            slug: before?.slug ?? '',
            addr: seen.addr,
            route: seen.route,
            trusted: !!trust,
            trust,
            lastSeen: before?.lastSeen ?? now,
            version: seen.hello.version,
            peers: before?.peers ?? [],
          };
          if (!trust) {
            updated.set(id, { ...base, lastSeen: now, peers: [] });
            return;
          }
          try {
            const listed = await call<{ peers: RemotePeerWire[] }>({ id, addr: seen.addr, trust }, '/v1/peers', {}, 2500);
            updated.set(id, { ...base, lastSeen: now, peers: Array.isArray(listed.peers) ? listed.peers.flatMap(cleanPeer) : [] });
            // Re-read: a `bridge forget` during this pass must not be undone by the snapshot.
            const current = trustedDevices();
            if (paired && Object.hasOwn(current, id) && current[id].addr !== seen.addr) trustDevice({ ...current[id], addr: seen.addr });
          } catch {
            updated.set(id, base);
          }
        }),
      );

      const day = Date.now() - 86_400_000;
      const devices = [...updated.values()].filter((d) => Date.parse(d.lastSeen) > day || Object.hasOwn(trusted, d.id));
      const taken = new Set<string>();
      for (const device of devices.sort((a, b) => a.id.localeCompare(b.id))) {
        const keep = device.slug && !taken.has(device.slug) ? device.slug : uniqueSlug(device.name, device.id, taken);
        device.slug = keep;
        taken.add(keep);
      }
      writeRemoteState({ at: now, devices });

      for (const [nonce, at] of seenNonces) if (Date.now() - at > 2 * SKEW_MS) seenNonces.delete(nonce);
      for (const [id, session] of pairs) if (Date.now() - session.created > 180_000) pairs.delete(id);
    } finally {
      discovering = false;
    }
  };

  // A pass that throws must not take the daemon down; the next one tries again.
  const discoverSafely = () => discover().catch((err: Error) => console.error(`telepathy bridge: discovery failed: ${err.message}`));
  await discoverSafely();
  const poll = setInterval(() => void discoverSafely(), pollMs());
  const rebind = setInterval(() => void syncListeners(), 15_000);
  console.log(
    `telepathy bridge: ${self.name} (${self.id}) listening on ${[...servers.keys()].map((a) => `${a}:${port}`).join(', ')}`,
  );

  return await new Promise<number>((resolve) => {
    const stop = () => {
      clearInterval(poll);
      clearInterval(rebind);
      stopMdns();
      for (const server of servers.values()) server.close();
      const record = readJson<DaemonRecord>(daemonFile());
      if (record?.pid === process.pid) fs.rmSync(daemonFile(), { force: true });
      resolve(0);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

