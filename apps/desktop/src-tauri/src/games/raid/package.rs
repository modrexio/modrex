use crate::games::package::{
    EnabledStateMechanism, GamePackage, Installation, SignalSource, SteamStore, Target, Unit,
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
//
// The excluded names are the BLT and Diesel infrastructure dirs the loader creates under
// mods/ that are never user mods: base (the SuperBLT basemod) plus the downloads, logs and
// saves runtime dirs BLT and BeardLib recreate on every launch. This mirrors
// RAIDWW2-BeardLib's own _ignore_folders list (Classes/Frameworks.lua), verified against a
// real install. On a blanket-accept target this list is what keeps them out of the mod scan,
// and it is also what stops launch_without_mods, which moves folders regardless of markers,
// backing them up and then failing to restore them once the loader recreates them. BeardLib
// itself is deliberately omitted: it is a normal installable mod page (id 49760), tracked
// like any other mod.
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
        targets: vec![Target {
            tag: "mods".to_string(),
            label_key: "mods".to_string(),
            unit: Unit::Directory {
                entry_markers: Vec::new(),
                scan_markers: Vec::new(),
                index_gated_markers: Vec::new(),
                excluded_names: owned(&["base", "downloads", "logs", "saves"]),
                priority_prefix: false,
            },
            enabled_state: EnabledStateMechanism::Filesystem,
            mods_subpath: owned(&["mods"]),
            disabled_subpath: owned(&["mods", "disabled"]),
            backup_subpath: owned(&["mods.bak"]),
        }],
    }
}
