//! Resolves a game id to the engine config and storefront definition its package declares.

use crate::commands::launchers::{EpicDef, GameDef, SteamDef, XboxDef};
use crate::commands::mods::{ModEngineConfig, ModUnit, ScanTarget};
use crate::game_package::{self as package, GamePackage};
use std::sync::LazyLock;

pub struct GameSpec {
    pub id: &'static str,
    pub engine: &'static ModEngineConfig,
    pub def: &'static GameDef,
}

pub static GAME_REGISTRY: LazyLock<Vec<GameSpec>> = LazyLock::new(|| {
    crate::games::discovered()
        .iter()
        .map(|(_, pkg)| spec_from(pkg))
        .collect()
});

// ModEngineConfig, ScanTarget and GameDef borrow for 'static because every consumer holds
// them for the life of the process. Their text points into the cached package, so only the
// slices and the two structs are allocated, once per package.
fn spec_from(pkg: &'static GamePackage) -> GameSpec {
    let engine = Box::leak(Box::new(ModEngineConfig {
        game_id: &pkg.id,
        index_game_name: &pkg.name,
        mod_metadata: pkg.mod_metadata,
        decoders: &pkg.decoders,
        targets: own_slice(pkg.targets.iter().map(scan_target).collect()),
    }));
    let mut def = GameDef {
        name: &pkg.name,
        executables: text_slice(&pkg.install.executables),
        process_names: text_slice(&pkg.install.processes),
        steam: None,
        epic: None,
        xbox: None,
    };
    for store in &pkg.install.stores {
        match store {
            package::StoreBinding::Steam { app_id, folder } => {
                def.steam = Some(SteamDef {
                    app_id: *app_id,
                    folder_name: folder,
                })
            }
            package::StoreBinding::Epic { name } => def.epic = Some(EpicDef { display_name: name }),
            package::StoreBinding::Xbox {
                product_id,
                executable,
            } => {
                def.xbox = Some(XboxDef {
                    product_id,
                    executable,
                })
            }
        }
    }
    GameSpec {
        id: &pkg.id,
        engine,
        def: Box::leak(Box::new(def)),
    }
}

fn scan_target(target: &'static package::Target) -> ScanTarget {
    ScanTarget {
        tag: &target.tag,
        label_key: target.label.key(),
        unit: match &target.unit {
            package::Unit::File {
                family,
                disabled_suffix,
            } => ModUnit::File {
                extension: &family.extension,
                disabled_suffix,
                priority_prefix: prefixes_filenames(target),
            },
            package::Unit::Directory {
                discovery,
                ignore_preset,
                ..
            } => ModUnit::Directory {
                entry_markers: markers(discovery, package::MarkerMode::Archive),
                scan_markers: markers(discovery, package::MarkerMode::Scan),
                index_gated_markers: markers(discovery, package::MarkerMode::IndexGated),
                excluded_names: ignore_preset
                    .map(package::NamePreset::names)
                    .unwrap_or_default(),
                priority_prefix: prefixes_filenames(target),
            },
        },
        companions: match &target.unit {
            package::Unit::File { family, .. } => text_slice(&family.companions),
            package::Unit::Directory { contains, .. } => contains
                .as_ref()
                .map(|family| text_slice(&family.companions))
                .unwrap_or_default(),
        },
        contained_extension: match &target.unit {
            package::Unit::File { .. } => None,
            package::Unit::Directory { contains, .. } => {
                contains.as_ref().map(|family| family.extension.as_str())
            }
        },
        enabled_state: target.activation,
        mods_subpath: text_slice(&target.path),
        disabled_subpath: own_slice(
            target
                .path
                .iter()
                .map(String::as_str)
                .chain(std::iter::once("disabled"))
                .collect(),
        ),
        backup_subpath: text_slice(&target.backup),
    }
}

/// The scan reads one flat list per mode, so a rule naming several modes lands in each of
/// them. An all_directories policy contributes nothing, which is what makes every folder a
/// mod (see mods/paths.rs).
fn markers(
    discovery: &'static package::Discovery,
    wanted: package::MarkerMode,
) -> &'static [&'static str] {
    let package::Discovery::Markers { markers } = discovery else {
        return &[];
    };
    own_slice(
        markers
            .iter()
            .filter(|rule| rule.modes.contains(&wanted))
            .map(|rule| rule.file.as_str())
            .collect(),
    )
}

fn prefixes_filenames(target: &package::Target) -> bool {
    target.load_order == package::LoadOrder::FilenamePrefix
}

fn text_slice(values: &'static [String]) -> &'static [&'static str] {
    own_slice(values.iter().map(String::as_str).collect())
}

fn own_slice<T>(values: Vec<T>) -> &'static [T] {
    Box::leak(values.into_boxed_slice())
}

pub fn game_spec(game_id: &str) -> Option<&'static GameSpec> {
    GAME_REGISTRY.iter().find(|s| s.id == game_id)
}

#[cfg(test)]
#[path = "games_tests.rs"]
mod tests;
