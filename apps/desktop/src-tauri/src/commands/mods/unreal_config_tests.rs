use super::*;
use crate::game_package::ConfigLocation;
use filetime::{set_file_mtime, FileTime};

fn marker(root: &Path, name: &str, seconds: i64) -> PathBuf {
    let directory = root.join(name);
    std::fs::create_dir_all(&directory).unwrap();
    let marker = directory.join("GameUserSettings.ini");
    std::fs::write(&marker, "[Settings]\n").unwrap();
    set_file_mtime(&marker, FileTime::from_unix_time(seconds, 0)).unwrap();
    directory.canonicalize().unwrap()
}

#[test]
fn newest_marker_wins_and_is_resolved_again_without_platform_names() {
    let temp = tempfile::tempdir().unwrap();
    let old = marker(temp.path(), "WindowsClient", 100);
    let current = marker(temp.path(), "Windows", 200);
    assert_eq!(discover(temp.path()).unwrap(), Some(current.clone()));
    assert!(!current.join("Engine.ini").exists());
    let future = marker(temp.path(), "FuturePlatform42", 300);
    assert_eq!(discover(temp.path()).unwrap(), Some(future));
    set_file_mtime(
        old.join("GameUserSettings.ini"),
        FileTime::from_unix_time(400, 0),
    )
    .unwrap();
    assert_eq!(discover(temp.path()).unwrap(), Some(old));
}

#[test]
fn ties_and_missing_markers_have_no_automatic_answer() {
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(discover(temp.path()).unwrap(), None);
    marker(temp.path(), "Nested/Platform", 500);
    std::fs::create_dir(temp.path().join("Windows")).unwrap();
    std::fs::write(temp.path().join("Windows/Engine.ini"), "").unwrap();
    assert_eq!(discover(temp.path()).unwrap(), None);
    marker(temp.path(), "Windows", 100);
    marker(temp.path(), "WindowsClient", 100);
    assert_eq!(discover(temp.path()).unwrap(), None);
    assert_eq!(discover(&temp.path().join("absent")).unwrap(), None);
}

#[test]
fn malformed_roots_and_markers_surface_errors() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("file");
    std::fs::write(&file, "").unwrap();
    assert!(discover(&file).is_err());
    std::fs::create_dir_all(temp.path().join("Windows/GameUserSettings.ini")).unwrap();
    assert!(discover(temp.path()).unwrap_err().contains("regular"));
}

#[test]
fn wrong_store_has_no_automatic_directory() {
    assert_eq!(automatic_directory("pd3", Some("epic")).unwrap(), None);
    assert_eq!(automatic_directory("pd3", Some("xbox")).unwrap(), None);
    assert_eq!(automatic_directory("cb", Some("epic")).unwrap(), None);
    let root = game_spec("cb").unwrap().unreal_config.unwrap();
    assert!(
        matches!(&root.roots[0], ConfigLocation::WindowsUserProfile { path, .. }
        if path == &["Saved Games", "CrimeBoss", "Steam", "Saved", "Config"])
    );
}

#[cfg(windows)]
#[test]
fn directory_junction_is_refused_even_when_another_marker_is_valid() {
    use std::os::windows::process::CommandExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Config");
    marker(&root, "Windows", 100);
    let target = temp.path().join("elsewhere");
    std::fs::create_dir(&target).unwrap();
    let junction = root.join("Linked");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert!(discover(&root).unwrap_err().contains("linked"));
    std::fs::remove_dir(junction).unwrap();
}

#[cfg(unix)]
#[test]
fn linked_marker_is_refused_even_when_another_marker_is_valid() {
    let temp = tempfile::tempdir().unwrap();
    marker(temp.path(), "Windows", 100);
    let target = temp.path().join("target");
    std::fs::write(&target, "").unwrap();
    let directory = temp.path().join("Linked");
    std::fs::create_dir(&directory).unwrap();
    std::os::unix::fs::symlink(target, directory.join("GameUserSettings.ini")).unwrap();
    assert!(discover(temp.path()).unwrap_err().contains("linked"));
}

#[test]
fn picks_persist_only_without_an_automatic_answer_and_bind_to_install_and_store() {
    let temp = tempfile::tempdir().unwrap();
    let directory = marker(temp.path(), "Windows", 100);
    let mut context = InstallContext {
        game_id: "pd3".into(),
        game_path: "install".into(),
        canonical_game_path: "first".into(),
        launcher: Some("epic".into()),
    };
    assert!(persistent_pick(&context, &directory, Some(directory.clone())).is_none());
    let first = persistent_pick(&context, &directory, None).unwrap();
    context.launcher = Some("xbox".into());
    let other_store = persistent_pick(&context, &directory, None).unwrap();
    context.canonical_game_path = "second".into();
    let other_install = persistent_pick(&context, &directory, None).unwrap();
    assert_ne!(first, other_store);
    assert_ne!(other_store, other_install);
    assert_eq!(other_install.directory, directory.to_string_lossy());
}

#[test]
fn session_pick_overrides_automatic_and_persisted_pick_only_applies_without_an_answer() {
    let temp = tempfile::tempdir().unwrap();
    let automatic = marker(temp.path(), "Windows", 100);
    let picked = marker(temp.path(), "Picked", 200);
    assert_eq!(
        select_directory(
            Some(picked.clone()),
            || panic!("session wins"),
            || panic!("session wins")
        )
        .unwrap(),
        Some((picked.clone(), true))
    );
    assert_eq!(
        select_directory(
            None,
            || Ok(Some(automatic.clone())),
            || panic!("automatic wins")
        )
        .unwrap(),
        Some((automatic, false))
    );
    assert_eq!(
        select_directory(None, || Ok(None), || Ok(Some(picked.clone()))).unwrap(),
        Some((picked, true))
    );
    assert!(select_directory(
        None,
        || Err("marker metadata unavailable".into()),
        || panic!("errors must surface")
    )
    .is_err());
}

#[test]
fn invalid_or_retargeted_remembered_folders_do_not_fall_back() {
    assert!(
        select_directory(None, || Ok(None), || Ok(Some(PathBuf::from("relative"))))
            .unwrap_err()
            .contains("absolute")
    );
    let temp = tempfile::tempdir().unwrap();
    let missing = temp.path().join("missing");
    assert!(select_directory(None, || Ok(None), || Ok(Some(missing))).is_err());
}
