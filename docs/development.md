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
The new lint rules and the formatter skip the explicit Zod paths in
`.oxlintrc.json`. The previous lint and formatting checks still run on those
paths. The approved bundle may apply tool-only form changes to the four fixed
entry files if compiler-emitted JavaScript stays equal. This does not permit
hand-written changes to their bodies. For an emit comparison, use
`bun scripts/compare-js-emit.ts --capture OUT_DIR` before and after the sweep,
with the tool files present in both trees. Then run
`bun scripts/compare-js-emit.ts BEFORE_DIR AFTER_DIR`. It parses the pinned
TypeScript compiler’s JavaScript output and reports each file as raw-equal,
syntax-equal or failed. Keep new comments out of the emit; test and check
types separately. Numeric and cooked string spelling can differ. Tagged
template raw text, regex pattern text and directive spelling must match. `bun run lint` checks the Zod list
using the same module syntax
and source scope as the touched-Zod guard. Listed files must exist and import
Zod. All guarded Zod imports must be listed; test imports need not be listed.

When a file no longer imports Zod after migration, remove its path from the
`excludeFiles` list in `.oxlintrc.json` in the same change. Run `make format`,
inspect the diff and run `bun run lint`. If a guarded file moves and retains Zod,
update its path in the same change, subject to the touched-Zod policy.

For a bulk sweep, use `bun scripts/regenerate-hard-mode.ts` from a clean feature
checkout that contains the tooling. For the initial bundle, run the supplied
script with `--tool-patch /absolute/path/to/tool.patch` from a clean feature
branch at freshly fetched `origin/main`. It applies the tool patch to the index,
leaves the generated sweep unstaged, reports changes by top-level folder, and
fails if a second format run changes anything.

Two lint rules have options with a reason. `eslint/sort-imports` sets
`ignoreDeclarationSort: true`: the order of import declarations is the order
in which modules are evaluated, so the rule checks only the order of names
inside one import. `eslint/new-cap` sets `capIsNewExceptionPattern` to
`^(?:Schema|Data|Context)\.`: Effect constructors such as `Schema.Struct`
are functions with capital names. Other capitalised calls and `new` with a
lower-case name are still reported.

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
The hosted **Quality checks** gate always runs the full suite, plus the existing
touched-Zod policy and self-update environment checks. No Slack or provider
credentials are required.

`check-affected` keeps the strict typecheck and lint. It selects transitive
importers from private HEAD and Git-index snapshots, not unstaged files.
Deletions and renames select old-path importers from HEAD plus new-path
importers from the index. Deleted tests do not run themselves. Imported test
helpers and data files are graph inputs too.
Source edits also select architecture tests, which read the source graph.
A small reader table maps architecture baseline/policy JSON to architecture
tests, hook data to touched-Zod hook tests, and documentation to architecture
tests. `docs/api.md` also selects the API Git-status test that reads it.
The touched-Zod and affected-test hook implementations map to their hook tests,
which invoke them as subprocesses rather than import them.

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

### Strict baseline freshness

The architecture guard rejects stale-high inventories as well as growth.
Keep `largestCycle`, `cycleComponents`, `cyclicEdges`, `crewPlugin.members`
and physical `rootFiles` current in the same PR as the structural change.
Component/member order does not matter; identities do. A dependency replacement
can need a refresh even if its closure count stays the same. Single-file
self-loops count as cyclic components.

`sourceFiles`, `sourceEdges`, `sourceCommit` and `measurementStatus` remain
informational. Their changes do not require a baseline edit. Existing policy,
exception and source-size checks keep their behavior.

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
