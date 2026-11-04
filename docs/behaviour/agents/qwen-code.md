# Qwen Code

telepathy installs in Qwen Code as an extension. Messages arrive at the next turn through its hooks, and Qwen's own
`list_agents` and `send_message` reach the other agents' sessions.

## Install

```sh
qwen extensions install https://github.com/Winterrks/telepathy/archive/refs/heads/main.tar.gz --auto-update
```

Update: `qwen extensions update telepathy` (or let `--auto-update` do it). Tested with Qwen Code 0.24.4. Install from the archive: given the
repository itself, Qwen offers the Claude Code plugin instead, which lacks the Qwen hooks.

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **Qwen Code** | Next turn (hooks) | ✅ |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| The others receive | Their hooks: before a prompt or after a tool call the pending messages go into the context; at the end of a turn they keep the turn going (`decision: block`, Cursor's `followup_message`, Antigravity's `continue`) |

## list_agents and send_message

Qwen Code does the same as Claude Code's `ListAgents` and `SendMessage` with its `list_agents` and
`send_message`:

| Piece | Mechanism |
|---|---|
| Qwen's `list_agents` / `send_message` | Qwen Code 0.24 and later list their own background agents and other Qwen sessions. Its PostToolUse hook cannot rewrite a result, so the other agents' sessions follow `list_agents` as context. A PreToolUse hook on `send_message` delivers a message aimed at a `<agent>:` address, a `[ref]`, or another device, and stops the native call the same way. Teammate names and Qwen's own destinations are left alone |

Updating every agent answers yes to Qwen's update confirmation
([Updating every agent](../telepathy-command.md#updating-every-agent)).
