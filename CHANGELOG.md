# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/whereixuezugi/nightshift/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/whereixuezugi/nightshift/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/whereixuezugi/nightshift/releases/tag/v1.0.0
