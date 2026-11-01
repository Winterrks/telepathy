import { runAgent } from './agent/host.ts';

// The detached host `start_agent` spawns: `node agent.mjs <agent folder>`.
runAgent(process.argv[2] ?? '').then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`telepathy agent: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
