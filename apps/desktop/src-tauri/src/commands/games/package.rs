//! Throwaway experiment: can an existing game's mod layout be written as serde data whose
//! variable behaviour is named by capability id rather than carried in the type?

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub(super) struct CapabilityRef {
    pub(super) id: String,
    pub(super) params: BTreeMap<String, Value>,
}

impl CapabilityRef {
    pub(super) fn bare(id: &str) -> Self {
        Self {
            id: id.to_string(),
            params: BTreeMap::new(),
        }
    }

    pub(super) fn with(id: &str, key: &str, value: Value) -> Self {
        Self {
            id: id.to_string(),
            params: [(key.to_string(), value)].into_iter().collect(),
        }
    }
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
pub(super) enum Unit {
    File {
        extension: String,
    },
    Directory {
        entry_markers: Vec<String>,
        scan_markers: Vec<String>,
        index_gated_markers: Vec<String>,
        excluded_names: Vec<String>,
    },
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    pub(super) tag: String,
    pub(super) unit: Unit,
    pub(super) mods_subpath: Vec<String>,
    pub(super) disabled_subpath: Vec<String>,
    pub(super) backup_subpath: Vec<String>,
    /// None where a mod is disabled by moving it rather than renaming it. Path building,
    /// scanning and identity all read this, so it is a target fact and not a parameter of
    /// whichever capability performs the rename.
    pub(super) disabled_suffix: Option<String>,
    /// Folder, reorder, state and install code read this, not only load-order changes.
    pub(super) priority_prefix: bool,
    pub(super) enable: Vec<CapabilityRef>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub(super) struct GamePackage {
    pub(super) id: String,
    pub(super) signals: CapabilityRef,
    pub(super) targets: Vec<Target>,
}

/// Paired with the exhaustive destructuring in every_field_reaches_the_json, which stops
/// compiling when a field is added.
pub(super) const GAME_PACKAGE_KEYS: &[&str] = &["id", "signals", "targets"];

pub(super) const KNOWN_CAPABILITIES: &[&str] = &[
    "diesel",
    "none",
    "move_to_disabled_dir",
    "rename_with_suffix",
    "mods_txt_manifest",
    "external_json",
];

/// Names the package, the field and the id, which is what a caller needs to locate an
/// unresolved reference in data it did not write.
pub(super) fn resolve_capabilities(pkg: &GamePackage) -> Result<(), String> {
    let check = |field: &str, cap: &CapabilityRef| -> Result<(), String> {
        if KNOWN_CAPABILITIES.contains(&cap.id.as_str()) {
            return Ok(());
        }
        Err(format!(
            "package '{}': field '{}' names unknown capability '{}'",
            pkg.id, field, cap.id
        ))
    };
    check("signals", &pkg.signals)?;
    for target in &pkg.targets {
        for (i, cap) in target.enable.iter().enumerate() {
            check(&format!("targets[{}].enable[{}]", target.tag, i), cap)?;
        }
    }
    Ok(())
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

/// The most declarative game: one blanket-accept directory target.
pub(super) fn raid_package() -> GamePackage {
    GamePackage {
        id: "raid".to_string(),
        signals: CapabilityRef::bare("diesel"),
        targets: vec![Target {
            tag: "mods".to_string(),
            unit: Unit::Directory {
                entry_markers: vec![],
                scan_markers: vec![],
                index_gated_markers: vec![],
                excluded_names: strings(&["base", "downloads", "logs", "saves"]),
            },
            mods_subpath: strings(&["mods"]),
            disabled_subpath: strings(&["mods", "disabled"]),
            backup_subpath: strings(&["mods.bak"]),
            disabled_suffix: None,
            priority_prefix: false,
            enable: vec![CapabilityRef::bare("move_to_disabled_dir")],
        }],
    }
}

/// The most behavioural game: three targets whose enable work differs in kind.
pub(super) fn crime_boss_package() -> GamePackage {
    GamePackage {
        id: "cb".to_string(),
        signals: CapabilityRef::bare("none"),
        targets: vec![
            Target {
                tag: "mods".to_string(),
                unit: Unit::Directory {
                    entry_markers: vec![],
                    scan_markers: vec![],
                    index_gated_markers: vec![],
                    excluded_names: vec![],
                },
                mods_subpath: strings(&["CrimeBoss", "Mods"]),
                disabled_subpath: strings(&["CrimeBoss", "Mods", "disabled"]),
                backup_subpath: strings(&["CrimeBoss", "Mods.bak"]),
                disabled_suffix: None,
                priority_prefix: false,
                enable: vec![
                    CapabilityRef::with(
                        "external_json",
                        "store",
                        Value::from("crimeboss_mod_settings"),
                    ),
                    CapabilityRef::bare("move_to_disabled_dir"),
                ],
            },
            Target {
                tag: "paks".to_string(),
                unit: Unit::File {
                    extension: "pak".to_string(),
                },
                mods_subpath: strings(&["CrimeBoss", "Content", "Paks", "~mods"]),
                disabled_subpath: strings(&["CrimeBoss", "Content", "Paks", "~mods", "disabled"]),
                backup_subpath: strings(&["CrimeBoss", "Content", "~mods.bak"]),
                disabled_suffix: Some(".disabled".to_string()),
                priority_prefix: true,
                enable: vec![
                    CapabilityRef::with(
                        "external_json",
                        "store",
                        Value::from("crimeboss_mod_settings"),
                    ),
                    CapabilityRef::bare("rename_with_suffix"),
                ],
            },
            Target {
                tag: "ue4ss_mods".to_string(),
                unit: Unit::Directory {
                    entry_markers: strings(&["Scripts/main.lua"]),
                    scan_markers: strings(&["Scripts/main.lua"]),
                    index_gated_markers: vec![],
                    excluded_names: strings(&[
                        "ActorDumperMod",
                        "BPML_GenericFunctions",
                        "BPModLoaderMod",
                        "CheatManagerEnablerMod",
                        "ConsoleCommandsMod",
                        "ConsoleEnablerMod",
                        "jsbLuaProfilerMod",
                        "Keybinds",
                        "LineTraceMod",
                        "SplitScreenMod",
                        "shared",
                    ]),
                },
                mods_subpath: strings(&["CrimeBoss", "Binaries", "Win64", "Mods"]),
                disabled_subpath: strings(&["CrimeBoss", "Binaries", "Win64", "Mods", "disabled"]),
                backup_subpath: strings(&["CrimeBoss", "Binaries", "Win64", "Mods.bak"]),
                disabled_suffix: None,
                priority_prefix: false,
                enable: vec![CapabilityRef::bare("mods_txt_manifest")],
            },
        ],
    }
}
