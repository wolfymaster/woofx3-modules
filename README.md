# woofx3-modules

Source for the modules published to the [WoofX3 marketplace](../woofx3-marketplace-api).
Merging to `master` publishes every module whose files changed.

## What counts as a module

**A module is any directory containing a `manifest.json`.** That's the whole
rule. Modules live under `modules/` and can sit at any depth beneath it; the
grouping folders (`platform/`, `custom/`) are for humans — no tooling keys off
them, and `modules/` itself isn't special-cased either.

Identity comes from the manifest, not the path:

```jsonc
{
  "id": "twitch_platform",   // the marketplace slug — must be unique across the repo
  "name": "Twitch Platform",
  "version": "1.1.0"         // semver; the precheck requires this to go up
}
```

`modules/platform/twitch/` publishes under the id its manifest declares. Renaming or moving the
directory changes nothing; renaming the `id` creates a different module.

## Making a change

```bash
# 1. branch and edit
git checkout -b feat/spotify-device-picker
$EDITOR modules/platform/spotify/functions/song_request.js

# 2. commit with a conventional-commit message
git commit -am "feat(spotify): let viewers pick the playback device"

# 3. bump — the level is derived from your commit messages
./ci/scripts/bump.sh
#   spotify   1.0.0 -> 1.1.0  (minor: feat(spotify): let viewers pick the playback device)

# 4. commit the version and push
git commit -am "chore(spotify): 1.1.0"
git push
```

Open a PR against `master`. When it merges, the deploy workflow publishes
`spotify` at `1.1.0` and tags the commit `spotify@1.1.0`.

## Versioning

Every module carries its own version; there is no repo-wide version.

**The rule the CI enforces:** if you change a module's files, its
`manifest.json` version must go up. This matters because the marketplace stores
exactly one version per module — a change shipped under an unchanged version is
invisible to everyone downstream, because installed copies never learn there's
something new.

`./ci/scripts/bump.sh` does the arithmetic, deriving the level from the
conventional-commit messages on your branch that touched each module:

| Commit on your branch | Bump |
|---|---|
| `feat!: …`, or a `BREAKING CHANGE:` footer | major |
| `feat: …` | minor |
| anything else (`fix:`, `chore:`, `docs:`, …) | patch |

A module still on `0.x` gets a minor bump for a breaking change rather than
being pushed to `1.0.0` on your behalf (semver §4).

```bash
./ci/scripts/bump.sh                          # every changed module, level from commits
./ci/scripts/bump.sh minor                    # every changed module, forced level
./ci/scripts/bump.sh patch modules/platform/spotify   # one module, forced level
./ci/scripts/bump.sh --dry-run                # show what would change
```

Because levels come from commit messages scoped by path, **keep a commit to one
module** where you can. A single `feat!:` commit touching three modules bumps all
three to a new major. When that's inconvenient, pass the level explicitly.

This is semantic-release's semantics with the author, not a bot, running it. The
trade is deliberate: nothing writes to `master` behind your back, and the version
in the PR diff is the version that actually ships.

## Local setup

```bash
./ci/scripts/install-hooks.sh
```

Points `core.hooksPath` at `.githooks/`, so `pre-push` runs the same version
check CI does and you find out before opening the PR. Bypass once with
`git push --no-verify`; uninstall with `git config --unset core.hooksPath`.

## Scripts

| Script | Purpose |
|---|---|
| `ci/scripts/bump.sh` | Increment versions for changed modules |
| `ci/scripts/check-versions.sh` | The gate — fails if a changed module wasn't bumped |
| `ci/scripts/list-changed.sh` | Modules changed between two revisions (`--json` for a matrix) |
| `ci/scripts/base-ref.sh` | The revision "changed" is measured against |
| `ci/scripts/manifest.py` | Read/write top-level manifest fields |
| `ci/scripts/lib.sh` | Shared discovery, attribution and semver helpers |
| `ci/scripts/install-hooks.sh` | Point this clone's hooks at `.githooks/` |

`check-versions.sh` also validates every manifest in the repo, not just the
changed ones: each needs an `id`, `name` and `version`, the `id` must match
`^[a-z0-9][a-z0-9_-]{0,62}$`, and no two modules may declare the same `id`.

## CI

| Workflow | Trigger | Does |
|---|---|---|
| `.github/workflows/precheck.yml` | PR to `master` | Runs the version check, then a dry-run publish of each changed module so a malformed manifest fails here rather than mid-deploy |
| `.github/workflows/deploy.yml` | Push to `master` | Publishes each changed module, then tags `<id>@<version>` |

Deploy runs on the `[self-hosted, docker-local]` runner because the marketplace
API is only reachable on the internal network. The API base URL comes from the
`MARKETPLACE_API_URL` repo variable, defaulting to
`http://marketplace.dev.woofx3.tv`.

**Neither workflow needs a secret.** Both get the publishing tool from
`ghcr.io/wolfymaster/marketplace-cli:latest` — a public GHCR package holding a
single static binary, extracted by `.github/actions/marketplace-cli`. GHCR
package visibility is independent of repository visibility, so the CLI is
pullable anonymously even though `woofx3-marketplace-api` is private. That also
means the precheck runs on pull requests from forks, which never receive
secrets.

The image is republished by that repo's `release-cli.yml` on every push to
`main` that touches client code.

Publishing is non-destructive: `marketplace-cli publish` upserts, and the
existing build stays downloadable until the new ZIP is parsed and swapped
atomically. A failed deploy leaves the previous version live, and re-running is
safe.

`deploy.yml` also accepts a manual `workflow_dispatch` with a space-separated
list of module directories, for republishing after an incident.

## Release history

The marketplace stores only each module's current version, so the git tags
(`spotify@1.1.0`) are the record of what shipped when.

```bash
git tag -l 'spotify@*'          # every released version of one module
git log --oneline spotify@1.0.0..spotify@1.1.0 -- modules/platform/spotify
```
