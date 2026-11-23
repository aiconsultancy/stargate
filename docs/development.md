# Development

Development requires Git, jq, and mise on `PATH`. From a source checkout,
install the pinned tools and dependencies, then run the same checks used on
GitHub.

```sh
mise install
mise run deps
mise run hooks-install
mise run check
mise run hooks
```

`check` runs strict TypeScript, Oxlint lint checks, and all Bun tests on demand.
Commits run the same typecheck and lint, followed by affected tests. TypeScript
also rejects unchecked index access, implicit returns/overrides, unused code,
fallthrough, unreachable code, unused labels, and unchecked side-effect imports.
Oxlint treats warnings as failures and runs type-aware (backed by tsrs),
checking promise handling, exhaustive switches, explicit `any`, non-null
assertions, and `@ts-ignore`, across `src`, `tests`, `scripts` and `perf`.
The fault-check rules (unsafe returns, unbound methods, misused spreads and
more) run in `src`, `scripts` and `perf`. These stay off, each for a reason:

- `eslint/preserve-caught-error`: a `cause` would put raw file-system and
  Slack SDK errors in logs.
- `unicorn/prefer-type-error`: the repair changes the class of a thrown error.
- `unicorn/custom-error-definition`: the repair changes error names and
  renames exported classes.
- `eslint/require-unicode-regexp`: with `u`, Effect exports schema patterns as
  JSON Schema `pattern`, which changes the tool schemas sent.
- `unicorn/throw-new-error`: it reports the `Schema.TaggedError` factory.
- `eslint/no-redeclare`: it reports a value and a type with one name; the
  compiler reports real redeclarations.
- `eslint/no-useless-assignment`: it reports variables that the next loop
  pass reads.
- `unicorn/require-post-message-target-origin`: it reports Slack's
  `chat.postMessage`, not `window.postMessage`.
- `eslint/default-case`: a `default` branch hides the
  `switch-exhaustiveness-check` result for unions, or does not compile.
- `eslint/no-loop-func`: closures read live state on purpose.

`eslint/no-unmodified-loop-condition` is off for
`src/notifications/ingest/notifications.ts` only: its loops test `closing`,
which the scope finalizer sets from another fiber.

`make format` applies six supported Oxlint fixes, then the statement-spacing
rule, then Oxfmt. It repeats until a round makes no changes. It does not apply
suggestions, dangerous fixes, or fixes from the advisory configuration.
The hand-work lint rules are off for `tests/**`; tests keep the bundle gate.
The approved bundle may apply tool-only form changes to the four fixed
entry files if compiler-emitted JavaScript stays equal. This does not permit
hand-written changes to their bodies. For an emit comparison, use
`bun scripts/compare-js-emit.ts --capture OUT_DIR` before and after the sweep,
with the tool files present in both trees. Then run
`bun scripts/compare-js-emit.ts BEFORE_DIR AFTER_DIR`. It parses the pinned
TypeScript compiler’s JavaScript output and reports each file as raw-equal,
syntax-equal or failed. Keep new comments out of the emit; test and check
types separately. Numeric and cooked string spelling can differ. Tagged
template raw text, regex pattern text and directive spelling must match.

`eslint/no-restricted-imports` rejects `zod` and its subpaths in `src`,
`tests`, `scripts` and `perf`. The same rule runs separately on repo-owned
`tools/oxlint` files without linting its vendored copies. SDK-owned transitive
Zod is not a first-party dependency. The empty `excludeFiles` array marks
the general set for the lint-list checker and formatter; it exempts no file.

Seven ceiling rules apply outside `tests/**` and the four fixed
entry files: at most 250 lines in a function (blank lines and comments not
counted), 60 statements, 6 parameters, block depth 6, complexity 40, nested
calls 6 and 3 classes in a file. For each rule, one override in
`.oxlintrc.json` lists the files that already exceed the limit, with literal
sorted paths, and sets that rule to the largest value in its files. These
ceiling lists may only shrink. One raise is recorded: with the async rules
(NET-1822, comment `d65f8ac4`), the `eslint/max-lines-per-function` maximum
for `serve` in `src/app/runtime.ts` went from 1,334 to 1,350. The approved
repairs put braces around callbacks and add no statement to `serve`. It is
the only raise. `eslint/max-lines` stays off: the architecture size guard
owns file length (non-blank lines, limit 1,000, with its own list).
An exception list is an override that turns one or more rules off for literal,
sorted file paths, because those files hold places that must stay as they are.
Exception lists may also only shrink.

`bun run lint` runs `scripts/check-lint-lists.ts`. It puts every override in
`.oxlintrc.json` into exactly one kind and fails on an override of no kind:

- the general set: the one override with empty `excludeFiles`;
- the `tests/**` and fixed-entry overrides, matched by their exact `files` in
  `structuralOverrides` in the script; they may only turn rules off, and they
  must turn all seven ceiling rules off;
