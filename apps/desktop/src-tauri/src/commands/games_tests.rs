use super::*;
use crate::commands::mods::{backup_dir, disabled_dir, get_state_path, mods_dir, ModUnit};
use crate::game_package::{Activation, ModMetadata, DIESEL_INFRA_FOLDERS, UE4SS_BUNDLED_SUBMODS};
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
fn a_discovered_spec_resolves_its_package() {
    for (_, pkg) in crate::games::discovered() {
        let spec = game_spec(&pkg.id).expect("discovered package is registered");
        assert_eq!(spec.id, pkg.id);
        assert_eq!(spec.engine.game_id, pkg.id);
        assert_eq!(spec.engine.index_game_name, pkg.name);
        assert_eq!(spec.engine.mod_metadata, pkg.mod_metadata);
        assert_eq!(spec.def.name, pkg.name);
        assert_eq!(owned(spec.def.executables), pkg.install.executables);
        assert_eq!(owned(spec.def.process_names), pkg.install.processes);

        for store in &pkg.install.stores {
            match store {
                package::StoreBinding::Steam { app_id, folder } => {
                    let resolved = spec.def.steam.as_ref().expect("steam store resolved");
                    assert_eq!(
                        (resolved.app_id, resolved.folder_name),
                        (*app_id, folder.as_str())
                    );
                }
                package::StoreBinding::Epic { name } => {
                    let resolved = spec.def.epic.as_ref().expect("epic store resolved");
                    assert_eq!(resolved.display_name, name);
                }
                package::StoreBinding::Xbox {
                    product_id,
                    executable,
                } => {
                    let resolved = spec.def.xbox.as_ref().expect("xbox store resolved");
                    assert_eq!(
                        (resolved.product_id, resolved.executable),
                        (product_id.as_str(), executable.as_str())
                    );
                }
            }
        }
        assert_eq!(
            spec.def.steam.is_some(),
            pkg.install.stores.iter().any(|s| s.provider() == "steam"),
            "{} steam",
            pkg.id
        );
        assert_eq!(
            spec.def.epic.is_some(),
            pkg.install.stores.iter().any(|s| s.provider() == "epic"),
            "{} epic",
            pkg.id
        );
        assert_eq!(
            spec.def.xbox.is_some(),
            pkg.install.stores.iter().any(|s| s.provider() == "xbox"),
            "{} xbox",
            pkg.id
        );

        assert_eq!(spec.engine.targets.len(), pkg.targets.len());
        for (target, declared) in spec.engine.targets.iter().zip(&pkg.targets) {
            assert_eq!(target.tag, declared.tag);
            assert_eq!(target.label_key, declared.label.key());
            assert_eq!(target.enabled_state, declared.activation);
            assert_eq!(owned(target.mods_subpath), declared.path);
            assert_eq!(owned(target.backup_subpath), declared.backup);

            // The disabled folder is always the target plus one component, never declared.
            let mut expected_disabled = declared.path.clone();
            expected_disabled.push("disabled".to_string());
            assert_eq!(owned(target.disabled_subpath), expected_disabled);

            assert_eq!(
                target.priority_prefix_enabled(),
                declared.load_order == package::LoadOrder::FilenamePrefix
            );

            match (&target.unit, &declared.unit) {
                (
                    ModUnit::File {
                        extension,
                        disabled_suffix,
                        ..
                    },
                    package::Unit::File {
                        family,
                        disabled_suffix: declared_suffix,
                    },
                ) => {
                    assert_eq!(*extension, family.extension);
                    assert_eq!(disabled_suffix, declared_suffix);
                    assert_eq!(owned(target.companions), family.companions);
                }
                (
                    ModUnit::Directory {
                        entry_markers,
                        scan_markers,
                        index_gated_markers,
                        excluded_names,
                        ..
                    },
                    package::Unit::Directory {
                        discovery,
                        ignore_preset,
                        contains,
                    },
                ) => {
                    // Each rule lands in the flat list of every mode it names, and an
                    // all_directories policy contributes none, which is what makes the scan
                    // accept every folder.
                    let of_mode = |wanted: package::MarkerMode| -> Vec<String> {
                        match discovery {
                            package::Discovery::AllDirectories => Vec::new(),
                            package::Discovery::Markers { markers } => markers
                                .iter()
                                .filter(|rule| rule.modes.contains(&wanted))
                                .map(|rule| rule.file.clone())
                                .collect(),
                        }
                    };
                    assert_eq!(owned(entry_markers), of_mode(package::MarkerMode::Archive));
                    assert_eq!(owned(scan_markers), of_mode(package::MarkerMode::Scan));
                    assert_eq!(
                        owned(index_gated_markers),
                        of_mode(package::MarkerMode::IndexGated)
                    );
                    assert_eq!(
                        owned(excluded_names),
                        ignore_preset
                            .map(package::NamePreset::names)
                            .unwrap_or_default()
                            .iter()
                            .map(|name| name.to_string())
                            .collect::<Vec<_>>()
                    );
                    assert_eq!(
                        owned(target.companions),
                        contains
                            .as_ref()
                            .map(|family| family.companions.clone())
                            .unwrap_or_default()
                    );
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
    assert_eq!(modkit.enabled_state, Activation::Filesystem);
    assert!(!modkit.priority_prefix_enabled());

    let paks = cfg.target_for(Some("paks"));
    assert_eq!(paks.tag, "paks");
    assert!(!paks.is_directory_unit());
    assert_eq!(paks.disabled_suffix(), ".disabled");
    assert!(paks.priority_prefix_enabled());
    assert_eq!(paks.enabled_state, Activation::Filesystem);

    let ue4ss = cfg.target_for(Some("ue4ss_mods"));
    assert_eq!(ue4ss.tag, "ue4ss_mods");
    assert!(ue4ss.is_directory_unit());
    assert_eq!(ue4ss.enabled_state, Activation::Ue4ssModsTxt);
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
    assert_eq!(spec.engine.mod_metadata, ModMetadata::None);
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
    assert_eq!(mods.enabled_state, Activation::Filesystem);
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
    assert_eq!(spec.engine.mod_metadata, ModMetadata::Diesel);
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
    assert_eq!(mods.enabled_state, Activation::Filesystem);
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
    assert_eq!(spec.engine.mod_metadata, ModMetadata::Diesel);
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
    assert_eq!(paks.enabled_state, Activation::Filesystem);

    let ue4ss = cfg.target_for(Some("ue4ss_mods"));
    assert_eq!(ue4ss.tag, "ue4ss_mods");
    assert!(ue4ss.is_directory_unit());
    assert_eq!(ue4ss.disabled_suffix(), "");
    assert!(!ue4ss.priority_prefix_enabled());
    assert_eq!(ue4ss.enabled_state, Activation::Ue4ssModsTxt);
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
    assert_eq!(spec.engine.mod_metadata, ModMetadata::None);
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
    assert_eq!(spec.engine.mod_metadata, ModMetadata::Diesel);
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

#[test]
fn a_spec_borrows_the_package_reader_its_package_declares() {
    for (_, pkg) in crate::games::discovered() {
        let spec = game_spec(&pkg.id).expect("discovered package is registered");
        match (spec.package_reader, pkg.package_reader.as_ref()) {
            (Some(resolved), Some(declared)) => assert!(std::ptr::eq(resolved, declared)),
            (None, None) => {}
            _ => panic!("{} disagrees with its package about the viewer", pkg.id),
        }
    }
}

#[test]
fn every_declared_package_key_is_aes_256_hex() {
    for spec in GAME_REGISTRY.iter() {
        let Some(package::PackageReaderBinding::Unreal { aes_key }) = spec.package_reader else {
            continue;
        };
        assert_eq!(aes_key.len(), 64, "{}", spec.id);
        assert!(
            aes_key.bytes().all(|b| b.is_ascii_hexdigit()),
            "{}",
            spec.id
        );
    }
}

/// The viewer is offered exactly where a package declares a reader, so no game can reach
/// another game's key and a game that declares none has nothing to fall back to.
#[test]
fn viewer_support_follows_the_declaration_rather_than_the_game_id() {
    let declaring: Vec<&str> = crate::games::discovered()
        .iter()
        .filter(|(_, pkg)| pkg.package_reader.is_some())
        .map(|(_, pkg)| pkg.id.as_str())
        .collect();
    let resolving: Vec<&str> = GAME_REGISTRY
        .iter()
        .filter(|spec| spec.package_reader.is_some())
        .map(|spec| spec.id)
        .collect();
    assert_eq!(declaring, resolving);

    let mut keys: Vec<&str> = GAME_REGISTRY
        .iter()
        .filter_map(|spec| spec.package_reader.map(|reader| reader.aes_key()))
        .collect();
    let total = keys.len();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), total, "two games share one package key");
}
