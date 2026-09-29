use super::*;
use crate::commands::mods::{backup_dir, disabled_dir, engine_for_game, mods_dir};
use tempfile::TempDir;

struct Game {
    _tmp: TempDir,
    path: String,
    cfg: &'static ModEngineConfig,
}

impl Game {
    fn pd3() -> Self {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().to_str().unwrap().to_string();
        Game {
            _tmp: tmp,
            path,
            cfg: engine_for_game("pd3").unwrap(),
        }
    }

    fn active(&self) -> PathBuf {
        mods_dir(&self.path, self.cfg.primary())
    }

    fn disabled(&self) -> PathBuf {
        disabled_dir(&self.path, self.cfg.primary())
    }

    fn rejoin(&self, folders: &[ModFolder], mods: &[InstalledMod]) -> usize {
        rejoin_split_companions(&self.path, self.cfg, folders, mods, None)
    }
}

fn put(dir: &Path, name: &str, content: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(name), content).unwrap();
}

fn companions(dir: &Path, stem: &str, suffix: &str, content: &str) {
    put(
        dir,
        &format!("{stem}.ucas{suffix}"),
        &format!("{content} ucas"),
    );
    put(
        dir,
        &format!("{stem}.utoc{suffix}"),
        &format!("{content} utoc"),
    );
}

fn read(path: PathBuf) -> String {
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"))
}

fn record(uid: &str, filename: &str, enabled: bool) -> InstalledMod {
    InstalledMod {
        uid: uid.into(),
        filename: filename.into(),
        enabled,
        ..InstalledMod::default()
    }
}

#[test]
fn a_pak_gets_back_the_companions_a_reorder_left_behind() {
    let game = Game::pd3();
    put(&game.active(), "048_Judge_P.pak", "stub");
    companions(&game.active(), "054_Judge_P", "", "judge");

    let rejoined = game.rejoin(&[], &[record("1", "048_Judge_P.pak", true)]);

    assert_eq!(rejoined, 1);
    assert_eq!(read(game.active().join("048_Judge_P.ucas")), "judge ucas");
    assert_eq!(read(game.active().join("048_Judge_P.utoc")), "judge utoc");
    assert!(!game.active().join("054_Judge_P.ucas").exists());
}

#[test]
fn one_identical_copy_is_rejoined_and_the_others_are_left() {
    let game = Game::pd3();
    put(&game.active(), "004_Mats_P.pak", "stub");
    companions(&game.active(), "033_Mats_P", "", "mats");
    companions(&game.active(), "055_Mats_P", "", "mats");

    assert_eq!(game.rejoin(&[], &[record("1", "004_Mats_P.pak", true)]), 1);

    assert_eq!(read(game.active().join("004_Mats_P.ucas")), "mats ucas");
    assert!(!game.active().join("033_Mats_P.ucas").exists());
    assert_eq!(read(game.active().join("055_Mats_P.utoc")), "mats utoc");
}

#[test]
fn a_disabled_mod_takes_its_leftovers_into_the_disabled_folder() {
    let game = Game::pd3();
    put(&game.disabled(), "020_Rail_P.pak.disabled", "stub");
    companions(&game.active(), "003_Rail_P", "", "rail");
    companions(&game.active(), "023_Rail_P", "", "rail");

    assert_eq!(game.rejoin(&[], &[record("1", "020_Rail_P.pak", false)]), 1);

    assert_eq!(
        read(game.disabled().join("020_Rail_P.ucas.disabled")),
        "rail ucas"
    );
    assert_eq!(
        read(game.disabled().join("020_Rail_P.utoc.disabled")),
        "rail utoc"
    );
    assert!(!game.active().join("003_Rail_P.ucas").exists());
    assert!(game.active().join("023_Rail_P.ucas").exists());
}

#[test]
fn an_enabled_mod_takes_its_leftovers_out_of_the_disabled_folder() {
    let game = Game::pd3();
    put(&game.active(), "011_Vending_P.pak", "stub");
    companions(&game.disabled(), "009_Vending_P", ".disabled", "vending");

    assert_eq!(
        game.rejoin(&[], &[record("1", "011_Vending_P.pak", true)]),
        1
    );

    assert_eq!(
        read(game.active().join("011_Vending_P.ucas")),
        "vending ucas"
    );
    assert!(!game.disabled().join("009_Vending_P.ucas.disabled").exists());
}

