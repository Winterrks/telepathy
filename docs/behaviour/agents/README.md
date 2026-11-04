# Agents

Which coding agents telepathy works with, how each one receives a message, and a page per agent with its install,
update and quirks.

## Quick start

The fastest way is the [`telepathy` command](../telepathy-command.md#the-telepathy-command), which sets up every agent CLI it finds:

```sh
npm install -g telepathy-cli && telepathy setup
```

Or by hand, with Claude Code and Codex:

```sh
claude plugin marketplace add Winterrks/telepathy && claude plugin install telepathy@telepathy
codex plugin marketplace add Winterrks/telepathy && codex plugin add telepathy@telepathy
```

1. Start a Codex session. It shows up in `list_peers` right away as `no thread yet`, under a stable name. Open
   `/hooks` and approve telepathy's hooks (Codex asks once for each plugin hook; `telepathy setup` approves them for
   you). A message sent before the first
   prompt fails immediately (`has no thread yet; prompt it once`) and is not stored. After that prompt, or if you
   started it with `codex resume <id>`, the same name is the thread and Codex can be queued.
2. Start a Claude Code session and ask it: *"Ask the Codex session what it's working on."*
3. Codex answers in a turn of its own, and the answer shows up in Claude as a `<telepathy-peer-message>` notification.

You need Node.js 20 or newer on your `PATH`. Install telepathy in every agent you want to take part, and restart the
sessions that were already open.

## Supported agents

| Agent | How it receives a message | Tested live |
|---|---|---|
| **[Claude Code](claude-code.md)** | Wakes an idle session (plugin monitor; in the Claude app, a waiter Claude starts itself) | ✅ |
| **[Codex CLI](codex.md)** | Wakes an idle session (`codex queue`); mid-turn, after its next tool call | ✅ |
| **[OpenCode](opencode.md)** 1.x and 2.x | Wakes an idle session (in-process plugin); in 2.x also mid-turn | ✅ |
| **[Kilo Code](kilo-code.md)** CLI | Wakes an idle session (same plugin as OpenCode) | Loads and registers; no model run yet |
| **[GitHub Copilot CLI](copilot.md)** | Next turn (hooks) | ✅ |
| **[Grok Build CLI](grok.md#grok-build-cli)** | Wakes an idle session once Grok starts the telepathy monitor | ✅ (see [Grok Build CLI](grok.md#grok-build-cli)) |
| **[Grok Bot](grok.md#grok-bot)** | A routine webhook: `telepathy grokbot` starts one run with the message as its context. In a session on this machine, a parked `wait_for_messages` call | Webhook measured against Grok Bot 0.78.1; a run's reply untested (no usage left) |
| **[Devin CLI](devin.md)** | Next turn (hooks) | ✅ |
| **[Antigravity App](antigravity.md)** | Wakes an idle conversation (the `telepathy-wake` sidecar calls `agentapi send-message`) | Not live-tested on 1.4.9 |
| **[Antigravity CLI](antigravity.md)** | Next turn (hooks). No inject API while the TUI is idle | Hooks on CLI 1.2.9; 1.4.9 contract from the docs |
| **[Antigravity IDE](antigravity.md)** | TBD | — |
| **[Qwen Code](qwen-code.md)** | Next turn (hooks) | ✅ |
| **[Cursor CLI](cursor.md)** | After its next tool call (hooks) | ✅ |
| **[Kimi Code](kimi-code.md)** | Next turn (hooks) | Registers, hooks and tools ✅; no model run yet |

- **Wakes an idle session:** the message starts a turn by itself, even while nobody is typing.
- **Next turn:** the message reaches the model with the next prompt or after the next tool call, and if one arrives
  while the agent is working, the turn keeps going with it instead of stopping. An idle session sees it when you next
  prompt it; senders are told so.

## Not supported yet

Not supported yet: the Cursor and Kilo Code IDE extensions; the Antigravity IDE (hooks may load, idle wake is not
wired); Claude Cowork (it runs in a VM, which can't see the other sessions); Hermes Agent, OpenClaw and Pi. The
ChatGPT app's Codex threads get addresses of their own like the CLI's, but delivery to them is untested. Gemini CLI
is deprecated. Its successor is Antigravity (`agy`). `telepathy doctor` reports a leftover
`~/.gemini/extensions/telepathy`. `telepathy install --remove-legacy` removes it so `agy plugin import gemini`
does not install telepathy twice.

## Each agent

Each agent installs telepathy its own way. If you use several agents, install it in each of them.

- [Claude Code](claude-code.md)
- [Codex](codex.md)
- [OpenCode](opencode.md)
- [Kilo Code](kilo-code.md)
- [GitHub Copilot CLI](copilot.md)
- [Qwen Code](qwen-code.md)
- [Grok](grok.md): Grok Build CLI and Grok Bot
- [Devin CLI](devin.md)
- [Antigravity](antigravity.md): the App, the CLI and the IDE
- [Cursor](cursor.md)
- [Kimi Code](kimi-code.md)

To update every agent's copy at once, see [Updating every agent](../telepathy-command.md#updating-every-agent).

## Known quirks

This is still an early version. Some harness quirks can prevent live reception, such as a Codex interrupt (Esc),
after which messages aren't received until you send something
([An interrupted Codex does not get the queue](codex.md#an-interrupted-codex-does-not-get-the-queue)). If you find a
similar quirk in any harness, [let us know](https://github.com/Winterrks/telepathy/issues).
