use super::*;
use tempfile::TempDir;

fn write_record(dir: &Path, file: &str, display_name: &str, location: &Path, app_name: &str) {
    let record = serde_json::json!({
        "DisplayName": display_name,
        "InstallLocation": location.to_str().unwrap(),
        "AppName": app_name,
    });
    fs::write(dir.join(file), record.to_string()).unwrap();
}

#[test]
fn launch_record_follows_the_selected_folder_not_the_first_name_match() {
    let manifests = TempDir::new().unwrap();
    let first = TempDir::new().unwrap();
    let second = TempDir::new().unwrap();
    write_record(manifests.path(), "a.item", "Game", first.path(), "first");
    write_record(manifests.path(), "b.item", "Game", second.path(), "second");

    let record =
        record_for_install(manifests.path(), "Game", second.path().to_str().unwrap()).unwrap();

    assert_eq!(record.app_name, "second");
}

#[test]
fn unreadable_records_of_other_games_do_not_hide_this_one() {
    let manifests = TempDir::new().unwrap();
    let game = TempDir::new().unwrap();
    fs::write(manifests.path().join("empty.item"), "").unwrap();
    fs::write(manifests.path().join("zeros.item"), [0u8; 64]).unwrap();
    write_record(manifests.path(), "game.item", "Game", game.path(), "game");

    let record =
        record_for_install(manifests.path(), "Game", game.path().to_str().unwrap()).unwrap();

    assert_eq!(record.app_name, "game");
}

#[test]
fn a_folder_without_its_own_record_is_refused() {
    let manifests = TempDir::new().unwrap();
    let recorded = TempDir::new().unwrap();
    let selected = TempDir::new().unwrap();
    write_record(manifests.path(), "a.item", "Game", recorded.path(), "game");

    let error = record_for_install(manifests.path(), "Game", selected.path().to_str().unwrap())
        .err()
        .unwrap();

    assert!(error.contains("could not be found"), "{error}");
}

#[test]
fn two_records_for_one_folder_are_refused() {
    let manifests = TempDir::new().unwrap();
    let game = TempDir::new().unwrap();
    write_record(manifests.path(), "a.item", "Game", game.path(), "one");
    write_record(manifests.path(), "b.item", "Game", game.path(), "two");

    let error = record_for_install(manifests.path(), "Game", game.path().to_str().unwrap())
        .err()
        .unwrap();

    assert!(error.contains("More than one"), "{error}");
}

#[test]
fn a_record_for_another_game_is_not_matched() {
    let manifests = TempDir::new().unwrap();
    let game = TempDir::new().unwrap();
    write_record(
        manifests.path(),
        "a.item",
        "Other Game",
        game.path(),
        "other",
    );

    assert!(record_for_install(manifests.path(), "Game", game.path().to_str().unwrap()).is_err());
}
