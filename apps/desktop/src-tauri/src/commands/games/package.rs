//! Representation spike: can a game be described as data alone?
//!
//! Nothing outside this module refers to it. It exists to answer one question before any
//! migration depends on the answer: can the two extreme games be expressed with no field
//! that is a function, a closure, a trait object, or a string that shared code later
//! matches on to pick behaviour. RAID is the most declarative game, Crime Boss the most
//! behavioural, so a representation that holds for both holds for the three in between.
//!
//! A capability reference is a name plus parameters. It is resolved by lookup against a
//! registry of typed implementations, never matched on. That is the whole difference
//! between this and a stringly-typed dispatch: adding a game that reuses an existing
//! capability edits no shared code, and a name that resolves to nothing fails the build.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// A named capability plus the parameters that capability needs. Params stay untyped here
/// and are parsed into the implementation's own struct at the edge, so the package format
/// does not have to enumerate every capability's parameter shape.
#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct CapabilityRef {
    pub id: String,
    pub params: BTreeMap<String, Value>,
}

impl CapabilityRef {
    fn bare(id: &str) -> Self {
        Self {
            id: id.to_string(),
            params: BTreeMap::new(),
        }
    }

    fn with(id: &str, params: &[(&str, Value)]) -> Self {
        Self {
            id: id.to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }
}

/// Whether a mod in this target is one file or one directory. This is a property of the
/// game's mod format rather than a choice of behaviour, which is why it stays an enum: the
/// two shapes carry different data, and no third shape exists to extend to.
#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
pub enum Unit {
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

/// A storefront the game is sold on. Open by construction: the id selects an adapter and
/// the params are that adapter's own data, so a new storefront adds no variant here.
#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct Storefront {
    pub id: String,
    pub params: BTreeMap<String, Value>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub tag: String,
    pub label_key: String,
    pub unit: Unit,
    pub mods_subpath: Vec<String>,
    pub disabled_subpath: Vec<String>,
    pub backup_subpath: Vec<String>,
    pub placement: CapabilityRef,
    /// Ordered, because enabling a Crime Boss mod both rewrites the game's own
    /// ModSettings record and moves the mod on disk. One reference could not say that.
    pub enable: Vec<CapabilityRef>,
    pub order: CapabilityRef,
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct SourceBinding {
    pub source_id: String,
    pub native_id: String,
    pub numeric_id: Option<u32>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct LoaderBinding {
    pub loader_id: String,
    /// Catalog ids that mean "install this loader" for this game only. Declaring them per
    /// game is what stops one game's loader page satisfying another game's dependency.
    pub catalog_ids: Vec<i64>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct SettingDecl {
    pub key: String,
    pub default: Value,
    pub allowed: Vec<Value>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct GamePackage {
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub storage_key: String,
    pub has_news: bool,
    pub required_launch_flag: Option<String>,
    pub index_game_name: String,
    pub state_filename: String,
    pub signals: CapabilityRef,
    pub executables: Vec<String>,
    pub process_names: Vec<String>,
    pub storefronts: Vec<Storefront>,
    pub targets: Vec<Target>,
    pub sources: Vec<SourceBinding>,
    pub loaders: Vec<LoaderBinding>,
    pub settings: Vec<SettingDecl>,
}

/// Every key GamePackage serializes. Kept beside the exhaustive destructuring in
/// every_field_reaches_the_json, which stops compiling when a field is added.
const GAME_PACKAGE_KEYS: &[&str] = &[
    "id",
    "name",
    "short_name",
    "storage_key",
    "has_news",
    "required_launch_flag",
    "index_game_name",
    "state_filename",
    "signals",
    "executables",
    "process_names",
    "storefronts",
    "targets",
    "sources",
    "loaders",
    "settings",
];

// Mirrors engine.rs's BLT_INFRA_FOLDERS and UE4SS_BUNDLED_SUBMODS. Duplicated rather than
// imported because the spike must stand alone to be deletable.
const BLT_INFRA_FOLDERS: &[&str] = &["base", "downloads", "logs", "saves"];

const UE4SS_BUNDLED_SUBMODS: &[&str] = &[
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
];

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

/// RAID: one blanket-accept directory target, one storefront, one source, one loader.
fn raid_package() -> GamePackage {
    GamePackage {
        id: "raid".to_string(),
        name: "RAID: World War II".to_string(),
        short_name: "RAID".to_string(),
        storage_key: "raid".to_string(),
        has_news: false,
        required_launch_flag: None,
        index_game_name: "RAID: World War II".to_string(),
        state_filename: ".modrex.json".to_string(),
        signals: CapabilityRef::bare("diesel"),
        executables: strings(&["raid_win64_release.exe"]),
        process_names: strings(&["raid_win64_release"]),
        storefronts: vec![Storefront {
            id: "steam".to_string(),
            params: [
                ("app_id".to_string(), Value::from(414740)),
                ("folder_name".to_string(), Value::from("RAID World War II")),
            ]
            .into_iter()
            .collect(),
        }],
        targets: vec![Target {
            tag: "mods".to_string(),
            label_key: "mods".to_string(),
            unit: Unit::Directory {
                entry_markers: vec![],
                scan_markers: vec![],
                index_gated_markers: vec![],
                excluded_names: strings(BLT_INFRA_FOLDERS),
            },
            mods_subpath: strings(&["mods"]),
            disabled_subpath: strings(&["mods", "disabled"]),
            backup_subpath: strings(&["mods.bak"]),
            placement: CapabilityRef::bare("passthrough"),
            enable: vec![CapabilityRef::bare("move_to_disabled_dir")],
            order: CapabilityRef::bare("none"),
        }],
        sources: vec![SourceBinding {
            source_id: "modworkshop".to_string(),
            native_id: "543".to_string(),
            numeric_id: None,
        }],
        loaders: vec![LoaderBinding {
            loader_id: "raid_superblt".to_string(),
            catalog_ids: vec![49744],
        }],
        settings: vec![],
    }
}

/// Crime Boss: three targets with three different enable mechanisms, two storefronts, two
/// sources, a loader shared with PAYDAY 3, and a per-game setting.
fn crime_boss_package() -> GamePackage {
    GamePackage {
        id: "cb".to_string(),
        name: "Crime Boss: Rockay City".to_string(),
        short_name: "CBRC".to_string(),
        storage_key: "cb".to_string(),
        has_news: false,
        required_launch_flag: None,
        index_game_name: "Crime Boss: Rockay City".to_string(),
        state_filename: ".modrex.json".to_string(),
        signals: CapabilityRef::bare("none"),
        executables: strings(&["CrimeBoss.exe"]),
        process_names: strings(&["CrimeBoss-Win64-Shipping"]),
        storefronts: vec![
            Storefront {
                id: "steam".to_string(),
                params: [
                    ("app_id".to_string(), Value::from(2933080)),
                    (
                        "folder_name".to_string(),
                        Value::from("CrimeBossRockayCity"),
                    ),
                ]
                .into_iter()
                .collect(),
            },
            Storefront {
                id: "epic".to_string(),
                params: [(
                    "display_name".to_string(),
                    Value::from("Crime Boss: Rockay City"),
                )]
                .into_iter()
                .collect(),
            },
        ],
        targets: vec![
            Target {
                tag: "mods".to_string(),
                label_key: "modkitMods".to_string(),
                unit: Unit::Directory {
                    entry_markers: vec![],
                    scan_markers: vec![],
                    index_gated_markers: vec![],
                    excluded_names: vec![],
                },
                mods_subpath: strings(&["CrimeBoss", "Mods"]),
                disabled_subpath: strings(&["CrimeBoss", "Mods", "disabled"]),
                backup_subpath: strings(&["CrimeBoss", "Mods.bak"]),
                placement: CapabilityRef::with(
                    "mods_skeleton",
                    &[(
                        "content_subpath",
                        Value::from(vec!["Content", "Paks", "WindowsNoEditor"]),
                    )],
                ),
                enable: vec![
                    CapabilityRef::with(
                        "external_json",
                        &[("store", Value::from("crimeboss_mod_settings"))],
                    ),
                    CapabilityRef::bare("move_to_disabled_dir"),
                ],
                order: CapabilityRef::bare("none"),
            },
            Target {
                tag: "paks".to_string(),
                label_key: "legacyPaks".to_string(),
                unit: Unit::File {
                    extension: "pak".to_string(),
                },
                mods_subpath: strings(&["CrimeBoss", "Content", "Paks", "~mods"]),
                disabled_subpath: strings(&["CrimeBoss", "Content", "Paks", "~mods", "disabled"]),
                backup_subpath: strings(&["CrimeBoss", "Content", "~mods.bak"]),
                placement: CapabilityRef::bare("flat_file"),
                enable: vec![
                    CapabilityRef::with(
                        "external_json",
                        &[("store", Value::from("crimeboss_mod_settings"))],
                    ),
                    CapabilityRef::with(
                        "rename_with_suffix",
                        &[("suffix", Value::from(".disabled"))],
                    ),
                ],
                order: CapabilityRef::bare("numeric_prefix"),
            },
            Target {
                tag: "ue4ss_mods".to_string(),
                label_key: "ue4ssMods".to_string(),
                unit: Unit::Directory {
                    entry_markers: strings(&["Scripts/main.lua"]),
                    scan_markers: strings(&["Scripts/main.lua"]),
                    index_gated_markers: vec![],
                    excluded_names: strings(UE4SS_BUNDLED_SUBMODS),
                },
                mods_subpath: strings(&["CrimeBoss", "Binaries", "Win64", "Mods"]),
                disabled_subpath: strings(&["CrimeBoss", "Binaries", "Win64", "Mods", "disabled"]),
                backup_subpath: strings(&["CrimeBoss", "Binaries", "Win64", "Mods.bak"]),
                placement: CapabilityRef::bare("passthrough"),
                enable: vec![CapabilityRef::bare("mods_txt_manifest")],
                order: CapabilityRef::bare("none"),
            },
        ],
        sources: vec![
            SourceBinding {
                source_id: "modworkshop".to_string(),
                native_id: "857".to_string(),
                numeric_id: None,
            },
            SourceBinding {
                source_id: "nexus".to_string(),
                native_id: "crimebossrockaycity".to_string(),
                numeric_id: Some(6528),
            },
        ],
        loaders: vec![LoaderBinding {
            loader_id: "ue4ss".to_string(),
            catalog_ids: vec![47749],
        }],
        settings: vec![SettingDecl {
            key: "crimebossInstallMode".to_string(),
            default: Value::from("ask"),
            allowed: vec![Value::from("ask"), Value::from("auto")],
        }],
    }
}

/// Stands in for the capability registry build.rs will resolve against.
const KNOWN_CAPABILITIES: &[&str] = &[
    "diesel",
    "none",
    "passthrough",
    "flat_file",
    "mods_skeleton",
    "move_to_disabled_dir",
    "rename_with_suffix",
    "mods_txt_manifest",
    "external_json",
    "numeric_prefix",
];

/// Fails naming the package, the field and the id, which is what a build-time diagnostic
/// has to say to be actionable from generated code.
fn resolve_capabilities(pkg: &GamePackage) -> Result<(), String> {
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
        check(
            &format!("targets[{}].placement", target.tag),
            &target.placement,
        )?;
        check(&format!("targets[{}].order", target.tag), &target.order)?;
        for (i, cap) in target.enable.iter().enumerate() {
            check(&format!("targets[{}].enable[{}]", target.tag, i), cap)?;
        }
    }
    Ok(())
}

/// The typed view the Steam adapter owns. Params are parsed into this at the edge, so the
/// package format carries no per-storefront variant while the data is still checked.
#[derive(Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
struct SteamParams {
    app_id: u32,
    folder_name: String,
}

fn parse_storefront<T: serde::de::DeserializeOwned>(
    pkg: &GamePackage,
    front: &Storefront,
) -> Result<T, String> {
    let value = Value::Object(front.params.clone().into_iter().collect());
    serde_json::from_value(value).map_err(|e| {
        format!(
            "package '{}': storefront '{}' has invalid params: {e}",
            pkg.id, front.id
        )
    })
}

/// Emits the TypeScript the renderer and site consume today. Returned rather than written:
/// the spike must not create a generated artifact anything could start depending on.
fn emit_typescript(packages: &[GamePackage]) -> String {
    let mut out = String::from("// Generated from commands/games/*/package.rs. Do not edit.\n\n");
    out.push_str("export const GAMES = {\n");
    for pkg in packages {
        out.push_str(&format!("    {}: {{\n", pkg.id));
        out.push_str(&format!("        name: {:?},\n", pkg.name));
        out.push_str(&format!("        shortName: {:?},\n", pkg.short_name));
        out.push_str(&format!("        storageKey: {:?},\n", pkg.storage_key));
        out.push_str(&format!("        hasNews: {},\n", pkg.has_news));
        out.push_str("        modTargets: [\n");
        for target in &pkg.targets {
            out.push_str(&format!(
                "            {{ id: {:?}, path: {:?} }},\n",
                target.tag,
                target.mods_subpath.join("/")
            ));
        }
        out.push_str("        ],\n    },\n");
    }
    out.push_str("} as const\n\nexport type GameId = keyof typeof GAMES\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn both() -> Vec<GamePackage> {
        vec![raid_package(), crime_boss_package()]
    }

    #[test]
    fn both_games_round_trip_through_json() {
        for pkg in both() {
            let json = serde_json::to_string(&pkg).expect("serialize");
            let back: GamePackage = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(pkg, back, "round trip changed package '{}'", pkg.id);
        }
    }

    #[test]
    fn an_unknown_field_is_rejected() {
        let mut json = serde_json::to_value(raid_package()).expect("serialize");
        json.as_object_mut()
            .expect("object")
            .insert("bonusBehaviour".to_string(), Value::from("hook"));
        let err = serde_json::from_value::<GamePackage>(json)
            .expect_err("an unknown field must not deserialize");
        assert!(
            err.to_string().contains("bonusBehaviour"),
            "diagnostic should name the offending field, got: {err}"
        );
    }

    /// Guards against a field that exists on the struct but never reaches the JSON, which
    /// is how behaviour hides from the generated artifacts. The destructuring below stops
    /// compiling when a field is added, forcing GAME_PACKAGE_KEYS to be updated with it.
    #[test]
    fn every_field_reaches_the_json() {
        for pkg in both() {
            let GamePackage {
                id: _,
                name: _,
                short_name: _,
                storage_key: _,
                has_news: _,
                required_launch_flag: _,
                index_game_name: _,
                state_filename: _,
                signals: _,
                executables: _,
                process_names: _,
                storefronts: _,
                targets: _,
                sources: _,
                loaders: _,
                settings: _,
            } = &pkg;

            let json = serde_json::to_value(&pkg).expect("serialize");
            let object = json.as_object().expect("object");
            for key in GAME_PACKAGE_KEYS {
                assert!(
                    object.contains_key(*key),
                    "package '{}' does not serialize field '{}'",
                    pkg.id,
                    key
                );
            }
            assert_eq!(
                object.len(),
                GAME_PACKAGE_KEYS.len(),
                "package '{}' serializes keys not listed in GAME_PACKAGE_KEYS",
                pkg.id
            );
        }
    }

    #[test]
    fn every_capability_id_resolves() {
        for pkg in both() {
            resolve_capabilities(&pkg).expect("all capability ids should resolve");
        }
    }

    #[test]
    fn an_unknown_capability_id_names_package_field_and_id() {
        let mut pkg = crime_boss_package();
        pkg.targets[0].placement = CapabilityRef::bare("teleport_the_mod");
        let err = resolve_capabilities(&pkg).expect_err("unknown capability must fail");
        assert!(
            err.contains("cb"),
            "diagnostic must name the package: {err}"
        );
        assert!(
            err.contains("targets[mods].placement"),
            "diagnostic must name the field: {err}"
        );
        assert!(
            err.contains("teleport_the_mod"),
            "diagnostic must name the id: {err}"
        );
    }

    #[test]
    fn storefront_params_parse_into_the_adapters_own_type() {
        let raid = raid_package();
        let steam: SteamParams = parse_storefront(&raid, &raid.storefronts[0]).expect("parse");
        assert_eq!(
            steam,
            SteamParams {
                app_id: 414740,
                folder_name: "RAID World War II".to_string(),
            }
        );
    }

    #[test]
    fn bad_storefront_params_name_the_package_and_storefront() {
        let mut raid = raid_package();
        raid.storefronts[0]
            .params
            .insert("app_id".to_string(), Value::from("not a number"));
        let err = parse_storefront::<SteamParams>(&raid, &raid.storefronts[0])
            .expect_err("invalid params must fail");
        assert!(err.contains("raid") && err.contains("steam"), "got: {err}");
    }

    #[test]
    fn crime_boss_needs_two_enable_steps_on_its_file_and_folder_targets() {
        let cb = crime_boss_package();
        let mods = &cb.targets[0];
        let paks = &cb.targets[1];
        let ue4ss = &cb.targets[2];
        assert_eq!(mods.enable.len(), 2);
        assert_eq!(paks.enable.len(), 2);
        assert_eq!(ue4ss.enable.len(), 1);
        assert_eq!(mods.enable[0].id, "external_json");
        assert_eq!(mods.enable[1].id, "move_to_disabled_dir");
        assert_eq!(paks.enable[1].id, "rename_with_suffix");
        assert_eq!(ue4ss.enable[0].id, "mods_txt_manifest");
    }

    /// The scoping change Phase 16 makes deliberate: Crime Boss declares only its own UE4SS
    /// catalog id, so PAYDAY 3's pages (47771, 44048) cannot satisfy a Crime Boss dependency.
    #[test]
    fn loader_catalog_ids_are_scoped_to_the_declaring_game() {
        let cb = crime_boss_package();
        let ue4ss = &cb.loaders[0];
        assert_eq!(ue4ss.catalog_ids, vec![47749]);
        assert!(!ue4ss.catalog_ids.contains(&47771));
        assert!(!ue4ss.catalog_ids.contains(&44048));
    }

    #[test]
    fn typescript_emission_covers_both_games() {
        let ts = emit_typescript(&both());
        assert!(ts.contains("raid: {"));
        assert!(ts.contains("cb: {"));
        assert!(ts.contains(r#"shortName: "CBRC""#));
        assert!(ts.contains(r#"{ id: "paks", path: "CrimeBoss/Content/Paks/~mods" }"#));
        assert!(ts.contains("export type GameId"));
    }
}
