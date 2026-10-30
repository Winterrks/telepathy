import { agentLabel, type Agent } from '../core/agents.ts';
import { ANTIGRAVITY_SIDECAR_ID, antigravitySidecarEnabled, leftoverGeminiExtension, LEFTOVER_GEMINI_NOTE } from '../core/antigravity.ts';
import { findInstalls, isNewer, type Install } from '../core/installs.ts';
import { stateDir } from '../core/paths.ts';
import { VERSION } from '../core/version.ts';
import { autoUpdateCheckedAt, autoUpdateEnabled } from '../auto-update.ts';
import { cachedGithubVersion, latestGithubVersion, rememberGithubVersion } from '../version-check.ts';
import { detectedHarnesses, harnesses, resolvedBin } from './harnesses.ts';

function freshness(version: string, latest: string | undefined): string {
  if (!latest) return 'latest unknown';
  if (!isNewer(latest, version) && !isNewer(version, latest)) return 'current';
  if (isNewer(version, latest)) return `ahead of GitHub ${latest}`;
  return `outdated (latest ${latest})`;
}

/**
 * Detected installs and whether each matches the version on GitHub main.
 * `doctor` adds the state directory, auto-update, and which harness CLIs are on PATH.
 */
export async function statusReport(options: { doctor?: boolean } = {}): Promise<{ text: string; code: number }> {
  let latest: string | undefined = process.env.TELEPATHY_LATEST_VERSION?.trim() || cachedGithubVersion();
  let latestError: string | undefined;
  if (!process.env.TELEPATHY_LATEST_VERSION?.trim()) {
    try {
      latest = await latestGithubVersion();
      rememberGithubVersion(latest);
    } catch (err) {
      latestError = (err as Error).message;
      latest = latest ?? cachedGithubVersion();
    }
  }
  const installs = findInstalls();
  const lines: string[] = [];
  lines.push(`telepathy CLI ${VERSION}`);
  lines.push(`state: ${stateDir()}`);
  lines.push(`auto-update: ${autoUpdateEnabled() ? 'on' : 'off'}${autoUpdateCheckedAt() ? ` (last check ${autoUpdateCheckedAt()})` : ''}`);
  if (latest) lines.push(`latest on GitHub: ${latest}`);
  else lines.push(`latest on GitHub: unavailable${latestError ? ` (${latestError})` : ''}`);
  lines.push('');
  if (!installs.length) lines.push('No installed copy of telepathy was found.');
  else {
    lines.push('Installed copies:');
    const seen = new Set<Agent>();
    for (const install of installs) {
      seen.add(install.agent);
      lines.push(`- ${agentLabel(install.agent)} ${install.version}  ${freshness(install.version, latest)}  ${install.dir}`);
    }
    for (const harness of harnesses()) {
      if (seen.has(harness.agent)) continue;
      if ((harness.agent === 'grok' || harness.agent === 'cursor') && seen.has('claude')) {
        lines.push(`- ${agentLabel(harness.agent)} uses Claude Code's copy when that plugin is installed`);
      }
    }
  }
  if (options.doctor) {
    lines.push('');
    lines.push(`node ${process.version}`);
    lines.push('Harness CLIs on PATH:');
    for (const harness of harnesses()) {
      const bin = resolvedBin(harness);
      lines.push(`- ${agentLabel(harness.agent)}: ${bin ?? 'not on PATH'}`);
    }
    const idle = detectedHarnesses().filter((harness) => !installs.some((install: Install) => install.agent === harness.agent));
    if (idle.length) lines.push(`On PATH with no copy of their own: ${idle.map((harness) => harness.agent).join(', ')}.`);
    lines.push(
      `Antigravity App sidecar (${ANTIGRAVITY_SIDECAR_ID}): ${antigravitySidecarEnabled() ? 'enabled' : 'not enabled in ~/.gemini/config/config.json'}`,
    );
    const leftover = leftoverGeminiExtension();
    if (leftover) lines.push(`Leftover Gemini CLI extension: ${leftover}. ${LEFTOVER_GEMINI_NOTE} \`telepathy install --remove-legacy\` removes it.`);
  }
  return { text: lines.join('\n'), code: 0 };
}
