# Text mentions

In a channel, Stargate starts a conversation only when a message mentions the
bot. A post such as "Calling all captains" often tags one captain or none,
so the other captains do not receive it. `access.textMentions` lets a bot
start a conversation when a top-level message names it in plain text.

The setting is off by default. Enable it for one bot:

```json
"access": {
  "users": ["*"],
  "channels": ["*"],
  "textMentions": {
    "channels": ["C0EXAMPLE03", "C0EXAMPLE04"],
    "names": ["captains", "all captains", "Galactica", "Adama"]
  }
}
```

## Rules

- Only a top-level message counts. A thread reply that contains a name does
  not start a conversation; a reply in a thread the bot already follows is an
  ordinary follow-up, as before.
- A name matches as a whole word, in any letter case. Spaces inside a name
  match any whitespace. `captains` does not match `captain`. Names are
  literal: up to 20 names of up to 40 characters.
- Only text that Slack shows counts: a link's label, not its address, and not
  user, channel or group mentions or emoji codes such as `:captains:`.
- `channels` takes channel IDs (`C…` or `G…`). DMs need no mention.
- A typed mention works as before and adds no marker.
- User, channel and deny rules apply unchanged. The bot's own messages are
  never admitted. A bot message is admitted only from a verified peer
  captain, which needs `access.peerCaptains`; the peer captain thread limit
  applies. See [peer captains](peer-captains.md).
- With `mentionOnly`, a named top-level message starts a conversation; each
  later turn still needs a mention.

## What the captain sees

The prompt starts with a marker that holds the configured name that matched.
When several names match, the longest wins:

```text
[Admitted by text mention: all captains]

Calling all captains: who has NET-9?
```

Generated captain instructions contain a "Text mentions" paragraph: reply
only when the content needs an answer, otherwise answer with
`[[pogo:silent]]`, which posts nothing. A definition that was generated
before this feature does not contain that paragraph: add it, as for other
instruction changes.

Every admitted message is one agent turn, also when the captain stays
silent. Broad names such as `captains` admit more messages.

Voice messages use the same name matcher with their own list. See
[spoken mentions](transcription.md#spoken-mentions-in-channels).
