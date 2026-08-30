//! Resolves a game id to its engine config and storefront definition. Discovered game
//! packages are the source for the games that have one; the rest are still handwritten
//! statics.

use crate::commands::launchers::{EpicDef, GameDef, SteamDef, XboxDef, CRIMEBOSS, PD2, PD3, PDTH};
use crate::commands::mods::{
    ModEngineConfig, ModUnit, ScanTarget, CRIMEBOSS_ENGINE, PD2_ENGINE, PD3_ENGINE, PDTH_ENGINE,
};
use crate::games::package::{self, GamePackage};
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
            .into_iter()
            .map(|(_, pkg)| spec_from(pkg)),
    );
    specs
});

fn handwritten_specs() -> Vec<GameSpec> {
    vec![
        GameSpec {
            id: "pd3",
            engine: &PD3_ENGINE,
            def: &PD3,
        },
        GameSpec {
            id: "pd2",
            engine: &PD2_ENGINE,
            def: &PD2,
        },
        GameSpec {
            id: "pdth",
            engine: &PDTH_ENGINE,
            def: &PDTH,
        },
        GameSpec {
            id: "cb",
            engine: &CRIMEBOSS_ENGINE,
            def: &CRIMEBOSS,
        },
    ]
}

// ModEngineConfig, ScanTarget and GameDef borrow for 'static because every consumer holds
// them for the life of the process. A package owns its strings, so materialising one means
// giving them that lifetime. GAME_REGISTRY builds each package exactly once, so what this
// leaks is bounded by the number of packages compiled in.
fn spec_from(pkg: GamePackage) -> GameSpec {
    let id = leak_str(pkg.id);
    let engine = Box::leak(Box::new(ModEngineConfig {
        game_id: id,
        index_game_name: leak_str(pkg.index_game_name),
        state_filename: leak_str(pkg.state_filename),
        signals: pkg.signals,
        targets: leak_slice(pkg.targets.into_iter().map(scan_target).collect()),
    }));
    let def = Box::leak(Box::new(GameDef {
        name: leak_str(pkg.display_name),
        executables: leak_strs(pkg.installation.executables),
        process_names: leak_strs(pkg.installation.process_names),
        steam: pkg.installation.steam.map(|s| SteamDef {
            app_id: s.app_id,
            folder_name: leak_str(s.folder_name),
        }),
        epic: pkg.installation.epic.map(|e| EpicDef {
            display_name: leak_str(e.display_name),
        }),
        xbox: pkg.installation.xbox.map(|x| XboxDef {
            product_id: leak_str(x.product_id),
            executable: leak_str(x.executable),
        }),
    }));
    GameSpec { id, engine, def }
}

fn scan_target(target: package::Target) -> ScanTarget {
    ScanTarget {
        tag: leak_str(target.tag),
        label_key: leak_str(target.label_key),
        unit: match target.unit {
            package::Unit::File {
                extension,
                disabled_suffix,
                priority_prefix,
            } => ModUnit::File {
                extension: leak_str(extension),
                disabled_suffix: leak_str(disabled_suffix),
                priority_prefix,
            },
            package::Unit::Directory {
                entry_markers,
                scan_markers,
                index_gated_markers,
                excluded_names,
                priority_prefix,
            } => ModUnit::Directory {
                entry_markers: leak_strs(entry_markers),
                scan_markers: leak_strs(scan_markers),
                index_gated_markers: leak_strs(index_gated_markers),
                excluded_names: leak_strs(excluded_names),
                priority_prefix,
            },
        },
        enabled_state: target.enabled_state,
        mods_subpath: leak_strs(target.mods_subpath),
        disabled_subpath: leak_strs(target.disabled_subpath),
        backup_subpath: leak_strs(target.backup_subpath),
    }
}

fn leak_str(value: String) -> &'static str {
    Box::leak(value.into_boxed_str())
}

fn leak_strs(values: Vec<String>) -> &'static [&'static str] {
    leak_slice(values.into_iter().map(leak_str).collect())
}

fn leak_slice<T>(values: Vec<T>) -> &'static [T] {
    Box::leak(values.into_boxed_slice())
}

pub fn game_spec(game_id: &str) -> Option<&'static GameSpec> {
    GAME_REGISTRY.iter().find(|s| s.id == game_id)
}

#[cfg(test)]
#[path = "games_tests.rs"]
mod tests;
