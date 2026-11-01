import { updateAll } from './update-all.ts';
import { VERSION } from './core/version.ts';
import { configCommand } from './cli/config.ts';
import { installAll, parseOnly } from './cli/install.ts';
import { runCommand } from './cli/run.ts';
import { bridgeCommand } from './bridge/cli.ts';
import { formatHeadlessPs, stopHeadless } from './headless/peer.ts';
import { statusReport } from './cli/status.ts';
import { isCliEntry } from './cli/entry.ts';
import { argvFlag } from './core/argv.ts';

const HELP = `telepathy ${VERSION}

Usage:
  telepathy setup [--dry-run] [--only a,b] [--no-hooks] [--no-adapters]
  telepathy update [--dry-run]
  telepathy status
  telepathy doctor
  telepathy install [--dry-run] [--only a,b] [--remove-legacy]
  telepathy config [auto-update on|off]
  telepathy run [--list] [--tui | --headless] [--install] [--name X] [--cwd D] <agent> [args...]
  telepathy ps
  telepathy stop <name>
  telepathy bridge [start|stop|status|watch|pair|forget|add|remove|name]
  telepathy grokbot [connect|start|stop|status|test|send|peers|disconnect]
  telepathy mcp --agent <agent>
  telepathy --help
  telepathy --version

\`run\` starts the agent in its ACP mode under telepathy, so a message starts a turn even while it is idle.
Claude Code and Codex need their ACP adapters (claude-agent-acp, codex-acp). \`--tui\` execs the vendor
CLI instead; a session started that way, or on its own, is still reachable through its plugin.
\`agy\` is an alias for antigravity. Agents without an ACP mode (Hermes, OpenClaw, Pi) start their CLI.
\`--headless\` keeps a peer up until \`telepathy stop\`: Claude stream-json, Codex app-server,
OpenCode serve, or ACP. \`--name\` reuses the same peer id after a restart.
\`run\` does not install a plugin or edit a global config unless \`--install\` is passed.

\`setup\` installs telepathy in every agent CLI it finds, updates old copies, approves telepathy's own hooks where the
agent has a command for it, and installs the Claude Code and Codex ACP adapters.

\`bridge\` reaches sessions on your other devices over Tailscale or the local network (\`telepathy bridge help\`).
\`grokbot\` connects a Grok Bot routine webhook, so a message wakes the Bot with its text (\`telepathy grokbot help\`).

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
  if (cmd === 'setup') {
    const { setupCommand } = await import('./cli/setup.ts');
    return setupCommand(rest);
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
    const onlyValue = argvFlag(rest, '--only');
    if (rest.includes('--only') && !onlyValue && !onlyEq) throw new Error('--only needs a value');
    const only = onlyEq ? parseOnly(onlyEq.slice('--only='.length)) : parseOnly(onlyValue);
    return installAll({ dryRun, only, removeLegacy });
  }
  if (cmd === 'config') return configCommand(rest);
  if (cmd === 'run') return runCommand(rest);
  if (cmd === 'bridge') return bridgeCommand(rest);
  if (cmd === 'grokbot') {
    const { grokbotCommand } = await import('./grokbot/cli.ts');
    return grokbotCommand(rest);
  }
  if (cmd === 'agent-host') {
    const { runAgent } = await import('./agent/host.ts');
    return runAgent(rest[0] ?? '');
  }
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