- a ceiling list: exactly one ceiling rule, not off;
- an exception list: every rule off, no ceiling rule, each rule on in the
  general set.

The check fails when a ceiling list file no longer exceeds the general limit,
when a list maximum is above the largest value of its files (the message gives
the value), when an exception list file has no finding of its rule with the
rule on, and when a listed path does not exist, is a pattern, or is a test, a
fixed entry. When a change brings a file under a limit or removes
its last finding of a listed rule, remove the file from that list in the same
change. A new file or a file that is not listed must meet the general rules.
The check also fails when Oxlint fails, gives no output, or reports fewer files
or rules than it was given; it never reads a missing result as "no finding".

For a bulk sweep, use `bun scripts/regenerate-hard-mode.ts` from a clean feature
checkout that contains the tooling. For the initial bundle, run the supplied
script with `--tool-patch /absolute/path/to/tool.patch` from a clean feature
branch at freshly fetched `origin/main`. It applies the tool patch to the index,
leaves the generated sweep unstaged, reports changes by top-level folder, and
fails if a second format run changes anything.

`eslint/sort-imports` sets
`ignoreDeclarationSort: true`: the order of import declarations is the order
in which modules are evaluated, so the rule checks only the order of names
inside one import. `eslint/new-cap` sets `capIsNewExceptionPattern` to
`^(?:Schema|Data|Context)\.`: Effect constructors such as `Schema.Struct`
are functions with capital names. Other capitalised calls and `new` with a
lower-case name are still reported.

The gate applies these type-contract rules in `src`, `scripts` and
`perf`, with these exceptions:

- `typescript/no-unnecessary-boolean-literal-compare` is off for
  `src/transports/slack/slack.ts` only: `result.ok === true` checks an untrusted Slack
  Web API response, whose declared `boolean` type is not proved at run time.
- `anti-slop/no-chained-type-assertions` is off for
  `src/automation/maintenance/maintenance-drain.ts` only: one cast covers the gap between
  `Schema.optional` fields of the participant schema and the exported
  `DrainParticipant` type under `exactOptionalPropertyTypes`.
- `anti-slop-effect/no-service-constructor-imports` is off for
  `src/app/runtime.ts` only: it is the composition root that builds the
  notification service.
- `unicorn/no-useless-undefined` runs with `checkArguments: false`: an
  explicit `undefined` argument stays, because removing it changes
  `arguments.length` for dual APIs such as `Deferred.succeed`.
- `typescript/strict-boolean-expressions` runs with `allowNullableBoolean`,
  `allowNullableString` and `allowNullableNumber` beside the defaults. The
  stricter form for nullable strings and numbers (867 places on 23 November 2026) is not done: a 100-place trial kept today's result by construction,
  found no fault and was undecidable at one place in four. The rule is off for
  six files where a condition tests SDK data or an `unknown` or generic value
  whose run-time kind the type does not prove: `scripts/crew-question-smoke.ts`,
  `scripts/irc-question-smoke.ts`, `src/backends/opencode/opencode-history.ts`,
  `src/backends/opencode/opencode.ts`, `src/automation/cron/index.ts` and
  `src/gateway/gateway.ts`.

These type-contract rules stay off, each for a reason:

- `eslint/no-undefined`: the only repair writes `void 0` in place of
  `undefined`.
- `unicorn/no-null`: most `null` values go into JSON, SQLite or wire formats;
  replacing them changes stored or sent data.
- `typescript/consistent-return`: the compiler option `noImplicitReturns`
  does this check; the rule also conflicts with `no-useless-undefined`.
- `typescript/parameter-properties`: the repair changes the order in which
  class fields are initialised.
- `anti-slop/no-unknown-parameters`, `anti-slop/no-unknown-returns`,
  `anti-slop/no-unsafe-dictionary-type`, `typescript/no-unsafe-type-assertion`
  and `anti-slop/no-runtime-typeof`: the repair decodes values where they
  enter the program, which adds validation errors that do not exist today.
- `anti-slop/no-known-value-widening`: some bindings hold `unknown` on
  purpose because they feed a decoder.
- `typescript/no-unnecessary-condition`: most findings guard state that
  changes across an `await`, SDK, HTTP, JSON or persisted data, or the
  runtime, which the declared type does not prove.
- `typescript/no-invalid-void-type`: Oxlint reports `void` as a type argument
  of a call, such as `Promise.withResolvers<void>()`, under every option.
- `eslint/class-methods-use-this`: Oxlint ignores the option for methods that
  implement an interface; public contract methods and per-instance hooks
  cannot change.

The async and performance rules (NET-1822) run in `src`, `scripts` and
`perf`. These stay off, each for a reason:

