import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { autoUpdateEnabled, scheduleAutoUpdate } from '../auto-update.ts';
import { resolveArgvPath } from '../cli/entry.ts';
import { deliveryHint } from '../core/listing.ts';
import { ensureDir, envDurationMs, readJson, writeJsonAtomic } from '../core/paths.ts';
import { isAgent } from '../core/agents.ts';
import { isNewer } from '../core/installs.ts';
import { listPeers } from '../core/peers.ts';
import { procStart } from '../core/proc.ts';
import { peerStatus, statusText } from '../core/status.ts';
import { VERSION } from '../core/version.ts';
import {
  call,
  type Hello,
  hello,
  REVERSE_ROUTES,
  requestAad,
  responseAad,
  type Target,
  type WireRequest,
  type WireResponse,
} from './client.ts';
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
  onlineWindowMs,
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
import { type BridgeInfo, isVersion, parseBridgeInfo, restartWaitMs, watchInstall } from './update.ts';

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
  /** The version this bridge runs. Bridges before 0.11.2 leave it out. */
  version?: string;
  /**
   * A newer version is installed where this bridge restarts from. It restarts at `at` (ms since epoch), once the
   * devices it reaches have that version too or `until` passes.
   */
  restart?: { into: string; at?: number; waitingFor: string[]; until: number };
  /** A version this bridge could not restart into. It stays on `version` until another one is installed. */
  failedInto?: string;
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

/**
 * A device that can't accept connections (a firewall, NAT) keeps a request open to each device it can reach.
 * This is how long that request waits here for something to carry back; it stays inside the online window.
 */
const holdMs = () => Math.min(envDurationMs('TELEPATHY_BRIDGE_HOLD_MS', 10_000), Math.max(500, onlineWindowMs() / 2));
/**
 * A request for such a device leaves within this or fails as never sent. Its sender's deadline is counted from
 * when it asked, so a request may not sit here longer than the margin the sender keeps back.
 */
