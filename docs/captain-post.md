# Captain posts

A captain usually answers only in the Slack thread that started its turn.
The captain-only `stargate_post` tool lets it post as its **own bot** to another
allowed channel or thread. Use it instead of asking an operator to relay a
message.

`stargate_post` is off by default. Enable it per bot.

## Enable

1. Bind the captain to its gateway configuration and bot. `stargate_post` uses
   the same non-secret Stargate plugin option as `stargate_cron`; see
   [cron jobs](cron.md#opencode-tool-and-local-cli):

   ```json
   "cron": { "configPath": "/srv/stargate/stargate.json", "bot": "galactica" }
   ```

   `stargate crew init --cron-config PATH --cron-bot ID` writes this binding.
   It does not require file-backed cronjobs.

2. Add `captainPost` to that bot in `stargate.json`:

   ```json
   "captainPost": {
     "channels": ["C0123456789", "C0EXAMPLE01"],
     "fileDirectories": ["/srv/stargate/galactica/captain", "/srv/stargate/proofs"],
     "postsPerHour": 30
   }
   ```

   | Field             | Default                                           | Meaning                                  |
   | ----------------- | ------------------------------------------------- | ---------------------------------------- |
   | `channels`        | Required                                          | Conversation IDs the captain may post to |
   | `fileDirectories` | Captain `backend.directory`, OpenCode scratch dir | Roots for attached files; `[]` disables  |
   | `postsPerHour`    | `30` (1–600)                                      | Admitted posts per bot, rolling hour     |

   Without `fileDirectories`, the OpenCode scratch directory follows
   OpenCode's own rule: `join(os.tmpdir(), "opencode")`. The plugin resolves
   it for each call in the **OpenCode service's** process, so that service's
   `TMPDIR` applies. With `TMPDIR=$HOME/.cache/tmp` it is
   `~/.cache/tmp/opencode`; without `TMPDIR` it is `/tmp/opencode`. Stargate's
   own shell `TMPDIR` has no effect.

   `channels` is a nonempty list of explicit Slack conversation IDs
   (`C…`, `G…` or `D…`). `*` is not accepted. Outbound posting is
   therefore always narrower than inbound access, also when
   `access.channels` is `["*"]`.

3. Run `stargate config check`. `captainPost` requires an OpenCode backend, and
   `captainPost.channels` rejects `*`, names and an empty list.

The bot token must be in the **OpenCode service's** environment or in
`<config>.env`, as for `stargate_cron`. The plugin reads the configuration again
for each post, so a change applies to the next call. It does not need a
gateway restart.

## Tool input

```json
{
  "channel": "C0123456789",
  "thread_ts": "1731490000.000100",
  "text": "Release *1.4* is ready for <@U0123456789>.",
  "files": ["/home/captain/.cache/tmp/opencode/release-notes.pdf"],
  "reply_broadcast": false
}
```

- `channel` (required): a channel ID, not a name.
- `thread_ts` (optional): reply in this thread. Without it, the post is a
  new top-level message.
- `text` (required): Markdown, 1–3000 characters. Stargate formats it like a
  normal reply. `<@U…>` and other Slack mentions pass through.
- `files` (optional): up to 10 absolute paths. Each must be a canonical
  regular file (no symlinks) inside a post directory. The attachment limits
  and denied names from [attachments](attachments.md) apply. Hidden path
  segments are refused below the post directory, not above it: a root such
  as `~/.cache/tmp/opencode` works, but `.git` or `.ssh` inside it does not.
  Stargate uploads files into the thread of the post: the given thread, or the
  new message.
- `reply_broadcast` (optional, default `false`): with `thread_ts`, also show
  the reply in the channel.
- `key` (optional): a retry key. The default is the host tool-call ID.

The result has `status`, `channel`, `ts`, `permalink` when Slack returns one,
and the state of each file.

## Authorization

Every check fails closed. If a check fails, nothing is posted.

- Only the configured root captain session can use the tool. Crew, child
  agents and earlier captain roots are refused. The bound bot must use the
  captain's directory and, when both are pinned, the same session ID.
- The channel must be listed by ID in `captainPost.channels`.
- The channel must also pass the bot's `access.channels`, where `*` matches.
  `deniedChannels` overrides both lists.
- DMs (`D…`) and group DMs are allowed only when their IDs are listed in
  `captainPost.channels`. Inbound `*` never allows a post by itself.
- Stargate needs no Slack lookup and no extra OAuth scope for these checks.
- Tool input cannot change the binding, the configuration path or the bot.

A Slack user or crew message can ask the captain to post. It cannot widen
these rules. The captain decides whether a post is appropriate. It must never
post secrets or private content from another thread.

The bot must be a member of a channel to post there. Otherwise Slack refuses
the post with `not_in_channel`.

## Durability and retries

Stargate records each post in `<dataDirectory>/captain-post.sqlite` (mode `0600`)
before it calls Slack. The record holds the channel, thread, text length,
file metadata, retry key and outcome. It does not hold the message text.

| Status      | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `posted`    | Slack returned a message `ts`. All files are shared.           |
| `partial`   | The message is posted. One or more files are not shared.       |
| `failed`    | Slack refused the post (for example `not_in_channel`).         |
| `uncertain` | The response was lost. The message may or may not be in Slack. |

A call with a key that already has a record returns that record. It does not
post again. For `uncertain`, check the channel before you make a new call.
Stargate never resends an uncertain post. For `partial`, a retry with the same
key resumes files that were not shared. A file with an unconfirmed upload
completion is checked with `files.info`; Stargate never completes it again. A
retry key that belongs to a different post is refused.

One call at a time owns the file uploads of a post. Stargate records the owner
and a five-minute lease in SQLite with a compare-and-set update. Each file
step renews the lease, including the step before the one-shot completion. A
concurrent retry with the same key does not upload: its files show
`in-progress`. When an owner stops without releasing, a retry can take over
after the lease expires. An interrupted upload was never completed, so the
new owner starts it again; an abandoned private Slack upload can remain.

A resumed file is checked again against the current configuration: the
current `fileDirectories` (or default roots), the hidden-path rule below that
root, and the saved size and SHA-256. If its directory is no longer allowed,
the file becomes `unavailable` and is not read. The channel rules are also
checked again on every call, including retries.

This is not exactly-once delivery. Slack has no idempotency key for
`chat.postMessage`.

## Rate limit and audit

Each bot can admit `postsPerHour` posts in any rolling hour. A retry of a
recorded key does not count again. Over the limit, the tool refuses the post
and returns the time when the next post can be admitted.

Each call writes one JSON audit line to the OpenCode service's standard error:

```json
{
  "event": "stargate_post",
  "bot": "galactica",
  "channel": "C0123456789",
  "thread": null,
  "ts": "1731490000.000200",
  "length": 42,
  "files": 1,
  "status": "posted",
  "replay": false
}
```

Audit lines never contain message text, file names or paths.

## Limits

- One message per call, at most 3000 characters.
- No edits, deletes, reactions, scheduled messages or Block Kit input.
- Posts use the plugin host's Slack token directly, not the gateway queue.
  The gateway does not retry them.
- A later human reply in a thread that the bot posted to follows the normal
  routing rules, including `resumeSlackThreads`.
- Existing captain definitions are not overwritten. Add the `stargate_post`
  guidance from `templates/agents/captain.md` to customized definitions.
