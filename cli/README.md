# telepathy-cli

The `telepathy` command. The plugin package in the repository root stays `telepathy` and `private`, which is what OpenCode installs from git. This package is the one to publish.

Node 20 or newer. After install, `telepathy --help` lists `update`, `status`, `doctor`, `install`, `config`, `run`, `ps`, and `stop`. Messaging still stays on the machine. `update`, `status`, and the daily auto-update check fetch the version on GitHub.

The version matches the plugin (`0.10.0` until the plugin version changes). One number, so a CLI and the plugin it updates are the same release.
