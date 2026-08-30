use super::*;
use crate::commands::mods::{backup_dir, disabled_dir, get_state_path, mods_dir, ModUnit};
use crate::game_package::{
    EnabledStateMechanism, SignalSource, DIESEL_INFRA_FOLDERS, UE4SS_BUNDLED_SUBMODS,
};
use std::path::PathBuf;
use tempfile::TempDir;

fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

fn discovered_ids() -> Vec<String> {
    crate::games::discovered()
        .iter()
        .map(|(directory, _)| directory.to_string())
        .collect()
}

#[test]
fn spec_ids_match_their_engine_game_ids() {
    for spec in GAME_REGISTRY.iter() {
        assert_eq!(spec.id, spec.engine.game_id);
    }
}

#[test]
fn spec_ids_are_unique() {
    let mut ids: Vec<&str> = GAME_REGISTRY.iter().map(|s| s.id).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), GAME_REGISTRY.len());
}

#[test]
fn every_registered_game_is_reachable_by_its_own_id() {
    for spec in GAME_REGISTRY.iter() {
        let found = game_spec(spec.id).expect("registered id resolves");
        assert!(std::ptr::eq(found, spec), "{}", spec.id);
    }
}

#[test]
fn a_package_directory_name_matches_the_package_it_holds() {
    for (directory, pkg) in crate::games::discovered() {
        assert_eq!(*directory, pkg.id);
    }
}

#[test]
fn the_registry_is_exactly_the_discovered_packages_in_a_stable_order() {
    let ids: Vec<&str> = GAME_REGISTRY.iter().map(|s| s.id).collect();
    assert_eq!(
        ids,
        discovered_ids()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
    );
    let again: Vec<&str> = GAME_REGISTRY.iter().map(|s| s.id).collect();
    assert_eq!(ids, again);
}

#[test]
fn a_discovered_spec_carries_its_package_verbatim() {
    for (_, pkg) in crate::games::discovered() {
        let spec = game_spec(&pkg.id).expect("discovered package is registered");
        assert_eq!(spec.id, pkg.id);
        assert_eq!(spec.engine.game_id, pkg.id);
        assert_eq!(spec.engine.index_game_name, pkg.index_game_name);
        assert_eq!(spec.engine.state_filename, pkg.state_filename);
        assert_eq!(spec.engine.signals, pkg.signals);
        assert_eq!(spec.def.name, pkg.display_name);
        assert_eq!(owned(spec.def.executables), pkg.installation.executables);
        assert_eq!(
            owned(spec.def.process_names),
            pkg.installation.process_names
        );
        assert_eq!(
            spec.def.steam.as_ref().map(|s| (s.app_id, s.folder_name)),
            pkg.installation
                .steam
                .as_ref()
                .map(|s| (s.app_id, s.folder_name.as_str()))
        );
        assert_eq!(
            spec.def.epic.as_ref().map(|e| e.display_name),
            pkg.installation
                .epic
                .as_ref()
                .map(|e| e.display_name.as_str())
        );
        assert_eq!(
            spec.def.xbox.as_ref().map(|x| (x.product_id, x.executable)),
            pkg.installation
                .xbox
                .as_ref()
                .map(|x| (x.product_id.as_str(), x.executable.as_str()))
        );

        assert_eq!(spec.engine.targets.len(), pkg.targets.len());
        for (target, declared) in spec.engine.targets.iter().zip(&pkg.targets) {
            assert_eq!(target.tag, declared.tag);
            assert_eq!(target.label_key, declared.label_key);
            assert_eq!(target.enabled_state, declared.enabled_state);
            assert_eq!(owned(target.mods_subpath), declared.mods_subpath);
            assert_eq!(owned(target.disabled_subpath), declared.disabled_subpath);
            assert_eq!(owned(target.backup_subpath), declared.backup_subpath);
            match (&target.unit, &declared.unit) {
                (
                    ModUnit::File {
                        extension,
                        disabled_suffix,
                        priority_prefix,
                    },
                    package::Unit::File {
                        extension: declared_extension,
                        disabled_suffix: declared_suffix,
                        priority_prefix: declared_prefix,
                    },
                ) => {
                    assert_eq!(extension, declared_extension);
                    assert_eq!(disabled_suffix, declared_suffix);
                    assert_eq!(priority_prefix, declared_prefix);
                }
                (
                    ModUnit::Directory {
                        entry_markers,
                        scan_markers,
                        index_gated_markers,
                        excluded_names,
                        priority_prefix,
                    },
                    package::Unit::Directory {
                        entry_markers: declared_entry,
                        scan_markers: declared_scan,
                        index_gated_markers: declared_gated,
                        excluded_names: declared_excluded,
                        priority_prefix: declared_prefix,
                    },
                ) => {
                    assert_eq!(owned(entry_markers), *declared_entry);
                    assert_eq!(owned(scan_markers), *declared_scan);
                    assert_eq!(owned(index_gated_markers), *declared_gated);
                    assert_eq!(owned(excluded_names), *declared_excluded);
                    assert_eq!(priority_prefix, declared_prefix);
                }
                _ => panic!("{} target {} changed unit kind", pkg.id, target.tag),
            }
        }
    }
}

