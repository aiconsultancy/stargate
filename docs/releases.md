# Releases

Stargate publishes releases on [GitHub][releases]. The public release
sequence starts at `v0.20.3`. User-facing changes merged to `main` trigger
releases through GitHub Actions.

## How a release is made

1. A PR is squash-merged into `main`; the repository allows no other merge
   method. The PR title becomes the commit subject, also for one-commit PRs.
2. The **Checks** workflow runs on `main`.
3. When Checks succeeds, the **Release** workflow
   (`.github/workflows/release.yml`) runs for that commit, if it is still the
   head of `main`. A commit that is no longer the head is skipped; the next
   release includes its changes.
4. `scripts/release-version.ts` reads the commit subjects since the last
   `vX.Y.Z` tag and selects the version:

   | Commits since the last tag                                                | Bump       |
   | ------------------------------------------------------------------------- | ---------- |
   | Any `type!:` subject or `BREAKING CHANGE:` footer                         | major      |
   | Any `feat:` subject                                                       | minor      |
   | Any `fix:`, `perf:`, `revert:` or `Revert "…"` subject, or `(deps)` scope | patch      |
   | Only other types (`docs:`, `test:`, `refactor:`, `chore:`…)               | no release |

   Before `1.0.0`, a major bump increments the minor version. A revert is as
   large as the change it reverts, and at least a patch. `(deps-dev)` updates
   only change development tools, so they do not release. Commits that do not
   release are included in the next release's notes.
5. The workflow creates `stargate-vX.Y.Z.tar.gz` (a `git archive` of the commit)
   and its SHA-256 file, and publishes the tag and release with the commit
   subjects as notes. The workflow publishes checksums. The updater also
   compares the unpacked tree against the tagged commit by default. Archive
   and checksum names, archive root prefixes, and `.stargate-release.json`
   metadata use Stargate only. Old updaters cannot install this format; use
   the explicit [one-time bootstrap](hard-cutover.md#release-bootstrap).
   Historical v0.20.3/v0.20.4 assets keep their original `pogo-vVERSION` names.

## Release manually

To release changes that do not release on their own, run the Release workflow
on `main`:

```sh
gh workflow run release.yml --repo aiconsultancy/stargate --ref main
```

It releases the head of `main` only after its Quality checks have passed, and
bumps at least the patch version. With nothing new since the last tag, it does
nothing.

The version lives in the tag, not in `package.json`. CI never commits to
`main`, so branch protection stays unchanged.

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