- `oxc/no-optional-chaining`: the code uses optional chaining on purpose; the
  rule is for runtimes without it and contradicts `prefer-optional-chain`.
- `oxc/no-rest-spread-properties`: `Object.assign` is not equal to object
  spread or rest, and the rule opposes `no-conditional-empty-object-spread`.
- `eslint/no-await-in-loop`: the loops are sequential by design; awaiting
  together would change order, concurrency and failure behaviour.
- `eslint/require-await`: `typescript/require-await` is the type-aware form
  and does not contradict `promise-function-async`.
- `oxc/no-map-spread`: the repair mutates the mapped objects and changes
  identity and aliasing.
- `unicorn/prefer-spread`: it turns `Array.from(text)` into `[...text]`, and
  `typescript/no-misused-spread` requires the reverse for strings.
- `typescript/promise-function-async`: adding `async` returns a new promise
  on each call and adds microtask turns. Code and tests depend on both: for
  example, `startHostMetrics().read()` must return the same pending promise.
  15 places in 12 files cannot take `async` without a change of behaviour.
- `unicorn/no-await-expression-member`: moving the `await` into a `const`
  before the statement runs it earlier or unconditionally where the old
  expression evaluated another operand first, for example the right side of
  `||` or `&&`. 20 places in 16 files are like this.

These rules are off only for the files listed in `.oxlintrc.json`, because
the repair would change behaviour there. Keep each list as short as it is;
remove a file when its places are repaired.

- `typescript/await-thenable` in `src/transports/teams/registration.ts`: removing the
  `await` of `allowed()` removes a microtask turn before a Teams post.
- `unicorn/prefer-top-level-await` in `scripts/irc-question-smoke.ts`:
  top-level await changes when the smoke module finishes evaluating.
- `typescript/return-await` in `src/backends/opencode/opencode.ts`: the file
  is on this list for the steer `try` (line 1567). A second read with tests
  (NET-1822) found that this place is not a fault: `reconcileSteer` always
  resolves, so no rejection can skip the `catch`. `return await` there has the
  same behaviour, so the file can leave this list in a follow-up.
- `oxc/no-accumulating-spread` in `src/dispatch/dispatcher.ts`: mutating the
  tracked issue would alias the record that the caller holds.
- `typescript/no-confusing-void-expression` in
  `scripts/hooks/affected-tests.ts`: its test rewrites the signal handler
  lines by their exact text.
- `unicorn/no-useless-spread` in three files: the loops copy a list or the
  header keys because they change it while they iterate.
- `typescript/require-await` in eleven files: each reported function returns a
  promise that its callers use; removing `async` changes the return type and
  turns a rejection into a throw.
  `src/automation/maintenance/nightly/droid/droid.ts` joined when it left the Zod list (batch 17): its `status` and `reports` droid tools are this case.
- `typescript/strict-void-return` in `src/app/service.ts` and
  `src/backends/claude.ts`: `promisify(execFile)` relies on the custom
  promisified `execFile`; a wrapper callback would lose it. The abort
  listener at `src/backends/claude.ts:999` could take braces, but the file
  stays listed for its `promisify` place, so that repair would shrink
  nothing; it is left as it is.

`hooks-install` installs prek's
pre-commit and pre-push hooks for this clone. `hooks` runs the pre-commit gate,
including workflow validation, merge/case conflicts, broken symlinks, large
files, private keys, trailing whitespace, final newlines, and TOML/YAML syntax.
File hygiene hooks can edit files; review and stage their changes before retrying
a commit.
The pinned Gitleaks scanner also checks a temporary snapshot of every file in
the Git index. Commits scan the staged versions, not unstaged edits. `hooks`
and CI scan the same full index, even when there is no staged diff. Stage new
files and edits before running this secret check manually. The scanner does
not read Git history, untracked files, or ignored local credentials. Scanner
output is redacted; do not add real credentials to test the hook. Keep secrets
outside tracked files and use environment references in configuration.
GitHub Actions runs this gate and an explicit `mise run check` for pull requests
and pushes to `main`, using pinned tools and frozen dependency installation.
The hosted **Quality checks** gate always runs the full suite, plus self-update environment checks. No Slack or provider
credentials are required.

`check-affected` keeps the strict typecheck and lint. It selects transitive
importers from private HEAD and Git-index snapshots, not unstaged files.
Deletions and renames select old-path importers from HEAD plus new-path
importers from the index. Deleted tests do not run themselves. Imported test
helpers and data files are graph inputs too.
Source edits also select architecture tests, which read the source graph.
A small reader table maps architecture baseline/policy JSON to architecture
tests, and documentation to architecture tests. `docs/api.md` also selects the API Git-status test that reads it.
The affected-test hook maps to its subprocess tests.

