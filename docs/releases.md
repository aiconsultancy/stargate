# Releases

`main` is the trunk: small PRs merge often, and a merge creates a GitHub
release only when it contains a user-facing change. The first public release is
`v0.20.3`. Historical private tags are kept with the original repository.

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
5. The workflow creates `pogo-vX.Y.Z.tar.gz` (a `git archive` of the commit)
   and its SHA-256 file, and publishes the tag and release with the commit
   subjects as notes. GitHub build provenance (artifact attestations) is not
   available on the organization's current plan. Archive and checksum names,
   archive root prefixes, and `.pogo-release.json` metadata stay compatible
   with existing updaters after the Stargate rename.

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

```sh
gh release download v0.20.3 --repo aiconsultancy/stargate
sha256sum -c pogo-v0.20.3.tar.gz.sha256
# Strongest check without attestations: rebuild the archive from the tag.
git archive --format=tar.gz --prefix=pogo-v0.20.3/ v0.20.3 | sha256sum
```

`git archive` output is reproducible for one git version; compare the
unpacked trees (`diff -r`) if the hashes differ only because of compression.

## Dependency updates

Dependabot checks Bun packages and GitHub Actions daily and waits one day
after a version is published before proposing it. Bun applies the same rule
locally: `bunfig.toml` sets `minimumReleaseAge` to one day. Dependabot
updates merge automatically after Quality checks pass. `effect` is excluded:
it stays pinned to the OpenCode SDK's version.
