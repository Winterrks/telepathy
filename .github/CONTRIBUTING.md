# Contributing to telepathy

Thanks for helping. Bug reports, fixes and support for more agents are all welcome.

- **Found a bug?** Open an issue with the bug report template. Say which agents and versions were involved.
- **Planning something bigger**, like a new agent or a new tool? Open an issue first, so we can agree on the approach
  before you write it.
- **Security issue?** Don't open a public issue. See [SECURITY.md](../SECURITY.md).

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node.js 20 or newer.

```sh
git clone https://github.com/Winterrks/telepathy && cd telepathy
npm install
npm run check                     # typecheck, build, run all tests
claude --plugin-dir ./plugin      # try it in one Claude Code session without installing
```

While testing, `TELEPATHY_DEBUG=1` logs hook, server, monitor and plugin activity to `~/.telepathy/debug.log`, and
`TELEPATHY_HOME=<some folder>` keeps your test sessions apart from your real ones.

## Where things are

- `src/core/`: the shared logic. Agent detection (`agents.ts`), the session registry (`peers.ts`), message storage
  and delivery (`messages.ts`, `deliver.ts`), the tools (`tools.ts`) and the guide every agent gets (`guide.ts`).
- `src/server.ts` is the MCP server, `src/hook.ts` the hooks for every agent, `src/monitor.ts` Claude Code's
  monitor, and `src/opencode.ts` the OpenCode and Kilo Code plugin.
- `scripts/build.mjs` bundles everything into `plugin/dist/` and writes each agent's generated files.
- Manifests: `plugin/` (Claude Code, Codex, Copilot CLI, Cursor, Devin, Grok), the repo root (Gemini CLI, Qwen Code,
  Kimi Code) and `antigravity/`.
- `test/core.test.ts` covers the logic; `test/integration.test.ts` drives the built plugin, hooks, monitor and
  OpenCode plugin end to end.

## Making a change

- Edit `src/` and `plugin/skills/`. Don't edit `plugin/dist/`, `antigravity/dist/`, `antigravity/skills/`,
  `skills/` or the generated `AGENTS.md` files: `npm run bundle` rewrites them.
- Commit the rebuilt `plugin/dist/` with your change. Agents install straight from this repository, with no build
  step, so the bundle has to be up to date.
- Add or update tests. `npm run check` must pass.
- Don't add `build`, `prepare`, `install` or `postinstall` scripts to `package.json`. OpenCode installs from git
  and would run them, which breaks the install. Packages go in `devDependencies`, since the bundle includes them.
- Update the README when users would notice the change.
- Leave the version alone; it's bumped at release.

## Adding an agent

An agent needs:

1. an entry in `src/core/agents.ts`, so telepathy recognizes its process;
2. its hook output format in `SHAPES` in `src/hook.ts`, if it has hooks;
3. a manifest (plus MCP and hook config) where its installer looks, and a line in `MANIFESTS` in
   `scripts/build.mjs` so the version gets stamped;
4. tests, a row in the README's supported agents table and an installation section.

Put a default `.mcp.json` or `hooks/hooks.json` in `plugin/` only if no other agent would pick it up by accident;
several agents read each other's plugin formats. In the pull request, say which versions of the agent you tested
with, and whether a message reached it end to end.
