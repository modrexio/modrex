use super::super::engine::{synthetic_shared_paks_target, ModMetadata, ModUnit, SharedPaks};
use super::super::native_files::NativeGuard;
use super::super::types::{InstalledMod, ModsState};
use super::super::{install, state};
use super::*;
use tempfile::TempDir;

static XBOX_PAK_ENGINE: ModEngineConfig = ModEngineConfig {
    game_id: "shared-pak-test",
    decoders: &[],
    index_game_name: "Synthetic Game",
    mod_metadata: ModMetadata::None,
    targets: &[synthetic_shared_paks_target(SharedPaks {
        steam_app: None,
        epic_name: None,
        xbox: true,
    })],
};

struct Fixture {
    _temp: TempDir,
    game: PathBuf,
    paks: PathBuf,
    state_path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let game = temp.path().join("XboxGames/Synthetic Game/Content");
        let paks = mods_base(game.to_str().unwrap(), XBOX_PAK_ENGINE.primary());
        fs::create_dir_all(&paks).unwrap();
        fs::write(game.join("MicrosoftGame.config"), "<Game/>").unwrap();
        fs::write(paks.join("pakchunk0-WinGDK.pak"), b"native pak").unwrap();
        fs::write(paks.join("pakchunk0-WinGDK.sig"), b"native signature").unwrap();
        fs::write(paks.join("Manual.pak"), b"hand installed").unwrap();
        let state_path = get_state_path(game.to_str().unwrap(), &XBOX_PAK_ENGINE);
        Fixture {
            _temp: temp,
            game,
            paks,
            state_path,
        }
    }

    fn game_path(&self) -> &str {
        self.game.to_str().unwrap()
    }

    fn guard(&self) -> NativeGuard {
        NativeGuard::load(self.game_path(), &XBOX_PAK_ENGINE).unwrap()
    }

    fn install(&self, filename: &str, bytes: &[u8]) -> Result<(), String> {
        let source = self.game.join("staged.pak");
        fs::write(&source, bytes).unwrap();
        let state = state::read_state(&self.state_path).unwrap();
        install::install_shared_pak(
            self.game_path(),
            &self.state_path,
            InstalledMod {
                uid: filename.into(),
                filename: filename.into(),
                ..InstalledMod::default()
            },
            &source,
            &XBOX_PAK_ENGINE,
            XBOX_PAK_ENGINE.primary(),
            state,
            &self.guard(),
        )
    }

    fn assert_game_and_manual_files_untouched(&self) {
        assert_eq!(
            fs::read(self.paks.join("pakchunk0-WinGDK.pak")).unwrap(),
            b"native pak"
        );
        assert_eq!(
            fs::read(self.paks.join("pakchunk0-WinGDK.sig")).unwrap(),
            b"native signature"
        );
        assert_eq!(
            fs::read(self.paks.join("Manual.pak")).unwrap(),
            b"hand installed"
        );
    }
}

#[test]
fn an_install_records_the_bytes_it_placed() {
    let fixture = Fixture::new();

    fixture.install("pakchunk99-New_P.pak", b"new mod").unwrap();

    let state = state::read_state(&fixture.state_path).unwrap();
    let placed = super::super::identify::hash_file(&fixture.paks.join("pakchunk99-New_P.pak"))
        .unwrap()
        .unwrap();
    assert_eq!(
        state.mods[0].placed_sha256.as_deref(),
        Some(placed.as_str())
    );
    fixture.assert_game_and_manual_files_untouched();
}

#[test]
fn an_install_never_overwrites_a_file_modrex_did_not_place() {
    let fixture = Fixture::new();

    let error = fixture.install("Manual.pak", b"replacement").unwrap_err();

    assert!(error.contains("not installed by Modrex"), "{error}");
    assert!(state::read_state(&fixture.state_path)
        .unwrap()
        .mods
        .is_empty());
    fixture.assert_game_and_manual_files_untouched();
}

