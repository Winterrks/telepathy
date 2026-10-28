import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Antigravity's FAQ: driving a consumer login from third-party software, or wrapping `agy -p`,
 * can suspend the account. Headless and ACP use a Gemini API key instead.
 */
export const AGY_CONSUMER_LOGIN_WARNING = [
  'telepathy: refusing to drive Antigravity headless or ACP on a consumer login.',
  'Google says wrapping `agy -p` or driving a consumer account from third-party software can suspend the account.',
  'Set GEMINI_API_KEY and "modelProvider": "gemini" in ~/.gemini/antigravity-cli/settings.json, then try again.',
  'An interactive `telepathy run antigravity` (the TUI) is unchanged.',
].join('\n');

export function agySettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

/**
 * Headless and ACP require `GEMINI_API_KEY`. When the key is set and `modelProvider` is empty,
 * write `"modelProvider": "gemini"` so requests go to the API. An existing other value is left as-is.
 */
export function ensureAgyApiKey(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; warning: string } {
  if (!env.GEMINI_API_KEY?.trim()) return { ok: false, warning: AGY_CONSUMER_LOGIN_WARNING };
  const file = agySettingsFile(env);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (json.modelProvider !== 'gemini' && (json.modelProvider === undefined || json.modelProvider === '')) {
    json.modelProvider = 'gemini';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  }
  return { ok: true };
}
