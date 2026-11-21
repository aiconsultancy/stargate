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

`check` runs strict TypeScript, Oxlint lint checks, and Bun tests. TypeScript
also rejects unchecked index access, implicit returns/overrides, unused code,
fallthrough, unreachable code, unused labels, and unchecked side-effect imports.
Oxlint treats warnings as failures and runs type-aware (backed by tsrs),
checking promise handling, exhaustive switches, explicit `any`, non-null
assertions, and `@ts-ignore`, across `src`, `tests`, `scripts` and `perf`.
The deeper exceed-parity type-aware rules (unsafe returns, unbound methods,
misused spreads and more) stay in the advisory `mise run oxlint` layer until
triaged.

`format` runs Oxfmt over the repository. `hooks-install` installs prek's
pre-commit and pre-push hooks for this clone. `hooks` runs the same
repository-wide gate as CI, plus
workflow validation, merge/case conflicts, broken symlinks, large files, private
keys, trailing whitespace, final newlines, and TOML/YAML syntax. File hygiene
hooks can edit files; review and stage their changes before retrying a commit.
The pinned Gitleaks scanner also checks a temporary snapshot of every file in
the Git index. Commits scan the staged versions, not unstaged edits. `hooks`
and CI scan the same full index, even when there is no staged diff. Stage new
files and edits before running this secret check manually. The scanner does
not read Git history, untracked files, or ignored local credentials. Scanner
output is redacted; do not add real credentials to test the hook. Keep secrets
outside tracked files and use environment references in configuration.
GitHub Actions runs this gate for pull requests and pushes to `main`, using
pinned tools and frozen dependency installation. No Slack or provider credentials
are required.

The pre-push hook refuses to push a branch that is behind the freshly
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
