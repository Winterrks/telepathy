# Security

telepathy runs on your own machines: it sends no telemetry and keeps its state in `~/.telepathy`. Without
`telepathy bridge` or `telepathy grokbot`, its only network calls are version checks and updates.
See [Privacy and security](docs/behaviour/privacy-and-security.md) for what it reads, writes and runs.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/Winterrks/telepathy/security/advisories/new) (the repository's Security
tab). Include the affected version (`version` in `package.json`), the agents involved, and steps to reproduce.
You'll get an answer there; please don't open a public issue for security problems.

Fixes ship in the latest release only.
