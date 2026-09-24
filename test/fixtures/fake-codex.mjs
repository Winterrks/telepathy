#!/usr/bin/env node
// Stands in for the `codex` CLI in tests: records each invocation as one JSON line in $FAKE_CODEX_LOG.
import fs from 'node:fs';

fs.appendFileSync(
  process.env.FAKE_CODEX_LOG,
  JSON.stringify({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null }) + '\n',
);
if (process.env.FAKE_CODEX_FAIL === '1') {
  process.stderr.write('Error: thread not found\n');
  process.exit(1);
}
process.stdout.write('Queued message fake for thread fake.\n');