Untrusted paths have no graph edge or reader mapping. The default mode is
`defer`: run selected tests, name the untrusted paths in a notice, and rely on
hosted **Quality checks** for the full suite. A commit changing only
`package.json`, the lockfile, tool config or workflows runs typecheck and lint
locally and no tests. Hosted **Quality checks** covers those changes.
Set `STARGATE_UNTRUSTED_TESTS=full` for a local full-suite run when untrusted
paths change; `STARGATE_UNTRUSTED_TESTS=defer` explicitly selects the default.
Graph, parse and Git errors always run the full suite, in either mode.
The selector prints selected/total test-file counts and graph, reader-mapping
and untrusted-mode reasons before running tests. Selected-test failures fail
the commit even in `defer` mode.
The runner clears Git's local environment after selection so test fixtures can
create independent repositories. An empty staged diff, as in CI's
`prek run --all-files`, reports no affected tests and starts no test runner.
This is not full-suite evidence. CI's separate `check` step supplies that evidence.
Use `mise run check` or `make check` to run the full suite locally when needed.

### Repeated test comparisons

Use `test-compare` when a timeout occurs once, or when a change might slow a
test path. It measures observed failures and durations. It is not a commit
gate or a way to identify the cause of a failure. A failure report must state
the load average at the start of the test invocation, or say `unavailable`.

Compare two refs with one test-file invocation per tree per pair:

```sh
mise run test-compare -- --base origin/main --candidate HEAD \
  --file tests/irc-audit.test.ts --runs 40 --load ambient
```

Measure one working tree without a base:

```sh
mise run test-compare -- --file tests/irc-audit.test.ts --runs 20
```

`--candidate` accepts a commit ref or an existing Git tree directory. A path
captures its tracked working files, including uncommitted edits. Stage new
files before capture; ignored and untracked files are not copied. The default
single tree is the caller's current working tree. Stop editing while it is
captured. Results record the requested ref or path, its commit SHA and the
exact snapshot tree ID. The command creates no commits and does not check out,
reset, install into or clean the caller's tree.

The command creates private clones under `$TMPDIR` (the platform temporary
directory if unset). Each run restores its private source snapshot. It copies
installed dependencies into the temporary workspace, with safe internal
symlinks, and shares that private copy between compatible trees. The command
does not fetch or install packages during preparation. Allow enough temporary
disk space for the installed dependencies. The snapshot's `bun.lock` must match
the installed source tree. Use `--dependencies /path/to/matching/tree` if it
needs another existing install. External dependency symlinks are refused.
Tests still execute trusted code; this is not an operating-system sandbox.

Runs are ordered base, candidate, base, candidate. No runs execute in parallel.
An optional `--lock /path/to/lock` holds a `flock` lock for each invocation;
`STARGATE_TEST_COMPARE_LOCK` supplies the same default. The path must be outside
source trees. No lock is configured
by the repository. `flock` must be installed to use that option. Do not take
the same lock outside the command and pass it again with `--lock`.

Load modes:

- `none` (default): add no load. This does not claim the host was quiet.
- `ambient`: add no load and label the run as an ambient-host measurement.
- `synthetic`: after lock admission, start one CPU worker and one I/O worker
  that rewrites and syncs a private 1 MiB file at 20 ms intervals. Workers
  stop before the run's lock is released. The command refuses this mode when
  the starting 1-minute load exceeds 1.5 times the available core count, or
  when load is unavailable. Use ambient instead, or set an explicit ceiling
  with `--max-load NUMBER`. Do not add synthetic load to an already busy host.

The command needs Linux `/proc` process identities and POSIX process groups.
Unavailable identity facts fail closed before work starts. On normal exit,
errors, SIGINT and
SIGTERM, it kills and reaps its worker/test groups, checks that no group
survives, then releases the lock and removes its temporary clones and load
files. Each cleanup attempt bounds direct-child closure and group-disappearance
waiting to one second, then repeats SIGKILL and reports an infrastructure
failure if the group remains. Forced SIGKILL or machine failure cannot run
cleanup handlers;
synthetic workers also have an independent bounded lifetime. Tests remain
responsible for subprocesses that deliberately leave their process group.

Before any group signal, the command checks its recorded spawn leader and
session. The first signal captures group-member PID/start-time identities;
repeated signals require every current member to match that set and session.
Unknown members, changed identities, or unreadable facts withhold the signal
and return infrastructure exit 2. A child born after the first snapshot can
be conservatively refused. Inspection and signalling are not atomic; the
identity checks cannot exclude same-clock-tick reuse or privileged external
changes between them. The command is not a process-isolation sandbox.
Cleanup failures name group/member IDs, start times and unreadable facts,
the workspace retained/removed state, and the lock release state in the
error, JSON result, and Markdown summary. Confirm identities again before
manual intervention; a reported foreign replacement is not an owned worker.

