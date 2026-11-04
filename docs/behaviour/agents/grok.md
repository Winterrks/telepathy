# Grok

Grok Build CLI and Grok Bot both load this plugin. They do not receive messages the same way.

| Agent | How it receives a message | Tested live |
|---|---|---|
| **Grok Build CLI** | Wakes an idle session once Grok starts the telepathy monitor | ✅ (see [Grok Build CLI](#grok-build-cli)) |
| **Grok Bot** | A routine webhook: `telepathy grokbot` starts one run with the message as its context. In a session on this machine, a parked `wait_for_messages` call | Webhook measured against Grok Bot 0.78.1; a run's reply untested (no usage left) |

What these mean is under [Supported agents](README.md#supported-agents).

| Piece | Mechanism |
|---|---|
| Grok Build receives | The model starts `monitor.mjs` with Grok's monitor tool; each line wakes an idle session. Hooks cover the next tool call and the end of a turn until then |
| Grok Bot receives | `wait_for_messages` long-polls the inbox on the MCP connection the bot already holds and returns the message as the tool result. That return records `telepathy-id` so the sender's confirm succeeds. A logging line and `resources/updated` on `telepathy://inbox` are also sent, and claim nothing. A failed confirm withdraws the copy; a later wait does not see it |

Grok also gets `wait_for_messages`, which holds the MCP connection open until a message arrives. Grok Bot uses that
call to receive while idle; Grok Build keeps using its monitor and does not call it.

## Grok Build CLI

```sh
grok plugin install Winterrks/telepathy#plugin --trust
```

Update: `grok plugin update telepathy`. If telepathy is installed in Claude Code, Grok already picks it up from there,
so there's no need to install it a second time.

- **Waking up:** telepathy's instructions have Grok start the telepathy monitor (with its monitor tool, `persistent: true`)
  as its first action in every conversation. From then on, a message wakes an idle Grok session just like Claude Code.
  Before the first prompt of a conversation, Grok can't be woken yet. Don't also call `wait_for_messages`: that call
  would take the messages the monitor prints and block the turn. If it is called while the monitor is the listener, it
  returns immediately and claims nothing.
- **Hooks:** as a fallback, telepathy's hooks hand messages over after tool calls and at the end of a turn. Grok
  1.0.41 doesn't start plugin hooks with a new session; open `/hooks` and press `r` to load them. Grok 1.0.42 and later
  start them with a fresh session.

## Grok Bot

Grok Bot has no monitor tool and does not start a turn from MCP notifications, so polling `read_messages` was the only
way in and messages sat unread. `wait_for_messages` long-polls the inbox on the MCP connection the bot already holds
and returns the messages as the tool result (the same rendering as `read_messages`). Keep one call running with a long
`timeoutMs` (300000 when the client allows) and call it again whenever it returns. A result that says no messages
arrived only means that wait ended.

The default wait is 45 seconds, under a 60 second client cap. Pass `timeoutMs: 0` to claim whatever is already waiting
without blocking. While a call is in flight the session counts as listening, so hooks stay quiet. When the call ends,
that registration is removed.

A send succeeds only when the recipient's transcript shows `telepathy-id:<id>`: the sender aborts the wait at 100
seconds, checks once more during a 10 second grace, and fails at 110 seconds. Returning the message from
`wait_for_messages` records that marker, which is what confirms delivery. If no call is parked, the sender fails
when the window ends and withdraws the copy; a later `wait_for_messages` does not return it. A Grok session that is
not running fails immediately and nothing is written. Nothing is kept for an offline peer.

`plugin/grok.mcp.json` asks the host for a long tool timeout (`startup_timeout_sec` 30, `tool_timeout_sec` 6000,
`tool_timeouts.wait_for_messages` 6000). Hosts that ignore those JSON fields and kill the tool around 60 seconds need
the same values in `~/.grok/config.toml`:

```toml
[mcp_servers.telepathy]
startup_timeout_sec = 30
tool_timeout_sec = 6000

[mcp_servers.telepathy.tool_timeouts]
wait_for_messages = 6000
```

The server also emits a logging notification and, for a client that subscribed, `notifications/resources/updated` on
`telepathy://inbox`. Those do not claim the message. Grok's client does not turn them into a model turn; the tool
result does.

Check it from another session: send to the Grok Bot session while `wait_for_messages` is running. The call returns the
message. `list_peers` shows a listener only during the call. `TELEPATHY_DEBUG=1` logs to `~/.telepathy/debug.log`.

### A routine webhook (`telepathy grokbot`)

A Grok Bot runs in xAI's cloud, so it can't read this machine's inbox, and an idle Bot has no call parked. A routine
with a webhook trigger can be woken instead, and the webhook can carry the message:

1. Ask the Bot to make a routine with a webhook trigger, for example "when a telepathy message arrives, answer it".
   The Bot can create it itself, but the URL and key aren't in what its create call returns.
2. Open that routine from the Bot's info pane in the Grok Bot app (click its name in the chat header, then Routines).
   The Webhook section shows the URL and the key.
3. On this machine:

   ```sh
   telepathy grokbot connect scout https://api2.cursor.sh/automations/webhook/<id>
   ```

   It asks for the key (or reads it from stdin), saves both in `~/.telepathy/grokbot/scout.json` (mode 600), and
   starts the host. The key is never printed or logged. `telepathy grokbot test scout` wakes the Bot once to check
   it: a valid key starts a run for any JSON body, so there is no way to check it without one.

While the host runs, the Bot is the session `grok:scout`. A message to it is POSTed to the routine the way the
Grok Bot app's own Run button does it, `Authorization: Bearer <key>` and `{"context": "…"}`, so the run starts with
the message in hand, wrapped in `<telepathy-peer-message>` like anywhere else, and with the command that answers it.
Every POST costs the Bot a run, so messages that arrive within 400ms of each other share one (at most 1.5s after the
first; `TELEPATHY_GROKBOT_DEBOUNCE_MS`). The Bot answers by running, on this machine,
`telepathy grokbot send scout <address> "<reply>"`; `telepathy grokbot peers scout` lists the sessions.

The POST is the submit: a 2xx is recorded as delivery, the same as the ACP host handing a prompt to an agent. It
means the run was queued, not that it finished: the endpoint answered 200 with a `runUuid` in about 0.7s even while
the Bot's plan was out of usage. A refused POST (401, 429 and so on) is not a delivery. The host retries after 2, 5,
15, 30 and 60 seconds, and the sender fails and withdraws the copy when its window ends. Failures go to
`~/.telepathy/headless/grok-<name>.log` with the status, the server's error and its `x-automation-failure-hint`.

Any telepathy session's server restarts a connected Bot's host after a reboot; `telepathy grokbot start` does it by
hand. `status`, `stop` and `disconnect` (which also removes the key) do the rest. Install the CLI
(`npm install -g telepathy-cli`) so the Bot can type `telepathy`; without it the context gives the full `node` path to
the plugin's `grokbot.mjs`, which changes when the plugin updates.

What a connected Grok Bot is sent is under [Privacy and security](../privacy-and-security.md).
