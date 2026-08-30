//! Resolves a game id to its engine config and storefront definition. Discovered game
//! packages are the source for the games that have one; the rest are still handwritten
//! statics.

use crate::commands::launchers::{EpicDef, GameDef, SteamDef, XboxDef, CRIMEBOSS};
use crate::commands::mods::{ModEngineConfig, ModUnit, ScanTarget, CRIMEBOSS_ENGINE};
use crate::game_package::{self as package, GamePackage};
use std::sync::LazyLock;

pub struct GameSpec {
    pub id: &'static str,
    pub engine: &'static ModEngineConfig,
    pub def: &'static GameDef,
}

pub static GAME_REGISTRY: LazyLock<Vec<GameSpec>> = LazyLock::new(|| {
    let mut specs = handwritten_specs();
    specs.extend(
        crate::games::discovered()
            .iter()
            .map(|(_, pkg)| spec_from(pkg)),
    );
    specs
});

fn handwritten_specs() -> Vec<GameSpec> {
    vec![GameSpec {
        id: "cb",
        engine: &CRIMEBOSS_ENGINE,
        def: &CRIMEBOSS,
    }]
}

// ModEngineConfig, ScanTarget and GameDef borrow for 'static because every consumer holds
// them for the life of the process. Their text points into the cached package, so only the
// slices and the two structs are allocated, once per package.
fn spec_from(pkg: &'static GamePackage) -> GameSpec {
    let engine = Box::leak(Box::new(ModEngineConfig {
        game_id: &pkg.id,
        index_game_name: &pkg.index_game_name,
        state_filename: &pkg.state_filename,
        signals: pkg.signals,
        targets: own_slice(pkg.targets.iter().map(scan_target).collect()),
    }));
    let def = Box::leak(Box::new(GameDef {
        name: &pkg.display_name,
        executables: text_slice(&pkg.installation.executables),
        process_names: text_slice(&pkg.installation.process_names),
        steam: pkg.installation.steam.as_ref().map(|store| SteamDef {
            app_id: store.app_id,
            folder_name: &store.folder_name,
        }),
        epic: pkg.installation.epic.as_ref().map(|store| EpicDef {
            display_name: &store.display_name,
        }),
        xbox: pkg.installation.xbox.as_ref().map(|store| XboxDef {
            product_id: &store.product_id,
            executable: &store.executable,
        }),
    }));
    GameSpec {
        id: &pkg.id,
        engine,
        def,
    }
}

fn scan_target(target: &'static package::Target) -> ScanTarget {
    ScanTarget {
        tag: &target.tag,
        label_key: &target.label_key,
        unit: match &target.unit {
            package::Unit::File {
                extension,
                disabled_suffix,
                priority_prefix,
            } => ModUnit::File {
                extension,
                disabled_suffix,
                priority_prefix: *priority_prefix,
            },
            package::Unit::Directory {
                entry_markers,
                scan_markers,
                index_gated_markers,
                excluded_names,
                priority_prefix,
            } => ModUnit::Directory {
                entry_markers: text_slice(entry_markers),
                scan_markers: text_slice(scan_markers),
                index_gated_markers: text_slice(index_gated_markers),
                excluded_names: text_slice(excluded_names),
                priority_prefix: *priority_prefix,
            },
        },
        enabled_state: target.enabled_state,
        mods_subpath: text_slice(&target.mods_subpath),
        disabled_subpath: text_slice(&target.disabled_subpath),
        backup_subpath: text_slice(&target.backup_subpath),
    }
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
