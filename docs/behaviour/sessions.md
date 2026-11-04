# Sessions

Every running session that has telepathy is a peer with an address. This page covers addresses, how a session keeps
its identity across restarts and resumes, and the statuses the listings show.

## Addresses

Addresses look like `codex:api-c3f [codex-4242]` (the same `name [ref]` shape as Claude's `ListAgents`):

- **Name:** a Claude session goes by Claude Code's own name for it (`web-b0`). Every other session is named like that
  too: its folder, then the agent's first letter and two hex characters (`api-c3f` for Codex, `shop-ui-o1a` for
  OpenCode), which tell apart sessions in the same folder and never collide with Claude's two-character suffixes.
- **Aliases:** the bare folder name (`codex:api`) and a Codex thread's title also work, as long as only one session
  matches.
- **The `[ref]`:** `<agent>-<pid>`; for Codex `codex-<thread id>` and for OpenCode 2 `opencode-<session id>`, because one
  process runs many of their sessions. Use it when two sessions share a name.

A session on another device adds `@<device>` to both, for example `codex:api-c3f@laptop`; see [Devices](devices.md).

## A resumed session keeps its telepathy id and name

The key is the harness session id (Claude's `session_id`, a Codex thread id, an OpenCode `ses_` id, and the same
fields from the other hooks), not the pid. OpenCode binds that id from `--session` or `-s` on this process's command
line (`ps` still has the flag when `process.argv` does not) or a parent process, from `--continue` or `-c` by listing
sessions after plugin init returns and binding the newest primary one, from `session.created`, `session.updated`, or a
TUI event that names the session, or from the first `chat.message`. `--fork` does not bind the source id. Plugin init
does not wait on `session.list`: OpenCode cannot answer it until init returns. A fresh TUI has no session yet. It is
listed as `no session yet, sees messages at its first prompt`, and a message that arrives first creates a session,
publishes `tui.session.select` so the TUI leaves the home screen (`tui.selectSession` when that method exists), and
prompts it when the client can. The name from the pid-keyed moment is the one that is remembered. The first name is
stored under `~/.telepathy/identities/`. Mail already in the inbox when the process exited is still there on resume. A
send while the process is gone is `Message failed:` and is not stored. On resume, inbox files whose `sentAt` is after
that exit are dropped, so a copy that was not already in flight is not delivered. A new session id does not receive
the old inbox. `TELEPATHY_NAME` still overrides the name. Two live processes on one session id share the peer; the
oldest one owns delivery, and Claude delivery uses that process's socket.

## A stable name

Set `TELEPATHY_NAME` or start the server with `--name my-bot`. The address becomes `grok:my-bot` and stays that way
across restarts, and unread messages move to the new process. Two live sessions with the same name are called out in
`list_peers` and in `<telepathy-note kind="setup">`. Use the `[ref]` to pick one.

## One session per process

Identities are per agent process. Where one process hosts several chats (Grok's dashboard, Copilot's backgrounded
sessions), they share one address, and a message goes to whichever chat runs its hooks next. An Antigravity
conversation is its own peer: the id is `conversationId`, not the process. The App sidecar wakes that conversation.
The CLI and IDE deliver on the next hook boundary.

## Statuses

`list_peers` and the rows telepathy adds to ListAgents say what each session is doing: **busy** (in a turn), **shell**
(not generating, but a command it started is still running), **idle**, **waiting** (a permission prompt is waiting for
its user, so nothing moves until they answer) and, for Codex, **interrupted** (its last turn was interrupted, and it
starts queued messages only after its user's next prompt). A sender whose message lands in a waiting or interrupted
session is told so. Where each comes from:

| Agent | Statuses | Source |
|---|---|---|
| Claude Code | busy, shell, idle, waiting | Claude Code's own session record (`~/.claude/sessions/<pid>.json`). `shell` is idle when the only running command is telepathy's own monitor |
| Codex | busy, idle, interrupted, waiting | The thread's rollout log; waiting from the PermissionRequest hook until Codex writes to the log again |
| OpenCode, Kilo Code | busy, idle, waiting | The plugin's session and permission events |
| The others, including Antigravity | busy, idle | Hooks: busy from a prompt or tool call, idle when the turn ends |

Hooks can miss the end of a turn (an interrupt often runs none), so a hook-reported busy or waiting with no hook
activity for 15 minutes shows with a `?` and how long it has been quiet.
