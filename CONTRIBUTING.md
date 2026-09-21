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

`npm test` runs two suites:

- **`test/parse-limit.test.js`** — unit tests for reading reset times out of limit messages and rate-limit headers.
- **`test/api.test.js`** — starts the real server against mock Anthropic, OpenAI and Gemini endpoints (`test/fixtures/mock-providers.mjs`) and a fake Claude Code CLI (`test/fixtures/fake-claude.mjs`), then drives it through the REST API.

Neither needs network access or API keys. A change to how the queue behaves should come with a test in `api.test.js`; a new limit-message format should come with a line in `parse-limit.test.js`, quoting the real message.

## Where things live

| If you are changing | Look in |
|---|---|
| What a request is allowed to contain | `lib/jobs.js` |
| An endpoint | `lib/api.js`, then `docs/api.md` and `docs/openapi.yaml` |
| When jobs run, retries, chains | `lib/scheduler.js` |
| How one provider is spoken to | `lib/providers/<name>.js` |
| Something every chat provider shares | `lib/providers/chat.js` |
| Claude Code runs and sessions | `lib/providers/claudeCode.js` |

### Adding a provider

Write an adapter next to the others: `request()` to build the call, `stream()` to read one event, `mapError()` to turn a failure into `limit`, `credit`, `overloaded` or `error` with a reset time when there is one, and `caps` to say which attachments it reads. Register it in `lib/providers/index.js`, add a route to the mock in `test/fixtures/mock-providers.mjs`, and a test. Nothing else in the app should need to change; if it does, that is worth mentioning in the pull request.

## Style

- Two spaces, single quotes, semicolons. `.editorconfig` covers the basics.
- Comments say why, not what.
- Error messages are read by people at odd hours. Say what went wrong and what to do: "run_at is in the past", not "invalid input".
- No new runtime dependency without a good reason in the pull request.

## Out of scope

Automating claude.ai, or any service, through its private web endpoints. It breaks without notice and puts users' accounts at risk under those services' terms.

## Pull requests

Keep them focused. Fill in the template, add a line under **Unreleased** in `CHANGELOG.md`, and make sure CI is green.
