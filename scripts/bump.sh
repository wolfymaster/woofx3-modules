#!/usr/bin/env bash
# Increment the manifest version of every module you've changed.
#
# This is the "semantic release" half of the workflow, run by the author rather
# than by CI. The level is derived from the conventional-commit messages on your
# branch that touched each module, so you get semantic-release's semantics
# without a bot writing to master — and the version in the PR diff is the version
# that actually ships.
#
# Usage:
#   scripts/bump.sh                          # every changed module, level from commits
#   scripts/bump.sh minor                    # every changed module, forced level
#   scripts/bump.sh patch platform/spotify   # one module, forced level
#   scripts/bump.sh platform/spotify         # one module, level from commits
#
# Options:
#   -n, --dry-run   show what would change without writing
#   -b, --base REF  compare against REF instead of the merge base with master

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$(repo_root)"

DRY_RUN=0
BASE=""
LEVEL=""
declare -a TARGETS=()

while [[ $# -gt 0 ]]; do
	case "$1" in
	-n | --dry-run) DRY_RUN=1; shift ;;
	-b | --base) BASE="$2"; shift 2 ;;
	-h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	major | minor | patch)
		if [[ -n "$LEVEL" ]]; then
			echo "error: bump level given twice ('$LEVEL' and '$1')" >&2
			exit 1
		fi
		LEVEL="$1"; shift
		;;
	-*)
		echo "error: unknown option '$1'" >&2
		exit 1
		;;
	*)
		TARGETS+=("${1%/}"); shift
		;;
	esac
done

[[ -z "$BASE" ]] && BASE="$(default_base_ref)"

green=$'\033[32m'; dim=$'\033[2m'; reset=$'\033[0m'
if [[ ! -t 1 || -n "${NO_COLOR:-}" ]]; then green=""; dim=""; reset=""; fi

# derive_level <module-dir> — the bump implied by the conventional-commit
# messages on this branch that touched the module.
#
#   feat!: / BREAKING CHANGE footer -> major
#   feat:                           -> minor
#   anything else                   -> patch
#
# Per the 0.y.z rule in semver §4, a breaking change to a module still in 0.x
# bumps the minor rather than declaring 1.0.0 on the author's behalf.
derive_level() {
	local mod="$1"
	local messages
	messages="$(git log --format='%B%x00' "$BASE"..HEAD -- "$mod" 2>/dev/null || true)"

	if [[ -z "$messages" ]]; then
		# Uncommitted work has no messages to read; patch is the safe floor and
		# the author can always force a level.
		echo "patch"
		return
	fi

	if grep -qE '^[a-zA-Z]+(\([^)]*\))?!:' <<<"$messages" ||
		grep -qE '^BREAKING[ -]CHANGE:' <<<"$messages"; then
		local current major
		current="$(module_version "$mod")"
		major="${current%%.*}"
		if [[ "$major" == "0" ]]; then
			echo "minor"
		else
			echo "major"
		fi
		return
	fi

	if grep -qE '^feat(\([^)]*\))?:' <<<"$messages"; then
		echo "minor"
		return
	fi

	echo "patch"
}

# reason_for <module-dir> — the commit subject that justified the level, for the
# summary line. Purely cosmetic.
reason_for() {
	local mod="$1"
	git log --format='%s' "$BASE"..HEAD -- "$mod" 2>/dev/null | head -1
}

if [[ ${#TARGETS[@]} -eq 0 ]]; then
	mapfile -t TARGETS < <(changed_modules_worktree "$BASE")
	if [[ ${#TARGETS[@]} -eq 0 ]]; then
		echo "${dim}No module changes since $(git rev-parse --short "$BASE" 2>/dev/null || echo "$BASE").${reset}"
		exit 0
	fi
else
	for mod in "${TARGETS[@]}"; do
		if [[ ! -f "$mod/$MANIFEST_NAME" ]]; then
			echo "error: '$mod' is not a module (no $MANIFEST_NAME)" >&2
			exit 1
		fi
	done
fi

changed_any=0
for mod in "${TARGETS[@]}"; do
	level="${LEVEL:-$(derive_level "$mod")}"
	old="$(module_version "$mod")"
	new="$(semver_bump "$old" "$level")"
	id="$(module_id "$mod")"

	reason="$(reason_for "$mod")"
	suffix=""
	[[ -z "$LEVEL" && -n "$reason" ]] && suffix="  ${dim}(${level}: ${reason})${reset}"
	[[ -n "$LEVEL" ]] && suffix="  ${dim}(${level}, forced)${reset}"

	printf '  %-24s %s -> %s%s%s\n' "$id" "$old" "$green" "$new" "$reset$suffix"

	if [[ "$DRY_RUN" -eq 0 ]]; then
		"$SCRIPT_DIR/manifest.py" set-version "$mod/$MANIFEST_NAME" "$new"
		changed_any=1
	fi
done

if [[ "$DRY_RUN" -eq 1 ]]; then
	echo
	echo "${dim}Dry run — nothing written.${reset}"
elif [[ "$changed_any" -eq 1 ]]; then
	echo
	echo "${dim}Updated manifest.json versions. Review and commit them with your change.${reset}"
fi