#[test]
fn a_mod_moved_into_a_folder_takes_its_leftovers_from_the_parent() {
    let game = Game::pd3();
    let folder = ModFolder {
        id: "f".into(),
        disk_name: "001_Skins".into(),
        display_name: "Skins".into(),
        priority: 1,
        parent_id: None,
    };
    put(&game.active().join("001_Skins"), "002_Skin_P.pak", "stub");
    companions(&game.active(), "005_Skin_P", "", "skin");
    let mut m = record("1", "002_Skin_P.pak", true);
    m.folder_id = Some("f".into());

    assert_eq!(game.rejoin(&[folder], &[m]), 1);

    assert_eq!(
        read(game.active().join("001_Skins").join("002_Skin_P.ucas")),
        "skin ucas"
    );
}

#[test]
fn copies_that_differ_are_left_alone() {
    let game = Game::pd3();
    put(&game.active(), "022_Slate_P.pak", "stub");
    companions(&game.active(), "010_Slate_P", "", "old");
    companions(&game.active(), "025_Slate_P", "", "new");

    assert_eq!(game.rejoin(&[], &[record("1", "022_Slate_P.pak", true)]), 0);

    assert!(!game.active().join("022_Slate_P.ucas").exists());
    assert_eq!(read(game.active().join("010_Slate_P.ucas")), "old ucas");
}

#[test]
fn two_mods_missing_companions_of_one_name_are_left_alone() {
    let game = Game::pd3();
    put(&game.active(), "001_Same_P.pak", "stub");
    put(&game.active().join("001_Skins"), "001_Same_P.pak", "stub");
    companions(&game.active(), "007_Same_P", "", "same");
    let folder = ModFolder {
        id: "f".into(),
        disk_name: "001_Skins".into(),
        display_name: "Skins".into(),
        priority: 1,
        parent_id: None,
    };
    let mut in_folder = record("2", "001_Same_P.pak", true);
    in_folder.folder_id = Some("f".into());

    let rejoined = game.rejoin(&[folder], &[record("1", "001_Same_P.pak", true), in_folder]);

    assert_eq!(rejoined, 0);
    assert!(game.active().join("007_Same_P.ucas").exists());
}

#[test]
fn companions_that_belong_to_another_pak_are_never_taken() {
    let game = Game::pd3();
    put(&game.active(), "002_Skin_P.pak", "stub");
    put(&game.active(), "007_Skin_P.pak", "someone else's stub");
    companions(&game.active(), "007_Skin_P", "", "theirs");

    assert_eq!(game.rejoin(&[], &[record("1", "002_Skin_P.pak", true)]), 0);

    assert_eq!(read(game.active().join("007_Skin_P.ucas")), "theirs ucas");
    assert!(!game.active().join("002_Skin_P.ucas").exists());
}

#[test]
fn a_pak_that_has_its_companions_is_not_touched() {
    let game = Game::pd3();
    put(&game.active(), "002_Skin_P.pak", "stub");
    companions(&game.active(), "002_Skin_P", "", "mine");
    companions(&game.active(), "009_Skin_P", "", "older");

    assert_eq!(game.rejoin(&[], &[record("1", "002_Skin_P.pak", true)]), 0);

    assert_eq!(read(game.active().join("002_Skin_P.ucas")), "mine ucas");
    assert!(game.active().join("009_Skin_P.ucas").exists());
}

#[test]
fn nothing_moves_while_the_mods_folder_is_set_aside() {
    let game = Game::pd3();
    put(&game.active(), "048_Judge_P.pak", "stub");
    companions(&game.active(), "054_Judge_P", "", "judge");
    fs::create_dir_all(backup_dir(&game.path, game.cfg.primary())).unwrap();

    assert_eq!(game.rejoin(&[], &[record("1", "048_Judge_P.pak", true)]), 0);
    assert!(game.active().join("054_Judge_P.ucas").exists());
}

#[test]
fn a_second_pass_changes_nothing() {
    let game = Game::pd3();
    put(&game.active(), "048_Judge_P.pak", "stub");
    companions(&game.active(), "054_Judge_P", "", "judge");
    companions(&game.active(), "060_Judge_P", "", "judge");
    let mods = [record("1", "048_Judge_P.pak", true)];

    assert_eq!(game.rejoin(&[], &mods), 1);
    assert_eq!(game.rejoin(&[], &mods), 0);
    assert!(game.active().join("060_Judge_P.ucas").exists());
}

