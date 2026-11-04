# Subagents

`start_agent` starts another coding agent as a subagent of the session that calls it, the way Claude Code's own Agent
tool does, but across harnesses: a Claude session can start a Codex, a Codex can start an OpenCode, and so on.

```
start_agent(harness: "codex", description: "Review auth changes", prompt: "Review the diff on this branch…",
            model: "gpt-5.5", effort: "high", isolation: "worktree")
→ Started codex:review-auth-changes [codex-h-review-auth-changes], Codex in …/worktrees/codex-review-auth-changes,
  with mode auto, model gpt-5.5, effort high.
  Transcript: ~/.telepathy/agents/codex-review-auth-changes/transcript.md
```

- **What runs:** the harness in its ACP mode under a small detached host (`agent.mjs`), with telepathy's tools when
  that harness has the plugin. It is a session like any other: it shows in `list_peers` and `telepathy ps`, and anyone
  can message it.
- **Results:** the call returns at once. Each time the agent's turn ends, its final message (the last stretch of text
  after its last tool call) arrives at the parent as a `<telepathy-peer-message kind="agent-result" transcript="…">`,
  under the same delivery confirm as any message. Continue it with `send_message`; its next turn reports back the same way.
- **Transcript:** `~/.telepathy/agents/<harness>-<name>/transcript.md`, with the task, each message it got, its text,
  and its tool calls.
- **Mode, model, effort:** set over ACP from what the harness offers on `session/new`. The agent runs in its harness's
  auto mode (`auto`, Copilot's `autopilot`, Devin's `smart`; never a bypass or yolo mode). `model` matches an id or a
  unique part of one (`opus`, `gpt-5.5`); `effort` is the harness's own name for it. A model that does not exist is an
  error that lists what is there; an effort the harness has no setting for is noted.
- **Permissions:** a request the harness still makes, or every request when it has no auto mode (OpenCode, Kilo,
  Cursor), goes to the parent as a `kind="permission"` message. The parent asks its user and calls
  `answer_permission`. No answer within 10 minutes is a denial.
- **Isolation:** `isolation: "worktree"` gives it a git worktree and a `telepathy/<name>` branch under
  `~/.telepathy/worktrees`. At stop, an unchanged worktree is removed with its branch; a changed one is kept.
- **Lifetime:** until `stop_agent`, or until the session that started it ends: within 15 seconds for a Claude Code
  session, like its own subagents, and 10 minutes for other agents. A restart of the session's MCP server (a plugin
  reload) is not the session ending.
- **Harnesses:** every one with an ACP mode (see `telepathy run --list`). Claude Code and Codex need their ACP adapters.
  A harness that needs a sign-in it cannot do itself (`kimi login`, `grok login`) fails to start with that reason.

## In Claude Code: a background task

In Claude Code's terminal, `start_agent` answers with an [MCP task](https://code.claude.com/docs/en/mcp) instead of a
result, so the agent is a background task of Claude Code's own, with no model standing in between:

```
start_agent(harness: "opencode", description: "Build bridge API", prompt: "Add the /v1/devices endpoint…")
  ⎿ started server-side task opencode:build-bridge-api            (the footer counts it: 1 MCP task)
⏺ MCP task opencode:build-bridge-api (plugin:telepathy:bridge/start_agent) completed.
```

- **The report** is the task's result: Claude gets it when the agent's turn ends, and starts on it if it was idle.
- **Follow-ups:** `send_message` to the agent returns a task the same way (`opencode:build-bridge-api#2`), whose
  result is its next report.
- **Stopping:** `TaskStop`, or `x` in `/tasks`, cancels the task, and that stops the agent. Ending the session stops
  every agent it started, working or idle, like Claude's own agents. `/reload-plugins` doesn't: the restarted server
  takes the open tasks up again.
- **Permissions:** a permission request the agent makes opens a dialog for you (Allow, then Accept or Decline). It
  is your answer, not Claude's.
- **Where:** MCP tasks need Claude Code's terminal (v2.1.304 or later, protocol revision 2026-07-28), and are in
  public beta there. Elsewhere (`claude -p`, the VS Code extension, the desktop app, other agents), `start_agent`
  works as described above: it returns at once and the report comes as a message.
- **The Agent tool** always runs a Claude model, so an Agent call naming another harness (`telepathy:codex`,
  `codex`, `codex:<name>`) is stopped with a pointer to `start_agent`, unless a Claude agent or plugin goes by that name.
- **A finished task can't be stopped.** Once an agent has reported, its task is done and `TaskStop` says so, as for
  any finished agent. The agent waits for a follow-up until `stop_agent` or the end of the session.

## On another device

With the [bridge](devices.md) running, `start_agent` can start the agent on another of your devices:

```
start_agent(harness: "codex", device: "laptop", description: "Run the GPU tests", prompt: "…", cwd: "/Users/me/ml")
→ Started codex:run-the-gpu-tests@laptop [codex-h-run-the-gpu-tests@laptop], Codex in /Users/me/ml on laptop, …
```

- **Allow it there first.** Trusting a device lets its sessions message yours; starting programs is a separate yes.
  On the device that runs the agents: `telepathy bridge allow-agents <device>` (and `deny-agents` to take it back;
  `telepathy bridge forget` takes it back too). Until then a start is refused with that command. `telepathy bridge
  status` shows `may start agents here` on each device you allowed.
- **Where it works:** `cwd` is a folder on that device. Without one, it works in your folder when that path exists
  there too; otherwise the start fails and names folders sessions there work in.
- **It is that device's agent:** it runs there in its harness's auto mode, with that device's harnesses, sign-ins and
  files, as if you had started it there. Its transcript is on that device.
- **Reports, follow-ups, stopping, permissions:** the same as on this device. Reports and permission requests come
  over the bridge as messages from `<agent>:<name>@<device>`; `send_message`, `stop_agent` and `answer_permission`
  reach it by that address. In Claude Code's terminal it is a background task as above, with TaskStop and the
  permission dialog: the server polls that device's bridge every 2 seconds.
- **Lifetime:** it stops when the session that started it ends, 15 seconds after that session leaves the device's
  listing (10 minutes for other agents). While the starting device is out of reach, nobody can tell whether the
  session still runs, so the agent waits 10 minutes (`TELEPATHY_AGENT_UNREACHABLE_MS`) before it stops.