Output is a retained directory outside source trees. Its default is a separate
`test-compare-results-*` directory under `$TMPDIR`; use `--output DIR` for a
new or empty directory elsewhere. It contains `results.json`, raw logs and
JUnit reports for each run, and `summary.md`. Reports can contain complete test
messages; do not use live credentials in tests or publish logs without review.
Partial results are retained when measurement is interrupted.

The command prints its rule before the first run: compare failed file-run
counts. The verdict is candidate more, the same, fewer, or neither tree failed.
Single-tree mode reports only its observed count. The summary includes failures
out of completed runs, start-load ranges and each test's median, nearest-rank
p95 and maximum duration. File and test durations come from Bun's JUnit
reporter, not log scraping. Missing or invalid reports are infrastructure
errors; a crashed runner is not counted as an ordinary failed test.

The verdict makes no claim of statistical significance. Shared host load,
run order and small samples can change the result. The command omits a rough
sample-size estimate: that would require assumptions about independent trials
and an effect size that these runs do not establish. Passing repetitions do
not erase a previous failure or prove a cause.

Exit 0 means measurement completed, even when tests failed. Infrastructure or
usage errors exit nonzero; SIGINT/SIGTERM return 130/143 after successful group
cleanup. Group cleanup failures return 2 even after a signal. Scripts can add
`--fail-if-candidate-worse` to return 1 when a completed comparison finds more
candidate failures. `--timeout-ms` bounds each test process (default five
minutes, maximum thirty); `--runs` accepts 1 to 10000. Neither changes any
test's own timeout. No commit hook or CI gate runs this command automatically.

### Local selection limit

Pre-commit runs at most 20 selected test files by default. Set
`STARGATE_AFFECTED_TEST_LIMIT` to a nonnegative safe integer to change this
count; zero defers every nonempty selection. A selection at the limit still
runs. A larger set is listed in full, then deferred to hosted **Quality
checks**. Typecheck and lint run first and still must pass. The selector
does not choose an arbitrary subset of a wide selection.

Set `STARGATE_FORCE_AFFECTED_TESTS=1` to run the complete selected set locally
despite the limit; zero is the default. Invalid values fail without starting
tests. The limit applies only to a successful selected set. The existing
`STARGATE_UNTRUSTED_TESTS=full` opt-in and selection-error full-suite fallback
are unchanged and bypass it. The full `check` command and hosted Quality
are also unchanged. A deferred test failure is found in hosted Quality,
not at commit time; auto-merge still waits for that full-suite gate.

The default separates the observed small sets of 2–10 files from sets of
44–224 files seen during wide changes. It is a file-count bound,
not a time budget. A single slow test file can still make a commit slow,
and concurrent small local runs can still contend for host resources.

The pre-push hook runs no tests. It refuses to push a branch behind the freshly
fetched `origin/main`: rebase first (`git fetch origin && git rebase
origin/main`), re-run checks, then push. Pushes to `main` itself, branch
deletions and non-branch refs are not checked. When the fetch itself fails,
the push is refused rather than verified against a stale ref; bypass only
when you are certain `main` is unchanged (`git push --no-verify`). After
pulling this hook in, re-run `mise run hooks-install` once to install the
new hook type in your clone.

TypeScript checks first-party source, tests and performance benchmarks.
`skipLibCheck` remains enabled
because the installed SDK declarations have upstream type errors. It does not
skip checks of SDK use in this code. Oxlint's `useLiteralKeys` style rule is off
because it conflicts with `noPropertyAccessFromIndexSignature`; record keys use
bracket access. Do not replace it with casts, suppression comments, or weaker
type-safety rules.

Effect **4.1.0** stays pinned to the OpenCode SDK's version. The official
`effect-ts` and `effect-v3-to-v4` skills are installed in `.agents/skills`;
[provenance and file hashes](../.agents/effect-skills.json) record their upstream
revision. Read `node_modules/effect/AGENTS.md` before changing Effect code.
The migration skill is available for future upgrades; this project already uses
Effect 4. Skill examples that install `latest` do not override the SDK pin.
Oxfmt leaves these upstream skill files unformatted to preserve their hashes.
The quality gate is the root `.oxlintrc.json`; the vendored anti-slop rules
and code-size thresholds live in the advisory `tools/oxlint/oxlint.config.ts`
run by `mise run oxlint`.

All seven Oxlint category switches are on in `.oxlintrc.json`: `correctness`,
`suspicious`, `pedantic`, `style`, `perf`, `restriction` and `nursery`. Each
rule that is off has the value `"off"` in the config. Its reason is in this
document or on the lint issues (NET-1817 holds the list of off rules with
their reasons). When a later Oxlint version adds a rule to a category, that
rule comes on automatically, and the update PR must decide it. The 408 rules of
the Oxlint plugins that are not enabled (for example `import`, `promise` and
`jest`) are outside these switches.

## Architecture inventory refresh

