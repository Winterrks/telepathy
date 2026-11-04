# Kimi Code

telepathy installs in Kimi Code from a Kimi session. Messages arrive at the next turn through its hooks.

## Install

In a Kimi Code session:

```text
/plugins install https://github.com/Winterrks/telepathy
```

Then start a new session with `/new`. Update from `/plugins`. Kimi has no plugin command outside a session, so
`telepathy setup`, `telepathy update` and auto-update do what `/plugins install` does: download the latest release,
swap it into `~/.kimi-code/plugins/managed/telepathy`, and record it in `~/.kimi-code/plugins/installed.json`.

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **Kimi Code** | Next turn (hooks) | Registers, hooks and tools ✅; no model run yet |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| The others receive | Their hooks: before a prompt or after a tool call the pending messages go into the context; at the end of a turn they keep the turn going (`decision: block`, Cursor's `followup_message`, Antigravity's `continue`) |

As a subagent, Kimi Code needs its own sign-in first (`kimi login`); see [Subagents](../subagents.md).
