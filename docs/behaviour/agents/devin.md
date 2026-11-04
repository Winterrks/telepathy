# Devin CLI

telepathy installs in the Devin CLI as a plugin. Messages arrive at the next turn through its hooks.

## Install

```sh
devin plugins install Winterrks/telepathy#plugin
```

Update: `devin plugins update telepathy`. Tested with Devin CLI 3000.11.3.

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **Devin CLI** | Next turn (hooks) | ✅ |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| The others receive | Their hooks: before a prompt or after a tool call the pending messages go into the context; at the end of a turn they keep the turn going (`decision: block`, Cursor's `followup_message`, Antigravity's `continue`) |
