use super::package::{EnabledStateMechanism, GamePackage, SignalSource, Unit};

fn raid() -> GamePackage {
    super::discovered()
        .into_iter()
        .find(|(directory, _)| *directory == "raid")
        .expect("raid is discovered")
        .1
}

#[test]
fn every_discovered_package_round_trips_through_json() {
    for (directory, pkg) in super::discovered() {
        let json = serde_json::to_string(&pkg).expect("package serializes");
        let restored: GamePackage = serde_json::from_str(&json).expect("package deserializes");
        assert_eq!(restored, pkg, "{directory}");
    }
}

#[test]
fn an_unknown_package_field_is_rejected() {
    let mut value = serde_json::to_value(raid()).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .insert("mystery".to_string(), serde_json::Value::Bool(true));
    let err = serde_json::from_value::<GamePackage>(value)
        .expect_err("unknown fields are rejected")
        .to_string();
    assert!(err.contains("mystery"), "{err}");
}

#[test]
fn an_unknown_target_field_is_rejected() {
    let mut value = serde_json::to_value(raid()).unwrap();
    value["targets"][0]
        .as_object_mut()
        .unwrap()
        .insert("mystery".to_string(), serde_json::Value::Bool(true));
    let err = serde_json::from_value::<GamePackage>(value)
        .expect_err("unknown fields are rejected")
        .to_string();
    assert!(err.contains("mystery"), "{err}");
}

#[test]
fn the_raid_package_declares_its_identity() {
    let pkg = raid();
    assert_eq!(pkg.id, "raid");
    assert_eq!(pkg.display_name, "RAID: World War II");
    assert_eq!(pkg.index_game_name, "RAID: World War II");
    assert_eq!(pkg.state_filename, ".modrex.json");
    assert_eq!(pkg.signals, SignalSource::Diesel);
}

#[test]
fn the_raid_package_installs_from_steam_only() {
    let installation = raid().installation;
    assert_eq!(installation.executables, ["raid_win64_release.exe"]);
    assert_eq!(installation.process_names, ["raid_win64_release"]);
    let steam = installation.steam.expect("raid ships on steam");
    assert_eq!(steam.app_id, 414740);
    assert_eq!(steam.folder_name, "RAID World War II");
    assert!(installation.epic.is_none());
    assert!(installation.xbox.is_none());
}

#[test]
fn the_raid_package_has_one_blanket_accept_target() {
    let pkg = raid();
    assert_eq!(pkg.targets.len(), 1);
    let target = &pkg.targets[0];
    assert_eq!(target.tag, "mods");
    assert_eq!(target.label_key, "mods");
    assert_eq!(target.enabled_state, EnabledStateMechanism::Filesystem);
    assert_eq!(target.mods_subpath, ["mods"]);
    assert_eq!(target.disabled_subpath, ["mods", "disabled"]);
    assert_eq!(target.backup_subpath, ["mods.bak"]);

    let Unit::Directory {
        entry_markers,
        scan_markers,
        index_gated_markers,
        excluded_names,
        priority_prefix,
    } = &target.unit
    else {
        panic!("raid installs mods as directories");
    };
    assert!(entry_markers.is_empty());
    assert!(scan_markers.is_empty());
    assert!(index_gated_markers.is_empty());
    assert_eq!(*excluded_names, ["base", "downloads", "logs", "saves"]);
    assert!(!priority_prefix);
}