After source changes reduce the recorded architecture inventory, preview the
current working tree against an ancestor commit:

```sh
mise run architecture-refresh -- --base "$(git merge-base origin/main HEAD)"
```

Preview is the default and does not change the baseline. Add `--write` to the
same command to format and atomically replace `tests/architecture-baseline.json`.
Install locked dependencies first (`mise run deps`); writes use the checkout's
installed Oxfmt. Review and stage the resulting diff. Do not edit guard JSON
concurrently with the refresh.

The tool reuses the architecture test's graph reader. It measures unstaged and
untracked source files too. It compares roots, cyclic edges, largest cycle and
crew-plugin closure size with the baseline at `--base`, a full 40-character
ancestor commit hash. Module and edge totals are informational, not caps.
Provenance and unknown fields remain unchanged. Without pruning, stale
exceptions and stale `largeFiles` entries are errors. New or duplicate
exceptions always fail. Unauthorized size permissions and unlisted oversized
files also fail, with or without pruning.
The tool cannot grant permissions, approve new exceptions or raise base caps.
It does not replace the architecture guards or the separate source-size check.

`--prune-stale` previews removals; exit 0 requires all other guards.
`--write` applies them. `prunedExceptions` and `prunedLargeFiles` name each
removed entry; reruns list none. The tool uses the source-size checker's
existing measurement and alias mapping: a listed file at or below 1,000 non-blank
lines, or an absent file, is stale; a moved file that is still oversized keeps its
logical entry. The tool never adds a size permission or changes the limit.
Normal inventory refresh and all other guards stay intact.

The source-size limit is **1,000 non-blank lines**. Split text at LF and count
each line only when JavaScript `trim()` leaves a character. Empty lines and
whitespace-only lines (including spaces, tabs, form feed and CR) do not count;
comment lines do count. LF and CRLF give the same count, and a final newline
does not add a line. This is a textual, not syntactic, measure: a blank line
inside a template literal also does not count. The rule is simple and
predictable; it does not measure a literal's runtime content or memory use.
Listed identities still have no individual size cap. Prune an entry when it
falls to 1,000 non-blank lines or fewer so that later growth is checked again.

Use optional `--output PATH` for a JSON receipt outside the checkout, including
in preview mode. Unknown options and repeated single-value options are errors.

### Named crew closure additions

A slice extraction can put already-loaded code into another file. Jack's
22 November 2026 decision permits that increase only when the PR names each
new file and proves that its body was already loaded by the crew plugin.
The tool cannot prove that code was moved rather than newly written.

Name each new physical source file with repeatable
`--allow-closure-addition FILE` arguments to `mise run architecture-refresh`.
Preview first; add `--write` only after reviewing it. Names must exactly
match the added member identities after the existing source alias mapping.
Unused, duplicate, unknown and unnamed additions fail. Even an equal-count
swap or an addition below an old count cap needs the explicit name.

For each named file, the parser checks literal imports, re-exports and type
imports, including literal dynamic imports and `require`. They must resolve
to installed packages, built-ins or members of the base closure. A named
addition cannot import another newly added member, even if both are named.
Computed import/require calls and local non-source imports are refused.
The ordinary graph resolver's source-path and symlink checks still apply.
These checks do not prove body identity or account for arbitrary runtime
loaders, filesystem reads, evaluation or package side effects. Those remain
part of the PR's reviewer proof, with code movement and initialization order.

Removals and named additions may combine, including a rename. Preview prints
`closureAdditions` and `closureRemovals` separately, with each named file's
logical identity, local import targets and passed checks. The same exact-set
rule applies whether the total closure count rises, stays equal or falls.
Without a new member identity, the existing no-option output is unchanged.

The option changes no baseline format, exception permission, size permission,
root or cycle allowance. All other checks remain required. A new slice file
still needs normal slice membership and boundary classification in its PR.
The architecture guard remains strict by identity; commit the measured
baseline with the reviewed extraction. `--prune-stale` remains a separate,
explicit operation on resolved exception and stale large-file identities.

### Declared exception rekeys

Jack approved P1 on 22 November 2026: a declared exception may change its
source identity only when kind and target are equal, the old key disappears,
the importing file is new in that PR, and the exception total does not rise.
This does not approve new boundary permissions.

Use repeatable `--rekey-exception OLD_KEY NEW_KEY` arguments. Quote each
complete key, including its spaces and arrow. Preview first, then use `--write`
only after review. The receipt names every `exceptionRekeys` pair.
Without this argument, the existing exception guard is unchanged.

The tool also requires an active base exception and its parsed import edge
in the old source at `--base`. It checks physical file absence using the base
source tree and applies each tree's existing aliases. Duplicate sources or
destinations, changed kind/target, an old edge still present, a pre-existing
new source, missing provenance and a measured exception-count increase fail
with named `rekey:` errors before any baseline write. These additional
provenance checks are narrower than the approved rule, not wider.
Body identity and initialization order remain reviewer evidence. Closure,
root, cycle, size and other exception guards remain required.

