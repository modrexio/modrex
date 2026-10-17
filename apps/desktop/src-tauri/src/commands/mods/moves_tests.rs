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

fn empty_app_folder_operation(game_id: &str, operation: &str) {
    use crate::commands::mods::folders::{
        create_folder_op, delete_folder_op, move_folder_op, rename_folder_op,
    };
    use crate::commands::mods::paths::get_state_path;
    use crate::commands::mods::reorder::reorder_children_op;
    use crate::commands::mods::state::{get_folder_path, read_state, reconcile_state};
    use crate::commands::mods::types::TopLevelItem;

    let cfg = engine_for_game(game_id).unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    let parent = create_folder_op(game, &sp, "Parent", None, cfg).unwrap();
    let parent_id = (operation == "delete").then(|| parent.id.clone());
    let empty = create_folder_op(game, &sp, "Empty", parent_id, cfg).unwrap();
    let before = read_state(&sp).unwrap();
    let old_rel = get_folder_path(&before.folders, Some(&empty.id)).unwrap();
    let active = mods_base(game, cfg.primary());
    let old_dir = active.join(&old_rel);
    assert!(old_dir.is_dir());
    let unrelated: Vec<_> = cfg
        .targets
        .iter()
        .skip(1)
        .flat_map(|target| [mods_base(game, target), disabled_base(game, target)])
        .map(|base| base.join(&old_rel))
        .collect();
    for dir in &unrelated {
        fs::create_dir_all(dir.join("empty/library")).unwrap();
        fs::write(dir.join("keep.lua"), b"loader library").unwrap();
    }

    match operation {
        "rename" => rename_folder_op(game, &sp, &empty.id, "Renamed", cfg).unwrap(),
        "move" => move_folder_op(game, &sp, &empty.id, Some(parent.id.clone()), cfg).unwrap(),
        "reorder" => reorder_children_op(
            game,
            &sp,
            None,
            &[
                TopLevelItem::Folder {
                    id: parent.id.clone(),
                },
                TopLevelItem::Folder {
                    id: empty.id.clone(),
                },
            ],
            cfg,
        )
        .unwrap(),
        "delete" => delete_folder_op(game, &sp, &parent.id, cfg).unwrap(),
        _ => unreachable!(),
    }

    let saved = read_state(&sp).unwrap();
    let new_rel = get_folder_path(&saved.folders, Some(&empty.id)).unwrap();
    let new_dir = active.join(&new_rel);
    assert!(
        new_dir.is_dir(),
        "{game_id} {operation}: directory missing at {new_rel}"
    );
    if old_dir != new_dir {
        assert!(
            !old_dir.exists(),
            "{game_id} {operation}: source directory remains"
        );
    }
    for dir in &unrelated {
        assert_eq!(fs::read(dir.join("keep.lua")).unwrap(), b"loader library");
        assert!(dir.join("empty/library").is_dir());
    }
    let reloaded = reconcile_state(game, &sp, cfg).unwrap();
    let folder = reloaded
        .folders
        .iter()
        .find(|folder| folder.id == empty.id)
        .expect("the empty app folder must survive a reload");
    let reloaded_rel = get_folder_path(&reloaded.folders, Some(&empty.id)).unwrap();
    assert!(active.join(reloaded_rel).is_dir());
    match operation {
        "rename" => assert_eq!(folder.display_name, "Renamed"),
        "move" => assert_eq!(folder.parent_id.as_deref(), Some(parent.id.as_str())),
        "reorder" => assert!(
            folder.priority
                < reloaded
                    .folders
                    .iter()
                    .find(|folder| folder.id == parent.id)
                    .unwrap()
                    .priority
        ),
        "delete" => {
            assert_eq!(folder.parent_id, None);
            assert!(!reloaded.folders.iter().any(|folder| folder.id == parent.id));
            assert!(!active.join(&parent.disk_name).exists());
        }
        _ => unreachable!(),
    }
}

#[test]
fn empty_app_folder_pd3_rename() {
    empty_app_folder_operation("pd3", "rename");
}
#[test]
fn empty_app_folder_raid_rename() {
    empty_app_folder_operation("raid", "rename");
}
#[test]
fn empty_app_folder_pd3_move() {
    empty_app_folder_operation("pd3", "move");
}
#[test]
fn empty_app_folder_raid_move() {
    empty_app_folder_operation("raid", "move");
}
#[test]
fn empty_app_folder_pd3_reorder() {
    empty_app_folder_operation("pd3", "reorder");
}
#[test]
fn empty_app_folder_raid_reorder() {
    empty_app_folder_operation("raid", "reorder");
}
#[test]
fn empty_app_folder_pd3_delete() {
    empty_app_folder_operation("pd3", "delete");
}
#[test]
fn empty_app_folder_raid_delete() {
    empty_app_folder_operation("raid", "delete");
}

