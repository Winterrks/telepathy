# Codex

telepathy installs in the Codex CLI as a plugin with four hooks. A message is queued into the running TUI with
`codex queue`, and a busy Codex gets it after its next tool call.

## Install

```sh
codex plugin marketplace add Winterrks/telepathy && codex plugin add telepathy@telepathy
```

Then open `/hooks` in a Codex session and approve telepathy's four hooks (press `t` to trust all), or run
`telepathy setup`, which approves them through Codex's own app-server API (`hooks/list`, then `config/batchWrite`;
telepathy never edits `config.toml` itself). Codex 0.166 and later fold the plugin's files into each hook's hash, so
every telepathy update leaves the hooks "modified" and Codex stops running them until they are approved again.
`telepathy update` and the daily auto-update re-approve the hooks you had approved before; a hook you never approved
is left for you or `telepathy setup`.

PostToolUse and UserPromptSubmit hand messages over during a turn and with your next prompt; without them, a busy
Codex gets a message only when its turn ends. PermissionRequest only records that a permission prompt is waiting for
you, so other sessions know why Codex isn't answering; it never answers a prompt, and without it nothing else changes.

## Update

Run `codex plugin marketplace upgrade telepathy`, then restart running Codex sessions: the upgrade replaces the folder
their hooks run from, so until they restart, Codex shows "Hook failed" after tool calls and messages wait for the turn
to end. Needs Codex CLI 0.149 or newer (tested with 0.161, whose terminal sessions all run in one shared background
daemon that Codex replaces when it updates; telepathy tells them apart by thread, so a session keeps its address
across those updates and across `codex resume`).

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **Codex CLI** | Wakes an idle session (`codex queue`); mid-turn, after its next tool call | ✅ |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| Codex receives | `codex queue`, the Codex CLI's own "queue a message for an existing session". The running TUI picks it up within about 10 s. During a turn, the PostToolUse hook hands the message over from the inbox and removes it from the queue (`thread/queue/delete` on a short-lived `codex app-server`) |

## Which sessions are listed

A launched TUI is listed as soon as the process is up, before any prompt, as `no thread yet`. A send then fails
immediately and writes nothing: Codex's MCP server and SessionStart run per thread, and a side `thread/start` would
not be the composer on screen. Only an interactive TUI is listed (bare `codex`, a prompt, `codex resume`,
`codex fork`, plus global flags). The ChatGPT app's `exec-server` helper is not a session, and neither is a TUI whose
parent is an app bundle. A listed TUI keeps the `CODEX_HOME` it was started with, so a send queues in that home.
`codex resume <id>` is that thread immediately, so a send can be queued. After the first prompt, SessionStart binds
the same name to the thread. Without the hooks, a thread becomes deliverable once it has called a telepathy tool.

## A launched Codex is listed before its first prompt

The row is `no thread yet`. A send fails immediately (`Message failed: … has no thread yet; prompt it once`) and
nothing is written or queued. `codex resume <id>` is already that thread, keeps the name from the last time that
thread was seen, and can be queued under the same 110s confirm rules as any other thread. A bare `codex resume` stays
`no thread yet` until SessionStart reports the id. Two windows in the same directory stay two rows until each one has
a thread id.

## A busy Codex gets messages after its next tool call

The PostToolUse hook appends the message to the tool result. That is the mid-turn path. `codex queue` only runs the
message after the turn ends, so it is the fallback when no further tool call happens. Whichever comes first wins: a
message handed over mid-turn (or read with `read_messages`) is taken back out of Codex's queue, so it doesn't arrive
twice. Without the PostToolUse hook approved, messages wait for the turn to end.

## An interrupted Codex does not get the queue

After you interrupt a turn (Esc), Codex leaves queued messages paused and does not start them, including after
`codex resume`, until you prompt it. A send while that status holds fails immediately
(`Message failed: … is interrupted, so its queue will not run this. Nothing was left for a later prompt.`) and writes
nothing. The next prompt is not this call, so the confirm window is not spent waiting. `list_peers` and ListAgents
show the session as interrupted.

## The tool timeout

Codex's MCP server in this plugin is named `bridge`, so the tool timeout key is
`plugins."telepathy@telepathy".mcp_servers.bridge.tool_timeout_sec`. `send_message` waits up to 110 seconds (100s,
then 10s), counted from the start of the tool call so listing before the wait counts against it, and returns as soon
as that grace period ends. That stays inside Claude Code's about-120s move of a live tool call to the background. A
value read from `config.toml` or from a `-c` override on the Codex process is trusted. When that effective value is
below 110, the note names the key. When the file is readable and neither place shows the key, the note says the value
could not be verified, once per session, and does not claim the key is unset. A note that Codex has not approved its
hooks is shown only when no telepathy hook has fired for that session.

The other setup notes are in [Messages](../messages.md#setup-notes). Codex's statuses (busy, idle, interrupted,
waiting) are in [Statuses](../sessions.md#statuses).

## As a subagent

`start_agent(harness: "codex")` and `telepathy run codex` use `codex-acp` from `@agentclientprotocol/codex-acp`,
which runs Codex's own app-server, so it reads `~/.codex/config.toml` as your Codex CLI does. The agent runs in
Codex's "Auto review" mode (`agent`): Codex asks only about actions it finds unsafe, and those come to the parent.
Zed's earlier `@zed-industries/codex-acp` bundled its own, older Codex, which could refuse to start on a setting the
CLI reads (an `[agents]` table, for one). `telepathy setup` and `telepathy update` replace it.
