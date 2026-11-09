# Pogo design

## Boundaries

```text
One process
  ├─ Bot A: Socket Mode + Web API → routing/access → durable queue
  │                                                ↓
  │                                       OpenCode adapter → V2 server
  └─ Bot B: Socket Mode + Web API → routing/access → durable queue
                                                   ↓
                                          Pi Durable adapter → SDK/SQLite
```

`config.ts` validates input and resolves environment references. `setup.ts`
creates Slack manifests, config, and private credentials. `cli.ts` exposes
interactive and scripted operation. `service.ts` produces Linux user units.

`slack.ts` owns one outbound connection and API client per registration.
`routing.ts` validates Slack payloads, checks identity and access, and builds
conversation keys. `gateway.ts` runs independent workers. `store.ts` owns
the queue, delivery cursor, and session mappings. `runtime.ts` owns startup,
the exclusive process lock, cancellation, and resource cleanup.

No shared agent implementation depends on Slack. No Slack implementation
depends on a particular agent protocol. Effect 4 owns lifetimes and
concurrency: the process scope in `runtime.ts`, the per-conversation worker
slots in `Gateway.work`, and the crew plugin's resource scope. Pure logic,
SQLite stores and the adapter contract stay Promise-based TypeScript with
`AbortSignal`; `effect.ts` bridges them. See the
[architecture review](architecture-review.md).

Workers start only after every bot has connected; a connection failure at
startup leaves queued requests queued. Shutdown closes Slack intake for every
bot first. Requests that arrive after that point get no ACK, so Slack
redelivers them. All workers then stop together: each turn sees its signal
abort and records an `interrupted` outcome. Backends, stores and the instance
lock close last. A failure after startup stops every bot and exits with code
1, so the service manager restarts Pogo.

## Adapter contract

```ts
interface AgentBackend {
  createSession(input: {
    key: string;
    title: string;
    signal: AbortSignal;
  }): Promise<string>;

  prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    onText?: (text: string) => void,
    onInput?: (id: string) => void,
  ): Promise<string>;
  interrupt?(sessionId: string, signal: AbortSignal): Promise<void>;
  transcript?(
    sessionId: string,
    after: string | undefined,
    signal: AbortSignal,
  ): Promise<Transcript>;
  watch?(
    onSettled: (sessionId?: string) => void,
    signal: AbortSignal,
  ): Promise<void>;
  startActivity?(
    sessionId: string,
    requestID: string,
    reporter: string | undefined,
    signal: AbortSignal,
  ): Promise<ActivityWatch>;
  close(): Promise<void>;
}
```

The opaque session ID must survive closing and reopening the adapter. Prompt
must return only the current turn's assistant text, not reasoning or prior
replies. Prompt must honour cancellation and stop underlying work, not only
the wait. Close releases owned resources, never an attached external service.
Implement interrupt if work can survive the gateway process.
Pinned-session recovery uses the separate `interruptInput` capability: withdraw
the retained input and stop only when latest raw-input history proves ownership.
A settled transcript that ends before a newer input is not ownership proof.
Without that capability, recovery leaves native work untouched.

`onText` receives cumulative visible text for the current turn. It is optional;
existing module adapters can continue returning only their final answer.
Callbacks must not include reasoning, tool arguments, or tool results. The
gateway buffers snapshots and performs Slack writes separately. OpenCode uses
live text events and reads final history as the source of truth. If the event
connection fails, final delivery continues without replaying agent work.
An observer can attach while earlier native work is busy. OpenCode publishes a
preview only after history proves it follows the submitted input. Pi uses the
submission's entry/answer bounds and live run input IDs. Uncertain previews are
suppressed; attachment time alone does not establish ownership.
While OpenCode's inbox still contains the input, previews skip history scans.
Inbox absence does not prove placement; history remains authoritative. Both
adapters allocate correlation IDs before admission, so a lost response can be
cleaned up without submitting again. Unreadable recovery remains uncertain;
these per-attempt IDs do not make replay after a process crash safe.

