use super::*;
use crate::commands::launchers::steam_manifest::write_test_catalog;
use crate::commands::mods::engine::{Activation, ModMetadata, ModUnit, ScanTarget, SharedPaks};
use crate::commands::mods::{
    decisions, file_transaction, get_state_path, install, paths, state, InstalledMod, ModFolder,
    ModsState,
};
use tempfile::TempDir;

static SHARED_PAK_ENGINE: ModEngineConfig = ModEngineConfig {
    game_id: "shared-pak-test",
    decoders: &[],
    index_game_name: "Synthetic Game",
    mod_metadata: ModMetadata::None,
    targets: &[ScanTarget {
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
        mods_subpath: &["ReadyOrNot", "Content", "Paks"],
        disabled_subpath: &["ReadyOrNot", "Content", "Paks", "disabled"],
        backup_subpath: &["ReadyOrNot", "Content", "Paks.mods.bak"],
        store_layouts: &[],
    }],
};

struct Fixture {
    _temp: TempDir,
    steam: PathBuf,
    game: PathBuf,
    paks: PathBuf,
    native: NativeGuard,
}

fn fixture() -> Fixture {
    let temp = TempDir::new().unwrap();
    let steam = temp.path().join("Steam");
    let game = temp.path().join("Library/steamapps/common/Synthetic Game");
    write_test_catalog(
        &steam,
        &game,
        78,
        &[
            "ReadyOrNot/Content/Paks/native.pak",
            "ReadyOrNot/Content/Paks/native.sig",
            "ReadyOrNot/Content/Paks/native-folder/missing.pak",
        ],
    )
    .unwrap();
    let cfg = &SHARED_PAK_ENGINE;
    let paks = mods_dir(game.to_str().unwrap(), cfg.primary());
    fs::create_dir_all(&paks).unwrap();
    fs::write(paks.join("native.pak"), b"native pak").unwrap();
    fs::write(paks.join("native.sig"), b"native signature").unwrap();
    let native = NativeGuard::load_from(
        game.to_str().unwrap(),
        cfg,
        &CatalogStore::Steam(steam.clone()),
    )
    .unwrap();
    Fixture {
        _temp: temp,
        steam,
        game,
        paks,
        native,
    }
}

fn pending_update_fixture() -> Fixture {
    let mut fixture = fixture();
    let acf = fixture
        .game
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("appmanifest_78.acf");
    let app = fs::read_to_string(&acf)
        .unwrap()
        .replace("\"StateFlags\" \"4\"", "\"StateFlags\" \"6\"")
        .replace("\"TargetBuildID\" \"56\"", "\"TargetBuildID\" \"57\"");
    fs::write(acf, app).unwrap();
    fixture.native = NativeGuard::load_from(
        fixture.game.to_str().unwrap(),
        &SHARED_PAK_ENGINE,
        &CatalogStore::Steam(fixture.steam.clone()),
    )
    .unwrap();
    fixture
}

#[test]
fn pending_steam_update_preserves_native_files_and_allows_manual_mod_moves() {
    let fixture = pending_update_fixture();
    assert!(fixture
        .native
        .check_file(&fixture.paks.join("native.pak"))
        .is_err());
    assert!(fixture
        .native
        .protects(&fixture.paks.join("native.sig"))
        .unwrap());
    assert!(fixture
        .native
        .check_tree(&fixture.paks.join("native-folder"))
        .is_err());
    let source = fixture.paks.join("Manual.pak");
    let destination = fixture.paks.join("Manual.pak.disabled");
    fs::write(&source, b"manual bytes").unwrap();
    let state_path = get_state_path(fixture.game.to_str().unwrap(), &SHARED_PAK_ENGINE);
    let mut moves = crate::commands::mods::moves::Moves::with_native_guard(fixture.native);
    moves.path(source.clone(), destination.clone());
    moves
        .run()
        .unwrap()
        .save(&state_path, &ModsState::default())
        .unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(destination).unwrap(), b"manual bytes");
    assert_eq!(
        fs::read(fixture.paks.join("native.pak")).unwrap(),
        b"native pak"
    );
    assert_eq!(
        fs::read(fixture.paks.join("native.sig")).unwrap(),
        b"native signature"
    );
    assert!(state_path.is_file());
}

