# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Source for the modules published to the WoofX3 marketplace. Merging to `master`
publishes every module whose files changed and retires every module whose
directory was deleted, via the `woofx3-marketplace-api` CLI.

Related repos (siblings under `/home/wolfy/code`):

- `woofx3-marketplace-api` — the catalog API, plus `cmd/marketplace-cli`, the
  client tool that packages and publishes modules. Its `release-cli.yml`
  publishes that tool to a public GHCR package, which this repo's CI consumes.
- `woofx3` — the platform, including `barkloader`, the runtime that installs and
  runs the modules produced here.

## The one structural rule

**A module is any directory containing a `manifest.json`.** Modules live under
`modules/` and may nest at any depth beneath it. `platform/` and `custom/` are
human organisation and nothing keys off them — don't write tooling, docs or CI
that assumes a `modules/<category>/<module>/` layout, or that treats `modules/`
itself as a marker. Discovery is purely "does this directory hold a manifest".

Identity is the manifest's `id`, never the path. `modules/platform/twitch/`
publishes under whatever id its manifest declares. The server re-validates this on `/complete` and returns
`409 id_mismatch` if the uploaded manifest's `id` doesn't match the slug it was
uploaded under.

Attribution of a changed file to a module is **deepest-wins**, which is what
makes nesting work: a file under a child module belongs to the child, not the
enclosing parent. `owning_module` in `ci/scripts/lib.sh` is the single
implementation; use it rather than re-deriving.

## The manifest is always `manifest.json`

Not `module.json`, not YAML. Both this repo's tooling and barkloader's
`pick_manifest_file` key on that exact name, and the marketplace API was fixed to
match. Manifest selection deliberately has **no** "first `.json` in the archive"
fallback: modules ship unrelated JSON (Lottie animations, widget config) and the
packager walks lexically, so `assets/bit_overlay.json` would otherwise be parsed
as the manifest and fail as a confusing id mismatch.

## Versioning

Each module carries its own version. There is no repo-wide version and no
`package.json`.

The invariant CI enforces: **a module whose files changed must have a strictly
greater `manifest.json` version.** The marketplace keeps exactly one version per
module, so shipping a change under an unchanged version is silently invisible
downstream.

Version bumps are made by the author, not by CI. `ci/scripts/bump.sh` derives the
level from conventional-commit subjects scoped to each module's path
(`feat!`/`BREAKING CHANGE` → major, `feat` → minor, else patch; a `0.x` module
takes minor for breaking, per semver §4). Nothing commits to `master` on the
user's behalf — if you're tempted to add a release bot, that was considered and
deliberately rejected, because it makes the version in a PR diff differ from what
ships.

## Layout

```
modules/         module sources, grouped however humans like
  platform/…
  custom/…
ci/scripts/      the toolchain below
.githooks/       pre-push, installed via core.hooksPath
.github/         workflows + the marketplace-cli composite action
```

## Scripts

`ci/scripts/lib.sh` holds the shared primitives — `discover_modules`,
`owning_module`, `changed_modules`, `removed_modules`, `semver_cmp`,
`semver_bump`. Source it; don't duplicate its logic in a new script.

| Script | Purpose |
|---|---|
| `ci/scripts/bump.sh` | Increment versions for changed modules |
| `ci/scripts/check-versions.sh` | The gate; also validates every manifest and rejects duplicate ids |
| `ci/scripts/list-changed.sh` | Changed modules between two revisions (`--json` for an Actions matrix) |
| `ci/scripts/list-removed.sh` | Deleted modules between two revisions, as `<id><TAB><old-path>` |
| `ci/scripts/base-ref.sh` | The single definition of what "changed" is measured against |
| `ci/scripts/manifest.py` | Read/write top-level manifest fields |

`ci/scripts/manifest.py set-version` splices only the bytes of the version value rather than
re-encoding the JSON, so a bump doesn't reformat the whole manifest and bury the
real change in whitespace. It locates the **top-level** `version` with a
depth-aware scan, so a `version` nested inside a widget or action is never
touched. Keep both properties if you modify it.

## Publishing