### Base-aware hosted baseline comparison

The hosted Quality job checks the tree it checked out against that commit's
first parent. For a PR this is GitHub's merge commit (`refs/pull/N/merge`)
against the current target tip. For a push to main it is the pushed commit
against `github.event.before`. The step fails with a named `event:` error
when the merge commit's second parent is not the PR head, when `before` is
empty or zero, or when `before` is not the first parent (a push of several
commits: each commit must be checked against its own parent). Checkout keeps
full history (`fetch-depth: 0`).

The step runs the refresh tool as a preview against the parent and requires
the complete preview, including informational counters, to equal the
checked-out baseline as JSON data. It does not write the baseline.

`tests/architecture-change.json` declares the refresh arguments for one
change. Example:

```json
{
  "baselineSha256": "<sha256 of the baseline on current main>",
  "closureAdditions": ["FILE"],
  "rekeyExceptions": [{ "oldKey": "OLD_KEY", "newKey": "NEW_KEY" }]
}
```

`pruneStale: true` supplies `--prune-stale`, each `closureAdditions` file
supplies `--allow-closure-addition FILE`, and each `rekeyExceptions` pair
supplies `--rekey-exception OLD_KEY NEW_KEY`. Unknown fields and repeated
keys fail. The file grants no general exception, size entry or closure growth.
The path must be a regular file of at most 64 KiB: a symbolic link
(`declaration:symlink`), a directory or another special file
(`declaration:not-regular-file`) and a larger file (`declaration:too-large`)
fail. The limit allows about 400 rekey pairs.

A declaration applies only to the change that writes it: if its bytes equal
the parent's, it is inherited and inactive. An active declaration with an
allowance must name `baselineSha256`, the SHA-256 of the parent's
`tests/architecture-baseline.json` bytes. Compute it on current main before
regenerating, for example
`git show origin/main:tests/architecture-baseline.json | sha256sum`.
The binding is to the baseline content, not to a commit:

- A PR that is behind main by commits that did not change the baseline stays
  valid, both as merge commit and as squash on main.
- On a PR, a declaration bound to another baseline fails with
  `declaration:stale-baseline`: regenerate the baseline and the declaration on
  current main. A left-over declaration can never make a PR pass.
- `main` does not require branches to be up to date. A PR with an earlier
  passing run can still merge after another change rewrote the baseline, for
  example a prune written with `--write` that does not touch the declaration
  file. On that push, the step validates the declared allowances against the
  actual parent instead of failing on the hash. If every allowance is valid
  there and the preview equals the committed baseline, the step passes with a
  warning annotation: "declaration was bound to an older baseline; allowances
  re-validated against the parent", followed by the allowances in full.
  Otherwise it fails with `declaration:stale-baseline`. The repository
  setting "require branches to be up to date before merging" would remove
  this case. That setting is the owner's choice.
- Two PRs that both edit the declaration file conflict on it, and GitHub
  creates no merge commit until the later one is updated.
- After merge, the file on main names the old baseline hash. It is inactive.
  No clean-up commit is needed. The next change may leave the file, or
  overwrite it with `{}` or with its own declaration.

On success the step prints every active allowance in full as a notice
annotation and in the step summary. The reader verifies each one; the tool
cannot:

- Closure addition: the named file holds only code that the crew plugin
  closure already loaded (moved bodies, no new package).
- Exception rekey: the importing code moved unchanged into the new file; the
  tool already requires equal kind and target.
- Prune stale: entries are only removed. The notice lists the exceptions and
  size entries that the commit removed against the parent.

Reverts:

- A revert of a PR that removed exceptions re-adds them. No declaration can
  allow that, so such a revert fails the step. It needs an owner decision
  (for example an admin merge, with main red until the exceptions go again).
- A revert of an allowance PR restores the previous declaration bytes, which
  name an older baseline. Write `{}` into the declaration in the revert.

The check uses the candidate's tool, graph reader, policy and workflow. A PR
that weakens these can weaken the check; baseline edits alone cannot disable
it. Trusted review remains necessary for changes to the check and its inputs.
In particular, the policy is read from the commit under test, so an edit to
`tests/architecture-policy.json` is itself a permission. A new import plus a
policy line that makes its target a public contract passes with no
allowances. The step then prints the notice "policy changed in this commit:
the reader checks every changed line", with the added and removed line count,
also in the step summary. The second reader is the control for every policy
line.
Running the base tool instead requires an isolated trusted copy, compatible
dependencies and staged rollout of new arguments, and still needs a trusted
workflow to select it. No pre-push hook is included.

### Strict baseline freshness

