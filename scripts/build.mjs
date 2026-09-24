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
  entryPoints: ['server', 'hook', 'monitor'].map((name) => path.join(root, 'src', `${name}.ts`)),
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

for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
  const file = path.join(pluginDir, manifest);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json.version !== pkg.version) {
    json.version = pkg.version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  }
}

console.log(`built telepathy ${pkg.version} into plugin/dist`);
