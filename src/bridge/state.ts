import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../core/agents.ts';
import { ensureDir, envDurationMs, readJson, stateDir, writeJsonAtomic } from '../core/paths.ts';
import { slugify } from '../core/peers.ts';

/**
 * Files the bridge keeps under `<state>/bridge`. The daemon writes `remote.json`; every telepathy process
 * on this machine reads it to list and reach sessions on other devices. Keys stay in `trusted.json` (mode 600).
 */
export const bridgeDir = () => path.join(stateDir(), 'bridge');
const deviceFile = () => path.join(bridgeDir(), 'device.json');
const trustedFile = () => path.join(bridgeDir(), 'trusted.json');
const hostsFile = () => path.join(bridgeDir(), 'hosts.json');
const remoteFile = () => path.join(bridgeDir(), 'remote.json');
export const daemonFile = () => path.join(bridgeDir(), 'daemon.json');
export const eventsFile = () => path.join(bridgeDir(), 'events.jsonl');
export const pairingDir = () => path.join(bridgeDir(), 'pairing');

export const PROTOCOL = 1;

export function bridgePort(): number {
  const raw = Number(process.env.TELEPATHY_BRIDGE_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 47380;
}

/** The port this machine's running bridge listens on: its own record, since a session need not share its environment. */
export function localBridgePort(): number {
  const port = readJson<{ port?: unknown }>(daemonFile())?.port;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : bridgePort();
}

/** A device counts as online while its last answer is this recent. */
export const onlineWindowMs = () => envDurationMs('TELEPATHY_BRIDGE_ONLINE_MS', 15_000);

export interface DeviceIdentity {
  id: string;
  name: string;
}

/** This machine: a random id made once, and a name from the host (Tailscale's when the daemon knows it). */
export function deviceIdentity(): DeviceIdentity {
  const stored = readJson<DeviceIdentity>(deviceFile());
  if (stored?.id && stored.name) return stored;
  const identity = { id: crypto.randomBytes(8).toString('hex'), name: defaultDeviceName() };
  writeSecret(deviceFile(), identity);
  return identity;
}

export function renameDevice(name: string): DeviceIdentity {
  const identity = { ...deviceIdentity(), name };
  writeSecret(deviceFile(), identity);
  return identity;
}

function defaultDeviceName(): string {
  const host = os.hostname().replace(/\.local$/i, '').split('.')[0];
  return slugify(host) || 'device';
}

export interface TrustedDevice {
  id: string;
  name: string;
  /** base64 AES-256 key from pairing. */
  key: string;
  pairedAt: string;
  /** Where it answered last, `host:port`. */
  addr?: string;
}

export function trustedDevices(): Record<string, TrustedDevice> {
  return readJson<Record<string, TrustedDevice>>(trustedFile()) ?? {};
}

export function trustDevice(device: TrustedDevice): void {
  writeSecret(trustedFile(), { ...trustedDevices(), [device.id]: device });
}

export function forgetDevice(id: string): boolean {
  const all = trustedDevices();
  if (!all[id]) return false;
  delete all[id];
  writeSecret(trustedFile(), all);
  return true;
}

/** Hosts added with `telepathy bridge add`, as `host` or `host:port`. */
export function manualHosts(): string[] {
  return readJson<string[]>(hostsFile()) ?? [];
}

export function setManualHosts(hosts: string[]): void {
  writeJsonAtomic(hostsFile(), [...new Set(hosts)]);
}

function writeSecret(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, value);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on filesystems without modes
  }
}

/** One session on another device, as that device described it. */
export interface RemotePeerWire {
  id: string;
  agent: Agent;
  name: string;
  address: string;
  cwd?: string;
  /** `busy`, `idle 2m`…, from that device's own status sources. */
  status?: string;
  /** How it receives, in that device's words. */
  delivery?: string;
  startedAt?: string;
}

export type Route = 'tailscale' | 'lan' | 'manual';

export interface RemoteDevice {
  id: string;
  name: string;
  /** What addresses use after `@`: unique among the devices this one knows. */
  slug: string;
  addr: string;
  route: Route;
  /** Same Tailscale user, or paired. Untrusted devices are listed for pairing only. */
  trusted: boolean;
  /** `tailscale` (same user on the tailnet) or `paired`. */
  trust?: 'tailscale' | 'paired';
  lastSeen: string;
  version?: string;
  peers: RemotePeerWire[];
  /**
   * How this device reaches it. `reverse`: it does not accept connections (a firewall, NAT), so it keeps one open
   * to this device and requests go back over that connection.
   */
  reach?: 'direct' | 'reverse';
  /** How it reaches this device, as it said last. `reverse` means it could not connect here. */
  reachesUs?: 'direct' | 'reverse';
}

export interface RemoteState {
  at: string;
  devices: RemoteDevice[];
}

export function readRemoteState(): RemoteState | undefined {
  return readJson<RemoteState>(remoteFile());
}

export function writeRemoteState(state: RemoteState): void {
  ensureDir(bridgeDir());
  writeJsonAtomic(remoteFile(), state);
}

export const isOnline = (device: RemoteDevice, now = Date.now()) => now - Date.parse(device.lastSeen) < onlineWindowMs();

/**
 * Trusted devices from the daemon's last pass. Without a running daemon the file goes stale, and its
 * devices count as offline.
 */
export function knownDevices(): RemoteDevice[] {
  const state = readRemoteState();
  if (!state) return [];
  return state.devices.filter((device) => device.trusted);
}

/** A device's slug: its name, with a short id when two devices share one. */
/** A device id as `deviceIdentity` makes them. Anything else from the network is refused. */
export const DEVICE_ID = /^[0-9a-f]{16}$/;

/**
 * A device name another machine sent. It is shown in the pairing prompt next to the code the user compares, so
 * control characters, escapes and bidi overrides are removed: a name must not be able to draw a fake code.
 */
export function safeName(value: unknown, fallback = 'device', max = 48): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return text || fallback;
}

export function uniqueSlug(name: string, id: string, taken: Set<string>): string {
  const base = slugify(name) || 'device';
  if (!taken.has(base)) return base;
  return `${base}-${id.slice(0, 4)}`;
}

export interface BridgeEvent {
  at: string;
  dir: 'in' | 'out';
  device: string;
  from: string;
  to: string;
  ok: boolean;
  status: string;
  preview: string;
}

/** Appends one message crossing between devices, for `telepathy bridge watch`. */
export function logEvent(event: Omit<BridgeEvent, 'at'>): void {
  try {
    ensureDir(bridgeDir());
    fs.appendFileSync(eventsFile(), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
    const size = fs.statSync(eventsFile()).size;
    if (size > 512 * 1024) {
      const lines = fs.readFileSync(eventsFile(), 'utf8').trim().split('\n').slice(-500);
      fs.writeFileSync(eventsFile(), lines.join('\n') + '\n', { mode: 0o600 });
    }
  } catch {
    // the log is for watching only
  }
}

export function recentEvents(limit: number): BridgeEvent[] {
  try {
    return fs
      .readFileSync(eventsFile(), 'utf8')
      .trim()
      .split('\n')
      .slice(-limit)
      .map((line) => JSON.parse(line) as BridgeEvent);
  } catch {
    return [];
  }
}

export const preview = (body: string) => safeName(body, '', 160);
