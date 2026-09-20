#!/usr/bin/env bash
# Shared helpers for module discovery, change attribution and version comparison.
# Source this; don't execute it.
#
# The organising rule of this repo: a module is any directory containing a
# manifest.json, at any depth. Nothing keys off the folder names under modules/
# (platform/, custom/) — those are for humans, and modules/ itself is not
# special-cased either. Identity comes from the manifest's "id" field, which is
# also what the marketplace stores and what /complete validates the upload
# against.

set -euo pipefail

MANIFEST_NAME="manifest.json"

# Resolved from this file's own location so the toolchain can be moved without
# every caller learning where it lives.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_TOOL="$LIB_DIR/manifest.py"

repo_root() {
	git rev-parse --show-toplevel 2>/dev/null || pwd
}

# discover_modules — every module directory in the repo, one per line,
# shortest path first so parents precede their children.
#
# Uses git rather than `find` so ignored build output is never mistaken for a
# module. Untracked-but-not-ignored files are included so a brand-new module is
# discoverable before its first commit — which is when you most want to bump it.
discover_modules() {
	local root
	root="$(repo_root)"
	if git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
		git -C "$root" ls-files --cached --others --exclude-standard \
			-- "*${MANIFEST_NAME}" "${MANIFEST_NAME}"
	else
		(cd "$root" && find . -name "$MANIFEST_NAME" -not -path './.git/*' | sed 's|^\./||')
	fi | while read -r manifest; do
		dirname "$manifest"
	done | sort -u | awk '{ print length($0), $0 }' | sort -n -s | cut -d' ' -f2-
}

# module_id <module-dir> — the manifest's declared id, which is the marketplace
# slug. Never derived from the path.
module_id() {
	"$MANIFEST_TOOL" get "$1/$MANIFEST_NAME" id
}

module_version() {
	"$MANIFEST_TOOL" get "$1/$MANIFEST_NAME" version
}

# warn_nested_modules — a module directory that contains another module gets
# packaged with its child inside it. The server picks the shallowest manifest so
# this still deploys correctly, but the child's files are duplicated into the
# parent's ZIP, which is almost never intended.
warn_nested_modules() {
	local -a mods=()
	local m
	while IFS= read -r m; do mods+=("$m"); done < <(discover_modules)

	local parent child
	for parent in "${mods[@]}"; do
		for child in "${mods[@]}"; do
			[[ "$parent" == "$child" ]] && continue
			if [[ "$child" == "$parent"/* ]]; then
				echo "warning: module '$child' is nested inside module '$parent';" >&2
				echo "         $parent's package will also contain $child's files." >&2
			fi
		done
	done
}

# owning_module <path> — the deepest module directory containing <path>, or
# nothing if the file belongs to no module. Deepest-wins is what makes nesting
# work: a file under a child module is attributed to the child, not the parent.
owning_module() {
	local file="$1" best="" m
	while IFS= read -r m; do
		if [[ "$file" == "$m"/* ]]; then
			if [[ -z "$best" || ${#m} -gt ${#best} ]]; then
				best="$m"
			fi
		fi
	done < <(discover_modules)
	[[ -n "$best" ]] && printf '%s\n' "$best"
}

# changed_modules <base-ref> [head-ref] — module directories touched between two
# revisions, deduplicated. A module counts as changed if any file under it moved,
# including deletions.
changed_modules() {
	local base="$1" head="${2:-HEAD}"
	local -a mods=()
	local m
	while IFS= read -r m; do mods+=("$m"); done < <(discover_modules)
	[[ ${#mods[@]} -eq 0 ]] && return 0

	git diff --name-only "$base" "$head" | while IFS= read -r file; do
		local best="" mod
		for mod in "${mods[@]}"; do
			if [[ "$file" == "$mod"/* ]]; then
				if [[ -z "$best" || ${#mod} -gt ${#best} ]]; then
					best="$mod"
				fi
			fi
		done
		[[ -n "$best" ]] && printf '%s\n' "$best"
	done | sort -u
}

# changed_modules_worktree <base-ref> — like changed_modules, but compares the
# working tree (including uncommitted edits and new files) against the base.
# This is what bump.sh uses, so you can bump before committing.
changed_modules_worktree() {
	local base="$1"
	local -a mods=()
	local m
	while IFS= read -r m; do mods+=("$m"); done < <(discover_modules)
	[[ ${#mods[@]} -eq 0 ]] && return 0

	{
		git diff --name-only "$base" --
		git ls-files --others --exclude-standard
	} | sort -u | while IFS= read -r file; do
		local best="" mod
		for mod in "${mods[@]}"; do
			if [[ "$file" == "$mod"/* ]]; then
				if [[ -z "$best" || ${#mod} -gt ${#best} ]]; then
					best="$mod"
				fi
			fi
		done
		[[ -n "$best" ]] && printf '%s\n' "$best"
	done | sort -u
}

# manifest_dirs_at_rev <rev> — every module directory as it existed at <rev>.
#
# discover_modules reads the working tree, which by definition cannot see a
# module that was deleted — the case removals are entirely about — so this reads
# the tree out of git instead. NUL-delimited, because git quotes paths
# containing unusual characters when it prints them a line at a time.
manifest_dirs_at_rev() {
	local rev="$1" file
	git ls-tree -r -z --name-only "$rev" | while IFS= read -r -d '' file; do
		if [[ "$file" == "$MANIFEST_NAME" || "$file" == */"$MANIFEST_NAME" ]]; then
			dirname "$file"
		fi
	done | sort -u
}

