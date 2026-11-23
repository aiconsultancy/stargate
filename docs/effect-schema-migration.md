# Effect Schema migration

Use the installed Effect 4 Schema instead of Zod for first-party validation.
Keep accepted inputs, decoded values, public configuration, stored records and
tool wire formats unchanged. Keep Bun SQLite and the Promise adapter contract.
This migration does not upgrade Effect or the SDKs.

## Import rule

First-party TypeScript, including tests and repo-owned lint tooling, must not
import `zod` or its subpaths. `bun run lint` enforces this through
`eslint/no-restricted-imports`. The rule checks static imports, exports with a
module source, and literal dynamic imports. Do not load Zod through CommonJS
or a computed specifier. The old touched-file and exclusion-list guards were
removed with the direct dependency. Tests keep legacy expected values and
advertisements as data.

## PR budget and batch boundaries

The migration uses 18 component batches. Batch 18 closes the migration by
removing the last first-party imports, bridges, and direct dependency.

This replaces the original estimate of approximately 410 one-schema PRs. The
inventory at `2ef51cf` found 348 named schema bindings and 52 inline parse
boundaries, plus schema factories and shared shapes. These are migration work
units, not separate PRs. Nested fields and inferred aliases are not extra PRs.

Each batch replaces a connected set of validators at one component boundary.
Its inferred types, direct consumers and parity tests travel together. Reconcile
new schemas from current main before starting a batch. Move coupled definitions
between the planned batches when composition requires it. Do not introduce an
adapter merely to retain an artificial file split. Do not stack migration PRs.

Migration batches:

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
- [Files and delivery](https://github.com/aiconsultancy/stargate/pull/84).
- [Cron operations and records](https://github.com/aiconsultancy/stargate/pull/211).
- [Maintenance execution and offline scripts](https://github.com/aiconsultancy/stargate/pull/212).
- [Maintenance records and readiness](https://github.com/aiconsultancy/stargate/pull/213).
- [Status, quota, notifications and health](https://github.com/aiconsultancy/stargate/pull/215).
- Dependency removal, test validators and retired bridges (batch 18, NET-1806).

The first batch-6 timing pair failed at +18.27%. Its diagnostic pair measured
+2.63% with retained coverage; this is not a performance repair. The earlier
batch-4 first-pair +10.9% failure also remains recorded.

### Configuration settings composed into later batches

Batch 18 removes `legacySetting`, `objectToolInput`, `projectToolInput` and
`projectKeySchema`. `settings-legacy.ts` keeps its native projectors,
`settingsAdvertisement` and `settingsInputAdvertisement`. Earlier batches
removed adapters at their owning boundaries:

- Engine inbox/mail now compose native task-ID/text primitives directly;
  batch 10 removes their two bridges. Batch 9 removed the team/agent-ID and
  quota-configuration bridges with their native parents.
- Fleet identifiers, repositories and review-worker settings now compose
  directly into native runtime protocol/control records. Batch 11 removes
  their four bridges with the actual parents.
- Batch 14 composes the cron destination, advanced options, evaluation and
  quota-event settings natively and removes their bridges.
- Batch 15 removes the Fleet status metadata and pull-request repository bridges.
- Batch 16 removes the cleanup-path bridge. The maintenance result record
  composes the native path setting directly.

The `stargate_cron` tool input (`crew/cron/cron.ts`) derives its JSON
advertisement from the native operation fields; the bytes equal the earlier Zod
advertisement. A present field must match that field of one operation and an
unknown field fails; only then the operation decoder reports its issues. The
handler applies the branch defaults.
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
projector is shared by the native adapters. Recovery RPC
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
and native nested-strict decoding/encoding. Batch 15 moves the quota tool to
the native project envelope; the unused project-selection alias is removed
with IRC's native consumer. The pure projectors these adapters use remain.

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

Each batch needs focused parity tests, strict TypeScript, Oxlint, Oxfmt, full required
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
Claude backend does not call it. `package.json` has no direct Zod dependency;
SDK-required transitive Zod stays in `bun.lock`. Dependency and provenance
checks are unchanged. Check the installed interface before migrating another SDK or RPC boundary.

Prefer Effect capabilities over other direct dependencies only after verifying
equivalent behavior and security properties. This plan does not establish that
`jose`, `croner` or `pino` can be removed without losing required behavior.
