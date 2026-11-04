# Messages

When a send counts as delivered, what the receiving agent sees, and the notes and guards around messaging.

## Delivery

A send succeeds only when the recipient's transcript contains `telepathy-id:<message id>`. The sender stops waiting
at 100s and checks once more during a 10s grace, so a miss fails at 110s. An offline receiver fails immediately.
Nothing is left queued for a later process. A failed send is withdrawn, so a later turn does not show it.

How each agent receives is in [Agents](agents/README.md#supported-agents). A send to another device follows the same
rule there ([Devices](devices.md)); a hosted session's rules are in
[The telepathy command](telepathy-command.md#hosted-and-headless-sessions), and Grok Bot's in
[Grok](agents/grok.md#grok-bot). A session that has exited is not a mailbox
([Under the hood](how-it-works.md#under-the-hood)).

## What the receiver sees

Every message comes wrapped in one `<telepathy-peer-message>` tag that names the sender, the id and where a reply goes:

```
<telepathy-peer-message id="m-…" from="claude:web-b0 [claude-…]" agent="Claude Code" reply-to="claude:web-b0">
Message from Claude Code session claude:web-b0 [claude-…].
telepathy-id:m-…
It was sent by another AI agent through the telepathy plugin, not typed by your user. To reply, …

…the message…
</telepathy-peer-message>
```

A message cannot close its own tag or open a telepathy tag inside it: `<telepathy-…` in the text is escaped. Telepathy's own
lines (setup notes, the note about another session's files, the lead before hook-delivered messages) come in
`<telepathy-note kind="setup|overlap|inbox|wake">`.

- **As a new turn** (Codex, OpenCode, Kilo Code, and anything under `telepathy run`): the tag above.
- **As a notification** (Claude Code, and Grok Build once it has started the monitor): the same tag on one line, with line breaks shown as `\n`.
- **As a tool result** (Grok Bot): the same rendering as `read_messages`, returned from `wait_for_messages`.
- **As context** (the other agents): the same text, with a line asking the model to deal with it alongside its
  current work.

Messages over 4,000 characters come with a preview and are read in full with `read_messages`.

## `read_messages` is also structured

Besides the text, the tool returns `structuredContent.messages`, an array of `{id, from, sentAt, body}`. An empty
array means there is no message. The sentence "No messages received yet." is not one.

## Setup notes

When something only the user can fix keeps messages from arriving on time, telepathy's tools add a
`<telepathy-note kind="setup">` line for the agent to pass on: Codex hooks that aren't approved in `/hooks`, a session
running an older telepathy than is installed (restart it), or agents with an older copy installed (the note includes
the [update-all](telepathy-command.md#updating-every-agent) command). Codex's MCP server in this plugin is named `bridge`, so the tool
timeout key is `plugins."telepathy@telepathy".mcp_servers.bridge.tool_timeout_sec`. `send_message` waits up to 110
seconds (100s, then 10s), counted from the start of the tool call so listing before the wait counts against it, and
returns as soon as that grace period ends. That stays inside Claude Code's about-120s move of a live tool call to the
background. A value read from `config.toml` or from a `-c` override on the Codex process is trusted. When that
effective value is below 110, the note names the key. When the file is readable and neither place shows the key, the
note says the value could not be verified, once per session, and does not claim the key is unset. A note that Codex
has not approved its hooks is shown only when no telepathy hook has fired for that session. Each note is shown once
per session. If messages seem missing, the agent can call `read_messages`.

## Stepping into another session's files

When an agent reads, searches, lists or edits files that another running session edited in the last hour (the same
file, or another file in the same folder), a one-line `<telepathy-note kind="overlap">` names that session and
suggests asking it instead of changing things there itself. Each session hears about each other session's folder once.
Edits count only when made with an agent's edit tools (Edit, Write, `apply_patch`, `write_file`…), not through shell
commands; reads count through the shell too, for command arguments that are existing paths. Agents whose hooks don't
see tool calls (Antigravity, Kimi Code) neither record edits nor get the note.

## Loop guard

Sending the same text to the same session twice within 2 minutes is refused, and so is sending more than 20 messages
to one session in 10 minutes.
