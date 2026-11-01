import { open, seal, type Sealed } from './crypto.ts';
import { DEVICE_ID, deviceIdentity, PROTOCOL, safeName, trustedDevices } from './state.ts';

/** What `GET /v1/hello` says. It needs no trust, so it carries no session data. */
export interface Hello {
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
}

export const requestAad = (path: string, from: string, to: string) => `req ${path} ${from}->${to}`;
export const responseAad = (path: string, from: string, to: string, nonce: string) => `res ${path} ${from}->${to} ${nonce}`;

export const baseUrl = (addr: string) => `http://${addr}`;

export async function hello(addr: string, timeoutMs = 1500): Promise<Hello | undefined> {
  try {
    const res = await fetch(`${baseUrl(addr)}/v1/hello`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<Hello>;
    if (!body || body.protocol !== PROTOCOL || typeof body.id !== 'string' || !DEVICE_ID.test(body.id)) return undefined;
    return {
      protocol: PROTOCOL,
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
}

/**
 * One authenticated call. A paired device gets a sealed body and must answer sealed under the same key.
 * Without a key, plain JSON goes only to a device trusted through the tailnet.
 */
export async function call<T>(target: Target, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const self = deviceIdentity();
  const trusted = trustedDevices();
  const key = Object.hasOwn(trusted, target.id) ? trusted[target.id].key : undefined;
  if (!key && target.trust !== 'tailscale') throw new Error('this device is not paired with it');
  const wire: WireRequest = { device: self.id, name: self.name };
  if (key) wire.sealed = seal(key, requestAad(path, self.id, target.id), body);
  else wire.body = body;
  const res = await fetch(`${baseUrl(target.addr)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wire),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const reply = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as WireResponse;
  if (reply.error) throw new Error(reply.error);
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
