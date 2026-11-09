# Stop a request

Select **Stop** below your request's live reply or waiting message.
This requests cancellation of that exact request, not the latest request in
the channel. The button works in channels and DM threads. Only the original
requester can use it.

Pogo checks the configured bot/backend identity, Slack app, workspace, user,
channel, thread, and stored preview message. Current user and channel access
rules still apply. Denies override allows. Other users cannot stop your work,
even if the bot allows all users. A stale button cannot stop a later request.

Pogo saves the stop request before it acknowledges the interaction. It then
aborts the request's signal. The built-in adapters first withdraw their own
queued input. They interrupt session execution only when that input was placed:
OpenCode checks history; Pi Durable uses its submission record. Custom adapters
must honour the existing cancellation contract.

The reply becomes a stop notice after the backend call settles. With a
transcript-capable backend (OpenCode), public text that settled before the
stop stays above the notice, and later public replies from the same session
still reach the thread. Pogo reports them; it never submits the request again.
Delivery failures retry the notice, not the agent work. If the process stops
first, startup recovery attempts to interrupt surviving work and delivers the
saved stop notice. Pogo does not delete the session or replay the request.

**Stopping does not undo tool actions. Existing effects may remain.**
An external service or tool can finish before cancellation reaches it.
Check agent state before you send the request again.

The **Stop requested** status is reserved for an accepted requester Stop.
An internal maintenance-monitor failure also stops the turn, but reports
**Agent unavailable**, not a user Stop. The failure does not grant maintenance
permission. Pogo does not replay the request or expose the monitor's raw error.

## Setup

Enable **Interactivity & Shortcuts** for the Slack app with Socket Mode.
The generated Pogo manifest already enables interactivity for `/cron`.
No new slash command, OAuth scope, token, or public HTTP endpoint is needed.
`/cron` commands, modals, and buttons continue to work.

## Limits

- Stop appears only when a live preview or waiting message appears. Fast
  replies can complete before a button appears. If waiting feedback is off
  and the backend does not stream text, there is no Stop button.
- Requests still queued in Pogo have no preview button. There is no channel-wide
  or arbitrary-session stop command. A request waiting behind another request
  cannot be stopped from the other request's button.
- A completed response wins over a later click, even if Slack delivery is
  still pending. Pogo keeps that response instead of replacing it.
- Clicking Stop does not cancel later requests or remove a recurring
  schedule. Use `/cron remove` to stop future scheduled runs.
- Backend interruption after input placement is session-wide. If another native
  turn starts before the interrupt arrives, it can also be stopped. Avoid native
  input in the same session while stopping a placed request.
- Pogo creates an input ID or request key before admission. If the response is
  lost, cleanup uses that exact correlation to withdraw the input or prove its
  placement before interrupting. It never resubmits the prompt for recovery.
  If recovery reads fail, the outcome remains uncertain; check native state
  before retrying. Correlation covers an in-flight attempt, not crash replay.
- Backend interruption is best effort. A failed interrupt or an adapter that
  ignores cancellation can leave work running. The stop notice records the
  request to stop; it does not certify that external work stopped or rolled
  back. Admission can race cleanup: an OpenCode input accepted after its cancel
  request can still run. Live Slack delivery still has its existing retry and
  duplication limits.
