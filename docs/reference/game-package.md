# Authoring a game package

Generated from the contract in `apps/desktop/game-package/src/lib.rs`. Do not edit.

One game is one directory under `apps/desktop/src-tauri/src/games/<id>/` containing one
`package.toml`. Nothing else lists the games. The desktop build script reads every
manifest, checks it, and compiles it in, so a mistake is a build failure rather than a
missing game at runtime.

## Root

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | must equal the directory name |
| `name` | yes | full title shown in the interface |
| `short_name` | yes | abbreviation shown where space is tight |
| `mod_metadata` | yes | what a mod here says about itself |
| `sources` | no | mod sites this game is listed on |
| `news` | no | publisher news feeds |
| `install` | yes | how to find and launch the game |
| `loaders` | no | mod loaders Modrex can install |
| `decoders` | no | container formats to unpack before install |
| `targets` | yes | the places mods are installed |

Components are values, not table headers. A repeated component is a list of objects,
each object is delimited by braces, and each field sits on its own line ending in a
comma. Behaviour nests inside the component it describes, so one target reads as one
object instead of three separate scopes.

```toml
sources = [
    {
        provider = "modworkshop",
        game_id = "2",
    },
]
```

## Editor tooling

These manifests use TOML 1.1 multiline inline tables. The authoritative check is the
Rust build: `cargo test` inside `apps/desktop/src-tauri` parses and validates every
manifest. Taplo 0.9 and other tools limited to TOML 1.0 report false syntax errors on
this syntax. Do not run an incompatible formatter over these files.

## `mod_metadata`

| Value | Meaning |
| --- | --- |
| `diesel` | mods carry BLT `mod.txt` or BeardLib `main.xml` |
| `none` | mod files describe nothing about themselves |

## `sources`

| Provider | Fields |
| --- | --- |
| `modworkshop` | `game_id`, the id modworkshop knows this game by, written as text |
| `nexus` | `domain`, `numeric_id` |

At most one entry per provider, and every entry is optional. A game with no entry for
a provider is simply not listed there, and nothing in the interface offers it.

## `news`

| Provider | Fields |
| --- | --- |
| `paydaythegame` | `category` |

At most one entry per provider.

## `install`

`executables` and `processes` are required, `launch_flag` is optional, and `stores`
lists every storefront the game can be found on. At most one entry per provider.

| Provider | Fields |
| --- | --- |
| `steam` | `app_id` (number), `folder` (Steam installdir) |
| `epic` | `name` as the Epic launcher lists it |
| `xbox` | `product_id`, `executable` relative to the install's Content folder |

## `loaders`

`kind` names a loader the host implements; a kind that does not exist is a build error,
and so is a field belonging to a different kind. `modworkshop_ids` lists the
modworkshop mod ids the loader is published under, so a mod depending on one of them
installs the loader.

| Kind | Extra fields |
| --- | --- |
| `ue4ss` | `storefronts`, `proxy_dlls`, `install_into` |
| `superblt` | none |
| `raid_superblt` | none |
| `pdth_overrides` | none |
| `dahm` | none |

`storefronts` accepts: `steam`, `epic`, `xbox`.

## `decoders`

| Format | Fields |
| --- | --- |
| `pdmod` | `target`, the tag of the target it unpacks into |

## `targets`

Order sets the order the interface lists them in. Exactly one target must set
`primary = true`; that is the one a download installs into unless something routes it
elsewhere.

| Key | Required | Meaning |
| --- | --- | --- |
| `tag` | yes | stable id, stored in every installed mod's record. Renaming one is a data migration |
| `label` | yes | which folder name the interface shows |
| `primary` | no | defaults to `false`; exactly one target must set it |
| `path` | yes | components below the game path |
| `backup` | yes | where launching without mods moves the contents |
| `activation` | yes | how a mod is enabled and disabled |
| `load_order` | yes | whether the game orders mods here |
| `unit` | yes | what one mod looks like |

The disabled folder is always `path` plus `disabled`, so it is not declared. `backup`
is declared because it does not follow a pattern: pak targets must place it outside
`Paks/`, which Unreal mounts recursively.

### `label`

| Value | Interface string |
| --- | --- |
| `mods` | `settings.folders.mods` |
| `modkit_mods` | `settings.folders.modkitMods` |
| `legacy_paks` | `settings.folders.legacyPaks` |
| `overrides` | `settings.folders.overrides` |
| `ue4ss_mods` | `settings.folders.ue4ssMods` |

### `activation`

| Value | Meaning |
| --- | --- |
| `filesystem` | enabling and disabling move the mod between the target and its `disabled` folder |
| `ue4ss_mods_txt` | the files never move; UE4SS's `mods.txt` beside them is edited instead |

### `load_order`

| Value | Meaning |
| --- | --- |
| `filename_prefix` | installed files are renamed `001_Name` so the game mounts them in order |
| `none` | the game does not order mods in this target |

### `unit`

`kind = "file"` means one mod is one file:

```toml
unit = {
    kind = "file",
    disabled_suffix = ".disabled",
    family = {
        extension = "pak",
        companions = ["ucas", "utoc"],
    },
}
```

`kind = "directory"` means one mod is one folder, and requires a `discovery` policy.
`ignore_preset` names a host list of folders that are never mods. `contains` is set when
Modrex synthesizes the folder around a file family rather than copying an author's
folder as-is.

### `family` and `contains`

