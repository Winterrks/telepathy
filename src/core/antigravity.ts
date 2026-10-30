import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Which Antigravity surface owns a conversation, from its `<app_data_dir>`. */
export type AntigravitySurface = 'app' | 'cli' | 'ide';

/** Plugin sidecar id: `<plugin>/<sidecar directory>`. */
export const ANTIGRAVITY_SIDECAR_ID = 'telepathy/telepathy-wake';

/**
 * App data directories, longest suffix first so `antigravity-cli` is not read as the App's `antigravity`.
 * Docs: `~/.gemini/antigravity` is the App, `antigravity-cli` the CLI, `antigravity-ide` the IDE.
 */
export function antigravitySurface(transcriptPath: string | undefined): AntigravitySurface | undefined {
  if (!transcriptPath) return undefined;
  const norm = transcriptPath.replace(/\\/g, '/');
  if (norm.includes('/antigravity-cli/')) return 'cli';
  if (norm.includes('/antigravity-ide/')) return 'ide';
  if (norm.includes('/antigravity/')) return 'app';
  return undefined;
}

/** `~/...` in a hook payload becomes this user's home. Other paths are unchanged. */
export function expandHomePath(file: string): string {
  if (file === '~') return os.homedir();
  if (file.startsWith('~/') || file.startsWith('~\\')) return path.join(os.homedir(), file.slice(2));
  return file;
}

export function geminiConfigFile(): string {
  return path.join(os.homedir(), '.gemini', 'config', 'config.json');
}

/** The old Gemini CLI extension. `agy plugin import gemini` would install it again beside the native plugin. */
export function leftoverGeminiExtension(): string | undefined {
  const dir = path.join(os.homedir(), '.gemini', 'extensions', 'telepathy');
  return fs.existsSync(path.join(dir, 'gemini-extension.json')) ? dir : undefined;
}

export function removeLeftoverGeminiExtension(): string | undefined {
  const dir = leftoverGeminiExtension();
  if (!dir) return undefined;
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

interface GeminiConfig {
  sidecars?: Record<string, { enabled?: boolean; projectId?: string }>;
  [key: string]: unknown;
}

function readGeminiConfig(): GeminiConfig {
  try {
    return JSON.parse(fs.readFileSync(geminiConfigFile(), 'utf8')) as GeminiConfig;
  } catch {
    return {};
  }
}

/** Whether `~/.gemini/config/config.json` enables the App wake sidecar. */
export function antigravitySidecarEnabled(): boolean {
  return readGeminiConfig().sidecars?.[ANTIGRAVITY_SIDECAR_ID]?.enabled === true;
}

/** Turns the sidecar on without dropping other config or an existing projectId. */
export function enableAntigravitySidecar(): void {
  const file = geminiConfigFile();
  const json = readGeminiConfig();
  const current = json.sidecars?.[ANTIGRAVITY_SIDECAR_ID] ?? {};
  json.sidecars = { ...json.sidecars, [ANTIGRAVITY_SIDECAR_ID]: { ...current, enabled: true } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

export const LEFTOVER_GEMINI_NOTE =
  'Gemini CLI is deprecated. Remove this directory so `agy plugin import gemini` does not install telepathy a second time.';
