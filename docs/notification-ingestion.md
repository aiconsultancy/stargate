# External notification ingestion

The optional HTTP input accepts facts for display in configured Slack channels.
Notifications never enter `Gateway`, agent queues, backends or prompts. This
feature is separate from [notification muting](notifications.md).

Every `notify.adapters.<name>.enabled` flag defaults to `false`. Omitted or
disabled inputs create no notification store, routes, workers or Slack sends.
Configuration is still validated when disabled. Only the built-in `http`
adapter and explicit Slack C/G channel destinations are supported. Pollers,
IRC sinks, public ingress, cloud queues and receipt APIs are not implemented.

## Terms

| Term           | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| Notification   | An inert schema-1 fact for display, never a command.                   |
| Input adapter  | Trusted code that authenticates a source and calls `publish`.          |
| Source         | Configured adapter instance and principal with topic grants.           |
| Topic and tags | Logical stream name and bounded string filters.                        |
| Destination    | Configured Slack registration, channel and audience.                   |
| Subscription   | Exact topic or final `.*` prefix, tag filters and destination aliases. |
| Signature      | Server-derived occurrence identity for bounded deduplication.          |
| Outbox row     | Durable work for one resolved physical destination.                    |

## Configure

Merge this example into an existing configuration. Replace the IDs with approved
registrations and channels. Keep `enabled: false` until activation is approved.

```json
{
  "api": { "listen": "unix" },
  "notify": {
    "adapters": {
      "local-http": {
        "type": "http",
        "enabled": false,
        "path": "/v1/notifications/local",
        "sources": [
          {
            "id": "release-ci",
            "tokenEnv": "STARGATE_NOTIFY_RELEASE_CI",
            "topics": ["release.*"],
            "audience": "internal",
            "perMinute": 60
          }
        ]
      }
    },
    "destinations": {
      "release-log": {
        "slack": { "bot": "code-helper", "channel": "C123" },
        "audience": "internal"
      }
    },
    "subscriptions": [{ "topic": "release.*", "to": ["release-log"] }]
  }
}
```

Enabled HTTP requires `api.listen: "unix"`. This selects the existing API
owner's private mode-0600 socket, not an additional listener. Fleet TCP settings
still work when HTTP notification inputs are off. There is no simultaneous TCP
and Unix API. Dashboard and Teams listeners remain separate.

Each source needs its own 32–256-character bearer credential using ASCII letters,
digits, `_` or `-`. Store only its environment name in config. Use a private
`<config>.env` companion or the process environment. Environment values override
the companion. Producer checks do not change `process.env`. Disabled inputs
need no resolved producer credentials. Never pass secrets as CLI arguments.

Producer credentials cannot read Fleet routes. The operator token cannot
publish. Startup rejects reused operator/producer credentials and producer
credentials shared between sources, even through different environment names.
`config check` is offline. It reads an existing operator token to detect reuse
but never creates or rotates it. Startup also checks the exact loaded token.

Mount paths are canonical ASCII `/v1/notifications/<mount>` paths. Duplicate
mounts, unknown fields or adapter types, wildcard/DM/IRC destinations, missing
registration/alias references and incompatible audiences fail validation.
Source IDs and adapter names are stable identities. Secret rotation does not
change signatures. Subscriptions can use ANDed tag filters, for example
`"tags": { "stage": ["stable", "preview"] }`.

## Access and echo exclusion

The sending registration must allow the explicit destination channel. An
`internal` source cannot reach a `public` destination. Aliases deduplicate by
app, workspace, bot user and channel. Conflicting alias policies are rejected.
Backend and model settings are not part of the sending principal.

Offline checks cannot resolve workspace or bot-user identities. They therefore
reject a destination when another peer-enabled local registration could admit
its channel. Mention-only mode, muted threads and the sender's current display
name do not prove safety. Use dedicated channels or receiver denies.

Startup resolves all registration identities before starting notification work.
Each row freezes registration, app, workspace, bot user, channel and both
audiences. Immediately before dispatch, the sink checks the current policy
snapshot and every frozen field. Removed/rebound aliases, changed principals,
new denies, widened audiences and receiver echo conflicts cause drops, never
redirection. This guarantee covers this process and configuration, not other
hosts or third-party bots. Ordinary peer chat is unchanged.

All `notify` changes require restart. Live-safe access reloads can revoke stored
work or create an echo conflict; sends then drop. Such a candidate still must
pass schema, credentials and the existing restart-only planner. Failed reloads
do not advance the notification policy snapshot. A fresh `config check` or
restart still refuses an unsafe destination policy.

## Publish and retry

Send one JSON object. Identity, signatures and destinations are not body fields.

```json
{
  "schema": 1,
  "topic": "release.desktop",
  "occurredAt": "2026-11-19T02:00:00Z",
  "tags": { "stage": "stable" },
  "payload": {
    "title": "Desktop released",
    "body": "Version 1.2.3 is available.",
    "url": "https://example.com/releases/1.2.3"
  }
}
```

`occurredAt` is the producer's calendar-valid RFC 3339 event time, with at most
millisecond precision. Set it once. Retry the same envelope, including that
time and all content. The signature includes projection version, stable source
scope, topic, UTC occurrence time, ordinally sorted tags and display fields.
JSON order, equivalent time zones and absent/empty optional fields do not
change it. Same-source identical events at the same instant merge. A late
copy can be admitted again after dedup retention expires.