A file family is a primary `extension` plus the `companions` that travel with it
because they share its filename stem. Unreal splits one mod across a `pak` holding
loose files, a `utoc` indexing a container and a `ucas` holding that container's data.
Modrex reads none of these formats; it moves whatever shares the stem, so a mod
shipping only the `pak` is normal and an absent companion is never an error. Write
`companions = []` for a game whose mods are a single file. Containers split into
numbered partitions such as `Foo_s1.ucas` are not recognised.

Extensions are written bare: no leading dot, no path separator, no duplicates, and a
companion may not repeat the primary extension.

### `discovery`

| Policy | Meaning |
| --- | --- |
| `all_directories` | every folder in the target is one mod, minus anything `ignore_preset` excludes |
| `markers` | a folder is a mod when it contains one of the listed marker files. Requires at least one rule |

Under `markers`, each rule names one file and the modes it participates in, so one
file's whole role reads together:

```toml
discovery = {
    policy = "markers",
    markers = [
        {
            file = "mod.txt",
            modes = ["archive", "scan"],
        },
        {
            file = "base.lua",
            modes = ["archive", "index_gated"],
        },
    ],
}
```

| Mode | Meaning |
| --- | --- |
| `archive` | recognises a mod folder inside a downloaded archive, and selects the file hashed to identify it |
| `scan` | recognises an installed mod folder |
| `index_gated` | recognises an installed mod folder, kept only if the mod index knows its hash. Cannot be combined with `scan` on one file |

### `ignore_preset`

| Preset | Folders |
| --- | --- |
| `diesel_infra` | `base`, `downloads`, `logs`, `saves` |
| `ue4ss_bundled_submods` | `ActorDumperMod`, `BPML_GenericFunctions`, `BPModLoaderMod`, `CheatManagerEnablerMod`, `ConsoleCommandsMod`, `ConsoleEnablerMod`, `jsbLuaProfilerMod`, `Keybinds`, `LineTraceMod`, `SplitScreenMod`, `shared` |

## Errors

The build script reports the manifest path followed by the problem. Unknown keys,
unknown values and missing required keys are reported by the TOML reader with a line
and column; note that a mistake inside a table is reported at that table's header.
Everything else is reported by the checks the build script runs after parsing:
a `id` that disagrees with its directory, a duplicate target tag or provider, a target
count of zero, a primary count other than one, a decoder pointing at a target that is
not declared, a marker file listed twice or claiming both `scan` and `index_gated`, a
`markers` policy with no rules, a malformed extension, and a hand-written copy of an
`ignore` preset.

## Example: the simplest game, RAID: World War II

```toml
id = "raid"
name = "RAID: World War II"
short_name = "RAID"
mod_metadata = "diesel"

sources = [
    {
        provider = "modworkshop",
        game_id = "543",
    },
]

install = {
    executables = ["raid_win64_release.exe"],
    processes = ["raid_win64_release"],
    stores = [
        {
            provider = "steam",
            app_id = 414740,
            folder = "RAID World War II",
        },
    ],
}

loaders = [
    {
        kind = "raid_superblt",
        modworkshop_ids = [49744],
    },
]

targets = [
    {
        tag = "mods",
        label = "mods",
        primary = true,
        path = ["mods"],
        backup = ["mods.bak"],
        activation = "filesystem",
        load_order = "none",

        unit = {
            kind = "directory",
            ignore_preset = "diesel_infra",

            # RAID-SuperBLT and RAIDWW2-BeardLib load script mods and asset override packs from
            # this one folder, and the game's assets/mod_overrides mount is gone. Asset packs
            # carry no supermod.xml or mod.xml, so no marker file could recognise them.
            discovery = {
                policy = "all_directories",
            },
        },
    },
]
```

## Example: a game with every section, PAYDAY: The Heist

```toml
id = "pdth"
name = "PAYDAY: The Heist"
short_name = "PDTH"
mod_metadata = "diesel"

sources = [
    {
        provider = "modworkshop",
        game_id = "2",
    },
    {
        provider = "nexus",
        domain = "paydaytheheist",
        numeric_id = 4339,
    },
]

news = [
    {
        provider = "paydaythegame",
        category = "theheist",
    },
]

decoders = [
    {
        format = "pdmod",
        target = "mod_overrides",
    },
]

install = {
    executables = ["payday_win32_release.exe"],
    processes = ["payday_win32_release"],
    stores = [
        {
            provider = "steam",
            app_id = 24240,
            folder = "PAYDAY The Heist",
        },
    ],
}

loaders = [
    {
        kind = "pdth_overrides",
        modworkshop_ids = [53474],
    },
    {
        kind = "dahm",
        modworkshop_ids = [14267],
    },
]

targets = [
    {
        tag = "mods",
        label = "mods",
        primary = true,
        path = ["mods"],
        backup = ["mods.bak"],
        activation = "filesystem",
        load_order = "none",

        unit = {
            kind = "directory",
            ignore_preset = "diesel_infra",

            # base.lua is DAHM's framework entry point, shared by its own bundled modules and
            # by genuinely installable sub-mods, so an index match is the only reliable way to
            # tell them apart.
            discovery = {
                policy = "markers",
                markers = [
                    {
                        file = "mod.txt",
                        modes = ["archive", "scan"],
                    },
                    {
                        file = "base.lua",
                        modes = ["archive", "index_gated"],
                    },
                ],
            },
        },
    },
    {
        tag = "mod_overrides",
        label = "overrides",
        path = ["assets", "mod_overrides"],
        backup = ["assets", "mod_overrides.bak"],
        activation = "filesystem",
        load_order = "none",

        unit = {
            kind = "directory",

            discovery = {
                policy = "all_directories",
            },
        },
    },
]
```

