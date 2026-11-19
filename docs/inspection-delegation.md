# Task-scoped inspection delegation

A configured, pinned captain can grant one assigned worker read-only
`stargate_crew inspect` access to **one explicit current task** in the same
team and project context. OpenCode workers and coding-enabled Pi workers use
their own saved identities. They never become captain. Without a matching
grant, existing crew-tool guards remain unchanged.

**Current SDK boundary:** OpenCode V2 SDK 2.2.7 exposes permission assertions
that can prompt, pending requests, saved approvals and raw session/agent rules.
It does not expose a read-only effective-permission evaluator that includes
current policies and permission hooks. The plugin therefore cannot prove the
issuer's continuing native `inspect` authority during another worker's call.
It supplies **no production issuer evaluator**: delegated snapshots and worker
audit reads fail closed with `unavailable`, before protected data is read.
Issuance, captain list/audit/revoke and ordinary crew tools remain supported.
Local fake-runtime tests explicitly supply owner-bound read-only issuer proof;
this is not a native SDK feature or a model-supplied callback. Do not activate
worker inspection by assuming raw rules are complete or by asserting as a
foreign captain. A future supported read-only evaluator is required.

This first slice does not activate grants, change native permissions, add
roles, create sessions, or change an installed service. A native deny always
wins. Pi `tools: "none"` remains tools-off.

## Policy

- Humans are Fleet Admirals. Rank alone conveys no runtime powers. A Rear
  Admiral or Commodore can receive a valid grant as a configured assigned
  worker, but cannot issue or onward-delegate because of that title. Only
  the team's configured pinned captain can issue this first slice.
