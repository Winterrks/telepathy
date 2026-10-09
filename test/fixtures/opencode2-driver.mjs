// Loads the built OpenCode plugin the way OpenCode 2 does (default export { id, setup }, called once per project
// directory of one service process) with a fake plugin context. Reads one JSON command per stdin line and prints one
// JSON line per result, so a test can drive it.
import readline from 'node:readline';

const [pluginPath, ...directories] = process.argv.slice(2);
const mod = await import(pluginPath);
const print = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const known = new Set((process.env.FAKE_OPENCODE_SESSIONS ?? '').split(',').filter(Boolean));

/** One project directory's plugin instance: its hooks, tools, skills and event stream. */
function makeContext(directory) {
  const hooks = {};
  const toolHooks = {};
  const tools = {};
  const skills = {};
  const queue = [];
  let wake;
  const dispose = { dispose() {} };
  const ctx = {
    location: { directory },
    event: {
      subscribe: ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (queue.length) yield queue.shift();
            else await new Promise((resolve) => (wake = resolve));
          }
        },
      }),
    },
    session: {
      hook: (name, fn) => ((hooks[name] = fn), dispose),
      prompt: async (input) => print({ prompt: input, directory }),
      get: async ({ sessionID }) => {
        if (!known.has(sessionID)) throw new Error('Session not found');
        return { id: sessionID };
      },
    },
    tool: {
      transform: (fn) => (fn({ get: (id) => tools[id], add: (tool) => (tools[tool.name] = tool) }), dispose),
      hook: (name, fn) => ((toolHooks[name] = fn), dispose),
    },
    skill: { transform: (fn) => (fn({ get: (id) => skills[id], add: (skill) => (skills[skill.id] = skill) }), dispose) },
  };
  const push = (event) => {
    queue.push(event);
    wake?.();
  };
  return { ctx, hooks, toolHooks, tools, skills, push };
}

const instances = {};
for (const directory of directories) {
  instances[directory] = makeContext(directory);
  await mod.default.setup(instances[directory].ctx);
}
const first = instances[directories[0]];
print({ ready: process.pid, tools: Object.keys(first.tools), skills: Object.keys(first.skills) });

for await (const line of readline.createInterface({ input: process.stdin })) {
  const cmd = JSON.parse(line);
  const it = instances[cmd.directory ?? directories[0]];
  if (cmd.op === 'prompt') await it.hooks.prompt({ sessionID: cmd.sessionID, prompt: { text: 'hi' }, delivery: 'steer' });
  if (cmd.op === 'event') {
    for (const i of Object.values(instances)) i.push(cmd.event); // the service sends every instance its events
    await new Promise((r) => setTimeout(r, 50));
  }
  if (cmd.op === 'tool') {
    const result = await it.tools[cmd.name].execute(cmd.args ?? {}, { sessionID: cmd.sessionID });
    print({ tool: cmd.name, output: result.content });
  }
  if (cmd.op === 'run') {
    // A built-in tool call that completed: its result goes through the execute.after hook.
    const event = { tool: cmd.name, sessionID: cmd.sessionID, input: cmd.args, status: 'completed', result: { content: 'ok' } };
    await it.toolHooks['execute.after'](event);
    print({ ran: cmd.name, output: event.result.content });
  }
  if (cmd.op === 'context') {
    const event = { sessionID: cmd.sessionID, system: [] };
    await it.hooks.context(event);
    print({ system: event.system });
  }
  print({ done: cmd.op });
}
