#!/usr/bin/env bash
# Point this clone's hooks at .githooks/ so the version check runs before push.
#
# Uses core.hooksPath rather than copying into .git/hooks, so the hooks stay
# version-controlled and everyone picks up changes automatically.
#
# Usage: scripts/install-hooks.sh

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

chmod +x .githooks/* scripts/*.sh scripts/*.py 2>/dev/null || true
git config core.hooksPath .githooks

echo "Hooks installed: core.hooksPath -> .githooks"
echo
echo "  pre-push  runs scripts/check-versions.sh against the pushed range"
echo
echo "Bypass a single push with 'git push --no-verify'."
echo "Uninstall with 'git config --unset core.hooksPath'."
