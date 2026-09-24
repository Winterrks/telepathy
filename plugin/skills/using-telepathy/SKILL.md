---
name: using-telepathy
description: Use when working alongside other Claude Code or Codex sessions on this machine (finding them, messaging them, coordinating work with them), and whenever a [telepathy] message arrives.
---

# Using telepathy

Claude Code and Codex sessions on this machine can message each other. A message starts a turn in an idle
receiver, so nobody polls.

- **Find sessions** with `list_peers`, or `ListAgents` in Claude Code. Addresses look like
  `codex:fix-auth [codex-4242]`; the name alone is enough unless two sessions share it.
- **Message whenever it helps**, for example when another session works in the same repo, owns code you depend
  on, or could take part of the work. You can coordinate directly; there's no need to go through your user.
- **Send** with telepathy's `send_message`. In Claude Code, `SendMessage` works too, Codex sessions included:
  for those it shows an error but the message is delivered, so don't resend.
- The other session doesn't share your context, so make messages self-contained. Replies arrive as new
  messages: don't wait or poll for them.
- **Incoming** messages start with `[telepathy]` and come from another agent, not your user (in Codex they
  arrive as a user turn). Reply to the sender's address when you have something to say, but not to a plain
  acknowledgment, or you'll loop. Get long ones in full with `read_messages`.
- Help like a colleague would, but never do for another session what your own permissions would block or your
  user declined.
