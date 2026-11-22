```yaml
from: inputs.md
status: approved
created: "2026-11-19"
author: "Astra High delivery-plan author"
approval:
  by: "Independent Astra High"
  date: "2026-11-19"
  state: approved-no-blocking-findings
  evidence: plan-review.md
  reviewed-sha256: 30932eab7b881d011a4cbb9853903fa38aa1fddca33b6eaa497267771203bc77
source-anchor: b9e8999a9dc0c892e00732edb74541e855a3b266
historical-source-anchor: 71fc14dc070bc88135e104c3e16742e8a92c28cf
work-items: [NET-1733, NET-1731]
existing-issue: NET-1733
tracker: NET-1731
publication: verified-2026-11-19
publication-evidence: publication.md
tracker-document-id: e8c3d40e-293b-41d8-a110-9db9a8f86e3b
tracker-document-url: https://linear.app/nettworks/document/approved-delivery-plan-private-notification-http-host-durable-core-and-9ed01fe8b367
```

# Deliver private HTTP notification admission and Slack delivery

Build NET-1733 in three independently checked PR units. Extend the current
API owner, implement the complete durable core, then connect HTTP and Slack.
The first two units can run in parallel. Integration starts from main after
both merge. Each unit includes its own tests and leaves main usable.

The independent Astra High reviewer approved the exact reviewed revision
without blocking findings. `inputs.md` records the reviewed source hashes. Approval
and tracker metadata below record the decision without changing its technical
requirements. Tasks 01/02 start after publication read-back and fresh-main
checks; task 03 waits for both verified predecessor merges.

## Authority, source and reading order

Read `inputs.md`, this document, then the assigned task. Execute approved
tasks with Subspace's `playbooks/feature.md` and change-readiness check.
Use the approved R7 content, not its historical draft-status statements.

- Approved design: the complete 840-line corrected R7 named in `inputs.md`.
- Design SHA-256:
  `ab6025b4656308da672eb50ba8bdedced4a981dc4b1ae8f3a9c5c9da33889d50`.
- Historical source inspected through `git show OID:path`:
  `71fc14dc070bc88135e104c3e16742e8a92c28cf`.
- Admitted source after the captain's freshness update:
  `b9e8999a9dc0c892e00732edb74541e855a3b266`.
  PR #77 merged as this squash, with parent 71fc and reviewed/gated tree
  `b19e69c8adc6ac60f2b00917d7a4fe995a6956e1`. Relevant deltas are below.
- Guides inspected at the anchor: `AGENTS.md`, `README.md`,
  `docs/{api,configuration,operations,design,development}.md`,
  `docs/architecture-review.md`, and relevant migration constraints in
  `docs/effect-schema-migration.md`.
- Commands come from that anchor's `mise.toml` and `package.json`.
  Bun is 1.4.4, Effect 4.1.0, OpenCode SDK 2.3.2.
- Independent source assessment: `source-integration-check.md`, 299 lines,
  SHA-256
  `80cee1b91e2842d07f57e04356adefbaf0c386811ae43b62cbbae8decf55a450`.
  Its single-host, offline-echo and shutdown decisions are incorporated below.
  It assesses current source and does not approve this plan.

At this repository path, `node_modules` is absent. No install or test run was
performed for planning. Implementation must use a prepared isolated worktree,
the frozen lockfile, and the installed Effect guide before writing Effect.
Illustrative R7 types are requirements guidance, not verified compilable code.

After approval, the captain publishes the approved plan and task mapping to
NET-1733 and NET-1731, reads them back, and records those references. No new
issue is required. The canonical implementation artifact destination is
`docs/changes/notification-ingestion/`. Copy approved artifacts there only in
authorized implementation work; keep one authoritative plan revision.
Commit, push and PR publication need their normal project authorization.
No action in this planning request grants release or live-operation authority.

## Outcome and scope

An authenticated producer submits a versioned display event on a private Unix
socket. `202` means that the dedup record and every selected destination row
committed, or that the event was already admitted. The same configured Slack
registration sends literal text from its durable row without an agent turn.
Restart retains accepted work and bounded attempt history.