#[test]
fn cb_resolves_all_three_of_its_mod_targets() {
    let cfg = crate::commands::mods::engine_for_game("cb").unwrap();
    assert_eq!(cfg.targets.len(), 3);

    let modkit = cfg.primary();
    assert_eq!(modkit.tag, "mods");
    assert!(std::ptr::eq(cfg.target_for(None), modkit));
    assert!(std::ptr::eq(cfg.target_for(Some("mods")), modkit));
    assert!(modkit.is_directory_unit());
    assert_eq!(modkit.enabled_state, EnabledStateMechanism::Filesystem);
    assert!(!modkit.priority_prefix_enabled());

    let paks = cfg.target_for(Some("paks"));
    assert_eq!(paks.tag, "paks");
    assert!(!paks.is_directory_unit());
    assert_eq!(paks.disabled_suffix(), ".disabled");
    assert!(paks.priority_prefix_enabled());
    assert_eq!(paks.enabled_state, EnabledStateMechanism::Filesystem);

    let ue4ss = cfg.target_for(Some("ue4ss_mods"));
    assert_eq!(ue4ss.tag, "ue4ss_mods");
    assert!(ue4ss.is_directory_unit());
    assert_eq!(ue4ss.enabled_state, EnabledStateMechanism::Ue4ssModsTxt);
    assert_eq!(ue4ss.excluded_names(), UE4SS_BUNDLED_SUBMODS);

    let game = "C:/Games/Crime Boss";
    let root = PathBuf::from(game);
    assert_eq!(mods_dir(game, modkit), root.join("CrimeBoss/Mods"));
    assert_eq!(
        disabled_dir(game, modkit),
        root.join("CrimeBoss/Mods/disabled")
    );
    assert_eq!(backup_dir(game, modkit), root.join("CrimeBoss/Mods.bak"));
    assert_eq!(
        mods_dir(game, paks),
        root.join("CrimeBoss/Content/Paks/~mods")
    );
    assert_eq!(
        backup_dir(game, paks),
        root.join("CrimeBoss/Content/~mods.bak")
    );
    assert_eq!(
        mods_dir(game, ue4ss),
        root.join("CrimeBoss/Binaries/Win64/Mods")
    );
    assert_eq!(
        backup_dir(game, ue4ss),
        root.join("CrimeBoss/Binaries/Win64/Mods.bak")
    );
    assert_eq!(
        get_state_path(game, cfg),
        root.join("CrimeBoss/Mods/.modrex.json")
    );
}

#[test]
fn cb_keeps_its_launch_and_storefront_metadata() {
    let spec = game_spec("cb").expect("cb resolves");
    assert_eq!(spec.engine.index_game_name, "Crime Boss: Rockay City");
    assert_eq!(spec.engine.signals, SignalSource::None);
    assert_eq!(spec.def.name, "Crime Boss: Rockay City");
    assert_eq!(spec.def.executables, ["CrimeBoss.exe"]);
    assert_eq!(spec.def.process_names, ["CrimeBoss-Win64-Shipping"]);
    let steam = spec.def.steam.as_ref().expect("cb ships on steam");
    assert_eq!(steam.app_id, 2933080);
    assert_eq!(steam.folder_name, "CrimeBossRockayCity");
    let epic = spec.def.epic.as_ref().expect("cb ships on epic");
    assert_eq!(epic.display_name, "Crime Boss: Rockay City");
    assert!(spec.def.xbox.is_none());
}

#[test]
fn cb_recognises_an_install_by_its_executable() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().to_str().unwrap();
    let def = game_spec("cb").unwrap().def;
    assert!(!def.is_installation(path));
    std::fs::write(dir.path().join("CrimeBoss.exe"), b"").unwrap();
    assert_eq!(def.resolve_executable(path), Some("CrimeBoss.exe"));
    assert!(def.is_installation(path));
}

