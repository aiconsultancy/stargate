# NET-1733 independent delivery-plan review

## Verdict

APPROVED

No blocking findings or required plan edits. The completed plan and three task
files are consistent with approved R7, the selected delivery policies and the
current source anchor. The technical integration choices are approved under
the owner's delegated plan-approval instruction recorded in provenance.

This approval covers the reviewed plan revision. It does not establish code
correctness or authorize Git publication, live bindings, deployment or release.

## Reviewed artifacts

All four files were read completely and their SHA-256 values independently
matched before review. Paths are relative to this private delivery directory.

| Artifact                               | Lines | SHA-256                                                            |
| -------------------------------------- | ----: | ------------------------------------------------------------------ |
| `delivery.md`                          |   553 | `30932eab7b881d011a4cbb9853903fa38aa1fddca33b6eaa497267771203bc77` |
| `task-01-private-api-host.md`          |   120 | `ccf63ad698ea379fe1ee9114b6fbd8a7edf5a714f8c9d0893f27bbdb62345617` |
| `task-02-durable-notification-core.md` |   131 | `3b7bbb4c6fa2d840bb9c6021a660bc7ab008440f7050666e66f2873ff9acaecd` |
| `task-03-http-slack-poc.md`            |   176 | `e6d525323c5233770c92606ac7ed524e5541d6aee8b515940735cf19cb3c3e69` |

Also used updated `inputs.md`, approved R7 and the prior independent source
assessment, SHA-256
`80cee1b91e2842d07f57e04356adefbaf0c386811ae43b62cbbae8decf55a450`.
R7 remains SHA-256
`ab6025b4656308da672eb50ba8bdedced4a981dc4b1ae8f3a9c5c9da33889d50`.
Its draft header and unanswered-policy wording are superseded as instructed.

## Current-source disposition

The admitted anchor is `b9e8999a9dc0c892e00732edb74541e855a3b266`.
Read-only local Git inspection confirmed its parent
`71fc14dc070bc88135e104c3e16742e8a92c28cf` and tree
`b19e69c8adc6ac60f2b00917d7a4fe995a6956e1`.

The relevant migration diff was inspected in `src/app/runtime.ts`,
`src/gateway/routing.ts`, `src/gateway/peers.ts` and `src/gateway/store.ts`. The plan correctly adopts
Effect Schema/Result decoding and current inferred/mutable types. Instance
ownership, API acquisition, peer access policy and store transactions retain
the integration contracts examined in the earlier assessment.

Git comparison confirmed no delta in the inspected API server/config,
root config/setup/reload, Effect bridge, Slack connection/formatting,
Teams Unix helper, cron-store privacy pattern, settings helpers, gateway
version implementation, `mise.toml` or `package.json`.
Thus `delivery.md:120-149` correctly dispositions the material source change.
The captain's supplied merge/Quality receipt was not re-investigated.
No migration tests or reviews were repeated.

## Prior integration constraints resolved

### Single API owner and separate authority

`delivery.md:151-222` and task 01 retain the existing public server entry point
and top-level API configuration. `api.listen: "unix"` selects one private
endpoint. Legacy TCP settings retain their meaning; notification enablement
requires Unix mode. There is no simultaneous second API listener or implicit
producer exposure through an existing Fleet TCP/proxy endpoint.

The proposed Node HTTP owner is a bounded replacement for listener mechanics,
using existing repository precedents. It preserves Fleet paths, credentials,
private-peer checks, CORS, read behavior and SSE rather than applying producer
policy globally. Producer credentials cannot become operator credentials.
Equal cross-role or ambiguous source credentials are rejected. Producer
Origin/preflight rejection and header-only auth precede body processing.

Task 01 owns direct TCP/Unix, raw framing, deadline, reserved-capacity,
SSE/backpressure and socket-replacement checks. The 0600 socket extension
preserves the existing helper's 0660 default. These acceptance checks must
pass before its transport adaptation is implementation-complete.

### Offline echo exclusion and current bindings

