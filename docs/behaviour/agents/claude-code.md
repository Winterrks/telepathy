# Claude Code

telepathy installs in Claude Code as a plugin. An incoming message wakes an idle session, and Claude Code's own
`ListAgents` and `SendMessage` reach the other agents' sessions.

## Install

```sh
claude plugin marketplace add Winterrks/telepathy && claude plugin install telepathy@telepathy
```

Update: `claude plugin marketplace update telepathy && claude plugin update telepathy@telepathy`. To update
automatically, open `/plugin`, go to Marketplaces, select telepathy and choose Enable auto-update (it's off by default
for third-party marketplaces). Tested with Claude Code 2.1.281.

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **Claude Code** | Wakes an idle session (plugin monitor; in the Claude app, a waiter Claude starts itself) | ✅ |

What these mean is under [Supported agents](README.md#supported-agents).

### Claude receives through its inbox socket when the session has one

Claude Code v2.1.224 or later (v2.1.234 on native Windows) exports `CLAUDE_CODE_MESSAGING_SOCKET`. Telepathy's server
in that session posts there, and only the delivery owner's socket: a second window on the same session has its own
path and must not replace it. `send_message` succeeds only when the recipient's transcript contains
`telepathy-id:<message id>`. Telepathy reads the effective `crossSessionInbound` (managed settings, user settings, and
a stricter project or local value; see the settings precedence page) before writing. `hold` and `refuse` are not
posted. The inbox copy stays, for a hook or `read_messages`, and can still be withdrawn. A socket reply of `held`
means Claude already has bytes that cannot be recalled; the result says that, and does not start with
`Message failed`. A marker that arrives in the grace window moves the file from `withdrawn/` to `archive/`. A failure
after a hold says nothing was posted because that session is holding peer messages, and that the inbox copy was
withdrawn. A failed confirm's strongest signal does not say the message was delivered. The post names the real sender
(Codex, OpenCode, and the rest), which Claude shows in place of "Another Claude session". The plugin does not start
its background monitor: a process Claude launched and that then exited is a "background task exited" notice, and a
process that stays up is what `/exit` asks to stop. `plugin/monitors/monitors.json` is empty, because a plugin monitor
cannot see whether `CLAUDE_CODE_MESSAGING_SOCKET` is set. A session that exported the socket does not start an idle
waiter. A session that did not (bare mode, a build older than the socket, or a bind that failed and left the variable
unset) starts one from SessionStart, UserPromptSubmit, and Stop: `monitor.mjs --rewake` with `asyncRewake` and a
one-day timeout. It exits immediately when a socket is set. Without one it waits, then exits 2 with the message line,
which is what wakes Claude. The Desktop app's Code tab, the VS Code extension, and `claude -p` on current versions
export a socket, so idle wake there is the post. A stream-json host with no socket is still asked to start a one-shot
`--once` waiter with Bash. Until that runs, the hooks hand messages over at the next prompt or when a turn ends.

## ListAgents and SendMessage

Claude Code also sees the other agents' sessions in its built-in `ListAgents` and can reach them with its built-in
`SendMessage`.

| Piece | Mechanism |
|---|---|
| `ListAgents` / `SendMessage` | A Claude PostToolUse hook adds the other agents' sessions, and every session on another device, to the ListAgents result, in its own row format. `SendMessage` on its own only reaches Claude sessions, so a PreToolUse hook delivers a `SendMessage` aimed at another harness or device, then stops the native call; that tool result is an error (deny is the only decision that prevents the native call). Claude-to-Claude `SendMessage` is left alone |

### A SendMessage to another agent shows up as an error line in Claude's UI

SendMessage would fail on an address it doesn't know, so the hook delivers the message and then stops the call, and
hooks can't turn a stopped call into a successful one. The error text says the message was delivered and not to resend
it. The plugin's `send_message` gives a normal result, and Claude can use either. Claude-to-Claude SendMessage calls
are never touched.

## start_agent and the Agent tool

In Claude Code's terminal, `start_agent` runs as a background task Claude Code follows itself
([In Claude Code: a background task](../subagents.md#in-claude-code-a-background-task)).

| Piece | Mechanism |
|---|---|
| `start_agent` in Claude Code | The server speaks protocol revision 2026-07-28 with Claude Code (`serveStdio`) and answers `start_agent`, and `send_message` to an agent it started, with an MCP task when the request declares the tasks extension. It answers Claude Code's `tasks/get`, `tasks/update` and `tasks/cancel` itself. The agent host offers its report or permission request to the open task (`~/.telepathy/agents/<name>/task/`) and sends it as a message when no task takes it |

The Agent tool always runs a Claude model, so an Agent call naming another harness (`telepathy:codex`,
`codex`, `codex:<name>`) is stopped with a pointer to `start_agent`, unless a Claude agent or plugin goes by that name.

Its statuses (busy, shell, idle, waiting) come from Claude Code's own session record; see
[Statuses](../sessions.md#statuses). The hooks it runs are listed under
[Privacy and security](../privacy-and-security.md).
