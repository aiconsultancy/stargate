# Stargate design

## Boundaries

This section describes the current runtime.

```text
One process
  ├─ Bot A: Socket Mode + Web API → routing/access → durable queue
  │                                                ↓
  │                                       OpenCode adapter → V2 server
  ├─ Bot B: Socket Mode + Web API → routing/access → durable queue
  │                                                ↓
  │                                       Pi Durable adapter → SDK/SQLite
  ├─ Bot C: Socket Mode + Web API → routing/access → durable queue
  │                                                ↓
  │                                       Claude adapter → Agent SDK → CLI
  └─ Bot D: Socket Mode + Web API → routing/access → durable queue
                                                   ↓
                                          Codex adapter → Codex SDK → CLI
```

`config.ts` validates input and resolves environment references. `setup.ts`
creates Slack manifests, config, and private credentials. `cli.ts` exposes
interactive and scripted operation. `service.ts` produces Linux user units.

`slack.ts` owns one outbound connection and API client per registration.
`routing.ts` validates Slack payloads, checks identity and access, and builds
conversation keys. `gateway.ts` runs independent workers.
Captain-addressed [meta commands](meta-commands.md) are handled locally at Slack
admission, after access checks and before a captain job is queued. The command
table owns dispatch and help; settings reuse their existing storage owners.
Opt-in OpenCode clarification controls also bypass that queue: the original
turn is waiting on its native form. The gateway binds each offer to its exact
input, running question tool, form fingerprint and posted Slack message.
Durable one-shot claims prevent a repeated interaction from replaying a native
answer or cancellation. These controls never approve tool permissions.
Opt-in [follow-up steering](operations.md#follow-up-steering) uses the same
gateway queue and native synthetic-input mechanism as crew steering. Only the
exact thread owning the active input is eligible. Durable admission receipts
separate accepted steering, definite refusal and uncertain native writes;
another thread stays queued. No second scheduler selects follow-ups.
Opt-in [inbound Slack reactions](operations.md#inbound-slack-reactions) reuse
that admission path. Slack intake verifies a human actor and the bot-authored
target, preferring stored posted-message timestamps over an exact API lookup.
Reaction jobs retain the target timestamp separately from their deduplication
ID, so source lines identify the reaction without treating it as a new message
or issuing read receipts against it.
`attachment-delivery.ts` publishes the files of a stored reply. `store.ts` owns
the queue, delivery cursor, and session mappings. `runtime.ts` owns startup,
the exclusive process lock, cancellation, and resource cleanup.

No shared agent implementation depends on Slack. No Slack implementation
depends on a particular agent protocol. The gateway takes a
`GatewayTransport` (namespace, access recheck, source line, sender note);
Slack supplies `slackTransport`. The IRC adapter in `src/transports/irc/` has
its own client, admission rules and line delivery. Teams uses the same durable worker
with authenticated Bot Framework intake, stored conversation references and
Connector delivery. See [IRC transport](irc.md) and [Teams transport](teams.md).
Opt-in [fleet tools](fleet-tools.md) keep native session permissions, original
message evidence and human approval separate from model text and agent rank.
Effect 4 owns lifetimes and
concurrency: the process scope in `runtime.ts`, the per-conversation worker
slots in `Gateway.work`, and the crew plugin's resource scope. Pure logic,
SQLite stores and the adapter contract stay Promise-based TypeScript with
`AbortSignal`; `effect.ts` bridges them. See the
[architecture review](architecture-review.md).

The IRC transport does not depend on Slack. Attachment delivery retains each
file's stored phase so retries resume. The dashboard source owns session scope;
backends answer metadata and transcript queries. Nightly maintenance runs external
commands through `CommandRunner`; its tests do not call providers. See
[maintenance](maintenance.md). Keep Effect pinned to the OpenCode SDK version.

Workers start only after every bot has connected; a connection failure at
startup leaves queued requests queued. Shutdown closes Slack intake for every
bot first. Requests that arrive after that point get no ACK, so Slack
redelivers them. All workers then stop together: each turn sees its signal
abort and records an `interrupted` outcome. Backends, stores and the instance
lock close last. A failure after startup stops every bot and exits with code
1, so the service manager restarts Stargate.

## Source layout and boundary rules

The [restructure tracker](https://linear.app/nettworks/issue/NET-1766/tracker-stargate-source-restructure-into-bounded-vertical-slices)
is the authority for the stages and ownership decisions. This section describes
the target, not the current runtime layout above.

### Target layout — FUTURE, NOT CURRENT

Entries below are relative to the future source root. Names without `.ts` are
module stems, not declarations of public files. These paths are not current-path
references or a complete file inventory.

| Target directory                                              | Ownership or module stems                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/`                                                        | Composition and startup                                                                                                                                             |
| `ops/`                                                        | Operator interfaces and operations                                                                                                                                  |
| `lib/`                                                        | Domain-free helpers and types                                                                                                                                       |
| `shared/`                                                     | Shared domain helpers and types                                                                                                                                     |
| `config/`                                                     | Configuration                                                                                                                                                       |
| `gateway/`                                                    | Turn engine only: gateway, ports, routing, store core, streaming, request-failure, turn-progress, cancellation, thread-context, reactions, mentions, peers, waiting |
| `transports/slack/`                                           | Transport only: connection, format, files, interactions, bot-web, pairing, crew-ui                                                                                  |
| `transports/irc/`, `transports/teams/`                        | Transport implementations                                                                                                                                           |
| `questions/`                                                  | questions, background-questions, question-settings, slack-questions                                                                                                 |
| `activity/`                                                   | activity, activity-delivery, activity-slack                                                                                                                         |
| `attachments/`                                                | attachments, attachment-delivery                                                                                                                                    |
| `meta-commands/`                                              | meta-commands, config-panel                                                                                                                                         |
| `captain-post/`                                               | captain-post, config                                                                                                                                                |
| `cron/`                                                       | cron, cron-advanced, cron-control, cron-decision, cron-input, cron-store, cron-ui, config, cronjob-files, cronjob-manager                                           |
| `notifications/preferences/`, `notifications/ingest/`         | Notification preferences and ingestion                                                                                                                              |
| `maintenance/`                                                | maintenance modules, update-notice, nightly/                                                                                                                        |
| `quota/`, `fleet/`, `dashboard/`, `transcription/`, `health/` | Their named domains                                                                                                                                                 |
| `backends/`                                                   | Contract, factory, opencode/, pi/, claude, codex                                                                                                                    |
| `crew/`                                                       | Fixed plugin.ts, protocol/, engine, pi, messaging, reporting                                                                                                        |

The current paths `src/main.ts`, `src/config.ts`, `src/crew/plugin.ts` and
`src/fleet/plugin.ts` are fixed and must never move. Tests stay flat in `tests/`.
`gateway.ts` has a permanent exception to the limit of 1,000 non-blank lines.
The O1 decision in [architecture review](architecture-review.md) is unchanged.

The `transports/` directory groups IRC, Slack and Teams for navigation.
They remain three separate slices with unchanged dependency rules.

### Dependency policy

Each slice has a small public surface: its config schema, model or wire types,
and one entry point. Other files are private. Slice-to-slice imports use only
named public files and explicitly listed directed neighbour pairs; directory
membership alone grants no permission. Slice owners declare the public files
and neighbour pairs. The table above is a target slice map, not a manifest of
those declarations. Do not infer public filenames or permissions from it.

The dependency order is `lib` → slice contracts → `config` → slices → gateway
engine → transports → `app`: a dependent imports a lower layer, not the reverse.
`lib` and `shared` never import a slice. A slice never imports gateway, transport
or app. Backend adapters remain independent of Slack. No file import cycles are
allowed.

Count consuming slices for the rule of three, not files, calls or tests. A helper
or type stays in its owner slice by default. A second slice imports an owner's
public file or copies a small amount of code. At the third consuming slice, move
a domain-free helper or type to `lib`, or a domain helper or type to `shared`.
A store or service always stays with its owner.

### Migration guards

Stage 0 architecture guards ratchet current violations: exception entries may
be removed but not expanded. Follow the tracker stages in order. Do not move
source files until all Stage 0 and Stage 1 guards are in place. A pure move PR
changes only file locations and import lines; behavior, configuration, SQLite
and wire formats stay unchanged.

A move in the crew plugin closure changes its digest and requires a full
OpenCode restart for the release. An unchanged digest permits a gateway-only
restart. This plan does not deploy a release.

## Maintenance restart drain

The default-off [notification path](notification-ingestion.md) runs alongside
agent work, not through `Gateway` or backends. The existing Unix API owner
authenticates configured producer sources. The Effect core commits dedup and
per-destination rows to private `notify.sqlite` under the instance lock before
returning `202`. The Slack sink checks current physical bindings, audiences,
access and echo exclusion immediately before a request-scoped literal send.
Notification topology is restart-only; current access publishes atomically
with successful live reload. Early intake close stops admission and claims,
then actual send settlement precedes store/lock release. A referenced process
hard-exit timer covers nonsettling notification shutdown, including startup
failure. Existing maintenance drain and agent steering are unchanged.

The optional [maintenance restart drain](maintenance.md#restart-drain) uses a
same-user host barrier and private live-participant metadata under
`~/.local/state/stargate/maintenance-drain`. Independent gateways retain their
own databases. Their existing worker poll observes the barrier: admission
pauses, intake persists accepted messages, and running work can finish.
Crew admissions use the same barrier and retain held assignments in their
existing pending-task table. This adds no scheduler or message queue.
NET-1719 context queues carry advance/completion notices without native input
or model execution; Pi notices use ordinary mail. Only drain-held assignments
are automatically eligible after release, under their original ownership.

## Live configuration reload

Optional [session update notices](update-notices.md) reuse readiness, the
registered tool list and existing gateway/crew stores. They queue passive
context without starting work or bypassing task and permission checks.

`config-reload.ts` reads a complete candidate with the CLI's schema and
credential checks. It resolves the companion against a base environment captured
before startup loading, without changing `process.env`. Reload requests are
serialised. A pure allowlist planner rejects reconnect-only field or existing
effective-environment changes, returning paths without values. Invalid/rejected
candidates never advance the current snapshot. SIGHUP is the only trigger;
watching files and gap-free code replacement are not implemented here.

The runtime stages added IRC clients, backends and blocked worker fibres before
commit. Removed members are paused and checked synchronously for queued,
running or responding work and active Gateway processing. The commit publishes
all settings and roster references without an await, then releases new workers.
Removed idle workers/connections retire independently. Dynamic workers share the
existing process scope and writer; shutdown still closes intake before draining
workers, then closes backend resources and stores. No second runtime is started.

A Gateway turn captures its execution settings, source/note and transcriber by
reference to an immutable configuration version. Future turns use the replaced
version. Access is an intersection, not a frozen grant: new denies apply before
every subsequent delivery; new allows cannot expand the starting policy. IRC
checks that gate again when a queued line reaches its socket. Calls already sent
to Slack cannot be recalled. Cron and interactive surfaces also receive current
access rules without replacing their pending state.

See [reload fields and operator commands](configuration.md#reload-configuration-without-restarting)
for the exact live-safe set and conservative restart-only policy. Only the IRC
crew roster is in this configuration; the separate OpenCode crew-plugin roster
keeps its existing append-only/migration requirements.

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
client's shared event stream. Pi Durable, Claude, Codex and existing modules omit
them and keep the prompt-only contract. See [session transcript](#session-transcript).

The Claude adapter starts one Claude Code CLI per turn through the pinned
Agent SDK, in its own process group, with a minimal environment and a private
`CLAUDE_CONFIG_DIR` per namespace. `createSession` allocates a UUID; the
first turn creates that native session and later turns resume it from the
namespace's transcript directory. Previews come from streamed main-agent
text blocks; the answer comes from completed assistant messages, never from
error frames. When the CLI exits, is cancelled or lingers after its result,
Stargate stops its process group and every process that carries the turn's random
environment marker (Claude Code runs Bash in separate sessions), and forces
survivors after a grace period. Each signal follows a synchronous check of
the process's start time, user IDs and marker (no pidfd API is available).
Records of running CLIs let `interrupt` stop what an earlier Stargate process
left: the group only while its recorded leader still matches, other
processes only by that check. See [Claude backend](claude.md).

The Codex adapter starts one Codex CLI per turn (`codex exec`) through the
pinned Codex SDK, with a minimal environment and a private `CODEX_HOME` per
namespace. Command-line `--config` overrides define the only model provider
(the configured proxy), the sandbox (`read-only` by default), approval
policy `never`, and turn off project instructions, skills, plugins, hooks,
subagents and optional network traffic. `createSession` allocates a Stargate
UUID; the first turn's `thread.started` event stores the Codex thread ID,
and later turns resume it. Previews and the answer are the completed agent
messages of the turn; failures carry fixed causes, never CLI stderr. The
CLI shares Stargate's process group and its sandbox uses new sessions and PID
namespaces, so clean-up uses only the turn marker (`STARGATE_CODEX_TURN`) and
the same verified per-process signals as Claude, from the shared
`backends/cli-agent.ts` module. Cancellation starts that clean-up at once,
not after the SDK's stream ends, because the SDK only sends `SIGTERM` and
then waits for the CLI's output. The SDK exposes no process or stream
handle, so Stargate's `sh` launcher (`codexPathOverride`) `exec`s the CLI with
its output through an unlinked FIFO and a marked `cat`: only marked
processes hold Stargate's pipes, and the clean-up closes them. The launcher
is written (`O_EXCL | O_NOFOLLOW`) and verified per turn at its canonical
path and runs root-owned system utilities by absolute path; after
validation every path that Stargate writes, checks or runs is used only in
canonical form, and changeable symbolic links are refused; `codex-paths.ts`
refuses a `workspace-write` directory that overlaps Stargate's data,
installation, the SDK packages or the home directory. The CLI never sees
the operator's `PATH`: it gets a fixed one built at start-up from the SDK
helper directory, root-controlled system directories (every program
checked over its full link chain) and the checked `extraPath`. The turn stops
waiting for a stream that is still open shortly after the clean-up. Run
records hold only the marker and start time. See [Codex backend](codex.md).

`startActivity` is an optional, request-scoped reporting capability. Its
`ActivityWatch` reads bounded visible journal facts and can finish or cancel
the capture. OpenCode implements it through the location-scoped Stargate reporting
RPC. Other adapters remain compatible without it. The gateway manages report
delivery separately from answer delivery, with its own deadline and access
rechecks. See [crew activity](crew-activity.md) and [`activity.ts`](../src/activity/activity.ts).
`resumeActivity` reopens a saved capture through read/finish/cancel, not start.
The gateway persists its Slack timestamp, capture ID, revision and done flag
in `jobs.activity`. Post-response loops have a separate bound and survive
restart without rerunning tools or final model summaries.

`crewStatus` is an optional read-only adapter capability for `/stargate crew`.
OpenCode implements it through the authenticated captain-location reporting
RPC, without a captain session ID. It reads crew state and in-process Pi
execution observations, never the mutating crew-tool status/recovery path.
Bounded per-task metadata includes reporter work independently of turn captures.
The Slack modal ACKs and opens before the read, and applies the bot's normal
app, workspace, user and channel access rules. Stored task state is not a
liveness guarantee. Backends without this capability remain compatible.

`quota` is an optional read-only adapter capability for `/stargate usage`. It uses
the same location-authorized RPC and private modal as crew status. The crew
plugin's opt-in `QuotaReader` supplies sanitized Claude/Codex subscription
limits to this RPC and the authorized `stargate_quota` tool on both harnesses.
Proxy management credentials stay on the host. No model, session or queue
operation is required; see [provider usage](usage.md).

The optional gateway `quotaWatch` uses the same reader without a backend
turn. It publishes a small crew-launch policy and posts transition notices
through an allowed Slack channel. The launch supervisor owns worker admission
and the captain can still respond while a worker is paused.

`history` is an optional read-only adapter capability for the
[fleet dashboard](dashboard.md). It returns session metadata, child sessions
and transcript pages in one harness-independent shape
([`session-history.ts`](../src/shared/session-history.ts)). OpenCode reads its
server API and asks the crew plugin for crew roots and Pi crew transcripts.
Pi Durable reads its own store. Adapters answer what they are asked;
[`dashboard-source.ts`](../src/dashboard/dashboard-source.ts) decides which sessions
belong to a bot. The dashboard listens on a Unix socket in the private data
directory, so Stargate still opens no network port.

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
Changing backend settings selects a new session namespace, Pi database,
Claude configuration directory and Codex home.

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
scope. Ordinary replies with no Slack controls retain the native `markdown`
blocks and source chunking used before this change. Only control-containing
replies enter the new preparation path: Bun's Markdown parser classifies the
entire clean reply or cumulative preview before any message split. Complete user (`<@U…>`/`<@W…>`) and channel
(`<#C…>`/`<#G…>`) controls become structured mentions only in non-code text.
HTTP, HTTPS and mailto angle links become link elements; credential-bearing or
whitespace-containing URLs are not promoted. Broadcasts, bare
`@here`/`@channel`/`@everyone`, subteam/date controls and malformed controls remain
literal. Code spans and code blocks keep their classification in every chunk,
including quoted fences and marker-free middle chunks. No continuation chunk
is parsed again or used to infer code state.

Each chunk carries its pre-classified `rich_text` payload in the existing JSON
outbox. Delivery and restart retries reuse that payload. Original Markdown is
retained once with the reply for repair deduplication, separately from rendered
fallback text. Legacy string chunks, CLI repairs without classification and
unprepared posts/edits use literal `plain_text`; they are never reparsed locally.
Unmatched fences, raw inline delimiters, parser failures and oversized atomic
links cause the whole control-containing reply to use plain text. This conservative fallback can
suppress intended mentions: correctness takes precedence over formatting.

Rich text keeps emphasis, lists, quotes and code. Headings become bold text,
tables become readable rows and images become literal alt text plus URL. Image
alt text is always literal because Bun strips its source styles before the
image callback. Native Markdown cannot carry structured mention elements. The
top-level fallback is escaped; top-level `mrkdwn` parsing is never enabled.
Scheduled names remain literal. The gateway consumes reaction and silent
directives before classification, including streaming previews.
Updates are coalesced, not sent for every token. Preview timestamps are
stored in SQLite; completion, errors, and restart recovery update those same
messages. If the final reply is shorter, Stargate removes its extra preview messages.
Slack failures stop live updates but do not stop or rerun tools. Final delivery
uses the durable response and retry cursor. A crash between a Slack post and
timestamp persistence can still leave an extra preview.

Replies keep the existing 60,000-codepoint source ceiling; transcript replies
remain unbounded. The classified-element packer caps each Slack message at
2800 text-plus-URL codepoints. It splits only text leaves, retaining their styles and
code classification. Mentions and links are atomic. Each chunk uses one content
block plus at most one Stop block, below Slack's 50-block message cap; text
leaves remain below 3,000 characters. A list item can continue in another message
with its list context. The transport-neutral legacy chunker remains available
to deliveries without a classification hook, but Slack never reparses its output.

Waiting feedback starts only if no visible text arrives before the configured
delay. It reuses the first preview message. Visible text stops rotations, and
completion or cancellation stops all feedback timers. See [waiting settings](waiting.md).

With explicit `fleetControl.results`, the fleet ledger also owns a completion
outbox. Authenticated IRC assignment intake claims its exact delegation and
server event; the result worker binds the persisted native input and settled
public outcome. The owner queues a continuation against the original ingress
job/native input, with captain/agent source identity (`s=fleet`) and no human
approval authority. Queue-before-ack recovery deduplicates continuations across
restart. This is distinct from native crew tasks and from ordinary peer chat;
see [fleet tools](fleet-tools.md) for failure and recovery semantics.

## Session transcript

### Pinned captains

OpenCode `backend.sessionID` selects one existing captain root across sources.
The adapter validates that binding without creating a replacement. Captain
execution and history catch-up share one slot; Slack destinations remain on
the individual jobs. Existing per-thread session mappings remain as history,
but do not receive captain catch-up broadcasts.

Each pinned Slack turn also carries a compact model-visible source line:
`s=slack;c=<channel>;t=<thread>;m=<message>;u=<user>`. The persistent captain
definition explains it once. Turns add only that line and the new user message,
not repeated Slack history or a JSON envelope. The captain resolves "resume
this" against this source; missing context needs authorized retrieval or a
clarification, not another thread's task. This is a context anchor, not a second
captain or a model-level isolation guarantee. See
[thread context](thread-context.md).

`captain_cursors` stores one cursor and delivery owner for that bot and session.
The native input ID commits on the job before admission. History attributes
each public entry to its preceding user or standalone shell input. A known
Stargate input selects its originating job; an unknown native input clears the
Slack owner. Crew tasks retain the exact originating captain input resolved
from the dispatch tool's message ancestry, including while queued. Captain-bound
crew wakes queue rather than steer another source's active turn. Their metadata
selects that retained input only for the exact originating captain session.
Missing or foreign origins clear Slack ownership and stay in native history.
OpenCode shell-completion metadata supplies a shell/job ID, not an original
input ID. A bounded same-session history read resolves the unique earlier
native `shell` tool result with that ID and matching command, then folds its
original input ancestry, including earlier shell and crew wakes. The existing
durable input/job mapping selects the original registration and conversation;
neither quoted source lines nor shell markup selects a destination. Missing,
foreign, conflicting or ambiguous shell ancestry stays native-only, never on
the latest chat. The reader keeps at most 10,000 compact records and launch
witnesses, hashing commands rather than retaining tool output. Exceeding that
bound also stays native-only. Read failures retain the delivery cursor for
retry; they do not replay work. Adjacent mixed-origin wakes remain native-only.
Unrecognised synthetic inputs, including completions without metadata, clear
ownership. Recognised native instruction loads, restart notices and the exact
native output-limit continuation remain context-only records; their text never
selects a source. The output-limit continuation must be synthetic, with the
verified exact text, no description and absent or empty metadata.
A queued job never selects a destination before its input appears in history.

Old tasks keep a null origin; activation never guesses or backfills their source.
Their results, notices and history remain available through normal crew status
and collection, but an unsolicited wake cannot choose a Slack destination.
This includes tasks already running during activation. Recover the result and
report it in its proven source; do not replay the assignment to obtain routing.

Replies for the current input, continuation outbox rows for earlier owners,
and cursor advancement commit together. Native UI output with no Stargate owner
stays in native history instead of being copied to a Slack chat. Catch-up waits
for queued and running captain requests and never broadcasts to old mappings.
Targeted per-thread transcript repair does not support pinned captains and
fails without writing state.

### Ordinary thread-scoped bots

A mapped OpenCode session can continue after its Slack turn ends. Background
shell completions and crew notifications resume it after a successful wait, a
timeout, or Stop. Stargate delivers that public assistant text to the same thread.
It never runs the request again for this delivery.

The `sessions` row stores a transcript cursor: the newest native message that
Stargate accounted for in Slack. NULL means the mapping predates the cursor.

- A turn records its starting cursor. After the prompt settles, the reply is
  all settled public text after that cursor, not only the last answer. The
  reply and the new cursor commit in one SQLite transaction. If another writer
  moved the cursor, the transaction rolls back; the turn posts **Reply
  delayed** and catch-up delivers from the moved cursor.
- Reactions come only from the prompt's own reply to the current input.
  Directives in earlier continuations are removed and never applied.
- A message whose first line is `[[stargate:silent]]` has no public text and no
  files, in a turn and in a continuation. A turn with no other public text
  commits an empty reply with its cursor and posts nothing. When the prompt's
  own reply is silent, unreadable or unsettled history queues catch-up without
  a **Reply delayed** notice.
- The final read retries briefly (100, 200, 400 ms) for completion marks. If
  history stays unreadable, or no public text has settled, the turn posts one
  **Reply delayed** status box and catch-up delivers the reply from history.
  Stargate never posts the streamed copy without its cursor. Settled text before
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

At startup, mappings without a cursor get a baseline at current history. Stargate
does not backfill earlier history. If that baseline read fails when a request
starts, the reply is read strictly after the request's own native input, and
the cursor is seeded there. Later replies are not skipped. If that read also
fails, Stargate posts the streamed reply and leaves the cursor unset.

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

`repairThread` in `src/ops/transcript.ts` is an operator helper, not a CLI
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
bun -e 'import { repairThread } from "./src/ops/transcript";
console.log(JSON.stringify(await repairThread({
  config: "stargate.json", bot: "captain", channel: "D123", thread: "1.000",
  since: "msg_INPUT_ID", apply: false,
}), null, 2));'
```

Stargate's running worker delivers applied rows; the helper does not post to
Slack. Only `apply: true` refuses a thread with a queued or running request;
a dry run never queues replies or moves the cursor. Both modes first restrict
the existing data directory to `0700` and `stargate.sqlite` to `0600`, before SQLite
creates WAL/SHM files. Repair refuses a missing database or a database symlink;
it never creates replacement state.

## Scheduled prompts

`/cron` uses Socket Mode command and interactive payloads, not agent-generated
commands. The modal lists only jobs owned by the caller in the current channel.
Creation and removal recheck the bot, workspace, user, and channel boundaries.

Schedules and run claims live in a separate private `cron.sqlite` database.
Opt-in advanced jobs retain per-window quota observations and event receipts
in that database and claim events without invoking a model. Explicit job-model
evaluation uses the crew plugin's stateless tools-off generation; optional Pi
arbitration uses a separate tools-off store rather than a crew task slot. Only
an act/escalate verdict reaches the captain or job delivery. Claims precede
generation, so uncertain evaluations are held rather than replayed. Runtime
scope bindings fence controls against restart-only configuration drift.
Each run posts a new thread root, then enters the existing durable gateway
queue. The creator's current access rules still apply. Scheduled thread replies
use the same conversation routing as human-started threads. Agent failures and
delivery retries retain the gateway's no-blind-replay rules.

See [cron jobs](cron.md) for schedule syntax, timezone handling, restart
behavior, and required Slack app configuration.

## Captain posts

The captain-only `stargate_post` tool runs in the crew plugin, not the gateway.
It reads the bound `stargate.json` for each call, checks the bot's channel rules,
records the post in a private `captain-post.sqlite`, then calls Slack with
that bot's own token. Retries read the record and never resend. See
[captain posts](captain-post.md).

## Initial ceilings

The initial release supported text conversations, explicit allowlists, two
built-in adapters (now four, with Claude and Codex), trusted module adapters, local
setup, and user services. It does not
add file transfer, tool-event streaming, interactive approvals, OAuth SaaS
installation, clustering, or a plugin discovery/package system. Those require
specific use cases before extending these boundaries.

## Request failures

A request that cannot finish stores one fixed cause in `jobs.failure`. The
card and the plain-text notice come from that cause only
(`request-failure.ts`); no error text crosses the queue.

A backend reports a provider or process failure as `BackendFailure` with a
category, the provider's HTTP status when it saw one, and `ran`: whether the
turn can have done work. The stored cause is
`provider:<category>:<status or 0>:<ran or idle>`.

| Category   | Meaning                                           | Evidence                          |
| ---------- | ------------------------------------------------- | --------------------------------- |
| `quota`    | Quota, rate limit, billing or credential cooldown | HTTP 402 or 429, or a named cause |
| `auth`     | Credentials or account rejected                   | HTTP 401 or 403, or a named cause |
| `model`    | Model missing or not allowed                      | HTTP 404, or a named cause        |
| `timeout`  | Provider did not answer in time                   | HTTP 408 or 504                   |
| `network`  | Provider, proxy or agent server not reached       | Socket error code                 |
| `crash`    | Agent process ended without a result              | CLI exit without a result         |
| `provider` | Any other provider error                          | Any other HTTP status or cause    |

What each backend can see:

| Backend    | Source                                                                                 | `ran` is true when                       |
| ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| OpenCode   | `status` and `type` of the failed assistant message; socket errors to the server       | a message of the turn has a tool call    |
| Pi Durable | HTTP status of each call to the configured proxy; socket errors (proxy providers only) | the proxy accepted an earlier call       |
| Claude     | the SDK's fixed error cause and `api_error_status`; a CLI that exits without a result  | a tool call was seen, or the CLI crashed |
| Codex      | the HTTP status or failure words in the CLI's error event; a CLI that exits early      | a work item was seen, or the CLI crashed |

`ran` is false only on positive evidence: the provider refused a model call
and the turn had made no tool call before it. A CLI that ends without a
result is always reported as "may have run".

The gateway's own causes stay as before: `timeout` (turn budget),
`cancelled` (Stop), `interrupted` (shutdown) and `backend` (a failure that
no backend could classify). The gateway logs `failure`, `status`, `ran` and
`backend` at warning level and never logs error text.
