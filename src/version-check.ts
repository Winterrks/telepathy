import { readJson, stateDir, writeJsonAtomic } from './core/paths.ts';
import path from 'node:path';

const DEFAULT_URL = 'https://raw.githubusercontent.com/Winterrks/telepathy/main/package.json';

export interface CachedVersion {
  version: string;
  fetchedAt: string;
}

const cacheFile = () => path.join(stateDir(), 'github-version.json');

/** The last GitHub version this machine fetched. No network. */
export function cachedGithubVersion(): string | undefined {
  return readJson<CachedVersion>(cacheFile())?.version;
}

/**
 * The version on GitHub main's package.json. `TELEPATHY_LATEST_VERSION` skips the network (tests).
 * `TELEPATHY_VERSION_URL` replaces the URL.
 */
export async function latestGithubVersion(): Promise<string> {
  const override = process.env.TELEPATHY_LATEST_VERSION?.trim();
  if (override) return override;
  const url = process.env.TELEPATHY_VERSION_URL?.trim() || DEFAULT_URL;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: 'application/json', 'user-agent': 'telepathy-cli' },
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== 'string' || !body.version.trim()) throw new Error('GitHub package.json has no version');
  return body.version.trim();
}

export function rememberGithubVersion(version: string): void {
  writeJsonAtomic(cacheFile(), { version, fetchedAt: new Date().toISOString() } satisfies CachedVersion);
}