The owner selected bounded replay for unknown sends and stale leases.
Duplicates are possible. Identical same-source events at the same instant
merge. Do not add an occurrence marker, receipt lookup, repair queue, or
exactly-once claim.

Excluded from these three units: NET-1734 poller, NET-1735 IRC sink, new SSE
inputs, webhook verification, Redis/cloud queues, public ingress, health or
metrics routes, configuration-write routes, dashboard/Teams migration,
live credentials, live channels, service changes, deployment and releases.
Existing Fleet SSE is a compatibility requirement, not a new SSE input.

## Requirements and direct acceptance

These local IDs index approved R7 sections; they do not replace its content.

- REQ-01: One private API owner; existing Fleet behavior preserved.
  Unit 01 proves TCP Fleet regressions and Unix Fleet requests.
- REQ-02: Per-route trust and bounded connections, body, lifetime and capacity.
  Unit 01 proves raw HTTP limits; unit 03 proves the credential matrix.
- REQ-03: Strict envelope and source-derived occurrence signature.
  Unit 02 proves decoder/signature cases; unit 03 proves HTTP rejection/retry.
- REQ-04: Atomic dedup/fanout and bounded storage.
  Unit 02 proves real SQLite rollback, capacity, reopen and crash behavior.
- REQ-05: Bounded, isolated send attempts and replay.
  Unit 02 proves scheduling; unit 03 proves request-scoped Slack HTTP behavior.
- REQ-06: Frozen binding, audience, access and echo exclusion.
  Unit 02 proves row invariants; unit 03 proves config/startup/send/reload.
- REQ-07: Shutdown settles waiters and local users before store close.
  Unit 02 proves core shutdown; unit 03 proves runtime order and process exit.
- REQ-08: Independent inputs, default-off and restart-only configuration.
  Unit 03 proves strict config, credentials and disabled runtime behavior.
- REQ-09: Inert output with no gateway/backend admission.
  Unit 03 proves literal Slack payloads and zero notification-origin calls.
- REQ-10: Existing drain, steering, version and transport behavior.
  Units 01/03 run named regressions and the full repository gates.

Delivery acceptance requires the combined runtime fixture in unit 03.
Passing unit 01 or 02 alone does not establish the complete HTTP/Slack POC.
Conversely, those units must pass independently before they can merge.

## Current source reconciliation

### Merged schema delta: 71fc to b9

The captain's verified receipt in `inputs.md` establishes merged main and
Quality success. Immutable source comparison dispositions the integration
delta; migration tests, reviews and probes are not repeated here.

- `src/app/runtime.ts` replaces Zod human-identity parsing with
  `Schema.decodeUnknownResult` and `Result.isSuccess`. Startup, API and
  finalizer ownership remain unchanged; historical line numbers below refer
  to 71fc, not the shifted b9 lines.
- `src/gateway/routing.ts` and `src/gateway/peers.ts` now use Effect Schema/Result and current
  inferred values. `Identity` remains `{ team, user }`; peer admission and
  allow/deny policy remain unchanged. Use their current helpers and types.
- `src/gateway/store.ts` uses `settingsStruct`, `typeof schema.Type`, Effect decoding
  and explicit mutable arrays for its persisted activity/file/burst values.
  Its tables and transaction ownership did not change. The new notification
  store stays separate and follows these current schema/type conventions.
- API host/config, Slack connection, root config/setup/reload, Effect bridge,
  Teams Unix helper, cron-store privacy pattern and gateway version code are
  unchanged between these anchors. Their inspected contracts still apply.
  `mise.toml` and `package.json` also remain unchanged.
- New notification boundaries use existing Effect helpers from
  `src/settings-schema.ts`, including strict nested `settingsStruct` where
  required. Use current `.Type`/Result contracts and explicit mutability.
  Do not reintroduce Zod into migrated consumers or copy old `.safeParse`
  call shapes. Remaining API config compatibility is not a reason to use
  Zod for new notification envelopes. Preserve existing unrelated bridges.

This delta does not change the three slices or require a new policy gate.
Before each build, check only later relevant main changes against b9.

