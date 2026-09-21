# Security policy

## Supported versions

Only the latest release gets fixes.

| Version | Supported |
|---|---|
| 2.x | Yes |
| 1.x | No |

## Reporting a vulnerability

Please don't open a public issue. Use **Report a vulnerability** on this repository's Security tab, which opens a private advisory.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a first reply within a week, and credit in the release notes if you'd like it.

## Scope

In scope: anything that lets someone without the password or a valid token read conversations, queue messages, reach settings, or run commands through Claude Code; token or session handling; path traversal through uploads; injection into the Claude Code command line.

Out of scope: what a signed-in user can do on purpose (they can already run Claude Code), deployments that set `ALLOW_NO_PASSWORD=1` without authenticating in front, and denial of service by someone who is already signed in.

See [docs/security.md](docs/security.md) for how to deploy safely.
