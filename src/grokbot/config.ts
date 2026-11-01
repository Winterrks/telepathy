import fs from 'node:fs';
import path from 'node:path';
import { readJson, stateDir, writeJsonAtomic } from '../core/paths.ts';
import { slugify } from '../core/peers.ts';

/**
 * One Grok Bot routine webhook. The Grok Bot app shows the URL and key on a webhook-triggered routine's panel;
 * the Bot can create the routine itself, but neither value is in what its create call returns, so a person copies
 * them here once. The file is mode 600 and the key is never printed or logged.
 */
export interface GrokBotConfig {
  name: string;
  slug: string;
  url: string;
  key: string;
  createdAt: string;
}

export const grokbotDir = () => path.join(stateDir(), 'grokbot');
export const configPath = (slug: string) => path.join(grokbotDir(), `${slug}.json`);

/** Problems with a routine URL, or undefined. The Grok Bot app's own Run button posts to `/automations/webhook/<id>`. */
export function urlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a URL.`;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'The webhook URL must be https.';
  if (url.username || url.password) return 'The webhook URL must not contain credentials; the key is passed separately.';
  return undefined;
}

export function keyProblem(key: string): string | undefined {
  if (!key) return 'No key was given.';
  if (/\s/.test(key)) return 'The key contains whitespace; paste only the key.';
  if (key.length < 16) return 'That key is too short to be a routine key.';
  return undefined;
}

/** Mode 600 only, like delivery.json: a looser file is not trusted with a key. */
export function readConfig(slug: string): GrokBotConfig | undefined {
  const file = configPath(slug);
  try {
    if ((fs.statSync(file).mode & 0o077) !== 0) return undefined;
  } catch {
    return undefined;
  }
  const config = readJson<GrokBotConfig>(file);
  if (!config || typeof config.url !== 'string' || typeof config.key !== 'string') return undefined;
  return config;
}

export function writeConfig(name: string, url: string, key: string): GrokBotConfig {
  const slug = slugify(name);
  if (!slug) throw new Error(`"${name}" has no usable characters for a name.`);
  const config: GrokBotConfig = { name, slug, url, key, createdAt: new Date().toISOString() };
  writeJsonAtomic(configPath(slug), config);
  return config;
}

export function removeConfig(slug: string): boolean {
  const file = configPath(slug);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function listConfigs(): GrokBotConfig[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(grokbotDir());
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readConfig(name.slice(0, -'.json'.length)))
    .filter((config): config is GrokBotConfig => !!config);
}

/** Configs whose file exists but is not mode 600, so the host refuses them. */
export function looseConfigs(): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(grokbotDir());
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!name.endsWith('.json')) return false;
    try {
      return (fs.statSync(path.join(grokbotDir(), name)).mode & 0o077) !== 0;
    } catch {
      return false;
    }
  });
}
