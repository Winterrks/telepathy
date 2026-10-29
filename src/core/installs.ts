import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from './agents.ts';
import { configuredEnv } from './paths.ts';

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

/**
 * Canonical path, including when the last component does not exist yet.
 * On macOS `/var` is a symlink to `/private/var`. A missing `TELEPATHY_HOME` used to stay
 * under `/var` while an existing install dir realpath'd to `/private/var`, so the sandbox
 * install looked outside the sandbox and a sibling temp dir could look inside it.
 */
function resolveReal(dir: string): string {
  const abs = path.resolve(dir);
  const missing: string[] = [];
  let current = abs;
  while (current !== path.dirname(current)) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch {
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
  return abs;
}

/** `/tmp` and the passwd home are not a sandbox. A directory under them can be. */
function genericDir(dir: string): boolean {
  const normalized = resolveReal(dir);
  if (normalized === path.parse(normalized).root) return true;
  const generic = ['/tmp', '/var', '/private', '/private/tmp', '/var/tmp', '/private/var'];
  if (generic.includes(normalized)) return true;
  try {
    const tmp = resolveReal(os.tmpdir());
    if (normalized === tmp || normalized === path.dirname(tmp)) return true;
  } catch {
    // tmpdir is unreadable
  }
  return false;
}

/**
 * Roots whose installs auto-update may touch. Unset when `TELEPATHY_HOME` is the user's own
 * `~/.telepathy` (or is unset): that is the real profile, and every install on the machine is in scope.
 * A different `TELEPATHY_HOME` is a sandbox. Installs outside it, including the real `~/.claude`, are not.
 */
export function isolatedStateRoots(): string[] | undefined {
  const explicit = configuredEnv('TELEPATHY_HOME');
  if (!explicit) return undefined;
  const state = resolveReal(explicit);
  let passwd = path.resolve(os.userInfo().homedir);
  try {
    passwd = fs.realpathSync(passwd);
  } catch {
    // keep the unresolved home
  }
  if (state === resolveReal(path.join(passwd, '.telepathy'))) return undefined;
  const parent = path.dirname(state);
  const roots = [genericDir(parent) || parent === passwd ? state : parent];
  let apparent = path.resolve(os.homedir());
  try {
    apparent = fs.realpathSync(apparent);
  } catch {
    // keep it
  }
  const covered = roots.some((root) => apparent === root || apparent.startsWith(root + path.sep));
  if (apparent !== passwd && !covered) roots.push(apparent);
  return roots;
}

function inRoots(dir: string, roots: string[]): boolean {
  const resolved = resolveReal(dir);
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/** True when `dir` is outside the sandbox `TELEPATHY_HOME` selects. A real profile has no sandbox. */
export function outsideIsolatedHome(dir: string): boolean {
  const roots = isolatedStateRoots();
  if (!roots) return false;
  return !inRoots(dir, roots);
}

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

function extension(agent: 'qwen'): Install[] {
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

/**
 * The same plugin loads in the App, CLI, and IDE. `agy plugin install` stages a copy under the CLI plugins
 * directory; a manual install lives in `~/.gemini/config/plugins/telepathy`. The newest of those is the copy
 * update and status report. A leftover Gemini CLI extension is not an install.
 */
function antigravity(): Install[] {
  const dirs = [
    path.join(home(), '.gemini', 'config', 'plugins', 'telepathy'),
    path.join(home(), '.gemini', 'antigravity-cli', 'plugins', 'telepathy'),
  ];
  const found = dirs.flatMap((dir) => {
    const version = builtVersion(dir);
    return version ? [{ agent: 'antigravity' as const, version, dir }] : [];
  });
  const newest = newestOf(found);
  return newest ? [newest] : [];
}

/**
 * OpenCode 2 installs a package plugin into `npm/<target folder>/<install time>/node_modules/<name>`, with a target
 * folder such as `git-telepathy-1869ef84f4ac` for a GitHub install.
 */
function opencodeNpmCache(): string[] {
  const npm = path.join(cacheHome(), 'opencode', 'npm');
  return list(npm)
    .filter((name) => /telepathy/i.test(name))
    .flatMap((name) => list(path.join(npm, name)).map((install) => path.join(npm, name, install, 'node_modules', 'telepathy')))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')));
}

/** Whether an OpenCode install is OpenCode 2's, which updates with `opencode plugin update`. */
export const isOpencodeNpmInstall = (install: Install) =>
  install.agent === 'opencode' && install.dir.startsWith(path.join(cacheHome(), 'opencode', 'npm') + path.sep);

/** OpenCode and Kilo Code install the npm package from GitHub into their package cache. */
function packageCache(agent: 'opencode' | 'kilo'): Install[] {
  const packages = path.join(cacheHome(), agent, 'packages');
  const candidates =
    agent === 'opencode'
      ? [...opencodeNpmCache(), ...list(packages)
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
          })]
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
    ...extension('qwen'),
    ...copilot(),
    ...devin(),
    ...antigravity(),
    ...packageCache('opencode'),
    ...packageCache('kilo'),
  ];
}

/**
 * Installs auto-update may change. A `TELEPATHY_HOME` other than `~/.telepathy` is a sandbox:
 * a copy whose directory is outside that tree, including the real `~/.claude`, is left alone.
 */
export function installsInScope(installs: Install[] = findInstalls()): Install[] {
  const roots = isolatedStateRoots();
  if (!roots) return installs;
  return installs.filter((install) => inRoots(install.dir, roots));
}

/** The newest version among the installs and `also` (the running build's). */
export function newestVersion(installs: Install[], also?: string): string | undefined {
  return [...installs.map((i) => i.version), ...(also ? [also] : [])].reduce<string | undefined>(
    (best, v) => (!best || isNewer(v, best) ? v : best),
    undefined,
  );
}
