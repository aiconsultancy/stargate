# Releases

Every merge to `main` creates a GitHub release. The first release is
`v0.1.0`.

## How a release is made

1. A PR is squash-merged into `main`. Its title becomes the commit subject.
2. The **Checks** workflow runs on `main`.
3. When Checks succeeds, the **Release** workflow
   (`.github/workflows/release.yml`) runs for that commit, if it is still the
   head of `main`. A commit that is no longer the head is skipped; the next
   release includes its changes.
4. `scripts/release-version.ts` reads the commit subjects since the last
   `vX.Y.Z` tag and selects the version:

   | Commits since the last tag                        | Bump  |
   | ------------------------------------------------- | ----- |
   | Any `type!:` subject or `BREAKING CHANGE:` footer | major |
   | Any `feat:` subject                               | minor |
   | Anything else                                     | patch |

   Before `1.0.0`, a major bump increments the minor version.
5. The workflow creates `pogo-vX.Y.Z.tar.gz` (a `git archive` of the commit)
   and its SHA-256 file, records GitHub build provenance for the archive, and
   publishes the tag and release with the commit subjects as notes.

The version lives in the tag, not in `package.json`. CI never commits to
`main`, so branch protection stays unchanged.

## Verify a release

```sh
gh release download v0.1.0 --repo aiconsultancy/pogo
sha256sum -c pogo-v0.1.0.tar.gz.sha256
gh attestation verify pogo-v0.1.0.tar.gz --repo aiconsultancy/pogo
```

## Dependency updates

Dependabot checks Bun packages and GitHub Actions daily and waits one day
after a version is published before proposing it. Bun applies the same rule
locally: `bunfig.toml` sets `minimumReleaseAge` to one day. Dependabot
updates merge automatically after Quality checks pass. `effect` is excluded:
it stays pinned to the OpenCode SDK's version.
