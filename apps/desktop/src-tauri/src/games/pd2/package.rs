use crate::game_package::{
    EnabledStateMechanism, EpicStore, GamePackage, Installation, LoaderBinding, SignalSource,
    SteamStore, Target, Unit, DIESEL_INFRA_FOLDERS,
};

fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

pub fn package() -> GamePackage {
    GamePackage {
        id: "pd2".to_string(),
        display_name: "PAYDAY 2".to_string(),
        index_game_name: "PAYDAY 2".to_string(),
        state_filename: ".modrex.json".to_string(),
        signals: SignalSource::Diesel,
        installation: Installation {
            executables: owned(&["PAYDAY2.exe", "payday2_win32_release.exe"]),
            process_names: owned(&["PAYDAY2", "payday2_win32_release"]),
            steam: Some(SteamStore {
                app_id: 218620,
                folder_name: "PAYDAY 2".to_string(),
            }),
            epic: Some(EpicStore {
                display_name: "PAYDAY 2".to_string(),
            }),
            xbox: None,
        },
        loaders: vec![LoaderBinding {
            loader_id: "superblt".to_string(),
            modworkshop_ids: Vec::new(),
            config: None,
        }],
        targets: vec![
            Target {
                tag: "mods".to_string(),
                label_key: "mods".to_string(),
                unit: Unit::Directory {
                    entry_markers: owned(&["mod.txt", "main.xml"]),
                    scan_markers: owned(&["mod.txt", "main.xml"]),
                    index_gated_markers: Vec::new(),
                    excluded_names: owned(DIESEL_INFRA_FOLDERS),
                    priority_prefix: false,
                },
                enabled_state: EnabledStateMechanism::Filesystem,
                mods_subpath: owned(&["mods"]),
                disabled_subpath: owned(&["mods", "disabled"]),
                backup_subpath: owned(&["mods.bak"]),
            },
            Target {
                tag: "mod_overrides".to_string(),
                label_key: "overrides".to_string(),
                unit: Unit::Directory {
                    entry_markers: Vec::new(),
                    scan_markers: Vec::new(),
                    index_gated_markers: Vec::new(),
                    excluded_names: Vec::new(),
                    priority_prefix: false,
                },
                enabled_state: EnabledStateMechanism::Filesystem,
                mods_subpath: owned(&["assets", "mod_overrides"]),
                disabled_subpath: owned(&["assets", "mod_overrides", "disabled"]),
                backup_subpath: owned(&["assets", "mod_overrides.bak"]),
            },
        ],
    }
}
