# Crew coordination

Configured captain and crew use the same small coordination surface in
OpenCode and coding-enabled Pi crew. Standalone Pi bots get no crew extension.
Pi `tools: "none"` remains tools-off; mail and DM to those members return
unsupported without storing unreadable messages. Reports remain tools-off.
Pi mail is limited to 40 KiB of JSON-encoded text so one message cannot block
inbox paging at the native output ceiling. Oversized sends are not stored.

## Identities and working agreement

Generated native agent IDs and definition filenames use `<ship>-<role>-<name>`, for
example `galactica-captain-adama.md`, `galactica-crew-apollo.md` and
`pegasus-crew-apollo.md`. Use `crew init --id galactica` to select the namespace.
Native IDs remain at most 64 characters; generation rejects longer combinations.
Stargate addresses stay short, for example `adama` and `apollo`. An optional `agent`
on the existing configured member maps that short ID to its native definition.
Generated profiles fill this mapping; direct legacy configurations default it
to the short ID. No address registry or hidden old-ID aliases are introduced.

`captain` aliases the configured captain ID. Both use the originating captain
task or a validated message reply, never the latest Slack thread. `all` expands
configured captain and crew except the sender. Direct self-send is refused.
Reserved aliases cannot name crew members. Replies target the sender, not all.

Initialization creates `<captainDirectory>/WAYS_OF_WORKING.md` only if absent.
Captain maintains it; crew propose changes by mail or journal notes. Every
generated agent definition and Pi member instruction references this same path.
Read it initially and reread it when updated. Contents are not injected or sent
again each turn. Reports do not gain tools or repeat the file contents.
Native request hooks compare file content per member/session. Initial and
unchanged observations are silent. An edit adds one brief path/reread notice;
read failures preserve the last known version without deletion notices.
Pi definitions live in the captain's `.local/ship/definitions/<native ID>.md`.
The backend reads that trusted definition when it opens. Initialization preserves
edits; it does not create an unused OpenCode agent for a Pi member.
Working agreements never override operator instructions or permissions.
Historical Markdown journals remain; new milestone notes use SQLite.

Each crew member has one permanent worktree per configured project, named after its member ID. Task
branches change inside that worktree; tasks do not get replacement worktrees or
crew sessions. Temporary work in tmp directories is allowed without moving the
session. Existing legacy folder names need an explicit migration that preserves
their work, branches and session identity.

## Optional additional projects

The default crew context keeps its existing `projectDirectory`, permanent
`worktrees`, native captain pin and state identity. An optional `projects`
registry adds explicit repository contexts; it does not move that captain root,
rewrite an existing worker, change a model or expand a native permission grant.
The captain's original `captainDirectory` can differ from the selected
`projectDirectory`. Prepare each checkout and permanent worktree outside the
plugin, then add only their exact canonical paths to trusted plugin options:

```json
{
  "projects": {
    "library": {
      "projectDirectory": "/home/captain/workspace/library",
      "worktrees": {
        "apollo": "/home/captain/worktrees/apollo/library"
      }
    }
  }
}
```

Include every configured crew member in each project's `worktrees` map. Keys
are lowercase identifiers of at most48 characters, never paths; `default` and
prototype-related keys are reserved. Up to eight additional contexts and fifty
configured member contexts are accepted. The default repository must not be
duplicated under another key. All paths must exist, with distinct non-nested
worker directories and no symbolic-link aliases. Each worker must have the same
Git common directory as its configured project checkout; different project
keys must identify different repositories. Validation performs bounded read-only
Git inspection before opening any context. It never clones, creates a worktree,
changes a branch or resets files.

Captains select a configured key explicitly:

```js
stargate_crew({
  op: "dispatch",
  project: "library",
  crew: "apollo",
  text: "Implement and test the assigned change.",
});
stargate_crew({ op: "status", project: "library", taskID: "task_RETAINED_ID" });
stargate_mail({ op: "inbox", project: "library" });
```

The same optional selector is available on mail, DM, journal, quota, model and
history tools. A captain's omitted selector retains the default context. Reuse
the project key from the task receipt for later captain status/wait/recovery
operations; an unknown key never falls back. Workers can omit it: their actual
persisted native session ID selects their context. A worker cannot switch to
another project's tasks, mailbox or DM route by claiming a key. Unknown workers
and changed native directory/identity are refused. Models and permissions still
come from the existing configured native profile; do not install a worker
definition that contradicts the selected permanent worktree. The protected task
envelope identifies the selected directory and requires that repository's own
instructions. A project selection, message or returned transcript is never human
approval or permission to broaden scope.

Additional contexts use `<stateDirectory>/projects/<key>` and namespace
`<namespace>:project:<key>`. Each has separate persisted worker/native IDs,
task slots, queues and Mesij context. The same logical member may have work in
different projects; those are separate worker contexts. Retries, cancellation,
uncertain outcomes and recovery stay with their original project and input.
Changing a configured directory after state exists fails closed; retain the
old state and use an explicitly commissioned new context rather than deleting
or rebinding it. Existing default fingerprints and IDs are unchanged, including
when the registry is first enabled.