# module_id_at_rev <rev> <module-dir> — the id that module declared at <rev>.
# Fails if the manifest wasn't there or declared no id.
module_id_at_rev() {
	local rev="$1" dir="$2"
	git show "$rev:$dir/$MANIFEST_NAME" 2>/dev/null | "$MANIFEST_TOOL" get /dev/stdin id
}

# removed_modules <base-ref> [head-ref] — modules present at <base-ref> and gone
# at <head-ref>, one "<id><TAB><old-path>" line each. With no head-ref, compares
# against the working tree, so an uncommitted deletion is visible the same way
# changed_modules_worktree makes an uncommitted edit visible.
#
# Keyed on the manifest id, never the path, because the id is the identity.
# Moving a module from modules/custom/ to modules/platform/ deletes one manifest
# path and adds another, and must not read as a removal. Rewriting a module's id
# in place genuinely is a removal of the old id plus a publish of the new one,
# and reports as both.
removed_modules() {
	local base="$1" head="${2:-}"
	local -A present=()
	local dir id

	if [[ -n "$head" ]]; then
		while IFS= read -r dir; do
			[[ -z "$dir" ]] && continue
			id="$(module_id_at_rev "$head" "$dir" 2>/dev/null)" || continue
			[[ -n "$id" ]] && present["$id"]=1
		done < <(manifest_dirs_at_rev "$head")
	else
		while IFS= read -r dir; do
			[[ -z "$dir" ]] && continue
			id="$(module_id "$dir" 2>/dev/null)" || continue
			[[ -n "$id" ]] && present["$id"]=1
		done < <(discover_modules)
	fi

	local -A emitted=()
	while IFS= read -r dir; do
		[[ -z "$dir" ]] && continue
		# A manifest that was already unreadable or id-less at the base ref names
		# nothing in the marketplace, so there is nothing to retire.
		id="$(module_id_at_rev "$base" "$dir" 2>/dev/null)" || continue
		[[ -z "$id" ]] && continue
		[[ -n "${present[$id]:-}" ]] && continue
		[[ -n "${emitted[$id]:-}" ]] && continue
		emitted["$id"]=1
		printf '%s\t%s\n' "$id" "$dir"
	done < <(manifest_dirs_at_rev "$base") | sort
}

