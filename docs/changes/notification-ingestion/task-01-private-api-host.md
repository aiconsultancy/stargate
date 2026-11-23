```yaml
from: delivery.md
status: ready
readiness: captain-publication-verified-implementer-rechecks-fresh-main
created: "2026-11-19"
approval:
  by: "Independent Astra High"
  date: "2026-11-19"
  evidence: plan-review.md
  reviewed-sha256: ccf63ad698ea379fe1ee9114b6fbd8a7edf5a714f8c9d0893f27bbdb62345617
depends-on: []
work-items: [NET-1733]
tracker-document-id: e8c3d40e-293b-41d8-a110-9db9a8f86e3b
tracker-document-url: https://linear.app/nettworks/document/approved-delivery-plan-private-notification-http-host-durable-core-and-9ed01fe8b367
existing-issue: NET-1733
role: L4-implementation-with-independent-L3-review
```

# Task 01: Extend the existing private API host

## Start evidence and coverage

Read `inputs.md`, `source-integration-check.md` sections 1-3, and delivery's
current-source reconciliation. Start only after independent plan approval,
task readiness and tracker publication.
Record fresh main SHA and relevant changes since admitted b9 in delivery.
PR #77 is merged; use its current types without repeating migration gates.
REQ-01, REQ-02 and the Fleet portion of REQ-10 belong here.

Use the approved single-host decision. Existing TCP Fleet configurations keep
working. Add `api.listen: "unix"` for `<dataDirectory>/api.sock`; no enabled
alias, second API subtree, simultaneous listeners or production notify route.
This PR is useful and testable as a bounded Fleet host before notifications.

Load change-readiness, TypeScript engineering/testing, boundary discipline,
model-boundary, and verification skills as applicable. Read installed Effect
guidance if touching the config codec. Preserve current mixed-schema bridges;
new boundaries use Effect helpers. Do not restore Zod in migrated consumers
or turn this task into a general schema migration.

## One-writer files

Existing:

- `src/observability/dashboard/api/v1/server.ts`, `src/observability/dashboard/api/v1/config.ts`.
- `src/lib/unix-socket.ts`, only the explicit private-mode extension.
- `tests/api-v1-server.test.ts`, `tests/api-v1-config.test.ts`.
- `tests/teams-http.test.ts`, only shared socket-helper regression if needed.
- `docs/api.md`, Fleet API section of `docs/configuration.md`.
- `CHANGELOG.md`, this unit's compatible host capability and flag note.

New:

- `src/observability/dashboard/api/server.ts`, `src/observability/dashboard/api/route.ts`.
- `tests/api-host.test.ts`.

Keep `startApiV1Server` caller compatibility so this unit does not edit runtime.
Do not edit core files, root config, `src/observability/dashboard/api/v1/gateway.ts`, API projections,
drain/steer code or package versions. Changes outside this list require a
specific interface need and plan-boundary update before a second writer acts.

## Work

1. Extract current Fleet handler policy behind the same public entry point.
   Replace its transport mechanics with one `node:http` owner. Preserve peer
   CIDR checks for TCP and existing Fleet auth, headers, methods, routes,
   encoded IDs, source cancellation, metrics and version lookup behavior.
   Unix uses filesystem ownership, not a fabricated loopback peer address.
2. Add an optional trusted exact-route list. Module/method/path uniqueness and
   namespace checks happen before bind. Reserve `/api/v1`, `/api/messages`,
   health, metrics and config namespaces. Notification mounts use canonical
   ASCII paths only. Encoded/doubled slash, dot and backslash aliases never
   match. Preserve Fleet's existing encoded resource IDs separately.
3. Define route authorization on headers, independent limits, and a signal-aware
   Promise handler. Generic host code does not import notification source types.
   An empty list leaves only the existing Fleet routes, no placeholders.
4. Implement delivery's connection/header/request bounds and admitted-work
   reservations. Count streamed bytes even without Content-Length. Reject
   conflicting/malformed framing through the HTTP parser. Retain route slots
   until handler settlement. Close rejected/slow bodies and connections.
5. Preserve Fleet SSE streaming, eight-stream cap, heartbeat behavior,
   backpressure, disconnect propagation and shutdown. Producer policy never
   inherits Fleet's browser CORS policy. Synthetic fixture routes prove this.
6. Extend the socket helper with explicit private mode while preserving its
   existing 0660 default. API mode is born 0600 under umask 0177, in an owner
   0700 directory. Reuse liveness, no-follow and identity checks. Ensure native
   server close and explicit cleanup cannot delete a replacement socket.
7. Document Unix opt-in, existing TCP compatibility and rollback. Explain that
   notification routes are not yet wired. No operator configuration is edited.

## Acceptance and focused checks

New `tests/api-host.test.ts` must drive real local TCP/Unix sockets, including
raw sockets for incomplete headers, trickle bodies and malformed framing.
Short injected timing constants avoid slow wall-clock test sleeps.

- Legacy authenticated Fleet GET/HEAD/preflight/SSE and encoded ship tests
  pass unchanged. Correct tokens still work after invalid-token throttling.
- Unix Fleet route works with operator bearer; no TCP port opens in Unix mode.
- Wrong/unknown route returns fixed failure, no body read, no secret echo.
- Duplicate mounts and reserved namespace claims fail before any bind.
- Missing/incorrect length and chunked bodies cannot exceed the route cap.
- Slow headers and unauthenticated rejected requests release connections.
- Fill notification fixture slots while a Fleet read and event stream still
  progress. A timed-out nonsettling handler retains its slot until settlement.
- Request disconnect aborts handler work; stop cancels SSE readers and timers.
- Occupied live socket, symlink, regular file and wrong owner are preserved.
  A stale owned socket is handled safely; a replacement is never unlinked.
- Existing Teams/dashboard group socket mode remains 0660; API is 0600.

Run existing regressions and the new focused suite:

```sh
mise exec -- bun test tests/api-host.test.ts tests/api-v1-server.test.ts tests/api-v1-config.test.ts tests/api-v1-gateway-version.test.ts tests/teams-http.test.ts tests/dashboard.test.ts
```

Then run delivery's full checks. No live listener or service is used.
If Bun's Node compatibility cannot enforce a required timer/connection or
SSE guarantee, retain the failing fixture and resolve that specific transport
mechanic before declaring the unit ready. Do not waive the bound.

## Finish evidence and handoff

Record base/head, commands, results, actual compatibility assertions and
independent code-review verdict. Publish the final `ApiRoute` signature and
host ownership/stop contract for task 03. Unit 02 can continue independently.
When authorized, normal PR gates apply. This author grants no Git publication.
