import { probeDelivery, type ProbeReport } from './core/wake.ts';

/**
 * Check a configured wake without sending a message:
 *   node delivery.mjs test [name]
 * Posts {"event":"probe"}. A receiver that ignores probe events does not start a turn.
 */

function parse(argv: string[]): { command?: string; name?: string } {
  const rest = argv[0] === 'delivery' ? argv.slice(1) : argv;
  return { command: rest[0], name: rest[1] };
}

export function formatProbe(report: ProbeReport): string {
  if (report.how === 'webhook') {
    if (report.status !== undefined) return `webhook ${report.target} HTTP ${report.status}`;
    return `webhook ${report.target} failed: ${report.detail ?? 'error'}`;
  }
  if (report.status !== undefined) return `command ${report.target} exited ${report.status}`;
  return `command ${report.target} failed: ${report.detail ?? 'error'}`;
}

export async function runDeliveryCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { command, name } = parse(argv);
  if (command !== 'test') {
    return { code: 2, stdout: '', stderr: 'usage: node delivery.mjs test [name]\n' };
  }
  const { reports, error } = await probeDelivery(name);
  if (error) return { code: 1, stdout: '', stderr: `${error}\n` };
  const stdout = reports.map((report) => `${formatProbe(report)}\n`).join('');
  return { code: reports.every((report) => report.ok) ? 0 : 1, stdout, stderr: '' };
}

const invoked = process.argv[1]?.endsWith('delivery.ts') || process.argv[1]?.endsWith('delivery.mjs');
if (invoked) {
  const result = await runDeliveryCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
