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
- A plain Copilot is `copilot-<pid>` until something claims a session id. On resume (`--resume=<id>`, `--resume <id>`, `--continue`), the MCP server claims the stable id at startup when the process argv and one post-start signal for this cwd agree: a `session.resume` event in `$COPILOT_HOME/session-state/<id>/events.jsonl`, or `workspace.yaml`'s mtime. `inuse.<pid>.lock` is not a signal. Ambiguous signals claim nothing. The later sessionStart hook must bind that same id without a second peer or a second owner. The same id and name across resume is required.
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