### Extend the actual API, not R7's empty-host sketch

`src/dashboard/api/v1/server.ts:startApiV1Server` already owns a Bun listener, Fleet
source, host metrics, event streams, operator bearer authentication and CORS.
`src/dashboard/api/v1/config.ts:apiV1ConfigSchema` already occupies top-level `api`.
It requires `listen`; omission of `api` means off. `api.enabled` is currently
an unknown key, explicitly rejected by `tests/api-v1-config.test.ts`.
`src/app/runtime.ts:982-1011` starts this owner once.

The smallest compatible config extension is `api.listen: "unix"`, selecting
`<dataDirectory>/api.sock`. Existing private TCP `listen` strings retain their
meaning and wire behavior. Keep omission as the API off switch. Do not add a
second `api` subtree or require `enabled: true` on existing installations.
Notification adapter flags remain explicit and default false.

Enabled notification HTTP inputs require this Unix mode in NET-1733. A TCP
Fleet config continues to work, with notification routes absent. This retains
R7's no-TCP producer boundary without moving or disabling existing Fleet
installations. It does not offer simultaneous TCP and Unix API listeners.
Opting an installation into Unix mode is a future operator config choice,
not an action taken during implementation.

The current server's early GET/HEAD gate, global operator authentication,
global CORS and `requestIP` check cannot be reused unchanged for producers.
Dispatch trusted notification routes before the Fleet-specific policy.
Fleet keeps `/api/v1/*`, its token, GET/HEAD/OPTIONS, CORS, encoded ship IDs,
20-second reads and eight event streams. Notification mounts own only exact
`POST /v1/notifications/<mount>` paths. They never fall through to Fleet auth.

No producer CORS headers. Reject every producer request with an `Origin`
header, including `null`, and reject producer preflight. Accept only explicit
bearer authorization, never cookies or query parameters. An operator token
does not become a producer token. Startup rejects equal producer/operator
secrets or ambiguous producer credentials. No authorization failure reads the
body or exposes either credential.

### HTTP mechanics need a bounded owner

Current `Bun.serve` sets an idle timeout but does not establish the approved
absolute header lifetime, connection ceiling or route-slot settlement.
Use the existing `node:http` precedent from `src/teams/http.ts` for the common
API listener mechanics, retaining `startApiV1Server` as the public entry point.
Extract Fleet request handling without changing its policy or response shape.
One new `src/dashboard/api/server.ts` owns either TCP or Unix, never both. This replaces
the API's underlying listener; it does not start a competing host.

Reuse `src/lib/unix-socket.ts` ownership checks and identity cleanup. Its
current mode check is hardcoded to 0660. Add only a caller-selectable private
mode with existing defaults unchanged; API requests 0600 under umask 0177.
Do not copy the dashboard's unconditional stale-path unlink. Test live sockets,
symlinks, foreign/non-socket files, replacement identity and shutdown cleanup.
The runtime's instance lock remains the lifetime owner.

The API owner supplies absolute timers from connection acceptance through
header parsing, then request admission and body/handler completion. Rejected
requests close their connection within the same bound. The timeout aborts
body reads and the handler. A route slot is retained until the actual handler
settles, even after its HTTP response ends. No orphaned admission or send is
made safe merely by racing a Promise against a timer.

Initial host limits, reviewable implementation defaults: 64 connections,
16 KiB parsed headers, 10-second header deadline, 20-second notification
request lifetime, four requests per notification route, eight notification
requests in total. Keep separate allowances for eight Fleet reads and the
existing eight Fleet streams. A notification route cannot consume those
reserved admitted-work slots. Pre-header connections cannot be assigned a
route; connection/header limits bound them but cannot guarantee availability
against a process-wide flood. This is the R7 shared-process limitation.

The Node response bridge must stream Fleet SSE with bounded backpressure,
propagate client disconnect, and cancel its reader on stop. Never buffer an
event stream or apply a notification request deadline to its entire lifetime.

### Keep each state model separate

