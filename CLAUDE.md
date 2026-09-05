# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Source for the modules published to the WoofX3 marketplace. Merging to `master`
publishes every module whose files changed, via the `woofx3-marketplace-api` CLI.

Related repos (siblings under `/home/wolfy/code`):

- `woofx3-marketplace-api` — the catalog API and the `marketplace-api` CLI that
  packages and publishes modules. Deploy CI builds it from source.
- `woofx3` — the platform, including `barkloader`, the runtime that installs and
  runs the modules produced here.

## The one structural rule

**A module is any directory containing a `manifest.json`.** Modules may nest at
any depth. `platform/` and `custom/` are human organisation and nothing keys off
them — don't write tooling, docs or CI that assumes a `<category>/<module>/`
layout.

Identity is the manifest's `id`, never the path. `platform/twitch/` publishes as
`twitch_platform`. The server re-validates this on `/complete` and returns
`409 id_mismatch` if the uploaded manifest's `id` doesn't match the slug it was
uploaded under.

Attribution of a changed file to a module is **deepest-wins**, which is what
makes nesting work: a file under a child module belongs to the child, not the
enclosing parent. `owning_module` in `scripts/lib.sh` is the single
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

Version bumps are made by the author, not by CI. `scripts/bump.sh` derives the
level from conventional-commit subjects scoped to each module's path
(`feat!`/`BREAKING CHANGE` → major, `feat` → minor, else patch; a `0.x` module
takes minor for breaking, per semver §4). Nothing commits to `master` on the
user's behalf — if you're tempted to add a release bot, that was considered and
deliberately rejected, because it makes the version in a PR diff differ from what
ships.

## Scripts

`scripts/lib.sh` holds the shared primitives — `discover_modules`,
`owning_module`, `changed_modules`, `semver_cmp`, `semver_bump`. Source it;
don't duplicate its logic in a new script.

| Script | Purpose |
|---|---|
| `bump.sh` | Increment versions for changed modules |
| `check-versions.sh` | The gate; also validates every manifest and rejects duplicate ids |
| `list-changed.sh` | Changed modules between two revisions (`--json` for an Actions matrix) |
| `base-ref.sh` | The single definition of what "changed" is measured against |
| `manifest.py` | Read/write top-level manifest fields |

`manifest.py set-version` splices only the bytes of the version value rather than
re-encoding the JSON, so a bump doesn't reformat the whole manifest and bury the
real change in whitespace. It locates the **top-level** `version` with a
depth-aware scan, so a `version` nested inside a widget or action is never
touched. Keep both properties if you modify it.

## Publishing

Deploy uses `marketplace-api publish <module-dir>`, which is idempotent and
non-destructive: it creates the module if absent, otherwise requests a fresh
presigned upload URL for the existing object. The live build stays downloadable
until `/complete` parses the new ZIP and swaps the metadata atomically, so a
failed publish leaves the previous version serving and re-running is safe.

Do **not** switch this to `update-package` — that subcommand issues a `DELETE`
before re-uploading, so a mid-flight failure removes the module from the
marketplace entirely.

## Conventions

- **Commit per module where practical.** Bump levels come from commit subjects
  scoped by path, so one `feat!:` touching three modules majors all three.
- **Tags are the release history.** The marketplace row stores only the current
  version; `<id>@<version>` tags pushed by the deploy job are the record of what
  shipped when.
- **Assets are referenced from the manifest**, with paths relative to the module
  directory (see `custom/wolfy_profile`'s `assets[]` and `${asset:id}` step
  parameters).
- **Cross-module references use canonical ids** — `{moduleId}:trigger:{manifestId}`,
  e.g. `twitch_platform:trigger:cheer.channel.twitch`. A module that references
  another declares that dependency in its README; install order matters.
