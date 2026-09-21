# Configuration

Settings come from three places, in order of precedence: what you save in **Settings** (kept in `data/db.json`), then environment variables, then built-in defaults.

## Environment variables

### Service

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to bind. Anything other than localhost requires `APP_PASSWORD` |
| `DATA_DIR` | `./data` | Where the database, uploads and the session secret live |
| `APP_PASSWORD` | none | Password for the web UI. Required for non-local binds |
| `ALLOW_NO_PASSWORD` | unset | Set to `1` only if something else in front already authenticates. Read [Security](security.md) first |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy, so HTTPS detection and client IPs work |
| `TZ` | system | The timezone used to read reset times such as "resets 3am" |

### Providers

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Claude API key |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | For gateways and proxies |
| `OPENAI_API_KEY` | none | OpenAI key, or the key of any compatible service |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Point at OpenRouter, Groq, vLLM, Ollama and so on |
| `GEMINI_API_KEY` | none | Google AI Studio key |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | For gateways |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `CLAUDE_CWD` | your home folder | Default project folder for new Claude Code sessions |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps sessions, read for the session list |
| `CLAUDE_CODE_OAUTH_TOKEN` | none | Claude Code sign-in for headless servers, from `claude setup-token` |

### Notifications

| Variable | Default | Meaning |
|---|---|---|
| `NOTIFY_URL` | none | ntfy topic URL, or a Discord or Slack webhook |

## In-app settings

| Setting | Default | Notes |
|---|---|---|
| API key and base URL, per provider | from the environment | A key you paste replaces the environment one |
| Path to the claude command | `claude` | Settings shows the version it found |
| Default project folder | home | Where new Claude Code sessions start |
| Stop a run after | 60 min | Long agent runs are killed past this |
| Send this many seconds after a reset | 90 | A cushion, since a provider's clock is not yours |
| When the reset time is unknown, check every | 15 min | Used when a limit arrives with no reset time |
| Notification URL | none | Test it with the button next to it |
| API tokens | none | For the [REST API](api.md). Shown once, stored hashed |

> [!TIP]
> Set the reset cushion to 0 if you want the first request out the instant the clock flips, and expect the occasional wasted retry.

## Files on disk

```
data/
  db.json          conversations, queue, settings, hashed API tokens
  .secret          random value that signs the session cookie, mode 0600
  uploads/<id>/    one folder per attachment, plus cached video frames
  tmp/             in-flight uploads
```

`db.json` is written atomically: a temporary file, then a rename. If it is ever unreadable, the app backs it up as `db.json.corrupt-<timestamp>` and starts fresh rather than refusing to boot.

> [!CAUTION]
> `db.json` holds your API keys in plain text. Keep the folder to your own user (`chmod 700 data`), and keep it out of backups that others can read.

## Removing data

- One conversation: **Edit** in the thread header, then **Delete conversation**.
- Finished queue items: **Clear finished** in the queue panel.
- Everything: stop the app and delete `data/`.