Read-only status reports label each member's project and count member contexts;
the existing twenty-row cap reports truncation, the true total and an exact busy
count across all contexts. Older truncated status producers without that count
are labelled partial on the dashboard. Operator
history includes the owned roots from every context, with project labels on
additional roots. Unknown or cross-context session IDs do not gain access.
Existing cron, post, waiting/maintenance and activity-capture RPCs retain the
default captain scope. Recovery and IRC bind/outbox RPCs accept an optional
project key; each outbox cursor belongs to that one context. An existing IRC
consumer that omits it continues to read only the default outbox. No extra IRC
account, transport, approval route or provider connection is created.

## Tools

```js
stargate_crew({ op: "roster" });
stargate_journal({
  op: "append",
  text: "Focused tests passed; review remains.",
});
stargate_journal({ op: "read", after: 42, limit: 20 });
stargate_mail({ op: "send", to: "apollo", text: "Review when free." });
stargate_mail({ op: "inbox", after: 123, limit: 20 });
stargate_dm({
  op: "send",
  to: "captain",
  text: "Use interface X.",
  replyTo: "MESSAGE_ID",
  delivery: "steer",
});
```

Journal ID, timestamp, identity and optional task context come from the host.
Write concise milestones, checks, blockers and outcomes, not tool transcripts,
prompts, secrets or private reasoning. Read pages by `nextAfter`; queries remain
captain-context scoped. Redaction and a 1,500-character bound apply before storage.
Capture expiry does not delete journal history. Native-workaround feedback is
an ordinary journal note, not a feedback tool, ticket tracker or automatic loop.
Without a current task, crew notes have empty captain context and are readable
only by that member. They do not enter a previous captain's activity box.

Mail and DM use the existing Mesij inbox and message IDs. Optional legacy
`taskID` and `key` remain accepted. Otherwise the host tool-call ID supplies
retry identity. Inbox reads work without an active task; contextual reads filter
other captain roots. Pass `nextAfter` as `after` to acknowledge a page.
`replyTo` must reference validated mail addressed to the caller.
Only dispatching, running or cancelling work supplies current task context.
Completed and uncertain tasks do not select a captain for new messages. A
task-free crew send needs a validated reply. Its inbox can read all mail
addressed to that member; explicit historical task inbox reads remain supported.

Before sending, Stargate saves the authorized route intent and an envelope hash,
not another copy of the message text. If Mesij stores the message but its
response is lost, a later read can restore the route from an exact event/intent
match. Namespace, sender, recipient and task/captain lineage must still match.
Each intent binds to one native receipt ID. Copying an old envelope into a new
event does not authorize another delivery. Unproved older events do not gain
trusted routes automatically.

If a proved route cannot yet be saved, its acknowledgement barrier persists.
Neither `nextAfter` nor a later supplied `after` can pass that known hole.
Saving the route clears the barrier atomically. Recovery does not wake an agent,
and reading a page still does not acknowledge it.

Mail never wakes recipients. DM first stores mail, then requests native steer
or queue delivery. Receipts distinguish storage, native acceptance, unsupported,
deferred, unavailable and uncertain delivery. Acceptance does not prove reading,
execution or an answer. Broadcasts return per-recipient receipts.
Ask captain to coordinate broadcasts when useful; this is not a permission barrier.

Explicit DM can wake the originating captain or a free provisioned colleague.
Same-captain running OpenCode work gets task-marked steer with `resume:false`;
later queued assignments do not block that current-task message or get promoted.
OpenCode queue while busy is stored-only/unsupported. Pi uses native steer or
follow-up. Other-captain work, uncertain work and worker controls defer delivery.
Unprovisioned workers get only a reserved mailbox, not a new agent session.
Native failure never changes task state or discards mail. Retry only the same
admission identity: OpenCode `msg_<Mesij ID>`, Pi `requestId=<Mesij ID>`.
Cancellation can withdraw Pi follow-ups; durable mail remains, without replay.
`stargate_crew urgent` is a compatibility entry point to explicit DM.