#[test]
fn starting_a_pending_steam_update_blocks_mod_moves_before_any_changes() {
    let fixture = pending_update_fixture();
    let source = fixture.paks.join("Manual.pak");
    let destination = fixture.paks.join("Moved.pak");
    fs::write(&source, b"manual bytes").unwrap();
    let acf = fixture
        .game
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("appmanifest_78.acf");
    let app = fs::read_to_string(&acf)
        .unwrap()
        .replace("\"StateFlags\" \"6\"", "\"StateFlags\" \"262\"");
    fs::write(acf, app).unwrap();
    let mut moves = crate::commands::mods::moves::Moves::with_native_guard(fixture.native);
    moves.path(source.clone(), destination.clone());
    assert!(moves.run().is_err());
    assert_eq!(fs::read(source).unwrap(), b"manual bytes");
    assert!(!destination.exists());
    assert_eq!(
        fs::read(fixture.paks.join("native.pak")).unwrap(),
        b"native pak"
    );
    assert_eq!(
        fs::read(fixture.paks.join("native.sig")).unwrap(),
        b"native signature"
    );
}

#[cfg(windows)]
#[test]
fn merging_windows_equivalent_destinations_preserves_both_manual_files() {
    for (first, second) in [("A.pak", "a.pak"), ("ΟΣ.pak", "οσ.pak")] {
        let fixture = fixture();
        let one = fixture.paks.join("One").join(first);
        let two = fixture.paks.join("Two").join(second);
        fs::create_dir_all(one.parent().unwrap()).unwrap();
        fs::create_dir_all(two.parent().unwrap()).unwrap();
        fs::write(&one, b"one manual mod").unwrap();
        fs::write(&two, b"another manual mod").unwrap();
        let mut moves = crate::commands::mods::moves::Moves::with_native_guard(fixture.native);
        moves.path(one.clone(), fixture.paks.join(first));
        moves.path(two.clone(), fixture.paks.join(second));
        assert!(moves.run().is_err());
        assert_eq!(fs::read(one).unwrap(), b"one manual mod");
        assert_eq!(fs::read(two).unwrap(), b"another manual mod");
        assert!(!fixture.paks.join(first).exists());
    }
}

#[cfg(windows)]
#[test]
fn manual_case_only_rename_keeps_the_mod_and_state_consistent() {
    let fixture = fixture();
    let from = fixture.paks.join("Manual.pak");
    let to = fixture.paks.join("MANUAL.pak");
    fs::write(&from, b"manual mod").unwrap();
    let state_path = get_state_path(fixture.game.to_str().unwrap(), &SHARED_PAK_ENGINE);
    let mut moves = crate::commands::mods::moves::Moves::with_native_guard(fixture.native);
    moves.path(from, to.clone());
    moves
        .run()
        .unwrap()
        .save(&state_path, &ModsState::default())
        .unwrap();
    assert_eq!(fs::read(to).unwrap(), b"manual mod");
    assert!(state_path.is_file());
}

#[tokio::test]
async fn scanning_and_moving_uppercase_disabled_files_preserves_the_author_filename() {
    let fixture = fixture();
    let disabled = fixture.paks.join("disabled");
    fs::create_dir(&disabled).unwrap();
    fs::write(disabled.join("001_Manual.PAK.DISABLED"), b"manual mod").unwrap();
    let scanned = crate::commands::mods::find_untracked_paks(
        fixture.game.to_str().unwrap(),
        &std::collections::HashSet::new(),
        &SHARED_PAK_ENGINE,
    )
    .await;
    assert!(scanned.contains(&("001_Manual.PAK".into(), false, None)));
    let destination = fixture.paks.join("inactive");
    let mut moves = crate::commands::mods::moves::Moves::with_native_guard(fixture.native);
    moves.path(disabled.clone(), destination.clone());
    moves.run().unwrap();
    assert_eq!(
        fs::read(destination.join("001_Manual.PAK.DISABLED")).unwrap(),
        b"manual mod"
    );
    assert!(!disabled.exists());
}

