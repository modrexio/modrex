use super::*;
use crate::commands::mods::engine::{Activation, ModMetadata, ModUnit, SharedPaks};
use tempfile::TempDir;

const SHARED_TARGET: ScanTarget = ScanTarget {
    tag: "paks",
    label_key: "pakMods",
    label_name: None,
    shared_paks: Some(SharedPaks {
        steam_app: Some(78),
        epic_name: None,
    }),
    unit: ModUnit::File {
        extension: "pak",
        disabled_suffix: ".disabled",
        priority_prefix: false,
        keeps_archive_filename: true,
    },
    companions: &[],
    contained_extension: None,
    enabled_state: Activation::Filesystem,
    mods_subpath: &["Synthetic", "Content", "Paks"],
    disabled_subpath: &["Synthetic", "Content", "Paks", "disabled"],
    backup_subpath: &["Synthetic", "Content", "Paks.mods.bak"],
    store_layouts: &[],
};

fn config(targets: &'static [ScanTarget]) -> ModEngineConfig {
    ModEngineConfig {
        game_id: "shared-state-test",
        decoders: &[],
        index_game_name: "Synthetic Game",
        mod_metadata: ModMetadata::None,
        targets,
    }
}

fn folder(id: &str, parent: Option<&str>) -> ModFolder {
    ModFolder {
        id: id.into(),
        disk_name: id.into(),
        display_name: id.into(),
        priority: 1,
        parent_id: parent.map(String::from),
    }
}

fn manual_mod(folder_id: Option<&str>) -> InstalledMod {
    InstalledMod {
        uid: "manual".into(),
        filename: "Manual.pak".into(),
        folder_id: folder_id.map(String::from),
        enabled: true,
        ..InstalledMod::default()
    }
}

fn compaction_write_fixture(game_id: &str) -> (TempDir, PathBuf, &'static ModEngineConfig) {
    let cfg = super::super::engine::engine_for_game(game_id).unwrap();
    let temp = TempDir::new().unwrap();
    let game = temp.path().to_str().unwrap();
    let path = super::super::paths::get_state_path(game, cfg);
    let mut folders = vec![folder("A", None), folder("B", None)];
    for (index, folder) in folders.iter_mut().enumerate() {
        folder.priority = (index + 9) as i64;
        folder.disk_name = format!("{:03}_{}", folder.priority, folder.id);
        fs::create_dir_all(mods_base(game, cfg.primary()).join(&folder.disk_name)).unwrap();
    }
    save_state(
        &path,
        &ModsState {
            folders,
            mods: vec![],
        },
    )
    .unwrap();
    STATE_WRITES.with(|writes| writes.set(0));
    (temp, path, cfg)
}

#[test]
fn compaction_writes_only_its_folder_checkpoints_and_nothing_on_a_second_load() {
    let (temp, path, cfg) = compaction_write_fixture("pd3");
    let game = temp.path().to_str().unwrap();
    let state = reconcile_state(game, &path, cfg).unwrap();
    assert_eq!(state.folders[0].disk_name, "001_A");
    assert_eq!(state.folders[1].disk_name, "002_B");
    assert_eq!(
        STATE_WRITES.with(|writes| writes.get()),
        2,
        "two folder checkpoints need exactly two state writes"
    );
    STATE_WRITES.with(|writes| writes.set(0));
    reconcile_state(game, &path, cfg).unwrap();
    assert_eq!(
        STATE_WRITES.with(|writes| writes.get()),
        0,
        "a load without gaps must not write from compaction"
    );
}

#[test]
fn compaction_failed_rename_after_a_checkpoint_needs_no_extra_write() {
    let (temp, path, cfg) = compaction_write_fixture("pd3");
    let game = temp.path().to_str().unwrap();
    fs::create_dir_all(mods_base(game, cfg.primary()).join("002_B")).unwrap();
    let state = reconcile_state(game, &path, cfg).unwrap();
    assert_eq!(state.folders[0].disk_name, "001_A");
    assert_eq!(state.folders[1].disk_name, "010_B");
    assert_eq!(
        STATE_WRITES.with(|writes| writes.get()),
        1,
        "a rolled back rename leaves the checkpoint current"
    );
    assert!(mods_base(game, cfg.primary()).join("010_B").is_dir());
    assert_eq!(read_state(&path).unwrap().folders[1].disk_name, "010_B");
}

