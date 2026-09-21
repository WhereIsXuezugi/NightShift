# Usage

## The four providers

| Provider | What it uses | Conversations | Files it can read |
|---|---|---|---|
| **Claude Code** | Your Pro or Max subscription, through the `claude` CLI | Its own sessions, in `~/.claude/projects` | Anything on disk; files are handed over by path |
| **Claude API** | An Anthropic API key | Kept by Nightshift | Images, PDFs, text; video as extracted frames |
| **OpenAI** | An OpenAI key, or any compatible service | Kept by Nightshift | Images, PDFs, text; video as frames |
| **Gemini** | A Google AI Studio key | Kept by Nightshift | Images, PDFs, text, audio and short video directly |

Claude Code is an agent: it reads and edits files, runs commands, and keeps working until the task is done. The other three are chat: one message, one reply, with the conversation history kept here.

## When to send

Pick one of three modes under the composer.

**Now** — goes out on the next tick, a few seconds away.

**At a time** — pick a date and time in your own timezone. Good for "first thing tomorrow" or for spreading work across a billing period.

**When my limit resets** — if a limit is already known, the message waits for it. If not, it tries now, and parks itself behind the reset if the attempt comes back limited.

The checkbox **"If a limit blocks it, wait for the reset and send then"** applies to the first two modes. Leave it on and a message scheduled for 11 PM survives running into a limit; turn it off and it fails instead of drifting hours later.

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

**Model** is a free text box with suggestions loaded from the provider, so a model released this morning works without waiting for an update here.

**Effort** is the one control that behaves differently per provider, and Nightshift translates it:

| Effort | Claude | OpenAI | Gemini |
|---|---|---|---|
| low / medium / high | `output_config.effort` | `reasoning_effort` | `thinkingConfig.thinkingLevel` |
| extra high | `xhigh` | `xhigh` | mapped to `high` |
| max | `max` | mapped to `high` | mapped to `high` |

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

## Notifications

In **Settings**, set a notification URL:

- **ntfy** — `https://ntfy.sh/your-private-topic`, then subscribe on your phone. Pick an unguessable topic name.
- **Discord** or **Slack** — paste the webhook URL; the format is detected.

You get a message when something sends, when it fails, and the first time a limit parks the queue. **Allow browser alerts** adds desktop notifications while a tab is open.

## Keyboard

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> | Send or save |
| <kbd>Esc</kbd> | Close the drawers on a narrow screen |