#[test]
fn pd2_resolves_both_of_its_mod_targets() {
    let cfg = crate::commands::mods::engine_for_game("pd2").unwrap();
    assert_eq!(cfg.targets.len(), 2);

    let mods = cfg.primary();
    assert_eq!(mods.tag, "mods");
    assert!(std::ptr::eq(cfg.target_for(None), mods));
    assert!(std::ptr::eq(cfg.target_for(Some("mods")), mods));
    assert!(mods.is_directory_unit());
    assert_eq!(mods.disabled_suffix(), "");
    assert!(!mods.priority_prefix_enabled());
    assert_eq!(mods.enabled_state, EnabledStateMechanism::Filesystem);
    assert_eq!(mods.excluded_names(), DIESEL_INFRA_FOLDERS);

    let overrides = cfg.target_for(Some("mod_overrides"));
    assert_eq!(overrides.tag, "mod_overrides");
    assert!(overrides.is_directory_unit());
    assert!(overrides.excluded_names().is_empty());

    let game = "C:/Games/PAYDAY 2";
    let root = PathBuf::from(game);
    assert_eq!(mods_dir(game, mods), root.join("mods"));
    assert_eq!(disabled_dir(game, mods), root.join("mods/disabled"));
    assert_eq!(backup_dir(game, mods), root.join("mods.bak"));
    assert_eq!(mods_dir(game, overrides), root.join("assets/mod_overrides"));
    assert_eq!(
        disabled_dir(game, overrides),
        root.join("assets/mod_overrides/disabled")
    );
    assert_eq!(
        backup_dir(game, overrides),
        root.join("assets/mod_overrides.bak")
    );
    assert_eq!(get_state_path(game, cfg), root.join("mods/.modrex.json"));
}

#[test]
fn pd2_keeps_its_launch_and_storefront_metadata() {
    let spec = game_spec("pd2").expect("pd2 resolves");
    assert_eq!(spec.engine.index_game_name, "PAYDAY 2");
    assert_eq!(spec.engine.signals, SignalSource::Diesel);
    assert_eq!(spec.def.name, "PAYDAY 2");
    assert_eq!(
        spec.def.executables,
        ["PAYDAY2.exe", "payday2_win32_release.exe"]
    );
    assert_eq!(spec.def.process_names, ["PAYDAY2", "payday2_win32_release"]);
    let steam = spec.def.steam.as_ref().expect("pd2 ships on steam");
    assert_eq!(steam.app_id, 218620);
    assert_eq!(steam.folder_name, "PAYDAY 2");
    let epic = spec.def.epic.as_ref().expect("pd2 ships on epic");
    assert_eq!(epic.display_name, "PAYDAY 2");
    assert!(spec.def.xbox.is_none());
}

#[test]
fn pd2_recognises_an_install_by_either_executable() {
    let def = game_spec("pd2").unwrap().def;
    for exe in ["PAYDAY2.exe", "payday2_win32_release.exe"] {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_str().unwrap();
        assert!(!def.is_installation(path));
        std::fs::write(dir.path().join(exe), b"").unwrap();
        assert_eq!(def.resolve_executable(path), Some(exe));
        assert!(def.is_installation(path));
    }
}

#[test]
fn pdth_resolves_both_of_its_mod_targets() {
    let cfg = crate::commands::mods::engine_for_game("pdth").unwrap();
    assert_eq!(cfg.targets.len(), 2);

    let mods = cfg.primary();
    assert_eq!(mods.tag, "mods");
    assert!(std::ptr::eq(cfg.target_for(None), mods));
    assert!(std::ptr::eq(cfg.target_for(Some("mods")), mods));
    assert!(mods.is_directory_unit());
    assert_eq!(mods.enabled_state, EnabledStateMechanism::Filesystem);
    assert_eq!(mods.excluded_names(), DIESEL_INFRA_FOLDERS);

    let ModUnit::Directory {
        entry_markers,
        scan_markers,
        index_gated_markers,
        ..
    } = &mods.unit
    else {
        panic!("pdth installs mods as directories");
    };
    assert_eq!(*entry_markers, ["mod.txt", "base.lua"]);
    assert_eq!(*scan_markers, ["mod.txt"]);
    assert_eq!(*index_gated_markers, ["base.lua"]);

    let overrides = cfg.target_for(Some("mod_overrides"));
    assert_eq!(overrides.tag, "mod_overrides");
    assert!(overrides.is_directory_unit());
    assert!(overrides.excluded_names().is_empty());

    let game = "C:/Games/PAYDAY The Heist";
    let root = PathBuf::from(game);
    assert_eq!(mods_dir(game, mods), root.join("mods"));
    assert_eq!(disabled_dir(game, mods), root.join("mods/disabled"));
    assert_eq!(backup_dir(game, mods), root.join("mods.bak"));
    assert_eq!(mods_dir(game, overrides), root.join("assets/mod_overrides"));
    assert_eq!(
        backup_dir(game, overrides),
        root.join("assets/mod_overrides.bak")
    );
    assert_eq!(get_state_path(game, cfg), root.join("mods/.modrex.json"));
}

