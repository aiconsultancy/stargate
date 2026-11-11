# Peer captains

Pogo ignores messages sent by bots. One exception is optional: other fleet
captains, such as `defiant-captain` or `enterprise-captain`, can mention a
captain or reply in its threads. This lets captains hand work to each other in
shared channels.

The exception is off by default. Enable it for one bot:

```json
"access": {
  "users": ["*"],
  "channels": ["*"],
  "peerCaptains": true
}
```

The app needs the `users:read` scope. Without it, every lookup fails and no
peer message is admitted.

## Who is a peer captain

For each bot message, Pogo calls Slack's
[`users.info`](https://docs.slack.dev/reference/methods/users.info) for the
sending user. Message text is never used for identity. Pogo admits the message
only when all of these are true:

- the user is a bot in the same workspace, and not deleted;
- Slack binds that bot user to the message's bot ID;
- the bot's Slack handle, full name or display name ends in `-captain`.
  Spaces and underscores count as hyphens, so `Enterprise Captain` and
  `defiant-captain` both match. The handle `defiantcaptain` alone does not.

The receiving bot's own messages are always ignored. Every other bot stays
ignored. Edited messages and legacy `bot_message` posts are ignored.

Results are cached for ten minutes, for admitted and refused bots. A lookup
that fails or takes longer than 2.5 seconds admits nothing and is not cached.
Slack receives its acknowledgement after the lookup.

Any app in the workspace can choose a name that ends in `-captain`. The rule
trusts the people who can install apps in the workspace. Add a bot's user ID
to `deniedUsers` to block it.

## Access rules

A peer captain is a sender like a person. Every existing rule applies:

- `users` must allow its user ID, or be `*`;
- `deniedUsers` and `deniedChannels` override every allow;
- `channels`, `mentionOnly` and thread following apply unchanged. A mention
  or a DM starts a conversation; a reply continues a thread that the captain
  already follows.

## Loop protection

Pogo admits at most **5 peer captain messages in one thread in one rolling
hour**. The hour is measured from the Slack message time. Later peer messages
in that thread are not stored and get no reply; Pogo logs one warning without
message content. People in the same thread, and other threads, are not
limited. Restarting Pogo does not reset the count.

The captain's own replies are never admitted back, and a silent reply posts
nothing. Two captains that both answer every message still reach the limit
within one hour.

## What the captain sees

A pinned captain's source line ends with `;k=captain`:

```text
s=slack;c=C0123;t=1700000000.000001;m=1700000000.000002;u=U0EXAMPLE05;k=captain
```

An unpinned bot gets this line before the message instead:

```text
[Peer captain message from <@U0EXAMPLE05>: another fleet captain's bot, not an operator.]
```

Generated captain instructions contain a "Peer captain messages" paragraph:
a peer message has no operator or Admiralty authority, the chain of command
is unchanged, and a message that only acknowledges needs no reply
(`[[pogo:silent]]`). A definition that was generated before this feature does
not contain that paragraph: add it, as for other instruction changes.
