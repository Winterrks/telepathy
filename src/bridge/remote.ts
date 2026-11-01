import { confirmWindow } from '../core/confirm.ts';
import { checkRate, type DeliveryReport, recordSent, type SendResult } from '../core/deliver.ts';
import { formatAgo } from '../core/listing.ts';
import { type Message, newMessageId, type Party, partyOf } from '../core/messages.ts';
import { envDurationMs } from '../core/paths.ts';
import { type Peer, peerRef, resolvePeer } from '../core/peers.ts';
import { call } from './client.ts';
import { isOnline, knownDevices, logEvent, preview, type RemoteDevice, type RemotePeerWire } from './state.ts';

/**
 * Sessions on other devices, as every telepathy process sees them: the daemon's last listing of each trusted
 * device, with `@<device>` on each address and ref. A send to one goes straight to that device's bridge,
 * which delivers it there under the same transcript confirm and answers inside this call's deadline.
 */

export interface RemoteTarget {
  /** The device part after `@`, lowercased. */
  slug: string;
  /** What names the session on that device: an address, ref or name, without `@<device>`. */
  query: string;
}

/** `codex:api@laptop`, `codex-4242@laptop`, or a listing's `address [ref]` form. Local names never have `@`. */
export function remoteTarget(to: string): RemoteTarget | undefined {
  let query = to.trim().replace(/^["'`]|["'`]$/g, '').trim();
  const bracketed = /\[([^\]]+)\]\s*$/.exec(query);
  if (bracketed) query = bracketed[1].trim();
  const at = query.lastIndexOf('@');
  if (at <= 0 || at === query.length - 1) return undefined;
  return { slug: query.slice(at + 1).trim().toLowerCase(), query: query.slice(0, at).trim() };
}

/** True when `to` names a session on a device this one knows. */
export function isRemoteAddress(to: string): boolean {
  const target = remoteTarget(to);
  return !!target && !!findDevice(target.slug);
}

function findDevice(slug: string): RemoteDevice | undefined {
  const devices = knownDevices();
  return (
    devices.find((d) => d.slug === slug) ??
    devices.find((d) => d.name.toLowerCase() === slug) ??
    devices.find((d) => d.id === slug)
  );
}

const qualify = (value: string, device: RemoteDevice) => `${value}@${device.slug}`;

/** A remote session in this machine's `Peer` shape, so a listing or a resolve can treat it like a local one. */
function asPeer(wire: RemotePeerWire, device: RemoteDevice, qualified: boolean): Peer {
  return {
    id: qualified ? qualify(wire.id, device) : wire.id,
    agent: wire.agent,
    pid: 0,
    startedAt: wire.startedAt,
    cwd: wire.cwd,
    name: wire.name,
    address: qualified ? qualify(wire.address, device) : wire.address,
    hasListener: true,
    hasServer: true,
  };
}

export interface RemoteListing {
  device: RemoteDevice;
  online: boolean;
  peers: { peer: Peer; status?: string; delivery?: string }[];
}

/** Every trusted device the daemon knows, online or not, with its sessions qualified by `@<device>`. */
export function remoteListings(now = Date.now()): RemoteListing[] {
  return knownDevices().map((device) => {
    const online = isOnline(device, now);
    return {
      device,
      online,
      peers: online
        ? device.peers.map((wire) => ({ peer: asPeer(wire, device, true), status: wire.status, delivery: wire.delivery }))
        : [],
    };
  });
}

/** Lines for list_peers: each device, then its sessions in the same `- address [ref] · …` shape. */
export function formatRemoteListings(listings: RemoteListing[], now = Date.now()): string[] {
  if (!listings.length) return [];
  const lines: string[] = [];
  for (const { device, online, peers } of listings) {
    const via = device.trust === 'tailscale' ? 'your tailnet' : `paired, ${device.route === 'tailscale' ? 'over Tailscale' : 'on the local network'}`;
    if (!online) {
      lines.push(`Device ${device.slug} (${via}) is offline, last seen ${formatAgo(now - Date.parse(device.lastSeen))}.`);
      continue;
    }
    lines.push(`On device ${device.slug} (${via}), ${peers.length} session${peers.length === 1 ? '' : 's'}:`);
    for (const { peer, status, delivery } of peers) {
      const notes = [peer.cwd ? `cwd ${peer.cwd}` : '', status ?? '', delivery ?? ''].filter(Boolean);
      lines.push([`- ${peerRef(peer)}`, ...notes].join(' · '));
    }
  }
  return lines;
}

/** Margin kept back from this call's deadline for the network and the other device's process start. */
const marginMs = () => envDurationMs('TELEPATHY_BRIDGE_MARGIN_MS', 1500);

interface SendReply {
  ok: boolean;
  status?: string;
  error?: string;
  messageId?: string;
  recipient?: { id: string; agent: Peer['agent']; name: string; address: string };
}

export async function sendRemote(self: Peer, target: RemoteTarget, body: string): Promise<SendResult> {
  const device = findDevice(target.slug);
  if (!device) {
    const known = knownDevices().map((d) => d.slug);
    return {
      ok: false,
      error:
        `No device named "${target.slug}" is reachable. ` +
        (known.length
          ? `Known devices: ${known.join(', ')}.`
          : 'Run `telepathy bridge start` on both devices; devices of your own tailnet appear by themselves, others need `telepathy bridge pair`.'),
    };
  }
  if (!isOnline(device)) {
    return {
      ok: false,
      error: `Message failed: device ${device.slug} is offline (its telepathy bridge is not answering). Nothing was sent.`,
    };
  }

  // Resolve against the cached listing first, for the same ambiguity errors a local send gives. A session that
  // started after the last listing is left for the other device to resolve.
  const unqualified = device.peers.map((wire) => asPeer(wire, device, false));
  const resolved = resolvePeer(target.query, unqualified);
  if ('error' in resolved && / (?:matches|is a prefix of) \d+ sessions: /.test(resolved.error)) {
    return { ok: false, error: qualifyText(resolved.error, unqualified, device) };
  }
  const to = 'peer' in resolved ? resolved.peer.id : target.query;
  const rateKey = `${to}@${device.id}`;
  const limited = checkRate(self.id, rateKey, body);
  if (limited) return { ok: false, error: limited };

  const plan = confirmWindow();
  const deadline = plan.deadline ?? Date.now() + plan.abort + plan.grace;
  const budgetMs = deadline - Date.now() - marginMs();
  if (budgetMs < 2000) return { ok: false, error: `Message failed: too little of this call's wait is left to reach device ${device.slug}.` };

  const from = partyOf(self);
  let reply: SendReply;
  try {
    reply = await call<SendReply>(device, '/v1/send', { from, to, body, budgetMs }, budgetMs + marginMs());
  } catch (err) {
    const code = ((err as Error & { cause?: { code?: string } }).cause ?? {}).code;
    const why = (err as Error).name === 'TimeoutError' ? 'it did not answer before the wait ended' : (err as Error).message;
    // A refused or unroutable connection never reached that device, so nothing there needs withdrawing.
    const error = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN'].includes(code ?? '')
      ? `Message failed: device ${device.slug} is offline (its telepathy bridge refused the connection). Nothing was sent.`
      : `Message not confirmed: the bridge on device ${device.slug} failed (${why}). ` +
        'That device withdraws any copy it could not confirm, so a later turn there will not show it.';
    logEvent({ dir: 'out', device: device.slug, from: from.address, to: `${target.query}@${device.slug}`, ok: false, status: error, preview: preview(body) });
    return { ok: false, error };
  }

  const peers = reply.recipient ? [...unqualified, asPeer({ ...reply.recipient }, device, false)] : unqualified;
  const status = qualifyText(reply.ok ? (reply.status ?? 'Message delivered.') : (reply.error ?? 'Message failed.'), peers, device);
  const toAddress = reply.recipient ? qualify(reply.recipient.address, device) : `${target.query}@${device.slug}`;
  logEvent({ dir: 'out', device: device.slug, from: from.address, to: toAddress, ok: reply.ok, status, preview: preview(body) });
  if (!reply.ok || !reply.recipient) return { ok: false, error: status };

  recordSent(self.id, rateKey, body);
  const recipient = asPeer(reply.recipient, device, true);
  const toParty: Party = { id: recipient.id, agent: recipient.agent, name: recipient.name, address: recipient.address };
  const message: Message = { id: reply.messageId ?? newMessageId(), from, to: toParty, body, sentAt: new Date().toISOString() };
  const delivery: DeliveryReport = { confirmed: true, attempts: [{ id: 'bridge', result: 'confirmed', when: 'immediate', detail: device.slug }] };
  return { ok: true, message, recipient, status, delivery };
}

/** The other device names its sessions without `@`. Every `address [ref]` it mentions gets this device's suffix. */
function qualifyText(text: string, peers: Peer[], device: RemoteDevice): string {
  let out = text;
  for (const peer of peers) {
    out = out.split(peerRef(peer)).join(`${qualify(peer.address, device)} [${qualify(peer.id, device)}]`);
  }
  return out;
}
