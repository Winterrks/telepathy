// Loads the built OpenCode plugin the way OpenCode does (default export { id, server }) with a fake SDK client.
// Reads one JSON command per stdin line and prints one JSON line per result, so a test can drive it.
import readline from 'node:readline';

const [pluginPath, directory] = process.argv.slice(2);
// The live OpenCode process keeps `--session` on `ps` after dropping it from `process.argv`.
if (process.env.OPENCODE_TEST_HIDE_ARGV === '1') {
  for (const flag of ['--session', '-s', '--continue', '-c', '--fork', '--fork-session']) {
    const at = process.argv.indexOf(flag);
    if (at < 0) continue;
    const next = process.argv[at + 1];
    process.argv.splice(at, next && !next.startsWith('-') ? 2 : 1);
  }
}
if (process.env.OPENCODE_TEST_SESSION) process.argv.push('--session', process.env.OPENCODE_TEST_SESSION);
const mod = await import(pluginPath);
const print = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const listMode = process.env.OPENCODE_TEST_LIST;
// SDK methods read `this`. An unbound `create` or `select` throws the live error.
const session = {
  _sdk: true,
  promptAsync(options) {
    if (this?._sdk !== true) throw new TypeError("undefined is not an object (evaluating 'this._client')");
    print({ prompt: options });
  },
};
if (listMode) {
  // 'hang' never resolves. Plugin init must return without awaiting it.
  // `id` or `id:updatedMs`, comma-separated.
  session.list = function () {
    if (this?._sdk !== true) throw new TypeError("undefined is not an object (evaluating 'this._client')");
    if (listMode === 'hang') return new Promise(() => {});
    return Promise.resolve(
      listMode
        .split(',')
        .filter(Boolean)
        .map((item) => {
          const [id, updated] = item.split(':');
          return updated ? { id, time: { updated: Number(updated) } } : { id };
        }),
    );
  };
}
if (process.env.OPENCODE_TEST_CREATE) {
  session.create = function () {
    if (this?._sdk !== true) throw new TypeError("undefined is not an object (evaluating 'this._client')");
    return { id: process.env.OPENCODE_TEST_CREATE };
  };
  session.select = function (options) {
    if (this?._sdk !== true) throw new TypeError("undefined is not an object (evaluating 'this._client')");
    print({ selected: options.sessionID ?? options.body?.sessionID });
  };
}
// OpenCode 1.19.5's plugin client publishes tui.session.select. selectSession is absent on that client.
const tui = {
  _sdk: true,
  publish(options) {
    if (this?._sdk !== true) throw new TypeError("undefined is not an object (evaluating 'this._client')");
    print({ published: options?.body ?? options });
    return { data: true };
  },
};
if (process.env.OPENCODE_TEST_SELECT === '1') {
  tui.selectSession = function (options) {
    if (this?._sdk !== true) throw new TypeError("undefined is not an object (evaluating 'this._client')");
    print({ selectSession: options });
    return { data: true };
  };
}
const client = { session, tui };
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
