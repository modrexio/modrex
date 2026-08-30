use crate::game_package::{
    EnabledStateMechanism, EpicStore, GamePackage, Installation, LoaderBinding, SignalSource,
    SteamStore, Target, Unit, UE4SS_BUNDLED_SUBMODS,
};

fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

pub fn package() -> GamePackage {
    GamePackage {
        id: "cb".to_string(),
        display_name: "Crime Boss: Rockay City".to_string(),
        index_game_name: "Crime Boss: Rockay City".to_string(),
        state_filename: ".modrex.json".to_string(),
        signals: SignalSource::None,
        installation: Installation {
            executables: owned(&["CrimeBoss.exe"]),
            process_names: owned(&["CrimeBoss-Win64-Shipping"]),
            steam: Some(SteamStore {
                app_id: 2933080,
                folder_name: "CrimeBossRockayCity".to_string(),
            }),
            epic: Some(EpicStore {
                display_name: "Crime Boss: Rockay City".to_string(),
            }),
            xbox: None,
        },
        loaders: vec![LoaderBinding {
            loader_id: "ue4ss".to_string(),
            modworkshop_ids: vec![47749],
        }],
        targets: vec![
            // Primary target is CrimeBoss/Mods/<name>/ (Directory unit), the official
            // ModKit's install location. Unlike PD2 and PDTH's Directory targets the
            // install-time content is not an author-supplied folder copied as-is. Modrex
            // synthesizes the Content/Paks/WindowsNoEditor/ skeleton itself around the
            // extracted .pak and its .ucas/.utoc siblings, however the source archive is
            // packaged (see zip.rs's CB-specific resolution path). The official UGC
            // mod-loader merges multiple mods' Data Table Extensions additively when mods
            // live here, whereas the legacy paks target is generic Unreal pak-mount with no
            // merge semantics and resolves overlapping data as last-loaded-wins. It is kept
            // for loose-triplet-only mods but never selected for new installs:
            // resolve_archive_download dispatches on cfg.primary().unit, so paks is
            // reachable only via target_for(Some("paks")) during an ambient scan.
            Target {
                tag: "mods".to_string(),
                label_key: "modkitMods".to_string(),
                unit: Unit::Directory {
                    entry_markers: Vec::new(),
                    scan_markers: Vec::new(),
                    index_gated_markers: Vec::new(),
                    excluded_names: Vec::new(),
                    priority_prefix: false,
                },
                enabled_state: EnabledStateMechanism::Filesystem,
                mods_subpath: owned(&["CrimeBoss", "Mods"]),
                disabled_subpath: owned(&["CrimeBoss", "Mods", "disabled"]),
                backup_subpath: owned(&["CrimeBoss", "Mods.bak"]),
            },
            Target {
                tag: "paks".to_string(),
                label_key: "legacyPaks".to_string(),
                unit: Unit::File {
                    extension: "pak".to_string(),
                    disabled_suffix: ".disabled".to_string(),
                    priority_prefix: true,
                },
                enabled_state: EnabledStateMechanism::Filesystem,
                mods_subpath: owned(&["CrimeBoss", "Content", "Paks", "~mods"]),
                disabled_subpath: owned(&["CrimeBoss", "Content", "Paks", "~mods", "disabled"]),
                backup_subpath: owned(&["CrimeBoss", "Content", "~mods.bak"]),
            },
            Target {
                tag: "ue4ss_mods".to_string(),
                label_key: "ue4ssMods".to_string(),
                unit: Unit::Directory {
                    entry_markers: owned(&["Scripts/main.lua"]),
                    scan_markers: owned(&["Scripts/main.lua"]),
                    index_gated_markers: Vec::new(),
                    excluded_names: owned(UE4SS_BUNDLED_SUBMODS),
                    priority_prefix: false,
                },
                enabled_state: EnabledStateMechanism::Ue4ssModsTxt,
                mods_subpath: owned(&["CrimeBoss", "Binaries", "Win64", "Mods"]),
                disabled_subpath: owned(&["CrimeBoss", "Binaries", "Win64", "Mods", "disabled"]),
                backup_subpath: owned(&["CrimeBoss", "Binaries", "Win64", "Mods.bak"]),
            },
        ],
    }
}
