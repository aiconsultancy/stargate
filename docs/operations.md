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
| Let a trusted captain send a message to another approved conversation         | [Captain posts](captain-post.md)                                                                           |

## Linux user service

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
endpoint and its existing loaded captain location. It does not start a backend,
submit work, send messages, or change tasks. Other backend types report unknown.
A successful server metadata read does not test requests or waits. The pinned
session check verifies identity and location, not execution readiness. The crew
RPC checks the read-only reporting status; an unloaded location is unknown.
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
