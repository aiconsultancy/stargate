# Effect Schema migration

Use the installed Effect 4 Schema instead of Zod for first-party validation.
Keep accepted inputs, decoded values, public configuration, stored records and
tool wire formats unchanged. Keep Bun SQLite and the Promise adapter contract.
This migration does not upgrade Effect or the SDKs.

## PR budget and batch boundaries

The revised target is **18 migration PRs in total**. Three single-schema PRs
and the native backend batch are merged. That leaves 14 component batches. One
contingency split can bring the total to 19, still below 20. Report a proposed
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

## Remaining component batches

The numbers include the four completed PRs. File names identify primary scope,
not a restriction against updating a coupled consumer. Tests belong to the batch
that owns their production boundary, rather than a separate test-only PR.

5. Shared tool validation and SDK integration. Replace `crew/tool-input.ts`,
   `crew/project-options.ts` and the schema conversion in `crew/pi-extension.ts`.
   Preserve object-root advertisements, strict operation validation, defaults,
   input transforms and project selection. Include `crew/journal.ts`, project-key
   validation and Pi history input as the first real callers. Keep legacy SDK
   registration only for unmigrated tools; remove it with the final consumer.
6. Pi and session history. Migrate `backends/pi-durable.ts`,
   `backends/pi-history.ts`, `session-history.ts` and their history consumers.
7. Configuration and provisioning. Migrate `config.ts`, `provision.ts` and the
   schema definitions composed into configuration, including provider, activity,
   mention, transcription, waiting and component settings. Include affected
   profile generation. Runtime operation schemas can remain for their own batch.
8. Crew identity and profiles. Migrate `crew/team.ts`, `crew/identity.ts`,
   `crew/models.ts` and the remaining crew/profile settings and consumers.
9. Crew execution and recovery. Migrate `crew/engine.ts`,
   `crew/reconciliation.ts`, `crew/workspace.ts`, `crew/result.ts`,
   `crew/instruction-context.ts`, `crew/shell-context.ts`, `input-boundary.ts`
   and `crew/recovery-rpc.ts`.
10. Crew messages and RPC. Migrate `crew/mesij.ts`, `crew/messaging.ts`,
    `crew/history.ts`, `crew/history-rpc.ts`, `crew/irc-rpc.ts`,
    `crew/report-rpc.ts` and `crew/waiting.ts`. Keep request/response contracts
    together with their SDK serialization and validation.
11. Fleet protocols. Migrate `fleet/` and remaining fleet policy schemas,
    including dispatch, review, verification, results and stored fleet records.
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

The Claude SDK's `tool()` helper requires a Zod raw shape, but Stargate's current
Claude backend does not call it. Its transitive Zod dependency remains SDK-owned.
Check the installed interface before migrating another SDK or RPC boundary.

Prefer Effect capabilities over other direct dependencies only after verifying
equivalent behavior and security properties. This plan does not establish that
`jose`, `croner` or `pino` can be removed without losing required behavior.