#[test]
fn pdth_keeps_its_launch_and_storefront_metadata() {
    let spec = game_spec("pdth").expect("pdth resolves");
    assert_eq!(spec.engine.index_game_name, "PAYDAY: The Heist");
    assert_eq!(spec.engine.signals, SignalSource::Diesel);
    assert_eq!(spec.def.name, "PAYDAY: The Heist");
    assert_eq!(spec.def.executables, ["payday_win32_release.exe"]);
    assert_eq!(spec.def.process_names, ["payday_win32_release"]);
    let steam = spec.def.steam.as_ref().expect("pdth ships on steam");
    assert_eq!(steam.app_id, 24240);
    assert_eq!(steam.folder_name, "PAYDAY The Heist");
    assert!(spec.def.epic.is_none());
    assert!(spec.def.xbox.is_none());
}

#[test]
fn pdth_recognises_an_install_by_its_executable() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().to_str().unwrap();
    let def = game_spec("pdth").unwrap().def;
    assert!(!def.is_installation(path));
    std::fs::write(dir.path().join("payday_win32_release.exe"), b"").unwrap();
    assert_eq!(
        def.resolve_executable(path),
        Some("payday_win32_release.exe")
    );
    assert!(def.is_installation(path));
}

#[test]
fn pd3_resolves_both_of_its_mod_targets() {
    let cfg = crate::commands::mods::engine_for_game("pd3").unwrap();
    assert_eq!(cfg.targets.len(), 2);

    let paks = cfg.primary();
    assert_eq!(paks.tag, "paks");
    assert!(std::ptr::eq(cfg.target_for(None), paks));
    assert!(std::ptr::eq(cfg.target_for(Some("paks")), paks));
    assert!(!paks.is_directory_unit());
    assert_eq!(paks.disabled_suffix(), ".disabled");
    assert!(paks.priority_prefix_enabled());
    assert_eq!(paks.enabled_state, EnabledStateMechanism::Filesystem);

    let ue4ss = cfg.target_for(Some("ue4ss_mods"));
    assert_eq!(ue4ss.tag, "ue4ss_mods");
    assert!(ue4ss.is_directory_unit());
    assert_eq!(ue4ss.disabled_suffix(), "");
    assert!(!ue4ss.priority_prefix_enabled());
    assert_eq!(ue4ss.enabled_state, EnabledStateMechanism::Ue4ssModsTxt);
    assert_eq!(ue4ss.excluded_names(), UE4SS_BUNDLED_SUBMODS);

    let game = "C:/Games/PAYDAY 3";
    let root = PathBuf::from(game);
    assert_eq!(
        mods_dir(game, paks),
        root.join("PAYDAY3/Content/Paks/~mods")
    );
    assert_eq!(
        disabled_dir(game, paks),
        root.join("PAYDAY3/Content/Paks/~mods/disabled")
    );
    assert_eq!(
        backup_dir(game, paks),
        root.join("PAYDAY3/Content/~mods.bak")
    );
    assert_eq!(
        mods_dir(game, ue4ss),
        root.join("PAYDAY3/Binaries/Win64/Mods")
    );
    assert_eq!(
        disabled_dir(game, ue4ss),
        root.join("PAYDAY3/Binaries/Win64/Mods/disabled")
    );
    assert_eq!(
        backup_dir(game, ue4ss),
        root.join("PAYDAY3/Binaries/Win64/Mods.bak")
    );
    assert_eq!(
        get_state_path(game, cfg),
        root.join("PAYDAY3/Content/Paks/~mods/.modrex.json")
    );
}