// ── the index as a second opinion ───────────────────────────────────────────

fn index_with_companion(file_id: i64, sha256: &str) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
         CREATE TABLE sources (id INTEGER PRIMARY KEY, game_id INTEGER);
         CREATE TABLE mods (id INTEGER PRIMARY KEY, source_id INTEGER, remote_id INTEGER, name TEXT);
         CREATE TABLE files (id INTEGER PRIMARY KEY, mod_id INTEGER, remote_id INTEGER, sha256 TEXT, version TEXT, entry_name TEXT NOT NULL DEFAULT '');
         INSERT INTO games VALUES (1, 'PAYDAY 3');
         INSERT INTO sources VALUES (1, 1);
         INSERT INTO mods VALUES (1, 1, 77, 'Judge Skin');",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO files VALUES (1, 1, ?1, ?2, '1.0', 'Judge_P.ucas')",
        rusqlite::params![file_id, sha256],
    )
    .unwrap();
    conn
}

fn split_judge(game: &Game) -> String {
    put(&game.active(), "048_Judge_P.pak", "stub");
    companions(&game.active(), "054_Judge_P", "", "judge");
    hash_file(&game.active().join("054_Judge_P.ucas"))
        .unwrap()
        .unwrap()
}

#[test]
fn the_index_can_refuse_a_container_from_another_file() {
    let game = Game::pd3();
    split_judge(&game);
    let conn = index_with_companion(500, "not-these-bytes");
    let mut m = record("500", "048_Judge_P.pak", true);
    m.file_id = Some(500);

    let rejoined = rejoin_split_companions(&game.path, game.cfg, &[], &[m], Some(&conn));

    assert_eq!(rejoined, 0);
    assert!(game.active().join("054_Judge_P.ucas").exists());
}

#[test]
fn the_index_confirms_the_container_by_the_file_the_uid_names() {
    let game = Game::pd3();
    let sha = split_judge(&game);
    let conn = index_with_companion(500, &sha);
    let mut m = record("500", "048_Judge_P.pak", true);
    m.file_id = Some(999);

    let rejoined = rejoin_split_companions(&game.path, game.cfg, &[], &[m], Some(&conn));

    assert_eq!(rejoined, 1);
}

#[test]
fn a_nexus_file_id_is_not_looked_up_in_the_modworkshop_index() {
    let game = Game::pd3();
    split_judge(&game);
    let conn = index_with_companion(842, "not-these-bytes");
    let mut m = record("nexus:197:842", "048_Judge_P.pak", true);
    m.source = "nexus".into();
    m.file_id = Some(842);

    let rejoined = rejoin_split_companions(&game.path, game.cfg, &[], &[m], Some(&conn));

    assert_eq!(rejoined, 1);
}

// ── mark_container_missing ──────────────────────────────────────────────────

const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn write_pak(path: &Path, entries: &[&str]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let file = fs::File::create(path).unwrap();
    let mut writer =
        repak::PakBuilder::new().writer(file, repak::Version::V11, "../../../".into(), None);
    for entry in entries {
        writer.write_file(entry, false, b"asset").unwrap();
    }
    writer.write_index().unwrap();
}

fn flag(game: &Game, m: InstalledMod) -> Option<bool> {
    let mut mods = [m];
    mark_container_missing(&game.path, game.cfg, &[], &mut mods, KEY);
    let [m] = mods;
    m.container_missing
}

#[test]
fn a_stub_with_nothing_beside_it_is_flagged() {
    let game = Game::pd3();
    write_pak(&game.active().join("006_Portraits_P.pak"), &[]);

    assert_eq!(
        flag(&game, record("1", "006_Portraits_P.pak", true)),
        Some(true)
    );
}

#[test]
fn a_pak_with_its_own_assets_is_not_flagged() {
    let game = Game::pd3();
    write_pak(
        &game.active().join("005_Sounds.pak"),
        &["PAYDAY3/Content/Hit.uasset"],
    );

    assert_eq!(flag(&game, record("1", "005_Sounds.pak", true)), None);
}