#[test]
fn an_owned_mod_can_be_disabled_enabled_updated_and_uninstalled() {
    let fixture = Fixture::new();
    fixture.install("pakchunk99-New_P.pak", b"new mod").unwrap();
    let active = fixture.paks.join("pakchunk99-New_P.pak");
    let disabled = fixture.paks.join("disabled/pakchunk99-New_P.pak.disabled");

    install::disable_mod_op(
        fixture.game_path(),
        &fixture.state_path,
        "pakchunk99-New_P.pak",
        &XBOX_PAK_ENGINE,
        Some("xbox"),
    )
    .unwrap();
    assert!(!active.exists());
    assert_eq!(fs::read(&disabled).unwrap(), b"new mod");

    install::enable_mod_op(
        fixture.game_path(),
        &fixture.state_path,
        "pakchunk99-New_P.pak",
        &XBOX_PAK_ENGINE,
        Some("xbox"),
    )
    .unwrap();
    assert_eq!(fs::read(&active).unwrap(), b"new mod");

    fixture
        .install("pakchunk99-New_P.pak", b"new mod, version two")
        .unwrap();
    assert_eq!(fs::read(&active).unwrap(), b"new mod, version two");

    install::uninstall_mod_op(
        fixture.game_path(),
        &fixture.state_path,
        "pakchunk99-New_P.pak",
        &XBOX_PAK_ENGINE,
    )
    .unwrap();
    assert!(!active.exists());
    fixture.assert_game_and_manual_files_untouched();
}

#[test]
fn a_recorded_file_whose_bytes_changed_is_left_alone() {
    let fixture = Fixture::new();
    fixture.install("pakchunk99-New_P.pak", b"new mod").unwrap();
    let active = fixture.paks.join("pakchunk99-New_P.pak");
    fs::write(&active, b"replaced by the game").unwrap();

    let error = install::uninstall_mod_op(
        fixture.game_path(),
        &fixture.state_path,
        "pakchunk99-New_P.pak",
        &XBOX_PAK_ENGINE,
    )
    .unwrap_err();

    assert!(error.contains("not installed by Modrex"), "{error}");
    assert_eq!(fs::read(&active).unwrap(), b"replaced by the game");
}

#[test]
fn a_recorded_file_that_gains_a_signature_is_left_alone() {
    let fixture = Fixture::new();
    fixture.install("pakchunk99-New_P.pak", b"new mod").unwrap();
    fs::write(fixture.paks.join("pakchunk99-New_P.sig"), b"signature").unwrap();

    let error = install::disable_mod_op(
        fixture.game_path(),
        &fixture.state_path,
        "pakchunk99-New_P.pak",
        &XBOX_PAK_ENGINE,
        Some("xbox"),
    )
    .unwrap_err();

    assert!(error.contains("not installed by Modrex"), "{error}");
    assert_eq!(
        fs::read(fixture.paks.join("pakchunk99-New_P.pak")).unwrap(),
        b"new mod"
    );
}

#[test]
fn files_modrex_did_not_place_are_protected_and_vacant_names_are_free() {
    let fixture = Fixture::new();
    let guard = fixture.guard();

    assert!(guard.protects(&fixture.paks.join("Manual.pak")).unwrap());
    assert!(guard
        .protects(&fixture.paks.join("pakchunk0-WinGDK.pak"))
        .unwrap());
    assert!(guard
        .protects(&fixture.paks.join("pakchunk0-WinGDK.sig"))
        .unwrap());
    assert!(!guard.protects(&fixture.paks.join("Vacant_P.pak")).unwrap());
    guard.check_state_path(&fixture.state_path).unwrap();
    guard.check_path(&fixture.paks).unwrap();
}

#[test]
fn a_record_without_a_placed_hash_grants_nothing() {
    let fixture = Fixture::new();
    let state = ModsState {
        folders: vec![],
        mods: vec![InstalledMod {
            uid: "manual".into(),
            filename: "Manual.pak".into(),
            enabled: true,
            sha256: Some("0".repeat(64)),
            ..InstalledMod::default()
        }],
    };
    state::save_state(&fixture.state_path, &state).unwrap();

    let error = install::uninstall_mod_op(
        fixture.game_path(),
        &fixture.state_path,
        "manual",
        &XBOX_PAK_ENGINE,
    )
    .unwrap_err();

    assert!(error.contains("not installed by Modrex"), "{error}");
    fixture.assert_game_and_manual_files_untouched();
}