#[test]
fn shared_paks_distinguish_native_paths_from_existing_mods_without_provenance() {
    let fixture = fixture();
    assert!(fixture
        .native
        .check_file(&fixture.paks.join("native.pak"))
        .is_err());
    assert!(fixture
        .native
        .check_file(&fixture.paks.join("NATIVE.PAK"))
        .is_err());
    assert!(fixture
        .native
        .check_tree(&fixture.paks.join("native-folder"))
        .is_err());
    assert!(fixture
        .native
        .check_file(&fixture.paks.join("pakchunk99-Map_Hell.pak"))
        .is_ok());
    assert!(fixture
        .native
        .check_file(&fixture.paks.join("~mods/Manual/12345.pak"))
        .is_ok());
    assert!(fixture
        .native
        .check_file(&fixture.paks.join("Music.bank"))
        .is_err());
    assert!(fixture
        .native
        .check_file(&fixture.paks.join("mod.io/123/mod.pak"))
        .is_err());
    assert!(fixture
        .native
        .check_file(&fixture.paks.join("../outside.pak"))
        .is_err());
}

#[test]
fn mixed_folder_move_refuses_before_touching_existing_mods_or_metadata() {
    let fixture = fixture();
    let folder = fixture.paks.join("~mods/Manual");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("Mod.pak"), b"manual mod").unwrap();
    fs::write(folder.join("settings.json"), b"settings").unwrap();
    let mut moves = crate::commands::mods::moves::Moves::with_native_guard(fixture.native);
    moves.path(folder.clone(), fixture.paks.join("Renamed"));
    assert!(moves.run().is_err());
    assert_eq!(fs::read(folder.join("Mod.pak")).unwrap(), b"manual mod");
    assert_eq!(fs::read(folder.join("settings.json")).unwrap(), b"settings");
}

#[test]
fn preexisting_mod_file_moves_and_failed_state_save_restore_its_exact_path() {
    let fixture = fixture();
    let old = fixture.paks.join("~mods/Manual/pakchunk99-A.pak");
    fs::create_dir_all(old.parent().unwrap()).unwrap();
    fs::write(&old, b"manual bytes").unwrap();
    let dest = fixture
        .paks
        .join("disabled/~mods/Manual/pakchunk99-A.pak.disabled");
    fs::create_dir_all(dest.parent().unwrap()).unwrap();
    let mut moves = crate::commands::mods::moves::Moves::with_native_guard(fixture.native);
    moves.unit(SHARED_PAK_ENGINE.primary(), old.clone(), dest.clone());
    let bad_state = fixture.paks.join("cannot-save");
    fs::create_dir(&bad_state).unwrap();
    assert!(moves
        .run()
        .unwrap()
        .save(&bad_state, &ModsState::default())
        .is_err());
    assert_eq!(fs::read(old).unwrap(), b"manual bytes");
    assert!(!dest.exists());
    assert_eq!(
        fs::read(fixture.paks.join("native.pak")).unwrap(),
        b"native pak"
    );
}

