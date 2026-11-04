# Kilo Code

The Kilo CLI runs the same plugin as [OpenCode](opencode.md).

## Install

Add telepathy to the `plugin` list in `~/.config/kilo/kilo.json`:

```json
{ "plugin": ["git:github.com/Winterrks/telepathy"] }
```

The Kilo CLI runs the same plugin as OpenCode. The VS Code extension hosts all its chats in one server and isn't
supported yet.

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **Kilo Code** CLI | Wakes an idle session (same plugin as OpenCode) | Loads and registers; no model run yet |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| OpenCode receives | The plugin runs inside OpenCode. OpenCode 2: `session.prompt` with `delivery: "steer"`, which starts a turn or joins the running one. OpenCode 1.x: `client.session.promptAsync` once the session goes idle |

Updating every agent reinstalls Kilo Code by clearing its package cache
([Updating every agent](../telepathy-command.md#updating-every-agent)).
