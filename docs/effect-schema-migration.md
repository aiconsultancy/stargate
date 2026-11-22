# Effect Schema migration

Use the installed Effect 4 Schema instead of Zod for first-party validation.
Keep accepted inputs, decoded values, public configuration, stored records and
tool wire formats unchanged. Keep Bun SQLite and the Promise adapter contract.
This migration does not upgrade Effect or the SDKs.

## Touched-file ratchet

Any substantive change to a file importing `zod` must replace that file's
Zod schemas with Effect Schema in the same change; otherwise revert the touch.
CI enforces this on every pull request through `scripts/hooks/touched-zod.sh`.
The guard compares committed HEAD with the merge base of the supplied PR base.
It checks TypeScript files under `src`, `scripts` and `perf`. Direct imports,
subpath imports, reexports, import types, dynamic imports and `require` calls
all count, including single-quoted and static template literals.
Untouched Zod files keep working until their migration batch.
The legacy-oracle tests are exempt: they compare
against captured Zod behaviour by design and stay until the migration
removes the oracle.

**Decision (operator, 21 November 2026):** the ratchet intentionally
outranks the batch boundaries. A fix that touches a Zod file migrates that
file immediately, even mid-batch inside an otherwise unrelated PR; record
such a forced migration under the file's home batch so the remaining budget
stays accurate. Batches remain the plan for _untouched_ files.

### NET1766 mechanical import/path exception

The operator permits existing Zod imports to survive a narrowly verified move.
This exception does not permit new Zod imports or unrelated source edits.
The ordinary CI command applies these checks automatically. There is no label,
environment switch or alternate CI mode that bypasses them.

- The source must be an existing scoped base file or a Git-detected rename
  from one. Git compares all paths with 50% rename similarity. An added file
  or copy cannot inherit a legacy file's imports. A move that Git does not
  identify as a rename fails while it retains Zod.
- The guard parses committed source with the installed TypeScript API. It
  compares exact source text, not a token sequence with whitespace removed.
  Comments, formatting, ASI-sensitive newlines, import declarations, bindings,
  Zod specifiers and executable code must remain byte-identical.
- Only relative static import/reexport and dynamic import literal contents
  can change. Each target must resolve uniquely in both Git trees to the same
  base file, applying the actual rename map. An in-place consumer can change
  a path only when its target was renamed. A moved consumer can update paths to unchanged
  targets. The guard also checks unchanged relative paths in these
  files, so moving a consumer cannot silently select a different target.
- Resolution supports regular `.ts` files through explicit `.ts` paths,
  extensionless paths and directory `index.ts` paths. Ambiguous file/index
  candidates, symlinks, aliases, package resolution and JS-to-TS mappings are
  not proof of identity. Unresolved or unsupported paths fail the exception.
  Changed literals cannot change quote kind or use escaped path spellings.
- `require`, import-equals and import-type expressions must remain unchanged.
  A Zod file with a relative expression of one of these forms cannot move
  through this exception. Nonliteral dynamic imports and `require` arguments
  prevent a retained-Zod file from qualifying for the exception. They do not
  cause the ordinary guard to reject clean files without a literal Zod import.
  The guard detects literal module targets;
  it does not perform general semantic analysis of computed runtime module
  targets. Parse or Git comparison errors also fail closed. No supplied
  base still means no comparison, as before.

This mechanical proof covers import-only and move-only source edits, not arbitrary
behavior-preserving refactors. Constant extraction, importing a new helper,
changing a helper call, and other root/helper logic edits outside the declared
restructure policy below still require
migration or reversion of the Zod-file touch. This check does not prove general
runtime equivalence of a module move. Normal tests and review still cover
path-sensitive runtime behavior and changes inside imported modules.

### Declared scoped restructure changes

The owner permits small scoped restructure edits in existing Zod files.
Each PR can declare `path`, a `NET-` issue identifier and a one-line `reason`
in `scripts/hooks/touched-zod-changes.json`. The guard reads the committed PR
head, requires that list as a regular file, validates it and rejects duplicate
or invalid entries. Only an entry new or changed from the merge base applies;
an unchanged entry grants nothing to a later PR. An absent base list means an
empty list; malformed base data fails closed. The mechanism ships an empty
list. Each restructure PR must add or update its own entry. JSON formatting
changes alone do not renew an entry. Declared files must exist as regular files at base and head, without
copy or rename substitution. Their Zod declarations must be byte-identical.
No file may gain a Zod import. A declared edit has a fixed budget of 20 added
plus removed lines, so a ten-line replacement uses the full budget. This
covers the small root/syntax edits without granting a large rewrite. Unknown
loaders and failed Git, parse or declaration checks fail closed. Undeclared
files retain ordinary and mechanical policy. For the NET1769 root extraction
and NET1771 syntax import retarget, the respective PRs can add these entries:

```json
[
  {
    "path": "src/nightly/ready.ts",
    "issue": "NET-1769",
    "reason": "Centralize the installation root."
  },
  {
    "path": "src/update-notice.ts",
    "issue": "NET-1771",
    "reason": "Retarget the extracted syntax leaf."
  }
]
```

This is a quality check, not proof of behavior or verification of live issue
approval. Review and focused tests must establish scope and preserved behavior.

## PR budget and batch boundaries

The revised target is **18 migration PRs in total**. Twelve migration PRs are
merged. That leaves six component batches. One contingency split can bring the
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
- [Chat routing and interaction envelopes](https://github.com/aiconsultancy/stargate/pull/77).

The first batch-6 timing pair failed at +18.27%. Its diagnostic pair measured
+2.63% with retained coverage; this is not a performance repair. The earlier
batch-4 first-pair +10.9% failure also remains recorded.

## Remaining component batches

The numbers include the twelve completed PRs. Batch 13 is next, not merged.
File names identify primary scope, not a restriction against updating a coupled
consumer. Tests belong to the batch
that owns their production boundary, rather than a separate test-only PR.

13. Files and delivery. Migrate `attachments.ts`, `slack-files.ts`,
    `captain-post.ts`, the remaining plan schema in `irc/delivery.ts`,
    `crew/post.ts` and the coupled post registration in `crew/plugin.ts`.
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