#[test]
fn shared_disabled_update_save_failure_restores_mod_and_state() {
    let fixture = fixture();
    let source = fixture.game.join("new.pak");
    fs::write(&source, b"replacement").unwrap();
    let dest = fixture.paks.join("disabled/pakchunk99-Manual.pak.disabled");
    fs::create_dir_all(dest.parent().unwrap()).unwrap();
    fs::write(&dest, b"old manual mod").unwrap();
    let mod_data = InstalledMod {
        uid: "manual".into(),
        filename: "pakchunk99-Manual.pak".into(),
        enabled: false,
        ..InstalledMod::default()
    };
    let state = ModsState {
        folders: vec![],
        mods: vec![mod_data.clone()],
    };
    let state_path = get_state_path(fixture.game.to_str().unwrap(), &SHARED_PAK_ENGINE);
    state::save_state(&state_path, &state).unwrap();
    let before = fs::read(&state_path).unwrap();
    fs::create_dir(state::temporary_state_path(&state_path)).unwrap();
    let result = install::install_shared_pak(
        fixture.game.to_str().unwrap(),
        &state_path,
        InstalledMod {
            enabled: true,
            ..mod_data
        },
        &source,
        &SHARED_PAK_ENGINE,
        SHARED_PAK_ENGINE.primary(),
        state,
        &fixture.native,
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&dest).unwrap(), b"old manual mod");
    assert!(!fixture.paks.join("pakchunk99-Manual.pak").exists());
    assert_eq!(fs::read(&state_path).unwrap(), before);
    assert!(fs::read_dir(dest.parent().unwrap())
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".modrex-install-")));
    assert_eq!(
        fs::read(fixture.paks.join("native.pak")).unwrap(),
        b"native pak"
    );
    assert_eq!(
        fs::read(fixture.paks.join("native.sig")).unwrap(),
        b"native signature"
    );
}

#[test]
fn shared_installs_preserve_activation_identity_folders_and_native_files() {
    for (uid, source_kind, previous_enabled, folder_id) in [
        ("manual", "local", Some(true), None),
        (
            "nexus:2759:30000:entry:Hard/pakchunk99-Manual.pak",
            "nexus",
            Some(false),
            Some("profile"),
        ),
        (
            "nexus:2759:30000:pakchunk99-Manual",
            "nexus",
            Some(false),
            Some("profile"),
        ),
        (
            "nexus:2759:30000:entry:Hard/pakchunk99-Manual.pak",
            "nexus",
            Some(true),
            None,
        ),
        ("nexus:2759:30800", "nexus", None, None),
    ] {
        let fixture = fixture();
        let cfg = &SHARED_PAK_ENGINE;
        let game = fixture.game.to_str().unwrap();
        let state_path = get_state_path(game, cfg);
        let original = InstalledMod {
            uid: uid.into(),
            filename: "pakchunk99-Manual.pak".into(),
            source: source_kind.into(),
            remote_id: (source_kind == "nexus").then(|| "2759".into()),
            file_id: Some(30000),
            enabled: previous_enabled.unwrap_or(false),
            folder_id: folder_id.map(String::from),
            ..InstalledMod::default()
        };
        let state = ModsState {
            folders: folder_id
                .map(|id| ModFolder {
                    id: id.into(),
                    disk_name: "001_Profile".into(),
                    display_name: "Profile".into(),
                    priority: 1,
                    parent_id: None,
                })
                .into_iter()
                .collect(),
            mods: previous_enabled
                .map(|_| original.clone())
                .into_iter()
                .collect(),
        };
        let folder = state::get_folder_path(&state.folders, folder_id);
        let dest = paths::installed_mod_path(
            game,
            &original.filename,
            folder.as_deref(),
            cfg.primary(),
            previous_enabled.unwrap_or(true),
        );
        if previous_enabled.is_some() {
            fs::create_dir_all(dest.parent().unwrap()).unwrap();
            fs::write(&dest, b"manual mod").unwrap();
        }
        state::save_state(&state_path, &state).unwrap();
        let matched = if source_kind == "nexus" {
            decisions::shared_nexus_update(
                &state.mods,
                2759,
                30800,
                &original.filename,
                Some("Hard/pakchunk99-Manual.pak"),
                None,
                true,
            )
            .unwrap()
        } else {
            state.mods.first()
        };
        let update = InstalledMod {
            enabled: true,
            file_id: Some(30800),
            version: "2".into(),
            ..matched.cloned().unwrap_or(original)
        };
        let download = fixture.game.join("download.pak");
        fs::write(&download, b"updated mod").unwrap();
        install::install_shared_pak(
            game,
            &state_path,
            update,
            &download,
            cfg,
            cfg.primary(),
            state,
            &fixture.native,
        )
        .unwrap();
        let saved = state::read_state(&state_path).unwrap();
        assert_eq!(saved.mods.len(), 1);
        let installed = &saved.mods[0];
        assert_eq!(installed.enabled, previous_enabled.unwrap_or(true));
        assert_eq!(installed.uid, uid);
        assert_eq!(installed.filename, "pakchunk99-Manual.pak");
        assert_eq!(installed.folder_id.as_deref(), folder_id);
        assert_eq!(installed.file_id, Some(30800));
        assert_eq!(installed.version, "2");
        assert_eq!(fs::read(&dest).unwrap(), b"updated mod");
        if previous_enabled == Some(false) {
            assert!(!paths::active_mod_path(
                game,
                &installed.filename,
                folder.as_deref(),
                cfg.primary()
            )
            .exists());
        }
        file_transaction::replace_family(
            None,
            &dest,
            None,
            cfg.primary(),
            &fixture.native,
            &state_path,
            &ModsState::default(),
        )
        .unwrap();
        assert!(!dest.exists());
        assert_eq!(
            fs::read(fixture.paks.join("native.pak")).unwrap(),
            b"native pak"
        );
        assert_eq!(
            fs::read(fixture.paks.join("native.sig")).unwrap(),
            b"native signature"
        );
        assert!(state::read_state(&state_path).unwrap().mods.is_empty());
    }
}