#[test]
fn a_stub_with_its_companions_is_not_flagged() {
    let game = Game::pd3();
    write_pak(&game.disabled().join("048_Judge_P.pak.disabled"), &[]);
    companions(&game.disabled(), "048_Judge_P", ".disabled", "judge");

    assert_eq!(flag(&game, record("1", "048_Judge_P.pak", false)), None);
}

#[test]
fn the_flag_clears_once_the_companions_are_back() {
    let game = Game::pd3();
    write_pak(&game.active().join("006_Portraits_P.pak"), &[]);
    let mut stale = record("1", "006_Portraits_P.pak", true);
    stale.container_missing = Some(true);
    companions(&game.active(), "006_Portraits_P", "", "portraits");

    assert_eq!(flag(&game, stale), None);
}

#[test]
fn a_missing_pak_is_left_to_the_missing_flag() {
    let game = Game::pd3();
    let mut m = record("1", "006_Portraits_P.pak", true);
    m.missing = Some(true);

    assert_eq!(flag(&game, m), None);
}

// ── leftovers ───────────────────────────────────────────────────────────────

fn leftovers_fixture() -> Game {
    let game = Game::pd3();
    put(&game.active(), "002_Mine_P.pak", "stub");
    companions(&game.active(), "002_Mine_P", "", "mine");
    companions(&game.active(), "018_BagTracker_P", "", "bag");
    companions(
        &game.disabled().join("Skins"),
        "003_Old_P",
        ".disabled",
        "old",
    );
    game
}

#[test]
fn only_sets_no_pak_uses_are_leftovers() {
    let game = leftovers_fixture();

    let leftovers = leftover_sets(&game.path, game.cfg).unwrap();

    let names: Vec<(&str, &str, bool)> = leftovers
        .iter()
        .map(|l| (l.folder.as_str(), l.stem.as_str(), l.disabled))
        .collect();
    assert_eq!(
        names,
        vec![
            ("", "018_BagTracker_P", false),
            ("Skins", "003_Old_P", true)
        ]
    );
    assert_eq!(
        leftovers[0].files,
        vec!["018_BagTracker_P.ucas", "018_BagTracker_P.utoc"]
    );
    assert_eq!(
        leftovers[0].bytes,
        ("bag ucas".len() + "bag utoc".len()) as u64
    );
}

#[test]
fn deleting_a_leftover_removes_only_that_set() {
    let game = leftovers_fixture();
    let bag = leftover_sets(&game.path, game.cfg).unwrap().remove(0);

    delete_leftover_sets(&game.path, game.cfg, &[bag]).unwrap();

    assert!(!game.active().join("018_BagTracker_P.ucas").exists());
    assert!(!game.active().join("018_BagTracker_P.utoc").exists());
    assert!(game.active().join("002_Mine_P.ucas").exists());
    assert!(game
        .disabled()
        .join("Skins")
        .join("003_Old_P.ucas.disabled")
        .exists());
}

#[test]
fn a_set_a_pak_took_back_is_not_deleted() {
    let game = leftovers_fixture();
    let bag = leftover_sets(&game.path, game.cfg).unwrap().remove(0);
    put(&game.active(), "018_BagTracker_P.pak", "stub");

    let err = delete_leftover_sets(&game.path, game.cfg, &[bag]).unwrap_err();

    assert!(err.contains("018_BagTracker_P"), "{err}");
    assert!(game.active().join("018_BagTracker_P.ucas").exists());
}

#[test]
fn the_files_to_delete_come_from_the_scan_not_the_request() {
    let game = leftovers_fixture();
    let mut bag = leftover_sets(&game.path, game.cfg).unwrap().remove(0);
    bag.files = vec!["002_Mine_P.ucas".into()];

    delete_leftover_sets(&game.path, game.cfg, &[bag]).unwrap();

    assert!(game.active().join("002_Mine_P.ucas").exists());
    assert!(!game.active().join("018_BagTracker_P.ucas").exists());
}

#[test]
fn no_leftovers_are_listed_while_the_mods_folder_is_set_aside() {
    let game = leftovers_fixture();
    fs::create_dir_all(backup_dir(&game.path, game.cfg.primary())).unwrap();

    assert!(leftover_sets(&game.path, game.cfg).unwrap().is_empty());
}
