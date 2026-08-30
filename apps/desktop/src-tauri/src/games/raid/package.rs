use crate::game_package::{
    EnabledStateMechanism, GamePackage, Installation, LoaderBinding, SignalSource, SteamStore,
    Target, Unit, DIESEL_INFRA_FOLDERS,
};

fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

// RAID's modern loader (RAID-SuperBLT plus RAIDWW2-BeardLib) loads BLT script mods AND asset
// override packs from a single mods/<name>/ folder. The game's assets/mod_overrides mount is
// gone (current builds show a "MOD OVERRIDES IS NO LONGER USED" migration dialog, and
// BeardLib's FindOverrides scans each mods/<name>/ folder for override content such as
// soundbanks/, guis/ and units/ instead). So RAID has one blanket-accept target: every folder
// in mods/ is a user mod unless it is excluded by name. Markers are unusable here because
// asset packs carry no supermod.xml or mod.xml. Identification still reads those embedded ids
// when present (embedded_modworkshop_id) and otherwise falls back to SHA256 then name.
pub fn package() -> GamePackage {
    GamePackage {
        id: "raid".to_string(),
        display_name: "RAID: World War II".to_string(),
        index_game_name: "RAID: World War II".to_string(),
        state_filename: ".modrex.json".to_string(),
        signals: SignalSource::Diesel,
        installation: Installation {
            executables: owned(&["raid_win64_release.exe"]),
            process_names: owned(&["raid_win64_release"]),
            steam: Some(SteamStore {
                app_id: 414740,
                folder_name: "RAID World War II".to_string(),
            }),
            epic: None,
            xbox: None,
        },
        loaders: vec![LoaderBinding {
            loader_id: "raid_superblt".to_string(),
            modworkshop_ids: vec![49744],
            config: None,
        }],
        targets: vec![Target {
            tag: "mods".to_string(),
            label_key: "mods".to_string(),
            unit: Unit::Directory {
                entry_markers: Vec::new(),
                scan_markers: Vec::new(),
                index_gated_markers: Vec::new(),
                excluded_names: owned(DIESEL_INFRA_FOLDERS),
                priority_prefix: false,
            },
            enabled_state: EnabledStateMechanism::Filesystem,
            mods_subpath: owned(&["mods"]),
            disabled_subpath: owned(&["mods", "disabled"]),
            backup_subpath: owned(&["mods.bak"]),
        }],
    }
}
