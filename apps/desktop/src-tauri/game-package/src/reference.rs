//! Renders the contributor reference for package.toml from the contract itself.
//!
//! Every list here is produced by an exhaustive match, so a new provider, loader, policy or
//! mode stops this file compiling until it is described.

use crate::{
    Activation, Discovery, LoadOrder, MarkerMode, ModMetadata, NamePreset, Storefront, TargetLabel,
};

fn row(name: &str, description: &str) -> String {
    format!("| `{name}` | {description} |\n")
}

fn mod_metadata_rows() -> String {
    [ModMetadata::Diesel, ModMetadata::None]
        .iter()
        .map(|value| match value {
            ModMetadata::Diesel => row("diesel", "mods carry BLT `mod.txt` or BeardLib `main.xml`"),
            ModMetadata::None => row("none", "mod files describe nothing about themselves"),
        })
        .collect()
}

fn storefront_rows() -> String {
    [Storefront::Steam, Storefront::Epic, Storefront::Xbox]
        .iter()
        .map(|value| match value {
            Storefront::Steam => row("steam", "`app_id` (number), `folder` (Steam installdir)"),
            Storefront::Epic => row("epic", "`name` as the Epic launcher lists it"),
            Storefront::Xbox => row(
                "xbox",
                "`product_id`, `executable` relative to the install's Content folder",
            ),
        })
        .collect()
}

fn activation_rows() -> String {
    [Activation::Filesystem, Activation::Ue4ssModsTxt]
        .iter()
        .map(|value| match value {
            Activation::Filesystem => row(
                "filesystem",
                "enabling and disabling move the mod between the target and its `disabled` folder",
            ),
            Activation::Ue4ssModsTxt => row(
                "ue4ss_mods_txt",
                "the files never move; UE4SS's `mods.txt` beside them is edited instead",
            ),
        })
        .collect()
}

fn load_order_rows() -> String {
    [LoadOrder::FilenamePrefix, LoadOrder::None]
        .iter()
        .map(|value| match value {
            LoadOrder::FilenamePrefix => row(
                "filename_prefix",
                "installed files are renamed `001_Name` so the game mounts them in order",
            ),
            LoadOrder::None => row("none", "the game does not order mods in this target"),
        })
        .collect()
}

fn marker_mode_rows() -> String {
    [MarkerMode::Archive, MarkerMode::Scan, MarkerMode::IndexGated]
        .iter()
        .map(|value| match value {
            MarkerMode::Archive => row(
                "archive",
                "recognises a mod folder inside a downloaded archive, and selects the file hashed to identify it",
            ),
            MarkerMode::Scan => row("scan", "recognises an installed mod folder"),
            MarkerMode::IndexGated => row(
                "index_gated",
                "recognises an installed mod folder, kept only if the mod index knows its hash. Cannot be combined with `scan` on one file",
            ),
        })
        .collect()
}

fn preset_rows() -> String {
    NamePreset::ALL
        .iter()
        .map(|preset| {
            let names = preset
                .names()
                .iter()
                .map(|name| format!("`{name}`"))
                .collect::<Vec<_>>()
                .join(", ");
            match preset {
                NamePreset::DieselInfra => row("diesel_infra", &names),
                NamePreset::Ue4ssBundledSubmods => row("ue4ss_bundled_submods", &names),
            }
        })
        .collect()
}

fn label_rows() -> String {
    [
        TargetLabel::Mods,
        TargetLabel::ModkitMods,
        TargetLabel::LegacyPaks,
        TargetLabel::Overrides,
        TargetLabel::Ue4ssMods,
    ]
    .iter()
    .map(|label| {
        format!(
            "| `{}` | `settings.folders.{}` |\n",
            match label {
                TargetLabel::Mods => "mods",
                TargetLabel::ModkitMods => "modkit_mods",
                TargetLabel::LegacyPaks => "legacy_paks",
                TargetLabel::Overrides => "overrides",
                TargetLabel::Ue4ssMods => "ue4ss_mods",
            },
            label.key()
        )
    })
    .collect()
}

fn discovery_rows() -> String {
    let all = [
        Discovery::AllDirectories,
        Discovery::Markers {
            markers: Vec::new(),
        },
    ];
    all.iter()
        .map(|policy| match policy {
            Discovery::AllDirectories => row(
                "all_directories",
                "every folder in the target is one mod, minus anything `ignore_preset` excludes",
            ),
            Discovery::Markers { .. } => row(
                "markers",
                "a folder is a mod when it contains one of the listed marker files. Requires at least one rule",
            ),
        })
        .collect()
}

