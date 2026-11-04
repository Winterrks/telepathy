# Development

Contributor notes are in [CLAUDE.md](../../CLAUDE.md).

```sh
npm install
npm run check                     # typecheck, build, run all tests
claude --plugin-dir ./plugin      # try it in one Claude Code session without installing
```

- `src/`: the TypeScript source. `plugin/dist/` is the bundled build (committed, so installing needs no build step);
  read `src/` for the code.
- `test/core.test.ts`: naming, address resolution, agent detection, message formatting, the registry.
- `test/integration.test.ts`: drives the built plugin through the official MCP client SDK, runs the real hooks,
  monitor and OpenCode plugin, and uses a fake `codex` binary that records what `codex queue` would receive.

`npm run bundle` builds `plugin/dist` and `cli/dist` and rewrites generated files (manifest versions, the Antigravity copy, rule
files, `plugin/AGENTS.md`). Leave the version in `package.json` alone. The maintainer bumps it at release. Do not publish.