#[test]
fn pd3_keeps_its_launch_and_storefront_metadata() {
    let spec = game_spec("pd3").expect("pd3 resolves");
    assert_eq!(spec.engine.index_game_name, "PAYDAY 3");
    assert_eq!(spec.engine.signals, SignalSource::None);
    assert_eq!(spec.def.name, "PAYDAY 3");
    assert_eq!(spec.def.executables, ["PAYDAY3.exe"]);
    assert_eq!(spec.def.process_names, ["PAYDAY3-Win64-Shipping"]);

    let steam = spec.def.steam.as_ref().expect("pd3 ships on steam");
    assert_eq!(steam.app_id, 1272080);
    assert_eq!(steam.folder_name, "PAYDAY3");
    let epic = spec.def.epic.as_ref().expect("pd3 ships on epic");
    assert_eq!(epic.display_name, "PAYDAY 3");
    let xbox = spec.def.xbox.as_ref().expect("pd3 ships on xbox");
    assert_eq!(xbox.product_id, "9NPZVDCH73SX");
    assert_eq!(
        xbox.executable,
        "PAYDAY3/Binaries/WinGDK/PAYDAY3-WinGDK-Shipping.exe"
    );
}

/// The Microsoft Store build ships no Win64 bootstrapper, so recognising an install must not
/// depend on the launchable executable alone.
#[test]
fn pd3_recognises_both_its_win64_and_store_builds() {
    let def = game_spec("pd3").unwrap().def;

    let win64 = TempDir::new().unwrap();
    let win64_path = win64.path().to_str().unwrap();
    assert!(!def.is_installation(win64_path));
    std::fs::write(win64.path().join("PAYDAY3.exe"), b"").unwrap();
    assert_eq!(def.resolve_executable(win64_path), Some("PAYDAY3.exe"));
    assert!(def.is_installation(win64_path));

    let store = TempDir::new().unwrap();
    let store_path = store.path().to_str().unwrap();
    let staged = store.path().join("PAYDAY3/Binaries/WinGDK");
    std::fs::create_dir_all(&staged).unwrap();
    std::fs::write(staged.join("PAYDAY3-WinGDK-Shipping.exe"), b"").unwrap();
    assert_eq!(def.resolve_executable(store_path), None);
    assert!(def.is_installation(store_path));
}

#[test]
fn raid_resolves_the_paths_its_loader_reads() {
    let cfg = crate::commands::mods::engine_for_game("raid").unwrap();
    assert_eq!(cfg.targets.len(), 1);
    let target = cfg.primary();
    assert_eq!(target.tag, "mods");
    assert!(std::ptr::eq(cfg.target_for(None), target));
    assert!(std::ptr::eq(cfg.target_for(Some("mods")), target));
    assert!(std::ptr::eq(cfg.target_for(Some("unknown")), target));

    let game = "C:/Games/RAID";
    let root = PathBuf::from(game);
    assert_eq!(mods_dir(game, target), root.join("mods"));
    assert_eq!(
        disabled_dir(game, target),
        root.join("mods").join("disabled")
    );
    assert_eq!(backup_dir(game, target), root.join("mods.bak"));
    assert_eq!(
        get_state_path(game, cfg),
        root.join("mods").join(".modrex.json")
    );

    assert!(target.is_directory_unit());
    assert_eq!(target.disabled_suffix(), "");
    assert!(!target.priority_prefix_enabled());
    assert_eq!(target.excluded_names(), DIESEL_INFRA_FOLDERS);
}

#[test]
fn raid_keeps_its_launch_and_storefront_metadata() {
    let spec = game_spec("raid").expect("raid resolves");
    assert_eq!(spec.engine.index_game_name, "RAID: World War II");
    assert_eq!(spec.engine.signals, SignalSource::Diesel);
    assert_eq!(spec.def.name, "RAID: World War II");
    assert_eq!(spec.def.executables, ["raid_win64_release.exe"]);
    assert_eq!(spec.def.process_names, ["raid_win64_release"]);
    let steam = spec.def.steam.as_ref().expect("raid ships on steam");
    assert_eq!(steam.app_id, 414740);
    assert_eq!(steam.folder_name, "RAID World War II");
    assert!(spec.def.epic.is_none());
    assert!(spec.def.xbox.is_none());
}

#[test]
fn raid_recognises_an_install_by_its_executable() {
    let dir = TempDir::new().unwrap();
    let game = dir.path().to_str().unwrap();
    let def = game_spec("raid").unwrap().def;
    assert!(!def.is_installation(game));
    assert_eq!(def.resolve_executable(game), None);

    std::fs::write(dir.path().join("raid_win64_release.exe"), b"").unwrap();
    assert_eq!(def.resolve_executable(game), Some("raid_win64_release.exe"));
    assert!(def.is_installation(game));
}
