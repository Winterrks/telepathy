# Unified delivery across harnesses

Status: design only. No behavior change, no version bump. First pass and a second source pass, both 27 October 2026 (Europe/Lisbon). The second pass is called out inline where it changes a conclusion.

Telepathy already has one bus: a file inbox under `~/.telepathy`, three tools (`list_peers`, `send_message`, `read_messages`), and a pile of per-harness listeners. What it does not have is one delivery contract. Each harness grew its own way of getting a message into a session, and several of those ways only work when the receiver happens to be mid-turn, or when the model remembers to start a watcher.

This note records how delivery works in this repo today, what each harness can actually do as of the sources below, and a layered shape so the next harness is a thin adapter instead of another special case. It does not implement that shape.

A concurrent change is adding push delivery for Grok Bot clients. That work owns the Grok Bot wake mechanism. This note only reserves a slot for it. See [Grok Bot](#grok-bot).

## What delivery means

Four outcomes, from best to worst. A harness can do more than one. The sender's status string should name the one that actually happened.

| Outcome | Meaning |
|---|---|
| Direct injection | The text is inserted into that session's turn or context. The model does not have to call `read_messages`. |
| Wake an idle session | Injection starts a turn while nobody is typing and no tool is running. |
| Notification | The harness shows a line (a monitor event, a system notification). The model is expected to notice. Whether that starts a turn is up to the harness. |
| Poll only | The bytes sit in the inbox until this session calls `read_messages`. |

Next-boundary hooks (inject on the next prompt, tool result, or turn end) are direct injection with the wake missing. They are the usual fallback, not a fifth product. Notification-then-read is the fallback under that: show a line if the harness can, and leave the inbox claimable either way.

## How delivery works today

`sendMessage` in `src/core/deliver.ts` writes one JSON file into the recipient's inbox, except for Codex, which also submits `codex queue`. Something on the receiving side claims the file by renaming it into the archive (`claimInbox` in `src/core/messages.ts`). The rename is the only exactly-once lock. Two consumers racing for the same file, one wins.

Who claims it:

| Harness | What runs | Idle session | Mid-turn | If that listener is absent |
|---|---|---|---|---|
| Claude Code | Plugin monitor (`plugin/monitors/monitors.json` → `src/monitor.ts`). Each stdout line becomes a notification that starts a turn when the session is idle. | Wakes, in an interactive terminal. | Monitor still prints; hooks stay out of the way once `listener.json` exists. | `UserPromptSubmit` and `Stop` in `plugin/hooks/claude-hooks.json`. The Claude app and `claude -p` stream-json hosts do not start plugin monitors, so the guide tells the model to run `monitor.mjs --once` as a background command. Until that waiter exists, hooks only. |
| Codex | `codex queue --thread=<id>` (`src/core/codex-queue.ts`). The running TUI picks the queued turn up. | Wakes, about 10 seconds, unless the last turn was interrupted. | Inbox copy plus `PostToolUse`, which claims the inbox and deletes the queue item (`thread/queue/delete`) so it does not arrive twice. | Without `PostToolUse` approved, the queue waits until the turn ends. Without a thread id, send fails. |
| OpenCode 2 | In-process plugin. `ctx.session.prompt({ delivery: "steer" })` (`src/opencode.ts`). | Starts a turn. | Joins the running turn. | No hook fallback. `read_messages` still works. |
| OpenCode 1.x and Kilo Code | Same plugin, `client.session.promptAsync` once the session is idle. | Wakes after idle. | Waits until idle. | Same. |
| Copilot CLI | Hooks only (`plugin/hooks/copilot-hooks.json`): `sessionStart`, `userPromptSubmitted`, `postToolUse`, `agentStop`. | Does not wake. | `postToolUse` adds `additionalContext`. `agentStop` returns `decision: block` so the turn continues. | `read_messages`. |
| Gemini CLI | Hooks (`hooks/hooks.json`): `SessionStart`, `BeforeAgent`, `AfterTool`, `AfterAgent`, `Notification` (status only). | Does not wake. | `AfterTool` context; `AfterAgent` continues the turn. | `read_messages`. |
| Qwen Code | Claude-shaped hooks in `qwen-extension.json`: `UserPromptSubmit`, `PostToolUse`, `Stop`. | Does not wake. | Context, then `Stop` continues. | `read_messages`. |
| Grok CLI | MCP instructions tell the model to start `monitor.mjs` with Grok's `monitor` tool (`src/server.ts`, `src/core/guide.ts`). Hooks in `plugin/hooks/grok-hooks.json`: `SessionStart`, `PostToolUse`, `Stop`. | Wakes only after the model has started that monitor. Not before the first prompt. | `PostToolUse` context; `Stop` continues. The monitor, if running, suppresses the hooks. | `read_messages`. `UserPromptSubmit` is not registered, and current Grok discards that event's stdout anyway (below). |
| Devin CLI | `plugin/hooks.json`: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`. | Does not wake. | Context, then `Stop` continues. | `read_messages`. Plugin hooks are best-effort and fail open. |
| Antigravity CLI | `antigravity/hooks.json`: `PreInvocation` returns `{ injectSteps: [{ userMessage }] }`, `Stop` returns `{ decision: "continue" }`. | Does not wake. | Next invocation, or the turn continues. | `read_messages`. No session-start hook; later hooks register the process. |
| Cursor CLI | `plugin/hooks/cursor-hooks.json`: `sessionStart`, `postToolUse`, `stop` (`followup_message`, `loop_limit: 10`). | Does not wake. | After the next tool call. | README records that Cursor CLI 2026.09.23 does not run plugin stop hooks, so `followup_message` is configured and not observed there. |
| Kimi Code | `.kimi-plugin/plugin.json`: `SessionStart`, `UserPromptSubmit` (plain stdout), `Stop` (stderr + exit 2). No `PostToolUse`. | Does not wake. | Next prompt, or the turn continues. | `read_messages`. |
| Hermes, OpenClaw, Pi | Named in `src/core/agents.ts` so a process can be recognized. No manifest, no hooks, `nextTurnHook` unset. | No. | No. | `read_messages` only, and only if that process is running the MCP server. README lists them as not supported yet. |

Loop control already lives in the bus, not in the adapters: the same body to the same peer twice inside two minutes is refused, and so is a 21st message to one peer inside ten minutes (`src/core/deliver.ts`). Long hook payloads are previewed at 4,000 characters because Copilot's `postToolUse` `additionalContext` is capped at 10 KB (`src/core/messages.ts`).

Sender-facing status is already the ladder in miniature (`inboxStatus`, `codexQueueStatus`): listener means "delivered", hook-capable peer means "next turn", anything else means "only when it calls `read_messages`". Codex adds waiting, busy, and interrupted.

## What each harness can actually do

Dates are the source's own date when it has one, otherwise the retrieval date above. Secondary roundups that disagree with these pages are ignored. One public matrix claimed Gemini CLI and Copilot CLI cannot inject context; both vendors' docs say they can.

### Claude Code

Hooks fire in the terminal, IDE, desktop app, and cloud sessions. `UserPromptSubmit` runs before Claude processes a prompt, including turns Claude starts itself. `Stop` can block and continue. `PostToolUse` can add `additionalContext`. Command, HTTP, prompt, agent, and in-process mod hooks are all specified. ([Hooks reference](https://code.claude.com/docs/en/hooks), retrieved 27 Oct 2026.)

Plugin monitors are the idle-wake path telepathy uses. A monitor is a long-running command; every stdout line is a notification. They run only in interactive CLI sessions, unsandboxed, at hook trust level, and are skipped where the Monitor tool does not exist. They are experimental. ([Plugins reference](https://code.claude.com/docs/en/plugins-reference), retrieved 27 Oct 2026.)

Claude's own cross-session tools are the prior art telepathy already bridges. `ListAgents` and `SendMessage` deliver plain text between Claude sessions; an idle session starts a turn; a busy session sees the message between tool calls; `crossSessionInbound` can accept, hold, or refuse. Telepathy's `PreToolUse` on `SendMessage` delivers other agents' addresses and then denies the native call, so Claude's UI shows an error even when the inbox write succeeded. Native Claude-to-Claude traffic is not intercepted. ([Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), retrieved 27 Oct 2026; `src/hook.ts`.)

The same page documents a direct inject telepathy does not use yet. Since v2.1.224 (macOS, Linux, WSL 2) and v2.1.234 (native Windows), each session with messaging enabled binds an inbox socket. Hooks and Bash see `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. A script may connect and send `{"type":"auth","token":...}` as the first line (optional on macOS and Linux, required on native Windows). Messages on that socket go through the same inbound controls as `SendMessage`. The exception is an own-child post: when no `crossSessionInbound` value applies, Claude delivers a message it can verify came from the session's own child. If it cannot verify that, a bypass-permissions session holds the message. `refuse` drops every socket message and still binds the socket. Bare mode does not bind one. `claude -p` does. ([Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), [v2.1.224 release notes](https://github.com/anthropics/claude-code/releases/tag/v2.1.224).)

The page excerpt retrieved here shows the auth line and the trust rules. It does not quote the following line that carries the message body. Do not invent that payload from another project's README. Read the current page, then test, before any adapter writes the socket. Until then the monitor remains the Claude path this repo actually runs.

This is also the answer to the open question about `crossSessionInbound`. A socket write participates in accept, hold, and refuse. The monitor path does not. Prefer the socket for Claude-to-Claude once the payload is confirmed, and keep the monitor for hosts that do not bind a socket. A message from Codex or OpenCode into Claude is not an own-child post, so hold and refuse apply. That is the trust behavior to copy, not to bypass.

The Agent SDK can `query()` a session the SDK itself spawned, including a follow-up on a resumed session. That is not a handle on someone else's already-open TUI. ([Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Python SDK reference](https://code.claude.com/docs/en/agent-sdk/python), retrieved 27 Oct 2026.)

### Codex

`codex queue` is the supported idle wake. The app-server equivalent is experimental `thread/queue/add`: the server stores a user turn and starts it FIFO when the thread is next idle, up to 100 queued submissions. Completed and failed turns drain the queue. An interrupted turn leaves it paused, including after `thread/resume`, until `thread/queue/start` or a user prompt. `thread/queue/delete` removes one item. Clients must send `capabilities.experimentalApi: true`. ([App server README](https://github.com/openai/codex/blob/27c05a52/codex-rs/app-server/README.md), queue API added in commit `9341b38` on 13 Aug 2026.)

`turn/steer` appends user input to the in-flight regular turn and returns the `turnId` that accepted it. Review and compaction turns reject it. It is the mid-turn primitive. Telepathy does not call it; `PostToolUse` is the substitute, so a busy Codex with no further tool call waits until the turn ends. OpenAI's answer to an inject-command request was to use app-server `turn/steer` rather than teach the TUI a new flag. ([App server README](https://github.com/openai/codex/blob/27c05a52/codex-rs/app-server/README.md); [openai/codex#11415](https://github.com/openai/codex/issues/11415), Feb 2026.)

Hooks exist and are trust-gated: `/hooks` reviews the definition, and a changed command is skipped until trusted again. `UserPromptSubmit` and `PostToolUse` can return `hookSpecificOutput.additionalContext` (default preview around 2,500 tokens, configurable). `Stop` with `decision: "block"` does not reject the turn; it continues, and the `reason` becomes a new user prompt. `continue: false` from any matching Stop hook wins. Telepathy does not register Codex `Stop`, on purpose: the queue already starts the next turn, and a Stop continuation would double-deliver if both fired. ([Codex hooks](https://learn.chatgpt.com/docs/hooks), retrieved 27 Oct 2026.)

`codex-acp` is a separate stdio ACP server that launches app-server and translates. It is how an editor hosts Codex. It is not an attach point for a Codex TUI the user already started. ([codex-acp](https://github.com/agentclientprotocol/codex-acp/), retrieved 27 Oct 2026.)

### Gemini CLI

`BeforeAgent` can append `hookSpecificOutput.additionalContext` to that turn's prompt. `AfterAgent` can `decision: "deny"` and send `reason` back as a new prompt, or exit 2 to do the same from stderr. `AfterTool` can add context. Nothing in the hook list starts a turn while the CLI is idle. Hooks are enabled by default from Gemini CLI 0.26.0. ([Hooks reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md), retrieved 27 Oct 2026.)

`gemini --acp` is a real ACP agent over stdio: `initialize`, `session/new`, `session/prompt`, `session/cancel`. The ACP client is the program that spawned that process. A second program cannot share the TUI's stdin. ACP mode still runs inside Gemini CLI, so the same hooks apply to turns that entered through `session/prompt`. ([ACP mode](https://geminicli.com/docs/cli/acp-mode/), retrieved 27 Oct 2026.)

### Qwen Code

Qwen Code's hook document matches the Claude-shaped contract telepathy emits: command stdout JSON, `hookSpecificOutput.additionalContext` on tool events, and a top-level `decision`. Plain stdout is context only for command hooks. In ACP sessions, a hook `decision` of `"ask"` is treated as deny. No idle-wake event is documented. ([Qwen Code hooks](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md), retrieved 27 Oct 2026.) Telepathy installs Qwen from the archive tarball because pointing Qwen at the git repo offers the Claude plugin, which does not include these hooks (README).

### OpenCode and Kilo Code

OpenCode 2's plugin API is an in-process direct inject. `ctx.session.prompt({ sessionID, text, delivery })` admits a durable inbox item. `steer` (the default) delivers at the next safe step boundary and wakes execution. `queue` waits until idle, behind steers. `resume: false` records input without scheduling a turn. Synthetic messages skip the prompt hook. ([Plugin server](https://opencode.ai/v2/docs/build/plugins/server/), [session spec](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md), retrieved 27 Oct 2026.)

That is why OpenCode does not need a command hook. The plugin is on the session bus already. Kilo Code CLI loads the same package; the Kilo IDE extension is out of scope because one server hosts every chat (README).

There is also an HTTP session API (`POST /api/session/{sessionID}/pending/{inputID}/steer` and the inbox queue route). Telepathy does not call it. The in-process plugin is the supported path; the HTTP route is a fallback if a future adapter runs outside the process. It is not a reason to add a daemon by itself.

### Copilot CLI

Command hooks can inject `additionalContext` at `sessionStart` and `postToolUse`. `postToolUse` joins multiple hooks with a blank line and caps the result at 10 KB. `agentStop` can `decision: "block"` and force another turn, which still counts against a cloud job's timeout. `userPromptSubmitted` does **not** honor command-hook output; `modifiedPrompt` is SDK-only. ([Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference), retrieved 27 Oct 2026.)

The `notification` hook can return `additionalContext` and "inject it as a prepended user message", which "can trigger further agent processing if the session is idle". It only runs when Copilot itself emits a notification (shell finished, agent idle, permission, elicitation). It does not run because a file appeared in `~/.telepathy`. It is not an idle-wake channel for telepathy. Cloud agent does not fire it at all.

So Copilot stays next-boundary. A block on `agentStop` covers "a message landed while the turn was ending". A message that lands after the session is already idle waits for the next prompt or tool call.

`copilot --acp` is a real ACP server (stdio, or `--port`). `session/load` has been able to resume a session stored on disk since 0.0.410 (14 Feb 2026). A maintainer comment on 7 Apr 2026 says v1.0.19 lets `session/list` and `session/load` see sessions another process created, and that two processes still cannot edit one live session at the same time. Loading is a sequential resume, not a poke into the TUI the user already has open. ([ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server), [changelog 0.0.410](https://github.com/github/copilot-cli/blob/f774d4ad/changelog.md), [copilot-cli#1767](https://github.com/github/copilot-cli/issues/1767).)

### Cursor

Official hooks include `sessionStart` (`additional_context` into the initial system context), `postToolUse` (`additional_context` after the tool result), `beforeSubmitPrompt`, and `stop`. A non-empty `followup_message` from `stop` is submitted as the next user message. Default loop cap is 5 per script; `loop_limit: null` removes it. Claude-shaped `decision: "block"` on `Stop` is accepted as a follow-up. ([Hooks](https://cursor.com/docs/hooks), [third-party hooks](https://cursor.com/docs/reference/third-party-hooks), retrieved 27 Oct 2026.)

The CLI changelog for January 2026 lists stop hooks with follow-up loops. Telepathy's own live note is newer and narrower: Cursor CLI 2026.09.23 hands messages over after the next tool call and does not run plugin stop hooks (README). Treat `followup_message` as documented for the product and unverified for that CLI build. Do not claim the CLI wakes an idle session until a version is retested.

Cursor also reads Claude Code `settings.json` hooks. Telepathy already ships a separate Cursor manifest so Claude's matcher syntax is not what Cursor runs (`plugin/.cursor-plugin/plugin.json`).

### Devin CLI

Local sessions load `hooks.json` from a plugin. Events include `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `PermissionRequest`, `SessionEnd`. `UserPromptSubmit` and `SessionStart` inject `hookSpecificOutput.additionalContext`. Command hooks receive JSON on stdin and can block with exit 2 or `decision: "block"`. Plugin hooks are best-effort and fail open, including on cloud sessions' skill loading versus local hook execution. No monitor or queue API is documented, so an idle Devin waits. ([Hooks overview](https://docs.devin.ai/cli/extensibility/hooks/overview), [lifecycle](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks), [plugins](https://docs.devin.ai/cli/extensibility/plugins/overview), retrieved 27 Oct 2026.)

### Grok CLI (Grok Build)

Two documents disagree, and the longer one wins.

The short hooks page, last updated 2 July 2026, says that for passive events stdout is ignored and exit 0 is enough. ([Hooks](https://docs.x.ai/build/features/hooks).)

The in-repo user guide on `main` is specific. An allowing `UserPromptSubmit` drops stdout, including `additionalContext`. Auto-wake turns run that hook observe-only. `PostToolUse` stdout is read: `additionalContext` is delivered next to the tool result, clipped at 10,000 characters. `Stop` with `decision: "block"` or `additionalContext` keeps the agent working; `reason` is continuation feedback. `SessionStart` and `Notification` ignore stdout. A non-zero exit on `PostToolUse` keeps a block reason and drops `additionalContext`. ([10-hooks.md](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md), retrieved 27 Oct 2026.)

Telepathy's Grok hooks match that guide by accident of shape: they do not use `UserPromptSubmit`, they do use `PostToolUse` `additionalContext` and `Stop` `decision: "block"`. They cannot put a message on the next typed prompt. They can put it on the next tool result, or continue a turn that is just ending.

Idle wake is the `monitor` tool, not a plugin monitor. Each stdout line becomes a conversation notification. `persistent: true` keeps it for the session. Urgent monitor events are eligible for mid-turn drain; noisy monitors are stopped automatically. The model has to start it. Telepathy's MCP instructions say to do that as the first action of every conversation. Before that, and whenever the model does not, the session is poll-only until the next tool call or turn end. Grok 1.0.41 does not start plugin hooks on a new session until `/hooks` reload (README). ([Background tasks](https://docs.x.ai/build/features/background-tasks), [20-background-tasks.md](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/20-background-tasks.md), retrieved 27 Oct 2026.)

Grok's session actor is already ACP-shaped internally (`acp_session.rs`, leader-mode clients). That is an internal seam, not an invitation for telepathy to open a second ACP session onto a running TUI.

### Grok Bot

Grok Bot clients that only speak MCP have the three tools and no hook process. `read_messages` is the whole receive path. MCP cannot push a tool call into an idle client (see below).

The product itself can wake a Bot without MCP. Official docs, updated 22 Oct 2026, say one Bot can send an asynchronous message to another Bot, and the receiver wakes and can reply later. Routines run on a schedule or, where supported, after a Cursor account event such as Slack or GitHub. A test run does real work. Inference hooks are the wrong seam: before a governed model call, Cursor POSTs a signed `prompt` frame to an endpoint you own, and that endpoint returns allow or deny. It does not insert a message. ([Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration), [Inference hooks](https://docs.x.ai/grok-bot/inference-hooks).) Webhook triggers with Standard Webhooks signatures are documented for Grok automations, last updated 17 Aug 2026, and the Bot routines page points at webhooks for schedules and Slack. A valid webhook returns 202 and starts work asynchronously. ([Webhook triggers](https://docs.x.ai/grok/automations/webhooks).) That is a notification-then-read ladder if the routine's first step is "call read_messages". It is not injection into an already-open MCP turn.

Third-party bridges use the same doorbell shape. They are prior art, not a dependency. ([grok-bot-mcp-connector](https://glama.ai/mcp/servers/chipherndon/grok-bot-mcp-connector), retrieved 27 Oct 2026.)

Push delivery for MCP clients is in progress on a separate cloud agent, ["Push delivery of incoming messages for Grok Bot clients"](https://cursor.com/agents/bc-5fc4e04e-258b-59c3-8a1e-61969582bd7e). This design does not choose its transport, its session id, or its code layout. The contract it should satisfy is in [Adapter contract](#adapter-contract). Do not also call Bot webhooks from the core bus. Two wakes for one inbox file is the double-delivery bug.

### Antigravity CLI

Telepathy's tested contract (CLI 1.2.9, README) is the one to keep until an official schema is published: `PreInvocation` may return `injectSteps[].userMessage`, and `Stop` may return `decision: "continue"`. A July 2026 secondary writeup describes a five-event set (`PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`) derived from Gemini's engine. Treat that as a hint, not a spec. No idle-wake API is claimed.

### Kimi Code

The contract telepathy ships is the plugin manifest: `UserPromptSubmit` appends plain stdout, `Stop` continues on exit code 2 with the reason on stderr (`.kimi-plugin/plugin.json`, `src/hook.ts`). No vendor hook page was found that was clearly Kimi Code rather than a third-party shim. Retest before extending it. There is no wake.

### Pi, Hermes, OpenClaw

Not supported for messaging yet.

Pi's extension API can inject at `before_agent_start` (`{ message }`) and rewrite the message list at `context`. That is next-prompt injection inside the process, the same class as OpenCode, not a remote wake. A community `hook.json` maps Claude event names onto those Pi events; `UserPromptSubmit` `additionalContext` is injected, and a block there is demoted to a context note because Pi has no deny at that boundary. ([pi-hooks package](https://pi.dev/packages/@fyeeme/pi-hooks), retrieved 27 Oct 2026.) The oh-my-pi hook list matches those events. ([oh-my-pi hooks](https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md).)

Hermes and OpenClaw expose tool and LLM lifecycle callbacks in community comparison tables. No primary page was found that shows either one starting a turn from outside the process. Until that exists they stay poll-only, and only once they run the MCP server.

### Goose

Goose has command hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, plus file and shell events. `PreToolUse` and `Stop` can block. A Stop block keeps the turn going and is capped (`GOOSE_STOP_HOOK_BLOCK_CAP`). Every other event, including `UserPromptSubmit` and `PostToolUse`, ignores a block decision, and the published guide does not describe `additionalContext` injection. An open PR proposes that injection and was still open as of 15 July 2026. ([Goose hooks](https://github.com/block/goose/blob/main/documentation/docs/guides/context-engineering/hooks.md), [PR 10361](https://github.com/aaif-goose/goose/pull/10361).) Goose can host ACP agents; that makes Goose a client, not a peer telepathy can attach to. A Goose adapter would be Stop-continuation plus poll, until the advise-tier PR lands and is retested.

### Amp

Amp plugins run in-process and can append a user message. `thread.append` and `thread.appendUserMessage` add a user message; `steer: true` prefers it when the thread is busy. `agent.end` may return `{ action: "continue", userMessage }` and start another turn, default cap 5 plugin continuations. `agent.start` may append hidden context to the user message that just started the turn. None of this runs unless the plugin is loaded in that thread, and it cannot see a thread that has not loaded the plugin. ([Plugins](https://ampcode.com/docs/customize/plugins), [Plugin API](https://ampcode.com/docs/plugin-api), retrieved 27 Oct 2026.)

Amp orbs can register a webhook that stores an event and wakes the orb. The webhook body is untrusted and must not be treated as agent instructions. That is a reasonable notification rung for cloud Amp, not for a local CLI session. ([Event-driven orbs](https://ampcode.com/docs/orbs/event-driven).)

`amp-acp` exists so ACP clients can reopen Amp threads. Same constraint as the other adapters: the ACP client is whoever spawned the process.

### Cline

File hooks include `TaskStart`, `TaskResume`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`. `contextModification` is documented as text for a later model call. It was dropped on the floor for non-cancelling `TaskStart` and `UserPromptSubmit` hooks until VS Code 4.1.20, which injects it as hidden `<hook_context>` on the same turn. ([File-hook examples](https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md), [hooks guide](https://github.com/cline/cline/blob/8a6441fd/.clinerules/hooks/README.md); the bug and the fix are [cline#13554](https://github.com/cline/cline/issues/13554), comment 24 Sep 2026.) There is no API to start a task that is sitting idle because a file changed. Cline is next-prompt injection once the installed version is new enough, otherwise poll.

### Continue

Continue CLI merged a Claude-shaped hook runner on 4 Mar 2026 ([continuedev/continue#11029](https://github.com/continuedev/continue/pull/11029)). The internal agent notes list command and HTTP handlers, exit 0 to proceed and exit 2 to block, and `hookSpecificOutput`. Prompt and agent hook types were not implemented yet. Config merges `.continue/` and `.claude/` settings. A docs issue for a public hooks page was still open on 6 Mar 2026 ([#11115](https://github.com/continuedev/continue/issues/11115)). The February 2026 survey that said Continue had no hooks is stale. Treat current Continue CLI as next-boundary, same class as Copilot, and retest a release before adding a manifest. Nothing in that PR starts a turn while the CLI is idle. The IDE product is a separate surface. This pass did not find an inject API for it.

### Factory Droid

Droid hooks are Claude-shaped. `UserPromptSubmit`, `SessionStart`, and `PostToolUse` can return `hookSpecificOutput.additionalContext`. `Stop` can `decision: "block"` and continue. `Notification` fires for `idle_prompt` among other types, which is the same trap as Copilot: the event runs when Droid goes idle, not when telepathy writes a file. Config is `~/.factory/hooks.json` and `.factory/hooks.json`. ([Factory hooks](https://docs.factory.com/harness/hooks), [hooks reference](https://factory.mintlify.app/reference/hooks-reference), retrieved 27 Oct 2026.) Next-boundary only. Not a peer until someone ships a manifest and a live send.

### Kiro CLI

Kiro CLI V3 hooks use PascalCase triggers in `.kiro/hooks/*.json`. `UserPromptSubmit` cannot reject the prompt. A non-zero exit is forwarded to the agent as context. `Stop` cannot reject with exit 2, but exit 1 or `{"decision":"block","reason":"..."}` asks for another turn. Command actions receive JSON on stdin. Agent actions "inject a prompt into the current conversation", which is still inside a turn Kiro already started. ([V3 hooks migration](https://kiro.dev/docs/cli/v3/hooks-migration/), [Hooks](https://kiro.dev/docs/hooks/), retrieved 27 Oct 2026.) Next-boundary. No idle wake found.

### Crush

Crush ships 13 hook events, including `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `TurnStart`, and `TurnEnd`. Native stdout uses `context` (a string or a list) to append text to a tool result, plus `decision`, `updated_input`, and `updated_output`. Exit 2 blocks a tool. Exit 49 halts the turn. The Claude-compat parser drops `hookSpecificOutput.additionalContext`. An open issue filed 19 Jun 2026 shows the field is never copied onto `HookResult.Context`, while the native `context` field is. ([Crush hooks](https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md), [crush#3156](https://github.com/charmbracelet/crush/issues/3156).) A Crush adapter must emit `context`, not the Claude envelope telepathy uses everywhere else. That is a new `HookShape`, not a config alias. No idle-wake event in the 13.

### Aider

Aider has no tool hooks. `--watch-files` wakes Aider when a one-line comment ending in `AI!` or `AI?` appears in a watched file. Conventions load as read-only context. There is no session id, no MCP server in the default product, and no way to hand it a telepathy message except by writing a file it is already watching or by the user typing. ([Watch files](https://aider.chat/docs/usage/watch.html), [options](https://aider.chat/docs/config/options.html), retrieved 27 Oct 2026.) Out of scope until Aider grows a prompt API. Writing `AI!` comments into the user's repo to fake one is not an adapter.

### Zed

Zed is an ACP client. External-agent threads spawn a new agent process through the registry (Claude Code, Codex, Copilot CLI, OpenCode, Gemini CLI, and others as of the 28 Jan 2026 registry post). Zed does not attach its UI to a terminal session that is already running. Thread import restores a stored session into Zed; it does not share a live TUI. ([External agents](https://zed.dev/docs/ai/external-agents), [ACP registry](https://zed.dev/blog/acp-registry).) A Zed thread is addressable only if the agent process inside it is itself a telepathy peer (the spawned Claude, Codex, …). Zed-the-editor is not a row in `list_peers`.

## MCP is not a wake channel

The 28 July 2026 spec revision is explicit.

- Resource subscriptions are client-opened. The client sends `subscriptions/listen`, and the server may then emit `notifications/resources/updated` or list-changed notifications. The spec says the host decides whether resource data ever reaches a model. It does not say the host must start a turn. ([Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources).)
- `notifications/message` and `notifications/progress` are request-scoped. They ride the response stream of the request that opted in. They are not a side channel that can poke an idle session. The HTTP GET stream is gone. Server-initiated sampling, elicitation, and roots no longer arrive as free-standing requests on that stream; they are embedded in an `InputRequiredResult` while a client request is in flight. ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), changelog in [SEP notes](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx).)
- Sampling (`sampling/createMessage`) is deprecated (SEP-2577). New implementations should call a provider API themselves. Even where a client still honors it, sampling is a nested completion during some other request, with a human-in-the-loop recommendation. It is not "append this to the user's session". ([Sampling](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling).)
- Elicitation asks the user a question (form or URL) during a tool call. Using it to deliver an agent-to-agent message would put another agent's text in a dialog the user thinks is from the tool, and it only works while a tool call is open. Do not use it. ([Elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).)

Logging and roots are deprecated in the same revision. Telepathy's server advertises tools only (`src/server.ts`). Keep it that way.

Tasks moved out of the core spec into the extension `io.modelcontextprotocol/tasks` (SEP-2663, final, created 27 Apr 2026). A server may return a task handle from `tools/call`. The client polls `tasks/get`. That is a slower poll, not a wake. The events extension (SEP-3415, draft PR opened 5 Oct 2026) sketches `events/list`, poll, a long-lived stream, and signed webhooks so a client can hear about an upstream event while the user is away. It is not accepted. The working group's charter still describes callback semantics as in progress. ([SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663), [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), [charter](https://modelcontextprotocol.io/community/working-groups/tasks-events).) Do not block the ladder on it. If it lands later, it is one more `direct` adapter for clients that both advertise the extension and turn an event into a turn. The spec, even drafted, only delivers the event to the client.

A harness issue from the same period states the gap cleanly: notifications stop at the client, and "the notification → agent-activity seam is a harness concern" that nobody owns yet. ([strands-agents/harness-sdk#3600](https://github.com/strands-agents/harness-sdk/issues/3600).) Telepathy should not wait for that seam. Hooks, monitors, and native queues already are it.

## ACP is not a uniform attach transport

ACP `session/prompt` sends a user message to a session on an agent the client spawned. Baseline content is text and resource links. In v1 the response arrives when the turn finishes. The v2 prompt RFD (initial draft 13 Apr 2026, failure-reporting revision 1 Oct 2026) changes the response to mean "the user message was inserted", and it sketches agents that emit session updates without a user prompt. That is the agent talking to its own client. It is not a third process injecting into a TUI. ([Prompt request](https://agentclientprotocol.github.io/typescript-sdk/types/PromptRequest.html), [v2 prompt lifecycle](https://agentclientprotocol.com/rfds/v2/prompt).)

Stdio ACP is one client, one agent. Unofficial multiplexers (`acp-multiplex`, `acp-mux`) proxy that one process to several frontends. They require the agent to have been launched under the proxy. They cannot grab a Claude or Codex the user started in a terminal.

So "telepathy as an ACP client that injects into every running session" fails the riskiest assumption in this task:

- The user's TUI already owns stdin.
- Zed, JetBrains, and `gemini --acp` spawn a new process; they do not attach.
- Codex's real inject API is app-server, which telepathy already speaks, not ACP.
- OpenCode's real inject API is the plugin session bus.
- An ACP proxy that sat in front of every prompt would see every user message, which is a larger trust boundary than `~/.telepathy` and would mean launching agents through telepathy. That is a different product.

ACP remains useful as an optional adapter for a harness whose only programmatic prompt API is ACP **and** that telepathy itself spawned (a future headless mode). It is not rung 1 of the default ladder. No local spike is included. A spike would need those CLIs installed and would restate the stdio rule.

## Capability matrix

"Today" is what this repo does. "Platform" is the best rung the vendor's current docs support, even if telepathy does not use it yet. Poll is always available as long as the MCP server or the native tools are loaded; the Poll column is the rung you land on when the better ones are missing.

| Harness | Direct inject, today | Wake idle, today | Notification, today | Poll only, today | Best platform rung, unused or partial |
|---|---|---|---|---|---|
| Claude Code TTY | Monitor line into a turn | Yes | The monitor line is the notification | If no monitor and no hooks | Inbox socket since v2.1.224, same wake as `SendMessage`, and it honors `crossSessionInbound`. Payload line after auth was not in the page excerpt retrieved here |
| Claude app / stream-json | Waiter exit, or hooks | Yes, once the model has started the one-shot waiter | Waiter completion | Until the waiter runs | Same |
| Codex | `codex queue` plus mid-turn hook | Yes, unless interrupted | Queue is silent | If queue submit fails | `turn/steer` while busy; `Stop` continuation exists and is intentionally unused |
| OpenCode 2 | `session.prompt` steer | Yes | No | If the plugin is not loaded | HTTP steer/queue |
| OpenCode 1 / Kilo CLI | `promptAsync` when idle | Yes, when idle | No | If the plugin is not loaded | — |
| Copilot CLI | Hook context / Stop block | No | `notification` hook cannot be triggered by us | Between turns, if hooks did not run | `copilot --acp` can `session/load` a disk session. v1.0.19 still refuses two live writers |
| Gemini CLI | `BeforeAgent` / `AfterTool` / `AfterAgent` | No | `Notification` hook is status only | While idle | `gemini --acp` only for a process we spawned |
| Qwen Code | Same hook family | No | No | While idle | ACP sessions treat hook `ask` as deny |
| Grok CLI | `PostToolUse` / `Stop`, after the model starts `monitor` | Yes, after that monitor starts | Monitor lines | Before the monitor, and on the next typed prompt (`UserPromptSubmit` drops stdout) | Internal ACP session actor; do not attach from outside |
| Grok Bot MCP client | No | No | No, until the other change lands | Yes | Reserved. See that change |
| Devin CLI | Hook context / Stop block | No | No | While idle | Plugin hooks fail open |
| Antigravity CLI | `injectSteps` / Stop continue | No | No | While idle | Official schema not found |
| Cursor CLI | `postToolUse` `additional_context` | No | No | While idle, and at turn end on the build that skips plugin `stop` | `followup_message` documented, not observed on CLI 2026.09.23 |
| Kimi Code | Prompt stdout / Stop exit 2 | No | No | While idle, and between tools (no PostToolUse) | Vendor page not found; retest |
| Hermes, OpenClaw | No | No | No | Yes, if the MCP server is up | No primary inject API found |
| Pi | No | No | No | Yes, if the MCP server is up | In-process `before_agent_start` |
| Amp | No | No | No | Not a peer yet | In-process `appendUserMessage`; orb webhook is notify-then-read |
| Goose | No | No | No | Not a peer yet | `Stop` can continue; prompt hooks do not inject until PR 10361 lands |
| Cline | No | No | No | Not a peer yet | `contextModification` on the next prompt, VS Code ≥ 4.1.20 |
| Continue CLI | No | No | No | Not a peer yet | Claude-shaped hooks merged 4 Mar 2026. Public docs issue still open that day. Next prompt, not idle wake |
| Factory Droid | No | No | No | Not a peer yet | `additionalContext` on prompt and tool hooks. `Stop` can continue. `idle_prompt` notification is not our wake |
| Kiro CLI V3 | No | No | No | Not a peer yet | `Stop` `decision: block` continues. `UserPromptSubmit` cannot reject. Agent actions inject into a turn already running |
| Crush | No | No | No | Not a peer yet | Native `context` field injects. Claude `additionalContext` is dropped ([crush#3156](https://github.com/charmbracelet/crush/issues/3156)) |
| Aider | No | No | No | Not a peer | `--watch-files` is a file convention, not a session API |
| Zed | No | No | No | Not a peer | Client of other agents; those agents can be peers |

## Architecture

One bus, one delivery function, thin adapters. The inbox stays the source of truth. Adapters do not grow their own queues.

```
 send_message / native tool
        │
        ▼
 ┌──────────── core bus (already) ────────────┐
 │ rate limit, duplicate window, inbox file,  │
 │ archive, formatAsUserTurn / formatForContext│
 └──────────────────┬──────────────────────────┘
                    │ recipient peer record
                    ▼
 ┌──────────── deliver(peer, message) ────────┐
 │ walk the ladder, stop at the first accept  │
 └──────────────────┬──────────────────────────┘
                    │
     ┌──────────────┼──────────────┬──────────────┐
     ▼              ▼              ▼              ▼
  direct         native         hook          poll
  adapter        queue          manifest      (inbox
  (in-proc       (Codex         (static,      left
   or RPC)        app-server)    pull)         unread)
```

There is no new machine-wide daemon in the first cut. `send_message` already runs inside the sender's process and can call the recipient's adapter before returning, which is what Codex does now. A daemon is justified only when the inject API is a socket the sender cannot open (a long-lived broker holding OpenCode HTTP credentials, or an ACP process telepathy spawned). Starting one preemptively splits the claim logic across two processes for no current harness.

### Adapter contract

Every harness implements the same attempts. Each attempt returns one of `accepted`, `unsupported`, or `failed` plus a sentence the sender can show. The bus, not the adapter, writes the inbox, applies the rate limit, and formats the body. The adapter never invents a second message id.

```ts
type Attempt = "accepted" | "unsupported" | "failed";

interface DeliveryAdapter {
  id: string; // matches Agent in src/core/agents.ts
  /** Start a turn now, or steer one that is running. May claim the inbox. */
  direct(peer, message): Promise<{ result: Attempt; detail?: string }>;
  /** Hand the bytes to a queue the harness itself drains. Inbox copy stays. */
  enqueue(peer, message): Promise<{ result: Attempt; detail?: string }>;
}
```

Hooks are not methods. They are pull, declared in the harness manifest, and they call `claimInbox` when they run. `deliver` does not invoke them. It only decides whether to tell the sender "a hook will pick this up" (`nextTurnHook` and `hookRan`, as today) or "poll".

Rules every adapter follows:

1. Claim by rename, or do not claim. If a direct call fails after a claim, the message is already archived and `read_messages` must still show it. OpenCode does this today. Do not "unclaim" by copying back.
2. At most one success path presents the body as a turn. Codex's queue-plus-inbox pair is the pattern: the hook or `read_messages` deletes the queue item when it claims.
3. The body that hits the model is `formatAsUserTurn` or `formatForContext`, including the `[telepathy]` header and the reply address. Adapters do not reword it.
4. Do not raise the recipient's permission mode, answer a permission prompt, or call `thread/queue/start` after the user interrupted a turn.
5. Identity is the peer id the registry already uses (`<agent>-<pid>`, or `<agent>-<session id>` where one process hosts many sessions). Grok Bot's push work must use that id or explicitly extend `sessionPeerId`. A second id space will split inboxes.

Adding a harness is then:

- an `AgentSpec` row (process match, whether a next-turn hook exists),
- a manifest (hooks, MCP server, skill) whose stdout shape is one of the shapes in `SHAPES` in `src/hook.ts`,
- an adapter whose `direct` and `enqueue` return `unsupported` unless that harness has a real API,
- a line in the matrix above, updated only after a live send.

Hook stdout shapes stay in one table. Today they are already centralized (`hookSpecificOutput.additionalContext`, Copilot's flat `additionalContext`, Cursor's `additional_context` and `followup_message`, Antigravity's `injectSteps`, Kimi's plain stdout / exit 2). A new harness that speaks one of those shapes needs no TypeScript. A new shape is a new `HookShape`, not a new bus.

### Fallback ladder

For one message, in order, stop at the first accept:

1. **Direct**, if the recipient has a live injector: OpenCode/Kilo plugin, a running Claude monitor or waiter (the inbox write is enough; the watcher claims), a running Grok `monitor`, a future Grok Bot push adapter, an in-process Amp or Pi adapter.
2. **Native queue**, if the harness drains one: Codex `thread/queue/add` / `codex queue`. While a regular turn is in flight, prefer `turn/steer` when it is wired, and still keep the inbox copy so a hook can win the race and delete the queue item.
3. **Next-boundary hook**, if `nextTurnHook` is set and a hook has run at least once for this process: leave the inbox. Status: visible at the next prompt, tool result, or turn end, and not while idle.
4. **Poll**: leave the inbox. Status: only `read_messages`. The using-telepathy skill already tells the model to say so when `read_messages` returns something the hooks never handed over.

Notification is not its own rung. A monitor or webhook that starts a turn is rung 1. A notification that merely asks the model to call `read_messages` is rung 4 with a louder status string. Do not add a side channel that duplicates the inbox.

Interrupted Codex stays on rung 2 and does not fall through to a synthetic `thread/queue/start`. The user stopped that session. The sender is told, as today.

### What not to build

- A telepathy ACP proxy in front of every CLI.
- MCP resource subscriptions, sampling, or elicitation as the wake signal.
- A long-polling MCP tool that holds the model's turn open. It burns the tool timeout and blocks the session the message is supposed to interrupt.
- Per-harness copies of the rate limit, the archive, or the `[telepathy]` header.
- Writing `AI!` comments, fake user prompts on disk, or clipboard keystrokes. The accessibility bridge some people use to drive the Grok Bot desktop app is a different product and is out of scope here.

## Risks

**Prompt injection between agents.** A message is rendered as a user turn for Codex, OpenCode, and any future `appendUserMessage` or `session/prompt`. Hooks inject it beside the user's prompt or a tool result, which models treat as instructions. The header says another agent wrote it, and the guide says not to do what the recipient's own permissions would block or what its user declined. That is a label, not a sandbox. Keep it. Do not also pass the sender's permission mode, transcripts, or tool results unless the user asked. Claude's native path has `crossSessionInbound`; telepathy skips that hold (README, Privacy). A direct adapter must not become a way around a harness that has since added an equivalent hold.

**Loops.** Two agents that auto-reply will ping-pong. The duplicate window and the 20-per-10-minutes cap are necessary and not sufficient: a rephrased reply is a new hash. Stop-continuation makes it worse, because each side's `Stop` hook starts another turn without a person. Caps already exist on the other side of some adapters (Cursor default 5, Amp default 5, Goose `GOOSE_STOP_HOOK_BLOCK_CAP`, Copilot cloud job timeout). The bus should grow a hop count in the message record, separate from the rate limit: after N automatic replies in a chain (propose 4, matching a round trip plus one confirmation each way), further sends in that chain require the text to be a user's, or they fail with a sentence the model can show. Do not implement that in this change. `stop_hook_active` must keep meaning "do not ask again if the inbox is empty", which it already does.

**Consent and trust.** Codex will not run a hook until `/hooks` trusts that exact command. Grok project hooks need `/hooks-trust`. Devin plugin hooks fail open, which is the opposite problem: a broken hook looks like poll-only with no error. Claude monitors run unsandboxed at hook trust. A direct adapter that calls `codex queue` or `session.prompt` does not show the recipient's user a separate approval, because the harness thinks the prompt came from its own API. The status string and the `[telepathy]` header are the disclosure. Any new direct adapter has to be opt-in by installing the plugin, never by scanning the process table and attaching.

**Message storms.** `list_peers` plus a fan-out is one model call away. The per-recipient cap does not bound a sender that messages every peer. A later change can add a per-sender cap across recipients. Adapters must not retry `failed` by falling through to a second inject; fall through only on `unsupported`. A `failed` Codex queue must not also be presented by a Stop hook as a second turn unless the inbox claim says it was never shown.

**Double delivery.** Already the subtle bug. Codex queue and inbox, monitor and hook, `read_messages` and a later Stop. The claim rename is the lock. New push (Grok Bot) has to claim or to share the claim. If it delivers without claiming, the next hook will show the message again.

**Wrong session.** One process, many chats, is already called out for Grok's dashboard, Copilot's background sessions, and Antigravity subagents: they share a pid address, and whichever chat runs its hooks next receives the message. Direct inject is only safe where the harness names a session id (Codex thread, OpenCode session, Amp thread). Pid-scoped adapters must stay on the hook/poll rungs. The Grok Bot push work should not invent a pid-wide wake if several chats share the process.

**Stale experimental APIs.** `thread/queue/*` is experimental. Plugin monitors are experimental. Grok's hook stdout rules changed after the short docs page was written. Adapters should treat `unsupported` and a clear error as success of the ladder (fall through), not as a reason to shell out to a second undocumented flag.

**ACP and MCP confusion.** A future contributor will be tempted to "just subscribe". The sections above are the reason not to. Sampling and elicitation in particular look like injection and are the wrong direction: sampling asks the client to run a model, elicitation asks the user a question.

## Phased rollout

Each phase is shippable alone. None of them bumps the release by itself; the repo's rule is to bump when the plugin contents change, because agents cache by version.

**Phase 0.** This document.

**Phase 1.** Extract `DeliveryAdapter` around the current Codex queue and the current inbox write. `direct` for Claude is "inbox write, listener claims". `direct` for OpenCode stays inside the plugin, which already watches the inbox; the sender does not call into OpenCode. Behavior and status strings stay. Tests in `test/integration.test.ts` already drive hooks, the monitor, the OpenCode plugin, and a fake `codex queue`; point them at the adapter.

**Phase 2.** Two inject gaps that vendor docs already name, each behind a live test.

Codex mid-turn: call `turn/steer` when the peer is busy and the app-server accepts it, and keep `thread/queue/delete` so a hook that got there first does not steer a duplicate. Do not call `thread/queue/start` on an interrupted thread. Retest an interrupted TUI. The README's Esc quirk is load-bearing.

Claude inbox socket: when the recipient's environment has `CLAUDE_CODE_MESSAGING_SOCKET`, post there instead of relying on the monitor, and let `crossSessionInbound` hold or refuse. The monitor stays the fallback when the socket is missing. Copy the post-auth payload from the current docs page into a test before shipping. A wrong line would look like a successful connect and deliver nothing.

**Phase 3.** Grok Bot push lands in the other change, as the Grok Bot `direct` implementation of this contract. This phase is coordination, not code in this note: one claim, the existing formatter, the existing rate limit, the existing peer id. Grok CLI's monitor-tool path stays the CLI adapter. Do not replace it with the Bot mechanism unless they are the same process.

**Phase 4.** Hook-only harnesses stay hook-only. Fill gaps that are config, after a live retest, not before:

- Cursor CLI: confirm whether a current build runs plugin `stop`. If it does, `followup_message` is already the continuation. If it does not, delete the dead hook rather than documenting a wake that never fires.
- Grok CLI: do not add `UserPromptSubmit` expecting `additionalContext` to stick. The guide says it will not.
- Copilot: leave `notification` unused. It cannot see our inbox.
- Kimi and Antigravity: retest against current CLIs before adding events. Antigravity has no stable public schema.

**Phase 5.** New peers, one adapter each, only after a live send on a named version: Amp (`appendUserMessage`), Pi (`before_agent_start`), Goose (`Stop` continuation, poll while idle), Cline (next prompt, VS Code at least 4.1.20), Continue CLI (Claude-shaped hooks, retest because the public docs page was still an open issue), Factory Droid (same envelope as Claude), Kiro CLI V3 (`Stop` block), Crush (native `context`, not `additionalContext`). Aider and Zed-the-editor stay out. Zed-hosted Claude or Codex is already a peer if that process loads telepathy.

**Not a phase.** ACP proxy. Reopen only if a harness ships a supported multi-client attach that works on a process the user started without telepathy. The v2 RFD does not.

## Open questions

- Should the hop cap count only `Stop`-driven continuations, or every `send_message` whose triggering turn was itself a telepathy delivery? The second is safer and will false-positive when a person asked the agent to "tell Codex and then reply with what it said".
- Codex `turn/steer` versus waiting for `PostToolUse`: steering mid-tool-call was observed by others to work during a long shell, but a steer that lands after the model has committed to its final text is dropped with a successful write. The adapter needs `expectedTurnId` (or the app-server's equivalent error) and must fall back to the queue when steer returns "not steerable".
- Grok Bot session identity. If the push work addresses a chat inside a shared process, the registry's pid id is wrong for it. Settling that belongs in that change; this note should be updated in the same PR so the matrix does not keep two meanings of `grok`.
- Cursor IDE versus Cursor CLI. The docs describe the IDE and the CLI together. Telepathy's live test was the CLI. The IDE extension is already listed as unsupported because one process hosts many chats.
- Claude `crossSessionInbound`. The monitor path skips it. The documented inbox socket does not. Phase 2 should switch Claude delivery to the socket where the socket exists, so hold and refuse apply without telepathy reimplementing them. Until that payload is copied from the docs into a test, this stays open.
- Antigravity and Kimi vendor docs. Both adapters are repo-tested and under-documented upstream. They should not gain new events until a primary page or a fresh live test says the stdout shape still works.
- Goose PR 10361. If it merges, Goose moves from "Stop continues, prompt hooks are blind" to "next prompt can carry context". Recheck before writing a manifest.

## Prior art worth copying, and worth not copying

Worth copying: Claude's labeled cross-session messages, the accept/hold/refuse switch, and the inbox socket those messages already use; Codex's queue plus an explicit delete so two paths cannot both win; OpenCode's `steer` versus `queue` distinction; Amp's continuation cap.

[open-agent-bridge](https://github.com/kevinArgueta96/open-agent-bridge) is the closest working system read for this pass. Its README says Claude delivery writes `CLAUDE_CODE_MESSAGING_SOCKET` (Claude Code at least 2.1.224), Codex delivery calls the app-server daemon socket (Codex at least 0.162), OpenCode and pi start turns from an in-process plugin over a private Unix socket, and Antigravity starts turns with `SendUserCascadeMessage` after the agent runs a one-time attach because the language server wants a CSRF token that hooks and MCP servers do not get. The Claude and Codex halves match vendor docs retrieved the same day. The Antigravity method and the CSRF claim are README statements. This pass did not read that repository's source. Copy the shape (one bus, one native door per harness). Do not copy an unreviewed Antigravity client.

[hcom](https://github.com/salemaziel/hcom) is hooks in front of Claude, Gemini, Codex, and OpenCode, with a local SQLite log. It claims mid-turn inject and idle wake. That is telepathy's existing ladder, plus transcript and terminal observation this design does not take. Watching another session's screen is a surveillance feature, not delivery.

[agent-chat-mcp](https://github.com/RLabs-Inc/agent-chat-mcp/) injects on the next `UserPromptSubmit` and calls that push. It is rung 3. [agent-inbox](https://github.com/salimfadhley/agent-inbox) is a mailbox with issued ids and HTTP clients. Poll, unless a hook is added outside the project.

Worth not copying: accessibility-driven typing into a desktop app. A webhook doorbell that wakes a Grok Bot which then polls, except as that other change's fallback if it cannot land inside the client. Crush's Claude-compat path, until `additionalContext` is actually delivered.

## Sources

Primary pages, retrieved 27 October 2026 unless the row names an older date:

- Claude Code hooks, plugins (monitors), cross-session messaging, Agent SDK sessions and Python reference: `code.claude.com/docs`
- Codex app-server README and queue commit `9341b38` (13 Aug 2026), hooks at `learn.chatgpt.com/docs/hooks`, issue #11415 (Feb 2026), `codex-acp`
- Gemini CLI hooks reference and ACP mode; Qwen Code hooks
- OpenCode v2 plugin server docs and `specs/v2/session.md`
- GitHub Copilot hooks reference
- Cursor hooks, third-party hooks, CLI changelog (January 2026)
- Devin CLI hooks, lifecycle hooks, plugins
- Grok Build `10-hooks.md` and `20-background-tasks.md`; `docs.x.ai` hooks page (updated 2 Jul 2026) and background tasks
- MCP spec 2026-07-28: resources, streamable HTTP, sampling, elicitation, changelog (SEP-2575, SEP-2577)
- ACP schema (`session/prompt`), v2 prompt RFD (revised 1 Oct 2026), Zed external agents, Zed ACP registry post (28 Jan 2026)
- Amp plugin API; Goose hooks guide and PR 10361 (open as of 15 Jul 2026); Cline issue 13554 (fix reported 24 Sep 2026); Aider watch-files
- This repo: `src/core/deliver.ts`, `src/core/messages.ts`, `src/core/codex-queue.ts`, `src/hook.ts`, `src/monitor.ts`, `src/opencode.ts`, `src/server.ts`, and the per-harness manifests listed above

Second pass, same day, added:

- Claude Code inbox socket and `crossSessionInbound` behavior on that socket (cross-session messaging page, release v2.1.224)
- Copilot ACP server reference, changelog 0.0.410, issue 1767 (live co-editing still unsupported as of the 7 Apr 2026 maintainer comment)
- Grok Bot routines (22 Oct 2026), bot-to-bot handoff, inference hooks, Grok automation webhooks (17 Aug 2026)
- Continue CLI hooks PR 11029 (merged 4 Mar 2026) and docs issue 11115
- Factory Droid hooks reference
- Kiro CLI V3 hooks migration
- Crush hooks README and issue 3156 (19 Jun 2026)
- MCP tasks SEP-2663 (final) and events SEP-3415 (draft, opened 5 Oct 2026)
- open-agent-bridge, hcom, and agent-inbox READMEs

Not searched, and named so a reader does not treat silence as a finding: no Slack, Linear, Notion, Datadog, or Sentry workspace is connected to this run. GitHub and the public docs above are the record. Vendor claims that were only in a third-party README are labeled as that. The Antigravity `SendUserCascadeMessage` call is one of those.
