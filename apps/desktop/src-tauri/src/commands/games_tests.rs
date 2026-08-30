use super::*;
use crate::commands::mods::{backup_dir, disabled_dir, get_state_path, mods_dir};
use crate::game_package::{SignalSource, DIESEL_INFRA_FOLDERS};
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
fn the_registry_lists_discovered_games_last_in_a_stable_order() {
    let ids: Vec<&str> = GAME_REGISTRY.iter().map(|s| s.id).collect();
    let discovered = discovered_ids();
    let split = ids.len() - discovered.len();
    assert_eq!(
        ids[split..].to_vec(),
        discovered.iter().map(String::as_str).collect::<Vec<_>>()
    );
    assert!(!ids[..split].is_empty(), "handwritten games still resolve");
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
