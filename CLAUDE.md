# Working on telepathy

Contributor notes. User-facing behavior is in `README.md`. `plugin/AGENTS.md` and `antigravity/rules/AGENTS.md` are agent guides rewritten by `npm run bundle`; do not edit them by hand.

## Layout

- `src/core/` — peers, inbox, delivery, confirm, listing, process table, Copilot resume claim (`copilot-resume.ts`).
- `src/acp/` — ACP host used by `telepathy run` for Copilot and other ACP harnesses.
- `src/cli/` — the `telepathy` command, harness table, launch.
- `src/headless/` — hosted peers and the inbox pump that pushes messages into a running host.
- `src/agent/` — `start_agent`: the detached host that runs a harness as a subagent, ACP mode/model/effort, and the tools.
- `src/grokbot/` — `telepathy grokbot`: a Grok Bot routine webhook as a hosted `grok:<name>` peer.
- `src/bridge/` — `telepathy bridge`: the per-device daemon, Tailscale trust, mDNS, pairing, and `remote.ts`, which every process uses to list and reach `@device` sessions.
- `src/server.ts` — stdio MCP server. `src/hook.ts` — harness hooks. `src/opencode.ts` — OpenCode and Kilo plugin.
- `plugin/` — manifests, skills, hook config. `plugin/dist/` and `cli/dist/` are the committed bundles.

## Delivery and confirm

Do not weaken these.

- `telepathy run <agent>` pushes messages as they arrive. Plain Copilot, Devin, Qwen, Kimi, Cursor, and Antigravity CLI receive at the next turn via hooks. Claude Code does too when it has no inbox socket. Grok Bot receives from `wait_for_messages`.
- Success is the transcript marker `telepathy-id:<message id>` (`user.message` or `userPromptSubmitted` for Copilot). The sender aborts at 100s (`TELEPATHY_CONFIRM_ABORT_MS`) and checks once more during a 10s grace. A miss fails at 110s. An offline receiver fails immediately. Nothing is queued. A failed send is withdrawn.
- A plain Copilot is `copilot-<pid>` until something claims a session id. An explicit `--resume=<id>` or `--resume <id>` claims that session when its own `session.resume` is newer than the process and the cwd matches, even if another session only rewrote `workspace.yaml`. `--continue` and a bare `--resume` claim nothing when two sessions compete. `inuse.<pid>.lock` is not a signal. The later sessionStart hook must bind that same id without a second peer or a second owner. The same id and name across resume is required. Command lines come from `ps -ww`, so a long argv cannot hide `--resume`.
- `telepathy run` injects the MCP server when the harness will not start one. Send stdio servers on `session/new` only when initialize advertises `mcpCapabilities` `stdio` or `local`. Copilot 1.0.105 advertises http and sse and rejects anything else. For that Copilot, inject with `--additional-mcp-config @<file>` (`type: local`, the plugin command, args, and `tools: ["*"]`) unless an `installed-plugins` copy already starts the server. The file lists every `TELEPATHY_*` name, plus `CODEX_HOME`, `COPILOT_HOME`, `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, and `XDG_RUNTIME_DIR`, so tokens stay out of that temp file. Copilot 1.0.105 still passes its own full environment to the spawned process. The allowlist does not restrict that server's runtime environment. Do not add that flag beside a copy that already starts the server. When the agent has neither stdio nor a command-line injection, say the session has no telepathy tools.
- `telepathy mcp` reads `--name` only when the flag is present and the next argument is a value. Absent, that used to take argv[0] (`mcp`) and persist it as the stable name. A stored name `mcp` is dropped the next time that server starts without an explicit name. A real `--name mcp` is kept.
- Tests set `TELEPATHY_SANDBOX=1`. That process must not exec a Codex binary outside the temp dir or with a `CODEX_HOME` outside the sandbox. Telepathy never writes `config.toml` itself.
- A send to `<address>@<device>` goes from the sender's process to that device's bridge with the sender's remaining deadline less a margin. That bridge runs `deliverLocal` in a `telepathy bridge deliver` child, under the same confirm, and answers inside it. An offline device fails at once. Nothing is queued on either side.
- The bridge trusts a device only by `tailscale whois` (same user, not shared in, on both tailnet addresses) or by a pair key. Pairing is a commitment, an X25519 exchange, and a 6-digit code both users confirm. Do not add a plain-JSON path for anything else, and do not bind 0.0.0.0.
- A device others can't connect to (firewall, NAT) holds `/v1/reverse` open on each device it reaches. Requests for it go from the sender's process to its own bridge's `/v1/outbox` (loopback only, `/v1/peers` and `/v1/send` only), out on that held request, and back on `/v1/reverse/done`. The receiving device runs them through the same `authenticate` as a direct request, with the address it dialed as the remote end. A request not picked up within 1s fails as never sent, so the sender's deadline still holds.
- Messages are wrapped in `<telepathy-peer-message>`; telepathy's own lines in `<telepathy-note kind=…>`. The body escapes `<telepathy-`. The `telepathy-id:` marker stays inside the tag.
- `telepathy run <agent>` is the ACP host wherever the harness has an ACP mode; `--tui` execs the vendor CLI.
- `start_agent` spawns `agent.mjs` (from `src/agent-main.ts`) detached. It strips the parent's session markers from the environment, sets the harness's auto mode (never bypass/yolo), model and effort over ACP, and sends each turn's last run of agent text to the parent with `deliverLocal` and `kind: agent-result`. Permission requests go to the parent; only the parent's `answer_permission` answers them. `state.json` reaches `stopped` only after the transcript is flushed.
- The ACP host calls `authenticate` only for a single auth method the agent runs itself (no `terminal-auth`), with a 30s limit.
- `telepathy setup` and updates approve Codex hooks only through Codex's app-server (`hooks/list`, then `config/batchWrite` of `hooks.state`), and only telepathy's own (`pluginId` `telepathy@…`). `setup` approves untrusted and modified hooks; `update` and auto-update only modified ones (approved before, then changed by an update).
- `telepathy grokbot` hosts a Grok Bot as `grok:<name>`: messages go to its routine webhook as `{"context"}` with `Authorization: Bearer`, the body the Grok Bot app's Run button sends. The POST is the submit, so a 2xx is the delivery marker (like `session/prompt` in the ACP host); a refused POST never is. The key lives in `~/.telepathy/grokbot/<name>.json`, mode 600, and never goes into a log or output.
- `/exit` and `/quit` in the ACP host shut down the way an idle Ctrl-C does. They are not forwarded as prompts. Ctrl-C during a turn still cancels the turn first.

## Commands

```sh
npm test
npm run typecheck
npm run bundle
npm run check          # typecheck, bundle, test
```

Commit the bundle with the source change. Do not add `build`, `prepare`, `install`, or `postinstall` scripts.

Never bump the version or publish without the maintainer. The version stays `0.11.1` until they release.
