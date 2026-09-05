#!/usr/bin/env bash
# List the modules changed between two revisions.
#
# Used by the deploy workflow to decide what to publish, and useful by hand to
# see what a merge would ship.
#
# Usage:
#   scripts/list-changed.sh [--json] [base-ref] [head-ref]
#
#   --json   emit a GitHub Actions matrix array: [{"id":…,"path":…,"version":…}]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$(repo_root)"

JSON=0
if [[ "${1:-}" == "--json" ]]; then
	JSON=1
	shift
fi

BASE="${1:-$(default_base_ref)}"
HEAD_REF="${2:-HEAD}"

mapfile -t changed < <(changed_modules "$BASE" "$HEAD_REF")

if [[ "$JSON" -eq 0 ]]; then
	printf '%s\n' "${changed[@]:-}"
	exit 0
fi

# Build the matrix with python so ids and paths are correctly escaped rather
# than glued together with printf.
printf '%s\n' "${changed[@]:-}" | python3 -c '
import json, subprocess, sys

entries = []
for path in (line.strip() for line in sys.stdin):
    if not path:
        continue
    def field(name):
        return subprocess.run(
            ["scripts/manifest.py", "get", f"{path}/manifest.json", name],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    entries.append({"id": field("id"), "path": path, "version": field("version")})

entries.sort(key=lambda e: e["id"])
print(json.dumps(entries))
'
