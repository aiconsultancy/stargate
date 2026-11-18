# Architecture review and Effect adoption

Review date: 2026-11-08. Baseline: merged `489bf2e` plus the installed
maintenance, manual reconciliation and status-request composition from
release `489bf2e-galactica` (commit `fd375c8`). The review covered the
supported installation, not only `main`.

## Scope

The review followed each flow end to end:

1. CLI, setup, provisioning, strict configuration and environment references.
2. Process ownership: instance lock, stores, Slack connections, backends,
   workers, signals and cleanup (`runtime.ts`).
3. Slack intake: Socket Mode dispatch, ACK, access rules, bot rejection,
   app/workspace/channel/thread isolation (`slack.ts`, `routing.ts`).
4. Durable queue: admission before ACK, per-conversation ordering, delivery
   cursor, retry, restart recovery (`store.ts`, `gateway.ts`).
5. Turn execution: streaming previews, waiting feedback, Stop, timeout
   budget, maintenance notices, reactions, transcript continuation and
   catch-up (`gateway.ts`, `streaming.ts`, `maintenance-delivery.ts`).
6. Adapters: OpenCode V2 client, Pi Durable harness, trusted modules
   (`backend.ts`, `backends/`).
7. Crew plugin inside OpenCode: tasks, sessions, native API fallback,
   history, models, compaction, mail/DM, journals, activity reporting, ways
   of working, maintenance gate, inspection and manual reconciliation
   (`crew/`).
8. Scheduled prompts, crew status modal, pairing (`cron*.ts`, `crew-ui.ts`,
   `pairing.ts`).

## Findings

Severity: **high** can lose requests or leave the service down; **medium**
can leak resources or block recovery; **low** is a maintainability or
defence-in-depth issue.

