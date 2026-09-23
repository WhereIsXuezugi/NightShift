# Getting started

## Requirements

| | Needed for |
|---|---|
| Node.js 20 or newer | Running the app |
| [Claude Code](https://code.claude.com) | The Claude Code provider, which uses your Pro or Max plan |
| ffmpeg | Video frames, and converting oversized or unusual images |
| An API key | Each of the Claude API, OpenAI and Gemini providers you want |
| [Ollama](https://ollama.com) | Local models, with no key |

None of the providers is required. The app runs with whichever ones you set up.

## Install with Node

```bash
git clone https://github.com/whereixuezugi/nightshift.git
cd nightshift
npm install
npm start
```

Open http://127.0.0.1:8787. With no `APP_PASSWORD` set, the app binds to localhost only and does not ask you to sign in.

To run it as a service, a systemd unit is enough:

```ini
# /etc/systemd/system/nightshift.service
[Unit]
Description=Nightshift
After=network.target

[Service]
Type=simple
User=you
WorkingDirectory=/home/you/nightshift
EnvironmentFile=/home/you/nightshift/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now nightshift
```

## Docker

The image ships Node, ffmpeg, git and the Claude Code CLI.

```bash
cp .env.example .env     # set APP_PASSWORD at minimum
docker compose up -d --build
```

| Volume | What it holds |
|---|---|
| `./data` → `/data` | Conversations, the queue, uploads, your keys |
| `claude-home` → `/home/node/.claude` | Claude Code's sign-in and session history |
| `./workspace` → `/workspace` | Projects Claude Code is allowed to work in |

> [!IMPORTANT]
> If `./data` is not writable by the container, run `sudo chown -R 1000:1000 data workspace`.

### Ollama in Docker

Nightshift talks to Ollama natively, with no key. There are two ways to wire it up in Docker.

**Ollama already runs on the host.** Nothing to change: the container reaches it at `http://host.docker.internal:11434`. Ollama listens only on localhost by default, which the container cannot see, so start it with `OLLAMA_HOST=0.0.0.0` (for the systemd service: `sudo systemctl edit ollama`, add `Environment="OLLAMA_HOST=0.0.0.0"` under `[Service]`, then restart it). Keep port 11434 closed in your firewall.

**Run Ollama alongside Nightshift.** Add to `.env`:

```bash
COMPOSE_PROFILES=ollama
OLLAMA_BASE_URL=http://ollama:11434
```

then `docker compose up -d`. Models live in the `ollama` volume. For an NVIDIA GPU, uncomment the `deploy` block in `docker-compose.yml` (it needs the NVIDIA Container Toolkit).

Either way, open **Settings → Ollama**, check it says **Ready**, and pull a model by name. Without Docker, a local Ollama at the default address just works.

## Signing providers in

### Claude Code

Claude Code has its own sign-in, separate from any API key.

**On your own machine:** run `claude` once in a terminal and complete the login. Nightshift then finds your existing sessions in `~/.claude/projects`.

**In Docker:** either

1. run `claude setup-token` on a machine where you are already signed in and put the result in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, or
2. run `docker compose exec -it nightshift claude` and sign in there. It is kept in the `claude-home` volume.

Check it worked: **Settings** reports the Claude Code version it found.

### Claude API, OpenAI, Gemini

Paste a key into **Settings**, or set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` in the environment. Keys set in Settings are saved in `data/db.json`; keys from the environment are used as-is and shown as "from the environment".

> [!TIP]
> The OpenAI provider speaks plain Chat Completions, so any compatible service works: OpenRouter, Groq, Together, vLLM, LM Studio. Point **Base URL** at it and use its model names. For Ollama, use its own provider instead, which needs no key and can pull models.

### Ollama

Install it from [ollama.com](https://ollama.com), then pull a model from **Settings → Ollama** or with `ollama pull llama3.2`. For Docker, see [Ollama in Docker](#ollama-in-docker) above.

## Bringing in your history

Already have months of conversations elsewhere? **Import** in the sidebar reads the data exports of ChatGPT, Claude, Gemini and AI Studio, and Claude Code session files. See [Usage](usage.md#import-export-and-backup).

## Your first scheduled message

1. Pick a provider tab on the left.
2. **New conversation** (or **New session** for Claude Code, where you choose a project folder).
3. Write the message.
4. Choose **When my limit resets**.
5. Send. It appears in the queue, and in the thread as a dashed bubble, until it goes out.

If you are not limited right now, it sends immediately; if the send hits a limit, it parks itself behind the reset and tries again then.

## Getting to it from your phone

The app refuses to listen on anything but localhost unless `APP_PASSWORD` is set. Once it is, pick one:

- **Tailscale or WireGuard** — simplest and safest; the app stays off the public internet.
- **A reverse proxy with HTTPS** — Caddy is two lines:

  ```
  nightshift.example.com {
      reverse_proxy 127.0.0.1:8787
  }
  ```

  Set `TRUST_PROXY=1` so the session cookie is marked secure.
- **Cloudflare Tunnel** — no open ports; put an Access policy in front of it.

Then add ntfy in **Settings** so your phone buzzes when a queued message lands.

## Updating

```bash
git pull
npm install
# restart: systemctl restart nightshift, or
docker compose up -d --build
```

Your data lives in `data/`, which is untouched by updates. The app migrates older data files on start.