Use mail/DM with `replyTo` for peer answers. A final answer remains the assigned
task result. Native task-marked notices instruct a worker to restate that result
if it had already finished. Captain task notices also support an existing wait.
Free-worker notification reuses the existing durable control reservation. A
process crash can retain that control and block dispatch. A captain can inspect
the exact reservation and explicitly abandon its blocked task with an audit;
a control still held by an operation in this process cannot be cleared. Stargate
never clears another controller automatically or adds a lock lease. See
[captain recovery](crew-recovery.md#captain-controlled-recovery); do not edit
the database to clear a slot.

## Task communication protocol

The shared working agreement owns ship policy. Definitions reference that file;
assignments carry task-specific scope, not another copy of the policy. Before
project work, captain and crew read the target checkout's `AGENTS.md`, applicable
nested instructions, guides and required skills. Project instructions own
implementation and delivery rules. Generated Pi definitions name the worker's
project `AGENTS.md` explicitly because their runtime is separate from OpenCode.

Workers acknowledge assignments with task ID, scope and next checkpoint. They
answer captain DMs with `replyTo` at the next safe point: after the current tool
returns with a known outcome, before another mutation, or between independent
work units. One substantive reply can acknowledge and answer; no separate read
receipt or unconditional heartbeat is required. Milestones use mail; urgent
replies use explicit DM. Final task results include revision, checks and limits.

Captain `wait` has one 60-second observation window shared by queued promotion
and running work. A running or queued return leaves the task running or queued;
reply with progress and end the turn, then collect the same task later. Do not
repeat wait in one turn or dispatch it again. Stop and caller cancellation still
stop the underlying work. Gateway timeouts at or below 60 seconds can expire
before this window; the default gateway timeout is 30 minutes. This bounds one
wait, not the model's whole turn or another conversation's response latency.

For an unsolicited completion report, send one concise `stargate_dm` to `captain`
with the task ID and verified outcome **before** `complete` or the final answer.
Completion alone does not wake the captain, and completed tasks cannot select
a captain route for a new send. The captain may briefly see running while the
worker records the result. Stored or deferred mail is not confirmed delivery;
retain the original result for later collection, without resubmitting work.

Background shell completion notices are native context only when retained history
proves a unique prior `shell` launch by the task-owned worker in the same original
task turn. Launch agent identifiers follow the same configured-agent or retained
crew-ID rule as native session and final-answer validation. The callback's job/shell IDs, command and native wrapper must match that
launch. User shell commands, unknown notices, foreign or missing launch witnesses
remain boundaries; callback output stays opaque. A shell exit code is not a worker
final answer. Completion still needs the original task envelope and a successful,
visible native `stop` answer. No history or task is rewritten to supply that proof.

Placement keeps its cheap input scans; only a candidate callback adds a bounded
full-turn history scan (up to 100 pages of 100 records) to prove native ordering.
A complete scan with an unowned callback is superseded by that boundary. Missing
history, pagination failures or exhausted bounds remain unknown. Explicit reconciliation still refuses compaction;
this callback handling adds no resume, replay, cancellation or permission operation.
Read-only review evidence keeps all maker and unsafe-tool checks: a shell callback
cannot make an unsafe shell launch acceptable as a read-only review.

New profile definitions include this protocol. Existing definitions and the
captain-maintained `WAYS_OF_WORKING.md` are not overwritten by deployment; the
OpenCode tool description carries the wait rule to existing captains.

Use these distinct states: stored mail, admitted native delivery, evidenced
reading, correlated answer and persisted or verified task completion. Native
`accepted` means admitted, not read or answered. No acknowledgement proves task
completion, and no final task answer replaces a correlated peer reply.

During active work, captain checks a missed checkpoint or, by default, two
minutes without acknowledgement. Inspect once and send at most one supported
status request, then report the blocker and next action. This working default
does not create a timer service or promise a two-minute response. Deferred,
unsupported or uncertain delivery never justifies replaying an assignment.
FIFO is the default scheduling instruction, not a runtime lock. The captain can
override queued order for priority work. `status` or `wait` selects a queued
task for admission when the worker is idle; new dispatch can also pass queued
work. Explain priority decisions and preserve unselected assignments.
Read-only checks and roll calls do not wait behind queued work: use `inspect`
for a no-wake snapshot, or `stargate_dm` for an actual member reply. An idle member
can receive that DM without promoting or cancelling an older assignment.
Tools-off summaries can also pass queued maintenance when their reporter is idle.
Active or uncertain execution, ownership, controllers and the queue-size bound
remain hard guards; an override never preempts a running task. Do not cancel or
promote unrelated work to obtain a reply. Instructions cannot interrupt a hung provider
or a long synchronous tool.

Improve this agreement from recorded task outcomes through the existing
[ship maintenance workflow](ship-maintenance.md#task-boundary-improvement).

## Native clients

Prefer Stargate tools when adequate. Use authentic existing OpenCode/Pi APIs for
recoverable gaps within existing scope and authority. Do not start another Pi
storage owner, read OpenCode's database, change global credentials, create extra
roots or replay uncertain tools. Record concrete deficiencies and successful
workarounds through ordinary journal notes. Escalate only a remaining blocker
that needs operator authority or input.

OpenCode retains scoped `stargate_history`. Pi exposes self-only `pi_history` through
its current live conversation's native paginated `Conversation.entries`; this
does not start work. There is no unified Pi `stargate_history` in this release.
Pi history returns only bounded, redacted user/assistant text and preserves the
raw page cursor. System/tool records and reasoning are excluded. Native tool
results larger than 50 KiB return a fixed error, not partial JSON or cursors;
retry a read with a smaller limit.

## Activation

Ship the plugin and gateway together, run checks, then use an operator-approved
deployment. Retain explicit reporter configuration when a final summary is
desired, using the short member ID. Back up state before a native-ID migration.
Install namespaced definitions and matching `agent` mappings together. Switch
existing sessions to their mapped native definitions with the supported native
API when needed; keep their history and Stargate task/member IDs. Runtime checks
accept only the mapped native name or that member's original short native
name during this migration, with unchanged session/directory/namespace checks.
Historical final answers with the original short agent name remain recoverable.
Gateway backend agent settings select the captain's native definition. Worktree
paths can remain. No automatic live reset or state deletion is performed.