`transcript` and `watch` are optional. `transcript` returns the public text of
settled assistant messages after a native message cursor, oldest first, with
the newest settled message ID as the next cursor. An undefined cursor returns
only the current baseline; `""` reads from the session start. `pending` marks
unsettled messages after the cursor. A missing session or a cursor that is
not in readable history throws `TranscriptUnavailable`, never a skip; other
read errors are transient. The `latestInput` cursor reads strictly after the
adapter's latest submitted prompt input for that session. `watch` reports
sessions that settle outside a prompt and reports each (re)connection. Both
exclude reasoning, tool data, user and synthetic messages, and system text.
OpenCode implements them with message pages, session idle state, and the
client's shared event stream. Pi Durable and existing modules omit them and
keep the prompt-only contract. See [session transcript](#session-transcript).

`startActivity` is an optional, request-scoped reporting capability. Its
`ActivityWatch` reads bounded visible journal facts and can finish or cancel
the capture. OpenCode implements it through the location-scoped Pogo reporting
RPC. Other adapters remain compatible without it. The gateway manages report
delivery separately from answer delivery, with its own deadline and access
rechecks. See [crew activity](crew-activity.md) and [`activity.ts`](../src/activity.ts).
`resumeActivity` reopens a saved capture through read/finish/cancel, not start.
The gateway persists its Slack timestamp, capture ID, revision and done flag
in `jobs.activity`. Post-response loops have a separate bound and survive
restart without rerunning tools or final model summaries.

`crewStatus` is an optional read-only adapter capability for `/pogo crew`.
OpenCode implements it through the authenticated captain-location reporting
RPC, without a captain session ID. It reads crew state and in-process Pi
execution observations, never the mutating crew-tool status/recovery path.
Bounded per-task metadata includes reporter work independently of turn captures.
The Slack modal ACKs and opens before the read, and applies the bot's normal
app, workspace, user and channel access rules. Stored task state is not a
liveness guarantee. Backends without this capability remain compatible.

Custom modules export:

```ts
export async function createBackend(
  options: Record<string, unknown>,
  context: { dataDirectory: string },
): Promise<AgentBackend> {
  // Validate options here; keep state under context.dataDirectory.
  return adapter;
}
```

The gateway validates the returned method surface; the module owns option
validation. Module import and execution are trusted-code operations.

## Identity and state

See the [state-machine inventory](agents/state-machines.md) for transition
owners and invariants across the gateway, backends, crew, and scheduled work.

Bot identity includes config ID, Slack App ID, authenticated workspace/user,
and a hash of normalized backend settings. A conversation adds channel and
thread timestamp. Environment **names**, not token values, enter settings.
An explicit OpenCode `sessionID` pin is excluded from this hash. It binds the
existing captain without changing thread admission or cron scope. Other
backend settings still select separate namespaces.
Changing credentials for the same installation does not discard sessions.
Changing backend settings selects a new session namespace and Pi database.

One shared SQLite database stores all registrations' queue rows. Private Pi
storage lives in per-bot/per-backend directories. This is logical separation,
not an OS security boundary. ACLs are checked at admission and before work or
delivery; removed users cannot receive a pending response after restart.
User and channel allow lists accept explicit IDs or a whole `*`. Optional
`deniedUsers` and `deniedChannels` default to empty and always override allows.
Wildcard channel access follows Slack's membership/visibility boundary; it does
not join channels. Denies also block queued turns and persisted replies.

## Execution and delivery

```text
Slack event → validate → SQLite queued → ACK
                            ↓
                         running → responding → done
                            │          │
                         failure       └─ delivery retry, bounded attempts
                            ↓
                     safe error reply
```

Ready-job selection prevents concurrent turns within a conversation. Workers
for other conversations proceed independently, subject to per-bot limits.
Message timestamp deduplication also covers the two Slack event types for
the same mention. Completed deduplication rows persist until operator removal.

Crashes during `running` do not trigger generic execution retries. The adapter
may already have changed files or called external services. Recovery attempts
interrupt, then stores a notice for Slack delivery. A future recovery design
would need durable execution IDs and backend-specific reconciliation, not
blindly retrying `prompt`.

Delivery stores all chunks and a sent cursor. A successful API call advances
the cursor. Transport ambiguity still permits duplicate Slack replies. This
release does not claim exactly-once execution or delivery.

Failures store a fixed safe cause with the response before Slack delivery.
The optional `SlackDelivery.failure(channel, thread, cause, ts?)` hook posts a
collapsible status box or replaces the preview at `ts`. Returning `false` means
the preview was removed; the gateway posts a replacement. Existing adapters
without this hook receive the stored plain-text notice through `post`/`update`.
Delivery retries reuse the persisted cause and do not repeat backend work.

Live replies use ordinary Slack posts and edits with the existing `chat:write`
scope. Both posts and edits use native `markdown` blocks, without converting
standard Markdown to Slack's separate `mrkdwn` syntax. The top-level text remains
an escaped notification/accessibility fallback. Chunks with explicit Slack
mention or broadcast controls use literal `plain_text` blocks instead; ordinary
code contents are not rewritten. Scheduled announcement names also stay literal.
Updates are coalesced, not sent for every token. Preview timestamps are
stored in SQLite; completion, errors, and restart recovery update those same
messages. If the final reply is shorter, Pogo removes its extra preview messages.
Slack failures stop live updates but do not stop or rerun tools. Final delivery
uses the durable response and retry cursor. A crash between a Slack post and
timestamp persistence can still leave an extra preview.

Replies keep the existing 60,000-codepoint ceiling and 2800-codepoint message
budget. Splitting prefers paragraphs or lines and closes/reopens ordinary
top-level backtick and tilde fences with their language. Very long tables,
inline constructs, nested Markdown containers, and fence lines over 512
codepoints are not structurally reconstructed across messages.

Waiting feedback starts only if no visible text arrives before the configured
delay. It reuses the first preview message. Visible text stops rotations, and
completion or cancellation stops all feedback timers. See [waiting settings](waiting.md).

## Session transcript

### Pinned captains

OpenCode `backend.sessionID` selects one existing captain root across sources.
The adapter validates that binding without creating a replacement. Captain
execution and history catch-up share one slot; Slack destinations remain on
the individual jobs. Existing per-thread session mappings remain as history,
but do not receive captain catch-up broadcasts.

Each pinned Slack turn also carries model-visible source identity. When enabled,
bounded thread context refreshes on every reply, not only the first request.
The thread root and newest eligible messages anchor
short references such as "resume this". The persistent captain instructions
resolve those references against this source rather than the latest unrelated
task in shared history. This is a context anchor, not a second captain or a
model-level isolation guarantee. See [thread context](thread-context.md).

`captain_cursors` stores one cursor and delivery owner for that bot and session.
The native input ID commits on the job before admission. History attributes
each public entry to its preceding user or standalone shell input. A known
Pogo input selects its originating job; an unknown native input clears the
Slack owner. Crew tasks retain the exact originating captain input resolved
from the dispatch tool's message ancestry, including while queued. Captain-bound
crew wakes queue rather than steer another source's active turn. Their metadata
selects that retained input only for the exact originating captain session.
Missing or foreign origins clear Slack ownership and stay in native history;
ordinary shell-completion synthetics retain the existing continuation behavior.
A queued job never selects a destination before its input appears in history.

Old tasks keep a null origin; activation never guesses or backfills their source.
Their results, notices and history remain available through normal crew status
and collection, but an unsolicited wake cannot choose a Slack destination.
This includes tasks already running during activation. Recover the result and
report it in its proven source; do not replay the assignment to obtain routing.

Replies for the current input, continuation outbox rows for earlier owners,
and cursor advancement commit together. Native UI output with no Pogo owner
stays in native history instead of being copied to a Slack chat. Catch-up waits
for queued and running captain requests and never broadcasts to old mappings.
Targeted per-thread transcript repair does not support pinned captains and
fails without writing state.

### Ordinary thread-scoped bots

A mapped OpenCode session can continue after its Slack turn ends. Background
shell completions and crew notifications resume it after a successful wait, a
timeout, or Stop. Pogo delivers that public assistant text to the same thread.
It never runs the request again for this delivery.

The `sessions` row stores a transcript cursor: the newest native message that
Pogo accounted for in Slack. NULL means the mapping predates the cursor.

- A turn records its starting cursor. After the prompt settles, the reply is
  all settled public text after that cursor, not only the last answer. The
  reply and the new cursor commit in one SQLite transaction. If another writer
  moved the cursor, the transaction rolls back; the turn posts **Reply
  delayed** and catch-up delivers from the moved cursor.
- Reactions come only from the prompt's own reply to the current input.
  Directives in earlier continuations are removed and never applied.
- The final read retries briefly (100, 200, 400 ms) for completion marks. If
  history stays unreadable, or no public text has settled, the turn posts one
  **Reply delayed** status box and catch-up delivers the reply from history.
  Pogo never posts the streamed copy without its cursor. Settled text before
  an unsettled message is delivered; the rest follows through catch-up.
- On timeout, backend failure, or Stop, settled public text stays above the
  one **Request status** box. Shutdown keeps the cursor; restart catch-up
  delivers that text after the recovery notice.
- Startup, `watch` notifications, and each event-stream (re)connection queue
  catch-up. Startup and reconnects queue every mapped thread of the bot
  namespace, with no age limit. A quiet thread costs one single-message
  history read.
- A failed catch-up read keeps the cursor and retries without a new event,
  after 1, 2, 4 seconds and so on, at most every five minutes. Retries read
  history only; they never prompt the agent.
- `TranscriptUnavailable` stops background catch-up for that thread with one
  warning. The mapping and cursor stay. The next request in the thread
  resumes it. Catch-ups share the bot's concurrency slots with requests;
  queued requests start first in each tick and quiet threads cost one read.
- Catch-up waits while the thread has a queued, running, or delivering job.
  A queued turn reads the same history, so earlier continuations stay first.
- Catch-up advances the cursor and inserts one `responding` job row in one
  transaction. The row's event ID is `transcript:<newest message ID>`. Normal
  delivery then applies access rechecks, chunking, retries, and the sent
  cursor. Retries do not read history or call the backend again.
- Transcript replies are not clipped at the 60,000-codepoint reply ceiling.
  All public text is stored and posted in 2800-codepoint messages.
- Text-free continuations, such as tool-only steps, advance the cursor without
  a Slack reply. Model reaction directives are removed from continuations.

Delivery targets the latest request row of the exact bot/app/workspace/
backend/channel/thread conversation. Session IDs that map only in another bot
namespace, worker sessions, and child sessions are ignored.

At startup, mappings without a cursor get a baseline at current history. Pogo
does not backfill earlier history. If that baseline read fails when a request
starts, the reply is read strictly after the request's own native input, and
the cursor is seeded there. Later replies are not skipped. If that read also
fails, Pogo posts the streamed reply and leaves the cursor unset.

A catch-up reads every history page back to its cursor. If the cursor message
is missing, for example after a session revert, catch-up stops and keeps the
cursor. The next request reads strictly after its own native input and starts
the reply with a note that earlier replies may be missing. The reply and the
re-anchored cursor commit together. Replies between the lost cursor and that
request are not delivered; use targeted repair with a known `since` message
if they matter. Transient read errors never re-anchor.

Event coverage: the installed OpenCode 2.2.6 server publishes
`session.execution.started`, then `succeeded`, `failed`, or `interrupted`, from
one session runner. Prompts, synthetic inbox items, resume, skills, and
compaction wake that runner. The call site that turns a background shell
completion into a synthetic item was not located in the minified build. Tests
use fake events. Reconnect catch-up covers a missed event.

`greybeard:` Settledness uses the message completion time, its error, or the
session idle time. One catch-up read may take five minutes; a longer read
fails, keeps the cursor and retries. A server query for messages after an ID
is the upgrade path for very long sessions. This is not exactly-once
delivery: the Slack/SQLite crash window and ambiguous network writes can
still duplicate a reply.

### Targeted repair

`repairThread` in `src/transcript.ts` is an operator helper, not a CLI
command. It resolves one bot's current namespace for one thread and compares
settled public replies after a native message ID with stored Slack replies.
A dry run reports the missing IDs, `requeued` failed outbox rows in scope,
and `conflicts`. `apply: true` retries those failed rows with their stored
text, queues the missing replies as delayed updates labelled with their
original UTC time, and moves the cursor to the repaired head, in one
transaction. Conflicts, or any row that cannot be inserted or requeued,
refuse the whole apply. Repeated runs find no missing replies. More than
`limit` (default 20) missing replies is an error.

The cursor moves to the repaired head even when it was earlier. Replies that
`only` excludes, and replies between an older stored cursor and a later
`since`, are not delivered later. Run it only against a reviewed thread:

```sh
bun -e 'import { repairThread } from "./src/transcript";
console.log(JSON.stringify(await repairThread({
  config: "pogo.json", bot: "captain", channel: "D123", thread: "1.000",
  since: "msg_INPUT_ID", apply: false,
}), null, 2));'
```

Pogo's running worker delivers applied rows; the helper does not post to
Slack. Only `apply: true` refuses a thread with a queued or running request;
a dry run never queues replies or moves the cursor. Both modes first restrict
the existing data directory to `0700` and `pogo.sqlite` to `0600`, before SQLite
creates WAL/SHM files. Repair refuses a missing database or a database symlink;
it never creates replacement state.

## Scheduled prompts

`/cron` uses Socket Mode command and interactive payloads, not agent-generated
commands. The modal lists only jobs owned by the caller in the current channel.
Creation and removal recheck the bot, workspace, user, and channel boundaries.

Schedules and run claims live in a separate private `cron.sqlite` database.
Each run posts a new thread root, then enters the existing durable gateway
queue. The creator's current access rules still apply. Scheduled thread replies
use the same conversation routing as human-started threads. Agent failures and
delivery retries retain the gateway's no-blind-replay rules.

See [cron jobs](cron.md) for schedule syntax, timezone handling, restart
behavior, and required Slack app configuration.

## Initial ceilings

The initial release supports text conversations, explicit allowlists, two built-in
adapters, trusted module adapters, local setup, and user services. It does not
add file transfer, tool-event streaming, interactive approvals, OAuth SaaS
installation, clustering, or a plugin discovery/package system. Those require
specific use cases before extending these boundaries.
