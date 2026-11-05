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

  prompt(sessionId: string, text: string, signal: AbortSignal): Promise<string>;
  interrupt?(sessionId: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
```

The opaque session ID must survive closing and reopening the adapter. Prompt
must return only the current turn's assistant text, not reasoning or prior
replies. Prompt must honour cancellation and stop underlying work, not only
the wait. Close releases owned resources, never an attached external service.
Implement interrupt if work can survive the gateway process.

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

## Initial ceilings

The initial release supports text conversations, explicit allowlists, two built-in
adapters, trusted module adapters, local setup, and user services. It does not
add file transfer, live event streaming, interactive approvals, OAuth SaaS
installation, clustering, or a plugin discovery/package system. Those require
specific use cases before extending these boundaries.
