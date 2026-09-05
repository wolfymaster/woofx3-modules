#!/usr/bin/env bash
# Fail unless every module touched since the base ref has had its manifest
# version incremented.
#
# This is the gate that makes GitOps deploys safe: the deploy job publishes any
# module whose files changed, and the marketplace stores exactly one version per
# module, so a change that ships under an unchanged version is invisible to
# everyone downstream — installed copies never learn there's something new.
#
# Usage: ci/scripts/check-versions.sh [base-ref]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ci/scripts/lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$(repo_root)"

BASE="${1:-$(default_base_ref)}"

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
	echo "error: base ref '$BASE' does not exist" >&2
	exit 1
fi

red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; dim=$'\033[2m'; reset=$'\033[0m'
if [[ ! -t 1 || -n "${NO_COLOR:-}" ]]; then
	red=""; green=""; yellow=""; dim=""; reset=""
fi

failed=0

# --- Every module must be well-formed and uniquely identified ----------------
# Identity comes from the manifest, so two modules declaring the same id would
# quietly overwrite each other in the marketplace no matter where they live.
declare -A id_seen=()
while IFS= read -r mod; do
	[[ -z "$mod" ]] && continue
	manifest="$mod/$MANIFEST_NAME"

	if ! id="$(module_id "$mod" 2>/dev/null)" || [[ -z "$id" ]]; then
		echo "${red}✗${reset} $manifest has no top-level \"id\"" >&2
		failed=1
		continue
	fi
	if ! [[ "$id" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
		echo "${red}✗${reset} $manifest id '$id' must match ^[a-z0-9][a-z0-9_-]{0,62}\$" >&2
		failed=1
	fi
	if [[ -z "$("$SCRIPT_DIR/manifest.py" get "$manifest" name 2>/dev/null)" ]]; then
		echo "${red}✗${reset} $manifest has no top-level \"name\"" >&2
		failed=1
	fi
	if ! version="$(module_version "$mod" 2>/dev/null)" || [[ -z "$version" ]]; then
		echo "${red}✗${reset} $manifest has no top-level \"version\"" >&2
		failed=1
		continue
	fi
	if [[ -n "${id_seen[$id]:-}" ]]; then
		echo "${red}✗${reset} duplicate module id '$id' in ${id_seen[$id]} and $mod" >&2
		failed=1
	fi
	id_seen[$id]="$mod"
done < <(discover_modules)

warn_nested_modules

# --- Changed modules must be versioned up ------------------------------------
mapfile -t changed < <(changed_modules "$BASE" HEAD)

if [[ ${#changed[@]} -eq 0 ]]; then
	echo "${dim}No module changes since $(git rev-parse --short "$BASE").${reset}"
	exit "$failed"
fi

echo "Modules changed since ${dim}$(git rev-parse --short "$BASE")${reset}:"
echo

for mod in "${changed[@]}"; do
	manifest="$mod/$MANIFEST_NAME"
	new="$(module_version "$mod" 2>/dev/null || true)"
	id="$(module_id "$mod" 2>/dev/null || echo "$mod")"

	# A module that didn't exist at the base ref is new; whatever version it
	# declares is its first, so there is nothing to compare against.
	if ! old_manifest="$(git show "$BASE:$manifest" 2>/dev/null)"; then
		printf '  %s+%s %-24s %s %s(new module)%s\n' "$green" "$reset" "$id" "$new" "$dim" "$reset"
		continue
	fi

	old="$(printf '%s' "$old_manifest" | "$SCRIPT_DIR/manifest.py" get /dev/stdin version 2>/dev/null || true)"

	if [[ -z "$old" ]]; then
		printf '  %s+%s %-24s %s %s(version added)%s\n' "$green" "$reset" "$id" "$new" "$dim" "$reset"
		continue
	fi

	cmp="$(semver_cmp "$new" "$old")"
	case "$cmp" in
	1)
		printf '  %s✓%s %-24s %s -> %s\n' "$green" "$reset" "$id" "$old" "$new"
		;;
	0)
		printf '  %s✗%s %-24s %s %s(unchanged, but files were modified)%s\n' \
			"$red" "$reset" "$id" "$old" "$yellow" "$reset"
		printf '      %srun: ./ci/scripts/bump.sh patch %s%s\n' "$dim" "$mod" "$reset"
		failed=1
		;;
	-1)
		printf '  %s✗%s %-24s %s -> %s %s(version went backwards)%s\n' \
			"$red" "$reset" "$id" "$old" "$new" "$yellow" "$reset"
		failed=1
		;;
	esac
done

echo
if [[ "$failed" -ne 0 ]]; then
	cat >&2 <<-EOF
		${red}Version check failed.${reset}

		Every module you touch needs its manifest.json "version" incremented, because
		the marketplace keeps one version per module and the deploy job publishes
		whatever changed. Run ./ci/scripts/bump.sh to bump everything you've changed, or
		./ci/scripts/bump.sh <patch|minor|major> <module-dir> for one module.
	EOF
	exit 1
fi

echo "${green}All changed modules have an incremented version.${reset}"
