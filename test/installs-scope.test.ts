import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installsInScope, isolatedStateRoots } from '../src/core/installs.ts';

test('a symlink prefix keeps the sandbox install and excludes a sibling', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-scope-'));
  const realVar = path.join(base, 'private', 'var');
  fs.mkdirSync(realVar, { recursive: true });
  const varLink = path.join(base, 'var');
  fs.symlinkSync(realVar, varLink);
  const sandbox = path.join(varLink, 'sandbox');
  const claudeDir = path.join(sandbox, 'claude', 'plugins');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'telepathy@telepathy': [{ version: '0.9.0', installPath: claudeDir }] } }),
  );
  const outside = path.join(varLink, 'outside');
  const outsideVersion = path.join(outside, 'plugins', 'cache', 'telepathy', 'telepathy', '0.0.1');
  fs.mkdirSync(outsideVersion, { recursive: true });
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(home, { recursive: true });
  const saved = {
    TELEPATHY_HOME: process.env.TELEPATHY_HOME,
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.TELEPATHY_HOME = path.join(sandbox, 'state');
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, 'claude');
  process.env.CODEX_HOME = outside;
  process.env.XDG_CACHE_HOME = path.join(home, '.cache');
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  try {
    const roots = isolatedStateRoots();
    assert.ok(roots);
    const installs = installsInScope();
    assert.ok(installs.some((install) => install.agent === 'claude' && install.version === '0.9.0'));
    assert.equal(
      installs.some((install) => install.dir.startsWith(outside) || install.dir.startsWith(fs.realpathSync(outside))),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
