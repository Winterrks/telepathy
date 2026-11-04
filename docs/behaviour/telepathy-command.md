# The telepathy command

`telepathy` is a separate program from the plugin. It is published as **telepathy-cli** (the npm name `telepathy` is already taken). The plugin in this repository stays the private package OpenCode installs from git, still version 0.13.0. Requires Node 20 or newer.

Install it and set up every agent CLI it finds:

```sh
npm install -g telepathy-cli && telepathy setup
```

```sh
telepathy setup [--dry-run]           # install, update, approve hooks and install ACP adapters, everywhere
telepathy update [--dry-run]          # every installed copy, each with that harness's own updater
telepathy status                      # what is installed, and whether GitHub is newer
telepathy doctor                      # status, plus Node and which harness CLIs are on PATH
telepathy install [--dry-run] [--only claude,codex]
telepathy config auto-update off      # on by default; TELEPATHY_AUTO_UPDATE=0 also disables it
telepathy run <agent> [args...]       # the agent in its ACP mode, under telepathy's host
telepathy run --tui <agent> [args...] # the vendor TUI itself
telepathy run --list
telepathy run --headless --name box <agent>
telepathy ps
telepathy stop box
telepathy bridge start                # reach sessions on your other devices (see Across devices)
telepathy grokbot connect <name> <url> # a Grok Bot routine webhook as a session (see Grok Bot)
```

## Setup

`telepathy setup` looks for every agent CLI on `PATH`. It installs telepathy where it is missing, updates a copy older
than GitHub, approves telepathy's own Codex hooks, installs the Claude Code and Codex ACP adapters
(`@zed-industries/claude-agent-acp`, `@zed-industries/codex-acp`) when they are missing, and enables the Antigravity
App sidecar. It prints one line per agent and then what is left for you: Cursor installs from the Marketplace tab of
`/plugin`; Grok and Cursor load Claude Code's copy; Hermes, OpenClaw and Pi have no plugin. `--only claude,codex`
limits it, `--no-hooks` and `--no-adapters` skip those steps, and `--dry-run` only prints the plan. It exits 1 when
something failed.

## Running an agent under telepathy's host

`telepathy run <agent>` starts the agent in its ACP mode under telepathy's host, so an incoming message starts a turn even while the session is idle: `claude-agent-acp` (Claude Code; `claude-code-acp` is the older adapter name), `codex-acp` (Codex), `opencode acp`, `kilo acp`, `copilot --acp`, `qwen --acp`, `grok agent stdio`, `devin acp`, `cursor-agent acp`, `kimi acp`, and `antigravity-acp` (alias `agy`; `agy_acp_server.par` is the older adapter name). Claude Code and Codex need their adapters: `npm install -g @zed-industries/claude-agent-acp` and `npm install -g @zed-industries/codex-acp`. When one is missing, `run` says so and exits. `telepathy run --tui <agent>` execs the vendor CLI with your arguments and a full terminal instead. A session started that way, or started on its own without `telepathy run`, keeps its own TUI and is reachable through its plugin as before. Hermes, OpenClaw and Pi have no ACP mode and start their CLI. Telepathy is installed first if it is missing. A newer GitHub version is checked from the local cache and updated in the background, without blocking the session. The ACP host has telepathy's tools when the agent's own plugin starts telepathy's MCP server, or when the agent accepts one from the host; otherwise it says the session has no telepathy tools, and the session can still receive.

## Hosted and headless sessions

`telepathy run --headless <agent> --name <name> [--cwd <dir>]` keeps a peer up until `telepathy stop`. Claude Code stays on `claude -p` with stream-json stdin. Codex is an app-server thread. OpenCode (and Kilo) is `serve` plus a session prompt. Antigravity is a long-lived `agy --input-format stream-json --output-format stream-json` (not `agy -p`), and it refuses to start on a consumer login. Copilot and Qwen use the ACP host. The terminal shows a short status line. The harness's raw stream is appended to a log under the telepathy state directory. Model text is written as normal output, not one line per chunk. `--name` is the only peer: when the agent already has the telepathy plugin, that plugin's server is given `TELEPATHY_NAME` and the host does not register a second peer. A send succeeds only when the transcript shows the message id, inside the same 110 second confirm. An ACP turn that starts with a tool call or a permission request counts as delivered. An exited peer fails immediately and leaves nothing in the inbox. A failed send withdraws its copy, including a stream-json line or ACP prompt that has not been submitted. Ctrl-C during an interactive ACP turn cancels that turn; Ctrl-C while idle, or a second Ctrl-C, exits. `/exit` and `/quit` exit immediately, including while a turn or a permission question is open, and are not sent to the agent. Matching ignores case and surrounding whitespace.

## Auto-update

Auto-update runs at most once a day, from a session-start hook, the MCP server and the [bridge](devices.md), in a detached process. When the bridge sees a newer version on one of your other devices, it runs the check at once instead (at most once an hour for each version). It does not block the session. Failures are written to `auto-update.log` in the state directory (`TELEPATHY_HOME`, or `~/.telepathy`). `TELEPATHY_AUTO_UPDATE=0` wins, and each harness's MCP config forwards that variable (Codex only forwards names listed in `env_vars`). A `TELEPATHY_HOME` other than `~/.telepathy` is a sandbox: auto-update does not touch installs outside it. `telepathy update` skips a copy that is already the current version, and it prints the Codex restart note only when a version changed. When `telepathy-cli` is installed globally (`npm root -g`) and npm has a newer version, `telepathy update` and auto-update also run `npm install -g telepathy-cli@<version>`; a CLI run from a git checkout is left alone.

## Updating every agent

Each agent keeps its own copy of telepathy, so an update in one doesn't reach the others. Every copy ships a script
that updates all of them with each agent's own update command:

```sh
node ~/.claude/plugins/cache/telepathy/telepathy/<version>/dist/update-all.mjs
```

Any installed copy's `dist/update-all.mjs` works the same; add `--dry-run` to see what it would run. It needs the
network (the agents fetch from GitHub), answers yes to Qwen's update confirmation, and reinstalls OpenCode 1.x
and Kilo Code by clearing their package cache. OpenCode 2's `opencode plugin update` doesn't see git plugins, so its
package folder is moved aside and `opencode plugin add` reinstalls it; the old copy comes back if nothing was
reinstalled. Kimi Code's copy is replaced the way its `/plugins install` does it. Restart running sessions afterwards to load the new version. Grok and
Cursor load Claude Code's copy, so they follow Claude Code. When an agent's copy is older than the newest one on this
machine, telepathy's tools say so in a `<telepathy-note kind="setup">` note that includes this command.

The same updates are `telepathy update` (and `telepathy update --dry-run`) once the [command](#the-telepathy-command) is installed.
