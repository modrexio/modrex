use crate::game_package::{
    EnabledStateMechanism, GamePackage, Installation, LoaderBinding, SignalSource, SteamStore,
    Target, Unit, DIESEL_INFRA_FOLDERS,
};

fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

pub fn package() -> GamePackage {
    GamePackage {
        id: "pdth".to_string(),
        display_name: "PAYDAY: The Heist".to_string(),
        index_game_name: "PAYDAY: The Heist".to_string(),
        state_filename: ".modrex.json".to_string(),
        signals: SignalSource::Diesel,
        installation: Installation {
            executables: owned(&["payday_win32_release.exe"]),
            process_names: owned(&["payday_win32_release"]),
            steam: Some(SteamStore {
                app_id: 24240,
                folder_name: "PAYDAY The Heist".to_string(),
            }),
            epic: None,
            xbox: None,
        },
        loaders: vec![
            LoaderBinding {
                loader_id: "pdth_overrides".to_string(),
                modworkshop_ids: vec![53474],
            },
            LoaderBinding {
                loader_id: "dahm".to_string(),
                modworkshop_ids: vec![14267],
            },
        ],
        targets: vec![
            Target {
                tag: "mods".to_string(),
                label_key: "mods".to_string(),
                unit: Unit::Directory {
                    // base.lua is the DAHM mod-framework entry point. It is in entry_markers
                    // so DAHM sub-mod ZIPs classify correctly during install, and in
                    // index_gated_markers so base.lua-only directories ARE discovered by the
                    // scan but tracked only when their SHA256 matches the mod index. That
                    // match is the reliable way to tell user-installed sub-mods from DAHM's
                    // own framework.
                    entry_markers: owned(&["mod.txt", "base.lua"]),
                    scan_markers: owned(&["mod.txt"]),
                    index_gated_markers: owned(&["base.lua"]),
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
