import makeMdns from 'multicast-dns';
import { PROTOCOL, type DeviceIdentity } from './state.ts';

/** `_telepathy._tcp.local`: each bridge answers with its id, name, port and local network addresses. */
export const SERVICE = '_telepathy._tcp.local';

export interface Found {
  id: string;
  name: string;
  addr: string;
}

/** Advertises this bridge and browses for others. Returns a stop function; without multicast it does nothing. */
export function startMdns(self: DeviceIdentity, port: number, lanAddresses: () => string[], onFound: (found: Found) => void): () => void {
  let mdns: ReturnType<typeof makeMdns>;
  try {
    mdns = makeMdns();
  } catch {
    return () => {};
  }
  mdns.on('error', () => {});
  const instance = `${self.id}.${SERVICE}`;
  const host = `telepathy-${self.id}.local`;

  mdns.on('query', (query) => {
    if (!query.questions.some((q) => q.name === SERVICE || q.name === instance)) return;
    const addresses = lanAddresses();
    if (!addresses.length) return;
    mdns.respond({
      answers: [{ name: SERVICE, type: 'PTR', ttl: 120, data: instance }],
      additionals: [
        { name: instance, type: 'SRV', ttl: 120, data: { port, target: host, priority: 0, weight: 0 } },
        { name: instance, type: 'TXT', ttl: 120, data: [`id=${self.id}`, `name=${self.name}`, `v=${PROTOCOL}`] },
        ...addresses.map((ip) => ({ name: host, type: 'A' as const, ttl: 120, data: ip })),
      ],
    });
  });

  mdns.on('response', (response) => {
    const records = [...response.answers, ...(response.additionals ?? [])];
    for (const srv of records) {
      if (srv.type !== 'SRV' || !srv.name.endsWith(`.${SERVICE}`) || srv.name === instance) continue;
      const txt = records.find((r) => r.type === 'TXT' && r.name === srv.name);
      const fields = new Map<string, string>();
      if (txt?.type === 'TXT') {
        const data = Array.isArray(txt.data) ? txt.data : [txt.data];
        for (const item of data) {
          const text = item.toString();
          const eq = text.indexOf('=');
          if (eq > 0) fields.set(text.slice(0, eq), text.slice(eq + 1));
        }
      }
      const id = fields.get('id');
      if (!id || id === self.id || fields.get('v') !== String(PROTOCOL)) continue;
      for (const a of records) {
        if (a.type === 'A' && a.name === srv.data.target) onFound({ id, name: fields.get('name') ?? id, addr: `${a.data}:${srv.data.port}` });
      }
    }
  });

  const ask = () => {
    try {
      mdns.query({ questions: [{ name: SERVICE, type: 'PTR' }] });
    } catch {
      // the socket may be gone while the interface changes
    }
  };
  ask();
  const timer = setInterval(ask, 10_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    try {
      mdns.destroy();
    } catch {
      // already closed
    }
  };
}
