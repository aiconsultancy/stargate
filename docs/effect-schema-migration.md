# Effect Schema migration

Use the installed Effect 4 Schema instead of Zod for first-party validation.
Keep accepted inputs, decoded values, public configuration, stored records and
tool wire formats unchanged. Keep Bun SQLite and the Promise adapter contract.
This migration does not upgrade Effect or the SDKs.

## Size and unit of delivery

The initial estimate is approximately 410 PRs at one schema/type per PR.
The inventory at `2ef51cf` found 348 named schema bindings and 52 inline parse
boundaries, plus schema factories, shared shapes and final cleanup. This is a
planning estimate, not an exact count of every nested Zod expression. Schemas
added by concurrent changes must be included before their phase starts.

Each PR replaces one named schema/type or one inline validation boundary.
Its nested fields, inferred TypeScript aliases, consumers and tests travel
together. Do not group unrelated schemas, stack migration PRs or add speculative
compatibility layers to meet the estimate.

## Order

1. Establish the policy and migrate an independent leaf. The first unit is
   Claude's private session UUID schema and its prompt/interrupt consumers.
2. Migrate other independent leaves, then shared leaves in dependency order.
3. Migrate composed configuration, durable records and RPC schemas.
4. Migrate tool input schemas and their advertised JSON Schema. Preserve strict
   operation validation behind object-root advertisements.
5. Remove remaining first-party Zod use, obsolete adapters and the direct Zod
   dependency. SDK-owned transitive Zod can remain.

Completed:

- [Claude session UUID schema](https://github.com/aiconsultancy/stargate/pull/43).
- [OpenCode pairing-response schema](https://github.com/aiconsultancy/stargate/pull/44).

For mixed composition, add an adapter only when the selected schema requires
one. It must delegate to the authoritative Effect decoder, not copy its rules.
Remove the adapter when its remaining consumer migrates.

## Verification and merge

Before replacement, characterize the existing boundary with valid, invalid and
edge inputs. Compare acceptance, decoded output, defaults, transforms, missing
versus null values, strict or stripped object keys, issue paths and safe errors.
Preserve synchronous behavior and cancellation where applicable.

The first UUID migration preserves the existing case-sensitive max-UUID rule.
Effect's general UUID check also accepts uppercase or mixed-case max UUIDs;
the old Zod boundary accepted that sentinel only in lowercase. Ordinary UUIDs
remain case-insensitive and are forwarded without changing their spelling.

Each PR needs focused parity tests, strict TypeScript, Biome, full required
quality gates and clean independent review. Preserve the coverage and runtime
requirements. A measured full-suite duration increase above 10% fails the
runtime condition; do not reduce test selection or raise deadlines to hide it.

Commit through ordinary hooks. Require Quality checks on the exact head before
squash auto-merge. Verify the merged SHA, then start the next unit from current
main. Failed checks or unresolved review threads stop advancement.

## SDK boundaries and dependency removal

OpenCode's installed tool interface accepts Effect codecs directly. Pi Durable
accepts JSON Schema and validates it before execution. Verify the generated
input schema's dialect and definitions, and ensure it does not reject values
that the authoritative Effect decoder accepts.

The Claude SDK's `tool()` helper requires a Zod raw shape, but Stargate's current
Claude backend does not call it. Its transitive Zod dependency remains SDK-owned.
Check the installed interface before migrating another SDK or RPC boundary.

Prefer Effect capabilities over other direct dependencies only after verifying
equivalent behavior and security properties. This plan does not establish that
`jose`, `croner` or `pino` can be removed without losing required behavior.
