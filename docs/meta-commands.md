# Captain-addressed meta commands

In an allowed Slack conversation, mention one captain bot and put the command
after its mention:

```text
@your-captain /help
@your-captain /config
@your-captain /config waiting 3
@your-captain /config waiting off
@your-captain /config mutes
```

These are ordinary Slack messages, not app-owned slash commands such as
`/stargate`. The gateway handles them before it stores a captain job. They do
not create a captain turn or make a backend request, including when the backend
is unavailable. Replies stay in the message's thread.

## Commands

| Command after the mention        | Result                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/help`                          | Lists commands from the same table that dispatches them.                                                                           |
| `/config`                        | Lists supported settings and their current values.                                                                                 |
| `/config waiting <seconds\|off>` | Sets the waiting-response delay. Whole seconds from 0 to 3600 are accepted; `off` disables it. Zero means immediate, not disabled. |
| `/config mutes`                  | Reads this bot registration's saved thread and channel mutes. It changes no mute.                                                  |
| `/config system1 on`             | Reserved: replies `not available yet (NET-1709)`.                                                                                  |
| `/config system1 off`            | Reserved: replies `not available yet (NET-1709)`.                                                                                  |

The reserved System One commands do not enable a filter or route a message to
a decision model. Missing or invalid values reply `valid values: on, off`.
There are no long-form aliases. Both `/help` and `/config` list the supported
syntax from the same command table.

The waiting command uses the same private workspace override as the existing
captain tool, not another copy of the setting. See [waiting responses](waiting.md)
for workspace sharing, supported OpenCode registrations and the effect on
subsequent turns. Each command change records its time, Slack user and message
reference. Its reply names the old value, new value and person who changed it.

## Access and refusal

The configured app, workspace, user and conversation checks still apply. Denies
take precedence over wildcard allows. Only an allowed human can use a meta
command; another captain's bot cannot, even when ordinary peer chat is allowed.

The bot's mention must be the first token after leading whitespace. Its next
non-space character must be `/`, followed by a word matching `[a-z][a-z-]*`
and then whitespace or the end of the message. An unknown command word, setting
or invalid value gets short local usage guidance, never a model prompt.

Paths such as `@your-captain /api/health is down` and `@your-captain /tmp/foo`
are ordinary chat, not commands. So are later-slash requests such as
`@your-captain please run /config later` and messages that mention another bot
first. Quoted, code or forwarded text before or around the mention remains
ordinary quoted chat with unchanged text; it never changes a gateway setting.
An actual meta command must address only one bot.
`!config` is not an alias. These commands do not change access lists, credentials,
models, permissions or IRC settings.

## Slack payload evidence

Slack's [app mention reference](https://docs.slack.dev/reference/events/app_mention)
shows the bot mention as `<@BOT_ID>` inside `event.text`; direct messages use
`message.im`, not `app_mention`. The [slash command guide](https://docs.slack.dev/interactivity/implementing-slash-commands)
documents a separate command-first invocation and payload. The parser accepts
ordinary `message` and `app_mention` payloads with whitespace or newlines between
the mention and command.

Tests use those event shapes. No desktop or mobile client capture was made for
`@bot /config` in this change, so client-specific composer rewriting remains
unverified. A payload that does not match the addressed-command form does not
gain configuration authority.
