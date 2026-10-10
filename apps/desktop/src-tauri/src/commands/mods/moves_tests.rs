use super::*;
use crate::commands::mods::engine_for_game;
use std::fs;
use tempfile::TempDir;

fn pd3_paks() -> &'static ScanTarget {
    engine_for_game("pd3").unwrap().primary()
}

fn write_unit(dir: &Path, stem: &str, suffix: &str, tag: &str) {
    for ext in ["pak", "ucas", "utoc"] {
        fs::write(
            dir.join(format!("{stem}.{ext}{suffix}")),
            format!("{tag} {ext}"),
        )
        .unwrap();
    }
}

fn read(dir: &Path, name: &str) -> String {
    fs::read_to_string(dir.join(name)).unwrap()
}

#[test]
fn a_pak_moves_with_its_companions() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    write_unit(dir, "005_Mod_P", "", "mod");

    let mut moves = Moves::default();
    moves.unit(
        pd3_paks(),
        dir.join("005_Mod_P.pak"),
        dir.join("002_Mod_P.pak"),
    );
    moves.run().unwrap();

    for ext in ["pak", "ucas", "utoc"] {
        assert_eq!(read(dir, &format!("002_Mod_P.{ext}")), format!("mod {ext}"));
        assert!(!dir.join(format!("005_Mod_P.{ext}")).exists());
    }
}

#[test]
fn a_disabled_pak_moves_with_its_suffixed_companions() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    write_unit(dir, "005_Mod_P", ".disabled", "mod");

    let mut moves = Moves::default();
    moves.unit(
        pd3_paks(),
        dir.join("005_Mod_P.pak.disabled"),
        dir.join("002_Mod_P.pak.disabled"),
    );
    moves.run().unwrap();

    for ext in ["pak", "ucas", "utoc"] {
        assert_eq!(
            read(dir, &format!("002_Mod_P.{ext}.disabled")),
            format!("mod {ext}")
        );
    }
}

#[test]
fn a_pak_without_companions_moves_alone() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    fs::write(dir.join("005_Legacy.pak"), "legacy").unwrap();

    let mut moves = Moves::default();
    moves.unit(
        pd3_paks(),
        dir.join("005_Legacy.pak"),
        dir.join("001_Legacy.pak"),
    );
    moves.run().unwrap();

    assert_eq!(read(dir, "001_Legacy.pak"), "legacy");
    assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
}

#[test]
fn two_mods_of_one_published_name_can_swap() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    write_unit(dir, "001_Skin_P", "", "first");
    write_unit(dir, "002_Skin_P", "", "second");

    let mut moves = Moves::default();
    moves.unit(
        pd3_paks(),
        dir.join("001_Skin_P.pak"),
        dir.join("002_Skin_P.pak"),
    );
    moves.unit(
        pd3_paks(),
        dir.join("002_Skin_P.pak"),
        dir.join("001_Skin_P.pak"),
    );
    moves.run().unwrap();

    for ext in ["pak", "ucas", "utoc"] {
        assert_eq!(
            read(dir, &format!("002_Skin_P.{ext}")),
            format!("first {ext}")
        );
        assert_eq!(
            read(dir, &format!("001_Skin_P.{ext}")),
            format!("second {ext}")
        );
    }
    assert_eq!(fs::read_dir(dir).unwrap().count(), 6);
}

#[test]
fn a_file_in_the_way_stops_the_plan_before_anything_moves() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    write_unit(dir, "005_Mod_P", "", "mod");
    write_unit(dir, "004_Other_P", "", "other");
    fs::write(dir.join("002_Mod_P.ucas"), "stranger").unwrap();

    let mut moves = Moves::default();
    moves.unit(
        pd3_paks(),
        dir.join("004_Other_P.pak"),
        dir.join("003_Other_P.pak"),
    );
    moves.unit(
        pd3_paks(),
        dir.join("005_Mod_P.pak"),
        dir.join("002_Mod_P.pak"),
    );
    let err = moves.run().err().unwrap();

    assert!(err.contains("002_Mod_P.ucas"), "{err}");
    assert_eq!(read(dir, "004_Other_P.pak"), "other pak");
    assert_eq!(read(dir, "005_Mod_P.utoc"), "mod utoc");
    assert_eq!(read(dir, "002_Mod_P.ucas"), "stranger");
}

#[test]
fn two_moves_to_one_name_are_refused() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    fs::write(dir.join("a"), "a").unwrap();
    fs::write(dir.join("b"), "b").unwrap();

    let mut moves = Moves::default();
    moves.path(dir.join("a"), dir.join("c"));
    moves.path(dir.join("b"), dir.join("c"));

    assert!(moves.run().is_err());
    assert_eq!(read(dir, "a"), "a");
    assert_eq!(read(dir, "b"), "b");
}

#[test]
fn a_rename_that_fails_puts_every_file_back() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    write_unit(dir, "005_Mod_P", "", "mod");
    write_unit(dir, "004_Other_P", "", "other");

    let mut moves = Moves::default();
    moves.unit(
        pd3_paks(),
        dir.join("004_Other_P.pak"),
        dir.join("003_Other_P.pak"),
    );
    moves.unit(
        pd3_paks(),
        dir.join("005_Mod_P.pak"),
        dir.join("missing").join("002_Mod_P.pak"),
    );

    assert!(moves.run().is_err());
    for ext in ["pak", "ucas", "utoc"] {
        assert_eq!(
            read(dir, &format!("004_Other_P.{ext}")),
            format!("other {ext}")
        );
        assert_eq!(read(dir, &format!("005_Mod_P.{ext}")), format!("mod {ext}"));
    }
    assert_eq!(fs::read_dir(dir).unwrap().count(), 6);
}

#[test]
fn a_state_that_cannot_be_saved_puts_the_files_back() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    write_unit(dir, "005_Mod_P", "", "mod");
    fs::write(dir.join("not_a_dir"), "").unwrap();
    let state_path = dir.join("not_a_dir").join(".modrex.json");

    let mut moves = Moves::default();
    moves.unit(
        pd3_paks(),
        dir.join("005_Mod_P.pak"),
        dir.join("002_Mod_P.pak"),
    );
    let applied = moves.run().unwrap();

    assert!(applied.save(&state_path, &ModsState::default()).is_err());
    for ext in ["pak", "ucas", "utoc"] {
        assert_eq!(read(dir, &format!("005_Mod_P.{ext}")), format!("mod {ext}"));
        assert!(!dir.join(format!("002_Mod_P.{ext}")).exists());
    }
}