`delivery.md:257-284` resolves the missing offline identity information
conservatively. Static uncertainty cannot permit a potentially peer-admitting
destination. Startup identities refine checks without weakening offline
rejection. The sender is conservatively treated as a possible verified
captain, so a later display-name change does not invalidate the argument.

Task 03 freezes registration/app/workspace/user/channel and both audiences.
It uses current access and receiver policies immediately before sending,
including access changes between claim and send. Rebinding drops stored work
rather than selecting a new destination. Backend/model identity is excluded.
Ordinary peer chat remains unchanged. Task 03 owns the negative admission
and live-reload tests; no new identity service or config-check network call
is required.

### Early close and non-settling process termination

`delivery.md:395-421` and `task-03-http-slack-poc.md:96-108` close producer and
core admission in the early shared intake-close phase, before worker
interruption. A referenced 25-second timer is armed before waiting on
settlement. Its runtime-owned production action exits nonzero. It does not
release SQLite or the instance lock while local users remain active.

Task 02 owns waiter resolution, stopped claims, cancellation and settlement.
Task 03 owns startup-failure integration and a child-process hard-exit test,
including retained-row reopen evidence. This resolves the earlier gap where
an abort or timed-out finalizer alone could leave a live writer. Existing
agent drain/steering and later Fleet/backend cleanup retain their ownership.

## R7 coverage and slice boundaries

The core invariants at `delivery.md:356-393` and task 02 cover strict
occurrence identity, source grants, physical destination deduplication,
commit-before-acceptance and transactional all-or-nothing fanout. They include
rollback after tentative pending eviction, protected leased rows, bounded
dedup retention, persisted attempts/age and bounded unknown-outcome replay.
There is no occurrence marker, receipt API or agent-work retry path.

Task 03 combines auth, source binding, bounded HTTP admission and literal
Slack delivery in one default-off integration. Separate plain-text sections
keep accepted title/body/URL within provider block limits in one send.
Request-scoped fetch cancellation retains SDK timeout/zero-retry behavior;
ambiguous dispatch outcomes remain unknown. Real temporary SQLite and local
fake HTTP/sinks test these boundaries, including zero notification-origin
Gateway/backend calls.

Units 01 and 02 have disjoint ownership and independent useful acceptance.
The host serves real Fleet reads; the core is complete and callable with fake
sinks. Neither depends on unfinished integration. Unit 03 follows both merges
and is the sole root-config/runtime integration writer. L4 host/integration
and L3 core assignments match the requested routes and escalation policy.
Independent code review and normal exact-head checks remain required.

`delivery.md:511-531` provides additive rollout and safe rollback. Disabled
notification adapters create no notification store, routes or workers.
Downgrade removes unsupported notification/Unix settings while retaining
private state and preserving existing Fleet configuration where applicable.
Deferred poller, IRC, cloud and live proof do not gate local implementation.

## Readiness by slice

| Slice                      | Plan readiness                                       | Remaining prerequisite and owner                                                                                                                           |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01, private API host       | Ready for implementation admission                   | Captain records this approval and publishes/reads back the existing tracker mapping. Implementer checks fresh main and uses the planned isolated worktree. |
| 02, durable core           | Ready for implementation admission, parallel with 01 | Same publication and fresh-main prerequisites. L3 implements only its core/test files.                                                                     |
| 03, HTTP/Slack integration | Approved; dependency-blocked                         | Captain waits for 01/02 to merge with their evidence and interface handoffs. L4 then reconciles current main and owns integration.                         |

Publication is explicitly deferred until this verdict in
`delivery.md:62-68`; that is a captain execution prerequisite, not a missing
design decision. No additional human design approval is needed.

## Findings and limits

Blocking findings: none. Required smallest fixes: none.
No editorial preference is a readiness blocker.

The remaining implementation uncertainties already have owners and direct
checks: Bun's Node HTTP behavior in task 01; atomicity/replay in task 02;
real request cancellation, current-binding checks and teardown in task 03.
Approval does not waive a failed check or permit extra infrastructure.

This was a static artifact and material-source-delta review. No code tests,
runtime probes, installs, services, network requests or secret-config reads
were performed. No author artifact, source, branch or index was edited.
Only this review note was written.
