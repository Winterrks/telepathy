#!/usr/bin/env node
// One stand-in for every harness CLI. The test names it with FAKE_ARGV0 (claude, codex, gemini, …).
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';

const name = process.env.FAKE_ARGV0 || 'harness';
const args = process.argv.slice(2);
const logFile = process.env.FAKE_HARNESS_LOG;

function log(event) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ cmd: name, args, pid: process.pid, ...event }) + '\n');
}

log({ event: 'start', cwd: process.cwd() });

const stop = () => process.exit(0);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function isAcp() {
  return args.includes('--acp') || args[0] === 'acp' || name === 'claude-code-acp' || name === 'codex-acp';
}

if (args.includes('--sleep')) {
  setInterval(() => {}, 1 << 30);
} else if (name === 'codex' && args[0] === 'app-server') {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    log({ event: 'rpc', method: msg.method, id: msg.id, params: msg.params });
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake-codex' } });
    else if (msg.method === 'thread/start') {
      send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: process.env.FAKE_THREAD_ID || 'thread-fake-1' } } });
    } else if (msg.method === 'thread/resume') {
      send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params?.threadId } } });
    } else if (msg.method === 'turn/start') send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
    else if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, result: {} });
  });
} else if ((name === 'opencode' || name === 'kilo') && args[0] === 'serve') {
  const known = process.env.FAKE_OC_SESSION || 'ses_fake';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      log({ event: 'http', method: req.method, url: req.url, body });
      const url = req.url || '';
      if (req.method === 'POST' && (url === '/api/session' || url === '/session')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: known }));
        return;
      }
      if (req.method === 'GET' && (url === `/api/session/${known}` || url === `/session/${known}`)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: known }));
        return;
      }
      if (req.method === 'POST' && /\/(prompt|message)$/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404);
      res.end('no');
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    process.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`);
  });
} else if (isAcp()) {
  let permId = 0;
  let pending = null;
  const rl = readline.createInterface({ input: process.stdin });
  const finishPrompt = async (msg) => {
    if (process.env.FAKE_ACP_REJECT === '1') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'rejected' } });
      return;
    }
    const text = (msg.params?.prompt ?? []).map((part) => part?.text ?? '').filter(Boolean).join('\n');
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    });
    const hold = Number(process.env.FAKE_ACP_HOLD_MS || 0);
    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  };
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    log({ event: 'acp', method: msg.method, id: msg.id, params: msg.params, result: msg.result });
    if (pending && msg.id === pending.permId && msg.method === undefined) {
      const outcome = msg.result?.outcome?.outcome;
      const prompt = pending.prompt;
      pending = null;
      if (outcome === 'selected') void finishPrompt(prompt);
      else send({ jsonrpc: '2.0', id: prompt.id, error: { code: -32000, message: 'permission rejected' } });
      return;
    }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name, version: '0' } } });
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: process.env.FAKE_ACP_SESSION_ID || 'sess-acp' } });
    } else if (msg.method === 'session/load') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params?.sessionId || 'sess-acp' } });
    } else if (msg.method === 'session/prompt') {
      if (process.env.FAKE_ACP_PERMISSION === '1') {
        permId += 1;
        const id = 9000 + permId;
        pending = { permId: id, prompt: msg };
        send({
          jsonrpc: '2.0',
          id,
          method: 'session/request_permission',
          params: {
            sessionId: msg.params?.sessionId,
            options: [
              { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
            ],
            toolCall: { toolCallId: 'tool-1', title: 'shell' },
          },
        });
        return;
      }
      void finishPrompt(msg);
    } else if (msg.id !== undefined && msg.method) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  });
} else if (name === 'claude' && args.includes('stream-json')) {
  const session = process.env.FAKE_CLAUDE_SESSION || 'sess-claude-1';
  send({ type: 'system', subtype: 'init', session_id: session });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    log({ event: 'stdin', line });
    send({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: 'ack' }] } });
  });
} else if (args[0] === 'plugin' || args[0] === 'extensions' || args[0] === 'plugins' || args.includes('marketplace')) {
  process.exit(0);
} else {
  const code = process.env.FAKE_EXIT_CODE;
  process.exit(code === undefined ? 0 : Number(code));
}
