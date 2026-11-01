import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { kimiHome, outsideIsolatedHome, readKimiInstalled, type KimiPluginEntry } from './installs.ts';

/**
 * Kimi Code has no plugin subcommand; `/plugins install <url>` runs only inside a session. This does what that
 * command does (Kimi Code 2026.10, `PluginManager.install`): resolve the ref, download that commit, copy it to
 * `plugins/managed/telepathy` through a staging folder, and record it in `plugins/installed.json` with the same
 * fields. Kimi reads the manifest from the folder each time it loads, so the entry stays as thin as Kimi's own.
 */

const ID = 'telepathy';
const DEFAULT_SOURCE = 'https://github.com/Winterrks/telepathy';
const githubWeb = () => (process.env.TELEPATHY_GITHUB_WEB || 'https://github.com').replace(/\/$/, '');
const codeload = () => (process.env.TELEPATHY_GITHUB_CODELOAD || 'https://codeload.github.com').replace(/\/$/, '');

type Ref = { kind: 'branch' | 'tag' | 'sha'; value: string };

export interface KimiResult {
  ok: boolean;
  /** One line for a person. */
  output: string;
  version?: string;
  changed?: boolean;
}

/** `https://github.com/<owner>/<repo>[/tree/<ref>]`, as Kimi parses an install source. */
function parseSource(source: string): { owner: string; repo: string; ref?: Ref } | undefined {
  let url: URL;
  try {
    url = new URL(source.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined;
  const [owner, repoRaw, tree, ...rest] = url.pathname.split('/').filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/, '');
  if (!owner || !repo) return undefined;
  if (tree !== 'tree' || !rest.length) return { owner, repo };
  const value = rest.join('/');
  return { owner, repo, ref: { kind: /^[0-9a-f]{40}$/i.test(value) ? 'sha' : 'branch', value } };
}

/** The latest release tag, as Kimi resolves a bare repository URL. No release means HEAD. */
async function resolveRef(owner: string, repo: string, pinned?: Ref): Promise<Ref> {
  if (pinned) return pinned;
  const res = await fetch(`${githubWeb()}/${owner}/${repo}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return { kind: 'branch', value: 'HEAD' };
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(res.headers.get('location') ?? '')?.[1];
  if ((res.status === 301 || res.status === 302) && tag) return { kind: 'tag', value: decodeURIComponent(tag) };
  throw new Error(`could not look up the latest release of ${owner}/${repo}: HTTP ${res.status}`);
}

async function resolveSha(owner: string, repo: string, ref: Ref): Promise<string> {
  if (ref.kind === 'sha') return ref.value.toLowerCase();
  const res = await fetch(`${githubWeb()}/${owner}/${repo}/commits/${ref.value.split('/').map(encodeURIComponent).join('/')}.atom`, {
    headers: { accept: 'application/atom+xml', range: 'bytes=0-4095' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`could not resolve ${owner}/${repo}@${ref.value}: HTTP ${res.status}`);
  const sha = /Grit::Commit\/([0-9a-f]{40})/i.exec(await res.text())?.[1];
  if (!sha) throw new Error(`could not resolve ${owner}/${repo}@${ref.value} to a commit`);
  return sha.toLowerCase();
}

function readManifestVersion(root: string): string | undefined {
  try {
    const version = (JSON.parse(fs.readFileSync(path.join(root, '.kimi-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Kimi's own write: a temp file and a rename, so a session never reads half a file. */
function writeInstalled(plugins: KimiPluginEntry[]): void {
  const dir = path.join(kimiHome(), 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, 'installed.json');
  fs.writeFileSync(`${final}.tmp`, JSON.stringify({ version: 1, plugins }, null, 2), 'utf8');
  fs.renameSync(`${final}.tmp`, final);
}

/** Installs telepathy into Kimi Code, or updates the copy it has. `dryRun` resolves but writes nothing. */
export async function installKimiPlugin(options: { dryRun?: boolean } = {}): Promise<KimiResult> {
  const home = kimiHome();
  if (outsideIsolatedHome(home)) return { ok: false, output: `left unchanged: ${home} is outside this TELEPATHY_HOME` };
  const installed = readKimiInstalled() ?? { version: 1, plugins: [] };
  const existing = installed.plugins.find((plugin) => plugin?.id === ID);
  if (existing && existing.source !== 'github') {
    return { ok: true, output: `Kimi Code loads telepathy from ${existing.root} (${existing.source ?? 'a local folder'}); update that copy yourself` };
  }
  const originalSource = existing?.originalSource || DEFAULT_SOURCE;
  const parsed = parseSource(originalSource) ?? parseSource(DEFAULT_SOURCE)!;
  const owner = existing?.github?.owner ?? parsed.owner;
  const repo = existing?.github?.repo ?? parsed.repo;
  try {
    const ref = await resolveRef(owner, repo, parsed.ref);
    const sha = await resolveSha(owner, repo, ref);
    const managed = path.join(home, 'plugins', 'managed', ID);
    const current = existing ? readManifestVersion(existing.root) : undefined;
    if (existing && existing.github?.installedSha === sha && current) {
      return { ok: true, output: `already at ${ref.value} (${sha.slice(0, 12)})`, version: current, changed: false };
    }
    if (options.dryRun) return { ok: true, output: `would download ${owner}/${repo}@${ref.value} (${sha.slice(0, 12)}) into ${managed}` };

    const parent = path.dirname(managed);
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, `${ID}-`));
    const previous = `${staging}-previous`;
    const archive = `${staging}.tar.gz`;
    let moved = false;
    let published = false;
    try {
      const res = await fetch(`${codeload()}/${owner}/${repo}/tar.gz/${sha}`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      execFileSync('tar', ['-xzf', archive, '-C', staging, '--strip-components=1'], { stdio: 'ignore' });
      const version = readManifestVersion(staging);
      if (!version) throw new Error('the download has no .kimi-plugin/plugin.json');
      try {
        fs.renameSync(managed, previous);
        moved = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      fs.renameSync(staging, managed);
      published = true;
      const now = new Date().toISOString();
      const entry: KimiPluginEntry = {
        id: ID,
        root: fs.realpathSync(managed),
        source: 'github',
        enabled: existing?.enabled ?? true,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        originalSource,
        capabilities: existing?.capabilities,
        github: { owner, repo, ref, installedSha: sha },
      };
      const plugins = existing
        ? installed.plugins.map((plugin) => (plugin?.id === ID ? entry : plugin))
        : [...installed.plugins, entry];
      writeInstalled(plugins);
      if (moved) fs.rmSync(previous, { recursive: true, force: true });
      const from = current && current !== version ? `${current} → ` : '';
      return { ok: true, output: `${existing ? 'updated' : 'installed'} ${from}${version} (${ref.value}, ${sha.slice(0, 12)})`, version, changed: true };
    } catch (err) {
      // Kimi's rollback: drop what was published and put the old copy back.
      fs.rmSync(published ? managed : staging, { recursive: true, force: true });
      if (moved) fs.renameSync(previous, managed);
      throw err;
    } finally {
      fs.rmSync(archive, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}
