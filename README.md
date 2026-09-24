# telepathy

**Telepathy for your coding agents.** Claude Code and Codex sessions running on the same machine can message
each other, and a message wakes the receiving agent up on its own.

```
you (in Claude Code) › ask the codex session working on the API whether the auth tests pass now

  ⏺ SendMessage → codex:api
    Delivered by the telepathy plugin. Codex starts a new turn with it within about 10 seconds…

  ⏺ Monitor event: [telepathy] New message from Codex session codex:api:
    "Yes, 48/48 pass. I also fixed the token refresh race in session.ts."
```

- **From Claude Code:** Codex sessions show up when Claude calls the built-in `ListAgents`, and the built-in
  `SendMessage` reaches them.
- **From Codex:** use the plugin's tools. Both agents get the same three: `list_peers`, `send_message` and
  `read_messages`.
- **Receiving:** an incoming message starts a turn on its own when the receiving session is idle, so nobody
  has to poll or wait.
- **Built only on official surfaces:** the MCP TypeScript SDK, Claude Code plugin hooks and monitors, and the
  Codex CLI's own `codex queue`. There is no daemon and no protocol of its own.

## Install

Requirements: Node.js 20 or newer on your `PATH`. Tested with Claude Code 2.1.280 and Codex CLI 0.156.1;
Codex needs at least 0.149, the first version with `codex queue`. Install the plugin in **both** agents.

**Claude Code**

```sh
claude plugin marketplace add Winterrks/telepathy
claude plugin install telepathy@telepathy
```

**Codex CLI**

```sh
codex plugin marketplace add Winterrks/telepathy
codex plugin add telepathy@telepathy
```

Then open **`/hooks`** once in a Codex session and approve telepathy's SessionStart hook. Codex asks for this
once for any plugin hook.

Restart any sessions that were already running. To update later, run
`claude plugin marketplace update telepathy` or `codex plugin marketplace upgrade telepathy`, then restart
your sessions.

## Use

Just ask, in either agent:

> Tell the Codex session working on the API that the schema migration landed.
>
> Ask the Claude session in ~/web whether it's still editing `auth.ts`, and wait for its answer.

