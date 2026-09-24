import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Agent } from '../src/core/agents.ts';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DIST = path.join(ROOT, 'plugin', 'dist');
const FAKE_CODEX = path.join(ROOT, 'test', 'fixtures', 'fake-codex.mjs');

export interface Sandbox {
  home: string;
  codexHome: string;
  codexLog: string;
  env: Record<string, string>;
  cleanup: () => void;
}

/** An isolated state dir plus a fake `codex` binary, so tests never touch the real ~/.claude or ~/.codex. */
export function makeSandbox(): Sandbox {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'um-test-'));
  const home = path.join(base, 'state');
  const codexHome = path.join(base, 'codex-home');
  const codexLog = path.join(base, 'codex-calls.jsonl');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.chmodSync(FAKE_CODEX, 0o755);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TELEPATHY_HOME: home,
    TELEPATHY_CODEX_BIN: FAKE_CODEX,
    FAKE_CODEX_LOG: codexLog,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: path.join(base, 'claude-config'),
  };
  delete env.TELEPATHY_AGENT_PID;
  delete env.TELEPATHY_DEBUG;
  return { home, codexHome, codexLog, env, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export function codexCalls(sb: Sandbox): { argv: string[]; codexHome: string | null }[] {
  if (!fs.existsSync(sb.codexLog)) return [];
  return fs.readFileSync(sb.codexLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A live process standing in for a `claude` or `codex` agent process; its pid is the session identity. */
export function fakeAgent(...args: string[]): ChildProcess & { pid: number } {
  // Extra arguments go after `--`, so a stand-in for `claude --input-format stream-json` shows them in `ps`.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', ...(args.length ? ['--', ...args] : [])], {
    stdio: 'ignore',
  });
  return child as ChildProcess & { pid: number };
}

export async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

export async function connectServer(sb: Sandbox, agent: Agent, agentPid: number, cwd = ROOT) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(DIST, 'server.mjs'), '--agent', agent],
    env: { ...sb.env, TELEPATHY_AGENT_PID: String(agentPid) },
    cwd,
    stderr: 'pipe',
  });
  const client = new Client({ name: `test-${agent}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export function toolText(result: { content?: unknown }): string {
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return content.map((c) => c.text ?? '').join('\n');
}

/** Runs a hook the way the agents do: JSON on stdin, output on stdout (and for some, stderr plus exit code). */
export function runHook(sb: Sandbox, agent: Agent, agentPid: number, event: string, input: object, ...extra: string[]) {
  const res = spawnSync(process.execPath, [path.join(DIST, 'hook.mjs'), '--agent', agent, event, ...extra], {
    input: JSON.stringify(input),
    env: { ...sb.env, TELEPATHY_AGENT_PID: String(agentPid) },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

export async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
