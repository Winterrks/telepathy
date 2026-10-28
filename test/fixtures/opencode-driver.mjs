// Loads the built OpenCode plugin the way OpenCode does (default export { id, server }) with a fake SDK client.
// Reads one JSON command per stdin line and prints one JSON line per result, so a test can drive it.
import readline from 'node:readline';

const [pluginPath, directory] = process.argv.slice(2);
if (process.env.OPENCODE_TEST_SESSION) process.argv.push('--session', process.env.OPENCODE_TEST_SESSION);
const mod = await import(pluginPath);
const print = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const listMode = process.env.OPENCODE_TEST_LIST;
const client = {
  session: {
    promptAsync: async (options) => print({ prompt: options }),
    ...(listMode
      ? {
          // 'hang' never resolves. Plugin init must return without awaiting it.
          list: () =>
            listMode === 'hang' ? new Promise(() => {}) : Promise.resolve(listMode.split(',').filter(Boolean).map((id) => ({ id }))),
        }
      : {}),
  },
};
const hooks = await mod.default.server({ client, directory });
print({ ready: process.pid, tools: Object.keys(hooks.tool) });

for await (const line of readline.createInterface({ input: process.stdin })) {
  const cmd = JSON.parse(line);
  if (cmd.op === 'chat') await hooks['chat.message']({ sessionID: cmd.sessionID, agent: 'build' }, { message: {}, parts: [] });
  if (cmd.op === 'event') await hooks.event({ event: cmd.event });
  if (cmd.op === 'tool') print({ tool: cmd.name, output: await hooks.tool[cmd.name].execute(cmd.args ?? {}, { sessionID: cmd.sessionID }) });
  if (cmd.op === 'run') {
    // One built-in tool call: its arguments go through tool.execute.before, its result through tool.execute.after.
    const callID = `call-${Math.random().toString(36).slice(2)}`;
    await hooks['tool.execute.before']({ tool: cmd.name, sessionID: cmd.sessionID, callID }, { args: cmd.args });
    const output = { title: cmd.name, output: 'ok', metadata: {} };
    await hooks['tool.execute.after']({ tool: cmd.name, sessionID: cmd.sessionID, callID }, output);
    print({ ran: cmd.name, output: output.output });
  }
  if (cmd.op === 'system') {
    const output = { system: [] };
    await hooks['experimental.chat.system.transform']({}, output);
    print({ system: output.system });
  }
  print({ done: cmd.op });
}