| ID  | Severity | Finding                                                                                                                                                                                                                                                                                                                                          | Status                                                                                                                                                                             |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | high     | A stopped gateway or cron worker aborted the process, but `start()` then resolved normally. Stargate exited with code 0, so systemd `Restart=on-failure` did not restart it.                                                                                                                                                                     | Fixed: any failure after startup, including a failed release, fails the program with `RuntimeStopped`; `main.ts` sets exit code 1.                                                 |
| F2  | high     | During shutdown, `accept` returned `false` for every event, and `handleSlackRequest` then sent the ACK. Slack treated unpersisted events as delivered.                                                                                                                                                                                           | Fixed: one intake gate is shared by every bot. When it closes, no bot sends an ACK, so Slack redelivers to the next connection.                                                    |
| F3  | high     | Shutdown drained workers and closed backends while Socket Mode connections still accepted events. With several bots, each intake closed only just before its own workers drained, so another bot could still accept work and start a turn that was then interrupted.                                                                             | Fixed: the shared intake finalizer runs first and closes every bot. One fiber holds all workers, so shutdown interrupts and drains them together; backends and stores close after. |
| F4  | medium   | If the worker poll threw (for example `SQLITE_BUSY`), `Gateway.work` waited for the transcript watch, which only stops on the shutdown signal. The worker hung without an error.                                                                                                                                                                 | Fixed: the watch is a scoped fiber; a failed poll closes the scope, aborts the watch and rejects.                                                                                  |
| F5  | medium   | `void this.catchUp(signal)` could reject without a handler. Bun prints unhandled rejections raw, which conflicts with the rule to never log raw SDK errors.                                                                                                                                                                                      | Fixed: catch-ups run in the supervised slot map; failures are handled in the fiber.                                                                                                |
| F6  | medium   | Plugin cleanup disposed registrations in sequence inside one `try`. One failed dispose skipped the remaining registrations; only the engine close was in `finally`.                                                                                                                                                                              | Fixed: one resource scope runs every release in reverse order and reports a failure afterwards.                                                                                    |
| F7  | medium   | The process-wide Pi harness pool cached a rejected open. Every later Pi operation failed until restart.                                                                                                                                                                                                                                          | Fixed: failed opens are evicted and retried.                                                                                                                                       |
| F8  | medium   | When the last owner closed a pooled Pi harness, a new owner could open a second harness on the same Pi SQLite store before the close finished.                                                                                                                                                                                                   | Fixed: a reopen waits for the previous close of the same store.                                                                                                                    |
| F9  | medium   | Startup recovery interrupts sessions with running jobs. A deleted OpenCode session made every startup fail.                                                                                                                                                                                                                                      | Fixed: a typed `SessionNotFoundError` means nothing can survive; other interrupt errors still fail startup and now restart the service.                                            |
| F10 | low      | Plugin tools repeated the permission check and error mapping eight times.                                                                                                                                                                                                                                                                        | Fixed: one guard.                                                                                                                                                                  |
| F11 | high     | Workers could start before every Slack connection succeeded: the original runtime for every bot after the first, and the first Effect draft for all bots. When a later connection failed, a worker had already prompted a queued request and recorded it as interrupted, so outages with service restarts consumed queued requests as uncertain. | Fixed: workers start only after all bots connect. A startup failure leaves queued requests queued and starts no turn.                                                              |
| O1  | low      | `Gateway.process` is a long sequential state machine with many mutable variables. Tests cover it heavily.                                                                                                                                                                                                                                        | Partly done: delivery is `Gateway.deliver`; files are in `attachment-delivery.ts`. Keep the turn half (`processTurn`) whole until a behaviour change needs a split.                |
| O2  | low      | `ActivityDelivery` hand-manages abort controllers, wake controllers and grace timers. No defect was found.                                                                                                                                                                                                                                       | Follow-up fixed late terminal callbacks with settled guards. Keep the existing Promise lifetime; no scope rewrite is needed.                                                       |
| O3  | low      | `CrewEngine.wait` polls SQLite every 25 ms per waiting call.                                                                                                                                                                                                                                                                                     | Open. Acceptable at current crew sizes.                                                                                                                                            |
| O4  | low      | `CrewReporter.advance` starts a summary job with the RPC request signal. If the host aborts request signals after a response, the summary fails closed as `unavailable`.                                                                                                                                                                         | Fixed: accepted jobs use owned cancellation. Capture cancel and reporter close abort and drain jobs; verification rechecks closure after awaiting the captain.                     |
| O5  | low      | `repairThread` opens `stargate.sqlite` outside `start()`, so the process umask is not forced to `0077`. Normal service units set `UMask=0077`.                                                                                                                                                                                                   | Fixed: restrict the existing directory and database before SQLite opens. Refuse missing databases and symlink targets; do not change the process umask.                            |

The original architecture pass needed no change to the backend contract, CLI, configuration,
SQLite schema or Slack scopes.

## Effect design

### Version

`effect` is pinned to **4.1.0**, the exact version that the installed
`@opencode/plugin` 2.2.7 requires and `@opencode/client` 2.2.7 declares as a peer.
Stargate and the SDK then load one Effect runtime.
Upgrade Effect together with the OpenCode SDK; a dependency test enforces the
match. API usage follows the Effect 4 documentation at
<https://effect.website/docs/v4> and the installed declarations.

### Where Effect owns behaviour

