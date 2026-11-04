# GitHub Copilot CLI

telepathy installs in the Copilot CLI as a plugin. A plain `copilot` receives through its hooks at the next turn;
`telepathy run copilot` injects messages as they arrive.

## Install

```sh
copilot plugin marketplace add Winterrks/telepathy && copilot plugin install telepathy@telepathy
```

Update: `copilot plugin update telepathy@telepathy`. Copilot CLI 1.0.105 or newer is required; 0.0.372 cannot load the
plugin. Copilot asks for folder trust in each new directory, and it asks before a tool runs for the first time,
telepathy's included.

## How it receives

| Agent | How it receives a message | Tested live |
|---|---|---|
| **GitHub Copilot CLI** | Next turn (hooks) | ✅ |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| The others receive | Their hooks: before a prompt or after a tool call the pending messages go into the context; at the end of a turn they keep the turn going (`decision: block`, Cursor's `followup_message`, Antigravity's `continue`) |

## Resume

A plain `copilot` receives through its hooks at the next turn, including before the first prompt.
`copilot --resume=<id>` and `copilot --resume <id>` reclaim that session when it has its own `session.resume` for this
directory, newer than the process. A fresh `copilot` in the same folder rewrites `workspace.yaml` and does not write
`session.resume`, so that file does not block the named resume. `--continue` and a bare `--resume` still claim nothing
when two sessions in the folder were touched after the process started. If the signals disagree, it stays
`copilot-<pid>` until the first prompt.

### A resumed Copilot keeps its id before the first prompt

A fresh `copilot` is `copilot-<pid>` until sessionStart. `copilot --resume=<id>` and `copilot --resume <id>` claim
that session when its own `session.resume` in `$COPILOT_HOME/session-state/<id>/events.jsonl` is newer than the
process and the cwd matches. Another session that only rewrote `workspace.yaml` is not a second candidate.
`--continue` and a bare `--resume` claim the one post-start session for this cwd, and claim nothing when two sessions
really compete. A send before the first prompt is delivered at the next turn when the turn falls inside the confirm
window; otherwise it fails and the copy is withdrawn. The sessionStart hook binds the same id and does not create a
second peer.

## Under telepathy run

`telepathy run copilot` injects messages as they arrive. Copilot's ACP initialize advertises http and sse only, and it
rejects a stdio server on `session/new`. A `plugin install` copy under `installed-plugins` starts telepathy's server,
so the host leaves that command line alone. A plugin loaded with `plugin marketplace add <dir>` does not start the
server. The host adds it for that session with `copilot --acp --additional-mcp-config @<file>`, the same local server
the plugin manifest uses. That file lists every `TELEPATHY_*` name, plus `CODEX_HOME`, `COPILOT_HOME`, `PATH`, `HOME`,
`USER`, `LOGNAME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
`XDG_DATA_HOME`, and `XDG_RUNTIME_DIR`, so tokens outside that list stay off disk. Copilot 1.0.105 still passes its
own full environment to the spawned server. The file does not restrict that process. Leave that host with `/exit`,
`/quit`, or Ctrl-C.
