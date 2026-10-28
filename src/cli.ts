import { updateAll } from './update-all.ts';
import { VERSION } from './core/version.ts';
import { configCommand } from './cli/config.ts';
import { installAll, parseOnly } from './cli/install.ts';
import { runCommand } from './cli/run.ts';
import { formatHeadlessPs, stopHeadless } from './headless/peer.ts';
import { statusReport } from './cli/status.ts';
import { isCliEntry } from './cli/entry.ts';

const HELP = `telepathy ${VERSION}

Usage:
  telepathy update [--dry-run]
  telepathy status
  telepathy doctor
  telepathy install [--dry-run] [--only a,b] [--remove-legacy]
  telepathy config [auto-update on|off]
  telepathy run [--list] [--acp | --headless] [--install] [--name X] [--cwd D] <agent> [args...]
  telepathy ps
  telepathy stop <name>
  telepathy mcp --agent <agent>
  telepathy --help
  telepathy --version

\`run\` execs the vendor CLI when that CLI can wake an idle session (Claude Code, Codex, OpenCode, Kilo).
Copilot CLI starts an ACP host instead. \`agy\` is an alias for antigravity. \`--acp\` forces ACP where a launcher exists.
\`--headless\` keeps a peer up until \`telepathy stop\`: Claude stream-json, Codex app-server,
OpenCode serve, or ACP. \`--name\` reuses the same peer id after a restart.

Auto-update is on by default. \`telepathy config auto-update off\` or TELEPATHY_AUTO_UPDATE=0 disables it.
State lives in TELEPATHY_HOME, or ~/.telepathy.
`;

async function main(argv: string[]): Promise<number> {
  // The bundled CLI spawns itself for auto-update. The hook entry handles this flag too.
  if (argv.includes('--telepathy-auto-update')) {
    const { runAutoUpdate } = await import('./auto-update.ts');
    await runAutoUpdate();
    return 0;
  }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (cmd === 'update') return updateAll({ dryRun: rest.includes('--dry-run') });
  if (cmd === 'status' || cmd === 'doctor') {
    const report = await statusReport({ doctor: cmd === 'doctor' });
    console.log(report.text);
    return report.code;
  }
  if (cmd === 'install') {
    const dryRun = rest.includes('--dry-run');
    const removeLegacy = rest.includes('--remove-legacy');
    const onlyEq = rest.find((arg) => arg.startsWith('--only='));
    const onlyFlag = rest.indexOf('--only');
    const only = onlyEq ? parseOnly(onlyEq.slice('--only='.length)) : onlyFlag >= 0 ? parseOnly(rest[onlyFlag + 1]) : undefined;
    return installAll({ dryRun, only, removeLegacy });
  }
  if (cmd === 'config') return configCommand(rest);
  if (cmd === 'run') return runCommand(rest);
  if (cmd === 'ps') {
    console.log(formatHeadlessPs());
    return 0;
  }
  if (cmd === 'stop') {
    const name = rest[0];
    if (!name) {
      console.error('Usage: telepathy stop <name>');
      return 1;
    }
    return stopHeadless(name);
  }
  if (cmd === 'mcp') {
    const { startMcpServer } = await import('./server.ts');
    await startMcpServer();
    return 0;
  }
  console.error(`Unknown command ${JSON.stringify(cmd)}.\n\n${HELP}`);
  return 1;
}

function invokedAsCli(): boolean {
  return isCliEntry(process.argv[1] ?? '');
}

if (invokedAsCli()) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
