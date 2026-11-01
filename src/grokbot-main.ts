import { grokbotCommand } from './grokbot/cli.ts';

// `node grokbot.mjs <grokbot command>`: the Grok Bot host and its `send`/`peers`, next to the plugin's server so a
// plugin install needs no CLI. `telepathy grokbot …` runs the same code.
grokbotCommand(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`telepathy grokbot: ${(err as Error).message}\n`);
    process.exitCode = 1;
  },
);
