# State machines

Stargate has state machines in persistent rows, promises, timers, and session
mappings. This inventory describes the transitions without adding a state
machine framework. The existing owners must keep each transition valid.

## Gateway and process

| Owner                          | States and transitions                                                   | Required invariant                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `routing.ts`, `Gateway.accept` | Unknown thread → accepted mention or DM → followed thread                | Validate app, workspace, user, and channel before admission. Reject bot messages.                                                         |
| `store.ts`, `Gateway.process`  | Queued → running → responding → done or failed                           | Persist before ACK. Run only the first unfinished job per conversation.                                                                   |
| `Gateway.work`                 | Available slot → active conversation → released slot                     | One fiber per conversation in a scoped `FiberMap`, and one worker per job; turns and catch-ups share the bot concurrency limit.           |
| Session mapping                | Missing → created → persisted → reused                                   | Reuse only within the full bot/backend/channel/thread namespace.                                                                          |
| Delivery cursor                | Unsent → confirmed chunk → next chunk; failure → delayed retry or failed | Delivery retries do not call the backend again. Advance only after Slack confirms a write.                                                |
| Restart recovery               | Running → interrupt attempt → responding with uncertainty notice         | Do not replay a turn whose tool outcomes are unknown.                                                                                     |
| Transcript cursor              | NULL → baseline → advance; read failure → retry; lost → next request     | Advance with the reply rows in one transaction. Never backfill a baseline or skip unread history silently.                                |
| `LiveReply`                    | Waiting → visible text → closed; write failure → disabled                | Serialize preview writes. Stop timers before final delivery. Preserve preview timestamps for restart recovery.                            |
| `ActivityDelivery`             | Capturing → finishing → settled; read or delivery failure → settled      | Settled state is absorbing. Retained handles cannot restart timers or backend work, including while cleanup drains.                       |
| Maintenance notice             | Read → publish → acknowledge → consent wait                              | Give read and acknowledgement separate deadlines. Owner cancellation stops both; publication alone does not start the consent window.     |
| Reaction reply                 | No reaction → requested → delivered or failed                            | Target the triggering message. A failed reaction-only reply must not disappear.                                                           |
| File upload (Slack)            | (none) → reserved → uploaded → completing → shared; or unavailable       | A retry before `uploaded` reserves a new ID and uploads again: nothing is public yet. Never repeat a completion with an unknown outcome.  |
| File link (IRC FILEHOST)       | (none) → uploading → uploaded → shared; or unavailable                   | The upload stores the file: never repeat one with an unknown outcome. Only a certain refusal allows another. Post a recorded URL.         |
| `runtime.ts`                   | Locked → connected → serving → intake closed → drained → closed          | Hold one data-directory lock. Start workers after all bots connect. Close all intake, drain all workers, then resources. Failure exits 1. |

An accepted Slack post can precede its SQLite confirmation. That crash window
can produce a duplicate. These transitions do not provide exactly-once external
effects or delivery.

`store.ts` defines the job statuses once (`jobStatuses`) with the method that
makes each transition, and the two sets that queries use: `pendingJobs` (no
reply is stored yet) and `unfinishedJobs` (not delivered or failed yet).
`cron-store.ts` defines `activeRuns` in the same way. Other modules import
these sets; they do not repeat the status names.

Every job transition checks the status that it starts from. `respond` needs
a running job and throws `JobTransitionRefused` otherwise. `finish`, `sent`
and `retry` need a stored reply (`finish` can also fail a queued job) and
return false otherwise; the gateway logs the refusal and writes nothing.

