import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, stateDir } from './paths.ts';

/** Appends to ~/.telepathy/debug.log when TELEPATHY_DEBUG=1. stdout belongs to MCP/hook protocols. */
export function debugLog(component: string, line: string): void {
  if (process.env.TELEPATHY_DEBUG !== '1') return;
  try {
    ensureDir(stateDir());
    fs.appendFileSync(path.join(stateDir(), 'debug.log'), `${new Date().toISOString()} [${component} ${process.pid}] ${line}\n`);
  } catch {
    // debugging must never break delivery
  }
}