#[test]
fn shared_install_refusals_preserve_every_file_and_the_saved_state() {
    for case in [
        "both",
        "active-only",
        "relocated-both",
        "relocated-active-only",
        "relocated-enabled",
        "untracked",
        "native-new",
        "native-old",
        "catalog",
    ] {
        let fixture = fixture();
        let cfg = &SHARED_PAK_ENGINE;
        let game = fixture.game.to_str().unwrap();
        let state_path = get_state_path(game, cfg);
        let folders = vec![ModFolder {
            id: "folder".into(),
            disk_name: "Profile".into(),
            display_name: "Profile".into(),
            priority: 0,
            parent_id: None,
        }];
        let old = InstalledMod {
            uid: "manual".into(),
            filename: if case == "native-old" {
                "native.pak"
            } else {
                "Manual.pak"
            }
            .into(),
            enabled: case == "relocated-enabled",
            folder_id: case.starts_with("relocated").then(|| "folder".into()),
            ..InstalledMod::default()
        };
        let folder = state::get_folder_path(&folders, old.folder_id.as_deref());
        let disabled =
            paths::disabled_mod_path(game, &old.filename, folder.as_deref(), cfg.primary());
        fs::create_dir_all(disabled.parent().unwrap()).unwrap();
        fs::write(&disabled, b"disabled original").unwrap();
        let active = paths::active_mod_path(game, &old.filename, folder.as_deref(), cfg.primary());
        let occupied = fixture.paks.join("disabled/Untracked.pak.disabled");
        match case {
            "both"
            | "active-only"
            | "relocated-both"
            | "relocated-active-only"
            | "relocated-enabled" => {
                fs::create_dir_all(active.parent().unwrap()).unwrap();
                fs::write(&active, b"active original").unwrap();
            }
            "untracked" => {
                fs::write(&occupied, b"untracked original").unwrap();
            }
            "catalog" => {
                fs::write(fixture.steam.join("depotcache/12_34.manifest"), b"changed").unwrap();
            }
            _ => {}
        }
        if case.ends_with("active-only") {
            fs::remove_file(&disabled).unwrap();
        }
        let state = ModsState {
            folders,
            mods: vec![old.clone()],
        };
        state::save_state(&state_path, &state).unwrap();
        let source = fixture.game.join("download.pak");
        fs::write(&source, b"new bytes").unwrap();
        let watched = [
            disabled,
            active,
            occupied,
            fixture.paks.join("native.pak"),
            fixture.paks.join("native.sig"),
            fixture.paks.join("Replacement.pak"),
            fixture.paks.join("disabled/Replacement.pak.disabled"),
            fixture.paks.join("Manual.pak"),
            fixture.paks.join("disabled/Manual.pak.disabled"),
            state_path.clone(),
            source.clone(),
        ];
        let contents = || {
            watched
                .iter()
                .map(|path| match fs::read(path) {
                    Ok(bytes) => Some(bytes),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => panic!("Could not inspect test file: {error}"),
                })
                .collect::<Vec<_>>()
        };
        let before = contents();
        let update = InstalledMod {
            filename: match case {
                "native-new" => "native.pak".into(),
                "native-old" => "Replacement.pak".into(),
                "untracked" => "Untracked.pak".into(),
                _ => old.filename.clone(),
            },
            enabled: true,
            folder_id: None,
            ..old
        };
        assert!(
            install::install_shared_pak(
                game,
                &state_path,
                update,
                &source,
                cfg,
                cfg.primary(),
                state,
                &fixture.native
            )
            .is_err(),
            "{case}"
        );
        assert_eq!(contents(), before, "{case}");
        assert!(!state::temporary_state_path(&state_path).exists());
    }
}

