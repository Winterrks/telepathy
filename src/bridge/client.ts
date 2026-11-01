import { open, seal, type Sealed } from './crypto.ts';
import { DEVICE_ID, deviceIdentity, localBridgePort, PROTOCOL, safeName, trustedDevices } from './state.ts';

/**
 * What `GET /v1/hello` says. It needs no trust, so it carries no session data. Its shape stays the same in every
 * protocol, so a bridge can see a device that runs a version it can't talk to and update toward it.
 */
export interface Hello {
  /** The wire protocol. A device with another one is listed, and nothing else is sent to it. */
  protocol: number;
  id: string;
  name: string;
  version: string;
  /** True while that device's user has `telepathy bridge pair` open. */
  pairing: boolean;
}

/** Request and response bodies on the wire. A paired device seals; a same-user tailnet device sends plain JSON. */
export interface WireRequest {
  device: string;
  name: string;
  sealed?: Sealed;
  body?: unknown;
}

export interface WireResponse {
  sealed?: Sealed;
  body?: unknown;
  error?: string;
  /** From this machine's own bridge: the device is not connected, so the request never reached it. */
  unreachable?: boolean;
}

/** The error a call throws when the request never reached the device. */
export const UNREACHABLE = 'TELEPATHY_UNREACHABLE';

export const requestAad = (path: string, from: string, to: string) => `req ${path} ${from}->${to}`;
export const responseAad = (path: string, from: string, to: string, nonce: string) => `res ${path} ${from}->${to} ${nonce}`;

export const baseUrl = (addr: string) => `http://${addr}`;

export async function hello(addr: string, timeoutMs = 1500): Promise<Hello | undefined> {
  try {
    const res = await fetch(`${baseUrl(addr)}/v1/hello`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<Hello>;
    const protocol = Number(body?.protocol);
    if (!body || !Number.isInteger(protocol) || protocol < 1 || typeof body.id !== 'string' || !DEVICE_ID.test(body.id)) return undefined;
    return {
      protocol,
      id: body.id,
      name: safeName(body.name),
      version: safeName(body.version, '?').slice(0, 20),
      pairing: body.pairing === true,
    };
  } catch {
    return undefined;
  }
}

export interface Target {
  id: string;
  addr: string;
  trust?: 'tailscale' | 'paired';
  reach?: 'direct' | 'reverse';
}

/** Routes that may go to a device over the connection it keeps open to this one. */
export const REVERSE_ROUTES = ['/v1/peers', '/v1/send'];

/**
 * One authenticated call. A paired device gets a sealed body and must answer sealed under the same key.
 * Without a key, plain JSON goes only to a device trusted through the tailnet.
 *
 * A device that does not accept connections is reached through this machine's own bridge, which hands the
 * request, as built here, to the connection that device keeps open. It is checked there as if it came directly.
 */
export async function call<T>(target: Target, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const self = deviceIdentity();
  const trusted = trustedDevices();
  const key = Object.hasOwn(trusted, target.id) ? trusted[target.id].key : undefined;
  if (!key && target.trust !== 'tailscale') throw new Error('this device is not paired with it');
  const wire: WireRequest = { device: self.id, name: self.name };
  if (key) wire.sealed = seal(key, requestAad(path, self.id, target.id), body);
  else wire.body = body;
  const reverse = target.reach === 'reverse' && REVERSE_ROUTES.includes(path);
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(reverse ? `${baseUrl(`127.0.0.1:${localBridgePort()}`)}/v1/outbox` : `${baseUrl(target.addr)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The outbox answers a little before this call gives up, so a late answer is an error, not a lost reply.
    body: JSON.stringify(reverse ? { device: target.id, route: path, wire, timeoutMs: Math.max(1000, timeoutMs - 500) } : wire),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  const reply = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as WireResponse;
  if (reply.error) throw Object.assign(new Error(reply.error), reverse && reply.unreachable ? { cause: { code: UNREACHABLE } } : {});
  if (key) {
    if (!reply.sealed || !wire.sealed) throw new Error('the answer was not sealed');
    return open<T>(key, responseAad(path, self.id, target.id, wire.sealed.n), reply.sealed);
  }
  return reply.body as T;
}

/** A pairing step: plain JSON, before there is a key. */
export async function pairCall<T>(addr: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetch(`${baseUrl(addr)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const reply = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as WireResponse;
  if (reply.error) throw new Error(reply.error);
  return reply.body as T;
}
