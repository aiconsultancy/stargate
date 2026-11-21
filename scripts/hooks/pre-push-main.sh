#!/bin/sh
# Pre-push: a branch push must contain the freshly fetched origin/main.
#
# prek does not forward git's pre-push stdin lines to hook entries; it
# exposes the push through PRE_COMMIT_* environment variables instead
# (verified against prek 0.5.10). This hook uses that contract:
#   PRE_COMMIT_REMOTE_BRANCH  the remote ref being pushed
#   PRE_COMMIT_TO_REF         the local commit being pushed
#
# Enforces the repository's rebase-before-push policy without rewriting
# anything itself. Skips pushes to main, branch deletions, and non-branch
# refs. Fetches origin/main first so a stale local remote-tracking ref
# cannot give false assurance. A failed fetch fails the push: without it
# we cannot know the branch is current. When the environment is absent
# (hook invoked outside prek), there is nothing to verify and the hook
# passes.
set -u

BRANCH=${PRE_COMMIT_REMOTE_BRANCH:-}
SHA=${PRE_COMMIT_TO_REF:-}

# Not a pre-push context we can verify: pass rather than block.
[ -n "$BRANCH" ] || exit 0
[ -n "$SHA" ] || exit 0

# Pushes to main itself are normal and unchecked.
case $BRANCH in
  refs/heads/main) exit 0 ;;
esac

# Only branch pushes are checked; tags and other refs pass through.
case $BRANCH in
  refs/heads/*) ;;
  *) exit 0 ;;
esac

# Deletions carry an all-zero new commit id (any hash length).
case $SHA in
  *[!0]*) ;;
  *) exit 0 ;;
esac

if ! git fetch --quiet origin main; then
  echo "pre-push: cannot fetch origin/main; refusing to push unverified." >&2
  echo "  Fix the network or remote, then push again." >&2
  echo "  If you are certain main is unchanged, bypass with: git push --no-verify" >&2
  exit 1
fi

if ! git merge-base --is-ancestor FETCH_HEAD "$SHA"; then
  echo "pre-push: $BRANCH is behind the fetched origin/main." >&2
  echo "  Rebase first, then re-run your checks and push:" >&2
  echo "    git fetch origin && git rebase origin/main" >&2
  exit 1
fi

exit 0
