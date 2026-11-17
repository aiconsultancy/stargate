# Crew result recovery

An OpenCode worker's successful final answer is enough to finish its task.
The worker can still call `stargate_crew complete`, but a missed tool call does not
require a human to supply message IDs, hashes or a copied result.

The captain's `status`, `wait` and next `dispatch` check recover results from
idle workers. A check of a queued task can also recover the previous task
before promoting the captain-selected task. FIFO is default guidance that the
captain can override; other queued tasks stay unchanged. This adds no background queue scheduler
or send an unsolicited Slack reply.

## Result selection

### OpenCode

Stargate checks the existing worker session's identity and successful native
execution outcome. It reads that session's messages backwards through the
authenticated OpenCode API until it reaches the saved task `inputID`. The input
must contain the original task envelope and captain metadata. The last completed
assistant answer must belong to that worker. Task-scoped synthetic urgency
notices keep the original result boundary when their target task and captain
metadata match. A later user input, unrelated synthetic input or standalone
shell input prevents selection of an unrelated answer.

Native OpenCode instruction-file loads are context within the existing turn,
not new assignments. Result recovery, explicit reconciliation and placement
checks recognise only the bounded native synthetic format: exact
`instruction.paths` metadata, ordered matching `Instructions from:` headers and
the native `Loaded ...` description. Malformed or ambiguous records and other
synthetic, user or shell input remain task boundaries. This recognises the
native history format, not authenticity of repository content; instruction text
never grants approval or changes the original task/session binding. History is
read without rewriting, resubmitting or replaying work.

Normal skill, compaction and model records do not prevent recovery. Only visible
answer text is stored, up to 64,000 characters, as for Pi worker results. Stargate
does not use private reasoning as a result.

Recovery can complete `running` and `uncertain` tasks. It updates only the same
retained task tuple and status; concurrent explicit completion takes precedence.
The next dispatch can reuse the original worker session after recovery. No
assignment is resubmitted, and no session is created, replaced or interrupted
by result recovery.

### Pi Durable

New Pi tasks submit their saved task `inputID` as the native request key.
Stargate saves the task's native conversation binding before admission. Tools-off
reports still use a fresh isolated conversation, not the maintenance context.

After restart, recovery reads the exact request receipt through the Pi SDK in
read-only mode. A matching completed input and its canonical answer can finish
the same retained crew task without another submission or provider request.
The absence of an in-memory execution is not proof that the task failed.

Queued, placed, unanswered, missing or unreadable receipts do not become
successful results. Read-only recovery does not resume native work. Older tasks
without a durable conversation binding remain recovery-required; Stargate does not
guess from another conversation's answer. A released or abandoned task cannot
be revived by a late receipt.

## When a result is not available

An active worker remains active. An interrupted or failed worker, a missing
answer, a changed task boundary or unavailable history returns an `uncertain`
status with a `diagnostic`. The diagnostic identifies the task and worker session
and gives the next action. For a temporary read failure, retry `status`. A later
successful final answer can recover the same uncertain task. Interrupted work
does not restart automatically.

The plugin uses the existing same-server history connection. Managed discovery
does not start another OpenCode server. If discovery is unavailable, configure
`team.historyAPI` for the existing server. History reads use the caller's abort
signal and a ten-second recovery timeout. Stargate does not query the OpenCode
runtime database directly. Pi receipt recovery uses the installed SDK's
read-only harness mode, not hand-written queries against native tables. The
storage adapter still checks its schema; review that path when upgrading Pi.

## Admission and completion protocol

Stargate reserves the task and its input identity before native admission. A lost
OpenCode response is checked against that exact inbox/history identity, never
by sending the assignment again. Admission can still mean queued, not started.
Cancellation withdraws the task's own queued input before considering an
interrupt; unrelated native input is not evidence of this task's execution.

A temporary observation failure must not prevent the authenticated assigned
worker from completing its current, unreleased task. Completion persists the
result before acknowledgement. An identical completion retry is idempotent;
stale, replaced and abandoned tasks cannot complete a new assignment.

## Captain-controlled recovery

An unknown outcome is not proof of failure or success. It also must not require
operator SQL to release a blocked crew slot. Captains use the existing
`stargate_crew` tool; workers and foreign or child sessions cannot use these controls.

