# Troubleshooting

## A message did not send

Open the queue and read the card. The status line says where it is, and a failure shows the provider's own words.

| What the card says | What it means | What to do |
|---|---|---|
| **Waiting for the limit to reset** | A limit was hit, the reset time is known | Nothing. It goes out then. **Reset now** if you know the limit already lifted |
| **Queued behind an earlier message** | Another message in the same conversation goes first | Nothing, or delete the one in front |
| **Waits for the reply before it** | Part of a chain | Nothing |
| **Held back** | The message before it failed | Fix that one, or press **Send now** to run this one anyway |
| **Failed: no API key** | The provider has no key | Settings |
| **Failed: model not found** | A model name that provider does not have | Clear the model box and pick from the list |

## Claude Code

**"claude wasn't found."** Set the full path in Settings. Find it with `which claude`. In Docker, it is installed in the image, so check the container rather than the host.

**"Invalid API key · Please run /login".** Claude Code is not signed in for the user running Nightshift. Run `claude` as that user, or set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

**No sessions listed.** The app reads `~/.claude/projects`. If Claude Code runs as a different user or with a custom `CLAUDE_CONFIG_DIR`, point `CLAUDE_CONFIG_DIR` at the same folder. Sessions with no user message are skipped.

**A run does nothing and ends.** Unattended runs cannot answer permission prompts, so in "Ask" mode anything that needs approval stops. Use "Accept file edits" for trusted projects.

**A limit message is not recognised.** The queue waits the polling interval instead of the exact reset, so nothing is lost. Please open an issue with the exact line the CLI printed; it takes one regex to fix, and there are tests for the formats already handled.

## Attachments

**"needs ffmpeg".** Video frames and image conversion need ffmpeg on the server. `apt install ffmpeg`, or use the Docker image, which has it.

**"can't be read by this model".** That provider cannot take the file type. Gemini reads video and audio directly; Claude Code can read anything on disk.

**Large uploads fail.** The limit is 1 GB per file. Behind nginx, raise `client_max_body_size`.

## Providers

**OpenAI-compatible gateway returns 404.** The base URL usually needs to end in `/v1`, and the model name has to be that service's own, for example `anthropic/claude-opus-5` on OpenRouter.

**Effort seems ignored.** If a model rejects it, the message is sent again without it and the card says so.

**Ollama says "Not reachable".** Check `curl http://127.0.0.1:11434/api/tags` from where Nightshift runs. In Docker, an Ollama on the host has to listen on `0.0.0.0`, not just localhost; see [Ollama in Docker](getting-started.md#ollama-in-docker). With the bundled service, `OLLAMA_BASE_URL` must be `http://ollama:11434` and `COMPOSE_PROFILES=ollama` set.

**Ollama: "model not found".** The model has not been pulled on that Ollama. Pull it in **Settings → Ollama**, or pick one from the dropdown, which lists only what is installed.

**The model dropdown is empty or old.** Press the refresh button beside it; lists are cached for ten minutes. If the provider cannot be reached, **Custom…** lets you type a name anyway.

**Gemini 429 straight away.** Free-tier quotas are daily as well as per-minute. The card shows the retry delay Google reports.

## Import and export

**"Nothing importable found".** Upload the zip exactly as the service sent it, or the `conversations.json` inside. For Gemini, Takeout must include *My Activity → Gemini Apps*; the *Gemini* folder alone holds only Gems. Very large exports are fine up to 8 GB.

**A ChatGPT conversation looks shorter than in the app.** Only the branch you last viewed is imported; edited-away branches are skipped, as are tool calls and hidden messages.

**Imported the same export twice.** Conversations already imported are detected and skipped, so nothing is duplicated.

**A restored message did not send.** Queued work from a backup comes back cancelled on purpose. Open it and press **Send now**, or edit its time.

## The app itself

**It refuses to start:** `Refusing to listen on 0.0.0.0 without APP_PASSWORD`. Set a password, or bind to `127.0.0.1`. This is deliberate; see [Security](security.md).

**"Sign in required" in a loop.** The cookie needs HTTPS to be marked secure behind a proxy. Set `TRUST_PROXY=1` and make sure the proxy passes `X-Forwarded-Proto`.

**Times are wrong.** Reset times such as "3am" are read in the server's timezone. Set `TZ` to yours; in Docker, add `TZ` to `.env`.

**Everything vanished after an update.** Check `DATA_DIR`. If `db.json` could not be parsed it is kept as `db.json.corrupt-<timestamp>` next to it, and the app starts fresh rather than refusing to boot.

## Digging deeper

```bash
# what the server is doing
journalctl -u nightshift -f          # or: docker compose logs -f

# what the queue thinks
curl -s localhost:8787/v1/jobs -H "Authorization: Bearer $TOKEN" | jq '.[] | {prompt, status, lastError, nextAttemptAt}'

# whether the providers are reachable
curl -s localhost:8787/v1/providers -H "Authorization: Bearer $TOKEN" | jq '.[] | {id, ready, limit}'

# reproduce the tests
npm test
```

If none of this explains it, open an issue with the job JSON (with the prompt removed if it is private), the provider, and the server log around the attempt.
