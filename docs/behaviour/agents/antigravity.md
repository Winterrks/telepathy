# Antigravity

One plugin covers the Antigravity App, CLI and IDE. The App sidecar wakes an idle conversation; the CLI receives at
the next turn through hooks.

## Install

One plugin loads in the App, the CLI, and the IDE. Install it from the `antigravity` folder, not the repository
root: at the root, `agy` would also install the other agents' folders.

```sh
agy plugin install https://github.com/Winterrks/telepathy/tree/main/antigravity
```

`agy plugin install` puts the plugin in `~/.gemini/config/plugins/telepathy/`. Reinstall to update.

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **Antigravity App** | Wakes an idle conversation (the `telepathy-wake` sidecar calls `agentapi send-message`) | Not live-tested on 1.4.9 |
| **Antigravity CLI** | Next turn (hooks). No inject API while the TUI is idle | Hooks on CLI 1.2.9; 1.4.9 contract from the docs |
| **Antigravity IDE** | TBD | — |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| The others receive | Their hooks: before a prompt or after a tool call the pending messages go into the context; at the end of a turn they keep the turn going (`decision: block`, Cursor's `followup_message`, Antigravity's `continue`) |

## The App sidecar

`telepathy install` enables the App sidecar `telepathy/telepathy-wake` in
`~/.gemini/config/config.json` when that file is inside the active home. The sidecar watches App
conversations and wakes an idle one with `agentapi send-message <conversation_id> <prompt>`. When
`ANTIGRAVITY_AGENTAPI_EXE` points at `language_server`, the sidecar runs `<exe> agentapi send-message`.
A failed exec backs off from 2s up to 30s for that conversation only. A message the sender already
withdrew, or whose deadline has passed, is not sent later. One hung `agentapi` does not block the other
App conversations: they are still dispatched about once a second. The CLI TUI has no inject API: hooks deliver at the next
invocation (`injectSteps`) or by continuing a turn that was about to stop (`decision: "continue"`). The IDE is
not woken while idle.

## Sessions

`SessionStart` registers the peer from `conversationId`. The same id, including `agy --conversation <uuid>`,
keeps the address and the name. `/fork` is a new id and a new peer. The transcript path says which surface it
is: `~/.gemini/antigravity` is the App, `antigravity-cli` the CLI, `antigravity-ide` the IDE.

Antigravity registers from `SessionStart`'s `conversationId`, so a resume with `--conversation` is the same
peer and `/fork` is a new one.

## telepathy run

`telepathy run antigravity` (alias `agy`) uses the official `antigravity-acp` binary. `telepathy run --tui antigravity`
is the interactive TUI. `telepathy run --headless antigravity` keeps a
long-lived `agy --input-format stream-json --output-format stream-json` and writes prompts on stdin. It does not
wrap `agy -p`. Headless and ACP require `GEMINI_API_KEY` and `"modelProvider": "gemini"` in
`~/.gemini/antigravity-cli/settings.json`. A consumer login alone is refused: Google's FAQ says driving a
consumer account from third-party software, or wrapping `agy -p`, can suspend the account. There is no
`agy --acp`. The ACP run uses `antigravity-acp` (`agy_acp_server.par` if that is the name on PATH) and the same
API-key check, so on a consumer login use `telepathy run --tui antigravity`.

Hooks were exercised on Antigravity CLI 1.2.9. The App sidecar, surface detection, and headless stream follow
the 1.4.9 docs and are not live-tested here.

The Gemini CLI note (a leftover `~/.gemini/extensions/telepathy`) is under
[Not supported yet](README.md#not-supported-yet).
