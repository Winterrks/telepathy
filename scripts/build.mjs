// Bundles each entry point (with the MCP SDK and zod inlined) into plugin/dist, so the plugin runs
// with plain `node` and no install step, and stamps the package version into both plugin manifests.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const pluginDir = path.join(root, 'plugin');

fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: ['server', 'hook', 'monitor', 'opencode'].map((name) => path.join(root, 'src', `${name}.ts`)),
  outdir: path.join(pluginDir, 'dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'linked',
  define: { __TELEPATHY_VERSION__: JSON.stringify(pkg.version) },
  // Some bundled CommonJS dependencies call require(); give them one in the ESM output.
  banner: { js: "import { createRequire as __umCreateRequire } from 'node:module'; const require = __umCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});

// Every manifest that carries a version, relative to the repo root. Agents that cache installed plugins
// by version (Codex, for one) would otherwise keep serving a stale copy.
const MANIFESTS = [
  'plugin/.claude-plugin/plugin.json',
  'plugin/.codex-plugin/plugin.json',
  'plugin/.grok-plugin/plugin.json',
  'plugin/.github/plugin/plugin.json',
  'plugin/.cursor-plugin/plugin.json',
  'plugin/.devin-plugin/plugin.json',
  'gemini-extension.json',
  'qwen-extension.json',
  '.kimi-plugin/plugin.json',
];

const { guideText } = await import('../src/core/guide.ts');
const write = (file, text) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) fs.writeFileSync(target, text);
};

for (const manifest of MANIFESTS) {
  const json = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8'));
  json.version = pkg.version;
  // Kimi Code never shows MCP server instructions, so the guide goes into its system prompt.
  if (manifest === '.kimi-plugin/plugin.json') json.systemPrompt = guideText('kimi');
  write(manifest, JSON.stringify(json, null, 2) + '\n');
}

// Guides for agents that don't show MCP server instructions, as always-on rule files.
write('plugin/AGENTS.md', guideText('devin') + '\n'); // Devin CLI loads a plugin's AGENTS.md as a rule
write('antigravity/rules/AGENTS.md', guideText('antigravity') + '\n');

// Folders that agents install on their own get their own copies: Antigravity installs antigravity/ alone,
// and Gemini CLI only finds skills in skills/ at the extension root.
const copyDir = (from, to) => {
  fs.rmSync(path.join(root, to), { recursive: true, force: true });
  fs.cpSync(path.join(root, from), path.join(root, to), { recursive: true });
};
copyDir('plugin/dist', 'antigravity/dist');
fs.rmSync(path.join(root, 'antigravity/dist/opencode.mjs'), { force: true });
copyDir('plugin/skills', 'antigravity/skills');
copyDir('plugin/skills', 'skills');
copyDir('assets', 'plugin/assets');

console.log(`built telepathy ${pkg.version} into plugin/dist`);