#[test]
fn missing_native_staging_name_blocks_a_manual_move_before_any_changes() {
    let fixture = fixture();
    write_test_catalog(
        &fixture.steam,
        &fixture.game,
        78,
        &[
            "ReadyOrNot/Content/Paks/native.pak",
            "ReadyOrNot/Content/Paks/__modrex_move_0__Manual.pak",
        ],
    )
    .unwrap();
    let native = NativeGuard::load_from(
        fixture.game.to_str().unwrap(),
        &SHARED_PAK_ENGINE,
        &CatalogStore::Steam(fixture.steam.clone()),
    )
    .unwrap();
    let old = fixture.paks.join("Manual.pak");
    let destination = fixture.paks.join("Moved.pak");
    fs::write(&old, b"manual bytes").unwrap();
    let mut moves = crate::commands::mods::moves::Moves::with_native_guard(native);
    moves.path(old.clone(), destination.clone());
    assert!(moves.run().is_err());
    assert_eq!(fs::read(old).unwrap(), b"manual bytes");
    assert!(!destination.exists());
    assert!(!fixture.paks.join("__modrex_move_0__Manual.pak").exists());
    assert_eq!(
        fs::read(fixture.paks.join("native.pak")).unwrap(),
        b"native pak"
    );
}

#[test]
fn state_temp_hard_link_refuses_replacement_and_preserves_native_bytes() {
    let fixture = fixture();
    let cfg = &SHARED_PAK_ENGINE;
    let state_path = get_state_path(fixture.game.to_str().unwrap(), cfg);
    let state_temp = state::temporary_state_path(&state_path);
    fs::hard_link(fixture.paks.join("native.pak"), &state_temp).unwrap();
    let destination = fixture.paks.join("Manual.pak");
    fs::write(&destination, b"old manual bytes").unwrap();
    let source = fixture.game.join("download.pak");
    fs::write(&source, b"new manual bytes").unwrap();
    let result = file_transaction::replace_family(
        Some(&source),
        &destination,
        Some(&destination),
        cfg.primary(),
        &fixture.native,
        &state_path,
        &ModsState::default(),
    );
    assert!(result.is_err());
    assert_eq!(fs::read(destination).unwrap(), b"old manual bytes");
    assert_eq!(
        fs::read(fixture.paks.join("native.pak")).unwrap(),
        b"native pak"
    );
    assert_eq!(fs::read(state_temp).unwrap(), b"native pak");
    assert!(!state_path.exists());
}