The architecture guard rejects stale-high inventories as well as growth.
Keep `largestCycle`, `cycleComponents`, `cyclicEdges`, `crewPlugin.members`
and physical `rootFiles` current in the same PR as the structural change.
The architecture test ignores component/member order; the hosted preview also
requires the tool's inventory order. A dependency replacement can need a refresh
even if its closure count stays the same. Single-file self-loops count as cyclic
components.

`sourceFiles` and `sourceEdges` remain informational, not permissions, but the
hosted comparison requires their current measured values. `sourceCommit` and
`measurementStatus` remain preserved provenance. Existing policy, exception and
source-size rules keep their behavior.

For stale inventories, run the exact refresh command printed by the test.
Inspect and commit the lowered JSON with the source change. No environment
or baseline opt-out is provided.

This closes removed allowances immediately but costs parallel delivery speed.
Two PRs that lower the same baseline key can conflict on the baseline file.
After rebasing, refresh against incoming main and retest. Do not restore an
older whole JSON file. Adopt this rule only after open structural PRs finish.
The earlier move wave deliberately deferred baseline edits to one refresh PR
to avoid these conflicts.

## Dependency updates

Dependabot checks Bun dependencies and pinned GitHub Actions daily.
Pi runtime packages have their own group. All `@opencode/*` packages and
`effect` update together; other dependencies are grouped together.
Security updates also use a group. Version updates have a one-day cooldown;
security updates bypass it. CI checks that all three Pi runtime packages stay
pinned to one release and that Effect matches the OpenCode SDK's version.

The repository policy permits auto-merge for all version levels, including
major updates, only after the required `Quality checks` gate passes. `main`
must require pull requests, up-to-date checks, and resolved review conversations.
Do not remove those protections while dependency auto-merge is enabled.

The required quality gate checks every commit and page against signed Dependabot
authorship, the full commit count, and the current PR head. This also blocks
auto-merge after a maintainer adds commits to a previously eligible PR. Put those
edits in a human-authored PR instead.
Like other PR checks, this gate trusts repository writers not to remove or weaken
the workflow and its tests. It is not a boundary against malicious maintainers.

The privileged Dependabot workflow reads metadata and never checks out PR code.
Its required write trigger has one documented, line-scoped workflow
lint exception; other security checks stay enabled. It requests advisory Copilot
reviews for Actions updates when the
existing organization policy permits them. Copilot excludes `package.json` and
lockfiles from review, so Bun updates do not use Copilot as a merge gate. Review
requests do not enable paid usage, count as approvals, or guarantee a review
will finish before merge. Major updates can still break behavior beyond the
test coverage; failed checks and unresolved review threads require a maintainer.

Dependabot does not update the tool pins in `mise.toml`; update them separately.

## Performance measurements

[Strobe](https://github.com/anomalyco/strobe) is pinned as a development
dependency. It does not run in the gateway or require a global installation.
The first benchmark measures `bun run src/main.ts --help`, including CLI
startup. It checks the help output without starting bots, loading a live
configuration or calling a provider. It does not measure gateway throughput.

```sh
mise run deps
mise run perf-check
git fetch origin main:refs/remotes/origin/main
mise run perf-compare
```

`perf-check` runs each case once. A passing check proves the benchmark works;
its timings are not a performance verdict. `perf-compare` measures base and
head in alternating pairs and requires a decided verdict. Run it on a quiet,
dedicated machine. Shared CI runners can refuse timing comparisons. Keep
refusals and inconclusive results; do not repeat until a favourable result.
Each variant installs its frozen lockfile without lifecycle scripts before
measurement. The commands preserve the host power settings and do not reserve
host CPUs. The smoke check has a two-minute setup-and-run cap.

Read the reported verdict and warnings. A timed command can exit zero even
when head is slower or worse. These optional tasks do not replace `check`,
change existing performance limits or add a CI timing gate.

Use `mise run strobe -- --help` for the pinned CLI. For example:

```sh
mise run strobe -- query exp_EXAMPLE insights
mise run strobe -- report experiment exp_EXAMPLE --format pr
```

Replace `exp_EXAMPLE` with a handle returned by Strobe. Review generated reports
before publishing them. Recordings and reports can contain local paths, process
details or command output. Do not publish credentials or private work. Do not
run `strobe up` or `update` as part of project setup: global daemon, MCP,
profiler permissions and live-process profiling need separate operator approval.

## Test coverage

Tests cover routing, multi-bot isolation,
access denial, SQLite persistence/locking, queue ordering, retries, interrupted
turns, setup safety, systemd escaping, the OpenCode HTTP contract, a real
Pi Durable session/store reopen, and the Claude Agent SDK with a fake CLI and
the pinned real CLI against a loopback fixture. No Slack or paid provider
calls run in tests.
Live Slack and model verification still requires your credentials.

Run `mise run eval` for the [conversation reliability evaluations](evaluation.md).
