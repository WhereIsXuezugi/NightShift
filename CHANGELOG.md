# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.0] - 2026-09-23

### Added
- **Ollama** provider, native and keyless, with model pulls from Settings (live progress), `think` mapped from the effort control, and a hint to pull a model that is missing. Docker Compose reaches an Ollama on the host, or runs one alongside with `COMPOSE_PROFILES=ollama`.
- **Model picker**: a real dropdown per provider, filled from its model list (cached ten minutes), with a refresh button and a **Custom…** option.
- **Import** from the official data exports of ChatGPT, Claude, Gemini (Takeout) and AI Studio, from Claude Code session files, and from Nightshift's own exports. Zip or JSON, with a preview, per-conversation selection, and skipping of anything already imported.
- **Export** any conversation as Markdown or JSON, a Claude Code session also as raw `.jsonl`, or everything at once.
- **Backup and restore** in one zip, attachments included and keys only on request.
- **Repeating schedules**: every day, every weekday or every week, DST-safe, whole chains included, with **Stop repeating**.
- **Copy** buttons on replies and on code blocks, working over plain HTTP too.
- Provider readiness: status per provider in Settings, rechecked every minute and pushed live, and a first screen that opens on a provider that is actually ready.
- `.env.example` and `.gitignore`.
- API: `GET /v1/conversations/{id}/export`, `GET /v1/sessions/{id}/export`, `GET /v1/export`, `POST /v1/import` (with preview and commit), `repeat` and `timezone` on messages, `status_note` and `key_optional` on providers, `?refresh=true` on models.

### Changed
- A later message scheduled in the same thread no longer holds up follow-ups that are due now.
- The OpenAI provider's hint no longer suggests Ollama, which has its own provider.

## [2.0.0] - 2026-09-21

### Added
- **OpenAI** provider, over Chat Completions, so OpenRouter, Groq, Together, vLLM, LM Studio and Ollama work through a base URL.
- **Gemini** provider, reading images, PDFs, audio and short video directly.
- **Message chains**: queue several messages in a row, each sent after the reply before it. A failure holds back the rest instead of sending them into a broken conversation.
- **Edit and delete** queued messages: text, attachments, model, effort and timing. Deleting re-links the chain.
- **REST API** at `/v1`, used by the web app itself, with API tokens, per-message webhooks, long polling (`?wait=`), and server-sent events. Documented in `docs/api.md` and `docs/openapi.yaml`.
- Base64 uploads, for scripts that would rather not build multipart requests.
- A shared effort control, translated to each provider's own setting, with an automatic retry without it when a model refuses.
- Reset times read from OpenAI's duration headers and Gemini's `RetryInfo`.
- `/healthz` for Docker and uptime checks.
- Logo, bundled fonts (no third-party requests), full documentation, and CI.

### Changed
- The Claude API provider id is now `anthropic`. Data from 1.x, which used `api`, is migrated on start.
- Provider keys and base URLs are set per provider in Settings.
- The provider layer is split into one shared runner and a small adapter per provider.

### Security
- API tokens are stored as SHA-256 hashes, shown once, and cannot change settings or manage tokens.

## [1.0.0] - 2026-09-18

### Added
- Schedule messages to Claude Code and the Claude API, now, at a set time, or when a usage limit resets.
- Reset-time parsing for Claude Code limit messages and Claude API rate-limit headers.
- Resuming existing Claude Code sessions, with their history shown in the app.
- Attachments, including video as frames.
- ntfy, Discord, Slack and browser notifications.
- Password protection, and a refusal to listen on the network without one.
- Docker image with Claude Code and ffmpeg.

[Unreleased]: https://github.com/whereixuezugi/nightshift/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/whereixuezugi/nightshift/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/whereixuezugi/nightshift/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/whereixuezugi/nightshift/releases/tag/v1.0.0