# semver_cmp A B — echoes -1 if A<B, 0 if equal, 1 if A>B. Implements the
# precedence rules from semver.org §11, including §11.3 (a release outranks the
# prerelease of the same core version).
semver_cmp() {
	local a="$1" b="$2"
	local a_core="${a%%[-+]*}" b_core="${b%%[-+]*}"
	local a_pre="" b_pre=""
	case "$a" in *-*) a_pre="${a#*-}"; a_pre="${a_pre%%+*}" ;; esac
	case "$b" in *-*) b_pre="${b#*-}"; b_pre="${b_pre%%+*}" ;; esac

	local -a A B
	IFS=. read -r -a A <<<"$a_core"
	IFS=. read -r -a B <<<"$b_core"

	local i x y
	for i in 0 1 2; do
		x="${A[i]:-0}"; y="${B[i]:-0}"
		[[ "$x" =~ ^[0-9]+$ ]] || x=0
		[[ "$y" =~ ^[0-9]+$ ]] || y=0
		if ((10#$x > 10#$y)); then echo 1; return 0; fi
		if ((10#$x < 10#$y)); then echo -1; return 0; fi
	done

	if [[ -z "$a_pre" && -n "$b_pre" ]]; then echo 1; return 0; fi
	if [[ -n "$a_pre" && -z "$b_pre" ]]; then echo -1; return 0; fi
	if [[ "$a_pre" == "$b_pre" ]]; then echo 0; return 0; fi

	local -a AP BP
	IFS=. read -r -a AP <<<"$a_pre"
	IFS=. read -r -a BP <<<"$b_pre"
	local n=${#AP[@]}
	((${#BP[@]} > n)) && n=${#BP[@]}
	for ((i = 0; i < n; i++)); do
		# A larger set of prerelease fields outranks a smaller one when all the
		# preceding identifiers are equal.
		if ((i >= ${#AP[@]})); then echo -1; return 0; fi
		if ((i >= ${#BP[@]})); then echo 1; return 0; fi
		x="${AP[i]}"; y="${BP[i]}"
		if [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]]; then
			if ((10#$x > 10#$y)); then echo 1; return 0; fi
			if ((10#$x < 10#$y)); then echo -1; return 0; fi
		elif [[ "$x" =~ ^[0-9]+$ ]]; then
			# Numeric identifiers always have lower precedence than alphanumeric.
			echo -1; return 0
		elif [[ "$y" =~ ^[0-9]+$ ]]; then
			echo 1; return 0
		elif [[ "$x" > "$y" ]]; then
			echo 1; return 0
		elif [[ "$x" < "$y" ]]; then
			echo -1; return 0
		fi
	done
	echo 0
}

# semver_bump <version> <major|minor|patch> — the next version. Bumping any
# level off a prerelease drops the prerelease tag.
semver_bump() {
	local version="$1" level="$2"
	local core="${version%%[-+]*}"
	local -a P
	IFS=. read -r -a P <<<"$core"
	local major="${P[0]:-0}" minor="${P[1]:-0}" patch="${P[2]:-0}"
	case "$level" in
	major) major=$((major + 1)); minor=0; patch=0 ;;
	minor) minor=$((minor + 1)); patch=0 ;;
	patch) patch=$((patch + 1)) ;;
	*)
		echo "error: unknown bump level '$level' (want major, minor or patch)" >&2
		return 1
		;;
	esac
	printf '%d.%d.%d\n' "$major" "$minor" "$patch"
}

# default_base_ref — what to diff against when the caller doesn't say. Prefers
# the merge base with the integration branch so a long-lived branch only ever
# reports its own changes.
default_base_ref() {
	local branch="${BASE_BRANCH:-master}"
	local ref
	for ref in "origin/$branch" "$branch"; do
		if git rev-parse --verify --quiet "$ref" >/dev/null; then
			git merge-base HEAD "$ref" 2>/dev/null && return 0
		fi
	done
	# A repo with no master yet (first commit) has nothing to compare against.
	git rev-parse --verify --quiet HEAD >/dev/null || return 1
	echo "HEAD"
}
