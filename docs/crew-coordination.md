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
Pogo addresses stay short, for example `adama` and `apollo`. An optional `agent`
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

Each crew member has one permanent worktree named after its member ID. Task
branches change inside that worktree; tasks do not get replacement worktrees or
crew sessions. Temporary work in tmp directories is allowed without moving the
session. Existing legacy folder names need an explicit migration that preserves
their work, branches and session identity.

## Tools

```js
pogo_crew({ op: "roster" });
pogo_journal({ op: "append", text: "Focused tests passed; review remains." });
pogo_journal({ op: "read", after: 42, limit: 20 });
pogo_mail({ op: "send", to: "apollo", text: "Review when free." });
pogo_mail({ op: "inbox", after: 123, limit: 20 });
pogo_dm({
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

Before sending, Pogo saves the authorized route intent and an envelope hash,
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
OpenCode queue while busy is stored-only/unsupported. Pi uses native steer or
follow-up. Other-captain work, uncertain work and worker controls defer delivery.
Unprovisioned workers get only a reserved mailbox, not a new agent session.
Native failure never changes task state or discards mail. Retry only the same
admission identity: OpenCode `msg_<Mesij ID>`, Pi `requestId=<Mesij ID>`.
Cancellation can withdraw Pi follow-ups; durable mail remains, without replay.
`pogo_crew urgent` is a compatibility entry point to explicit DM.

Use mail/DM with `replyTo` for peer answers. A final answer remains the assigned
task result. Native task-marked notices instruct a worker to restate that result
if it had already finished. Captain task notices also support an existing wait.
Free-worker notification reuses the existing durable control reservation. A
process crash can retain that control and block dispatch. A captain can inspect
the exact reservation and explicitly abandon its blocked task with an audit;
a control still held by an operation in this process cannot be cleared. Pogo
never clears another controller automatically or adds a lock lease. See
[captain recovery](crew-recovery.md#captain-controlled-recovery); do not edit
the database to clear a slot.

## Native clients

Prefer Pogo tools when adequate. Use authentic existing OpenCode/Pi APIs for
recoverable gaps within existing scope and authority. Do not start another Pi
storage owner, read OpenCode's database, change global credentials, create extra
roots or replay uncertain tools. Record concrete deficiencies and successful
workarounds through ordinary journal notes. Escalate only a remaining blocker
that needs operator authority or input.

OpenCode retains scoped `pogo_history`. Pi exposes self-only `pi_history` through
its current live conversation's native paginated `Conversation.entries`; this
does not start work. There is no unified Pi `pogo_history` in this release.
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
API when needed; keep their history and Pogo task/member IDs. Runtime checks
accept only the mapped native name or that member's original short native
name during this migration, with unchanged session/directory/namespace checks.
Historical final answers with the original short agent name remain recoverable.
Gateway backend agent settings select the captain's native definition. Worktree
paths can remain. No automatic live reset or state deletion is performed.
