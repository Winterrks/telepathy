import { execFile } from 'node:child_process';
import fs from 'node:fs';

/**
 * The Tailscale CLI's own view of the tailnet. Devices of the same Tailscale user are trusted without
 * pairing. A node shared in from another tailnet, or another user's device, is not.
 */

const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function tailscaleBin(): string | undefined {
  const explicit = process.env.TELEPATHY_TAILSCALE_BIN;
  if (explicit === '') return undefined;
  if (explicit) return explicit;
  if (process.platform === 'darwin' && fs.existsSync(MAC_APP_CLI)) return MAC_APP_CLI;
  return 'tailscale';
}

function runJson<T>(args: string[], timeoutMs = 4000): Promise<T | undefined> {
  const bin = tailscaleBin();
  if (!bin) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        resolve(undefined);
      }
    });
  });
}

interface StatusNode {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  UserID?: number;
  Online?: boolean;
  ShareeNode?: boolean;
  /** Tagged nodes all report one shared "tagged-devices" user, so a tag is never a user's own device. */
  Tags?: string[];
}

interface StatusJson {
  BackendState?: string;
  Self?: StatusNode;
  Peer?: Record<string, StatusNode>;
}

export interface TailnetPeer {
  host: string;
  ip: string;
  online: boolean;
}

export interface Tailnet {
  selfName: string;
  selfIps: string[];
  userId: number;
  /** Online or not, devices of the same user, not shared in. */
  peers: TailnetPeer[];
}

export async function tailnet(): Promise<Tailnet | undefined> {
  const status = await runJson<StatusJson>(['status', '--json']);
  if (!status || status.BackendState !== 'Running' || !status.Self || typeof status.Self.UserID !== 'number') return undefined;
  if (status.Self.Tags?.length) return undefined;
  const userId = status.Self.UserID;
  const peers = Object.values(status.Peer ?? {})
    .filter((peer) => peer.UserID === userId && !peer.ShareeNode && !peer.Tags?.length)
    .map((peer) => ({
      host: peer.HostName ?? peer.DNSName ?? '',
      ip: (peer.TailscaleIPs ?? []).find((ip) => ip.includes('.')) ?? '',
      online: !!peer.Online,
    }))
    .filter((peer) => peer.ip);
  return { selfName: status.Self.HostName ?? '', selfIps: status.Self.TailscaleIPs ?? [], userId, peers };
}

interface WhoisJson {
  Node?: { User?: number; Sharer?: number | null; Tags?: string[] | null };
  UserProfile?: { ID?: number };
}

const whoisCache = new Map<string, { at: number; same: boolean }>();

/** True when `ip` is a node of `userId` on this tailnet and not shared in from another one. */
export async function sameTailnetUser(ip: string, userId: number): Promise<boolean> {
  const cached = whoisCache.get(ip);
  if (cached && Date.now() - cached.at < 60_000) return cached.same;
  const who = await runJson<WhoisJson>(['whois', '--json', ip]);
  const same =
    !!who?.Node && who.Node.User === userId && !who.Node.Sharer && !who.Node.Tags?.length && (who.UserProfile?.ID ?? userId) === userId;
  whoisCache.set(ip, { at: Date.now(), same });
  return same;
}

/** 100.64.0.0/10 and fd7a:115c:a1e0::/48, the ranges Tailscale assigns. */
export function isTailscaleIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v4);
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}