#[cfg(windows)]
#[test]
fn unicode_aliases_block_missing_native_paths_and_leave_manual_names_editable() {
    let fixture = fixture();
    write_test_catalog(
        &fixture.steam,
        &fixture.game,
        78,
        &[
            "ReadyOrNot/Content/Paks/native.pak",
            "ReadyOrNot/Content/Paks/ΟΣ/missing.pak",
        ],
    )
    .unwrap();
    let native = NativeGuard::load_from(
        fixture.game.to_str().unwrap(),
        &SHARED_PAK_ENGINE,
        &CatalogStore::Steam(fixture.steam.clone()),
    )
    .unwrap();
    assert!(native
        .check_file(&fixture.paks.join("οσ/missing.pak"))
        .is_err());
    assert!(native.check_tree(&fixture.paks.join("οσ")).is_err());
    assert!(native
        .check_file(&fixture.paks.join("ος/missing.pak"))
        .is_ok());
    assert!(native.check_file(&fixture.paks.join("個人.pak")).is_ok());
}

static EPIC_PAK_ENGINE: ModEngineConfig = ModEngineConfig {
    game_id: "shared-pak-test",
    decoders: &[],
    index_game_name: "Synthetic Game",
    mod_metadata: ModMetadata::None,
    targets: &[ScanTarget {
        tag: "paks",
        label_key: "pakMods",
        label_name: None,
        shared_paks: Some(SharedPaks {
            steam_app: Some(78),
            epic_name: Some("Synthetic Game"),
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
        mods_subpath: &["ReadyOrNot", "Content", "Paks"],
        disabled_subpath: &["ReadyOrNot", "Content", "Paks", "disabled"],
        backup_subpath: &["ReadyOrNot", "Content", "Paks.mods.bak"],
        store_layouts: &[],
    }],
};

fn epic_install(temp: &TempDir) -> (PathBuf, PathBuf) {
    let manifests = temp.path().join("Manifests");
    let game = temp.path().join("Epic Games/Synthetic Game");
    crate::commands::launchers::epic_manifest::write_test_install(
        &manifests,
        &game,
        "Synthetic Game",
        &[
            "ReadyOrNot/Content/Paks/native.pak",
            "ReadyOrNot/Content/Paks/native.sig",
        ],
    );
    (manifests, game)
}

#[test]
fn an_epic_copy_protects_the_files_its_manifest_lists() {
    let temp = TempDir::new().unwrap();
    let (manifests, game) = epic_install(&temp);
    let paks = mods_dir(game.to_str().unwrap(), EPIC_PAK_ENGINE.primary());
    fs::create_dir_all(&paks).unwrap();

    let native = NativeGuard::load_from(
        game.to_str().unwrap(),
        &EPIC_PAK_ENGINE,
        &CatalogStore::Epic(manifests),
    )
    .unwrap();

    assert!(native
        .check_file(&paks.join("native.pak"))
        .unwrap_err()
        .contains("belongs to the game"));
    native.check_file(&paks.join("Mod_P.pak")).unwrap();
    native.verify_unchanged().unwrap();
}

#[test]
fn an_epic_copy_of_a_game_without_an_epic_binding_is_refused() {
    let temp = TempDir::new().unwrap();
    let (manifests, game) = epic_install(&temp);

    let error = NativeGuard::load_from(
        game.to_str().unwrap(),
        &SHARED_PAK_ENGINE,
        &CatalogStore::Epic(manifests),
    )
    .err()
    .unwrap();

    assert!(error.contains("not supported for Epic"), "{error}");
}

#[test]
fn an_epic_folder_its_records_do_not_name_is_refused() {
    let temp = TempDir::new().unwrap();
    let (manifests, _) = epic_install(&temp);
    let other = temp.path().join("Elsewhere");
    fs::create_dir_all(&other).unwrap();

    let error = NativeGuard::load_from(
        other.to_str().unwrap(),
        &EPIC_PAK_ENGINE,
        &CatalogStore::Epic(manifests),
    )
    .err()
    .unwrap();

    assert!(error.contains("Open Epic Games Launcher"), "{error}");
}