#[test]
fn compaction_without_filename_ordering_still_saves_metadata_once() {
    let (temp, path, cfg) = compaction_write_fixture("cb");
    let game = temp.path().to_str().unwrap();
    let state = reconcile_state(game, &path, cfg).unwrap();
    assert_eq!(state.folders[0].disk_name, "009_A");
    assert_eq!(state.folders[0].priority, 1);
    assert_eq!(read_state(&path).unwrap().folders[0].priority, 1);
    assert_eq!(STATE_WRITES.with(|writes| writes.get()), 1);
    STATE_WRITES.with(|writes| writes.set(0));
    reconcile_state(game, &path, cfg).unwrap();
    assert_eq!(STATE_WRITES.with(|writes| writes.get()), 0);
}

#[test]
fn compaction_metadata_after_a_checkpoint_still_needs_a_final_save() {
    static TARGETS: [ScanTarget; 1] = [ScanTarget {
        shared_paks: None,
        unit: ModUnit::Directory {
            entry_markers: &[],
            scan_markers: &[],
            index_gated_markers: &[],
            excluded_names: &[],
            priority_prefix: true,
            unreal_plugin: false,
        },
        ..SHARED_TARGET
    }];
    let cfg = config(&TARGETS);
    let temp = TempDir::new().unwrap();
    let game = temp.path().to_str().unwrap();
    let path = temp.path().join(STATE_FILENAME);
    let mut folders = vec![folder("A", None), folder("B", None)];
    for (index, folder) in folders.iter_mut().enumerate() {
        folder.priority = (index + 9) as i64;
        folder.disk_name = format!("{:03}_{}", folder.priority, folder.id);
        fs::create_dir_all(mods_base(game, cfg.primary()).join(&folder.disk_name)).unwrap();
    }
    let tracked = InstalledMod {
        id: -1,
        uid: "owned".into(),
        filename: "010_B".into(),
        enabled: true,
        priority: Some(1),
        ..InstalledMod::default()
    };
    save_state(
        &path,
        &ModsState {
            folders,
            mods: vec![tracked],
        },
    )
    .unwrap();
    STATE_WRITES.with(|writes| writes.set(0));
    let state = reconcile_state(game, &path, &cfg).unwrap();
    assert_eq!(STATE_WRITES.with(|writes| writes.get()), 2);
    assert_eq!(state.folders[0].disk_name, "001_A");
    assert_eq!(state.folders[1].disk_name, "010_B");
    assert_eq!(read_state(&path).unwrap().folders[1].priority, 2);
    assert!(mods_base(game, cfg.primary()).join("010_B").is_dir());
}

