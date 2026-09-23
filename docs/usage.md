# Usage

## The five providers

| Provider | What it uses | Conversations | Files it can read |
|---|---|---|---|
| **Claude Code** | Your Pro or Max subscription, through the `claude` CLI | Its own sessions, in `~/.claude/projects` | Anything on disk; files are handed over by path |
| **Claude API** | An Anthropic API key | Kept by Nightshift | Images, PDFs, text; video as extracted frames |
| **OpenAI** | An OpenAI key, or any compatible service | Kept by Nightshift | Images, PDFs, text; video as frames |
| **Gemini** | A Google AI Studio key | Kept by Nightshift | Images, PDFs, text, audio and short video directly |
| **Ollama** | Models on your own machine, no key | Kept by Nightshift | Images (on vision models), text; video as frames |

Claude Code is an agent: it reads and edits files, runs commands, and keeps working until the task is done. The other four are chat: one message, one reply, with the conversation history kept here.

When you open the app, it lands on a provider that is actually ready: the one you last used if it still works, otherwise one with work in the queue, otherwise the first one that is set up. Each provider in **Settings** carries a status: **Ready**, **Needs a key**, **Not found** (Claude Code) or **Not reachable** (Ollama), and the app rechecks every minute, so starting Ollama or signing in to Claude Code shows up without a reload.

## When to send

Pick one of three modes under the composer.

**Now** — goes out on the next tick, a few seconds away.

**At a time** — pick a date and time in your own timezone. Good for "first thing tomorrow" or for spreading work across a billing period.

**When my limit resets** — if a limit is already known, the message waits for it. If not, it tries now, and parks itself behind the reset if the attempt comes back limited.

The checkbox **"If a limit blocks it, wait for the reset and send then"** applies to the first two modes. Leave it on and a message scheduled for 11 PM survives running into a limit; turn it off and it fails instead of drifting hours later.

### Repeating

Choose **At a time** and a **Repeat** menu appears beside the date: **Every day**, **Every weekday** (Monday to Friday) or **Every week**. The time you pick is the first run and sets the time of day for the rest. (Over the API, `mode: "now"` with a repeat also works, repeating at the current time of day.)

Once a message has run, the next occurrence is queued straight away, as a copy of the whole chain if there are follow-ups. Repeats keep the wall-clock time in your timezone, so a 7:00 message stays at 7:00 across daylight saving changes. If the server was off through several occurrences, it runs once to catch up rather than several times in a row. A repeat that fails still queues the next one, so one bad night does not end it.

For Claude Code, a repeating message in a **new session** starts a fresh session every time; one sent to an existing session keeps resuming it.

**Stop repeating** on the queued message (in the thread or the queue) lets the current one run and queues no more. Deleting or cancelling it stops the series as well.

### The countdown

The header shows one clock per provider. Amber means a limit is in force, with a live countdown and the time it lifts. **Reset now** clears it by hand and releases everything waiting, for when you know the limit is over and would rather not wait for the app to find out.

## Chains: several messages in a row

Write the first message, press **Add follow-up**, write the next, and send. Each message waits for the reply before it, exactly like typing them one at a time.

This is the difference between a chain and three separate messages: a chain is ordered and conditional. If one fails, the rest stop and are marked **Held back** rather than firing into a broken state. Press **Send now** on a held-back message to run it anyway.

Chains work for Claude Code sessions too, including brand new ones: the first message creates the session and the rest resume it.

> [!TIP]
> A chain is the natural shape for overnight work: "run the migration", "then run the tests", "then write the summary". You wake up to three replies instead of one.

## Editing and deleting

Anything not yet sent can be changed. In the thread, a queued message shows **Edit**, **Cancel** and **Delete**; the queue panel shows the same.

- **Edit** loads it back into the composer. Change the text, attachments, model, effort or timing, then **Save changes**.
- Editing something that already failed puts it back in the queue.
- **Delete** removes it and re-links the chain, so a later message follows whatever came before the one you removed.
- **Cancel** stops a message that is sending right now.

## Models, effort and other knobs

**Model** is a dropdown filled from the provider's own model list, so a model released this morning shows up without waiting for an update here. The list is cached for ten minutes; the refresh button next to it fetches it again. Pick **Custom…** to type any name the list does not show, such as a fine-tune or a model behind a gateway. Opening a conversation selects the model it last used.

