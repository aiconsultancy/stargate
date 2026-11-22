```yaml
from: delivery.md
status: ready
readiness: captain-publication-verified-implementer-rechecks-fresh-main
created: "2026-11-19"
approval:
  by: "Independent Astra High"
  date: "2026-11-19"
  evidence: plan-review.md
  reviewed-sha256: 3b7bbb4c6fa2d840bb9c6021a660bc7ab008440f7050666e66f2873ff9acaecd
depends-on: []
work-items: [NET-1733]
tracker-document-id: e8c3d40e-293b-41d8-a110-9db9a8f86e3b
tracker-document-url: https://linear.app/nettworks/document/approved-delivery-plan-private-notification-http-host-durable-core-and-9ed01fe8b367
existing-issue: NET-1733
role: L3-implementation-with-independent-L3-review
```

# Task 02: Implement the complete durable notification core

## Start evidence and coverage

Start after independent approval, readiness and tracker publication. Record
fresh main SHA. Read delivery's core invariants, R7 sections 3-5 and 8-9, and
`source-integration-check.md` section 4.
Apply delivery's 71fc-to-b9 disposition: PR #77 is merged. Use current Effect
Schema helpers and `.Type`/Result contracts, not historical Zod call shapes.
REQ-03, REQ-04, REQ-05, REQ-07 and frozen-row parts of REQ-06 belong here.
No task-01 dependency: the core takes typed input and Promise sinks, not HTTP.

L3 owns implementation. Escalate only an actual unresolved scheduling,
cancellation or crash-recovery defect to L4. Load TypeScript engineering,
testing, change-readiness, idempotence, model-boundary and verification. Read
the installed Effect 4.1.0 `AGENTS.md` fully and inspect APIs used. Retain
`src/lib/effect.ts:abortable` settlement semantics and Bun SQLite.

## One-writer files

New production files under `src/notifications/ingest/` only:
`model.ts`, `signature.ts`, `subscriptions.ts`, `store.ts`, `sink.ts`,
`notifications.ts`. Adjacent pure helpers may share a file.

New tests:
`tests/notify-model.test.ts`, `tests/notify-store.test.ts`,
`tests/notify-core.test.ts`, `tests/notify-crash-fixture.ts`.

No root config/runtime/HTTP/Slack edits or feature switches. No production
database opens until task 03 wires the scoped service. No write to another
store or current migration worktree. Unit 01 can own all API paths in parallel.

## Work

1. Implement strict nested Effect input decoding and bounded model values,
   reusing `settingsStruct` and current schema helpers where appropriate.
   Reject supplied signatures, source/destination fields, invalid calendar
   timestamps and sub-millisecond precision. Source identity comes from the
   caller's trusted binding, not notification JSON. Derive R7's versioned
   SHA-256 projection with ordinal tags and canonical UTC milliseconds.
2. Match exact/final-`.*` topics and ANDed tag predicates. Check topic grants.
   Resolve subscriptions to unique physical destination bindings, not labels.
   Audience eligibility is checked before creating rows; an invalid binding
   or forbidden fanout refuses admission rather than silently partially sending.
3. Build a separate synchronous SQLite store with schema version, dedup table
   and outbox table. Guard private file ownership and reject symlink/corrupt or
   unsupported-version state without replacing it. Reuse the privacy pattern
   in `src/cron/store.ts:165-183`, with private mode before WAL/SHM creation,
   rather than relying on process umask. Use WAL and bounded busy timeout.
   Caller must hold the existing runtime instance lock in production.
4. Implement one admission transaction with dedup-first lookup, pending-only
   destination eviction, global/dedup capacity checks, dedup and full fanout.
   Enforce unique event/destination keys in SQLite. No send in this transaction.
5. Expose scoped Effect `Notifications.publish`. Use bounded dropping offers
   and Deferred results; one admission owner completes them after commit.
   Full queue returns QueueFull; write/capacity failures return
   StoreUnavailable;
   shutdown returns ShuttingDown; topic denial returns TopicNotGranted.
6. Implement the complete send scheduler over injected sinks and clock/timing.
   Claim commits attempt increment and lease before invoking the sink. Keep
   one active attempt per row/destination and at most four destinations active.
   Respect spacing, Retry-After and bounded backoff. Delete sent/permanent
   refusal/expired/exhausted rows. Replay unknown outcomes within the budget.
7. Recover stale leases on startup under sole ownership. Keep attempts and
   admission time, and drop exhausted/old rows without another provider call.
   Keep live in-process attempts owned even after lease expiry. Prune completed
   dedup only; outstanding rows protect their dedup record.
8. Implement close-admission, stop-claims, abort-and-settle and close-store
   ordering. A cancelled publish caller cannot undo committed work. Complete
   queued Deferreds with their actual result or ShuttingDown. Expose an explicit
   unresolved-send shutdown condition for task 03's termination hook; never
   close SQLite while local users can write. Memory telemetry resets at restart;
   attempts and age are durable. No permanent receipt API.

## Acceptance and focused checks

Use real temporary SQLite files, injected fake sinks and deterministic barriers.
Do not mock away SQLite commit/rollback. Inject faults with SQLite triggers or
a narrow transaction test seam, not duplicated production algorithms.

- Same retry, reordered tags/keys, absent/empty optionals and equivalent zones
  deduplicate. Next occurrence and another source do not. Same instant and
  identical source/content merge, with no occurrence-marker option.
- Observe commit before resolving publish. Cancel/loss after commit, reopen,
  retry: duplicate=true and one row per physical destination.
- Duplicate succeeds when store is full. Queue saturation is explicit.
  Overlap produces one row; zero matches stores dedup only.
- Fail after dedup insert, after first fanout insert and after pending eviction:
  rollback restores all old rows and inserts none. All-leased full destination
  rejects without eviction. Leased/active rows are never capacity victims.
- Completed-event pruning respects age/capacity; active rows retain dedup.
  A late event after permitted pruning can be accepted again.
- One blocked destination does not delay another. Rate limit delays are honored.
  Unknown outcomes replay at most three local claims; age ends retry earlier.
- Kill an isolated fixture before commit, after commit before response, after
  claim before send, and after fake provider acceptance before settlement.
  Reopen the same file and assert actual rows/attempts. The final case permits
  a duplicate. No power-loss durability claim is inferred from process tests.
- Restart makes stale leases eligible while preserving counters and age.
  A still-running fake sink cannot be claimed again after its lease expires.
- Shutdown resolves callers, cancels attempts and closes after settlement.
  A never-settling sink reports unresolved shutdown and leaves the store owned.
  Runtime process termination is proved separately in task 03.
- Unknown schema/corruption leaves the file unchanged and refuses startup.

```sh
mise exec -- bun test tests/notify-model.test.ts tests/notify-store.test.ts tests/notify-core.test.ts tests/effect.test.ts
```

Run delivery's full gates. Keep child-process fixtures self-contained, using
temporary paths and fake send effects only. No real transport or provider.

## Finish evidence and handoff

Record base/head, exact checks, crash/reopen observations and code review.
Hand off concrete source/binding types, publish errors, sink outcomes and
shutdown ownership API to task 03. Core tests demonstrate the whole callable
service before merge; no implementation is deferred to make task 03 pass.
