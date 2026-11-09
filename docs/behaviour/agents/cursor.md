# Cursor

telepathy installs in the Cursor CLI from Cursor's plugin marketplace. Messages arrive after the next tool call
through its hooks.

## Install

```sh
cursor-agent plugin marketplace add https://github.com/Winterrks/telepathy
```

Then install telepathy from the Marketplace tab of `/plugin` in the Cursor CLI. Tested with the Cursor CLI
2026.09.23: it hands messages over after the next tool call (its CLI doesn't run plugin stop hooks). If telepathy is
installed in Claude Code, Cursor also imports that copy; there's no need to install it twice.

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **Cursor CLI** | After its next tool call (hooks) | ✅ |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| The others receive | Their hooks: before a prompt or after a tool call the pending messages go into the context; at the end of a turn they keep the turn going (`decision: block`, Cursor's `followup_message`, Antigravity's `continue`) |

## As a subagent

`start_agent(harness: "cursor")` runs `cursor-agent acp`. Its ACP modes are `agent`, `plan` and `ask`, with no
auto mode: the ACP server reads only `--force` (run everything, which telepathy never sets), and treats Cursor's
Auto-review setting as Allowlist. Commands on Cursor's own allowlist (`permissions.allow` in
`~/.cursor/cli-config.json`) run without asking, and Cursor asks about every other shell command. So a Cursor agent
runs in telepathy's auto mode: a reviewer session of Cursor, in its `ask` mode, approves routine commands, and the
rest come to the parent ([Fewer permission requests](../subagents.md#fewer-permission-requests)). telepathy answers
Cursor's "Allow once", never its "Allow always", which would write to that global allowlist.
