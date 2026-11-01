import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { debugLog } from './core/debug.ts';
import { pendingMessages } from './core/messages.ts';
import { ensureDir, inboxDir } from './core/paths.ts';
import { readPeer } from './core/peers.ts';
import { noteTag } from './core/tags.ts';

/** Peek-only inbox. Subscribers are told when it changes; reading it does not claim. */
export const INBOX_URI = 'telepathy://inbox';

/**
 * Best-effort side channel for Grok clients that surface MCP events. Grok Build turns list-changed into a status
 * event and does not start a turn from logging or resources/updated, and Grok Bot does not subscribe, so this is
 * not how a message reaches the model. wait_for_messages is. Nothing here claims the inbox: a notification must
 * not steal a message from a later wait or from read_messages.
 *
 * Announcements are skipped while a listener is registered (a monitor, or a wait in flight). That listener is
 * already going to deliver, and a second notice would race it.
 */
export function attachGrokDelivery(server: McpServer, currentId: () => string): void {
  server.registerResource(
    'inbox',
    INBOX_URI,
    {
      title: 'Telepathy inbox',
      description: 'Messages other sessions have sent here and that nothing has claimed yet. Reading does not claim them; wait_for_messages or read_messages does.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            pendingMessages(currentId()).map((m) => ({ id: m.id, from: m.from.address, sentAt: m.sentAt, body: m.body })),
          ),
        },
      ],
    }),
  );
  // registerResource merges resources.listChanged and would drop subscribe if it replaced the block.
  server.server.registerCapabilities({ resources: { subscribe: true }, logging: {} });

  const subscribed = new Set<string>();
  server.server.setRequestHandler('resources/subscribe', (request) => {
    subscribed.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', (request) => {
    subscribed.delete(request.params.uri);
    return {};
  });

  const announced = new Set<string>();
  let watcher: fs.FSWatcher | undefined;
  let announcing = false;
  let again = false;

  const announceOnce = async () => {
    if (!server.isConnected()) return;
    const selfId = currentId();
    // A live listener (monitor or wait_for_messages) delivers by claiming. Don't also poke the client.
    if (readPeer(selfId)?.hasListener) return;
    const pending = pendingMessages(selfId);
    const pendingIds = new Set(pending.map((m) => m.id));
    for (const id of announced) if (!pendingIds.has(id)) announced.delete(id);
    const fresh = pending.filter((m) => !announced.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) announced.add(m.id);
    const note = noteTag(
      'inbox',
      `${fresh.length} new message(s) waiting (${fresh.map((m) => m.id).join(', ')}). Call wait_for_messages to claim them.`,
    );
    debugLog('server', `grok inbox notify ${fresh.map((m) => m.id).join(',')}`);
    if (subscribed.has(INBOX_URI)) {
      try {
        await server.server.sendResourceUpdated({ uri: INBOX_URI });
      } catch {
        // the client is not listening
      }
    }
    try {
      await server.sendLoggingMessage({ level: 'info', logger: 'telepathy', data: note });
    } catch {
      // logging not accepted
    }
  };

  const announce = async () => {
    if (announcing) {
      again = true;
      return;
    }
    announcing = true;
    try {
      do {
        again = false;
        await announceOnce();
      } while (again);
    } finally {
      announcing = false;
    }
  };

  let watched: string | undefined;
  const watch = () => {
    const selfId = currentId();
    ensureDir(inboxDir(selfId));
    if (watcher && watched === selfId) return;
    try {
      watcher?.close();
    } catch {
      // already closed
    }
    watcher = undefined;
    if (watched !== selfId) announced.clear();
    watched = selfId;
    try {
      watcher = fs.watch(inboxDir(selfId), () => void announce());
      watcher.on('error', () => {
        try {
          watcher?.close();
        } catch {
          // already closed
        }
        watcher = undefined;
      });
      // The stdio transport is what keeps the server alive. A watch must not hold the process open after it closes.
      watcher.unref();
    } catch {
      watcher = undefined;
    }
  };

  watch();
  const poll = setInterval(() => {
    watch();
    void announce();
  }, 2000);
  poll.unref();
}