| Boundary             | Effect construct                                                                                          | Reason                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime.ts` `serve` | `Effect.scoped`, `acquireRelease`, `addFinalizer`, `forkScoped`, `Deferred`, `raceFirst`, `timeoutOption` | One ordered lifetime for lock, stores, intake, workers and backends. Worker failure is a typed failure (`RuntimeStopped`).           |
| `Gateway.work`       | `FiberMap` keyed by conversation, `Schedule.spaced`, scoped watch fiber                                   | Per-conversation exclusivity and the concurrency limit are one structure. Scope close interrupts and drains every turn and catch-up. |
| Crew plugin setup    | `resourceScope` (Effect `Scope`)                                                                          | The host accepts one cleanup callback; the scope guarantees complete, ordered, idempotent release.                                   |
| Interop              | `abortable`, `runAbortable`                                                                               | Promise modules keep `AbortSignal`; interruption aborts the signal and waits until the Promise settles.                              |

`abortable` exists because `Effect.promise` and `Effect.tryPromise` resume an
interrupted fiber without waiting for the Promise. A turn would then keep
running and write to SQLite after the store closed. `abortable` aborts the
signal and keeps the fiber in its finalizer until the Promise settles. This
preserves the existing rule: cancelling a wait also stops agent work, and the
cleanup completes before the owning scope closes.

### What stays Promise-based

These modules keep plain TypeScript, Bun SQLite and `AbortSignal`. Validation
now follows the separate [Effect Schema migration](effect-schema-migration.md);
the original lifecycle adoption retained Zod to limit its scope.

- Pure logic: routing, access, chunking, formatting, reaction parsing,
  configuration schemas, cron validation.
- SQLite stores. Each method is a synchronous transaction; Effect would add
  no safety.
- The backend adapter contract and both adapters. Trusted modules implement
  the Promise interface; `TranscriptUnavailable` keeps its constructor and
  `instanceof` behaviour.
- `Gateway.process`, `LiveReply`, `ActivityDelivery`, maintenance delivery
  and the crew engine. They run inside supervised fibers and already honour
  their signals. Converting them changes no behaviour and has a high
  regression risk (see O1 and O2).
- Crew errors stay `CrewError`. The plugin guard maps them to tool messages;
  all other errors become fixed messages without raw details.

Rule for later work: use Effect where a module owns several concurrent tasks
or resources with a lifetime. Keep pure functions and single transactions
plain. Do not add service layers, queues or registries.

## Preserved behaviour

- Accepted events are persisted before ACK. Events that arrive after intake
  closes get no ACK, for any bot.
- One active turn or catch-up per conversation; the bot concurrency limit
  counts both.
- Delivery retries use the stored response and never call the backend.
- Running work after a crash is interrupted and reported, never replayed.
- Shutdown aborts each turn's signal; the turn records its `interrupted`
  outcome before the store closes. The transcript watch is read-only;
  stopping it never interrupts a session.
- Shared Pi harnesses close only when their last plugin owner closes.
- No exactly-once claim for side effects or Slack delivery.

## Rollout and migration

No configuration, CLI, database or Slack manifest change. Deploy as a normal
release and restart only the Stargate gateway. Update crew plugin package paths at
an idle boundary; OpenCode reloads those plugins without a server restart.
Restart OpenCode only for a confirmed unhealthy service. Behaviour differences
an operator can see:

- A failure after startup now ends the process with exit code 1 and the
  message "Stargate stopped after a runtime failure". The service manager
  restarts it.
- A startup interrupt failure other than a deleted session also restarts
  the service until OpenCode is reachable, instead of leaving it stopped.
- Slack redelivers events that arrive while Stargate stops, for every bot.
- Queued requests wait until every bot connects. A connection failure at
  startup leaves them queued for the next start.

## Verification

Regression tests use local fixtures, real temporary SQLite and fake Slack and
agent APIs; there are no provider calls.

- `tests/effect.test.ts`: interruption waits for Promise cleanup; typed and
  defect failures; ordered scope release after a failed release.
- `tests/runtime.test.ts`: shutdown order and no ACK after intake closes;
  worker failure rejects with `RuntimeStopped`; a startup failure releases
  bots that already connected; a failed Slack connection starts no queued
  turn; with two bots, every intake closes before any backend closes and a
  job that becomes ready during the drain does not start.
- `tests/gateway.test.ts`: a failed poll stops the watch and rejects; a
  running turn records its interruption during shutdown.
- `tests/transcript-opencode.test.ts`: interrupting a deleted session; watch
  shutdown sends no interrupt.
- `tests/crew-pi.test.ts`: a failed Pi harness open is retried; a new owner
  opens a Pi store only after the last owner's close finished.
- `tests/dependencies.test.ts`: Effect matches the OpenCode SDK pin.
