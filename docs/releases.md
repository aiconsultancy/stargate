# Releases

Stargate publishes releases on [GitHub][releases]. The public release
sequence starts at `v0.20.3`. Merging to `main` does **not** publish a release.
Checks, including the self-update environment test, still run on each merge.
The updater reads published GitHub releases, not commits on `main`; merged
changes wait until a person approves a release.

## Merge policy

Use short-lived branches and ready PRs. After review is clear, enable
`gh pr merge --auto --squash`. Main protection requires **Quality checks**
with strict up-to-date checks; the pre-push hook enforces the same
rebase-before-push policy. If main moves, `git fetch origin && git rebase
origin/main`, then re-run checks. GitHub deletes the remote branch after
merge.

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

## Preview and approve a release

Only the **Release** workflow (`.github/workflows/release.yml`) publishes.
It accepts manual dispatch on `main` only. Preview is the default:

```sh
gh workflow run release.yml --repo aiconsultancy/stargate --ref main -f dry_run=true
```

The read-only prepare job verifies current main and its successful **Quality
checks**, computes the next version and writes the candidate commit and notes
to the run summary. It does not create tags, assets, releases or deployments.
Review the flag decisions in that summary. To request publication:

```sh
gh workflow run release.yml --repo aiconsultancy/stargate --ref main -f dry_run=false
```

The publish job waits for the **release** GitHub environment's required
reviewer, **withakay (Jack)**. The environment permits protected branches;
the workflow additionally restricts dispatch to main. A person approves in
GitHub Actions. Agents must not approve on the owner's behalf. The owner
may dispatch and approve their own run (`prevent_self_review=false`).

After approval the job checks main and Quality checks again. If main advanced,
it fails without publishing: preview and approve a new run. It recomputes the
version and requires the prepared candidate version to match. Release runs
are serialised; neither preview nor merge cancels an existing release run.

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
locally: `bunfig.toml` sets `minimumReleaseAge` to one day. Dependabot
updates merge automatically after Quality checks pass. `effect` is excluded:
it stays pinned to the OpenCode SDK's version.

[releases]: https://github.com/aiconsultancy/stargate/releases
