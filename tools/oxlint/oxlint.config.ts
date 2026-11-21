import { defineConfig } from "oxlint";

// Replaces Biome (November 2026): Oxlint owns linting, Oxfmt owns
// formatting (.oxfmtrc.json), and tsrs owns type-checking.
//
// Biome rule parity (biome.json, since removed):
//   style/noNonNullAssignment            -> typescript/no-non-null-assertion
//   suspicious/noExplicitAny            -> typescript/no-explicit-any
//   suspicious/noTsIgnore                -> typescript/ban-ts-comment (superset)
//   nursery/noFloatingPromises          -> typescript/no-floating-promises
//   nursery/noMisusedPromises           -> typescript/no-misused-promises
//   nursery/noUnsafeReturn              -> typescript/no-unsafe-return
//   nursery/useExhaustiveSwitchCases    -> typescript/switch-exhaustiveness-check
//   suspicious/noImplicitAnyLet          -> no Oxlint rule; the strict tsc
//                                          noImplicitAny covers the real cases
//   nursery/useAwaitThenable             -> typescript/await-thenable, run
//                                          type-aware in this advisory layer
//                                          (repo tests await sync fakes by
//                                          design, so it is not gated)
//   style/useLiteralKeys                 -> stays off (conflicts with
//                                          noPropertyAccessFromIndexSignature)
// Rules deliberately off, triaged November 2026:
//   typescript/no-this-alias: Effect idiom `const gateway = this` inside
//     generator functions (they cannot be arrows).
//   unicorn/no-misleading-character-class: false positive on the intended
//     skin-tone range in src/irc/routing.ts.
//   unicorn/no-useless-spread, unicorn/no-useless-fallback-in-spread,
//   unicorn/prefer-string-starts-ends-with: accepted repo style.
export default defineConfig({
  ignorePatterns: [
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".cursor/**",
    ".git/**",
    ".opencode/**",
    "node_modules/**",
    "tools/oxlint/anti-slop/**",
  ],
  categories: {
    // Advisory deep run only; the quality gate uses the leaner root
    // .oxlintrc.json with Biome-parity strictness. This layer is stricter:
    // it also runs the exceed-parity type-aware rules the gate defers
    // (no-unsafe-return, unbound-method, no-misused-spread, no-base-to-string,
    // no-redundant-type-constituents, require-array-sort-compare,
    // await-thenable) plus the suspicious category.
    correctness: "error",
    suspicious: "error",
  },
  jsPlugins: [
    { name: "anti-slop", specifier: "./anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./anti-slop/effect/index.ts",
    },
  ],
  rules: {
    // Biome parity.
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/ban-ts-comment": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/switch-exhaustiveness-check": "error",
    // Deliberate exceptions (see header).
    "typescript/no-this-alias": "off",
    "eslint/no-misleading-character-class": "off",
    "unicorn/no-useless-spread": "off",
    "unicorn/no-useless-fallback-in-spread": "off",
    "unicorn/prefer-string-starts-ends-with": "off",
    // anti-slop, vendored at tools/oxlint/anti-slop (see PROVENANCE.md).
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    // Spacing is owned by Oxfmt in this repository; the anti-slop rule is a
    // whitespace policy (see its README: edit the vendored policy to taste).
    "anti-slop/require-readable-spacing": "off",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    // Effect group: this repository depends on Effect (see AGENTS.md).
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    // Code-quality ceilings: pragmatic thresholds that flag drift without
    // Clean Code dogma. Scoped to src/ via overrides; tests stay exempt.
    "eslint/complexity": ["error", { "max": 40 }],
    "eslint/max-lines": ["error", { "max": 1000 }],
    "eslint/max-lines-per-function": [
      "error",
      { "max": 250, "skipBlankLines": true, "skipComments": true },
    ],
    "eslint/max-params": ["error", { "max": 6 }],
    "eslint/max-depth": ["error", { "max": 6 }],
  },
  overrides: [
    {
      // Fixtures and smoke scripts are exempt from size ceilings; the
      // gate lint still checks their correctness. Globs are
      // config-relative and path-independent because this file lives
      // under tools/oxlint/.
      files: ["**/tests/**", "**/scripts/**"],
      rules: {
        "eslint/complexity": "off",
        "eslint/max-lines": "off",
        "eslint/max-lines-per-function": "off",
        "eslint/max-params": "off",
        "eslint/max-depth": "off",
      },
    },
  ],
});
