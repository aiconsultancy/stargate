# State machines

Pogo has state machines in persistent rows, promises, timers, and session
mappings. This inventory describes the transitions without adding a state
machine framework. The existing owners must keep each transition valid.

## Gateway and process

| Owner                          | States and transitions                                                   | Required invariant                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `routing.ts`, `Gateway.accept` | Unknown thread → accepted mention or DM → followed thread                | Validate app, workspace, user, and channel before admission. Reject bot messages.                                                         |
| `store.ts`, `Gateway.process`  | Queued → running → responding → done or failed                           | Persist before ACK. Run only the first unfinished job per conversation.                                                                   |
| `Gateway.work`                 | Available slot → active conversation → released slot                     | One fiber per conversation in a scoped `FiberMap`; turns and catch-ups share the bot concurrency limit.                                   |
| Session mapping                | Missing → created → persisted → reused                                   | Reuse only within the full bot/backend/channel/thread namespace.                                                                          |
| Delivery cursor                | Unsent → confirmed chunk → next chunk; failure → delayed retry or failed | Delivery retries do not call the backend again. Advance only after Slack confirms a write.                                                |
| Restart recovery               | Running → interrupt attempt → responding with uncertainty notice         | Do not replay a turn whose tool outcomes are unknown.                                                                                     |
| Transcript cursor              | NULL → baseline → advance; read failure → retry; lost → next request     | Advance with the reply rows in one transaction. Never backfill a baseline or skip unread history silently.                                |
| `LiveReply`                    | Waiting → visible text → closed; write failure → disabled                | Serialize preview writes. Stop timers before final delivery. Preserve preview timestamps for restart recovery.                            |
| `ActivityDelivery`             | Capturing → finishing → settled; read or delivery failure → settled      | Settled state is absorbing. Retained handles cannot restart timers or backend work, including while cleanup drains.                       |
| Maintenance notice             | Read → publish → acknowledge → consent wait                              | Give read and acknowledgement separate deadlines. Owner cancellation stops both; publication alone does not start the consent window.     |
| Reaction reply                 | No reaction → requested → delivered or failed                            | Target the triggering message. A failed reaction-only reply must not disappear.                                                           |
| `runtime.ts`                   | Locked → connected → serving → intake closed → drained → closed          | Hold one data-directory lock. Start workers after all bots connect. Close all intake, drain all workers, then resources. Failure exits 1. |

An accepted Slack post can precede its SQLite confirmation. That crash window
can produce a duplicate. These transitions do not provide exactly-once external
effects or delivery.

## Backends and Slack

| Owner              | States and transitions                                                       | Required invariant                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OpenCode adapter   | Observe → submit → prove input placement → collect → settle → detach         | Prove preview ownership from history. Withdraw queued input before considering session interruption. Never replay the prompt.  |
| OpenCode watch     | Subscribe → connected → settle notices → disconnect → delayed reconnect      | Notices only trigger cursor reads. Each connection triggers catch-up; no history polling between events.                       |
| Pi Durable adapter | Observe → queue → place input → collect through its answer → settle → detach | Use submission entry/answer bounds and live run inputs. Withdraw queued input atomically; do not abort the earlier native run. |
| `SlackConnection`  | Connect → dispatch → persist → ACK → intake closed → disconnect              | ACK accepted events only after durable admission. No ACK after intake closes. Sanitize SDK failures.                           |
| Reaction parser    | Incomplete prefix → valid directive or literal text                          | Hide only recognized reaction controls; do not expose a partial control as response text.                                      |
| Waiting override   | Validate → write private temporary file → rename                             | Check cancellation before replacement. Invalid cosmetic settings must not fail a turn.                                         |
| Markdown chunker   | Outside fence → open fence → split and reopen → closed fence                 | Keep ordinary fences balanced within the Slack message budget.                                                                 |

## Crew

| Owner                       | States and transitions                                                                          | Required invariant                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Peer identity               | Absent → pending → ready                                                                        | Recover a pending peer with its reserved session ID. Do not silently replace a ready peer whose session is missing or mismatched.    |
| Assignment                  | Queued → dispatching → running → completed; queued → cancelled; active → cancelling → uncertain | Dispatching is not proof of SDK admission. Do not automatically replay uncertain work. Only the assigned worker can complete a task. |
| Worker control              | Free → token reserved → operation → free                                                        | A reservation excludes dispatch and promotion. A crash-held reservation needs reconciliation.                                        |
| Pi harness ownership        | Resolve path → wait for prior close → acquire → release                                         | Recheck owner state after awaits. A closed owner cannot register a lease or keep a replacement harness open.                         |
| Urgent delivery             | Active → notification reserved → steer → notification released                                  | Pending notifications block slot release. Failed delivery reports notification uncertainty without changing assignment state.        |
| Mail                        | Authorize lineage → register → send or read inbox → acknowledge cursor                          | Keep send keys stable on retry. Advance the durable read cursor only by explicit acknowledgement.                                    |
| Compaction and model switch | Idle → control reserved → stream connected → admitted → started → ended → model switch          | Switch only after confirmed compaction. On failure, interrupt work, keep the model, and release control.                             |
| History traversal           | Session page → authorized session → message pages → next session                                | Bound the cursor and recheck visibility. Reject foreign sessions and query-mismatched cursors.                                       |
| Profile initialization      | Validate → inspect or create worktrees → inspect config → write                                 | Reuse identical files. Refuse conflicts and tracked files. Retain partial setup after failure.                                       |
| Crew waiting setting        | Authorize captain → persist delay or off → apply on next turn                                   | Workers cannot change captain settings.                                                                                              |

Crew state belongs to `crew/state.ts` and `crew/engine.ts`. The other owners
are `crew/mesij.ts`, `crew/compaction.ts`, `crew/models.ts`, `crew/history.ts`,
`crew/waiting.ts`, and `profile.ts`.

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

Placed-input interruption is still session-wide. A later native turn can start
before interruption reaches it. A lost admission response also leaves ownership
uncertain; do not guess an input ID, interrupt unrelated work, or replay it.
See [cancellation limits](../cancellation.md#limits).

The tests for these boundaries use local fixtures. They do not require Slack
credentials or paid model calls. The other transitions keep their existing
representations; the audit does not justify a general state-machine framework.