| Status | Meaning                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `202`  | `{ "signature": "v1:…", "duplicate": false }` after atomic dedup/fanout commit, or `duplicate: true`. Not delivery proof. |
| `400`  | Invalid JSON or strict envelope.                                                                                          |
| `401`  | No valid source bearer.                                                                                                   |
| `403`  | Topic not granted, or a browser Origin was supplied.                                                                      |
| `404`  | Unknown path/method, including disabled mounts and producer preflight.                                                    |
| `413`  | Body exceeds 64 KiB.                                                                                                      |
| `415`  | Not `application/json`, optionally UTF-8.                                                                                 |
| `429`  | Source rate exceeded, with `Retry-After` seconds.                                                                         |
| `503`  | Queue/store/route capacity, shutdown or unavailable work, with `Retry-After`.                                             |

Errors contain only a fixed `code` and a `correlationId`. Producer routes reject
every `Origin` header and have no CORS, cookies or query-token authentication.
Authentication runs before bounded body reads. The host reserves independent
Fleet read/stream work slots. See [host limits](api.md#host-limits).

Retry `429`, `503` and lost responses with the identical event after
`Retry-After`, within your own retry budget. A lost response or timeout does not
prove rollback. There is no receipt query or exactly-once delivery claim.

## Storage, sends and shutdown

The existing instance lock owns private `notify.sqlite`, separate from
`notifications.sqlite` mute preferences and the agent job store. One transaction
checks dedup before capacity and commits all selected destination rows together.
Only oldest pending rows can be evicted per destination; leased rows are never
capacity victims. Any refusal rolls back all tentative evictions and fanout.

Slack uses the same registration, with one request-scoped `chat.postMessage`,
zero SDK retries and a 15-second SDK timeout. Separate bounded `plain_text`
sections preserve title, body and URL. The fallback escapes Slack controls.
Markdown, mentions, commands, attachments, link fetches and unfurls are off.
Cancellation aborts actual HTTP. A confirmed refusal differs from an unknown
send result. Unknown results and stale crash leases replay within attempt and
age limits; duplicates remain possible. One stalled destination does not block
another. Aggregate counters are memory-only.

| Limit                                               | Default                                  |
| --------------------------------------------------- | ---------------------------------------- |
| Title/body/HTTPS URL                                | 200 / 2,800 / 2,048 code points          |
| Tags                                                | 16, keys 64 and values 256 code points   |
| Topic/pattern                                       | 200 code points                          |
| Adapter/source/destination/subscription count       | 16 / 64 per adapter / 128 / 512          |
| Source topic grants / ID / mount                    | 64 / 64 characters / 128 characters      |
| Source rate                                         | 60 per minute, configurable up to 60,000 |
| Admission queue / total rows / rows per destination | 1,000 / 10,000 / 500                     |
| Admission age / attempts / lease                    | 24 hours / 3 / 60 seconds                |
| Destination spacing / concurrent destinations       | 1 second / 4                             |
| Dedup age / records                                 | 7 days / 100,000                         |

Optional `notify.limits` can reduce `admissionQueue`, `outboxRows`,
`perDestination`, `maxAgeHours`, `sendAttempts`, `dedupDays` and `dedupRecords`.
These positive integer values cannot exceed the defaults. Timing and scheduler
limits are not operator flags. Limits are bounds, not throughput measurements.

Shutdown closes producer admission and core claims before worker interruption.
It aborts sends and waits for local users before releasing state and the
instance lock. A referenced 25-second timer starts at early intake close.
If notification work does not settle, the process exits with status 1 while
still owning the store and lock. A timeout never permits a live SQLite writer
to outlive ownership. Startup failures use the same owner. Restart preserves
admission age and counted attempts, then applies bounded replay.

## Local fixture and future live proof

Development uses temporary Unix HTTP and SQLite, local fake Slack HTTP and
injected backends. No provider or Slack account is needed:

```sh
mise exec -- bun test tests/notify-config.test.ts tests/notify-http.test.ts tests/notify-slack.test.ts tests/notify-runtime.test.ts
```

For disk-only fixtures, set `TMPDIR` to a private mode-0700 directory on disk.
The suites prove commit/response loss/restart, auth, literal text, physical
binding checks, real HTTP abort, disabled startup and child-process hard exit.
They do not establish live credentials, membership, delivery rights or deployment.

Only after separate approval of one source, credential, audience and test channel,
an operator may enable the input and restart through the normal process. Save
the unchanged JSON envelope to `event.json`. This request assumes the approved
credential is already in the operator environment; it does not create one:

```sh
printf 'Authorization: Bearer %s\n' "$STARGATE_NOTIFY_RELEASE_CI" |
  curl --fail-with-body --silent --show-error --header @- \
    --header 'Content-Type: application/json' --data-binary @event.json \
    --unix-socket /absolute/dataDirectory/api.sock \
    http://localhost/v1/notifications/local
```

Observe `202` and the literal message, then resend the same file and verify
`duplicate: true`. Do not infer exactly-once delivery or rights in other channels.
This documentation does not authorize that live procedure.

## Rollback

Disable all notification inputs and restart normally. Retain `notify.sqlite`
privately and unused. Re-enabling uses the same binding, age and attempt rules.
Before downgrade below this integration, remove only the `notify` subtree.
For a version without Unix API mode, restore the previous private TCP setting
or omit `api` if not needed. Preserve existing Fleet configuration and tokens.
Never delete a store to repair startup or downgrade its schema in place.

See the [approved change definitions](changes/notification-ingestion/delivery.md)
and their provenance for the delivery boundaries and deferred work.
