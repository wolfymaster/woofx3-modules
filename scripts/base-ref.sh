#!/usr/bin/env bash
# Print the revision to compare against — the point where the given commit
# (default HEAD) diverged from the integration branch.
#
# Factored out of the hook and the workflows so "what counts as changed" has one
# definition. Override the branch with BASE_BRANCH.
#
# Usage: scripts/base-ref.sh [rev]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPT_DIR/lib.sh"

rev="${1:-HEAD}"
branch="${BASE_BRANCH:-master}"

for ref in "origin/$branch" "$branch"; do
	if git rev-parse --verify --quiet "$ref" >/dev/null; then
		if base="$(git merge-base "$rev" "$ref" 2>/dev/null)"; then
			echo "$base"
			exit 0
		fi
	fi
done

echo "error: no '$branch' or 'origin/$branch' to compare against" >&2
exit 1
