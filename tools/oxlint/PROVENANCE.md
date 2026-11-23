# anti-slop provenance

- Upstream: https://github.com/dmmulroy/anti-slop
- Revision: 63dbb09f73438e550a6991dc6d778f979ffbf183
- License: MIT, copied to `anti-slop/LICENSE` (includes the ESLint
  Stylistic vendor notice under `anti-slop/src/vendor/`).
- Vendored by design: upstream ships no npm package and asks consumers to
  copy `src/`, read the rules, and adapt them (see its README).
- Upstream `*.test.ts` files were not vendored: they target Node's
  `RuleTester`, which throws under Bun and breaks `bun test` discovery.
  The rule implementations are byte-identical upstream source.
- Runtime: `oxlint` and `@oxlint/plugins` pinned to 1.93.0 (an exact
  version pair, the same pairing the OpenCode repository uses), bumped from
  anti-slop's own 1.78.0 development pair to enable type-aware parity with
  the removed Biome rules. `oxfmt` 0.79.0 owns formatting via
  `.oxfmtrc.json` (migrated from biome.json with `oxfmt --migrate=biome`).
- Biome was removed in November 2026: the quality gate is the root
  `.oxlintrc.json` (correctness category plus the former Biome rule set),
  and this file is the advisory deep configuration.
- Local policy: the root gate checks `anti-slop/require-readable-spacing`.
  Oxfmt handles the rest of formatting. Run `make format` to apply both.
  The other generic and Effect rules and the lint size ceilings stay advisory.
- Run the advisory configuration with `make oxlint` (mise task `oxlint`).

## Type-checking audit (November 2026)

- Runtime is Bun, which transpiles TypeScript without type-checking it.
  A static checker is still required; the repo has always kept one via
  `typecheck` in the quality gate.
- The pinned `typescript` package is 7.0.2 — the Go-native compiler —
  so `tsc --noEmit` was already the native engine (1.4s / ~1.1GB on this
  repo).
- `tsrs` (oxc-project/tsrs, Apache-2.0, Cloudflare/VoidZero) is a Rust
  port of the TypeScript 7 compiler. Version 7.1.0-beta.tsrs3 verified
  against this repo: identical zero-diagnostic result, a negative test
  correctly rejects bad input, 0.49s / ~390MB default, 0.30s / ~357MB
  with `--fast`.
- Prerelease status and the 7.1-beta target (repo pins TS 7.0.2) are
  the two caveats. Wiring follows the Effect repository's own split:
  `typecheck` runs `tsrs --noEmit` (the fast checker used by `make
  check` and CI via `mise run check`), and `typecheck:tsc` keeps the
  pinned stable Go compiler as fallback. If results ever disagree,
  trust `typecheck:tsc` and file a tsrs issue.
- Bun's `minimumReleaseAge` supply-chain guard (24h) intentionally
  delays fresh tsrs revisions; tsrs4 was blocked on install day.

To update: fetch the new upstream revision, diff against this directory,
and re-run `bun run oxlint`.
