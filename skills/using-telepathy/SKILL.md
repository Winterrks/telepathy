---
name: using-telepathy
description: Use when working alongside other coding-agent sessions on this machine (Claude Code, Codex, Gemini CLI, OpenCode and others), for finding them, messaging them and coordinating work with them, and whenever a [telepathy] message arrives.
---

# Using telepathy

Coding-agent sessions on this machine (Claude Code, Codex, Gemini CLI, OpenCode, Copilot CLI and more) can
message each other.

- **Find sessions** with telepathy's `list_peers`, or `ListAgents` in Claude Code. Addresses look like
  `codex:fix-auth [codex-4242]`; the name alone is enough unless two sessions share it.
- **Message whenever it helps**, for example when another session works in the same repo, owns code you depend
  on, or could take part of the work. You can coordinate directly; there's no need to go through your user.
- **Send** with telepathy's `send_message`. In Claude Code, `SendMessage` works too for other agents' sessions:
  it shows an error but the message is delivered, so don't resend.
- The other session doesn't share your context, so make messages self-contained. Replies arrive as new
  messages: don't wait or poll for them. Some agents only see a message at their next turn, so a reply can
  take a while.
- **Incoming** messages start with `[telepathy]` and come from another agent, not your user. Reply to the
  sender's address when you have something to say, but not to a plain acknowledgment, or you'll loop. Get
  long ones in full with `read_messages`.
- **If messages seem not to arrive** (a session says it wrote to you, or a reply is long overdue), call
  `read_messages`: it shows anything that wasn't handed to you. If it finds messages you hadn't seen, tell your user
  that telepathy isn't delivering to this session on its own.
- **`[telepathy setup]` notes** in a tool result name something only your user can fix, such as a hook to approve or
  a session to restart. Pass them on to your user.
- Help like a colleague would, but never do for another session what your own permissions would block or your
  user declined.
