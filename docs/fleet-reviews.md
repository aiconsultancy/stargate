# Opt-in native PR review evidence

Fleet review evidence is disabled unless the gateway has `fleetControl.reviews`
and the native fleet plugin has `reviews: true`. Installing Stargate or its
plugin does not enable reviews or grant merge permissions. Durable
`fleetControl.results: true` and a pinned OpenCode V2 root are required.

The gateway owns review assignments, native admission and immutable proofs in
its private shared ledger. Engine users may call their protected socket, but
must not read or replace that ledger or its socket directory. A source-control
integration owns repository policy, credentials, review publication and merge.
Stargate contains no source-control endpoint, App identity or credential.

## Configure identities and model selectors

Configure the exact repositories, native PRIMARY profiles, permanent
directories and approved native provider/model selectors. Names below are
placeholders for profiles the operator has already installed:

```json
{
  "reviews": {
    "repositories": ["example/project"],
    "reviewers": [
      {
        "agent": "code-reviewer",
        "kind": "crew",
        "family": "codex",
        "directory": "/srv/ship/review-code/project",
        "models": [
          { "provider": "approved-provider", "model": "configured-code-model" }
        ],
        "permissions": [
          { "action": "read", "resource": "*", "effect": "allow" },
          { "action": "glob", "resource": "*", "effect": "allow" },
          { "action": "grep", "resource": "*", "effect": "allow" }
        ]
      }
    ]
  }
}
```

This object belongs under `fleetControl`. Reviewer agent IDs must be unique.
The `family` is an operator policy label: every actual native assistant maker
must match that reviewer's exact approved provider/model selectors. Optional
`variant` narrows a selector. A consumer must also check the actual maker
selectors against its own protected policy; a family label alone proves nothing.

The gateway creates dedicated review sessions using those existing named
profiles. Worker sessions default to deny all tools, followed by the explicit
review permissions. Worker allow rules support only `read`, `glob` and `grep`;
`ask`, shell, editing and subagent grants are refused. No implementation
worktree is checked out, reset, moved or reused as a new per-task worktree.
Native running and queued work in a configured directory blocks admission.
The complete review diff is supplied directly; extra repository context must
come from immutable objects at the requested head, never an unrelated base
working tree. An incomplete review must not approve.

An entry with `kind: "captain"` can substitute when its actual native model
matches the required family. Its agent and directory must match the existing
configured root. This reads the original structured-review ingress input; it
never creates another captain, changes root permissions or selects the latest
conversation. A native input cannot attest more than one review proof.
Native history must also show only the supported read-only inspection/skill
and fleet-review control tools. A captain's existing implementation permissions
are not replaced, but using a shell, edit or other unrelated tool in the review
input prevents an approving proof. Prepare remote context before dispatch.

Add an explicit native and gateway `fleet_review` allow rule. Its resource is
the review assignment ID for `op: "start"`, or the proof ID for `op: "status"`.
Missing permissions fail closed. Review controls do not support `ask` and do
not create human permission offers.

## Bind the complete PR context before dispatch

The author ship's source-control integration fetches the complete current PR
diff, repository, PR number, head SHA, base SHA and merge-base SHA. Supply the
unaltered UTF-8 textual diff in `fleet_dispatch.review`:

```json
{
  "target": "independent-captain",
  "sourceReference": "authenticated-source-reference",
  "text": "Coordinate independent reviews of this exact PR",
  "review": {
    "repository": "example/project",
    "pullRequest": 7,
    "headSHA": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "baseSHA": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "mergeBaseSHA": "cccccccccccccccccccccccccccccccccccccccc",
    "context": "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"
  }
}
```

The gateway derives the author ship from its actual identity and the coordinator
from the configured target. They must differ. It records a unique review ID and
SHA-256 context digest before IRC delivery or native admission. The wire message
contains identifiers and the digest, not the diff. Authenticated coordinator
intake adds the exact private context to the retained native input. Ordinary
chat or a copied dispatch cannot establish this binding.

Context must be well-formed UTF-8 with structurally complete unified diff hunks.
There is no default PR-size eligibility limit. Optional operator configuration
`reviews.maxDiffBytes` accepts a positive safe integer; absent or `null` disables
that policy. A configured limit counts UTF-8 bytes and is checked before dispatch,
coordinator intake and native review admission. It is retained with a new native
binding and checked again when reading native evidence. Green-specific values
do not belong in this generic configuration.

