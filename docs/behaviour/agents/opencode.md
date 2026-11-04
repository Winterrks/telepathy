# OpenCode

telepathy runs inside OpenCode as a plugin. It adds the `telepathy_*` tools and wakes the session itself.

## Install

OpenCode 2.x:

```sh
opencode plugin add telepathy@git+https://github.com/Winterrks/telepathy.git
```

or add it to the `plugins` list in `~/.config/opencode/opencode.json`. Update with
`opencode plugin update telepathy@git+https://github.com/Winterrks/telepathy.git`. OpenCode 1.x reads the `plugin`
list instead (`{ "plugin": ["telepathy@git+https://github.com/Winterrks/telepathy.git"] }`); to update there, clear
OpenCode's package cache (`~/.cache/opencode/packages`) and restart.

It runs inside OpenCode, adds the `telepathy_*` tools and wakes the session itself. OpenCode 2's background service
hosts every window's sessions, so each session has an address of its own (`opencode-<session id>`); one counts as
running while the service runs and it was used in the last 12 hours. Tested with 2.0.25 and 1.18.30.

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **OpenCode** 1.x and 2.x | Wakes an idle session (in-process plugin); in 2.x also mid-turn | ✅ |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| OpenCode receives | The plugin runs inside OpenCode. OpenCode 2: `session.prompt` with `delivery: "steer"`, which starts a turn or joins the running one. OpenCode 1.x: `client.session.promptAsync` once the session goes idle |

How an OpenCode session binds its id (`--session`, `--continue`, a fresh TUI) is under
[A resumed session keeps its telepathy id and name](../sessions.md#a-resumed-session-keeps-its-telepathy-id-and-name).
OpenCode has no auto mode, so a subagent's permission requests come to its parent
([Subagents](../subagents.md)).
