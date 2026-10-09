use super::*;
use crate::game_package::{ConfigLocation, Storefront};
use std::fs;

#[test]
fn only_declared_games_can_access_graphics_configs() {
    for id in ["pd2", "pdth", "raid"] {
        assert!(graphics_config(id).is_ok());
    }
    assert!(graphics_config("pd3")
        .unwrap_err()
        .contains("not supported"));
    assert!(graphics_config("not-a-game")
        .unwrap_err()
        .contains("unknown game"));
}

#[test]
fn declared_config_locations_require_the_matching_store_and_platform() {
    let locations = [ConfigLocation::WindowsLocalAppData {
        store: Storefront::Steam,
        path: vec!["GraphicsConfigFixture".into(), "renderer.xml".into()],
    }];
    #[cfg(windows)]
    assert!(declared_config_path(&locations, Some("steam"))
        .unwrap()
        .unwrap()
        .ends_with("GraphicsConfigFixture/renderer.xml"));
    #[cfg(not(windows))]
    assert!(declared_config_path(&locations, Some("steam"))
        .unwrap()
        .is_none());
    for store in [None, Some("epic"), Some("xbox"), Some("manual")] {
        assert!(declared_config_path(&locations, store).unwrap().is_none());
    }
    assert!(declared_config_path(&[], Some("steam")).unwrap().is_none());
}

#[test]
fn missing_dx11_config_does_not_fall_back_to_a_legacy_file_or_create_anything() {
    let temp = tempfile::tempdir().unwrap();
    let legacy = temp.path().join("renderer_settings.xml");
    fs::write(&legacy, b"legacy display settings").unwrap();
    let current = temp.path().join("renderer_settings_dx11.xml");
    assert!(matches!(
        inspect(GraphicsDestination { path: current.clone(), chosen: false }, "renderer_settings_dx11.xml").unwrap(),
        ConfigFileLocation::Missing { path } if path == display_path(&current)
    ));
    assert!(!current.exists());
    assert_eq!(fs::read(&legacy).unwrap(), b"legacy display settings");
    let absent_parent = temp.path().join("not-created/renderer_settings_dx11.xml");
    assert!(matches!(
        inspect(
            GraphicsDestination {
                path: absent_parent.clone(),
                chosen: false
            },
            "renderer_settings_dx11.xml"
        )
        .unwrap(),
        ConfigFileLocation::Missing { .. }
    ));
    assert!(!absent_parent.parent().unwrap().exists());
}

#[test]
fn existing_config_is_reported_without_changing_its_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("renderer_settings_dx11.xml");
    let content = b"<renderer_config>\r\n</renderer_config>\r\n";
    fs::write(&path, content).unwrap();
    let canonical = path.canonicalize().unwrap();
    assert!(matches!(
        inspect(GraphicsDestination { path: canonical.clone(), chosen: true }, "renderer_settings_dx11.xml").unwrap(),
        ConfigFileLocation::Found { path } if path == display_path(&canonical)
    ));
    assert_eq!(fs::read(&path).unwrap(), content);
}

#[test]
fn choosing_a_file_requires_the_declared_name_and_an_existing_regular_file() {
    let temp = tempfile::tempdir().unwrap();
    let wrong_name = temp.path().join("renderer_settings.xml");
    fs::write(&wrong_name, b"legacy").unwrap();
    assert!(validate_file(&wrong_name, "renderer_settings_dx11.xml")
        .unwrap_err()
        .contains("Choose a file named"));
    let path = temp.path().join("renderer_settings_dx11.xml");
    assert!(validate_file(&path, "renderer_settings_dx11.xml")
        .unwrap_err()
        .contains("Could not open"));
    assert!(!path.exists());
    fs::create_dir(&path).unwrap();
    assert!(validate_file(&path, "renderer_settings_dx11.xml")
        .unwrap_err()
        .contains("not a regular file"));
    fs::remove_dir(&path).unwrap();
    fs::write(&path, b"current").unwrap();
    assert_eq!(
        validate_file(&path, "renderer_settings_dx11.xml").unwrap(),
        path.canonicalize().unwrap()
    );
    assert_eq!(fs::read(&wrong_name).unwrap(), b"legacy");
    assert_eq!(fs::read(&path).unwrap(), b"current");
}

#[cfg(unix)]
#[test]
fn a_chosen_config_is_rejected_after_its_folder_points_somewhere_else() {
    let temp = tempfile::tempdir().unwrap();
    let filename = "renderer_settings.xml";
    let selected_folder = temp.path().join("selected");
    let other_folder = temp.path().join("other");
    fs::create_dir(&selected_folder).unwrap();
    fs::create_dir(&other_folder).unwrap();
    fs::write(selected_folder.join(filename), b"selected display").unwrap();
    fs::write(other_folder.join(filename), b"other display").unwrap();
    let selected = selected_folder.join(filename).canonicalize().unwrap();
    let retired_folder = temp.path().join("retired");
    fs::rename(&selected_folder, &retired_folder).unwrap();
    std::os::unix::fs::symlink(&other_folder, &selected_folder).unwrap();
    let destination = GraphicsDestination {
        path: selected,
        chosen: true,
    };
    assert!(destination
        .validate(filename)
        .unwrap_err()
        .contains("somewhere else"));
    assert!(inspect(destination, filename)
        .unwrap_err()
        .contains("somewhere else"));
    assert_eq!(
        fs::read(retired_folder.join(filename)).unwrap(),
        b"selected display"
    );
    assert_eq!(
        fs::read(other_folder.join(filename)).unwrap(),
        b"other display"
    );
}

#[test]
fn manually_chosen_locations_are_invalidated_when_install_or_store_changes() {
    let original = InstallContext {
        game_id: "pd2".into(),
        game_path: "game".into(),
        canonical_game_path: "physical game".into(),
        launcher: Some("steam".into()),
    };
    let mut changed_game_path = original.clone();
    changed_game_path.game_path = "other game".into();
    let mut changed_physical_path = original.clone();
    changed_physical_path.canonical_game_path = "another physical game".into();
    let mut changed_store = original.clone();
    changed_store.launcher = Some("epic".into());
    for changed in [changed_game_path, changed_physical_path, changed_store] {
        let locations = GraphicsConfigLocations::default();
        let path = PathBuf::from("chosen/renderer_settings_dx11.xml");
        locations.0.lock().unwrap().insert(
            original.game_id.clone(),
            PickedConfig {
                context: original.clone(),
                path: path.clone(),
            },
        );
        assert_eq!(locations.for_context(&original), Some(path));
        assert!(locations.for_context(&changed).is_none());
        assert!(locations.for_context(&original).is_none());
    }
}

#[test]
fn app_picker_fallback_is_limited_to_missing_or_incomplete_associations() {
    for (code, shell_code) in [(1155, 0), (0, 27), (0, 31)] {
        assert!(needs_app_choice(code, shell_code));
    }
    for (code, shell_code) in [
        (5, 5),
        (2, 2),
        (1223, 0),
        (0, 29),
        (5, 31),
        (2, 27),
        (1223, 31),
    ] {
        assert!(!needs_app_choice(code, shell_code));
    }
}

#[cfg(unix)]
#[test]
fn symlinked_config_files_are_not_opened_through_a_different_target() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("other.xml");
    fs::write(&target, b"untouched").unwrap();
    let selected = temp.path().join("renderer_settings.xml");
    std::os::unix::fs::symlink(&target, &selected).unwrap();
    assert!(validate_file(&selected, "renderer_settings.xml")
        .unwrap_err()
        .contains("not a regular file"));
    assert_eq!(fs::read(&target).unwrap(), b"untouched");
}