- **There is no human issuer path.** Human-account attribution cannot prove
  human origin when an agent can post through that account. Agent-authored
  claims, quoted approval and claimed human identity fail closed. Human
  grants need independent trusted confirmation before a future implementation.
  Fleet instruction evidence still returns `humanApproval: false`; see
  [fleet tools](fleet-tools.md#original-instructions-and-authority).
- Never delegable: owner-only design approvals, infrastructure apply,
  Stripe operations, sandbox approval steps, Omega Directive, credential
  and access approvals, and safety, identity, ownership and deployment guards.
  This capability cannot authorize any operation except the selected read.
- No cross-ship grants. Fleet names, rank and a common human account do not
  convey Galactica, Avondale, Pegasus or jt-ship authority. Future cross-ship
  delegation needs explicit source/destination policy and destination consent.
  Another namespace, project state owner or session is denied now. Supported
  append-only roster expansion preserves old grant metadata and audits; it
  never adds resources or recipients to an existing grant.

## Tool surface

These operations use the existing protected `stargate_crew` tool and its
native permission action. No new native permission rule is installed.
Issuance asserts both `grant-inspect` and `inspect` for the actual native
captain caller, including exact retries. An `inspect` deny prevents issuance
even when `grant-inspect` is allowed. Missing actual-caller permission callbacks
are denied on OpenCode; callback-free access exists only for the verified
host-bound coding Pi conversation.

| Operation                | Caller                            | Purpose                              |
| ------------------------ | --------------------------------- | ------------------------------------ |
| `grant-inspect`          | Configured pinned captain         | Issue one bounded handle             |
| `list-inspect-grants`    | Captain or current worker         | Page own issued or received metadata |
| `inspect` with `grantID` | Exact assigned recipient          | Read the exact allowed target        |
| `revoke-inspect`         | Issuing captain                   | Persist terminal revocation          |
| `audit-inspect-grant`    | Issuer or valid current recipient | Page one grant's audit               |

Both recipient and target must have current **running** tasks owned by that
exact captain session. Legacy captain lineage does not authorize delegation.
Both peers must retain their verified registered identities, and neither
worker may hold a controller reservation. The finite scope is exactly one
`{crew, taskID}` target; there are no wildcards or directory scopes.

Captain example (replace IDs and set an actual future expiry):

```json
{
  "op": "grant-inspect",
  "crew": "worker",
  "taskID": "task_recipientOrder",
  "resource": { "crew": "helper", "taskID": "task_targetOrder" },
  "expiresAt": "2026-11-17T12:05:00Z",
  "key": "inspection-for-order-1"
}
```

Expiry is required, absolute RFC3339 with a timezone, in the future, at most
**15 minutes** after issuance. No automatic renewal or subdelegation exists.
The host clock is trusted. A clock earlier than issuance is denied.
Task completion, cancellation, uncertainty, release or reassignment denies
further reads, even before expiry. A newly issued grant requires a new
explicit captain call and a new key.

The result returns an `inspect_…` handle and non-secret grant metadata.
The recipient can discover handles with `list-inspect-grants`, then use:

```json
{
  "op": "inspect",
  "crew": "helper",
  "taskID": "task_targetOrder",
  "grantID": "inspect_0123456789abcdef0123456789abcdef"
}
```

The response contains only the target member, task ID, task status and native
execution state (`running`, `idle` or `unknown`). It omits prompts, results,
notices, queue entries, controller tokens/IDs, reconciliation and abandonment
records, and unrelated session data. A Pi target uses only an in-process
observation; it never opens a runtime to prove idle. An unavailable native
snapshot reports `unknown`, not permission to recover or replay work.

`requestStatus` is refused. The grant cannot send mail, wake a worker,
reconcile, promote a queue, inspect/edit a workspace, dispatch, maintain a
host, change models, issue another grant or perform any other mutation.
Audit writes are the only side effect of a delegated inspection.

Revoke with `{"op":"revoke-inspect","grantID":"inspect_…","key":"revoke-1"}`.
Issuance and revocation keys bind the exact validated arguments and issuer
in a SQLite transaction. Exact retries return the retained grant's current
metadata; changed arguments with the same key fail. Retries never renew or
restore a revoked grant. Repeated valid reads are allowed and each is audited.

List/audit pages use `after` and `limit` (default 20, maximum 50), returning
`nextAfter`. Captains can review retained issued grants and their audits.
Workers can list only metadata received for their own current order; terminal
grant metadata is not authority to read its target. Worker audit access also
requires a still-valid grant. No global worker audit surface exists.

## Proof, revocation and limits

`CrewState` owns the additional tables in its existing private SQLite file.
A random server-managed HMAC-SHA256 key authenticates the handle, protocol
version, stable namespace/project/captain identity fingerprint, issuer session, recipient and
target task/input/session bindings, saved Pi conversation bindings, issuance,
expiry and revocation. The key and MAC never enter prompts, tool arguments,
tool results, audit records or journals. Handles are selectors, **not bearer
tokens**. Copying one to another worker or ship conveys no authority.

The normal authorizer checks the actual host caller. Before each snapshot and
after its awaited reads it verifies issuer/recipient/target identity and the
current task, scope, expiry, revocation and controller state. The protected
OpenCode tool also repeats its actual caller's native permission check before
data release. Protected use additionally requires fresh read-only issuer
permission proof, before and after the snapshot. Without that proof the plugin
fails closed as described above; issuance-time approval is not continuing
issuer authority. The signed original recipient/resource bindings remain exact
across supported roster expansion. CrewState still checks the full roster and
directories before accepting an expansion.
Revocation does not interrupt unrelated work. An in-flight read may finish
internally, but a failed final check releases no protected snapshot.

Issue, use, admitted denial, observed expiry and revocation record fixed safe
reasons, outcome, time, operation, team fingerprint, issuer, recipient/order,
target and actual caller identity. Unknown or invalid proofs have no trusted
grant attribution. Raw rejected tool-schema inputs can be rejected by the
native host before the owner runs; the owner does not capture their contents.
Neither arbitrary reason text nor SDK exception text is stored.
Known invalid recipient and unknown handle reads share the same identity
denial, before revealing scope, expiry or revocation details. Unexpected failures
use `unavailable`; an aborted caller uses `cancelled`, not a false identity
diagnosis. Audit `actor` is the host session; `agent` is its native label at
tool admission or its mapped crew label after engine authorization. These labels
are context, not rank or an additional authority proof.

Reopen preserves the key, receipts, revocations and audit. Missing proof custody
with retained grants fails closed; it is not automatically replaced. Restart
never reissues a grant. Missing/malformed key custody disables only delegation;
ordinary crew, status, inspection and recovery remain available. Retained grants,
receipts and audits are not erased or re-signed. No broker, replacement state owner or permission
expansion is added.

Audit output is paginated, but local audit storage has no retention or write-rate
limit in this slice. Repeated calls can grow the private database. Operators
must monitor disk use and preserve evidence; no automatic cleanup job is added.

This is a **same-OS-user cooperative policy**, not a sandbox or independent
human approval proof. An agent with engine write access or access to the private
SQLite/key can bypass policy, forge records or restore an old database. HMAC
detects changed claims without the key; it cannot resist that host compromise
or database rollback. Use separate OS identities and independent key custody
for such a threat model. Human and cross-ship delegation remain unimplemented.
