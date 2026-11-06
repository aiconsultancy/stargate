# Initial Slack thread context

Initial thread context is disabled by default. To enable it for one bot, add
this top-level bot setting to the Pogo configuration, then restart Pogo:

```json
"threadContext": true
```

This setting changes no credentials, scopes, access rules, or backend settings.
Existing backend sessions continue unchanged. Custom `SlackDelivery`
implementations can optionally implement `threadContext`; without it, enabled
requests that need history fail before an agent turn starts.

## When Pogo reads history

If the first agent turn starts from a reply in an existing Slack thread, Pogo
reads prior messages in that same channel and thread. It does so only when no
backend session exists for that conversation. Later turns use the existing
backend session and do not read Slack history again. New thread roots and
scheduled runs have no prior messages to import and do not make a history call.
With `threadContext: false`, Pogo makes no thread-history calls.

Pogo persists the accepted request before Slack ACK. The history call occurs
during queued execution, after Pogo checks current user and channel access
again. The call uses the current message timestamp as an exclusive cutoff.
Messages at or after that timestamp are not imported, even if Slack returns
them. Cancellation aborts the history transport and prevents backend execution.

## Included text and limits

Pogo imports only text authored by the requesting user and this bot's own Slack
user. It excludes all other humans and bots, including otherwise allowed users.
It excludes edited, deleted, hidden, file-bearing, attachment-bearing and
non-message events. The only accepted subtype is `bot_message` for this bot's
own user. It does not fetch files, attachments, links, other channels or other
threads. Quoted text inside an eligible message remains untrusted text.

Each initial read makes **one** `conversations.replies` request with a page
limit of **50**. It does not follow pagination cursors. From that page, Pogo
imports up to **20 messages**, in timestamp order, up to **2,000 Unicode
codepoints per message** and **12,000 text codepoints total**. These limits
apply to message text before JSON escaping, not the complete prompt size.
Pogo selects the earliest eligible messages returned on that first page.

The prompt labels imported messages as untrusted JSON reference data. Author
labels are `requester` and `this_bot`, not agent conversation roles. The actual
user instruction follows separately. A `truncated` flag reports a remaining
Slack page or a message/text limit. This is a filtered subset, not a claim that
Pogo read the full thread. If no eligible messages exist and no limit was hit,
the user instruction stays unchanged.

JSON encoding prevents text from breaking the prompt's data structure; it does
not eliminate prompt injection. Keep tool permissions restrictive. Imported
text is sent to the configured backend and can become part of its session
history, like the current user instruction.

## Slack access and errors

Pogo uses the registration's existing bot token and Web API connection. Slack's
[current method contract](https://docs.slack.dev/reference/methods/conversations.replies.md)
lists bot-token history scopes: `channels:history`, `groups:history`,
`im:history`, and `mpim:history`, according to conversation type. Pogo's normal
app setup already requests the first three. This feature does not request
additional scopes or change a live installation. Bot membership and Slack's
visibility rules still apply; a Pogo allowlist does not grant Slack access.

History access, malformed-response, network and rate-limit failures fail closed:
Pogo reports that initial context could not be loaded and starts no agent turn.
It does not silently proceed as if it had read the thread. SDK payloads and
credential details are not logged or returned. Rate-limited calls are not
automatically retried; check Slack access or wait before sending a new request.
Normal reply-delivery retries do not fetch history or run the backend again.
