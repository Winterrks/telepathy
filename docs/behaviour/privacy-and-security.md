# Privacy and security

What stays on your machine, what goes over the network and to whom, and what telepathy reads and runs.

- **Messages stay on your machine unless you start the bridge or connect a Grok Bot.** telepathy has no telemetry.
  Messages are JSON files in `~/.telepathy` (created with mode 700), readable by anything running as your OS user, the
  same boundary as Claude Code's own cross-session sockets. Without `telepathy bridge` or `telepathy grokbot`, the
  network calls are version checks and updates, not messages.
- **A connected Grok Bot gets its messages in full.** `telepathy grokbot` POSTs each message sent to `grok:<name>`,
  with the sender's address and this machine's host name, to that Bot's routine webhook (`api2.cursor.sh` for the Grok Bot
  app), which runs in the cloud. Nothing else is sent there, and nothing is sent until you run `connect`.
- **The bridge sends messages only to your devices.** It answers a device of your own Tailscale user (checked with
  `tailscale whois`, carried by WireGuard) or a device you paired by comparing a 6-digit code (sealed with
  AES-256-GCM). Anything else gets a refusal; the one open endpoint, `/v1/hello`, returns this device's id, name and
  version, as mDNS already does. A trusted device sees your sessions' addresses, working directories and statuses,
  and can start a turn in any of them, the same as a session on this machine can. Pair only devices you control.
  It can start agents (programs, in their harness's auto mode) only after `telepathy bridge allow-agents` names it.
  `~/.telepathy/bridge/trusted.json` (mode 600) holds the pair keys; `events.jsonl` keeps the last messages' first
  160 characters for `telepathy bridge watch`. [update-all](telepathy-command.md#updating-every-agent)
  and `telepathy update` have each agent fetch a new version from GitHub. `telepathy status` and the daily auto-update
  read the version in this repository's `package.json` on GitHub (at most once a day unless you ask); with a global
  `telepathy-cli`, they also ask the npm registry for its latest version. `telepathy setup` runs each agent's own
  install command and `npm install -g` for the ACP adapters. A webhook named
  in `delivery.json` POSTs a wake with no message text. Apart from the bridge, none of these carry
  messages.
- **What it reads:** Claude Code's session name (`~/.claude/sessions/<pid>.json`), Codex's thread titles
  (`~/.codex/session_index.jsonl`), and the last turn marker at the end of a Codex session log
  (`~/.codex/sessions/…`) to show busy/idle, and the timestamp of its last line to tell when a permission prompt was
  answered; the `status` field of Claude Code's session record, to show busy/shell/idle/waiting; the names of telepathy's hook-approval tables in `~/.codex/config.toml`;
  and the version of each agent's installed copy of telepathy. It never reads message content from those logs, and
  stores none of it. It records which files each session edits with its edit tools (paths and times only, never
  contents), in that session's folder in `~/.telepathy`, removed when the session ends.
- **What runs:** the MCP server while a session is open; in Claude Code, the hooks in `plugin/hooks/claude-hooks.json`
  (SessionStart; PostToolUse/PreToolUse matched to ListAgents and SendMessage; PreToolUse on Agent, which points a
  call naming another harness to `start_agent`; PostToolUse matched to the file,
  search and Bash tools, which records edited paths and adds the note above; UserPromptSubmit and Stop). SessionStart,
  UserPromptSubmit, and Stop also start an idle-wake hook when the session has no inbox socket. Those hooks hand
  over waiting messages and, in a stream-json host without a socket, remind Claude to start a one-shot waiter. In
  the other agents, the hooks listed in their manifest. They register the session, hand over messages and track
  edited files, nothing else.
- **No approval step.** Claude Code's native cross-session messages pass through `crossSessionInbound`: for example, a
  message from a bypass-permissions session to a prompting one is held for your approval. telepathy messages skip
  that check and are delivered directly.
- **Trust.** Messages are clearly labeled as coming from another agent. Each receiving agent's own permission settings
  and prompts still apply to whatever a message asks it to do. Several agents show messages as a user turn or next to
  your prompt, so the header matters: don't run a session with approvals turned off if you wouldn't let the other
  agent type into it.
