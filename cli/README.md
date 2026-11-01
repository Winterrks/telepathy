# telepathy-cli

The `telepathy` command. The plugin package in the repository root stays `telepathy` and `private`, which is what OpenCode installs from git. This package is the one to publish.

Node 20 or newer. After install, `telepathy setup` installs telepathy in every agent CLI it finds, approves telepathy's own hooks where the agent has a command for it, and installs the Claude Code and Codex ACP adapters. `telepathy --help` lists the rest: `update`, `status`, `doctor`, `install`, `config`, `run`, `ps`, `stop`, `bridge` (sessions on your other devices) and `grokbot` (a Grok Bot routine webhook as a session). Messaging stays on your machines. `update`, `status`, and the daily auto-update check fetch the version on GitHub.

The version matches the plugin (`0.11.0` until the plugin version changes). One number, so a CLI and the plugin it updates are the same release.
