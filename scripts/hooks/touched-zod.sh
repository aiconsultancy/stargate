#!/bin/sh
# Reject touched Zod except mechanically verified import/path moves.
# See docs/effect-schema-migration.md for the exact exception limits.
# Usage: touched-zod.sh <base-sha>. No base means no comparison.
# Tests remain exempt for legacy-oracle comparisons.
set -eu

BASE=${1:-}
[ -n "$BASE" ] || exit 0

exec bun "$(dirname "$0")/touched-zod.ts" "$BASE"
