# Running Stargate

## Using the gateway

Mention a Slack bot in an allowed channel to start a conversation. Reply in
its thread to continue. Allowed direct messages can start a session without a
mention. For IRC, see [requests and replies](irc.md#access).

| Task                                                                          | Guide                                                                                                      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Paste a text snippet, attach a file, or let an agent publish a requested file | [Attachments](attachments.md)                                                                              |
| Cancel a running request, adjust feedback, or opt out of a reply              | [Cancellation](cancellation.md), [waiting feedback](waiting.md), [silent replies](setup.md#silent-replies) |
| Schedule prompts or import earlier thread context                             | [Scheduled prompts](cron.md), [thread context](thread-context.md)                                          |
| Enable text-name triggers or accept trusted peer captains                     | [Text mentions](text-mentions.md), [peer captains](peer-captains.md)                                       |
| Configure voice messages                                                      | [Transcription](transcription.md)                                                                          |
| Inspect queue, sessions, or crew without starting work                        | [Dashboard](dashboard.md), [session history](session-history.md), [crew activity](crew-activity.md)        |
| Read provider quota or pair OpenCode devices                                  | [Usage](usage.md), [device pairing](pairing.md)                                                            |
| Read gateway settings or change a captain's waiting delay without a turn      | [Captain-addressed meta commands](meta-commands.md)                                                        |
| Switch installed global OpenCode child-agent profiles                         | [Profile switching](agents/agent-profiles.md#switch-an-installed-profile)                                  |
| Let a trusted captain send a message to another approved conversation         | [Captain posts](captain-post.md)                                                                           |

## Follow-up steering

Follow-up steering is optional and defaults to off. For one Slack registration,
set the flag inside its existing `slack` object:

```json
{ "steerThreadFollowUps": true }
```

For IRC, set `irc[].features.steerThreadFollowUps` on the receiving ship. Both
settings use the same gateway behaviour; enabling one does not enable the other.
Changing configuration follows the normal restart-only configuration policy.
Merging this feature does not enable it in an installed captain.

When enabled for a pinned OpenCode captain, an admitted text follow-up in the
exact thread of its running turn can reach that turn at its next safe point.
It does not start a second captain job. A reaction marks an accepted Slack
steer. The running turn replies in its original thread and includes references
to the steered messages.

A different thread or DM remains in the existing queue. A short queue notice
explains that it is waiting behind another request. Idle captains retain normal
turn admission. Stop buttons, local meta commands and clarification controls
retain their own handling; they are never converted to steering input.
An active maintenance drain also queues follow-ups instead of extending the turn.

If native steering is definitely refused, for example while a form or permission
prompt is pending, the follow-up goes into the normal queue with a notice.
An ambiguous write is not proof of refusal: it must not create a duplicate
queued turn. Check the retained outcome before retrying. Message redelivery
must not repeat a native steer or captain job. External notices and reactions
do not have exactly-once delivery guarantees.

Unpinned sessions retain ordinary admission. Steering does not grant access or
mix conversations. User/channel admission, bot rejection, exact native input
ownership and current turn checks still apply. Unsupported attachments or
adapters use ordinary queue admission rather than dropping content.
An acknowledgement means native admission, not proof
that the model has read or acted on the follow-up.

The OpenCode SDK does not offer an atomic expected-input condition for steering.
Stargate checks the current native input and local ownership immediately before
the write, but a native turn change between that check and write remains possible.

## Inbound Slack reactions

`bots[].slack.inboundReactions` defaults to `false`. Enable it separately for
each registration, after the owner has applied the
[Slack manifest additions](setup.md#receiving-reactions-on-bot-messages).
Changing the flag uses the normal restart-only configuration procedure.
Merging code neither enables it nor changes a live Slack app.

Stargate delivers `reaction_added` and `reaction_removed` on messages posted
by this bot, from people and channels admitted by its existing access rules.
Only these Slack emoji names are admitted:

| Meaning     | Slack names                            |
| ----------- | -------------------------------------- |
| Thumbs up   | `+1`, `thumbsup`                       |
| Thumbs down | `-1`, `thumbsdown`                     |
| Tick        | `white_check_mark`, `heavy_check_mark` |
| Cross       | `x`                                    |
| Eyes        | `eyes`                                 |

The gateway first uses its persisted posted-message records to resolve the
thread. If no record exists, an exact `reactions.get` lookup must confirm the
same bot's authorship and return the target's thread. Unverified or unavailable
targets are ignored. `users.info` verifies the human actor; its `users:read`
scope is required even when the target is already stored locally. Registrations
that require a mention on every message also ignore reactions, which cannot
contain a mention. Ordinary notification mutes apply.

Stargate supplies the reacting person's `u=` identity, reaction name, whether
it was added or removed, and target message timestamp. It does not decide that
a reaction means approval or rejection. The receiving agent uses the existing
conversation context to interpret it.

For example, an added thumbs-up can carry
`s=slack;c=C123;t=1.000;m=2.000;u=U123;reaction=%2B1;action=added`.
Here `m=` names the bot message, not a new human message.

Reactions use the same durable admission path as follow-up messages. An idle
session receives a new turn. With `slack.steerThreadFollowUps` enabled, an
eligible reaction in the running turn's exact conversation can steer that
turn; otherwise it remains queued. Duplicate events and Slack retries do not
repeat accepted delivery. This does not promise exactly-once external effects.
Queued or uncertain reaction follow-ups receive the same short status notice
as text follow-ups. Removing a reaction can also produce that notice.

## Linux user service

Maintenance can opt into a [restart drain](maintenance.md#restart-drain) with
`maintenance.drain.enabled` (default off). It queues advance context, holds new
work in the existing queues, waits for idle or its deadline (default ten
minutes), and reports remaining work before restarting. `/health stargate`
shows the drain phase and outcome. This is separate from approval to install
or restart services; merging code does neither.

After verifying a foreground run, stop it and run these commands from the
Stargate directory. Run them as the user who will own the service:

```sh
bun run src/main.ts service install --config /absolute/path/to/stargate.json
systemctl --user enable --now stargate.service
systemctl --user status stargate.service
journalctl --user -u stargate.service -f
```

No `sudo`. Installation writes `~/.config/systemd/user/stargate.service` and reloads
systemd; it does **not** enable or start the service. The unit uses absolute
Bun/entrypoint paths, config-directory working directory, private umask, and
the optional config companion as `EnvironmentFile`. Keep the checkout and
the Bun executable in place. Reinstall the unit after moving either.

User services normally start at login. For operation after logout or before
login, ask your administrator about `loginctl enable-linger "$USER"`.
Do not assume your shell's exported variables reach systemd: use the private
companion file or configure the user-service environment explicitly.

### Boot-time network failures and connection readiness

Socket Mode and `auth.test` retry transient DNS and network failures with
exponential backoff (1 second initially, capped at 30 seconds) for up to
10 minutes per outage. Each Socket Mode attempt has a 30-second connection
deadline and must receive Slack's `connected` event; a resolved SDK `start()`
alone does not establish readiness. Authentication/permission errors are not
retried. Reconnects use the same bounded owner after a later disconnect.
The SDK's separate reconnect loop is disabled to avoid competing retries.
Exhaustion fails startup or stops the running gateway with a non-zero exit,
so `Restart=on-failure` can restart it. Shutdown cancels retries.

Startup removes the previous `ready.json` after acquiring the instance lock.
The new record is not written before transport connection: Slack registrations
must finish connecting, IRC-only gateways wait for IRC registration, and
Teams listener readiness counts for Teams-only gateways. IRC connection
states are sampled without changing its existing reconnect protocol.
If every transport remains disconnected for 10 minutes, the runtime fails.

`ready.json` records each transport's kind, registration ID and state:
`connecting`, `connected`, `reconnecting`, `failed` or `closed`, with
`transportObservedAt`. States refresh on changes (normally within 250 ms).
`readyAt` remains the original startup time, not a new startup after every
reconnect. Maintenance rejects a new-format record with no connected
transport. `/health stargate` displays the per-transport states and connected
count; older records without the field show unknown. These are the last
observed states, not proof of a currently live process after an abrupt crash.
Normal shutdown records closed connections.

**First upgrade:** older maintenance CLIs strictly decode `ready.json` and
reject the added transport fields. Run the first managed update from this
version's verified release tree or checkout, using its maintenance CLI. An old
nightly CLI could otherwise reject readiness and roll back the upgrade. Keep
the existing managed installer and recovery path; do not change release links
by hand. This upgrade instruction does not authorise a release or installation.

For service ordering, the usual unit hints are:

```ini
[Unit]
After=network-online.target
Wants=network-online.target
```

The generated user unit already includes `After=network-online.target`.
The system's network-online target is not a dependable readiness barrier in
the separate user service manager. Do not rely on adding `Wants` to fix DNS
timing; application retries are the recovery mechanism. A running unit alone
does not prove Slack is connected. Inspect `ready.json`, `/health` from a
working transport, and the sanitised service log.

The remaining examples use the linked `stargate` command. You can substitute
`bun run src/main.ts` from the checkout.

```sh
stargate service stop
stargate service start
stargate service status
stargate service uninstall
```

Use `--name other-stargate` for a separate unit. Separate instances need separate
config/data directories **and separate Slack app registrations**. Do not run
two Socket Mode listeners with the same credentials; Slack can distribute
events between them. One data directory has one process owner, enforced by a
SQLite file lock that the OS releases on exit.

## Nightly maintenance

Opt-in `maintenance.cleanup` removes guarded stale scratch directories,
merged local branches and leaked worktrees. It is disabled by default. Preview
with `stargate maintenance cleanup --plan`; configure literal roots/repositories
before enabling it. Apply uses the maintenance window and idle gate; reports
record each removed or retained item. See [cleanup guards](maintenance.md#opt-in-cleanup).

`stargate maintenance update --version X.Y.Z --now` installs one verified Stargate
release immediately, without the window or the idle gate, as a transient user
unit with automatic rollback; `--plan` shows what it would do. Never create a
release directory by hand. See [update now](maintenance.md#update-now).

Optional and off by default. In a configured window (default 00:00–01:00
Europe/London, with a stable per-install jitter) `stargate maintenance run`
updates Stargate from verified GitHub releases, CLIProxyAPI and the agent CLIs
(one-day supply-chain cool-off), and moves agent profiles and live
captain/crew sessions to newer models of the same family. It waits for an
idle boundary, checks health after every change, rolls back automatically,
and writes a versioned JSON report plus one Slack summary.

```sh
stargate maintenance plan --config /absolute/path/to/stargate.json        # read-only
stargate maintenance install-timer --config /absolute/path/to/stargate.json --print
```

An optional built-in maintenance droid (a Pi Durable agent) explains each
run and escalates problems through the report bot. It can only read
maintenance state and run `plan` or `recover`, within Stargate's limits.

See [nightly maintenance](maintenance.md) for configuration, the install
layout, the report schema, the [maintenance droid](maintenance.md#maintenance-droid)
and the one-time migration.

## Guarantees and limits

- Bot/app/workspace/backend identity separates session namespaces. Ordinary
  bots add channel/thread identity; a pinned captain shares one session across
  its allowed chat sources. Its memory is shared, not a privacy boundary.
- Messages queue in SQLite before Slack acknowledgement. Duplicate deliveries
  and overlapping `message`/`app_mention` events do not run the agent twice.
- Ordinary turns run in order per thread; different threads can run concurrently.
  Captain turns use one FIFO across sources. Each bot defaults to four concurrent
  turns and a 30-minute turn timeout (maximum one hour).
- Replies persist separately from execution; Slack retries do not rerun tools.
  Up to eight delivery attempts use bounded exponential delays.
- A stopped process can leave tool outcomes unknown. On restart, Stargate attempts
  to interrupt surviving work and reports the interrupted request rather than
  automatically running it again. Transcript/session state remains available.
  Pi Durable's task storage does not provide automatic gateway-turn recovery.
- Exactly-once external side effects are **not** guaranteed. A crash after
  Slack accepts a reply but before SQLite records it can duplicate that reply.
- OpenCode thread replies follow a durable per-thread message cursor. After a
  restart or reconnect, Stargate catches up every mapped thread. Failed history
  reads keep the cursor and retry with backoff. A deleted session or lost
  cursor stops catch-up for that thread. After a lost cursor, the next reply
  starts with a note that earlier replies may be missing. Existing threads
  start at current history, without backfill. Continuations are not
  guaranteed exactly once.
  Pinned captains instead use one source-attributed cursor. Their replies go to
  the originating job's destination, not every old chat. Unowned native UI
  output stays in native history. Per-thread transcript repair is unsupported
  for pinned captains.
- Events Slack does not deliver during an outage are not recovered from history.
- Backend-setting changes create a new session namespace. Pending jobs for an
  old backend identity remain on disk; they are not executed with new settings.
  Adding `backend.sessionID` only binds an existing native session; it does not
  change the namespace, thread admission or cron schedules. Changing that pin
  requires an explicit idle migration. One pinned session can have only one
  Slack bot registration, at most one IRC registration and one Stargate process
  owner; each transport delivers only replies to its own inputs.
- Claude Agent SDK backends deliver only each turn's own reply: no
  transcript catch-up, dashboard history or pinned captain session.
- Responses render Markdown, with no tool output or reasoning, at most 60,000
  Unicode characters; OpenCode transcript replies are not clipped. Streaming,
  `/cron`, and its interactive controls are supported. See
  [attachments](attachments.md) for supported file types and backends.
  Backend approval buttons are unavailable. See the
  [Slack feature comparison](slack-parity.md) for remaining gaps.
- Database files contain prompts and replies. There is no automatic retention
  policy. Keep the data directory private and back it up only while stopped.

Access rules are request filters, not isolation. A permitted user can ask the
agent to use every enabled capability under the Stargate process's OS account.
Separate users/containers are required to isolate untrusted workloads. Never
enable coding tools for an untrusted Slack audience.

## Read-only status report

Run `stargate status --config PATH --bot ID --log PATH [--json]` to print
JSON. `--log` is optional; without it, incident history is unknown. This is
separate from `service status`. The command reads only the configured OpenCode
endpoint. It does not start a backend,
submit work, send messages, or change tasks. Other backend types report unknown.
A successful server metadata read does not test requests or waits. The pinned
session check verifies identity and location, not execution readiness. Crew
reporting remains unknown: an atomic loaded-only read is unavailable. The
command does not call the crew RPC or inspect loaded locations.
Each probe has a five-second deadline. No quota or journal probe is performed.

The report scans at most the final 2 MiB of the supplied log for selected safe
failure categories in the preceding 24 hours. It groups by category, capability,
and bot attribution. Lines without a bot are unattributed, not assigned to the
selected bot. Known job IDs are limited to 20 per group. Ticket and incident
recovery remain unknown; current successful probes cannot prove old work
completed. Log rotation and complete source coverage cannot be verified, so
history is always incomplete even when the file is readable. Malformed lines,
truncation, missing window coverage, and unreadable files are reported. Do not
use an empty incident list as proof of health. Raw log messages, prompts,
credentials and error details are not included in the report.
