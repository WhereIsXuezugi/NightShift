<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="Nightshift" width="280">
</picture>
</div>

# Documentation

Nightshift is a self-hosted scheduler for AI chat messages. You write a message now; it goes out at a time you choose, or the moment your usage limit resets.

### Start here

| Page | What's in it |
|---|---|
| [Getting started](getting-started.md) | Installing with Node or Docker, signing providers in, reaching it from your phone |
| [Configuration](configuration.md) | Environment variables, in-app settings, where data lives |
| [Usage](usage.md) | Providers, the three send modes, chains, editing, attachments, alerts |
| [REST API](api.md) | Tokens, endpoints, webhooks, worked examples |
| [Architecture](architecture.md) | How the queue, the providers and the limit detection actually work |
| [Security](security.md) | The threat model and how to deploy safely |
| [Troubleshooting](troubleshooting.md) | Why a message didn't send, and how to find out |

### In one paragraph

A message you queue becomes a **job**. The scheduler wakes every five seconds, picks the jobs that are due, and runs them one at a time per provider. If a provider answers with a usage limit, the scheduler reads the reset time out of the response, parks every job for that provider behind it, and stops spending requests until then. When a job succeeds, its reply is stored, anything chained behind it is released, and your notification goes out. Nothing is lost if the machine restarts.

### Conventions in these docs

> [!TIP]
> Commands assume the app is at `http://127.0.0.1:8787`. If you set `PORT` or put it behind a proxy, adjust.

`whereixuezugi` in URLs is a placeholder for your GitHub account; replace it after forking or cloning.
