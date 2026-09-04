# Adding a game

A game whose mods install the way Modrex already installs mods is one directory and one
manifest. No Rust is written, nothing else lists the games, and there is no registry to
register in.

You still need a Rust toolchain, because the desktop build script is what parses and checks the
manifest. There is no shorter path to the same answer.

Read [integrations.md](integrations.md) first if the game needs a mod source, loader, storefront
or container format Modrex does not have yet. That work comes before the manifest, not after it.

## 1. Create the directory

```text
apps/desktop/src-tauri/src/games/<id>/package.toml
```

`<id>` is lowercase letters, digits and underscores, starting with a letter. It is the game's
identity everywhere: in settings, in each installed mod's record, and in the generated
TypeScript catalog. Changing it later is a data migration, so choose it once.

The build script reads every directory under `src/games/`. Creating the directory is what adds
the game.

That covers the desktop application and the catalog the site reads. The mod-identification
index is a separate pipeline: `apps/index` and the `*-postgres-index` workflows still name the
games they build for, so a new game has no index until those are extended.

## 2. Write the manifest

Copy [../reference/package.example.toml](../reference/package.example.toml) and replace the
values. Every field, every allowed value and every default is in
[../reference/game-package.md](../reference/game-package.md), which is generated from the
contract, so it cannot describe a shape the parser does not accept.

The manifests are TOML 1.1. Components are values rather than table headers, so a repeated
component reads as a list of multiline inline objects and one target reads as one object. The
real manifests under `src/games/` are the style reference. Taplo 0.9 and other TOML 1.0 tools
report false syntax errors on this, so no TOML formatter runs over these files.

Five decisions carry most of the work:

**Stores.** Each store binding names the game the way that storefront names it: a Steam
`app_id` and `installdir` folder, an Epic display name, an Xbox product id plus the executable
relative to the install's Content folder. A game with no store binding can never be found on
disk, so the manifest is rejected without one.

**Targets.** A target is one place mods are installed, and it carries everything about how mods
behave there: the path, where launching without mods moves it, whether enabling is a filesystem
move or an edit to a loader's own list, and whether load order is expressed as a filename
prefix. Exactly one target sets `primary = true`.

**Units.** A unit says what one mod looks like inside a target. A file unit declares the primary
extension plus the companion extensions that travel with it because they share its stem. A
directory unit declares how the scan decides a directory is one mod.

**Discovery.** `policy = "all_directories"` treats every directory as a mod, minus the names an
`ignore_preset` excludes. `policy = "markers"` names the files a mod ships. Each marker lists
its modes: `archive` recognizes a mod folder inside a downloaded archive, `scan` recognizes an
installed one, and `index_gated` recognizes an installed one but keeps it only when the mod
index knows its hash. Use `index_gated` when a marker is shared between a loader's own bundled
modules and genuinely installable mods.

**Package reader.** A game whose own packages are encrypted declares the key that reads them,
and the interface then offers to list what an installed mod contains. Omit it and that game
reports the viewer as unavailable; nothing falls back to another game's key.

## 3. Validate

From `apps/desktop/src-tauri`:

```sh
cargo build
```

The build script parses the manifest with serde and then runs the validator, and it names the
file and the problem. This is the authoritative check. `cargo test` in the same directory runs
it too, along with the tests that regenerate the files below.

## 4. Commit the generated files

The same test run rewrites two generated files from the packages. CI fails when either is stale,
so both belong in the same change as the manifest:

- `packages/games/catalog.generated.ts`, the game catalog the renderer and the site read.
- `docs/reference/game-package.md`, the field reference, when the contract itself changed.

Never edit either by hand.

## 5. Cover art, if you want it

`apps/desktop/src/renderer/src/components/WelcomeScreen.tsx` holds a partial map of store cover
art URLs and a partial map of fallback colors, both keyed by game id. A game with no entry
compiles and runs; it appears in the game picker with the fallback treatment. Adding art is two
entries in that one file.

## What the validator rejects

Serde rejects an unknown key, an unknown value and a missing required one before the validator
runs. The validator then rejects the things serde cannot see:

- a manifest whose `id` does not match its directory name
- two bindings from the same source, news, store or loader provider
- a ModWorkshop game id that is not a number
- no stores at all
- no targets, two targets with the same tag, or a number of primary targets other than one
- a decoder routed to a target the manifest does not declare
- a target with an empty path or an empty backup path
- a file unit with an empty `disabled_suffix`
- an extension or companion extension that is not bare alphanumeric, repeats the primary
  extension, or is listed twice
- the markers policy with no rules, a marker listed twice, a marker with no modes or a repeated
  mode
- a marker carrying both `scan` and `index_gated`, which contradict each other
- a UE4SS loader missing a storefront, a proxy DLL or an `install_into` component
- a package reader whose `aes_key` is not 64 hexadecimal characters

## When a manifest is not enough

The manifest can only name mechanisms that exist. If the game needs a mod source Modrex does not
implement, a loader it does not install, a storefront it cannot detect, or a container format it
cannot decode, that mechanism is added in shared Rust first. See
[integrations.md](integrations.md).