const PICKUP_MS = 1_000;
const MAX_REVERSE_BATCH = 16;
/** A delivery in flight when a restart is due finishes first; it answers inside its sender's 110s at most. */
const RESTART_GRACE_MS = 130_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The two ends of a request: its socket's addresses, or, for one that came back over a reverse connection, the address this device dialed. */
interface Conn {
  remote: string;
  local: string;
}
const v4 = (addr: string | undefined) => (addr ?? '').replace(/^::ffff:/, '');
const hostOf = (addr: string) => addr.replace(/:\d+$/, '');

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
  const entry = resolveArgvPath(process.argv[1] ?? '');
  // Updates and restarts. A build from a checkout (0.0.0-dev) has no version to update toward or restart into.
  const versioned = VERSION !== '0.0.0-dev';
  let installed = VERSION;
  let failedInto: string | undefined;
  let pendingSince = 0;
  let restartAt = 0;
  let restartTimer: NodeJS.Timeout | undefined;
  let waitingFor: string[] = [];
  /** Requests a restart must not cut: deliveries, requests waiting on a reverse connection, ones served over one. */
  let busy = 0;
  /** True while the loops and listeners are down for a restart. */
  let paused = false;
  const bridgeInfo = (): BridgeInfo => ({
    version: VERSION,
    installed: installed !== VERSION ? installed : undefined,
    autoUpdate: autoUpdateEnabled(),
    restartInMs: restartAt ? Math.max(0, restartAt - Date.now()) : undefined,
  });
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
  const authenticate = async (conn: Conn, wire: WireRequest, route: string) => {
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
    const tn = await currentTailnet();
    if (!tn || !isTailscaleIp(conn.local) || !isTailscaleIp(conn.remote) || !(await sameTailnetUser(conn.remote, tn.userId))) {
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

  // Reverse connections, on the side that is reached: the device that keeps a request open here, by id.
  interface Outgoing {
    id: string;
    route: string;
    wire: WireRequest;
  }
  interface Link {
    name: string;
    trust: 'tailscale' | 'paired';
    addr: string;
    version: string;
    /** What it said about its version, and when that arrived here. */
    info?: BridgeInfo;
    infoAt: number;
    peers: RemotePeerWire[];
    seenAt: number;
    /** Ends the request that device has waiting here now, if any. */
    release?: () => void;
    queue: Outgoing[];
    waiting: Map<string, (response: WireResponse) => void>;
  }
  const links = new Map<string, Link>();
  /** When this device last reached each device directly. */
  const directAt = new Map<string, number>();
  const reachedDirectly = (id: string) => Date.now() - (directAt.get(id) ?? 0) < onlineWindowMs();
  const linkFresh = (link: Link) => !!link.release || Date.now() - link.seenAt < onlineWindowMs();

  const handlers: Record<string, (conn: Conn, raw: unknown, gone?: AbortSignal) => Promise<WireResponse>> = {
    '/v1/peers': async (conn, raw) => {
      const wire = raw as WireRequest;
      const auth = await authenticate(conn, wire, '/v1/peers');
      if ('error' in auth) return { error: auth.error };
      return reply(auth, wire, '/v1/peers', { peers: localPeersWire(), bridge: bridgeInfo() });
    },
    '/v1/send': async (conn, raw) => {
      const wire = raw as WireRequest;
      const auth = await authenticate(conn, wire, '/v1/send');
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
      busy++;
      let result: Record<string, unknown>;
      try {
        result = await deliver({ from: qualified, to: input.to, body: input.body, budgetMs }, budgetMs);
      } finally {
        busy--;
      }
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
    '/v1/pair/start': async (conn, raw) => {
      const body = raw as { id?: string; name?: string; commit?: string };
      if (!pairingOpen()) return { error: `pairing is not open on ${self.name}; run \`telepathy bridge pair\` there first` };
      if (typeof body.id !== 'string' || !DEVICE_ID.test(body.id) || typeof body.commit !== 'string' || !body.commit) {
        return { error: 'malformed pairing request' };
      }
      if (pairs.size >= 4) return { error: 'too many pairing attempts; try again in a minute' };
      const session: PairSession = {
        id: randomNonce().replace(/[^a-zA-Z0-9]/g, '').slice(0, 16),
        initiator: { id: body.id, name: safeName(body.name), addr: conn.remote },
        commit: body.commit,
        keys: newKeyPair(),
        nonce: randomNonce(),
        created: Date.now(),
      };
      pairs.set(session.id, session);
      return { body: { session: session.id, id: self.id, name: self.name, publicKey: session.keys.publicKey, nonce: session.nonce } };
    },
    '/v1/pair/reveal': async (_conn, raw) => {
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
    '/v1/pair/confirm': async (_conn, raw) => {
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
    // A device this one could not connect to, asking for requests to carry back. It is authenticated like any
    // request, and what it carries back is checked on that device as if it had come in directly.
    '/v1/reverse': async (conn, raw, gone) => {
      const wire = raw as WireRequest;
      const auth = await authenticate(conn, wire, '/v1/reverse');
      if ('error' in auth) return { error: auth.error };
      const input = (auth.body ?? {}) as { peers?: unknown; version?: unknown; bridge?: unknown };
      const link: Link = links.get(wire.device) ?? {
        name: '',
        trust: 'tailscale',
        addr: '',
        version: '?',
        infoAt: 0,
        peers: [],
        seenAt: 0,
        queue: [],
        waiting: new Map(),
      };
      link.name = safeName(wire.name);
      link.trust = auth.key ? 'paired' : 'tailscale';
      link.addr = conn.remote;
      link.version = safeName(input.version, '?').slice(0, 20);
      // Read on arrival: a restart time in it counts from when it was sent, not from when its hold ends.
      link.info = parseBridgeInfo(input.bridge);
      link.infoAt = Date.now();
      link.peers = Array.isArray(input.peers) ? (input.peers as RemotePeerWire[]).slice(0, 500).flatMap(cleanPeer) : [];
      link.seenAt = Date.now();
      links.set(wire.device, link);
      if (!reachedDirectly(wire.device)) {
        // One waiting request per device: a newer one means the older connection is gone.
        link.release?.();
        if (!link.queue.length) {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              gone?.removeEventListener('abort', done);
              if (link.release === done) link.release = undefined;
              resolve();
            };
            const timer = setTimeout(done, holdMs());
            link.release = done;
            gone?.addEventListener('abort', done);
          });
        }
        link.seenAt = Date.now();
        // Its connection closed while it waited: whatever is queued waits for the next one.
        if (gone?.aborted) return { error: 'closed' };
      }
      const requests = link.queue.splice(0, MAX_REVERSE_BATCH);
      return reply(auth, wire, '/v1/reverse', { direct: reachedDirectly(wire.device), requests });
    },
    '/v1/reverse/done': async (conn, raw) => {
      const wire = raw as WireRequest;
      const auth = await authenticate(conn, wire, '/v1/reverse/done');
      if ('error' in auth) return { error: auth.error };
      const input = (auth.body ?? {}) as { id?: unknown; response?: unknown };
      const finish = typeof input.id === 'string' ? links.get(wire.device)?.waiting.get(input.id) : undefined;
      const valid = !!input.response && typeof input.response === 'object';
      if (finish && valid) finish(input.response as WireResponse);
      return reply(auth, wire, '/v1/reverse/done', { ok: !!finish && valid });
    },
    // This machine's own processes, handing a request for a device reached in reverse. Loopback only: anything
    // that arrives on another address is not this machine's.
    '/v1/outbox': async (conn, raw) => {
      if (conn.local !== '127.0.0.1' || conn.remote !== '127.0.0.1') return { error: 'not found' };
      const input = raw as { device?: unknown; route?: unknown; wire?: unknown; timeoutMs?: unknown };
      if (typeof input.route !== 'string' || !REVERSE_ROUTES.includes(input.route) || !input.wire || typeof input.wire !== 'object') {
        return { error: 'malformed request' };
      }
      const link = typeof input.device === 'string' ? links.get(input.device) : undefined;
      if (!link || !linkFresh(link)) return { error: 'it is not connected to this device right now', unreachable: true };
      const outgoing: Outgoing = { id: randomUUID(), route: input.route, wire: input.wire as WireRequest };
      const timeoutMs = Math.max(1000, Math.min(130_000, Number(input.timeoutMs) || 0));
      busy++;
      return await new Promise<WireResponse>((resolve) => {
        let settled = false;
        const finish = (response: WireResponse) => {
          if (settled) return;
          settled = true;
          busy--;
          clearTimeout(pickup);
          clearTimeout(timer);
          link.waiting.delete(outgoing.id);
          resolve(response);
        };
        const pickup = setTimeout(() => {
          const at = link.queue.indexOf(outgoing);
          if (at < 0) return;
          link.queue.splice(at, 1);
          finish({ error: 'it did not pick the request up, so nothing reached it', unreachable: true });
        }, PICKUP_MS);
        const timer = setTimeout(() => finish({ error: 'it did not answer in time' }), timeoutMs);
        link.waiting.set(outgoing.id, finish);
        link.queue.push(outgoing);
        link.release?.();
      });
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
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      handler({ remote: v4(req.socket.remoteAddress), local: v4(req.socket.localAddress) }, raw, gone.signal).then(
        (out) => {
          if (!res.destroyed) send(out.error ? 403 : 200, out);
        },
        (err: Error) => {
          if (!res.destroyed) send(500, { error: err.message });
        },
      );
    });
  };

  const servers = new Map<string, http.Server>();
  const startedAt = new Date(startedMs).toISOString();
  const ownProcStart = procStart(process.pid);
  let lastRecord = '';
  /** daemon.json: where this bridge listens, the version it runs, and when it restarts into a newer one. */
  const writeRecord = () => {
    if (paused) return;
    const record: DaemonRecord = {
      pid: process.pid,
      procStart: ownProcStart,
      port,
      startedAt,
      listening: [...servers.keys()].map((addr) => `${addr}:${port}`),
      version: VERSION,
      restart:
        installed !== VERSION && installed !== failedInto
          ? { into: installed, at: restartAt || undefined, waitingFor, until: pendingSince + restartWaitMs() }
          : undefined,
      failedInto,
    };
    const text = JSON.stringify(record);
    if (text === lastRecord && fs.existsSync(daemonFile())) return;
    lastRecord = text;
    writeJsonAtomic(daemonFile(), record);
  };
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
          // Stopped for a restart while this bound: the new bridge needs the port.
          if (paused) server.close();
          else servers.set(addr, server);
          resolve();
        });
      });
    }
    writeRecord();
  };

  // Devices found on the local network by mDNS, by address.
  const lanFound = new Map<string, { id: string; at: number }>();
  const startLan = () =>
    settings.mdns && settings.lan
      ? startMdns(self, port, () => lanAddresses(settings), (found) => {
          // Anyone on the LAN can answer mDNS. Keep the list bounded; each entry costs a hello per pass.
          if (!lanFound.has(found.addr) && lanFound.size >= MAX_LAN_FOUND) return;
          lanFound.set(found.addr, { id: found.id, at: Date.now() });
        })
      : () => {};

  // Reverse connections, on the side that can't be reached: one open request to each device this one reaches.
  let stopping = new AbortController();
  const reverseLoops = new Map<string, { running: boolean; retryAt: number }>();
  /** What each device said last about reaching this one. */
  const reachesUs = new Map<string, { how: 'direct' | 'reverse'; at: number }>();

  const serveReverse = async (target: Target, request: { id?: unknown; route?: unknown; wire?: unknown }) => {
    if (typeof request.id !== 'string' || typeof request.route !== 'string' || !REVERSE_ROUTES.includes(request.route)) return;
    const wire = request.wire as WireRequest | undefined;
    let response: WireResponse;
    busy++;
    try {
      if (!wire || typeof wire !== 'object' || wire.device !== target.id) {
        response = { error: 'malformed request' };
      } else {
        // It came over the connection this device opened to that address, so it is checked as a request from there.
        const remote = hostOf(target.addr);
        const tn = isTailscaleIp(remote) ? await currentTailnet() : undefined;
        const local = tn?.selfIps.find((ip) => ip.includes('.')) ?? '';
        try {
          response = await handlers[request.route]({ remote, local }, wire);
        } catch (err) {
          response = { error: (err as Error).message };
        }
      }
      await call(target, '/v1/reverse/done', { id: request.id, response }, 10_000, stopping.signal).catch(() => {});
    } finally {
      busy--;
    }
  };

  const runReverse = async (target: Target, state: { running: boolean; retryAt: number }) => {
    state.running = true;
    const { signal } = stopping;
    try {
      while (!signal.aborted) {
        let answer: { direct?: unknown; requests?: unknown };
        try {
          answer = await call(
            target,
            '/v1/reverse',
            { peers: localPeersWire(), version: VERSION, bridge: bridgeInfo() },
            Math.max(holdMs(), 10_000) + 5000,
            signal,
          );
        } catch (err) {
          // A bridge from before 0.11.1 has no reverse route; don't ask it on every pass.
          state.retryAt = Date.now() + (/not found/.test((err as Error).message) ? 300_000 : pollMs());
          return;
        }
        reachesUs.set(target.id, { how: answer.direct === true ? 'direct' : 'reverse', at: Date.now() });
        const requests = Array.isArray(answer.requests) ? answer.requests.slice(0, MAX_REVERSE_BATCH) : [];
        for (const request of requests) void serveReverse(target, (request ?? {}) as { id?: unknown });
        // It reaches this device directly now; the next discovery pass asks again.
        if (answer.direct === true) return;
      }
    } finally {
      state.running = false;
    }
  };

  const ensureReverse = (target: Target) => {
    const state = reverseLoops.get(target.id) ?? { running: false, retryAt: 0 };
    reverseLoops.set(target.id, state);
    if (state.running || Date.now() < state.retryAt || stopping.signal.aborted) return;
    void runReverse(target, state);
  };

  /** A trusted device this one reached in this pass, and the version it has. */
  interface Participant {
    name: string;
    /** The version it has installed, or runs when nothing newer is installed. */
    has: string;
    autoUpdate: boolean;
    /** When it restarts into `has`, on this device's clock. */
    restartAt?: number;
  }
  const participantOf = (info: BridgeInfo, name: string, heardAt: number): Participant => ({
    name,
    has: info.installed ?? info.version,
    autoUpdate: info.autoUpdate,
    restartAt: info.restartInMs !== undefined ? heardAt + info.restartInMs : undefined,
  });

  // Another device has a newer version: check for updates here now instead of at the next daily check. What gets
  // installed comes from npm and GitHub, never from that device, so a device that claims too much costs one check.
  const checkedFor = new Map<string, number>();
  let lastCheck = 0;
  const checkForUpdates = (version: string, from: string) => {
    const now = Date.now();
    if (now - (checkedFor.get(version) ?? 0) < 3_600_000 || now - lastCheck < 60_000) return;
    checkedFor.set(version, now);
    lastCheck = now;
    if (!autoUpdateEnabled()) {
      console.log(`telepathy bridge: ${from} has telepathy ${version}. Auto-update is off here, so this device stays on ${installed}.`);
      return;
    }
    console.log(`telepathy bridge: ${from} has telepathy ${version}; checking for updates here.`);
    scheduleAutoUpdate('bridge', { force: true });
  };

  const leadMs = () => holdMs() + 3 * pollMs();
  const setRestartAt = (at: number) => {
    if (at === restartAt) return;
    const first = !restartAt;
    restartAt = at;
    clearTimeout(restartTimer);
    restartTimer = undefined;
    if (!at) return;
    if (first) {
      const behind = waitingFor.length ? ` ${waitingFor.join(', ')} ${waitingFor.length === 1 ? 'does' : 'do'} not have it yet.` : '';
      console.log(`telepathy bridge: restarting into ${installed} in ${Math.round((at - Date.now()) / 1000)}s.${behind}`);
    }
    restartTimer = setTimeout(() => void restartWhenIdle(at), Math.max(0, at - Date.now()));
  };

  /**
   * After each pass: a newer version installed here restarts this bridge once every device it reaches has that
   * version too (or will not update, or the wait runs out), at the earliest moment any of them picked.
   */
  const planRestart = (participants: Participant[]) => {
    if (!versioned || paused) return;
    for (const p of participants) if (isNewer(p.has, installed)) checkForUpdates(p.has, p.name);
    if (installed === VERSION || installed === failedInto) {
      pendingSince = 0;
      waitingFor = [];
      setRestartAt(0);
      writeRecord();
      return;
    }
    const now = Date.now();
    pendingSince ||= now;
    // Behind and updating, or ahead of what is installed here: worth waiting for, so both run one version.
    const behind = participants.filter((p) => p.has !== installed && (p.autoUpdate || isNewer(p.has, installed)));
    waitingFor = behind.map((p) => p.name);
    if (behind.length && now - pendingSince < restartWaitMs()) {
      setRestartAt(0);
      writeRecord();
      return;
    }
    // Far enough out for every device to hear it; the earliest one picked for the same version wins.
    let at = restartAt || now + leadMs();
    for (const p of participants) {
      if (p.restartAt && p.has === installed && p.restartAt > now && p.restartAt < at) at = p.restartAt;
    }
    setRestartAt(at);
    writeRecord();
  };

  const restartWhenIdle = async (at: number) => {
    while ((busy > 0 || pairs.size > 0) && Date.now() < at + RESTART_GRACE_MS && restartAt === at && !paused) await sleep(250);
    if (restartAt !== at || paused) return;
    await restart();
  };

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
      const participants: Participant[] = [];
      await Promise.all(
        [...byId].map(async ([id, seen]) => {
          const paired = Object.hasOwn(trusted, id);
          const trust: RemoteDevice['trust'] = paired ? 'paired' : seen.route === 'tailscale' ? 'tailscale' : undefined;
          const before = previous.get(id);
          const name = before?.slug || seen.hello.name;
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
          if (seen.hello.protocol !== PROTOCOL) {
            // A version this one can't talk to: listed, so its user sees why, and updated toward when it is newer.
            updated.set(id, { ...base, lastSeen: now, peers: [], incompatible: true });
            if (trust && isVersion(seen.hello.version)) participants.push({ name, has: seen.hello.version, autoUpdate: false });
            return;
          }
          if (!trust) {
            updated.set(id, { ...base, lastSeen: now, peers: [] });
            return;
          }
          try {
            const target: Target = { id, addr: seen.addr, trust };
            const listed = await call<{ peers: RemotePeerWire[]; bridge?: unknown }>(target, '/v1/peers', {}, 2500);
            const info = parseBridgeInfo(listed.bridge);
            if (info) participants.push(participantOf(info, name, Date.now()));
            updated.set(id, {
              ...base,
              lastSeen: now,
              version: info?.version ?? base.version,
              installed: info?.installed,
              autoUpdate: info?.autoUpdate,
              peers: Array.isArray(listed.peers) ? listed.peers.flatMap(cleanPeer) : [],
              reach: 'direct',
            });
            directAt.set(id, Date.now());
            // That device may be waiting on this one in reverse; tell it now that it is reached directly.
            links.get(id)?.release?.();
            ensureReverse(target);
            // Re-read: a `bridge forget` during this pass must not be undone by the snapshot.
            const current = trustedDevices();
            if (paired && Object.hasOwn(current, id) && current[id].addr !== seen.addr) trustDevice({ ...current[id], addr: seen.addr });
          } catch {
            updated.set(id, base);
          }
        }),
      );

      // Devices this one could not connect to, but which keep a connection open to it.
      for (const [id, link] of links) {
        if (!linkFresh(link) || reachedDirectly(id)) continue;
        const before = updated.get(id);
        updated.set(id, {
          id,
          name: link.name,
          slug: before?.slug ?? '',
          addr: link.addr,
          route: isTailscaleIp(link.addr) ? 'tailscale' : 'lan',
          trusted: true,
          trust: link.trust,
          lastSeen: new Date(link.release ? Date.now() : link.seenAt).toISOString(),
          version: link.info?.version ?? link.version,
          installed: link.info?.installed,
          autoUpdate: link.info?.autoUpdate,
          peers: link.peers,
          reach: 'reverse',
        });
        if (link.info) participants.push(participantOf(link.info, before?.slug || link.name, link.infoAt));
      }
      for (const device of updated.values()) {
        const said = reachesUs.get(device.id);
        device.reachesUs = said && Date.now() - said.at < 2 * onlineWindowMs() ? said.how : undefined;
      }

      const day = Date.now() - 86_400_000;
      const devices = [...updated.values()].filter((d) => Date.parse(d.lastSeen) > day || Object.hasOwn(trusted, d.id));
      const taken = new Set<string>();
      for (const device of devices.sort((a, b) => a.id.localeCompare(b.id))) {
        const keep = device.slug && !taken.has(device.slug) ? device.slug : uniqueSlug(device.name, device.id, taken);
        device.slug = keep;
        taken.add(keep);
      }
      writeRemoteState({ at: now, devices });
      planRestart(participants);

      for (const [nonce, at] of seenNonces) if (Date.now() - at > 2 * SKEW_MS) seenNonces.delete(nonce);
      for (const [id, session] of pairs) if (Date.now() - session.created > 180_000) pairs.delete(id);
    } finally {
      discovering = false;
    }
  };

  // A pass that throws must not take the daemon down; the next one tries again.
  const discoverSafely = () => discover().catch((err: Error) => console.error(`telepathy bridge: discovery failed: ${err.message}`));

  let poll: NodeJS.Timeout | undefined;
  let rebind: NodeJS.Timeout | undefined;
  let dailyCheck: NodeJS.Timeout | undefined;
  let stopLan: () => void = () => {};
  let stopWatch: () => void = () => {};

  /** Listeners, discovery and the update watch. False when this device's own port is taken. */
  const startLoops = async (): Promise<boolean> => {
    paused = false;
    stopping = new AbortController();
    await syncListeners();
    if (!servers.has('127.0.0.1')) return false;
    stopLan = startLan();
    await discoverSafely();
    poll = setInterval(() => void discoverSafely(), pollMs());
    rebind = setInterval(() => void syncListeners(), 15_000);
    if (versioned) {
      stopWatch = watchInstall(entry, (version) => {
        // A new file is worth another try, even of a version a restart failed into before.
        if (version === installed && version !== failedInto) return;
        failedInto = undefined;
        installed = version;
        pendingSince = version !== VERSION ? Date.now() : 0;
        console.log(
          version === VERSION
            ? `telepathy bridge: ${version} is installed again; no restart needed.`
            : `telepathy bridge: telepathy ${version} is installed. Restarting into it with the devices this one reaches.`,
        );
        writeRecord();
      });
      // A bridge runs for days, so it checks for updates itself too. The 24h stamp keeps this to one check a day.
      scheduleAutoUpdate('bridge');
      dailyCheck = setInterval(() => scheduleAutoUpdate('bridge'), 3_600_000);
    }
    return true;
  };

  const stopLoops = () => {
    // Once is enough: a SIGTERM can land while a restart has already stopped everything.
    if (paused) return;
    paused = true;
    clearInterval(poll);
    clearInterval(rebind);
    clearInterval(dailyCheck);
    clearTimeout(restartTimer);
    restartTimer = undefined;
    restartAt = 0;
    stopWatch();
    stopWatch = () => {};
    stopping.abort();
    for (const link of links.values()) link.release?.();
    stopLan();
    stopLan = () => {};
    for (const server of servers.values()) server.close();
    servers.clear();
    const record = readJson<DaemonRecord>(daemonFile());
    if (record?.pid === process.pid) fs.rmSync(daemonFile(), { force: true });
  };

  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => (finish = resolve));
  /** Set by SIGTERM or SIGINT: a restart that fails then does not bring this bridge back. */
  let stopped = false;

  /**
   * Hands the port to a bridge started from the file installed now. If that one does not come up, this one takes
   * the port back and stays on its version until another one is installed.
   */
  const restart = async () => {
    const into = installed;
    console.log(`telepathy bridge: restarting into ${into}.`);
    stopLoops();
    let child: ChildProcess | undefined;
    let exited = false;
    try {
      const log = fs.openSync(path.join(bridgeDir(), 'daemon.log'), 'a', 0o600);
      child = spawn(process.execPath, [...process.execArgv, entry, 'bridge', 'run'], {
        detached: true,
        stdio: ['ignore', log, log],
        env: process.env,
      });
      fs.closeSync(log);
      child.on('exit', () => (exited = true));
      child.on('error', () => (exited = true));
      child.unref();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !exited) {
        if (readDaemon()?.pid === child.pid) {
          finish(0);
          // Keep-alive sockets must not hold this process open beside the new bridge.
          setTimeout(() => process.exit(0), 1000).unref();
          return;
        }
        await sleep(100);
      }
    } catch (err) {
      console.error(`telepathy bridge: could not start the bridge for ${into}: ${(err as Error).message}`);
    }
    if (child && !exited) child.kill('SIGKILL');
    if (stopped) return;
    failedInto = into;
    console.error(`telepathy bridge: the bridge for ${into} did not start, so this one (${VERSION}) keeps running. See daemon.log.`);
    if (!(await startLoops())) {
      console.error(`telepathy bridge: port ${port} is taken; stopping.`);
      stopLoops();
      finish(1);
    }
  };

  ensureDir(bridgeDir());
  if (!(await startLoops())) {
    console.error(`telepathy bridge: port ${port} is in use. Set TELEPATHY_BRIDGE_PORT to another port on every device.`);
    stopLoops();
    return 1;
  }
  console.log(
    `telepathy bridge: ${self.name} (${self.id}) listening on ${[...servers.keys()].map((a) => `${a}:${port}`).join(', ')}`,
  );

  const stop = () => {
    stopped = true;
    stopLoops();
    finish(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return await finished;
}