`src/notifications/preferences/notification-store.ts` and `notifications.sqlite` store mute preferences.
They are unrelated to new `src/notifications/ingest/` and `notify.sqlite`.
`Store.jobs`, cron, nightly outboxes and Fleet delegation state have different
replay semantics. Reuse SQLite/Effect patterns, not their tables or row types.
Notification retries must never become retries of agent work.

`src/app/runtime.ts:lockInstance` holds `instance.sqlite` exclusively.
Acquire the new database only under that existing lock, with private file
and directory checks. Follow `src/cron/store.ts:165-183` for no-follow,
regular-file open and mode 0600 before WAL/SHM creation. Programmatic `serve`
must be safe without relying on `start` having set process umask. Preserve
the file on unknown schema, corruption or startup failure. Use versioned,
additive schema initialization, WAL and the existing bounded busy-timeout
pattern. No live database reset or migration of another concern is included.

### Reuse the Slack connection with a real request deadline

`SlackConnection.announce` currently checks abort only before the shared
`send`. It is not the sink contract. Reuse the `historyWeb(signal)` pattern
already used by `activity` to add a bounded notification-send capability on
the same registration. Retain the SDK's 15-second timeout and zero retries.
No new Socket Mode connection or bot credential is needed.

`slackContent(text, "plain")` exposes the existing literal rendering.
One combined title/body/URL can exceed its single 3,000-character section.
Build one Slack message containing separate bounded plain-text sections
for title, body and URL; keep the escaped top-level fallback and disable
Markdown, parsing and unfurls. Preserve all accepted text in one provider
call. Do not invoke reply classification, mention parsing or a multi-post
reply chunker. This is a sink projection; stored payload/signature are intact.

`Identity` has workspace and user; `BotConfig.slack.appId` adds the app.
Freeze registration ID, app ID, workspace, bot user and channel in each row.
Do not use `botKey` as the notification principal: it includes backend config.
Aliases that resolve to one physical binding produce one destination row.

### Validate echo exclusion without a new directory service

`routeEvent` admits bot events only for verified peer captains, and still
checks user and channel allows/denies and rejects the receiver's own user.
Use those same access helpers in `src/notifications/ingest/binding.ts`; do not alter intake.
The notification path has no `Gateway.receive` or backend reference.

`config check` currently performs no Slack calls and has no resolved workspace
or bot-user IDs. Keep it offline. Reject a configured destination when another
local registration could accept a peer bot in that channel and static config
cannot rule out a conflict. Unknown identity is not proof of safety. The
runtime refines the same fail-closed predicate using connected identities,
but does not weaken the offline rejection. No peer-name lookup is needed:
assuming the sender could be a verified captain is conservative and stable
if its Slack display name changes. Dedicated notification channels remain
the approved resolution. Document this conservative config restriction.

Immediately before send, compare every frozen identity field and audience,
apply current sender channel access and receiver echo rules, and reject any
unsafe binding. Use closures over runtime's synchronously updated bot settings,
not a stale startup snapshot. `restartRequired` already makes unlisted fields
restart-only; retain that for `notify` and `api`. Live access changes still
affect send-time checks. A revoked or conflicting row is dropped, never moved.

## Component ownership and contracts

```text
   ┌────────────────────────────────────┐
   │         Existing API owner         │
   │ Fleet routes and private Unix mode │
   │                                    │
   └────────────────────────────────────┘
                      │dispatch
                      ▼
   ┌───────────────────────────────────┐
   │            HTTP input             │
   │ authenticated source and envelope │
   │                                   │
   └───────────────────────────────────┘
                      │publish
                      ▼
   ┌───────────────────────────────────┐
   │        Notifications core         │
   │ single admission owner and SQLite │
   │                                   │
   └───────────────────────────────────┘
                      │claim / send
                      ▼
   ┌───────────────────────────────────┐
   │            Slack sink             │
   │ frozen binding and request signal │
   │                                   │
   └───────────────────────────────────┘
```

- Fleet operator reads use a separate handler and credential on the API owner.
- The notification core owns commit and replay, not HTTP or Slack policy.
- Slack translates display payloads; it cannot choose a new destination.

Proposed new modules are deliberately small. Implementation can combine
adjacent pure helpers within its task boundary; no plugin framework is needed.

