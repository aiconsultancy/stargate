# Captain-addressed meta commands

In an allowed Slack conversation, mention one captain bot and put the command
after its mention:

```text
@your-captain /help
@your-captain /health
@your-captain /health host
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
| `/health`                        | Shows a read-only health summary.                                                                                                  |
| `/health <section>`              | Shows detail for `host`, `agents`, `stargate`, `opencode`, `proxy`, `services` or `starfleet`.                                     |
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

## Health reporting

`/health` uses the same allowed-human checks as configuration commands. It
does not wake crew, submit a model request, repair a service or create a captain
turn. Summary and detail replies stay below 3,000 characters. `✓` means an
observed healthy value, `⚠` means unknown or degraded, and `✗` means an observed
failure. An unreadable or unsupported value is `unknown`, not evidence of health.

Health reads reuse the capability report behind `stargate status` and the
existing read-only crew-reporting and quota interfaces. Crew task ownership is
not proof of native session execution: a running local task does not prove that
the worker is making progress. Task IDs and times can appear; task text, prompts,
message bodies, credentials and raw provider errors cannot.

The initial health summary has no expand buttons. NET-1714 adds those later.

### Health configuration and coverage

The optional `health` object belongs to one Slack bot registration. Its paths
are absolute. Changing it follows the normal restart-only configuration policy;
the health command never changes it.

```json
{
  "health": {
    "opencodeDataDirectory": "/srv/opencode/data",
    "crewWorktreesDirectory": "/srv/crew",
    "starfleetSnapshotFile": "/srv/stargate-health/starfleet.json",
    "stalledAfterSeconds": 1800,
    "snapshotMaxAgeSeconds": 900
  }
}
```

The two disk paths are optional: if absent, those disk values are `unknown`.
Root and Stargate data-directory disk reads need no extra path. The stall limit
defaults to 1,800 seconds; snapshot freshness defaults to 900 seconds. Both
limits accept whole seconds from 60 to 86,400.

- **Host:** OS load, core count, memory, swap, uptime and filesystem capacity
  and inodes. Process samples use numeric IDs and fixed labels, never command
  lines. CPU rates and disk growth require an earlier in-memory observation;
  the first observation is `unknown`. The process scan is bounded, not a full
  process inventory. Missing reboot/time-sync markers remain `unknown`.
- **Agents:** canonical crew task ownership, provisioning, queues and task
  times, plus pinned captain readiness. Native activity and a stall verdict
  remain `unknown` without a reliable last-activity source; old task timestamps
  alone do not prove a stall.
- **Stargate:** readiness version/time, configured unit state, scheduled-run
  metadata and the latest maintenance report. Current Slack/IRC connection
  state, last delivery, last-hour delivery/refusal counters and the latest
  release comparison remain `unknown` without a telemetry source.
- **OpenCode:** existing status reads, server version, server-wide active
  session count and location-scoped pending forms, permissions and MCP counts.
  These reads do not submit work or approve requests. Failed reads are
  independently `unknown`. Existing incident evidence retains its 24-hour
  window; it is not relabelled as a last-hour counter.
- **Proxy:** the configured unit state and the existing quota reader's
  provider/window percentages, observation and reset times. Quota is not token
  usage or proof that a model can run. Expired or inactive windows do not prove
  available allowance. Request/error/latency and cache-warming metrics remain
  `unknown` without a supported telemetry reader.
- **Services:** Sourcebot health, mirror refresh/index age, Caddy route probes,
  Tailscale state/peer count and failed units/timers are explicitly `unknown`
  in this slice. The gateway does not guess endpoints or discover credentials.
- **Starfleet:** only the cached snapshot described below. No request runs
  Azure CLI, an SSH command or the remote inspection route.

### Proposed Starfleet snapshot producer

The gateway reads a regular, private, owner-matching file no larger than 64 KiB.
It rejects symbolic links, malformed or foreign schemas, future observations
and observations older than `snapshotMaxAgeSeconds`. Replies mark the source
`remote`, show the observation age and label stale current state `unknown`.

```json
{
  "schema": "stargate.health.starfleet.v1",
  "observedAt": "2026-11-18T03:00:00Z",
  "services": {
    "avondale": "active",
    "stargate": "active",
    "opencode": "unknown",
    "proxy": "unknown"
  }
}
```

Each service accepts only `active`, `inactive`, `failed` or `unknown`. There
are no free-text output, command or credential fields.

Proposed producer, **not implemented here**: an independently approved scheduler
uses the existing read-only Starfleet inspection route, extracts only these
service states, and atomically publishes a mode-`0600` file owned by the gateway
user in a private local directory. On probe failure it publishes `unknown`
with the actual observation time; it must not refresh old success timestamps.
The gateway neither starts this producer nor grants its credentials or access.

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
