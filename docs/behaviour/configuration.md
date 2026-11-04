# Configuration and troubleshooting

## Environment variables

| Variable | Effect |
|---|---|
| `TELEPATHY_DEBUG=1` | Log hook, server, monitor and plugin activity to `~/.telepathy/debug.log` |
| `TELEPATHY_HOME` | State directory (default `~/.telepathy`) |
| `TELEPATHY_CODEX_BIN` | Path to the `codex` binary if it isn't on `PATH` |
| `TELEPATHY_WAKE_DEBOUNCE_MS` | How long a webhook burst waits after the last message. Default 400. The wait is also capped at 1.5 seconds after the first message |

Others, each described where it applies:

| Variable | Effect |
|---|---|
| `TELEPATHY_NAME` | A stable name for the session ([A stable name](sessions.md#a-stable-name)) |
| `TELEPATHY_AUTO_UPDATE=0` | Turns auto-update off, whatever `telepathy config` says ([Auto-update](telepathy-command.md#auto-update)) |
| `TELEPATHY_BRIDGE_PORT` | The bridge's port, 47380 by default, the same on every device ([Devices](devices.md)) |
| `TELEPATHY_BRIDGE_RESTART_WAIT_MS` | How long the bridge waits for your other devices before it restarts into an update. Default 10 minutes ([Devices](devices.md)) |
| `TELEPATHY_AGENT_UNREACHABLE_MS` | How long an agent started from another device keeps running while that device is out of reach. Default 10 minutes ([On another device](subagents.md#on-another-device)) |
| `TELEPATHY_GROKBOT_DEBOUNCE_MS` | How long a connected Grok Bot's host waits for more messages to share one run. Default 400, at most 1.5 seconds after the first ([A routine webhook](agents/grok.md#a-routine-webhook-telepathy-grokbot)) |
| `ANTIGRAVITY_AGENTAPI_EXE` | When it points at `language_server`, the Antigravity App sidecar runs `<exe> agentapi send-message` ([Antigravity](agents/antigravity.md#the-app-sidecar)) |

## Troubleshooting

- **A session isn't listed:** it needs telepathy installed in that agent, and a restart if it was already open. With
  `TELEPATHY_DEBUG=1`, the debug log shows whether its hooks and server started.
- **Messages arrive late:** that agent can't be woken while idle (see [Supported agents](agents/README.md#supported-agents)); it sees
  messages at its next turn.

A few best-effort lookups use files that aren't documented interfaces; if the files change, telepathy falls back
gracefully: display names come from Claude's and Codex's session files, falling back to the folder name; a Codex
row's busy/idle status comes from the end of its thread log; whether Codex approved telepathy's hooks comes from the
`[hooks.state."telepathy@…"]` table names in Codex's `config.toml` (only those names are used); `codex queue` and `thread/queue/delete` are marked
experimental in Codex's app-server protocol, and plugin monitors are an experimental Claude Code plugin component.

## A webhook wake

`~/.telepathy/delivery.json` (mode 600, or it is ignored) can name a peer and a `webhook` URL, or a `command` argv.
Set `key` and telepathy sends `Authorization: Bearer <key>` and `X-Automation-Key: <key>`. `authHeaders` replaces
those names. `headers` overrides one of them. Messages for the same URL wait 400ms after the last one (at most 1.5s
after the first, or `TELEPATHY_WAKE_DEBOUNCE_MS`) and go out as one POST, `{"id","ids","from","count","at"}`, with an
8 second timeout and no retry. `count` is how many of those messages are still in the inbox. The body has no message
text. The receiver must treat it as untrusted and read the inbox. The message is not removed. A failed POST is
appended to `~/.telepathy/wake.log` with the time, the host, and the status or error. The key and the message text are
not written there. `node <installed-copy>/dist/delivery.mjs test` posts `{"event":"probe"}` and prints the HTTP
status, so the URL can be checked without a real message. Receivers ignore probe events.

## This doorbell does not carry the message

The remote routine cannot read this machine's inbox, so something on this machine still has to: a persistent local
client, or the telepathy server kept on a stable name with `TELEPATHY_NAME` or `--name`. For a Grok Bot routine,
`telepathy grokbot` sends the message itself (see [A routine webhook](agents/grok.md#a-routine-webhook-telepathy-grokbot)).