#[test]
fn shared_state_rejects_duplicate_missing_and_cyclic_folder_references() {
    static TARGETS: [ScanTarget; 1] = [SHARED_TARGET];
    let shared = config(&TARGETS);
    let temp = TempDir::new().unwrap();
    let path = temp.path().join(".modrex.json");
    let invalid = [
        (vec![folder("a", None), folder("a", None)], vec![]),
        (vec![folder("a", Some("missing"))], vec![]),
        (vec![folder("a", Some("a"))], vec![]),
        (vec![folder("a", Some("b")), folder("b", Some("a"))], vec![]),
        (vec![], vec![manual_mod(Some("missing"))]),
    ];
    for (folders, mods) in invalid {
        let bytes = serde_json::to_vec(&ModsState { folders, mods }).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(matches!(
            read_state_for_game(temp.path().to_str().unwrap(), &path, &shared),
            Err(StateLoadError::Invalid(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(!temporary_state_path(&path).exists());
    }
    let valid = ModsState {
        folders: vec![folder("child", Some("root")), folder("root", None)],
        mods: vec![manual_mod(Some("child"))],
    };
    fs::write(&path, serde_json::to_vec(&valid).unwrap()).unwrap();
    let loaded = read_state_for_game(temp.path().to_str().unwrap(), &path, &shared).unwrap();
    assert_eq!(
        get_folder_path(&loaded.folders, Some("child")).as_deref(),
        Some("root/child")
    );

    static LEGACY_TARGETS: [ScanTarget; 1] = [ScanTarget {
        shared_paks: None,
        ..SHARED_TARGET
    }];
    let legacy = config(&LEGACY_TARGETS);
    let dangling = ModsState {
        folders: vec![],
        mods: vec![manual_mod(Some("missing"))],
    };
    fs::write(&path, serde_json::to_vec(&dangling).unwrap()).unwrap();
    assert!(read_state_for_game(temp.path().to_str().unwrap(), &path, &legacy).is_ok());
}

#[test]
fn folder_paths_handle_deep_graphs_and_preserve_missing_parent_semantics() {
    let mut folders = Vec::new();
    for index in 0..2000 {
        folders.push(folder(
            &index.to_string(),
            (index > 0).then(|| (index - 1).to_string()).as_deref(),
        ));
    }
    let path = get_folder_path(&folders, Some("1999")).unwrap();
    assert_eq!(path.split('/').count(), 2000);
    assert!(path.starts_with("0/1/2/"));
    assert!(path.ends_with("/1999"));
    assert_eq!(
        get_folder_path(&[folder("child", Some("absent"))], Some("child")).as_deref(),
        Some("child")
    );
    assert_eq!(
        get_folder_path(&[folder("cycle", Some("cycle"))], Some("cycle")),
        None
    );
}

#[test]
fn invalid_shared_state_blocks_operations_and_scan_writeback_without_changing_bytes() {
    static TARGETS: [ScanTarget; 1] = [SHARED_TARGET];
    let shared = config(&TARGETS);
    let temp = TempDir::new().unwrap();
    let game = temp.path().join("game");
    let paks = game.join("Synthetic/Content/Paks");
    fs::create_dir_all(&paks).unwrap();
    let state_path = paks.join(STATE_FILENAME);
    let native = paks.join("native.pak");
    let manual = paks.join("Manual.pak");
    fs::write(&native, b"native bytes").unwrap();
    fs::write(&manual, b"root manual bytes").unwrap();
    let state = ModsState {
        folders: vec![],
        mods: vec![manual_mod(Some("missing"))],
    };
    let bytes = serde_json::to_vec(&state).unwrap();
    fs::write(&state_path, &bytes).unwrap();
    let game_path = game.to_str().unwrap();
    assert!(
        super::super::install::uninstall_mod_op(game_path, &state_path, "manual", &shared)
            .unwrap_err()
            .contains("missing folder")
    );
    assert!(
        super::super::install::enable_mod_op(game_path, &state_path, "manual", &shared, None)
            .unwrap_err()
            .contains("missing folder")
    );
    assert!(super::super::install::install_mod_from_path(
        game_path,
        &state_path,
        manual_mod(None),
        &manual,
        None,
        &shared,
        shared.primary()
    )
    .unwrap_err()
    .contains("missing folder"));
    assert!(
        super::super::folders::create_folder_op(game_path, &state_path, "new", None, &shared)
            .unwrap_err()
            .contains("missing folder")
    );
    assert!(super::super::reorder::move_mod_to_folder_op(
        game_path,
        &state_path,
        "manual",
        None,
        0,
        &shared
    )
    .unwrap_err()
    .contains("missing folder"));
    let (scanned, writeback) = load_for_scan(game_path, &state_path, &shared);
    assert!(writeback.blocked());
    writeback.save(&state_path, &scanned, "invalid metadata reconstruction");
    assert_eq!(fs::read(&state_path).unwrap(), bytes);
    assert_eq!(fs::read(&native).unwrap(), b"native bytes");
    assert_eq!(fs::read(&manual).unwrap(), b"root manual bytes");
    assert!(!paks.join("new").exists());
    assert!(!temporary_state_path(&state_path).exists());
}

#[test]
fn invalid_shared_legacy_state_is_not_renamed_or_replaced_by_scan() {
    static TARGETS: [ScanTarget; 1] = [SHARED_TARGET];
    let shared = config(&TARGETS);
    let temp = TempDir::new().unwrap();
    let game = temp.path().join("game");
    let paks = game.join("Synthetic/Content/Paks");
    fs::create_dir_all(&paks).unwrap();
    let state_path = paks.join(STATE_FILENAME);
    let legacy = paks.join(".pd3mm.json");
    let state = ModsState {
        folders: vec![folder("cycle", Some("cycle"))],
        mods: vec![],
    };
    let bytes = serde_json::to_vec(&state).unwrap();
    fs::write(&legacy, &bytes).unwrap();
    let (scanned, writeback) = load_for_scan(game.to_str().unwrap(), &state_path, &shared);
    assert!(writeback.blocked());
    writeback.save(&state_path, &scanned, "invalid legacy reconstruction");
    assert_eq!(fs::read(&legacy).unwrap(), bytes);
    assert!(!state_path.exists());
}

#[test]
fn duplicate_shared_ownership_blocks_uninstall_and_scan_without_changing_bytes() {
    static TARGETS: [ScanTarget; 1] = [SHARED_TARGET];
    let shared = config(&TARGETS);
    let temp = TempDir::new().unwrap();
    let game = temp.path().join("game");
    let paks = game.join("Synthetic/Content/Paks");
    fs::create_dir_all(&paks).unwrap();
    let state_path = paks.join(STATE_FILENAME);
    let manual = paks.join("Manual.pak");
    let native = paks.join("native.pak");
    fs::write(&manual, b"manual bytes").unwrap();
    fs::write(&native, b"native bytes").unwrap();
    let state = ModsState {
        folders: vec![],
        mods: vec![
            InstalledMod {
                uid: "first".into(),
                ..manual_mod(None)
            },
            InstalledMod {
                uid: "second".into(),
                enabled: false,
                ..manual_mod(None)
            },
        ],
    };
    let bytes = serde_json::to_vec(&state).unwrap();
    fs::write(&state_path, &bytes).unwrap();
    let game_path = game.to_str().unwrap();
    assert!(
        super::super::install::uninstall_mod_op(game_path, &state_path, "first", &shared)
            .unwrap_err()
            .contains("same Pak path")
    );
    let (scanned, writeback) = load_for_scan(game_path, &state_path, &shared);
    assert!(writeback.blocked());
    writeback.save(&state_path, &scanned, "duplicate ownership reconstruction");
    assert_eq!(fs::read(&state_path).unwrap(), bytes);
    assert_eq!(fs::read(&manual).unwrap(), b"manual bytes");
    assert_eq!(fs::read(&native).unwrap(), b"native bytes");
    assert!(!temporary_state_path(&state_path).exists());

    let same_folder_path = ModsState {
        folders: vec![
            ModFolder {
                disk_name: "same".into(),
                ..folder("first", None)
            },
            ModFolder {
                disk_name: "same".into(),
                ..folder("second", None)
            },
        ],
        mods: vec![
            manual_mod(Some("first")),
            InstalledMod {
                uid: "second".into(),
                ..manual_mod(Some("second"))
            },
        ],
    };
    let bytes = serde_json::to_vec(&same_folder_path).unwrap();
    fs::write(&state_path, &bytes).unwrap();
    assert!(read_state_for_game(game_path, &state_path, &shared)
        .unwrap_err()
        .to_string()
        .contains("same Pak path"));
    assert_eq!(fs::read(&state_path).unwrap(), bytes);
}

#[cfg(windows)]
#[test]
fn windows_shared_ownership_rejects_ascii_and_unicode_aliases_of_missing_paths() {
    static TARGETS: [ScanTarget; 1] = [SHARED_TARGET];
    let shared = config(&TARGETS);
    let temp = TempDir::new().unwrap();
    let game = temp.path().join("game");
    let paks = game.join("Synthetic/Content/Paks");
    fs::create_dir_all(&paks).unwrap();
    let state_path = paks.join(STATE_FILENAME);
    for (first, second) in [("Folder", "FOLDER"), ("ΟΣ", "οσ")] {
        let state = ModsState {
            folders: vec![
                ModFolder {
                    disk_name: first.into(),
                    ..folder("first", None)
                },
                ModFolder {
                    disk_name: second.into(),
                    ..folder("second", None)
                },
            ],
            mods: vec![
                manual_mod(Some("first")),
                InstalledMod {
                    uid: "second".into(),
                    enabled: false,
                    ..manual_mod(Some("second"))
                },
            ],
        };
        let bytes = serde_json::to_vec(&state).unwrap();
        fs::write(&state_path, &bytes).unwrap();
        assert!(
            read_state_for_game(game.to_str().unwrap(), &state_path, &shared)
                .unwrap_err()
                .to_string()
                .contains("same Pak path")
        );
        assert_eq!(fs::read(&state_path).unwrap(), bytes);
        assert!(!paks.join(first).exists());
        assert!(!paks.join(second).exists());
    }
    let distinct = ModsState {
        folders: vec![
            ModFolder {
                disk_name: "οσ".into(),
                ..folder("first", None)
            },
            ModFolder {
                disk_name: "ος".into(),
                ..folder("second", None)
            },
        ],
        mods: vec![
            manual_mod(Some("first")),
            InstalledMod {
                uid: "second".into(),
                ..manual_mod(Some("second"))
            },
        ],
    };
    fs::write(&state_path, serde_json::to_vec(&distinct).unwrap()).unwrap();
    assert!(read_state_for_game(game.to_str().unwrap(), &state_path, &shared).is_ok());
}

#[test]
fn shared_ownership_rejects_unsafe_paths_before_resolving_them() {
    static TARGETS: [ScanTarget; 1] = [SHARED_TARGET];
    let shared = config(&TARGETS);
    let temp = TempDir::new().unwrap();
    let game = temp.path().join("game");
    fs::create_dir(&game).unwrap();
    let state_path = game.join(STATE_FILENAME);
    let outside = temp.path().join("outside.pak");
    fs::write(&outside, b"outside bytes").unwrap();
    for (filename, reason) in [
        ("../outside.pak".to_string(), "unsafe component"),
        (
            outside.to_str().unwrap().to_string(),
            "leaves the configured game",
        ),
    ] {
        let state = ModsState {
            folders: vec![],
            mods: vec![InstalledMod {
                filename,
                ..manual_mod(None)
            }],
        };
        let bytes = serde_json::to_vec(&state).unwrap();
        fs::write(&state_path, &bytes).unwrap();
        assert!(
            read_state_for_game(game.to_str().unwrap(), &state_path, &shared)
                .unwrap_err()
                .to_string()
                .contains(reason)
        );
        assert_eq!(fs::read(&state_path).unwrap(), bytes);
        assert_eq!(fs::read(&outside).unwrap(), b"outside bytes");
    }
}

#[test]
fn empty_shared_folders_reject_traversal_and_absolute_paths_without_cleanup() {
    static TARGETS: [ScanTarget; 1] = [SHARED_TARGET];
    let shared = config(&TARGETS);
    let temp = TempDir::new().unwrap();
    let game = temp.path().join("game");
    let paks = game.join("Synthetic/Content/Paks");
    fs::create_dir_all(&paks).unwrap();
    let outside = temp.path().join("outside");
    let other_game_directory = game.join("other");
    fs::create_dir(&outside).unwrap();
    fs::create_dir(&other_game_directory).unwrap();
    let sentinel = outside.join("preserve.txt");
    fs::write(&sentinel, b"outside bytes").unwrap();
    let state_path = paks.join(STATE_FILENAME);
    for disk_name in [
        "../..".to_string(),
        outside.to_str().unwrap().into(),
        other_game_directory.to_str().unwrap().into(),
    ] {
        let state = ModsState {
            folders: vec![ModFolder {
                disk_name,
                ..folder("empty", None)
            }],
            mods: vec![],
        };
        let bytes = serde_json::to_vec(&state).unwrap();
        fs::write(&state_path, &bytes).unwrap();
        assert!(matches!(
            read_state_for_game(game.to_str().unwrap(), &state_path, &shared),
            Err(StateLoadError::Invalid(_))
        ));
        assert!(super::super::folders::delete_folder_op(
            game.to_str().unwrap(),
            &state_path,
            "empty",
            &shared
        )
        .is_err());
        assert_eq!(fs::read(&state_path).unwrap(), bytes);
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside bytes");
        assert!(other_game_directory.is_dir());
        assert!(!temporary_state_path(&state_path).exists());
    }
}

#[cfg(windows)]
#[test]
fn empty_shared_folder_reparse_points_are_rejected_without_cleanup() {
    use std::os::windows::process::CommandExt;
    static TARGETS: [ScanTarget; 1] = [SHARED_TARGET];
    let shared = config(&TARGETS);
    let temp = TempDir::new().unwrap();
    let game = temp.path().join("game");
    let paks = game.join("Synthetic/Content/Paks");
    fs::create_dir_all(&paks).unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let sentinel = outside.join("preserve.txt");
    fs::write(&sentinel, b"outside bytes").unwrap();
    let junction = paks.join("empty");
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(junction.to_str().unwrap().replace('/', "\\"))
        .arg(outside.to_str().unwrap().replace('/', "\\"))
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state_path = paks.join(STATE_FILENAME);
    let state = ModsState {
        folders: vec![folder("empty", None)],
        mods: vec![],
    };
    let bytes = serde_json::to_vec(&state).unwrap();
    fs::write(&state_path, &bytes).unwrap();
    assert!(
        read_state_for_game(game.to_str().unwrap(), &state_path, &shared)
            .unwrap_err()
            .to_string()
            .contains("junctions")
    );
    assert!(super::super::folders::delete_folder_op(
        game.to_str().unwrap(),
        &state_path,
        "empty",
        &shared
    )
    .is_err());
    assert_eq!(fs::read(&state_path).unwrap(), bytes);
    assert_eq!(fs::read(&sentinel).unwrap(), b"outside bytes");
    assert!(junction.exists());
    assert!(!temporary_state_path(&state_path).exists());
    fs::remove_dir(&junction).unwrap();
}
