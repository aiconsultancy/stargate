# Stargate agent instructions

## Project

Stargate is a Bun/TypeScript Slack gateway. One process hosts multiple Slack app
registrations. Built-in backends connect to OpenCode V2, embed Pi Durable,
run Claude Code through the Claude Agent SDK (`docs/claude.md`), or run the
Codex CLI through the Codex SDK (`docs/codex.md`); trusted local modules can
implement the same adapter interface.

Read `README.md` for setup, `docs/operations.md` for limits, and
`docs/design.md` for architecture. Use `docs/cliproxyapi.md` when configuring
the separate local proxy.
For Slack bot provisioning, follow `docs/setup.md`. Create registrations for
this gateway; do not scaffold or run a replacement Bolt application.
For the trusted OpenCode captain/crew profile, use
`docs/agents/default-opencode.md`. Global model-named sub-agents use the
discovery/approval procedure linked from `docs/agents/agent-profiles.md`.

## Commands

`mise.toml` owns task commands. The Makefile is only a forwarding wrapper;
do not duplicate task implementations there. Bun is pinned through mise.

```sh
mise install
make deps
make check
make format
make stargate ARGS='--help'
make config-check ARGS='--config stargate.example.json --schema-only'
```

`make check` runs TypeScript, Oxlint, and the full Bun test suite on demand.
Run the smallest relevant test while changing behavior. Commits run strict
typecheck, lint, and affected tests. Untrusted paths defer to hosted checks by
default; selection errors still run the full suite. Set
`STARGATE_UNTRUSTED_TESTS=full` to opt in to full tests for untrusted paths.
Hosted **Quality checks** explicitly runs the full check before merge.
For repeated failure measurements and load reporting, see [Repeated test comparisons](docs/development.md#repeated-test-comparisons).
The affected-test limit defaults to 20 files. Larger selected sets are named
and deferred to hosted Quality; typecheck and lint still run locally.
Set `STARGATE_AFFECTED_TEST_LIMIT` to a nonnegative integer to change the
limit, or `STARGATE_FORCE_AFFECTED_TESTS=1` to run any selected set locally.
This bound does not change untrusted full opt-in or error full fallbacks.
Run `make hooks-install` once per clone. `make hooks` runs the pre-commit gate,
including workflow and file hygiene checks, but does not replace the full CI
gate. With no staged changes, affected tests report an explicit no-op.
Use `make format` for safe fixes;
do not suppress or weaken type-safety rules to pass the gate. Index-signature
properties require bracket access; Oxlint's conflicting `useLiteralKeys` rule is
intentionally disabled. Dependency declaration checks remain excluded because
installed SDK declarations have upstream type errors; first-party code and tests
must pass every configured check.
`make init` requires a real terminal and collects tokens without echoing them.
Pass non-secret CLI options through `ARGS`, or `mise run TASK -- OPTIONS`.

Use `mise run architecture-refresh -- --base "$(git merge-base origin/main HEAD)"`
to preview the working-tree architecture inventory. Add `--write` to save it.
The tool cannot approve new exceptions or increase base caps. See
[development](docs/development.md#architecture-inventory-refresh).
Guarded inventories must be current. Refresh and commit a lowered baseline
in the same PR as the structural change. Module/edge totals and provenance
are informational. Do not raise limits or add exceptions to pass a regression.

## Code boundaries

Follow the current runtime boundaries and future slice rules in
[the architecture design](docs/design.md#source-layout-and-boundary-rules).
Keep backend adapters independent of Slack and preserve session isolation.

`src/config/composition.ts` owns configuration composition. `src/config.ts`
retains the fixed public exports.

Source modules have a limit of 1,000 non-blank lines, except exact identities in
the architecture baseline's `largeFiles`. The measure is textual: ignore
empty and whitespace-only lines, including inside template literals; count
comments. LF and CRLF count equally, and a final newline adds no line. See
[the size measure](docs/development.md#architecture-inventory-refresh).

## Engineering

- Use strict TypeScript and Effect Schema at new or migrated input boundaries.
  Migrate existing Zod schemas in component batches, preserving validation and
  wire formats. Keep coupled schemas, direct consumers and parity tests together.
  Follow the PR budget and batch order in `docs/effect-schema-migration.md`.
  Keep remaining Zod consumers until their migration phase. Touched-Zod
  ratchet: a substantive change to a file importing `zod` must migrate that
  file's schemas to Effect Schema in the same change, or revert the touch.
  NET1766 permits mechanically verified import/path moves. The guard
  requires an existing base file or Git-detected rename, with byte-identical
  source except relative static import/reexport and literal dynamic import
  paths that resolve to the same base file through the actual rename map.
  Dynamic literal rewrites require the consumer itself to be renamed;
  stationary consumers keep the previous declared-change requirement.
  New files/copies and extra
  Zod imports, sources or bindings are not exempt. Formatting, comments,
  logic edits and constant/helper extraction need a declared NET issue entry
  in `scripts/hooks/touched-zod-changes.json`: an existing file, byte-identical
  Zod declarations, and at most 20 added plus removed lines. No file may gain
  a Zod import. The head list is required; only entries new or changed against
  the merge base apply to this PR. Unchanged entries grant nothing. This scoped
  restructure policy does not prove behavior. See the exact
  supported path-resolution limits in `docs/effect-schema-migration.md`.
- Prefer the installed Effect capability over another dependency when required
  behavior and security properties are equivalent. Do not remove SDK-required
  dependencies or change public behavior merely to reduce dependency count.
- Reuse project helpers, Bun, or the standard library before adding packages.
- Honour `AbortSignal`; cancelling a wait must also stop underlying agent work.
- Keep SDK/runtime API usage consistent with installed dependency versions.
- Use OpenCode V2 documentation; do not substitute V1 APIs or configuration.
- Keep Pi package versions aligned. Pi Durable's API is experimental.
- Add focused tests for non-trivial logic. Existing tests use `bun:test`, real
  SQLite, local HTTP fixtures, and fake Slack delivery; no paid provider calls.
- Do not introduce `any`, type suppression, or disabled lint rules to hide errors.
- Keep documentation and CLI help aligned with supported options and limits.

## Learning more about Effect

This repository uses Effect 4, pinned to the OpenCode SDK's version.
The official `effect-ts` and `effect-v3-to-v4` skills are installed in
`.agents/skills`; provenance and hashes are in `.agents/effect-skills.json`.

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely.
Follow its links when required. For APIs not covered there, search the installed
source in `node_modules/effect/src`. Keep the existing SDK-aligned version;
installing or loading a skill is not permission to upgrade Effect.

Repository choices take precedence over greenfield examples: use Effect Schema,
Bun SQLite, `bun:test`, and the existing Promise adapter contract. Follow
`docs/effect-schema-migration.md` for the incremental Zod migration; do not rewrite
unrelated Promise code or upgrade Effect as part of a schema change.

## Safety and credentials

- Never commit `stargate.json`, its `.env` companion, provider credentials, runtime
  databases, copied API responses, or installed machine-specific service files.
- Never request tokens in chat or accept secret values as CLI arguments.
- For the operator-approved Slack CLI login flow, a single-use challenge may
  be relayed only to complete `login --ticket --challenge`. Never persist that
  exchange, or confuse it with permission to collect persistent credentials.
- Never log raw SDK exceptions, request headers, prompts, or credential files.
- Keep allowlists nonempty and fail closed. Reject messages sent by bots.
  The only exception is a peer captain bot that Slack's directory verifies,
  when the bot sets `access.peerCaptains`. See `docs/peer-captains.md`.
- Only on explicit operator request, allow `*` for users or channels/DMs.
  `deniedUsers` and `deniedChannels` always override allows, including `*`.
  Keep app/workspace routing and bot rejection; missing deny lists default empty.
- Tool access is separate from Slack access. Default OpenCode tools to deny
  and Pi and Claude tools to none; directories are starting locations, not
  sandboxes. Never default Claude to `bypassPermissions`. Default Codex to
  the `read-only` sandbox, approval policy `never` and no tool network.
  Nothing that runs outside the Codex sandbox (launcher, CLI, Stargate data,
  `PATH` entries) may be writable from inside it.
- Persist accepted requests before Slack ACK. Delivery retries must not rerun
  tools. Interrupted execution has uncertain outcomes; do not blindly replay it.
- Do not claim exactly-once external side effects or delivery.
- Keep SQLite state and credential files private. Never delete state to fix
  an error without explicit authorization and an appropriate backup.
- Never create or edit a directory under a managed `releases/` root and never
  move `current` by hand. Install a release with `stargate maintenance update`
  (or the nightly run); see the
  [runbook](docs/maintenance.md#runbook-install-a-release-by-hand).
- Do not install/start/stop user services, change global OpenCode configuration,
  or edit the separate CLIProxyAPI installation unless the user requests it.
- Pi, Claude and Codex proxy routing require explicit provider endpoint and
  credential-reference configuration. Installing CLIProxyAPI does not select
  it automatically. Claude and Codex children get a minimal environment and a
  private `CLAUDE_CONFIG_DIR` or `CODEX_HOME`; never pass the host's
  `~/.claude`, `~/.codex` or other secrets.

## Git

Use trunk-based development. Never commit directly to `main`. Branch from the
latest `main` and keep branches short-lived. Keep each PR to one small change.
When the PR is ready, use `gh pr merge --auto --squash` so it merges when
**Quality checks** pass on its exact head. Auto-merge and automatic
remote-branch deletion are enabled. No approving review is required. You may
ask another captain for a Go or No go, but the verdict is advice and never
blocks the merge. The gate is a full test pass before a release; see
`docs/releases.md`.
Do not stack PRs or keep long-lived branches;
split a large feature into several PRs that each leave `main` working.
Pre-commit tests union HEAD and index import graphs, including deletions,
renames, and imported helpers/data. A reader table covers architecture policy,
hook data and documentation. Untrusted paths print a notice and defer to hosted
**Quality checks** by default. A commit changing only `package.json`, the
lockfile, tool config or workflows runs typecheck and lint locally, but no
tests. Hosted **Quality checks** runs the full suite for those changes.
Computation errors still run the full suite in either untrusted-path mode.
The pre-push hook only enforces the rebase-before-push policy: every branch
push must contain the freshly fetched `origin/main`, so a PR's head is
always current before review. If `main` moves, `git fetch origin && git
rebase origin/main`, then re-run checks; re-review only when the PR's own
diff changed.
Preserve unrelated user changes. Use Conventional Commits, for example
`feat: add backend endpoint configuration` or
`fix: preserve reply progress after delivery failure`. Stage only intended
project files and inspect the staged diff for credentials before committing.

PRs use squash merge. The PR title becomes the commit subject and must be a
Conventional Commit. Merge to `main` does not mean release-ready. Cut a release
only through an explicit, human-approved release step. Do not edit the version
in `package.json` or create tags by hand. See `docs/releases.md`.

Design large features with a configuration enable flag from the start. The
default is off. Release approval includes a decision on which flags become on
by default. The changelog lists new flags, their defaults, and each flag that
the release turns on by default.

Main pushes run Checks only; they never publish a release. The manual Release
workflow defaults to a read-only preview. Publication requires `dry_run=false`
and a person's approval through the `release` environment (reviewer: withakay).
Before requesting approval, update `CHANGELOG.md`'s Unreleased Feature flags
section: new flags with defaults, default changes, and flags enabled by default.
Use explicit `none` entries when no flags change. Do not approve a deployment
on the owner's behalf or bypass the environment gate.