A failed turn stores one fixed cause. A provider or process failure adds its
category, HTTP status and whether work can have run; see
[request failures](../design.md#request-failures).

`attachment-delivery.ts` owns both file rows. It saves the phase before the
step that the phase names and posts one notice for files that become
unavailable.

## Backends and Slack

| Owner              | States and transitions                                                       | Required invariant                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode adapter   | Observe → submit → prove input placement → collect → settle → detach         | Prove preview ownership from history. Withdraw queued input before considering session interruption. Never replay the prompt.                                                                   |
| OpenCode watch     | Subscribe → connected → settle notices → disconnect → delayed reconnect      | Notices only trigger cursor reads. Each connection triggers catch-up; no history polling between events.                                                                                        |
| Pi Durable adapter | Observe → queue → place input → collect through its answer → settle → detach | Use submission entry/answer bounds and live run inputs. Withdraw queued input atomically; do not abort the earlier native run.                                                                  |
| Claude adapter     | Stop orphan → create or resume → stream → result → close input → exit        | One turn per session. Signal a process only after checking start time, user and marker; a group only via its leader.                                                                            |
| Codex adapter      | Stop orphan → start or resume thread → map thread → stream → result → exit   | One turn per thread. Store the thread ID before continuing. Abort the SDK only while its stream is open. Cancel starts the bounded marker clean-up; stop waiting for a stream that outlives it. |
| `SlackConnection`  | Connect → dispatch → persist → ACK → intake closed → disconnect              | ACK accepted events only after durable admission. No ACK after intake closes. Sanitize SDK failures.                                                                                            |
| Reaction parser    | Incomplete prefix → valid directive or literal text                          | Hide only recognized reaction controls; do not expose a partial control as response text.                                                                                                       |
| Waiting override   | Validate → write private temporary file → rename                             | Check cancellation before replacement. Invalid cosmetic settings must not fail a turn.                                                                                                          |
| Markdown chunker   | Outside fence → open fence → split and reopen → closed fence                 | Keep ordinary fences balanced within the Slack message budget.                                                                                                                                  |

## Crew

| Owner                       | States and transitions                                                                          | Required invariant                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Peer identity               | Absent → pending → ready                                                                        | Recover a pending peer with its reserved session ID. Do not silently replace a ready peer whose session is missing or mismatched.    |
| Assignment                  | Queued → dispatching → running → completed; queued → cancelled; active → cancelling → uncertain | Dispatching is not proof of SDK admission. Do not automatically replay uncertain work. Only the assigned worker can complete a task. |
| Admission evidence          | Saved input ID → queued or placed receipt → owned execution/result                              | Reconcile the same ID after a lost response. Withdraw that input before considering interruption; do not stop unrelated native work. |
| Captain abandonment         | Inspect exact owner → audited abandon → terminal abandoned                                      | Preserve results and queue; never promote or replay here. Local abandonment is separate from pending, confirmed or unconfirmed stop. |
| Pi result receipt           | Bind conversation → submit task input ID → native done → crew result                            | Recover only the exact canonical answer through a read-only harness. Missing process-local execution is not proof of failure.        |
| Worker control              | Free → token reserved → operation → free                                                        | A reservation excludes dispatch and promotion. A crash-held reservation needs reconciliation.                                        |
| Pi harness ownership        | Resolve path → wait for prior close → acquire → release                                         | Recheck owner state after awaits. A closed owner cannot register a lease or keep a replacement harness open.                         |
| Urgent delivery             | Active → notification reserved → steer → notification released                                  | Pending notifications block slot release. Failed delivery reports notification uncertainty without changing assignment state.        |
| Mail                        | Authorize intent → send → bind receipt and route → read → acknowledge cursor                    | Bind one event per intent. Keep send keys stable. Explicit ACK cannot cross a known unresolved route hole.                           |
| Workspace recovery          | Inspect → validate fingerprint → reserve control → checkpoint → stash or reset                  | Captain only; configured Git root only. Preserve ignored data, refuse path obstructions and stale ownership, and retain checkpoints. |
| Compaction and model switch | Idle → control reserved → stream connected → admitted → started → ended → model switch          | Switch only after confirmed compaction. On failure, interrupt work, keep the model, and release control.                             |
| History traversal           | Session page → authorized session → message pages → next session                                | Bound the cursor and recheck visibility. Reject foreign sessions and query-mismatched cursors.                                       |
| Profile initialization      | Validate → inspect or create worktrees → inspect config → write                                 | Reuse identical files. Refuse conflicts and tracked files. Retain partial setup after failure.                                       |
| Crew waiting setting        | Authorize captain → persist delay or off → apply on next turn                                   | Workers cannot change captain settings.                                                                                              |

Crew state belongs to `crew/execution/state.ts` and `crew/execution/engine.ts`. The other owners
are `crew/messaging/mesij.ts`, `crew/compaction.ts`, `crew/controls/models.ts`, `crew/history.ts`,
`crew/controls/waiting.ts`, and `profile.ts`.

A dispatching reservation left after a process interruption does not prove SDK
admission. An idle session alone cannot distinguish it from live admission.
Cancel the wait or reconcile the task; do not release or replay it automatically.

## Scheduling and administration

| Owner                | States and transitions                                                      | Required invariant                                                                                                 |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Cron run             | Claim → announce thread → enqueue gateway job → terminal                    | Preserve the run claim and thread identity. Recovery must not blindly repeat uncertain announcement or agent work. |
| Cron clock           | Due occurrence → claimed occurrence → next occurrence                       | Guard ticks and persist the schedule cursor so overlapping ticks do not claim twice.                               |
| Cron UI              | Open list → edit or confirm → authorize → persist → ACK → refresh           | ACK once. Persist a removal before acknowledgement, including when the ACK fails. Deduplicate retried submissions. |
| Provisioning journal | Planned → create requested → created or uncertain → reconciled → registered | Do not blindly repeat an ambiguous app creation. Respect cooldowns and reconcile before registration.              |
| Setup writer         | Unlocked → locked → credential/config writes → unlocked                     | Keep tokens private. Refuse conflicting writes. Credential and config writes are not one atomic transaction.       |
| Hidden token input   | Normal terminal → hidden input → restored terminal                          | Restore terminal mode on success, cancellation, and failure.                                                       |
| User service         | Installed → manager reloaded; disabled/stopped → unit removed → reloaded    | Installation does not enable or start the service. Surface failed manager operations.                              |
| CLI                  | Parse → validate → dispatch; help → exit                                    | Validate before side effects. Do not accept persistent credentials as arguments.                                   |

Owners are `cron.ts`, `cron-store.ts`, `cron-ui.ts`, `provision.ts`,
`setup.ts`, `service.ts`, and `cli.ts`.

## IRC

| Owner                  | States and transitions                                                                               | Required invariant                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `IrcClient` connection | Closed → connected → capabilities → (SASL) → welcomed → registered; any → closed → delayed reconnect | Reset every per-connection field in one place. A callback of an earlier socket changes nothing. A refused login waits its own fixed delay. |
| Catch-up cursor        | No cursor → baseline → forward only                                                                  | Resume CHATHISTORY after the newest server time seen for the target. Only operator repair moves a cursor back.                             |
| Line delivery          | Chunk planned → units confirmed one by one → chunk sent                                              | The first plan of a chunk wins. A retry sends only the units after the confirmed count.                                                    |
| Stop reaction          | Active turn → Stop requested → settled                                                               | The transport checks who may stop. The gateway then settles the turn as for a Slack Stop.                                                  |
| `stargate_dm` copy     | Receipt recorded → copy sent → recognised by the recipient connection                                | Record the receipt ID before the copy is sent, so the copy is never admitted as a second turn.                                             |

Owners are `irc/client.ts`, `irc/ship.ts`, `irc/delivery.ts` and the
`irc_cursors`, `delivery_units` and `irc_stargate_dm` tables in `store.ts`.

## Maintenance

| Owner          | States and transitions                                                                                                                   | Required invariant                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Run            | Recover → discover → prepare → idle gate → agent CLIs → stop gateway → proxy → OpenCode restart → live sessions → start gateway → commit | Check idle again immediately before each step that changes live state. Busy or out of time: undo this run's changes and defer.  |
| Undo journal   | No entry → entry written before its change → entry cleared after verification                                                            | An entry means that an undo is owed. A corrupt journal is never undone. Commit the release before the gateway entry is cleared. |
| Idle gate      | Busy or unknown → idle, at gateway scope or Stargate scope                                                                               | Read-only. Unknown is busy. Gateway scope for a gateway restart; Stargate scope for all else. Sessions of others never block.   |
| Gateway update | Same plugin digest → gateway idle → stop gateway → switch → start gateway → commit                                                       | Only when no other change is due. Unknown digest: full run. Keep the release that OpenCode still runs.                          |
| Update now     | Checks → transient unit → stage and verify → stop gateway → switch → restart → ready → commit                                            | No window, idle gate or cool-off. Stargate release only. Refuse a downgrade, a leftover journal and a known-bad release.        |
| Summary outbox | `.json` → `.claimed` → `.sent`, `.failed` or `.refused`                                                                                  | Claim by rename before the post. A claimed summary is never posted again, also after a crash.                                   |

Owners are `maintenance/nightly/run.ts`, `maintenance/nightly/journal.ts`, `maintenance/nightly/schedule/idle.ts`,
`maintenance/nightly/update/plugin-digest.ts` and `maintenance/nightly/reports/outbox.ts`. See [maintenance](../maintenance.md).

## Transition regressions

An earlier transition audit identified three concrete failures:

- Pi observer callbacks could include old assistant text before the history
  baseline was established. Establish the baseline from both the attachment
  snapshot and pre-resolution advances before collecting the current answer.
- A concurrent crew waiter could treat a dispatching task's idle session as
  evidence of interruption while prompt admission was still pending. Idle
  observation must distinguish dispatching from admitted running work.
- Cron removal was acknowledged before it was durable. A failed ACK or a crash
  in that window could leave the schedule enabled.

Follow-up regressions cover these lifecycle boundaries:

- A Pi owner can close while acquisition waits for path resolution or the
  previous harness close. Check ownership again before registering a lease.
- A retained activity handle could start a grace timer after terminal cleanup.
  Mark it settled before asynchronous cleanup; later `finish()` and `cancel()`
  calls do nothing.
- Maintenance publication can outlast the read deadline. Give the delivered
  acknowledgement a fresh deadline linked to the same owner signal. A cancelled
  owner must not acknowledge publication or restore active consent.
- Both adapters can attach while earlier native work is busy. Attachment time
  does not prove input ownership. OpenCode checks transcript placement before
  publishing a preview; Pi uses submission entry/answer bounds and live run
  input IDs. Cancelling a queued follow-up must not stop the earlier native run.
- Crew admission can lose a receipt even though the saved input was accepted.
  Reconcile inbox/history by that identity, without another prompt. A temporary
  observation failure cannot invalidate the assigned worker's later completion.
- Pi can commit an answer before the process records crew completion. A durable
  task/conversation binding and exact read-only receipt recover that result.
- Mesij can store mail before its route receipt returns. Authorized send intents,
  one-event receipt binding and durable ACK barriers prevent a route gap from
  silently acknowledging past that message.
- Explicit captain abandonment is terminal, including in status views. A late
  completion or recovery cannot revive it; native stop evidence stays separate.
- Git stash and reset can delete untracked path obstructions while restoring
  HEAD. Refuse those obstructions before writing, including ignored children.

Placed-input interruption is still session-wide. A later native turn can start
before interruption reaches it. Correlation IDs created before admission let
cleanup recover a lost response without resubmitting. If ownership or placement
cannot be read, do not guess, interrupt unrelated work, or replay it.
See [cancellation limits](../cancellation.md#limits).

The tests for these boundaries use local fixtures. They do not require Slack
credentials or paid model calls. The other transitions keep their existing
representations; the audit does not justify a general state-machine framework.