- `src/dashboard/api/route.ts`, unit 01: trusted static exact-route descriptor,
  header-only authorization, per-route limits and Promise handler with signal.
  No notification import.
- `src/notifications/ingest/model.ts`, unit 02: strict input, source scope/audience, resolved
  destination, accepted result and typed failures.
- `src/notifications/ingest/notifications.ts`, unit 02: Effect
  `Notifications.publish(source, input)` and scoped service construction.
  Success follows commit; bounded dropping queue plus Deferred results.
- `src/notifications/ingest/store.ts`, unit 02: synchronous admit, claim, settle, recover,
  prune and close transactions. One database owner, two tables, no transports.
- `src/notifications/ingest/sink.ts`, unit 02: Promise `allowed`/`send`, frozen destination,
  signal and sent/refused/unknown outcome. Unit 03 implements Slack.
- `src/notifications/ingest/config.ts` and `binding.ts`, unit 03: config, subscriptions,
  credential references, physical binding and echo policy.
- `src/notifications/ingest/http.ts` and `slack.ts`, unit 03: header authentication and HTTP
  mapping; separate literal Slack projection and outcome mapping.
- `src/app/runtime.ts`, unit 03: lock, store lifetime, connected registrations,
  core scope, route composition and shutdown order. One integration writer.

One admission fiber serializes offers. Store operations are synchronous atomic
transactions on the same process-owned handle. Send workers can call claim
and settlement methods; they cannot span a transaction across an await.
One destination has at most one active attempt, and four destinations may
send concurrently. No second queue is introduced for source-specific state.

The initial adapter set contains `http` only. Each configured instance validates
even when disabled, mounts nothing when disabled, and starts no background
fiber. A future poller uses `publish` without requiring `api`; it owns its
checkpoint, backoff and source binding. A future IRC sink implements the
existing sink contract and its own echo/line-budget rules. Reject both types
in current config rather than shipping disabled placeholder implementations.

## Core invariants across every slice

1. Source scope is stable adapter instance plus configured source principal.
   Secrets, arrival time, backend/model and destination aliases are excluded.
   Preserve source audience with the admitted content.
2. Calendar-valid RFC 3339 occurrence times accept at most milliseconds and
   normalize to UTC milliseconds for the signature. Reject excess fields,
   supplied signatures, finer precision and invalid calendar dates. Sort tag
   keys ordinally. Identical optional absence/empty values use R7's projection.
3. Check dedup before capacity within the transaction. Compute a set of
   physical destinations. Insert dedup and every destination row atomically.
   Zero matches still commits dedup. No provider call occurs in admission.
4. Evict only the oldest pending row of a full destination. A leased or active
   row cannot be evicted. A later capacity/write failure restores tentative
   evictions and all earlier inserts through rollback.
5. Persist attempts at claim before send. Recover stale leases on process
   restart, retaining admission age and attempts. Never reclaim an in-process
   attempt just because wall time passed its lease.
6. Sent and permanent refusal delete only the corresponding destination row.
   Proven unsent retries respect Retry-After. Unknown sends back off and replay
   within limits. One failed channel does not stop another.
7. Dedup records with outstanding rows cannot be pruned. Prune completed
   records by age or capacity, oldest first. If space cannot be made, reject
   the whole admission. Retention is bounded, not permanent suppression.
8. Cancellation can detach a caller, not undo a committed admission. The
   admission owner completes or rejects all queued Deferreds on shutdown.
9. R7 defaults: queue 1,000; total outbox 10,000; per destination 500; age
   24 hours; three attempts; lease 60 seconds; one-second destination spacing;
   dedup seven days and 100,000 records; source 60/minute; body 64 KiB.
   Attempts and age survive restart. R7 telemetry counters remain in memory.
10. Bound fields as well as rows: 200-code-point title, 2,800-code-point body,
    at most 16 tags, HTTPS URL only. Proposed implementation ceilings for R7's
    unspecified small strings: topic 200, tag key 64, tag value 256, URL 2,048
    code points. No userinfo, controls or whitespace in URLs; never fetch them.
    Proposed config ceilings: 16 adapters, 64 sources per adapter, 128
    destinations, 512 subscriptions, 64 grants per source, 64-character IDs
    and 128-character mount paths. Validate positive finite numeric limits.
    These bound worker/config state and are reviewable implementation defaults.

