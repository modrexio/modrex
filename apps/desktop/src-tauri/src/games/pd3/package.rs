use crate::game_package::{
    EnabledStateMechanism, EpicStore, GamePackage, Installation, SignalSource, SteamStore, Target,
    Unit, XboxStore, UE4SS_BUNDLED_SUBMODS,
};

fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

pub fn package() -> GamePackage {
    GamePackage {
        id: "pd3".to_string(),
        display_name: "PAYDAY 3".to_string(),
        index_game_name: "PAYDAY 3".to_string(),
        state_filename: ".modrex.json".to_string(),
        signals: SignalSource::None,
        installation: Installation {
            executables: owned(&["PAYDAY3.exe"]),
            process_names: owned(&["PAYDAY3-Win64-Shipping"]),
            steam: Some(SteamStore {
                app_id: 1272080,
                folder_name: "PAYDAY3".to_string(),
            }),
            epic: Some(EpicStore {
                display_name: "PAYDAY 3".to_string(),
            }),
            xbox: Some(XboxStore {
                product_id: "9NPZVDCH73SX".to_string(),
                executable: "PAYDAY3/Binaries/WinGDK/PAYDAY3-WinGDK-Shipping.exe".to_string(),
            }),
        },
        targets: vec![
            Target {
                tag: "paks".to_string(),
                label_key: "mods".to_string(),
                unit: Unit::File {
                    extension: "pak".to_string(),
                    disabled_suffix: ".disabled".to_string(),
                    priority_prefix: true,
                },
                enabled_state: EnabledStateMechanism::Filesystem,
                mods_subpath: owned(&["PAYDAY3", "Content", "Paks", "~mods"]),
                disabled_subpath: owned(&["PAYDAY3", "Content", "Paks", "~mods", "disabled"]),
                backup_subpath: owned(&["PAYDAY3", "Content", "~mods.bak"]),
            },
            // game_path already ends in PAYDAY3 (the Steam installdir). See ue4ss.rs's
            // descriptor comment for why this is not a second copy of it. Steam and Epic only.
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
                mods_subpath: owned(&["PAYDAY3", "Binaries", "Win64", "Mods"]),
                disabled_subpath: owned(&["PAYDAY3", "Binaries", "Win64", "Mods", "disabled"]),
                backup_subpath: owned(&["PAYDAY3", "Binaries", "Win64", "Mods.bak"]),
            },
        ],
    }
}