/// `examples` is a list of (title, verbatim package.toml) pairs, passed in by the generator so
/// the reference can only show manifests that really exist.
pub fn markdown(examples: &[(&str, &str)]) -> String {
    let mut out = String::new();
    out.push_str(
        "# Authoring a game package\n\n\
         Generated from the contract in `apps/desktop/game-package/src/lib.rs`. Do not edit.\n\n\
         One game is one directory under `apps/desktop/src-tauri/src/games/<id>/` containing one\n\
         `package.toml`. Nothing else lists the games. The desktop build script reads every\n\
         manifest, checks it, and compiles it in, so a mistake is a build failure rather than a\n\
         missing game at runtime.\n\n\
         ## Root\n\n\
         | Key | Required | Meaning |\n| --- | --- | --- |\n\
         | `id` | yes | must equal the directory name |\n\
         | `name` | yes | full title shown in the interface |\n\
         | `short_name` | yes | abbreviation shown where space is tight |\n\
         | `mod_metadata` | yes | what a mod here says about itself |\n\
         | `sources` | no | mod sites this game is listed on |\n\
         | `news` | no | publisher news feeds |\n\
         | `install` | yes | how to find and launch the game |\n\
         | `loaders` | no | mod loaders Modrex can install |\n\
         | `decoders` | no | container formats to unpack before install |\n\
         | `targets` | yes | the places mods are installed |\n\n\
         Components are values, not table headers. A repeated component is a list of objects,\n\
         each object is delimited by braces, and each field sits on its own line ending in a\n\
         comma. Behaviour nests inside the component it describes, so one target reads as one\n\
         object instead of three separate scopes.\n\n\
         ```toml\n\
         sources = [\n\
         \x20   {\n\
         \x20       provider = \"modworkshop\",\n\
         \x20       game_id = \"2\",\n\
         \x20   },\n\
         ]\n\
         ```\n\n\
         ## Editor tooling\n\n\
         These manifests use TOML 1.1 multiline inline tables. The authoritative check is the\n\
         Rust build: `cargo test` inside `apps/desktop/src-tauri` parses and validates every\n\
         manifest. Taplo 0.9 and other tools limited to TOML 1.0 report false syntax errors on\n\
         this syntax. Do not run an incompatible formatter over these files.\n\n",
    );

    out.push_str("## `mod_metadata`\n\n| Value | Meaning |\n| --- | --- |\n");
    out.push_str(&mod_metadata_rows());

    out.push_str("\n## `sources`\n\n| Provider | Fields |\n| --- | --- |\n");
    out.push_str(&row(
        "modworkshop",
        "`game_id`, the id modworkshop knows this game by, written as text",
    ));
    out.push_str(&row("nexus", "`domain`, `numeric_id`"));
    out.push_str(
        "\nAt most one entry per provider, and every entry is optional. A game with no entry for\n\
         a provider is simply not listed there, and nothing in the interface offers it.\n",
    );

    out.push_str("\n## `news`\n\n| Provider | Fields |\n| --- | --- |\n");
    out.push_str(&row("paydaythegame", "`category`"));
    out.push_str("\nAt most one entry per provider.\n");

    out.push_str(
        "\n## `install`\n\n\
         `executables` and `processes` are required, `launch_flag` is optional, and `stores`\n\
         lists every storefront the game can be found on. At most one entry per provider.\n\n\
         | Provider | Fields |\n| --- | --- |\n",
    );
    out.push_str(&storefront_rows());

    out.push_str(
        "\n## `loaders`\n\n\
         `kind` names a loader the host implements; a kind that does not exist is a build error,\n\
         and so is a field belonging to a different kind. `modworkshop_ids` lists the\n\
         modworkshop mod ids the loader is published under, so a mod depending on one of them\n\
         installs the loader.\n\n\
         | Kind | Extra fields |\n| --- | --- |\n",
    );
    out.push_str(&row("ue4ss", "`storefronts`, `proxy_dlls`, `install_into`"));
    out.push_str(&row("superblt", "none"));
    out.push_str(&row("raid_superblt", "none"));
    out.push_str(&row("pdth_overrides", "none"));
    out.push_str(&row("dahm", "none"));
    out.push_str("\n`storefronts` accepts: ");
    out.push_str(
        &[Storefront::Steam, Storefront::Epic, Storefront::Xbox]
            .iter()
            .map(|value| match value {
                Storefront::Steam => "`steam`",
                Storefront::Epic => "`epic`",
                Storefront::Xbox => "`xbox`",
            })
            .collect::<Vec<_>>()
            .join(", "),
    );
    out.push_str(".\n");

    out.push_str(
        "\n## `decoders`\n\n\
         | Format | Fields |\n| --- | --- |\n",
    );
    out.push_str(&row(
        "pdmod",
        "`target`, the tag of the target it unpacks into",
    ));

    out.push_str(
        "\n## `targets`\n\n\
         Order sets the order the interface lists them in. Exactly one target must set\n\
         `primary = true`; that is the one a download installs into unless something routes it\n\
         elsewhere.\n\n\
         | Key | Required | Meaning |\n| --- | --- | --- |\n\
         | `tag` | yes | stable id, stored in every installed mod's record. Renaming one is a data migration |\n\
         | `label` | yes | which folder name the interface shows |\n\
         | `primary` | no | defaults to `false`; exactly one target must set it |\n\
         | `path` | yes | components below the game path |\n\
         | `backup` | yes | where launching without mods moves the contents |\n\
         | `activation` | yes | how a mod is enabled and disabled |\n\
         | `load_order` | yes | whether the game orders mods here |\n\
         | `unit` | yes | what one mod looks like |\n\n\
         The disabled folder is always `path` plus `disabled`, so it is not declared. `backup`\n\
         is declared because it does not follow a pattern: pak targets must place it outside\n\
         `Paks/`, which Unreal mounts recursively.\n\n\
         ### `label`\n\n| Value | Interface string |\n| --- | --- |\n",
    );
    out.push_str(&label_rows());

    out.push_str("\n### `activation`\n\n| Value | Meaning |\n| --- | --- |\n");
    out.push_str(&activation_rows());

    out.push_str("\n### `load_order`\n\n| Value | Meaning |\n| --- | --- |\n");
    out.push_str(&load_order_rows());

    out.push_str(
        "\n### `unit`\n\n\
         `kind = \"file\"` means one mod is one file:\n\n\
         ```toml\n\
         unit = {\n\
         \x20   kind = \"file\",\n\
         \x20   disabled_suffix = \".disabled\",\n\
         \x20   family = {\n\
         \x20       extension = \"pak\",\n\
         \x20       companions = [\"ucas\", \"utoc\"],\n\
         \x20   },\n\
         }\n\
         ```\n\n\
         `kind = \"directory\"` means one mod is one folder, and requires a `discovery` policy.\n\
         `ignore_preset` names a host list of folders that are never mods. `contains` is set when\n\
         Modrex synthesizes the folder around a file family rather than copying an author's\n\
         folder as-is.\n\n\
         ### `family` and `contains`\n\n\
         A file family is a primary `extension` plus the `companions` that travel with it\n\
         because they share its filename stem. Unreal splits one mod across a `pak` holding\n\
         loose files, a `utoc` indexing a container and a `ucas` holding that container's data.\n\
         Modrex reads none of these formats; it moves whatever shares the stem, so a mod\n\
         shipping only the `pak` is normal and an absent companion is never an error. Write\n\
         `companions = []` for a game whose mods are a single file. Containers split into\n\
         numbered partitions such as `Foo_s1.ucas` are not recognised.\n\n\
         Extensions are written bare: no leading dot, no path separator, no duplicates, and a\n\
         companion may not repeat the primary extension.\n\n\
         ### `discovery`\n\n| Policy | Meaning |\n| --- | --- |\n",
    );
    out.push_str(&discovery_rows());
    out.push_str(
        "\nUnder `markers`, each rule names one file and the modes it participates in, so one\n\
         file's whole role reads together:\n\n\
         ```toml\n\
         discovery = {\n\
         \x20   policy = \"markers\",\n\
         \x20   markers = [\n\
         \x20       {\n\
         \x20           file = \"mod.txt\",\n\
         \x20           modes = [\"archive\", \"scan\"],\n\
         \x20       },\n\
         \x20       {\n\
         \x20           file = \"base.lua\",\n\
         \x20           modes = [\"archive\", \"index_gated\"],\n\
         \x20       },\n\
         \x20   ],\n\
         }\n\
         ```\n\n\
         | Mode | Meaning |\n| --- | --- |\n",
    );
    out.push_str(&marker_mode_rows());

    out.push_str("\n### `ignore_preset`\n\n| Preset | Folders |\n| --- | --- |\n");
    out.push_str(&preset_rows());

    out.push_str(
        "\n## Errors\n\n\
         The build script reports the manifest path followed by the problem. Unknown keys,\n\
         unknown values and missing required keys are reported by the TOML reader with a line\n\
         and column; note that a mistake inside a table is reported at that table's header.\n\
         Everything else is reported by the checks the build script runs after parsing:\n\
         a `id` that disagrees with its directory, a duplicate target tag or provider, a target\n\
         count of zero, a primary count other than one, a decoder pointing at a target that is\n\
         not declared, a marker file listed twice or claiming both `scan` and `index_gated`, a\n\
         `markers` policy with no rules, a malformed extension, and a hand-written copy of an\n\
         `ignore` preset.\n\n",
    );

    for (title, manifest) in examples {
        out.push_str(&format!(
            "## Example: {title}\n\n```toml\n{}```\n\n",
            manifest
        ));
    }
    out
}
