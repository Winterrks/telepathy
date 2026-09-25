import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from './agents.ts';

/** One agent's installed copy of telepathy, found on disk. */
export interface Install {
  agent: Agent;
  version: string;
  /** The folder the agent loads telepathy from. */
  dir: string;
  /** Marketplace the plugin came from, for agents that install from one (`telepathy@<marketplace>`). */
  marketplace?: string;
}

const home = () => os.homedir();
const cacheHome = () => process.env.XDG_CACHE_HOME || path.join(home(), '.cache');
const dataHome = () => process.env.XDG_DATA_HOME || path.join(home(), '.local', 'share');

function readVersion(file: string): string | undefined {
  try {
    const version = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Antigravity's manifest has no version; the bundled server has it built in. */
function builtVersion(dir: string): string | undefined {
  try {
    return /var VERSION = (?:true \? )?"(\d+\.\d+\.\d+[^"]*)"/.exec(fs.readFileSync(path.join(dir, 'dist', 'server.mjs'), 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

const list = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const versionParts = (v: string) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);

/** Whether version `a` is newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

function newestOf(installs: Install[]): Install | undefined {
  return installs.reduce<Install | undefined>((best, i) => (!best || isNewer(i.version, best.version) ? i : best), undefined);
}

function claude(): Install[] {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
  let plugins: Record<string, { version?: string; installPath?: string }[]> = {};
  try {
    plugins = JSON.parse(fs.readFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {};
  } catch {
    return [];
  }
  return Object.entries(plugins)
    .filter(([key]) => key.startsWith('telepathy@'))
    .flatMap(([key, entries]) =>
      (entries ?? [])
        .filter((e) => e.version && e.installPath)
        .map((e) => ({ agent: 'claude' as const, version: e.version as string, dir: e.installPath as string, marketplace: key.slice('telepathy@'.length) })),
    );
}

/** Codex keeps each version it installed in `<CODEX_HOME>/plugins/cache/<marketplace>/telepathy/<version>`. */
function codex(): Install[] {
  const cache = path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'plugins', 'cache');
  const found = list(cache).flatMap((marketplace) =>
    list(path.join(cache, marketplace, 'telepathy')).map((version) => ({
      agent: 'codex' as const,
      version,
      dir: path.join(cache, marketplace, 'telepathy', version),
      marketplace,
    })),
  );
  const newest = newestOf(found.filter((i) => /^\d+\.\d+\.\d+/.test(i.version)));
  return newest ? [newest] : [];
}

function extension(agent: 'gemini' | 'qwen'): Install[] {
  const dir = path.join(home(), `.${agent}`, 'extensions', 'telepathy');
  const version = readVersion(path.join(dir, `${agent}-extension.json`));
  return version ? [{ agent, version, dir }] : [];
}

function copilot(): Install[] {
  const root = path.join(home(), '.copilot', 'installed-plugins');
  return list(root).flatMap((marketplace) => {
    const dir = path.join(root, marketplace, 'telepathy');
    const version = readVersion(path.join(dir, '.github', 'plugin', 'plugin.json'));
    return version ? [{ agent: 'copilot' as const, version, dir, marketplace }] : [];
  });
}

/** Devin keeps `<data>/devin/cli/plugins/cache/<source>/<version>`. */
function devin(): Install[] {
  const cache = path.join(dataHome(), 'devin', 'cli', 'plugins', 'cache');
  const found = list(cache)
    .filter((name) => /telepathy/i.test(name))
    .flatMap((name) =>
      list(path.join(cache, name)).flatMap((version) => {
        const dir = path.join(cache, name, version);
        const manifest = readVersion(path.join(dir, '.devin-plugin', 'plugin.json'));
        return manifest ? [{ agent: 'devin' as const, version: manifest, dir }] : [];
      }),
    );
  const newest = newestOf(found);
  return newest ? [newest] : [];
}

function antigravity(): Install[] {
  const dir = path.join(home(), '.gemini', 'config', 'plugins', 'telepathy');
  const version = builtVersion(dir);
  return version ? [{ agent: 'antigravity', version, dir }] : [];
}

/** OpenCode and Kilo Code install the npm package from GitHub into their package cache. */
function packageCache(agent: 'opencode' | 'kilo'): Install[] {
  const packages = path.join(cacheHome(), agent, 'packages');
  const candidates =
    agent === 'opencode'
      ? list(packages)
          .filter((name) => name.startsWith('telepathy@'))
          .flatMap((name) => {
            // `telepathy@git+https:` holds nested folders mirroring the rest of the URL.
            const found: string[] = [];
            const walk = (dir: string, depth: number) => {
              if (fs.existsSync(path.join(dir, 'node_modules', 'telepathy', 'package.json'))) found.push(path.join(dir, 'node_modules', 'telepathy'));
              else if (depth < 4) for (const sub of list(dir)) walk(path.join(dir, sub), depth + 1);
            };
            walk(path.join(packages, name), 0);
            return found;
          })
      : list(path.join(packages, 'git'))
          .filter((name) => /telepathy/i.test(name) && !name.endsWith('.json'))
          .map((name) => path.join(packages, 'git', name));
  const found = candidates.flatMap((dir) => {
    const version = readVersion(path.join(dir, 'package.json'));
    return version ? [{ agent, version, dir }] : [];
  });
  const newest = newestOf(found);
  return newest ? [newest] : [];
}

/**
 * Every agent's installed copy of telepathy that can be found on this machine, from local files only. Grok and
 * Cursor load Claude Code's copy, so they have none of their own here.
 */
export function findInstalls(): Install[] {
  return [
    ...claude(),
    ...codex(),
    ...extension('gemini'),
    ...extension('qwen'),
    ...copilot(),
    ...devin(),
    ...antigravity(),
    ...packageCache('opencode'),
    ...packageCache('kilo'),
  ];
}

/** The newest version among the installs and `also` (the running build's). */
export function newestVersion(installs: Install[], also?: string): string | undefined {
  return [...installs.map((i) => i.version), ...(also ? [also] : [])].reduce<string | undefined>(
    (best, v) => (!best || isNewer(v, best) ? v : best),
    undefined,
  );
}
