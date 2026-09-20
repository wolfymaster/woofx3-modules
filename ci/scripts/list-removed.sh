#!/usr/bin/env bash
# List the modules removed between two revisions — present at the base, gone at
# the head — as "<id><TAB><old-path>" lines.
#
# The counterpart to list-changed.sh. The deploy workflow feeds this to
# `marketplace-cli remove`, because the publish path only ever touches modules
# that still exist: without this, deleting a module directory leaves its last
# build serving from the marketplace forever.
#
# Removal is keyed on the manifest's id, so moving a module between directories
# is not a removal. See removed_modules in lib.sh.
#
# Usage:
#   ci/scripts/list-removed.sh [--json] [base-ref] [head-ref]
#
#   --json   emit a GitHub Actions matrix array: [{"id":…,"path":…}]
#
# With no head-ref the working tree is compared, so you can see what deleting a
# directory would retire before committing it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ci/scripts/lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$(repo_root)"

JSON=0
if [[ "${1:-}" == "--json" ]]; then
	JSON=1
	shift
fi

BASE="${1:-$(default_base_ref)}"
HEAD_REF="${2:-}"

mapfile -t removed < <(removed_modules "$BASE" "$HEAD_REF")

if [[ "$JSON" -eq 0 ]]; then
	printf '%s\n' "${removed[@]:-}"
	exit 0
fi

# Built with python so ids and paths are escaped rather than glued together with
# printf, matching list-changed.sh.
printf '%s\n' "${removed[@]:-}" | python3 -c '
import json, sys

entries = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    id_, _, path = line.partition("\t")
    entries.append({"id": id_, "path": path})

entries.sort(key=lambda e: e["id"])
print(json.dumps(entries))
'