For Ollama, the list is what you have pulled, with size and quantization. Pull more in **Settings → Ollama**: type a name such as `llama3.2` or `qwen3:8b` and watch the download progress.

**Effort** is the one control that behaves differently per provider, and Nightshift translates it:

| Effort | Claude | OpenAI | Gemini | Ollama |
|---|---|---|---|---|
| minimal | not sent | `minimal` | mapped to `low` | `think: false` |
| low / medium / high | `output_config.effort` | `reasoning_effort` | `thinkingConfig.thinkingLevel` | `think: "low"` … `"high"` |
| extra high | `xhigh` | `xhigh` | mapped to `high` | mapped to `high` |
| max | `max` | mapped to `high` | mapped to `high` | mapped to `high` |

Ollama models that think only on or off get `think: true` instead of a level; models that cannot think at all get nothing.

If a model rejects the setting, the message is sent again without it rather than failing, and the queue card says so.

**Max tokens** caps the reply length on chat providers. **Permissions** applies to Claude Code:

| Mode | What it means unattended |
|---|---|
| Ask | Effectively read-only: nothing to approve the prompts |
| Accept file edits | Edits files, still asks for other tools |
| Plan only | Produces a plan, changes nothing |
| Auto | Approves what its classifier considers safe |
| Skip all prompts | Runs anything. Only in a folder you trust it with |

## Attachments

Drag files onto the composer, paste them, or use **Attach files**. Each chip shows how the file will be read. Video is converted to evenly spaced frames when the provider cannot take it whole, which needs ffmpeg; Gemini reads short clips directly.

Claude Code is the one to use for an odd file type: it gets the path and can open the file with its own tools.

## Copying replies

Every reply has a **Copy** button under it, and every code block has its own in the corner. They work over plain HTTP on your LAN too, where browsers block the modern clipboard API.

## Import, export and backup

### Bring in your history

**Import** in the sidebar takes the official data exports of other apps, as the zip you downloaded or the JSON inside it. Several files at once are fine.

| From | Where to get it | What comes across |
|---|---|---|
| **ChatGPT** | Settings → Data controls → Export data. The link arrives by email | Every conversation on the branch you last saw, with your uploaded images and custom instructions as the system prompt. Tool calls and hidden messages are left out |
| **Claude** | Settings → Privacy → Export data | Messages, artifacts as code blocks, and the text of attached files |
| **Gemini** | [Google Takeout](https://takeout.google.com), with only *My Activity → Gemini Apps* selected | Takeout keeps prompts and replies, not conversations, so prompts less than 30 minutes apart are grouped into one. Adjust the gap in the dialog |
| **AI Studio** | The prompt files in the *Google AI Studio* folder of your Drive | Each saved prompt, with its system instructions |
| **Claude Code** | The `.jsonl` files in `~/.claude/projects/<project>/` | A session, installed so Claude Code can resume it in a folder you pick, or brought in as a plain conversation for another provider |
| **Nightshift** | Its own JSON export or backup zip | Everything, attachments included |

Before anything is written you see what was found: each conversation with its message count and dates, and which ones are **already imported** (those are unticked, so importing the same export twice adds nothing). Choose which provider the conversations belong to; they default to the one they came from. Afterwards you can continue any of them, schedule into them, or switch model.

### Take it out

The **Export** menu in a thread saves that conversation as **Markdown** (readable, with times and models) or **JSON** (complete, with attachments inside). Claude Code sessions also offer the raw **.jsonl** transcript.

**Settings → Import, export and backup** exports every conversation at once, as one JSON file or a zip of Markdown files arranged by provider.

### Backup

**Download a backup** saves everything in one zip: conversations, the queue, settings and attachments, without API keys unless you ask. Drop it into **Import** to restore. See [Configuration](configuration.md#backups) for what is kept and how queued work comes back.

## Notifications

In **Settings**, set a notification URL:

- **ntfy** — `https://ntfy.sh/your-private-topic`, then subscribe on your phone. Pick an unguessable topic name.
- **Discord** or **Slack** — paste the webhook URL; the format is detected.

You get a message when something sends, when it fails, and the first time a limit parks the queue. For a repeating message, it also says when the next one runs. **Allow browser alerts** adds desktop notifications while a tab is open.

## Keyboard

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> | Send or save |
| <kbd>Esc</kbd> | Close the drawers on a narrow screen |