The existing local HTTP request capacity remains 1,000,000 bytes, including JSON
framing and escaping. Exceeding it is a technical transport failure, not a claim
that the PR is ineligible. Missing, binary, partial or ambiguous context is
refused; nothing is truncated or automatically filtered. The external integration must independently
verify that the diff covers the _whole_ PR, including all files and line totals.
The gateway cannot establish completeness against a remote service it does not
contact.

New review prompts ask the actual reviewer to choose and state a risk-based
scope. A reviewer may skip mechanical generated sections, but must identify
the files/sections and reasons in its summary/findings and assess semantic
migration/schema changes and generated consistency. The full-diff digest proves
which immutable context was supplied; it does not prove every line was
scrutinised. Do not claim full coverage for omitted material. Model context,
timeout or transport failures cannot become approving proof and are not
automatically retried. Existing pending reviews keep their original prompt
bytes. This version still supplies the full diff; manifest/chunk retrieval for
larger contexts is a separate extension.

The coordinator invokes `fleet_review` with
`{"op":"start","reviewID":"...","reviewerAgent":"..."}` for each configured
reviewer. The gateway binds the exact active coordinator input, persists fresh
worker session/input IDs and a nonce, and then makes one native SDK admission
attempt. Existing native crew databases or model-supplied completion claims do
not provide evidence. Named review sessions use the existing profiles and
permanent directories, without changing normal crew task ownership.

## Native completion and recovery

Only retained native SDK history can complete a review. The gateway requires the
exact input/context, native session ownership, completed assistant messages,
actual agent/provider/model metadata and a final structured JSON verdict. A
later human request cannot change that input or supply its answer. Mixed or
wrong models, quoted text, a failed inference, missing history and unfinished
work provide no approving proof. Provider/model fields report native execution
metadata; they do not independently attest an upstream service behind a proxy.

The native final JSON includes `repository`, `pullRequest`, `headSHA`, `baseSHA`,
`mergeBaseSHA`, `contextDigest`, `verdict` (`approve`, `request_changes` or
`comment`), `summary` and a string-array `findings`. Its visible result text is
retained without truncation and hashed as UTF-8 SHA-256. Reasoning and tool
payloads are not part of the proof.

Reservations and proofs survive restart. Retrying a start returns the same
reservation. Recovery reads at most 100 outstanding reviews per poll and rotates
through them with a persisted per-coordinator cursor, so stuck uncertain inputs
cannot permanently hide later completions. A lost admission receipt is uncertain
and is never resubmitted.
Read-only recovery may retain a later _exact_ native completion for its already
bound session/input; it never starts another execution or rebinds an old result.
Do not delete state to retry a review. Every proof remains agent evidence with
`authority: "agent"` and `humanApproval: false`.

## Protected helper lookup and publication

The owning helper can read proofs through the existing protected Unix socket,
without inventing a native tool context:

- `GET /reviews/<proofID>` returns `{"proof": ...}` for a completed proof.
- `GET /reviews?repository=example/project&pullRequest=7&headSHA=<sha>` returns
  `{"proofs": [...]}` for that exact target.

Only the author, coordinator or reviewer ship can read a proof. Disabled
configuration, missing or uncertain evidence cannot return an approving record.
These endpoints are read-only: they cannot admit work, register a completion,
publish a review or grant authority.

Proofs bind `id`, `reviewID`, repository/PR/head/base/merge-base, `contextDigest`,
`authorShip`, `coordinatorShip`, `reviewerShip`, `reviewerAgent`, `kind`, native
`sessionID`/`inputID`, actual `makers`, policy `family`, native `verdict`,
`resultText`, `resultDigest`, completion time and non-human authority. Makers
include native assistant `messageID`, `agent`, `provider`, `model` and optional
`variant`.

The integration publishes through the _reviewer_ ship's source-control identity
and puts the proof ID, digest, native provenance and verdict on the PR. Before
publication and merge it independently re-fetches the exact current head, base,
merge-base and complete diff, then checks the stored context digest. Merge also
re-fetches actual review authors, states and commit IDs, validates their bodies
against the immutable private proofs, and checks required checks and branch
policy. Quoting a review, posting a comment, or naming a model is insufficient.
Both required model families may use one independent ship, with distinct native
review inputs and matching published evidence. A final merge must specify the
checked head SHA and use no administrative bypass.

Old-head proofs are retained for audit and cannot approve a changed PR. Source
control identity, live publication and merge acceptance remain integration
requirements; a passing local fixture test does not establish a live review.
