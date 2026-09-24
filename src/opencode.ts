import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent } from './core/agents.ts';
import { debugLog } from './core/debug.ts';
import { guideText } from './core/guide.ts';
import { claimInbox, formatForContext } from './core/messages.ts';
import { ensureDir, inboxDir } from './core/paths.ts';
import { peerId, registerListener, registerPresence, registerSession, selfPeer } from './core/peers.ts';
import { listPeersTool, readMessagesTool, sendMessageTool, TOOLS, type ToolResult } from './core/tools.ts';

/**
 * OpenCode (1.x) and Kilo Code plugin. It runs inside the agent's own process, so it registers native tools
 * (which, unlike MCP calls, know the calling session) and wakes the session itself: a message arriving while
 * the session is idle becomes a prompt through the SDK client's `session.promptAsync`, which starts a turn.
 */

interface PromptTarget {
  sessionID: string;
  agent?: string;
  model?: unknown;
}

interface PluginInput {
  client: {
    session: {
      promptAsync(options: { path: { id: string }; body: { parts: { type: 'text'; text: string }[]; agent?: string; model?: unknown } }): Promise<unknown>;
    };
  };
  directory?: string;
}

interface BusEvent {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string; parentID?: string };
    status?: { type?: string };
  };
}

const skillsDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'skills');
const out = (r: ToolResult) => (r.isError ? `Error: ${r.text}` : r.text);

const TelepathyPlugin = async ({ client, directory }: PluginInput) => {
  const agent: Agent = /kilo/i.test(path.basename(process.execPath)) ? 'kilo' : 'opencode';
  const pid = process.pid;
  const id = peerId(agent, pid);
  registerPresence(agent, pid, { cwd: directory });
  debugLog('opencode', `plugin loaded for ${id} in ${directory ?? '?'}`);

  let active: PromptTarget | undefined; // the primary session the user last prompted
  const children = new Set<string>(); // subagent sessions: never the delivery target
  const busy = new Set<string>();
  let delivering = false;

  /** Hands pending messages to the active session once it's idle; promptAsync then starts a turn. */
  async function deliver(): Promise<void> {
    if (delivering || !active || busy.has(active.sessionID)) return;
    delivering = true;
    try {
      const messages = claimInbox(id);
      if (!messages.length) return;
      const target = active;
      busy.add(target.sessionID); // the prompt makes it busy; session.idle clears it
      await client.session.promptAsync({
        path: { id: target.sessionID },
        // The messages are a turn of their own here, so they need no lead-in.
        body: { parts: [{ type: 'text', text: formatForContext(messages, { lead: false }) }], agent: target.agent, model: target.model },
      });
      debugLog('opencode', `delivered ${messages.map((m) => m.id).join(', ')} to session ${target.sessionID}`);
    } catch (err) {
      // The messages stay in the archive, where read_messages shows them as the most recent received.
      if (active) busy.delete(active.sessionID);
      debugLog('opencode', `delivery failed: ${(err as Error).message}`);
    } finally {
      delivering = false;
    }
  }

  let watcher: fs.FSWatcher | undefined;
  const watch = () => {
    if (watcher) return;
    try {
      watcher = fs.watch(ensureDir(inboxDir(id)), () => void deliver());
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined; // the interval below still polls
    }
  };
  watch();
  setInterval(() => {
    watch();
    void deliver();
  }, 2000).unref();

  const self = () => selfPeer(agent, pid);

  return {
    /** Lets OpenCode find the using-telepathy skill. */
    config: async (config: { skills?: { paths?: string[] } | unknown[] }) => {
      if (Array.isArray(config.skills)) return;
      const skills = (config.skills ??= {}) as { paths?: string[] };
      skills.paths ??= [];
      if (!skills.paths.includes(skillsDir)) skills.paths.push(skillsDir);
    },

    'chat.message': async (input: { sessionID: string; agent?: string; model?: unknown }) => {
      if (children.has(input.sessionID)) return;
      const changed = active?.sessionID !== input.sessionID;
      active = { sessionID: input.sessionID, agent: input.agent, model: input.model };
      if (changed) {
        registerSession(agent, pid, { sessionId: input.sessionID, cwd: directory, source: 'plugin' });
        registerListener(agent, pid); // from now on a message has a session to wake
      }
    },

    event: async ({ event }: { event: BusEvent }) => {
      const p = event.properties ?? {};
      if (event.type === 'session.created' && p.info?.parentID && p.info.id) children.add(p.info.id);
      if (event.type === 'session.status' && p.sessionID) {
        if (p.status?.type === 'idle') busy.delete(p.sessionID);
        else busy.add(p.sessionID);
      }
      if (event.type === 'session.idle' && p.sessionID) {
        busy.delete(p.sessionID);
        setTimeout(() => void deliver(), 0); // after OpenCode finishes going idle
      }
    },

    /** OpenCode shows no MCP instructions for plugin tools, so the guide goes into the system prompt. */
    'experimental.chat.system.transform': async (_input: unknown, output: { system?: string[] }) => {
      if (Array.isArray(output.system)) output.system.push(guideText(agent));
    },

    tool: {
      telepathy_list_peers: {
        description: TOOLS.list_peers.description,
        args: TOOLS.list_peers.args,
        execute: async () => out(listPeersTool(self())),
      },
      telepathy_send_message: {
        description: TOOLS.send_message.description,
        args: TOOLS.send_message.args,
        execute: async (args: { to: string; message: string }) => out(await sendMessageTool(self(), args.to, args.message)),
      },
      telepathy_read_messages: {
        description: TOOLS.read_messages.description,
        args: TOOLS.read_messages.args,
        execute: async (args: { id?: string; limit?: number }) => out(readMessagesTool(id, args)),
      },
    },
  };
};

export default { id: 'telepathy', server: TelepathyPlugin };
