# Releases

Stargate publishes releases on [GitHub][releases]. The public release
sequence starts at `v0.20.3`. Merging to `main` does **not** publish a release.
Checks run on each merge. They test the self-update environment and run the
Mesij integration tests separately with pinned tools.
The updater reads published GitHub releases, not commits on `main`; merged
changes wait until a manual release run publishes them.

## Merge policy

Use short-lived branches and ready PRs. Before merging any PR:

1. Run an independent [thermo-nuclear code quality review](../.agents/skills/thermo-nuclear-code-quality-review/SKILL.md)
   on the final diff. The independent reviewer may be a different GitHub
   identity, or a fresh ephemeral sub-session or separate agent session running
   under the same GitHub identity.
2. Record an explicit review attestation in the PR discussion naming the
   reviewed head commit, the independent reviewer or ephemeral session
   (including agent/model when applicable), the findings, and how the PR
   resolved them. A bare approval or unattributed self-attestation does not meet
   this policy.
3. Require successful **Quality checks** and the recorded review attestation.
   Then enable `gh pr merge --auto --squash`. GitHub deletes the remote branch
   after merge.

GitHub's `main` ruleset enforces linear history, no force-push, no deletion,
and **Quality checks**, with no `pull_request` approval rule. Reviews (including
`CHANGES_REQUESTED`) from other agents or reviewers are advisory and never block
a merge. The pre-push hook requires every branch push to contain the freshly
fetched `origin/main`. If `main` moves, rebase and run checks again. A changed
diff requires a new independent quality review and attestation for the new head.
If the diff did not change, post a short confirmation that the prior attestation
still applies to the new head.

### If `main` goes red

Pushes to `main` run the full **Quality checks** suite (GitHub Actions
concurrency runs one `main` check at a time and keeps the latest queued push).
Breaking `main` is undesirable but not an emergency: fix it in a separate
follow-up PR rather than rewriting history. When **Quality checks** fails on the
current `main` commit, the workflow flags it by opening (or updating) a
`red-main` GitHub issue that links the commit and names the merged PR, author,
pusher, and failing run URL. Once `main` is green again, the workflow closes
open `red-main` issues automatically (stale reruns of older commits do not
modify issues).

The release workflow checks that the dispatched SHA is current `main` and has
passed **Quality checks** before tagging. Never cut a release from a red commit
on `main`.

## Prepare release notes

Before dispatch, update `CHANGELOG.md` under `## Unreleased`. Each release
has an explicit feature-flag decision, even when the answer is none:

```markdown
## Unreleased

### Feature flags

- New flags: `feature.example`, default off. (Use none if there are no new flags.)
- Default changes: none.
- Enabled by default: none.

### Changes

- Describe changes waiting for this release.
```

List every new flag with its default. For a default change, state the flag,
old value and new value. List flags enabled by default in this release,
or write `none`. Keep the section current for the complete unreleased range;
after publication, move it under the released version and start a fresh
Unreleased section. The version script refuses missing or incomplete flag
sections. Published notes include commit subjects since the last tag and
this flag section. Default changes require their own code/configuration
change; approving a release does not toggle a host's settings.

## Preview and publish a release

Only the **Release** workflow (`.github/workflows/release.yml`) publishes.
It accepts manual dispatch on `main` only. Preview is the default:

```sh
gh workflow run release.yml --repo aiconsultancy/stargate --ref main -f dry_run=true
```

The read-only prepare job verifies current main and its successful **Quality
checks**, computes the next version and writes the candidate commit and notes
to the run summary. It does not create tags, assets, releases or deployments.
Review the flag decisions in that summary. To publish:

```sh
gh workflow run release.yml --repo aiconsultancy/stargate --ref main -f dry_run=false
```

The publish job uses the `release` GitHub environment (restricted to protected
branches only; there is no separate reviewer approval gate). Before tagging, the
workflow checks again that the dispatched SHA still matches `main` and that
**Quality checks** passed on that exact commit; if `main` is red or already
advanced, it fails without publishing. This pre-tag check is not an atomic
branch lock, so avoid pushing to `main` during the short window while the
archive is built and tagged. Release runs use `cancel-in-progress: false` so an
in-progress run is not cancelled, though GitHub keeps only the newest pending
dispatch in the concurrency queue.

`scripts/release-version.ts` selects the largest Conventional Commit bump
since the latest `vX.Y.Z` tag:

| Commits since the last tag                                     | Bump                       |
| -------------------------------------------------------------- | -------------------------- |
| Any `type!:` subject or `BREAKING CHANGE:` footer              | major                      |
| Any `feat:` subject                                            | minor                      |
| Any `fix:`, `perf:`, `revert:`, `Revert "…"` or `(deps)` scope | patch                      |
| Only other types (`docs:`, `test:`, `refactor:`, `chore:`…)    | patch for a manual release |

Before `1.0.0`, a major bump increments the minor version. A revert is as large
as the change it reverts, and at least a patch. `(deps-dev)` does not select a
bump; a manual release with commits waiting still forces at least a patch.
Nothing new since the latest tag means no release. Do not change the version
in `package.json` or create a tag by hand.

The approved job creates `stargate-vX.Y.Z.tar.gz` (a `git archive` of the
checked commit) and its SHA-256 file, then publishes both in the GitHub release.
The asset names, archive root and checksums are unchanged. The updater also
compares the unpacked tree against the tagged commit by default. Archive and
checksum names, archive root prefixes, and `.stargate-release.json` metadata
use Stargate only. Old updaters cannot install this format; use the explicit
[one-time bootstrap](hard-cutover.md#release-bootstrap). Historical
v0.20.3/v0.20.4 assets keep their original `pogo-vVERSION` names.

## Verify a release

Download the archive and matching checksum together from [GitHub Releases][releases].
Public assets are available without signing in. For example:

```sh
VERSION=X.Y.Z # Choose a release with Stargate-format assets.
release_url="https://github.com/aiconsultancy/stargate/releases/download/v$VERSION"
curl -fLO "$release_url/stargate-v$VERSION.tar.gz"
curl -fLO "$release_url/stargate-v$VERSION.tar.gz.sha256"
sha256sum -c "stargate-v$VERSION.tar.gz.sha256"
```

On macOS, use `shasum -a 256 -c "stargate-v$VERSION.tar.gz.sha256"`. To compare the
archive against the tagged source, fetch the same tag in a Stargate checkout
and rebuild it:

```sh
git fetch origin tag "v$VERSION"
git archive --format=tar.gz --prefix="stargate-v$VERSION/" "v$VERSION" | sha256sum
```

Use `shasum -a 256` on macOS for the last command. The workflow does not publish
artifact attestations. If archive hashes differ across Git or compression
versions, compare the unpacked files against the tree from the tag.

## Dependency updates

Dependabot checks Bun packages and GitHub Actions daily and waits one day
after a version is published before proposing it. Bun applies the same rule
locally: `bunfig.toml` sets `minimumReleaseAge` to one day. Dependabot PRs
must follow the same [merge policy](#merge-policy) as other PRs. `effect`
stays pinned to the OpenCode SDK's version.

[releases]: https://github.com/aiconsultancy/stargate/releases
