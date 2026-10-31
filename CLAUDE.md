# Working on telepathy

Contributor notes. User-facing behavior is in `README.md`. `plugin/AGENTS.md` and `antigravity/rules/AGENTS.md` are agent guides rewritten by `npm run bundle`; do not edit them by hand.

## Layout

- `src/core/` — peers, inbox, delivery, confirm, listing, process table, Copilot resume claim (`copilot-resume.ts`).
- `src/acp/` — ACP host used by `telepathy run` for Copilot and other ACP harnesses.
- `src/cli/` — the `telepathy` command, harness table, launch.
- `src/headless/` — hosted peers and the inbox pump that pushes messages into a running host.
- `src/server.ts` — stdio MCP server. `src/hook.ts` — harness hooks. `src/opencode.ts` — OpenCode and Kilo plugin.
- `plugin/` — manifests, skills, hook config. `plugin/dist/` and `cli/dist/` are the committed bundles.

## Delivery and confirm

Do not weaken these.

- `telepathy run <agent>` pushes messages as they arrive. Plain Copilot, Devin, Qwen, Kimi, Cursor, and Antigravity CLI receive at the next turn via hooks. Claude Code does too when it has no inbox socket. Grok Bot receives from `wait_for_messages`.
- Success is the transcript marker `telepathy-id:<message id>` (`user.message` or `userPromptSubmitted` for Copilot). The sender aborts at 100s (`TELEPATHY_CONFIRM_ABORT_MS`) and checks once more during a 10s grace. A miss fails at 110s. An offline receiver fails immediately. Nothing is queued. A failed send is withdrawn.
- A plain Copilot is `copilot-<pid>` until something claims a session id. An explicit `--resume=<id>` or `--resume <id>` claims that session when its own `session.resume` is newer than the process and the cwd matches, even if another session only rewrote `workspace.yaml`. `--continue` and a bare `--resume` claim nothing when two sessions compete. `inuse.<pid>.lock` is not a signal. The later sessionStart hook must bind that same id without a second peer or a second owner. The same id and name across resume is required. Command lines come from `ps -ww`, so a long argv cannot hide `--resume`.
- `telepathy run` injects the MCP server when the harness will not start one. Send stdio servers on `session/new` only when initialize advertises `mcpCapabilities` `stdio` or `local`. Copilot 1.0.105 advertises http and sse and rejects anything else. For that Copilot, inject with `--additional-mcp-config @<file>` (`type: local`, the plugin command, args, and `tools: ["*"]`) unless an `installed-plugins` copy already starts the server. The file lists `TELEPATHY_*`, `PATH`, `HOME`, and the other variables the server reads. It does not contain the rest of the process environment. Do not add that flag beside a copy that already starts the server. When the agent has neither stdio nor a command-line injection, say the session has no telepathy tools.
- `telepathy mcp` reads `--name` only when the flag is present and the next argument is a value. Absent, that used to take argv[0] (`mcp`) and persist it as the stable name. A stored name `mcp` is dropped the next time that server starts without an explicit name. A real `--name mcp` is kept.
- Tests set `TELEPATHY_SANDBOX=1`. That process must not exec a Codex binary outside the temp dir or with a `CODEX_HOME` outside the sandbox. Telepathy never writes `config.toml` itself.
- `/exit` and `/quit` in the ACP host shut down the way an idle Ctrl-C does. They are not forwarded as prompts. Ctrl-C during a turn still cancels the turn first.

## Commands

```sh
npm test
npm run typecheck
npm run bundle
npm run check          # typecheck, bundle, test
```

Commit the bundle with the source change. Do not add `build`, `prepare`, `install`, or `postinstall` scripts.

Never bump the version or publish without the maintainer. The version stays `0.9.0` until they release.
