use super::*;
use crate::commands::launchers::steam_manifest::write_test_catalog;
use crate::commands::mods::engine::{Activation, ModMetadata, ModUnit, ScanTarget};
use crate::commands::mods::{get_state_path, InstalledMod, ModsState};
use tempfile::TempDir;

static SHARED_PAK_ENGINE: ModEngineConfig = ModEngineConfig {
    game_id: "shared-pak-test",
    decoders: &[],
    index_game_name: "Synthetic Game",
    mod_metadata: ModMetadata::None,
    targets: &[ScanTarget {
        tag: "paks",
        label_key: "mods",
        native_steam_app: Some(78),
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
    let native = NativeGuard::load_from_steam_root(game.to_str().unwrap(), cfg, &steam).unwrap();
    Fixture {
        _temp: temp,
        steam,
        game,
        paks,
        native,
    }
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
fn replacement_save_failure_restores_existing_mod_bytes_and_other_files() {
    let fixture = fixture();
    let source = fixture.game.join("new.pak");
    fs::write(&source, b"replacement").unwrap();
    let dest = fixture.paks.join("pakchunk99-Manual.pak");
    fs::write(&dest, b"old manual mod").unwrap();
    let bad_state = fixture.paks.join("cannot-save");
    fs::create_dir(&bad_state).unwrap();
    let result = crate::commands::mods::file_transaction::replace_family(
        Some(&source),
        &dest,
        Some(&dest),
        SHARED_PAK_ENGINE.primary(),
        &fixture.native,
        &bad_state,
        &ModsState::default(),
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&dest).unwrap(), b"old manual mod");
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
fn installing_and_uninstalling_a_manual_mod_preserve_native_files() {
    let fixture = fixture();
    let cfg = &SHARED_PAK_ENGINE;
    let state_path = get_state_path(fixture.game.to_str().unwrap(), cfg);
    let dest = fixture.paks.join("pakchunk99-Manual.pak");
    fs::write(&dest, b"manual mod").unwrap();
    let source = fixture.game.join("download.pak");
    fs::write(&source, b"updated mod").unwrap();
    let state = ModsState {
        folders: vec![],
        mods: vec![InstalledMod {
            uid: "manual".into(),
            filename: "pakchunk99-Manual.pak".into(),
            enabled: true,
            ..InstalledMod::default()
        }],
    };
    crate::commands::mods::file_transaction::replace_family(
        Some(&source),
        &dest,
        Some(&dest),
        cfg.primary(),
        &fixture.native,
        &state_path,
        &state,
    )
    .unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"updated mod");
    crate::commands::mods::file_transaction::replace_family(
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
    assert!(fs::read_to_string(&state_path)
        .unwrap()
        .contains("\"mods\": []"));
}

#[test]
fn changed_depot_catalog_blocks_mutation_before_overwriting_existing_mod() {
    let fixture = fixture();
    let dest = fixture.paks.join("Manual.pak");
    fs::write(&dest, b"manual bytes").unwrap();
    let source = fixture.game.join("download.pak");
    fs::write(&source, b"new bytes").unwrap();
    fs::write(fixture.steam.join("depotcache/12_34.manifest"), b"changed").unwrap();
    let cfg = &SHARED_PAK_ENGINE;
    assert!(crate::commands::mods::file_transaction::replace_family(
        Some(&source),
        &dest,
        None,
        cfg.primary(),
        &fixture.native,
        &get_state_path(fixture.game.to_str().unwrap(), cfg),
        &ModsState::default()
    )
    .is_err());
    assert_eq!(fs::read(dest).unwrap(), b"manual bytes");
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
    let native = NativeGuard::load_from_steam_root(
        fixture.game.to_str().unwrap(),
        &SHARED_PAK_ENGINE,
        &fixture.steam,
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
    let state_temp = crate::commands::mods::state::temporary_state_path(&state_path);
    fs::hard_link(fixture.paks.join("native.pak"), &state_temp).unwrap();
    let destination = fixture.paks.join("Manual.pak");
    fs::write(&destination, b"old manual bytes").unwrap();
    let source = fixture.game.join("download.pak");
    fs::write(&source, b"new manual bytes").unwrap();
    let result = crate::commands::mods::file_transaction::replace_family(
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
    let native = NativeGuard::load_from_steam_root(
        fixture.game.to_str().unwrap(),
        &SHARED_PAK_ENGINE,
        &fixture.steam,
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
