# Contributing

Thanks for helping. Nightshift is small on purpose, and the bar for a change is that it keeps being small, understandable and dependable at 3 AM with nobody watching.

## Setting up

```bash
git clone https://github.com/whereixuezugi/nightshift.git
cd nightshift
npm install
npm run dev        # restarts on file changes
npm test
```

There is no build step. The front end is plain HTML, CSS and JavaScript in `public/`, served as-is.

## The tests

`npm test` runs four suites:

- **`test/parse-limit.test.js`** — unit tests for reading reset times out of limit messages and rate-limit headers.
- **`test/unit.test.js`** — repeats across daylight saving changes, the zip reader and writer, import parsing and Markdown export, without a server.
- **`test/api.test.js`** — starts the real server against mock Anthropic, OpenAI, Gemini and Ollama endpoints (`test/fixtures/mock-providers.mjs`) and a fake Claude Code CLI (`test/fixtures/fake-claude.mjs`), then drives it through the REST API.
- **`test/features.test.js`** — the same harness (`test/fixtures/server.mjs`) for Ollama, every import format, exports, backup and restore, and repeating chains.

None needs network access or API keys. A change to how the queue behaves should come with a test in `api.test.js`; a new limit-message format should come with a line in `parse-limit.test.js`, quoting the real message; a new import format should come with a small sample export in `features.test.js`.

## Where things live

| If you are changing | Look in |
|---|---|
| What a request is allowed to contain | `lib/jobs.js` |
| An endpoint | `lib/api.js`, then `docs/api.md` and `docs/openapi.yaml` |
| When jobs run, retries, chains | `lib/scheduler.js` |
| How one provider is spoken to | `lib/providers/<name>.js` |
| Something every chat provider shares | `lib/providers/chat.js` |
| Claude Code runs and sessions | `lib/providers/claudeCode.js` |
| Whether a provider shows as ready | `lib/readiness.js`, and `probe()` in the adapter |
| Repeating schedules | `lib/time.js`, then `repeatChain()` in `lib/scheduler.js` |
| Reading another app's export | `lib/importers.js` |
| Markdown, JSON and backup output | `lib/exporters.js` |

### Adding a provider

Write an adapter next to the others: `request()` to build the call, `stream()` to read one event, `mapError()` to turn a failure into `limit`, `credit`, `overloaded` or `error` with a reset time when there is one, and `caps` to say which attachments it reads. Optionally, `listModels()` fills the model dropdown and `probe()` lets the app check it is reachable when it needs no key. Register it in `lib/providers/index.js`, add a route to the mock in `test/fixtures/mock-providers.mjs`, and a test. Nothing else in the app should need to change; if it does, that is worth mentioning in the pull request.

## Style

- Two spaces, single quotes, semicolons. `.editorconfig` covers the basics.
- Comments say why, not what.
- Error messages are read by people at odd hours. Say what went wrong and what to do: "run_at is in the past", not "invalid input".
- No new runtime dependency without a good reason in the pull request.

## Out of scope

Automating claude.ai, or any service, through its private web endpoints. It breaks without notice and puts users' accounts at risk under those services' terms.

## Pull requests

Keep them focused. Fill in the template, add a line under **Unreleased** in `CHANGELOG.md`, and make sure CI is green.