1. Inspect the member and its exact task ownership. Local state remains readable
   when native execution is unknown.
2. Try `status` or verified result reconciliation first. Keep a completed result;
   do not abandon it because another task is blocked.
3. Inspect workspace changes and save work that must be kept.
4. Explicitly abandon the exact blocked task, with a reason and retry key.
5. Dispatch fresh work only after the normal native-idle checks pass. Abandoning
   a task does not promote its FIFO queue or replay the assignment.

```js
stargate_crew({ op: "inspect", crew: "bosun" });
stargate_crew({ op: "workspace", crew: "bosun", patch: true });
stargate_crew({
  op: "abandon",
  taskID: "task_FROM_INSPECTION",
  expected: {
    status: "uncertain",
    workerSessionID: "SESSION_FROM_INSPECTION",
    originCaptainID: "CAPTAIN_FROM_INSPECTION",
    inputID: "INPUT_FROM_INSPECTION",
    controlID: null,
  },
  reason: "Interrupted task reviewed; preserve its work and release the slot.",
  key: "bosun-recovery-1",
  acknowledgeUnconfirmedStop: true,
});
```

Copy the expected tuple and `controlID` from inspection; do not guess them.
Passing a stale tuple fails. An exact retry returns the retained abandonment
audit. A control still held by an operation in this process cannot be stolen;
clearing an orphan reservation needs its exact inspected control ID.

Abandonment records terminal `abandoned` task state, not successful execution.
The audit retains the previous status and result, original captain, reason,
retry key and stop evidence. Native stop can be pending, confirmed or
unconfirmed. The original task, history, mail, notices and queued work remain.
Idle execution alone never supplies a successful result.

### Workspace controls

Workspace inspection is read-only and uses only the member's configured Git
worktree. Foreign, nested and symlinked worktrees are refused. The optional
patch is bounded and excludes common credential file paths; this is not a
complete secret detector. Do not publish secrets from workspace output.

Stash and reset require the current HEAD, workspace fingerprint and active task
ID returned by inspection. They hold the worker control slot and refuse active
Stargate work. If native idle cannot be confirmed, the captain must explicitly set
`acknowledgeUnconfirmedExecution: true`.

```js
stargate_crew({
  op: "stash",
  crew: "bosun",
  expected: {
    head: "HEAD_FROM_WORKSPACE_INSPECTION",
    fingerprint: "FINGERPRINT_FROM_WORKSPACE_INSPECTION",
    taskID: null,
  },
  acknowledgeUnconfirmedExecution: true,
});
```

Stash includes staged, unstaged and untracked changes, but not ignored files.
The result includes the exact checkpoint OID and its restore command:
`git -C <worktree> stash apply --index <oid>`.

Reset uses `op: "reset"` with the same inspected values and
`acknowledgeDiscard: true`. It first stores a recoverable tracked-change
checkpoint, then resets to the current HEAD. It never runs `git clean`, drops a
stash, changes branches or restores work automatically. Untracked or ignored
paths that obstruct HEAD are refused before either stash or reset writes.
Resolve those obstructions without discarding their contents.
Submodules and nested repositories are refused for both mutations.

Fingerprint checks and Stargate control slots do not provide filesystem isolation.
Native processes can still write concurrently, especially when execution is
unknown. An acknowledgement accepts that limit; it does not prove a stop.
Read-only Git commands have a deadline. Once a mutating Git command starts,
Stargate lets it finish rather than killing it on an arbitrary timer. Cancellation
is checked before the write; it cannot undo a write already in progress. Inspect
the resulting workspace and checkpoint before retrying an interrupted request.

## Storage compatibility

Recovery adds `task_abandonments`, `pi_task_conversations`, `mail_intents` and
`mail_route_holes` to the existing private crew database. Existing task rows,
results, session IDs, journals and mailbox cursors are retained. No task is
abandoned or workspace changed automatically during installation.

The old task-status constraint also needs a one-time transactional table
rebuild to admit `abandoned` and `cancelled`. It preserves row IDs and checks
foreign keys before committing. Back up private crew state before upgrading.
Existing uncertain tasks remain unchanged until explicitly recovered.
