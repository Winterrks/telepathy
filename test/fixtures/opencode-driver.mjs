// Loads the built OpenCode plugin the way OpenCode does (default export { id, server }) with a fake SDK client.
// Reads one JSON command per stdin line and prints one JSON line per result, so a test can drive it.
import readline from 'node:readline';

const [pluginPath, directory] = process.argv.slice(2);
const mod = await import(pluginPath);
const print = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const client = { session: { promptAsync: async (options) => print({ prompt: options }) } };
const hooks = await mod.default.server({ client, directory });
print({ ready: process.pid, tools: Object.keys(hooks.tool) });

for await (const line of readline.createInterface({ input: process.stdin })) {
  const cmd = JSON.parse(line);
  if (cmd.op === 'chat') await hooks['chat.message']({ sessionID: cmd.sessionID, agent: 'build' }, { message: {}, parts: [] });
  if (cmd.op === 'event') await hooks.event({ event: cmd.event });
  if (cmd.op === 'tool') print({ tool: cmd.name, output: await hooks.tool[cmd.name].execute(cmd.args ?? {}, { sessionID: cmd.sessionID }) });
  if (cmd.op === 'system') {
    const output = { system: [] };
    await hooks['experimental.chat.system.transform']({}, output);
    print({ system: output.system });
  }
  print({ done: cmd.op });
}