## Shutdown and existing runtime behavior

Notification shutdown begins in the runtime's existing shared intake-close
phase. Close HTTP producer admission and the core admission gate before worker
interruption. Stop new claims, settle queued publish waiters, abort active sink
requests, wait for their settlement, then close the new store. Keep the
instance lock until all normal resource finalizers finish.

The current API finalizer runs after the worker FiberMap closes. Adding a
producer without an earlier gate would let it publish into a closing core.
Wire the gate into `closeIntake`; keep Fleet read/server cleanup later as now.
Do not apply its five-second timeout to notification store ownership.

Use a 20-second attempt deadline, below the 60-second lease; the Slack SDK
still times out at 15 seconds. Use a 25-second notification shutdown grace.
If an injected or defective sink remains active after grace, terminate the
gateway process nonzero rather than release the store/lock underneath it.
The runtime owns this escalation. Arm a referenced 25-second timer when early
notification shutdown starts, before awaiting FiberMap interruption or any
send settlement. Clear it only when notification local users have settled.
The production callback calls `process.exit(1)` with a fixed safe diagnostic;
an injected `RuntimeDependencies` callback must have a `never` return contract.
Use a child process to test the actual hard exit. Do not unref this timer,
return normally on expiration, or place a timeout around SQLite/lock release.
An early startup failure after core acquisition uses the same close owner.
Keep this escalation local to notification shutdown. Restart applies the
same bounded replay policy. No service manager is invoked.

Maintenance drains continue to hold agent admissions through their existing
barrier. Notifications are inert display work, not agent jobs or drain-held
assignments. They may finish during the drain and stop at actual process
shutdown. Do not change drain/steer algorithms, ready-record format, feature
defaults, `gatewayVersion`, or release version selection.

## PR units, ownership and safe parallel work

1. [Private API host](task-01-private-api-host.md).
   Current Fleet works through the bounded host and optional private Unix mode.
   Needs approved plan and fresh main. L4 implements; independent L3 reviews.
2. [Durable core](task-02-durable-notification-core.md).
   Complete Effect publish/outbox/send service, real SQLite and fake sinks.
   Needs approved plan and fresh main. L3 implements and independent L3 reviews.
   Use L4 only for unresolved crash or concurrency defects.
3. [HTTP and Slack POC](task-03-http-slack-poc.md).
   Complete default-off integration with authorization and lifetime checks.
   Needs units 01/02 merged and verified. L4 implements; independent L3 reviews.

Three units separate the two independent high-risk boundaries from the
configuration/transport integration that consumes both. Fewer units combine
unrelated host and crash-state changes. More units would leave unused config,
an unbounded sender or a temporarily unsafe route awaiting a later PR.
Unit 01 serves real Fleet reads, not placeholder 200/404 endpoints. Unit 02
is a complete callable core, not schema-only scaffolding. Unit 03 ships the
producer-facing feature as one safe, default-off vertical integration.

Units 01 and 02 use separate worktrees and disjoint file ownership. Unit 01
owns API and its socket-helper extension. Unit 02 owns only core files and
their tests. Integration, root config, runtime and shared documentation belong
to unit 03 after both dependencies merge. A reviewer reads but never edits an
active owner's worktree. No two writers edit `runtime.ts` or `config.ts`.

L3 route choices supplied by the owner are `sol-6-2-high-subagent` or
`glm-5-3-subagent`. L4 choices are `sol-6-2-xhigh-subagent` or
`glm-5-3-subagent`. The captain checks live allowed routes before dispatch.
No planner spawns children or changes profiles. Independent Astra approval
must precede ready status; L3/L4 code review does not substitute for it.

Branch each unit from current main, with no stacked PRs. Start unit 03 only
after both parents merge. Revalidate later relevant source changes against
admitted b9 before each start. PR #77 is already merged; do not reopen its
disposition or repeat migration checks. Resolve overlapping interface changes
using current Effect types. Notification work does not consume its PR budget.