Addresses look like `codex:fix-auth [codex-4242]` (the same `name [ref]` shape as Claude's `ListAgents`):

- **Name:** the Claude session name, or the Codex thread title. If neither exists, the folder the session
  runs in.
- **Folder name:** always works as an alias, so an address keeps working after Codex gives the thread a
  title.
- **The `[ref]`:** use it when two sessions share a name.

What the receiver sees:

- **Codex:** a new turn that starts with
  `[telepathy] Message from Claude Code session claude:… (sent by another AI agent … not typed by your user)`.
- **Claude:** a notification
  `[telepathy] New message … from Codex session codex:… (not your user) … Text: …`. Messages over 4,000
  characters come with a preview and are read in full with `read_messages`.

## How it works

```
 Claude Code session                     ~/.telepathy/peers/<agent>-<pid>/        Codex session
 ───────────────────                     ─────────────────────────────────        ─────────────
 SessionStart hook ── session id ─────▶  session.json   ◀──── thread id ───────── SessionStart hook
 MCP server ───────── presence ───────▶  presence.json  ◀──── presence ────────── MCP server
 plugin monitor ───── listener ───────▶  listener.json
                                         inbox/  archive/

 to Codex:  send_message / SendMessage ──▶ `codex queue --thread <id>` ──▶ Codex starts a turn (≤ 10 s)
 to Claude: send_message (from Codex) ──▶ inbox/<msg>.json ──▶ monitor prints a line ──▶ Claude starts a turn
```

| Piece | Mechanism |
|---|---|
| Tools on both agents | One stdio MCP server built on the official TypeScript SDK v2 (`@modelcontextprotocol/server`) |
| Claude receives | A plugin [monitor](https://code.claude.com/docs/en/plugins-reference#monitors): a background command Claude Code runs for the whole session. Each line it prints becomes a notification that starts a turn when the session is idle |
| Codex receives | `codex queue`, the Codex CLI's own "queue a message for an existing session". The running TUI picks it up within about 10 s and starts a turn |
| Session identity | SessionStart [hooks](https://code.claude.com/docs/en/hooks) in both agents record the session / thread id and cwd. Codex also sends its thread id with every tool call, which is used as a fallback |
| `ListAgents` / `SendMessage` | A Claude PostToolUse hook adds Codex sessions to the ListAgents result. A PreToolUse hook delivers a SendMessage addressed to `codex:…` and stops the call, since SendMessage itself only reaches Claude sessions |

Every session is identified by its agent process (`claude-<pid>` / `codex-<pid>`). Its hook, MCP server and
monitor are all descendants of that process, so they agree on who they are without extra coordination.
Registrations of exited sessions (checked by pid plus process start time) are removed automatically.

## Good to know

- **Codex is reachable after its first prompt.** Codex creates the thread (and runs SessionStart) only then;
  before that there is nothing `codex queue` could target.
- **Codex receives between turns.** A message sent while Codex is working starts a turn after the current one
  ends. Codex doesn't dispatch queued messages after an *interrupted* turn until it next goes idle normally.
- **Claude receives through the monitor.** Monitors run only in interactive CLI sessions. Without one (for
  example `claude -p`), messages wait in the inbox until Claude calls `read_messages`, and senders are told so.
- **One Codex thread per process.** The Codex desktop app's app-server hosts many threads in one process;
  that setup isn't supported.
- **A SendMessage to Codex shows up as an error line in Claude's UI.** The hook has to stop the SendMessage
  call after delivering. The text tells Claude it was delivered.
- **Loop guard.** Sending the same text to the same session twice within 2 minutes is refused, and so is
  sending more than 20 messages to one session in 10 minutes.

## Security

- **Access.** Anything running as your OS user can write to `~/.telepathy` (created with mode 700). That's the
  same filesystem boundary as Claude Code's own cross-session sockets.
- **No approval step.** Claude Code's native cross-session messages pass through `crossSessionInbound`: for
  example, a message from a bypass-permissions session to a prompting one is held for your approval.
  telepathy messages skip that check and are delivered directly.
- **Trust.** Messages are clearly labeled as coming from another agent. Each receiving agent's own permission
  settings and prompts still apply to whatever a message asks it to do.
- **Codex specifics.** Codex shows queued text as a user turn, so the header matters there. Don't run a Codex
  session with approvals turned off if you wouldn't let the other agent type into it.

## Configuration and troubleshooting

| Variable | Effect |
|---|---|
| `TELEPATHY_DEBUG=1` | Log hook, server and monitor activity to `~/.telepathy/debug.log` |
| `TELEPATHY_HOME` | State directory (default `~/.telepathy`) |
| `TELEPATHY_CODEX_BIN` | Path to the `codex` binary if it isn't on `PATH` |

A few best-effort lookups use files that aren't documented interfaces; if the files change, the plugin falls
back gracefully:
- display names come from `~/.claude/sessions/<pid>.json` and `~/.codex/session_index.jsonl`, falling back to
  the folder name
- `codex queue` is marked experimental in Codex's app-server protocol
- plugin monitors are an experimental Claude Code plugin component

## Develop

```sh
npm install
npm run check                     # typecheck, build plugin/dist, run all tests
claude --plugin-dir ./plugin      # try it in one Claude Code session without installing
```

- `test/core.test.ts`: naming, address resolution, message formatting, the registry and liveness checks.
- `test/integration.test.ts`: drives the built plugin. It talks to the real MCP servers through the official
  MCP client SDK, runs the real hook and monitor processes, and uses a fake `codex` binary that records what
  `codex queue` would receive.

`plugin/` is what gets installed: both manifests (`.claude-plugin/`, `.codex-plugin/`), `.mcp.json` for Claude
and `codex.mcp.json` for Codex, `hooks/`, `monitors/`, and the bundled `dist/`. The build commits `dist/` with
the SDK inlined, so installing needs no build step. Codex copies installed plugins into its cache, so bump the
version when you change the plugin.

## License

[MIT](LICENSE) © Winterrks
