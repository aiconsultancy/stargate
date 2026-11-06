# Stop a request

Select **Stop** below your request's live reply or waiting message.
This requests cancellation of that exact request, not the latest request in
the channel or the whole backend session. The button works in channels and
DM threads. Only the original requester can use it.

Pogo checks the configured bot/backend identity, Slack app, workspace, user,
channel, thread, and stored preview message. Current user and channel access
rules still apply. Denies override allows. Other users cannot stop your work,
even if the bot allows all users. A stale button cannot stop a later request.

Pogo saves the stop request before it acknowledges the interaction. It then
aborts the request's signal. The built-in OpenCode adapter explicitly
interrupts server-side execution; Pi Durable aborts its conversation. Custom
adapters must honour the existing cancellation contract.

The reply becomes a stop notice after the backend call settles. Delivery
failures retry the notice, not the agent work. If the process stops first,
startup recovery attempts to interrupt surviving work and delivers the saved
stop notice. Pogo does not delete the session or replay the request.

**Stopping does not undo tool actions. Existing effects may remain.**
An external service or tool can finish before cancellation reaches it.
Check agent state before you send the request again.

## Setup

Enable **Interactivity & Shortcuts** for the Slack app with Socket Mode.
The generated Pogo manifest already enables interactivity for `/cron`.
No new slash command, OAuth scope, token, or public HTTP endpoint is needed.
`/cron` commands, modals, and buttons continue to work.

## Limits

- Stop appears only when a live preview or waiting message appears. Fast
  replies can complete before a button appears. If waiting feedback is off
  and the backend does not stream text, there is no Stop button.
- Queued requests have no preview button. There is no channel-wide or
  arbitrary-session stop command. A request waiting behind another request
  cannot be stopped from the other request's button.
- A completed response wins over a later click, even if Slack delivery is
  still pending. Pogo keeps that response instead of replacing it.
- Clicking Stop does not cancel later requests or remove a recurring
  schedule. Use `/cron remove` to stop future scheduled runs.
- Backend interruption is best effort. A failed interrupt or an adapter that
  ignores cancellation can leave work running. The stop notice records the
  request to stop; it does not certify that external work stopped or rolled
  back. Live Slack delivery still has its existing retry and duplication
  limits.
