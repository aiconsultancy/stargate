# Effect Schema migration

Use the installed Effect 4 Schema instead of Zod for first-party validation.
Keep accepted inputs, decoded values, public configuration, stored records and
tool wire formats unchanged. Keep Bun SQLite and the Promise adapter contract.
This migration does not upgrade Effect or the SDKs.

## PR budget and batch boundaries

The revised target is **18 migration PRs in total**. Eleven migration PRs are
merged. That leaves seven component batches. One contingency split can bring the
total to 19, still below 20. Report a proposed
budget change before opening another PR; do not weaken verification to fit it.

This replaces the original estimate of approximately 410 one-schema PRs. The
inventory at `2ef51cf` found 348 named schema bindings and 52 inline parse
boundaries, plus schema factories and shared shapes. These are migration work
units, not separate PRs. Nested fields and inferred aliases are not extra PRs.

Each batch replaces a connected set of validators at one component boundary.
Its inferred types, direct consumers and parity tests travel together. Reconcile
new schemas from current main before starting a batch. Move coupled definitions
between the planned batches when composition requires it. Do not introduce an
adapter merely to retain an artificial file split. Do not stack migration PRs.

Completed:

- [Claude session UUID schema](https://github.com/aiconsultancy/stargate/pull/43).
- [OpenCode pairing-response schema](https://github.com/aiconsultancy/stargate/pull/44).
- [Azure transcript-response schema](https://github.com/aiconsultancy/stargate/pull/45).
- [Remaining native backend validators](https://github.com/aiconsultancy/stargate/pull/48).
- [Shared tool envelopes, journal and project selection](https://github.com/aiconsultancy/stargate/pull/49).
- [Pi and shared session history](https://github.com/aiconsultancy/stargate/pull/51).
- [Configuration, provisioning and composed settings](https://github.com/aiconsultancy/stargate/pull/66).
- [Crew identities, teams, models and profiles](https://github.com/aiconsultancy/stargate/pull/67).
- [Crew execution and recovery](https://github.com/aiconsultancy/stargate/pull/70).
- [Crew messages, history and local RPC](https://github.com/aiconsultancy/stargate/pull/71).
- [Fleet protocols](https://github.com/aiconsultancy/stargate/pull/72).

The first batch-6 timing pair failed at +18.27%. Its diagnostic pair measured
+2.63% with retained coverage; this is not a performance repair. The earlier
batch-4 first-pair +10.9% failure also remains recorded.

## Remaining component batches

The numbers include the eleven completed PRs. File names identify primary scope,
not a restriction against updating a coupled consumer. Tests belong to the batch
that owns their production boundary, rather than a separate test-only PR.

12. Chat routing and interaction envelopes. Migrate `routing.ts`,
    `interactions.ts`, `cancellation.ts`, `meta-commands.ts`, `questions.ts`,
    `pairing.ts`, `peers.ts`, `thread-context.ts`, `crew-ui.ts`, `irc/` and
    `teams/registration.ts`. Include remaining queue-record validation in
    `store.ts` and transport consumers.
13. Files and delivery. Migrate `attachments.ts`, `slack-files.ts`,
    `captain-post.ts` and remaining media/delivery schemas and consumers.
14. Cron operations and records. Migrate `cron-control.ts`, `cron-store.ts`,
    `cron-ui.ts`, `cron.ts` and `cronjob-files.ts`.
15. Status, quota and notifications. Migrate `crew-status.ts`, `status-report.ts`,
    `quota.ts`, `quota-watch.ts`, `health.ts`, `health-host.ts`,
    `notification-store.ts` and `notifications.ts`. Include report/UI consumers.
16. Maintenance records and readiness. Migrate `maintenance.ts`,
    `nightly/state.ts`, `nightly/ready.ts`, `nightly/journal.ts`,
    `nightly/report.ts` and remaining maintenance configuration/record schemas.
17. Maintenance execution and migration scripts. Migrate the remaining
    `nightly/` validators and `scripts/bootstrap-stargate.ts` and
    `scripts/migrate-stargate-state.ts`.
18. Dependency removal. Check for residual first-party Zod use in production,
    tests and tooling. Remove obsolete bridges and the direct Zod dependency.
    Keep SDK-owned transitive Zod and dependency provenance checks.

Inspect imports and schema composition before finalizing each batch's scope.
Execute shared prerequisites first. A dependency can move into an earlier batch
without creating another PR. Each merged batch must leave main working.

For mixed composition, add an adapter only when the selected schema requires
one. It must delegate to the authoritative Effect decoder, not copy its rules.
Remove the adapter when its remaining consumer migrates.

### Configuration settings composed into later batches

Migrated components use `settings-legacy.ts` only where an authoritative Effect setting is
still embedded in a Zod container. It does not retain a second validation rule.
Remove each bridge with its owning container:

- Engine inbox/mail now compose native task-ID/text primitives directly;
  batch 10 removes their two bridges. Batch 9 removed the team/agent-ID and
  quota-configuration bridges with their native parents.
- Fleet identifiers, repositories and review-worker settings now compose
  directly into native runtime protocol/control records. Batch 11 removes
  their four bridges with the actual parents.
- Cron destination identifiers in `cron-control.ts`: batch 14.
- Cleanup paths in maintenance result records: batch 16.

The cron tool's JSON advertisement remains derived from the setting codec,
including when the existing tool-input projection selects a transform's input.
Settings defaults retain the legacy decoded-value fallback and shallow-copy
semantics. They must not re-run input transforms or validate the fallback as
an input. Configuration string limits count Unicode code points; a regex keeps
its original JavaScript flags and its existing advertised pattern.

`loadConfig` is a human-facing error boundary for maintenance and transcript
commands. It collects all native field errors and preserves safe custom
diagnostics after non-aborting child constraint failures. This failure-only
pass runs the same annotated checks on structurally decoded values; it cannot
accept a configuration. Fixed safe error messages in setup, provisioning and
reload remain unchanged. Native vendor issue objects and duplicate ordering
are not copied into the public error format.

Crew's OpenCode adapter projects a strict object root and preserves field order,
field trimming and nested defaults. Top-level branch defaults stay with the
handler. Pi retains an exclusive operation
union with required defaulted fields and installed argument coercion. Its crew
decoder is separate from journal/history. The reviewed native advertisement
projector is shared without adding a Zod advertisement validator. Batch 18 must
retain or move its pure functions when removing the legacy-bridge module;
crew's native adapters still use them. Recovery RPC
uses native codecs through the installed Promise SDK's Standard Schema input
contract; nested strictness does not depend on caller decode options. Resume
remains a general crew operation, not an operator recovery RPC operation.

Mail, history and DM use their own native SDK adapters, not the crew-operation
adapter. OpenCode's DM object applies text trimming and its delivery default.
Flattened mail/history unions apply field transforms but leave top-level branch
defaults to handlers. Pi mail/DM explicitly select their own parameters and
decoders; native argument coercion still precedes handler trimming. Mesij text
remains untrimmed with a 65,536-code-point limit, distinct from crew send's
trimmed 64,000-code-point limit. Strict old task envelopes and loose modern
text envelopes remain separate. IRC/local-report RPC retain structured output
and native nested-strict decoding/encoding. Quota's Zod project helper remains
until batch 15; the unused project-selection alias is removed with IRC's native
consumer. Batch 18 must retain/move the pure projectors these adapters use.

Fleet runtime codecs preserve strict nested decode/encode behavior and schema
field order. The tool registrations keep their original object/union forms
through native Standard Schema adapters and the existing pure projectors.
UTC timestamps retain their spelling and require calendar-valid dates, seconds
and uppercase Z. Review diff/proof UTF-8 bounds remain separate from code-point
string bounds. Store's maker reads remain unbounded; writes and backend result
validation retain their 100-maker limit. No fingerprint, proof immutability,
queue-before-ACK, permission or recovery algorithm changes with these codecs.

## Verification and merge

Before replacement, characterize the existing boundary with valid, invalid and
edge inputs. Compare acceptance, decoded output, defaults, transforms, missing
versus null values, strict or stripped object keys, issue paths and safe errors.
Preserve synchronous behavior and cancellation where applicable.

Check string length units against the installed validator. Zod 4.6.7 counts
Unicode code points for journal text and member limits, not UTF-16 code units.
Preserve those accepted inputs when selecting Effect string checks.

The first UUID migration preserves the existing case-sensitive max-UUID rule.
Effect's general UUID check also accepts uppercase or mixed-case max UUIDs;
the old Zod boundary accepted that sentinel only in lowercase. Ordinary UUIDs
remain case-insensitive and are forwarded without changing their spelling.

Each batch needs focused parity tests, strict TypeScript, Biome, full required
quality gates and clean independent review. Preserve the coverage and runtime
requirements. A measured full-suite duration increase above 10% fails the
runtime condition; do not reduce test selection or raise deadlines to hide it.

Commit through ordinary hooks. Require Quality checks on the exact head before
squash auto-merge. Verify the merged SHA, then start the next batch from current
main. Failed checks or unresolved review threads stop advancement.

## SDK boundaries and dependency removal

OpenCode's installed tool interface accepts Effect codecs directly. Pi Durable
accepts JSON Schema and validates and coerces arguments before execution. Verify
its dialect, definitions, required fields and coercion against that existing SDK
boundary as well as the Effect decoder. The old Pi advertisements require some
fields whose decoders have defaults. Preserve that native acceptance; do not
silently fix an advertisement/default mismatch during this migration.

OpenCode RPC decodes Effect codecs with default options. Strict history objects
must reject unknown keys at that boundary, before a decoder can strip them.
Check nested input and output objects through the installed client as well as
direct decoders. Use Effect's Standard Schema adapter where client types require
it; verify that the installed SDK still recognizes the underlying Effect codec.

The Claude SDK's `tool()` helper requires a Zod raw shape, but Stargate's current
Claude backend does not call it. Its transitive Zod dependency remains SDK-owned.
Check the installed interface before migrating another SDK or RPC boundary.

Prefer Effect capabilities over other direct dependencies only after verifying
equivalent behavior and security properties. This plan does not establish that
`jose`, `croner` or `pino` can be removed without losing required behavior.