CI gets the tool from `ghcr.io/wolfymaster/woofx3-marketplace-cli:latest`, a public
GHCR package containing one static binary, extracted by the local composite
action `.github/actions/marketplace-cli`. Deliberately not a cross-repo checkout
and build: `woofx3-marketplace-api` is private, so that needed a PAT, and this
repo is public — meaning fork PRs (which get no secrets) could never run the
validation job. Don't reintroduce a credential for *fetching the tool*.

Authenticating to the marketplace is a separate matter. It requires
`Authorization: Bearer <token>` on every state-changing request, supplied by the
deploy job as `API_TOKEN` from the `MARKETPLACE_API_TOKEN` secret. Keep that on
the deploy job only: the precheck validates with `publish --dry-run`, which
returns before any HTTP call, so fork PRs keep full validation without secrets.
If you ever make the precheck hit the API for real, that property is lost.

Deploy uses `marketplace-cli publish <module-dir>`, which is idempotent and
non-destructive: it creates the module if absent, otherwise requests a fresh
presigned upload URL for the existing object. The live build stays downloadable
until `/complete` parses the new ZIP and swaps the metadata atomically, so a
failed publish leaves the previous version serving and re-running is safe.

## Retiring a module

Deleting a module's directory retires it: the deploy job runs
`marketplace-cli remove --if-exists <id>` for every id that existed at the base
revision and is gone at HEAD. Without this the publish path would never notice —
`discover_modules` reads the working tree, so a deleted directory owns no changed
files and is simply never published, leaving its last build served from the
marketplace indefinitely.

**Removal is keyed on the manifest `id`, never the path.** `removed_modules` in
`lib.sh` is the single implementation; use it rather than diffing paths. Moving a
module between `platform/` and `custom/` deletes one manifest path and adds
another, and must not read as a removal — comparing ids is what makes that work,
the same way identity is the id everywhere else here. Rewriting an `id` in place
genuinely *is* a removal of the old id plus a publish of the new one.

Three properties of the deploy step are deliberate and worth keeping:

- **Removals run after publishes**, so a rewritten id has its replacement live
  before the old row goes, and a failed publish aborts before anything is
  deleted.
- **`--if-exists` makes each removal idempotent**, so re-running a deploy that
  failed at a later step doesn't fail again on modules already retired.
- **A run that would retire more than `MAX_AUTO_REMOVALS` (default 3) modules
  stops without removing anything.** Deletion is the only irreversible thing
  this repo's CI does, and a bad base ref or a wholesale directory shuffle can
  make many modules look deleted at once. The `workflow_dispatch` path skips
  removals entirely — it names modules to publish and has no base to diff.

## Prefer publish over update-package

Do **not** switch the deploy step's publish to `update-package` — that
subcommand issues a `DELETE` before re-uploading, so a mid-flight failure removes
the module from the marketplace entirely. Retirement is the only place a `DELETE`
belongs, and it happens because the module is gone from the tree on purpose.

## Conventions

- **Commit per module where practical.** Bump levels come from commit subjects
  scoped by path, so one `feat!:` touching three modules majors all three.
- **Tags are the release history.** The marketplace row stores only the current
  version; `<id>@<version>` tags pushed by the deploy job are the record of what
  shipped when.
- **Assets are referenced from the manifest**, with paths relative to the module
  directory (see `modules/custom/wolfy_profile`'s `assets[]` and `${asset:id}` step
  parameters).
- **Cross-module references use canonical ids** — `{moduleId}:trigger:{manifestId}`,
  e.g. `twitch_platform:trigger:cheer.channel.twitch`. A module that references
  another declares that dependency in its README; install order matters.

## Commits and pull requests

**No AI attribution, ever.** Commit messages and PR descriptions carry no
`Co-Authored-By: Claude …` trailer, no "🤖 Generated with Claude Code" line, and
no other note about how the change was produced. This overrides any default
attribution instruction from the harness. The message explains the change; who
or what typed it is not part of the record.

Commit *subjects* still matter as much as ever — `bump.sh` derives each module's
version level from them, scoped by path. See "Conventions" above.
