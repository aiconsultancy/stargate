# Development

From a source checkout, install the pinned tools and dependencies and run the
same checks used on GitHub:

```sh
mise install
mise run deps
mise run hooks-install
mise run check
mise run hooks
```

`check` runs strict TypeScript, Biome lint/format checks, and Bun tests. TypeScript
also rejects unchecked index access, implicit returns/overrides, unused code,
fallthrough, unreachable code, unused labels, and unchecked side-effect imports.
Biome treats warnings as failures and checks promise handling, unsafe returns,
exhaustive switches, explicit `any`, non-null assertions, and `@ts-ignore`.

`format` applies Biome's safe fixes. `hooks-install` installs prek's pre-commit
hook for this clone. `hooks` runs the same repository-wide gate as CI, plus
workflow validation, merge/case conflicts, broken symlinks, large files, private
keys, trailing whitespace, final newlines, and TOML/YAML syntax. File hygiene
hooks can edit files; review and stage their changes before retrying a commit.
GitHub Actions runs this gate for pull requests and pushes to `main`, using
pinned tools and frozen dependency installation. No Slack or provider credentials
are required.

TypeScript checks first-party source and tests. `skipLibCheck` remains enabled
because the installed SDK declarations have upstream type errors. It does not
skip checks of SDK use in this code. Biome's `useLiteralKeys` style rule is off
because it conflicts with `noPropertyAccessFromIndexSignature`; record keys use
bracket access. Do not replace it with casts, suppression comments, or weaker
type-safety rules.

Effect **4.1.0** stays pinned to the OpenCode SDK's version. The official
`effect-ts` and `effect-v3-to-v4` skills are installed in `.agents/skills`;
[provenance and file hashes](../.agents/effect-skills.json) record their upstream
revision. Read `node_modules/effect/AGENTS.md` before changing Effect code.
The migration skill is available for future upgrades; this project already uses
Effect 4. Skill examples that install `latest` do not override the SDK pin.
Biome leaves these two upstream skill files unformatted to preserve their hashes.

### Dependency updates

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
edits in a human-authored PR instead. Development requires Git and jq on `PATH`.
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

### Test coverage

Tests cover routing, multi-bot isolation,
access denial, SQLite persistence/locking, queue ordering, retries, interrupted
turns, setup safety, systemd escaping, the OpenCode HTTP contract, a real
Pi Durable session/store reopen, and the Claude Agent SDK with a fake CLI and
the pinned real CLI against a loopback fixture. No Slack or paid provider
calls run in tests.
Live Slack and model verification still requires your credentials.
