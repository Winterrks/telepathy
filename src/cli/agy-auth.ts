import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Antigravity's FAQ: driving a consumer login from third-party software, or wrapping `agy -p`,
 * can suspend the account. Headless and ACP use a Gemini API key instead.
 * The login type is `modelProvider` in settings.json. Only `"gemini"` sends requests with
 * `GEMINI_API_KEY`. An absent or other value is the signed-in Google account, and a key in the
 * environment does not switch that.
 */
export const AGY_CONSUMER_LOGIN_WARNING = [
  'telepathy: refusing to drive Antigravity headless or ACP on a consumer login.',
  'Google says wrapping `agy -p` or driving a consumer account from third-party software can suspend the account.',
  'Set GEMINI_API_KEY and "modelProvider": "gemini" in ~/.gemini/antigravity-cli/settings.json, then try again.',
  'An interactive `telepathy run antigravity` (the TUI) is unchanged.',
].join('\n');

export const AGY_API_KEY_MISSING = [
  'telepathy: Antigravity settings use "modelProvider": "gemini", but GEMINI_API_KEY is not set.',
  'Export GEMINI_API_KEY, or remove modelProvider to go back to an interactive account login.',
  'Headless and ACP are not started.',
].join('\n');

export function agySettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

export type AgyLogin = 'gemini-api' | 'consumer';

/** `"gemini"` is the API-key login. Anything else, including an empty file, is the consumer account. */
export function agyLoginType(env: NodeJS.ProcessEnv = process.env): { type: AgyLogin; modelProvider?: string } {
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(fs.readFileSync(agySettingsFile(env), 'utf8')) as Record<string, unknown>;
  } catch {
    json = {};
  }
  const modelProvider = typeof json.modelProvider === 'string' ? json.modelProvider : undefined;
  if (modelProvider === 'gemini') return { type: 'gemini-api', modelProvider };
  return { type: 'consumer', modelProvider };
}

/**
 * Headless and ACP require the Gemini API-key login: `modelProvider` already `"gemini"` and
 * `GEMINI_API_KEY` set. This does not write settings. A consumer login is refused even when the key is present.
 */
export function ensureAgyApiKey(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; warning: string } {
  const login = agyLoginType(env);
  if (login.type !== 'gemini-api') return { ok: false, warning: AGY_CONSUMER_LOGIN_WARNING };
  if (!env.GEMINI_API_KEY?.trim()) return { ok: false, warning: AGY_API_KEY_MISSING };
  return { ok: true };
}