#[test]
fn duplicate_sources_are_refused_before_any_files_move() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    fs::write(dir.join("source.pak"), b"source").unwrap();
    let mut moves = Moves::default();
    moves.path(dir.join("source.pak"), dir.join("first.pak"));
    moves.path(dir.join("source.pak"), dir.join("second.pak"));
    assert!(moves.run().err().unwrap().contains("same mod file"));
    assert_eq!(fs::read(dir.join("source.pak")).unwrap(), b"source");
    assert!(!dir.join("first.pak").exists());
}

#[test]
fn existing_aliases_of_moved_files_are_allowed() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    fs::create_dir(dir.join("alias")).unwrap();
    fs::write(dir.join("a.pak"), b"a").unwrap();
    fs::write(dir.join("b.pak"), b"b").unwrap();

    let mut moves = Moves::default();
    moves.path(dir.join("a.pak"), dir.join("alias/../b.pak"));
    moves.path(dir.join("b.pak"), dir.join("alias/../a.pak"));
    moves.run().unwrap();

    assert_eq!(fs::read(dir.join("a.pak")).unwrap(), b"b");
    assert_eq!(fs::read(dir.join("b.pak")).unwrap(), b"a");
}

#[test]
fn a_foreign_file_alias_is_refused_after_a_source_alias() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    fs::create_dir(dir.join("alias")).unwrap();
    fs::write(dir.join("a.pak"), b"a").unwrap();
    fs::write(dir.join("b.pak"), b"b").unwrap();
    fs::write(dir.join("foreign.pak"), b"foreign").unwrap();

    let mut moves = Moves::default();
    moves.path(dir.join("a.pak"), dir.join("alias/../a.pak"));
    moves.path(dir.join("b.pak"), dir.join("alias/../foreign.pak"));
    assert!(moves.run().err().unwrap().contains("in the way"));

    assert_eq!(fs::read(dir.join("a.pak")).unwrap(), b"a");
    assert_eq!(fs::read(dir.join("b.pak")).unwrap(), b"b");
    assert_eq!(fs::read(dir.join("foreign.pak")).unwrap(), b"foreign");
}

#[cfg(windows)]
#[test]
fn windows_case_only_self_rename_is_allowed() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    fs::write(dir.join("Skin.pak"), b"source").unwrap();
    let mut moves = Moves::default();
    moves.path(dir.join("Skin.pak"), dir.join("skin.PAK"));
    moves.run().unwrap();
    assert_eq!(fs::read(dir.join("skin.PAK")).unwrap(), b"source");
    let name = fs::read_dir(dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name();
    assert_eq!(name, "skin.PAK");
}

#[cfg(windows)]
#[test]
fn windows_destination_names_ignore_case() {
    for (first, second) in [("Skin.pak", "skin.PAK"), ("\u{00c4}.pak", "\u{00e4}.PAK")] {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("a.pak"), b"a").unwrap();
        fs::write(dir.join("b.pak"), b"b").unwrap();
        let mut moves = Moves::default();
        moves.path(dir.join("a.pak"), dir.join(first));
        moves.path(dir.join("b.pak"), dir.join(second));
        assert!(
            moves.run().err().unwrap().contains("same destination"),
            "{first} {second}"
        );
        assert_eq!(fs::read(dir.join("a.pak")).unwrap(), b"a");
        assert_eq!(fs::read(dir.join("b.pak")).unwrap(), b"b");
    }
}

#[cfg(windows)]
#[test]
fn windows_existing_ancestor_aliases_are_refused() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    let from = dir.join("source.pak");
    fs::write(&from, b"source").unwrap();
    let mut moves = Moves::default();
    moves.path(from.clone(), dir.join("first.pak"));
    moves.path(dir.join("SOURCE.PAK"), dir.join("second.pak"));
    assert!(moves.run().err().unwrap().contains("same mod file"));
    assert_eq!(fs::read(from).unwrap(), b"source");
}