## Verification and evidence gates

Use focused `mise exec -- bun test <named files>` during implementation.
Each task names existing regression files and proposed new files separately.
No command below was executed by this author. New test files become runnable
in their owning unit; they are not claimed to exist at the source anchor.

Before any unit is reported implementation-complete:

```sh
mise run check
mise run config-check -- --config stargate.example.json --schema-only
git diff --check
```

`check` runs strict TypeScript, Biome and the full Bun suite. Once Git
publication is authorized, install existing hooks once per clone and stage
only the reviewed task changes before `mise run hooks`, because its secret
scan reads the index. Preserve hook execution and required Quality checks on
the exact PR head. Do not change dependencies, suppress rules or borrow the
schema migration's comparative timing gate for this feature.

Independent implementation review reads the exact diff and test evidence.
Required review focus: authority separation, commit boundary, physical
identity, unknown outcomes, signal settlement and runtime teardown order.
Resolve findings before merge-ready. Refresh checks after relevant edits or
base changes; re-review if the PR diff changes. Plan approval proves none of
these code properties.

Record base/head SHA, actual command/exit status, acceptance-case results,
review verdict and remaining limits in each task. For crash tests, record the
observed row/attempt state after reopen, not just child exit. For HTTP timeout
tests, record that body/handler work stopped or retained its slot correctly.

Local integrated proof uses a real temporary private Unix socket and SQLite
file, fake Slack HTTP and fake runtime transports/backends. It exercises
commit-before-202, lost-response replay, one destination failure, restart,
live access revocation and shutdown with in-flight work. No browser screenshot
or live Slack account is necessary for a backend-only local proof.
Raw local HTTP fixtures test connection/header/body boundaries. Load checks
assert caps and reserved progress, not an unmeasured throughput target.
The existing CLI smoke benchmark does not measure notification delivery.

## Rollout and rollback

1. Unit 01 preserves legacy Fleet TCP config and supports the explicit Unix
   mode. Omitted `api` opens nothing. No installation config changes.
2. Unit 02 adds no runtime wiring, listener, production file or enabled flag.
   Its executable tests open only temporary stores.
3. Unit 03 adds optional `notify`, with every adapter off by default. Disabled
   config is validated but opens no notify store, routes or send workers.
   Enabled HTTP requires Unix API mode and valid destination policy.
4. After local code evidence, any live proof needs separately approved test
   source/credential/channel/audience and the normal release/deploy permission.
   Document one operator-run Unix-socket request; do not execute it here.

To turn the feature off, disable all notification adapters and restart through
the normal authorized process. Retain `notify.sqlite` privately and unused.
Re-enabling recovers under the same age/attempt/binding rules; it is not a
reset. For downgrade below unit 03, remove only the new `notify` subtree.
For downgrade below unit 01, remove the new Unix-mode API config, or restore
the prior private TCP API config if one existed. Do not delete an existing
Fleet `api` subtree blindly, as historical R7 rollback text suggested.
Never delete stores to make startup succeed. No schema downgrade in place.

## Material decisions and limits

No unresolved product-policy decision is identified. The Unix config spelling,
conservative offline echo check and proposed finite host/field limits are
implementation choices for independent plan review, not renewed owner design
questions. A requirement to expose notification producers over the existing
TCP Fleet endpoint would change R7's producer boundary and needs an explicit
scope decision; this plan does not do that.

The main implementation uncertainties have direct owning checks: Node/Bun
compatibility for bounded HTTP/SSE in unit 01; cancellation and shutdown
settlement in units 02/03; source identity and literal projection in unit 03.
If a required native HTTP bound cannot be demonstrated on Bun 1.4.4, stop that
unit with the failing local case and smallest in-process correction. Do not
substitute an external proxy, new service or public listener.

The independent source-integration assessment has been read and its three
material integration decisions incorporated. Its socket-mode, store-privacy,
literal-projection and regression-test details are included in the owning
tasks. Its author must still review the completed plan independently. This
author's notes and the source assessment are not delivery-plan approval.
