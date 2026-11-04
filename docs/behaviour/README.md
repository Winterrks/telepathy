# How telepathy behaves

The technical side of telepathy, one topic per page. The [project README](../../README.md) is the overview.

- [How it works](how-it-works.md): the tools every agent gets, how a message reaches the receiving agent, and what
  runs underneath.
- [Sessions](sessions.md): addresses, names and refs, how a session keeps its identity across restarts and resumes,
  and the statuses the listings show.
- [Messages](messages.md): when a send counts as delivered, what the receiving agent sees, and the notes and guards
  around messaging.
- [Agents](agents/README.md): which agents are supported and how each one receives, with a page per agent for its
  install, update and quirks: [Claude Code](agents/claude-code.md), [Codex](agents/codex.md),
  [OpenCode](agents/opencode.md), [Kilo Code](agents/kilo-code.md), [GitHub Copilot CLI](agents/copilot.md),
  [Qwen Code](agents/qwen-code.md), [Grok](agents/grok.md), [Devin CLI](agents/devin.md),
  [Antigravity](agents/antigravity.md), [Cursor](agents/cursor.md) and [Kimi Code](agents/kimi-code.md).
- [The telepathy command](telepathy-command.md): `setup`, `update`, `run`, hosted and headless sessions,
  auto-update, and updating every agent's copy.
- [Devices](devices.md): `telepathy bridge`, which lets sessions on your other devices message each other.
- [Subagents](subagents.md): `start_agent`, including the background task in Claude Code and agents on another
  device.
- [Privacy and security](privacy-and-security.md): what stays on your machine, what goes over the network, and what
  telepathy reads and runs.
- [Configuration and troubleshooting](configuration.md): environment variables, webhook wakes, and what to check when
  a session is missing or a message is late.
- [Development](development.md): building and testing telepathy from this repository.
