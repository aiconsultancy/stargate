#!/bin/sh
# Reject Zod in files touched by a change.
#
# Policy: any change that modifies a file importing `zod` must replace that
# file's Zod schemas with Effect Schema in the same change. Untouched Zod
# files keep working until their migration batch (see
# docs/effect-schema-migration.md); the ratchet is per touched file.
#
# Usage: touched-zod.sh <base-sha>
#   With no base, nothing is compared and the check passes (main pushes,
#   direct local runs).
# Tests are exempt: the legacy-oracle tests compare against captured Zod
# behaviour by design and stay until the migration removes the oracle.
set -u

BASE=${1:-}
[ -n "$BASE" ] || exit 0

# Fail closed if the comparison point cannot be resolved.
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "touched-zod: cannot resolve base $BASE; refusing to verify." >&2
  exit 1
fi

CHANGED=$(git diff --name-only --diff-filter=ACMRT "$BASE"...HEAD -- 'src' 'scripts' 'perf')

VIOLATIONS=
for file in $CHANGED; do
  [ -f "$file" ] || continue
  # Only TypeScript source carries Zod; the enforcer, docs and shell
  # tooling may legitimately mention the import specifier.
  case $file in
    *.ts) ;;
    *) continue ;;
  esac
  if grep -q 'from "zod"' "$file"; then
    VIOLATIONS="$VIOLATIONS
  $file"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "touched-zod: this change touches files that still import zod:" >&2
  echo "$VIOLATIONS" >&2
  echo "  Each touched file must migrate its Zod schemas to Effect Schema" >&2
  echo "  in this change, or the touch must be reverted. See" >&2
  echo "  docs/effect-schema-migration.md for the migration guide." >&2
  exit 1
fi

exit 0
