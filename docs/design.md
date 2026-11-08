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
depends on a particular agent protocol. The first release uses Promise-based
TypeScript and Bun's standard APIs; Effect is not required.

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
  ): Promise<string>;
  interrupt?(sessionId: string, signal: AbortSignal): Promise<void>;
  startActivity?(
    sessionId: string,
    requestID: string,
    reporter: string,
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

`onText` receives cumulative visible text for the current turn. It is optional;
existing module adapters can continue returning only their final answer.
Callbacks must not include reasoning, tool arguments, or tool results. The
gateway buffers snapshots and performs Slack writes separately. OpenCode uses
live text events and reads final history as the source of truth. If the event
connection fails, final delivery continues without replaying agent work.

`startActivity` is an optional, request-scoped reporting capability. Its
`ActivityWatch` reads bounded visible task activity and can finish or cancel
the capture. OpenCode implements it through the location-scoped Pogo reporting
RPC. Other adapters remain compatible without it. The gateway manages report
delivery separately from answer delivery, with its own deadline and access
rechecks. See [crew activity](crew-activity.md) and [`activity.ts`](../src/activity.ts).

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