#[test]
fn a_change_rehashes_even_when_size_and_time_look_unchanged() {
    let fixture = Fixture::new();
    fixture.install("pakchunk99-New_P.pak", b"new mod").unwrap();
    let active = fixture.paks.join("pakchunk99-New_P.pak");
    let modified = filetime::FileTime::from_last_modification_time(&fs::metadata(&active).unwrap());
    let scan = NativeGuard::load_for_scan(fixture.game_path(), &XBOX_PAK_ENGINE).unwrap();
    assert!(!scan.protects(&active).unwrap());

    fs::write(&active, b"new MOD").unwrap();
    filetime::set_file_mtime(&active, modified).unwrap();
    let error = install::uninstall_mod_op(
        fixture.game_path(),
        &fixture.state_path,
        "pakchunk99-New_P.pak",
        &XBOX_PAK_ENGINE,
    )
    .unwrap_err();

    assert!(error.contains("not installed by Modrex"), "{error}");
    assert_eq!(fs::read(&active).unwrap(), b"new MOD");
}

#[test]
fn paths_outside_the_target_belong_to_other_targets() {
    let fixture = Fixture::new();
    let binaries = fixture.game.join("Synthetic/Binaries/WinGDK/Mods/Lua");
    fs::create_dir_all(&binaries).unwrap();

    assert!(!fixture.guard().protects(&binaries).unwrap());
}

static SHOUTING_SUFFIX_ENGINE: ModEngineConfig = ModEngineConfig {
    targets: &[ScanTarget {
        unit: ModUnit::File {
            extension: "pak",
            disabled_suffix: ".DISABLED",
            priority_prefix: false,
            keeps_archive_filename: true,
        },
        ..synthetic_shared_paks_target(SharedPaks {
            steam_app: None,
            epic_name: None,
            xbox: true,
        })
    }],
    ..XBOX_PAK_ENGINE
};

#[test]
fn a_signature_fences_a_disabled_pak_whatever_the_suffix_case() {
    let fixture = Fixture::new();
    let disabled = fixture.paks.join("disabled");
    fs::create_dir_all(&disabled).unwrap();
    fs::write(disabled.join("Signed.sig"), b"signature").unwrap();
    let guard = NativeGuard::load(fixture.game_path(), &SHOUTING_SUFFIX_ENGINE).unwrap();

    assert!(guard
        .protects(&disabled.join("Signed.pak.DISABLED"))
        .unwrap());
}

#[test]
fn reconcile_keeps_placed_mods_and_drops_records_that_prove_nothing() {
    let fixture = Fixture::new();
    fixture.install("pakchunk99-Kept_P.pak", b"kept").unwrap();
    fixture
        .install("pakchunk99-Changed_P.pak", b"changed")
        .unwrap();
    fs::write(fixture.paks.join("pakchunk99-Changed_P.pak"), b"edited").unwrap();
    let mut state = state::read_state(&fixture.state_path).unwrap();
    state.mods.push(InstalledMod {
        uid: "manual".into(),
        filename: "Manual.pak".into(),
        enabled: true,
        ..InstalledMod::default()
    });
    state::save_state(&fixture.state_path, &state).unwrap();

    let reconciled =
        state::reconcile_state(fixture.game_path(), &fixture.state_path, &XBOX_PAK_ENGINE).unwrap();

    let uids: Vec<_> = reconciled.mods.iter().map(|m| m.uid.as_str()).collect();
    assert_eq!(uids, ["pakchunk99-Kept_P.pak"]);
    assert_eq!(
        fs::read(fixture.paks.join("pakchunk99-Changed_P.pak")).unwrap(),
        b"edited"
    );
    fixture.assert_game_and_manual_files_untouched();
}

#[test]
fn a_modrex_folder_moves_only_while_it_holds_nothing_foreign() {
    let fixture = Fixture::new();
    let folder = super::super::types::ModFolder {
        id: "weapons".into(),
        disk_name: "001_Weapons".into(),
        display_name: "Weapons".into(),
        priority: 1,
        parent_id: None,
    };
    let dir = fixture.paks.join("001_Weapons");
    fs::create_dir_all(&dir).unwrap();
    state::save_state(
        &fixture.state_path,
        &ModsState {
            folders: vec![folder],
            mods: vec![],
        },
    )
    .unwrap();
    fixture.guard().check_tree(&dir).unwrap();

    fs::write(dir.join("Dropped.pak"), b"hand installed").unwrap();

    assert!(fixture.guard().check_tree(&dir).is_err());
    assert!(fixture
        .guard()
        .check_tree(&fixture.paks.join("Unknown"))
        .is_ok());
    fs::create_dir_all(fixture.paks.join("Unknown")).unwrap();
    assert!(fixture
        .guard()
        .check_tree(&fixture.paks.join("Unknown"))
        .is_err());
}
