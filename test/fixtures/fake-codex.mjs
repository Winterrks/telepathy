#!/usr/bin/env node
// Stands in for the `codex` CLI in tests: records each invocation as one JSON line in $FAKE_CODEX_LOG.
// `queue` keeps the queued ids in $FAKE_CODEX_LOG.queue.json; `app-server` answers thread/queue/delete from it.
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv, codexHome: process.env.CODEX_HOME ?? null }) + '\n');
if (process.env.FAKE_CODEX_FAIL === '1') {
  process.stderr.write('Error: thread not found\n');
  process.exit(1);
}

const queueFile = `${process.env.FAKE_CODEX_LOG}.queue.json`;
const readQueue = () => (fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : []);

if (argv[0] === 'app-server') {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    if (msg.method === 'initialize') reply({ userAgent: 'fake' });
    if (msg.method === 'thread/queue/delete') {
      const queue = readQueue();
      const deleted = queue.includes(msg.params.queuedSubmissionId);
      fs.writeFileSync(queueFile, JSON.stringify(queue.filter((id) => id !== msg.params.queuedSubmissionId)));
      reply({ deleted });
    }
  });
} else {
  const id = `q-${readQueue().length}-${process.pid}`;
  fs.writeFileSync(queueFile, JSON.stringify([...readQueue(), id]));
  process.stdout.write(`Queued message ${id} for thread fake.\n`);
}
