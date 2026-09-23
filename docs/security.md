# Security

## What this app can reach

Nightshift holds your API keys, and through Claude Code it can run commands and edit files on the machine it is installed on. Treat access to it as equivalent to a shell account.

| Surface | Risk if exposed |
|---|---|
| Web UI and `/v1` | Queue messages, read every conversation, spend your quota |
| Settings (session only) | Read nothing back, but redirect a provider base URL, so treat it as key access |
| Claude Code with **Skip all prompts** | Arbitrary commands in the project folder |
| `data/db.json` | API keys in plain text |

## Deploying safely

1. **Set `APP_PASSWORD`.** The app refuses to bind to anything but localhost without one. Use a long random phrase.
2. **Use HTTPS if it leaves the machine.** A reverse proxy (Caddy, nginx, Cloudflare Tunnel) with `TRUST_PROXY=1`, so the session cookie is marked `Secure`.
3. **Prefer a private network.** Tailscale or WireGuard is safer than a public hostname, and no harder.
4. **Lock down the data folder.** `chmod 700 data`. Keys live there.
5. **Keep permission modes conservative.** "Ask" leaves unattended runs effectively read-only. Use "Skip all prompts" only in a folder you would hand to a stranger, and prefer Docker, where `/workspace` is the only project folder mounted.
6. **Scope API tokens by habit.** One per tool, named, revoked when a tool is retired.
7. **Give ntfy an unguessable topic.** Topic names are the only access control ntfy.sh has.

> [!WARNING]
> `ALLOW_NO_PASSWORD=1` exists for setups where something in front already authenticates every request, such as Cloudflare Access or an authenticating proxy. If you set it because the password was inconvenient, anyone who can reach the port can run commands on your machine.

## How credentials are handled

- The session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` behind HTTPS. It carries an HMAC of the password with a per-install secret, not the password.
- The password and tokens are compared in constant time. A failed sign-in waits 800 ms.
- API tokens are stored as SHA-256 hashes; the plaintext is shown once, at creation.
- Tokens cannot read or change settings, or create other tokens.
- Keys are never sent to the browser. The UI sees only the last four characters.
- Backups leave keys and token hashes out unless you ask for them, and downloading one needs a signed-in session, not a token. A backup with keys is as sensitive as `data/db.json`.
- Imports are parsed without executing anything; zip entries are read by name only, never extracted to paths taken from the archive. Installing a Claude Code session writes only under `~/.claude/projects/`.

## Other hardening in the app

- Uploads are served with `X-Content-Type-Options: nosniff` and a restrictive `Content-Security-Policy`; anything that is not an image, video or PDF downloads as an attachment rather than rendering.
- `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` on every response.
- Uploaded names are stripped of path separators before touching disk.
- Model names, session ids, folders and modes are validated before reaching a command line; the Claude Code prompt goes over stdin, never through a shell.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's **Report a vulnerability** button on the Security tab, or email the address in the repository profile. Include what you found, how to reproduce it, and how bad you think it is. You will get a first reply within a week.
