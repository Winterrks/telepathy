# How it works

What every agent gets from telepathy, how a message reaches the receiving agent, and what runs underneath.

You have two agents open on the same repo: one building the UI, one fixing the daemon. Neither is in a worktree,
and neither knows the other exists. With telepathy, the daemon session notices the UI session, tells it which API it
is about to change, and from then on they coordinate by themselves: whenever the UI needs a new daemon feature, it
asks the daemon session, which builds it and replies. You don't relay a thing.

## Tools

Every agent gets the same tools: `list_peers` to see who else is running, `send_message` to write to them,
`read_messages` for long messages, and `start_agent` / `stop_agent` / `answer_permission` to run another agent as a
subagent ([Subagents](subagents.md)). Grok also gets `wait_for_messages`, which holds the MCP connection open until a
message arrives. Grok Bot uses that call to receive while idle; Grok Build keeps using its monitor and does not call
it. Addresses look like `codex:api-c3f` or `opencode:shop-ui-o1a`, so any session can reach any
other: Codex to Codex, OpenCode to Claude, Antigravity to Copilot. Claude Code also sees the other agents' sessions in its
built-in `ListAgents` and can reach them with its built-in `SendMessage`, and there `start_agent` runs as a background
task Claude Code follows itself ([In Claude Code: a background task](subagents.md#in-claude-code-a-background-task)); Qwen Code
does the same with its `list_agents` and `send_message`.

## Receiving

The receiving side is what makes it feel like telepathy. Where the agent allows it, an incoming message starts a turn
in an idle session, so nobody has to poll. Where it doesn't, the message rides along with the agent's next turn.

`telepathy run <agent>` pushes each message into the hosted session as it arrives. A plain Copilot, Devin, Qwen, Kimi,
Cursor, or Antigravity CLI session receives at its next turn through hooks. Claude Code does the same when it has no
inbox socket, and wakes an idle session when it does. Grok Bot receives when `wait_for_messages` returns. A send
succeeds only when the recipient's transcript contains `telepathy-id:<message id>`. The sender stops waiting at 100s
and checks once more during a 10s grace, so a miss fails at 110s. An offline receiver fails immediately. Nothing is
left queued for a later process. A failed send is withdrawn, so a later turn does not show it.

The rules in full are in [Messages](messages.md#delivery).

## An example

In Claude Code, asking a Codex session something looks like this:

```
you (in Claude Code) › ask the codex session working on the API whether the auth tests pass now

  ⏺ ListAgents
    Peer sessions (1):
      web-b0 [3fa9c1]  ·  interactive  ·  idle  ·  started 2h ago

    Other agents' sessions (2), reachable through the telepathy plugin …
      codex:api-c3f [codex-01a1176e-84cc-76c3-b84c-8e4da4d38c36]  ·  interactive  ·  idle  ·  started 3h ago
      opencode:shop-ui-o1a [opencode-ses_edfc52738ffe37lStsw85pjsWy]  ·  interactive  ·  busy  ·  started 1h ago

  ⏺ telepathy - send_message (to: "codex:api-c3f", message: "Do the auth tests pass now?")
    Message queued for delivery to codex:api-c3f [codex-01a1176e-84cc-76c3-b84c-8e4da4d38c36].

  ⏺ Monitor event: <telepathy-peer-message from="codex:api-c3f [codex-01a1…]" agent="Codex" reply-to="codex:api-c3f">
    New message from Codex session codex:api-c3f … "Yes, 48/48 pass. I also fixed the token refresh race in session.ts."
```

Just ask, in any agent:

> Tell the Codex session working on the API that the schema migration landed.
>
> Ask the Claude session in ~/web whether it's still editing `auth.ts`, and wait for its answer.
>
> Is anyone else working in this repo? If so, tell them which files you're about to change.

## Under the hood

```
 any agent session                       ~/.telepathy/peers/<agent>-<key>/        any agent session
 ─────────────────                       ─────────────────────────────────        ─────────────────
 session hook ─────── session id ─────▶  session.json   ◀──── session id ──────── session hook
 MCP server / plugin ─ presence ──────▶  presence.json  ◀──── presence ────────── MCP server / plugin
 monitor / plugin ─── listener ───────▶  listener.json
                                         inbox/  archive/

 to Codex:            send_message ──▶ `codex queue --thread <id>` ──▶ Codex starts a turn (≤ 10 s)
                                  └──▶ inbox/<msg>.json ──▶ mid-turn: the next tool call hands it over
 to Claude Code:      send_message ──▶ inbox/<msg>.json ──▶ monitor prints a line ──▶ Claude starts a turn
 to Grok Build:       send_message ──▶ inbox/<msg>.json ──▶ monitor prints a line ──▶ Grok starts a turn
 to Grok Bot:         send_message ──▶ inbox/<msg>.json ──▶ a parked wait_for_messages returns it
 to OpenCode / Kilo:  send_message ──▶ inbox/<msg>.json ──▶ plugin calls session.prompt(Async) ──▶ a turn starts
 to Antigravity App:  send_message ──▶ inbox/<msg>.json ──▶ sidecar calls `agentapi send-message`
 to the others:       send_message ──▶ inbox/<msg>.json ──▶ the next prompt, tool call or turn end hands it over
```

| Piece | Mechanism |
|---|---|
| Tools | One stdio MCP server built on the official TypeScript SDK v2 (`@modelcontextprotocol/server`). OpenCode and Kilo Code get the same tools as native plugin tools |
| Session identity | The harness's own session id when a hook, tool call, or environment variable reports one: `<agent>-<session id>`, stored under `~/.telepathy`. A resume (`claude --resume`, `codex resume`, `copilot --resume` / `copilot --continue`, an OpenCode session that continues) reclaims that id, its name, and its inbox. Copilot claims that id when its MCP server starts, before the first prompt, when the resume signals agree. `TELEPATHY_NAME` or `--name` still replaces the name. A process that has not reported an id yet is `<agent>-<pid>`. Two live processes on one session id are one peer; the first one owns delivery and the listing says `duplicate session` |
| Claude receives | A plugin [monitor](https://code.claude.com/docs/en/plugins-reference#monitors): each line it prints becomes a notification that starts a turn when the session is idle |
| Codex receives | `codex queue`, the Codex CLI's own "queue a message for an existing session". The running TUI picks it up within about 10 s. During a turn, the PostToolUse hook hands the message over from the inbox and removes it from the queue (`thread/queue/delete` on a short-lived `codex app-server`) |
| OpenCode receives | The plugin runs inside OpenCode. OpenCode 2: `session.prompt` with `delivery: "steer"`, which starts a turn or joins the running one. OpenCode 1.x: `client.session.promptAsync` once the session goes idle |
| Grok Build receives | The model starts `monitor.mjs` with Grok's monitor tool; each line wakes an idle session. Hooks cover the next tool call and the end of a turn until then |
| Grok Bot receives | `wait_for_messages` long-polls the inbox on the MCP connection the bot already holds and returns the message as the tool result. That return records `telepathy-id` so the sender's confirm succeeds. A logging line and `resources/updated` on `telepathy://inbox` are also sent, and claim nothing. A failed confirm withdraws the copy; a later wait does not see it |
| The others receive | Their hooks: before a prompt or after a tool call the pending messages go into the context; at the end of a turn they keep the turn going (`decision: block`, Cursor's `followup_message`, Antigravity's `continue`) |
| Guidance | A few lines of instructions: MCP server instructions where the agent shows them, otherwise a session-start hook, a rule file or a system-prompt field. The `using-telepathy` skill has the full guide |
| `ListAgents` / `SendMessage` | A Claude PostToolUse hook adds the other agents' sessions, and every session on another device, to the ListAgents result, in its own row format. `SendMessage` on its own only reaches Claude sessions, so a PreToolUse hook delivers a `SendMessage` aimed at another harness or device, then stops the native call; that tool result is an error (deny is the only decision that prevents the native call). Claude-to-Claude `SendMessage` is left alone |
| `start_agent` in Claude Code | The server speaks protocol revision 2026-07-28 with Claude Code (`serveStdio`) and answers `start_agent`, and `send_message` to an agent it started, with an MCP task when the request declares the tasks extension. It answers Claude Code's `tasks/get`, `tasks/update` and `tasks/cancel` itself. The agent host offers its report or permission request to the open task (`~/.telepathy/agents/<name>/task/`) and sends it as a message when no task takes it |
| Qwen's `list_agents` / `send_message` | Qwen Code 0.24 and later list their own background agents and other Qwen sessions. Its PostToolUse hook cannot rewrite a result, so the other agents' sessions follow `list_agents` as context. A PreToolUse hook on `send_message` delivers a message aimed at a `<agent>:` address, a `[ref]`, or another device, and stops the native call the same way. Teammate names and Qwen's own destinations are left alone |

Each agent gets its own manifest, so none of them runs another's hooks: `plugin/.claude-plugin`, `.codex-plugin`,
`.grok-plugin`, `.github/plugin` (Copilot), `.cursor-plugin` and `.devin-plugin`;
`qwen-extension.json` and `.kimi-plugin` at the repository root; `antigravity/` for Antigravity (plugin, hooks, MCP, skill, and the App sidecar); and the root
`package.json` for OpenCode and Kilo Code (its default export has `setup` for OpenCode 2 and `server` for 1.x and Kilo).
A session keyed by its harness id keeps its directory for a day after the process exits, so a resume reclaims the
same id and any mail that was already in the inbox. That day is not a mailbox: a send while the process is gone
returns `Message failed:` immediately and writes nothing. Pid-only registrations are removed once the process is
gone; their unread mail waits an hour. `list_peers` only shows sessions that are running.
