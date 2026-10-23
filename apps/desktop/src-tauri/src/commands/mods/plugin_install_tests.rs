//! PAYDAY 3 plugin mods end to end: how a download is routed, what the scan finds and what a
//! plugin install removes from the pak folder. Archive shapes follow the modworkshop survey.

use super::*;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::{NamedTempFile, TempDir};

fn make_zip(entries: &[(&str, &[u8])]) -> NamedTempFile {
    let f = NamedTempFile::new().unwrap();
    let mut zip = ::zip::ZipWriter::new(File::create(f.path()).unwrap());
    let opts = ::zip::write::SimpleFileOptions::default();
    for (name, data) in entries {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap();
    f
}

fn resolve(zip: &NamedTempFile) -> Result<staged::Staged, ResolveError> {
    resolve_archive_download(
        zip.path().to_path_buf(),
        engine_for_game("pd3").unwrap(),
        &StagingRegistry::new(),
    )
}

#[test]
fn a_forged_zip_installs_as_a_folder_named_after_its_descriptor() {
    let zip = make_zip(&[
        ("CustomPing.uplugin", b"{}"),
        ("Resources/Icon128.png", b"png"),
        ("Content/Paks/Windows/CustomPing_P.pak", b"pak"),
        ("Content/Paks/Windows/CustomPing_P.utoc", b"toc"),
        ("Content/Paks/WinGDK/CustomPing_P.pak", b"pak"),
    ]);
    let staged = resolve(&zip).unwrap();
    assert_eq!(staged.target_tag.as_deref(), Some("plugins"));
    assert_eq!(staged.root.file_name().unwrap(), "CustomPing");
    assert!(staged.root.join("CustomPing.uplugin").is_file());
    assert!(staged.root.join("Resources/Icon128.png").is_file());
    assert!(staged
        .root
        .join("Content/Paks/WinGDK/CustomPing_P.pak")
        .is_file());
}

#[test]
fn a_wrapper_named_unlike_the_plugin_is_not_the_installed_name() {
    let zip = make_zip(&[
        ("Download v2/CustomFOV.uplugin", b"{}"),
        ("Download v2/Content/Paks/Windows/CustomFOV_P.pak", b"pak"),
        ("readme.txt", b"outside the plugin"),
    ]);
    let staged = resolve(&zip).unwrap();
    assert_eq!(staged.root.file_name().unwrap(), "CustomFOV");
    assert!(staged
        .root
        .join("Content/Paks/Windows/CustomFOV_P.pak")
        .is_file());
    assert!(!staged.root.join("readme.txt").exists());
}

/// Jumpscare ships its movie inside the plugin, where it belongs, rather than as a movie
/// replacement for the game's own slots.
#[test]
fn a_movie_inside_a_plugin_stays_part_of_the_plugin() {
    let zip = make_zip(&[
        ("Jumpscare/Jumpscare.uplugin", b"{}"),
        ("Jumpscare/Jumpscare.bk2", b"movie"),
        ("Jumpscare/Content/Paks/Windows/Jumpscare_P.pak", b"pak"),
    ]);
    let staged = resolve(&zip).unwrap();
    assert_eq!(staged.target_tag.as_deref(), Some("plugins"));
    assert!(staged.root.join("Jumpscare.bk2").is_file());
}

#[test]
fn a_source_project_upload_is_refused() {
    let zip = make_zip(&[
        ("Armor_Timer/Armor_Timer.uplugin", b"{}"),
        ("Armor_Timer/Content/BP_Armor_Timer.uasset", b"uasset"),
    ]);
    let err = resolve(&zip).unwrap_err();
    assert!(
        matches!(err, ResolveError::Failure(ref m) if m.contains("source project")),
        "{err:?}"
    );
}

#[test]
fn an_archive_of_several_plugins_asks_which_to_install() {
    let zip = make_zip(&[
        ("Thin/Thin.uplugin", b"{}"),
        ("Thin/Content/Paks/Windows/Thin_P.pak", b"pak"),
        ("Variants/Wide/Wide.uplugin", b"{}"),
        ("Variants/Wide/Content/Paks/Windows/Wide_P.pak", b"pak"),
    ]);
    let Err(ResolveError::Prompt(prompt)) = resolve(&zip) else {
        panic!("expected a picker");
    };
    let InstallPrompt::ZipMultiPak(payload) = *prompt else {
        panic!("expected a picker");
    };
    assert_eq!(payload.target_tag.as_deref(), Some("plugins"));
    assert_eq!(payload.entries, vec!["Thin", "Variants/Wide"]);
}

#[test]
fn loose_paks_still_install_into_the_pak_folder() {
    let zip = make_zip(&[("Thing_P.pak", b"pak"), ("Thing_P.utoc", b"toc")]);
    let staged = resolve(&zip).unwrap();
    assert_eq!(staged.target_tag, None);
}

fn place(root: &Path, relative: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"x").unwrap();
}

#[tokio::test]
async fn the_scan_finds_plugins_where_the_game_loads_them() {
    let tmp = TempDir::new().unwrap();
    place(tmp.path(), "PAYDAY3/Mods/PDML/PDML.uplugin");
    place(tmp.path(), "PAYDAY3/Mods/Group/BetaHUD/BetaHUD.uplugin");
    place(tmp.path(), "PAYDAY3/Mods/Group/notes.txt");
    place(
        tmp.path(),
        "PAYDAY3/Mods.disabled/CustomPing/CustomPing.uplugin",
    );
    let cfg = engine_for_game("pd3").unwrap();
    let mut found: Vec<(String, bool)> =
        find_untracked_paks(tmp.path().to_str().unwrap(), &HashSet::new(), cfg)
            .await
            .into_iter()
            .filter(|(_, _, tag)| tag.as_deref() == Some("plugins"))
            .map(|(path, enabled, _)| (path, enabled))
            .collect();
    found.sort();
    assert_eq!(
        found,
        vec![
            ("CustomPing".to_string(), false),
            ("Group/BetaHUD".to_string(), true),
            ("PDML".to_string(), true),
        ]
    );
}

fn misplaced_pak(uid: &str, filename: &str, folder_id: Option<String>) -> InstalledMod {
    InstalledMod {
        uid: uid.to_string(),
        name: "Custom Ping".to_string(),
        filename: filename.to_string(),
        enabled: true,
        folder_id,
        file_id: Some(104639),
        ..InstalledMod::from_catalog(
            "modworkshop",
            "59527".to_string(),
            IdentityEvidence::InstallProvenance,
        )
    }
}

#[test]
fn a_plugin_install_removes_the_mods_loose_paks_and_their_emptied_folder() {
    let cfg = engine_for_game("pd3").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    let folder = create_folder_op(game, &sp, "Windows", None, cfg).unwrap();
    let source = tmp.path().join("staged.pak");
    fs::write(&source, b"pak").unwrap();
    install_mod_from_path(
        game,
        &sp,
        misplaced_pak(
            "104639_CustomPing_P",
            "CustomPing_P.pak",
            Some(folder.id.clone()),
        ),
        &source,
        Some(folder.id.clone()),
        cfg,
        cfg.primary(),
    )
    .unwrap();
    let saved = read_state(&sp).unwrap();
    let installed = &saved.mods[0];
    let folder_dir = mods_base(game, cfg.primary()).join(&saved.folders[0].disk_name);
    assert!(folder_dir.join(&installed.filename).is_file());

    let plugins = cfg.target_for(Some("plugins"));
    let aside =
        plugin_repair::set_aside_superseded_paks(game, &sp, cfg, plugins, Some("59527")).unwrap();
    assert!(!aside.all_disabled);
    assert!(!folder_dir.join(&installed.filename).exists());
    aside.commit();

    let saved = read_state(&sp).unwrap();
    assert!(saved.mods.is_empty());
    assert!(saved.folders.is_empty());
    assert!(!folder_dir.exists());
}

#[test]
fn installing_into_the_pak_folder_leaves_other_paks_alone() {
    let cfg = engine_for_game("pd3").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    let source = tmp.path().join("staged.pak");
    fs::write(&source, b"pak").unwrap();
    install_mod_from_path(
        game,
        &sp,
        misplaced_pak("104639", "CustomPing_P.pak", None),
        &source,
        None,
        cfg,
        cfg.primary(),
    )
    .unwrap();

    drop(
        plugin_repair::set_aside_superseded_paks(game, &sp, cfg, cfg.primary(), Some("59527"))
            .unwrap(),
    );
    assert_eq!(read_state(&sp).unwrap().mods.len(), 1);
}

#[test]
fn a_source_project_beside_a_usable_pak_leaves_the_pak_installable() {
    let zip = make_zip(&[
        ("Thing_P.pak", b"pak"),
        ("Source/Source.uplugin", b"{}"),
        ("Source/Content/BP_Thing.uasset", b"uasset"),
    ]);
    let staged = resolve(&zip).unwrap();
    assert_eq!(staged.target_tag, None);
}

#[test]
fn a_loose_pak_outside_the_plugin_is_offered_beside_it() {
    let zip = make_zip(&[
        ("Plugin/Plugin.uplugin", b"{}"),
        ("Plugin/Content/Paks/Windows/Plugin_P.pak", b"pak"),
        ("Runtime_P.pak", b"pak"),
    ]);
    let Err(ResolveError::Prompt(prompt)) = resolve(&zip) else {
        panic!("expected a picker");
    };
    let InstallPrompt::ZipMultiPak(payload) = *prompt else {
        panic!("expected a picker");
    };
    assert_eq!(payload.entries, vec!["Plugin", "Runtime_P.pak"]);
    assert_eq!(
        payload.entry_tags,
        Some(vec![Some("plugins".to_string()), None])
    );
}

#[tokio::test]
async fn a_plugin_folder_named_disabled_is_still_found() {
    let tmp = TempDir::new().unwrap();
    place(tmp.path(), "PAYDAY3/Mods/disabled/Foo/Foo.uplugin");
    let cfg = engine_for_game("pd3").unwrap();
    let found: Vec<String> =
        find_untracked_paks(tmp.path().to_str().unwrap(), &HashSet::new(), cfg)
            .await
            .into_iter()
            .filter(|(_, _, tag)| tag.as_deref() == Some("plugins"))
            .map(|(path, _, _)| path)
            .collect();
    assert_eq!(found, vec!["disabled/Foo"]);
}

fn staged_plugin(root: &Path, name: &str, payload: &[u8]) -> PathBuf {
    let dir = root.join("staged").join(name);
    place(&dir, &format!("{name}.uplugin"));
    fs::write(dir.join(format!("{name}.uplugin")), payload).unwrap();
    place(&dir, &format!("Content/Paks/Windows/{name}_P.pak"));
    dir
}

fn plugin_record(uid: &str, folder: &str) -> InstalledMod {
    InstalledMod {
        uid: uid.to_string(),
        name: folder.to_string(),
        filename: folder.to_string(),
        enabled: true,
        ..InstalledMod::default()
    }
}

#[test]
fn a_failed_plugin_copy_puts_the_previous_release_back() {
    let cfg = engine_for_game("pd3").unwrap();
    let plugins = cfg.target_for(Some("plugins"));
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    let v1 = staged_plugin(tmp.path(), "Foo", b"v1");
    install_mod_from_path(
        game,
        &sp,
        plugin_record("1", "Foo"),
        &v1,
        None,
        cfg,
        plugins,
    )
    .unwrap();

    let missing = tmp.path().join("no-such-source");
    let err = install_mod_from_path(
        game,
        &sp,
        plugin_record("2", "Foo"),
        &missing,
        None,
        cfg,
        plugins,
    )
    .unwrap_err();

    assert!(err.contains("could not install Foo"), "{err}");
    let installed = mods_base(game, plugins).join("Foo/Foo.uplugin");
    assert_eq!(fs::read(installed).unwrap(), b"v1");
    let saved = read_state(&sp).unwrap();
    assert_eq!(saved.mods.len(), 1);
    assert_eq!(saved.mods[0].uid, "1");
}

#[test]
fn a_new_release_in_the_same_plugin_folder_replaces_the_old_record() {
    let cfg = engine_for_game("pd3").unwrap();
    let plugins = cfg.target_for(Some("plugins"));
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    let v1 = staged_plugin(tmp.path(), "Foo", b"v1");
    install_mod_from_path(
        game,
        &sp,
        plugin_record("1", "Foo"),
        &v1,
        None,
        cfg,
        plugins,
    )
    .unwrap();
    disable_mod_op(game, &sp, "1", cfg, None).unwrap();

    let v2 = staged_plugin(&tmp.path().join("v2"), "Foo", b"v2");
    install_mod_from_path(
        game,
        &sp,
        plugin_record("2", "Foo"),
        &v2,
        None,
        cfg,
        plugins,
    )
    .unwrap();

    let saved = read_state(&sp).unwrap();
    assert_eq!(saved.mods.len(), 1);
    assert_eq!(saved.mods[0].uid, "2");
    assert!(!disabled_base(game, plugins).join("Foo").exists());
    assert_eq!(
        fs::read(mods_base(game, plugins).join("Foo/Foo.uplugin")).unwrap(),
        b"v2"
    );
}

#[test]
fn a_replaced_disabled_plugin_and_later_picks_from_its_file_stay_disabled() {
    let cfg = engine_for_game("pd3").unwrap();
    let plugins = cfg.target_for(Some("plugins"));
    let disabled = |uid: &str, folder: &str, file_id: i64| InstalledMod {
        enabled: false,
        location: Some("plugins".to_string()),
        file_id: Some(file_id),
        ..plugin_record(uid, folder)
    };
    let mods = [disabled("10_Thin", "Thin", 10)];
    assert!(plugin_repair::installs_disabled(
        cfg, &mods, plugins, "x", "Thin", 99, false
    ));
    assert!(plugin_repair::installs_disabled(
        cfg, &mods, plugins, "10_Wide", "Wide", 10, false
    ));
    assert!(!plugin_repair::installs_disabled(
        cfg, &mods, plugins, "20", "Other", 20, false
    ));
    assert!(plugin_repair::installs_disabled(
        cfg,
        &[],
        plugins,
        "20",
        "Other",
        20,
        true
    ));
    assert!(!plugin_repair::installs_disabled(
        cfg,
        &mods,
        cfg.primary(),
        "x",
        "Thin",
        10,
        false
    ));
}

/// Windows refuses to delete a file another process holds open without delete sharing, which
/// is what a running game does to its paks.
#[cfg(windows)]
#[test]
fn a_loose_pak_that_cannot_be_removed_stops_the_plugin_install() {
    use std::os::windows::fs::OpenOptionsExt;
    let cfg = engine_for_game("pd3").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    let source = tmp.path().join("staged.pak");
    fs::write(&source, b"pak").unwrap();
    install_mod_from_path(
        game,
        &sp,
        misplaced_pak("104639", "CustomPing_P.pak", None),
        &source,
        None,
        cfg,
        cfg.primary(),
    )
    .unwrap();
    let installed = read_state(&sp).unwrap().mods[0].filename.clone();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(mods_base(game, cfg.primary()).join(&installed))
        .unwrap();

    let plugins = cfg.target_for(Some("plugins"));
    let err = plugin_repair::set_aside_superseded_paks(game, &sp, cfg, plugins, Some("59527"))
        .err()
        .unwrap();

    assert!(err.contains("Close the game"), "{err}");
    assert_eq!(read_state(&sp).unwrap().mods.len(), 1);
    drop(held);
}

/// A plugin install that fails after the paks were set aside must leave the loose install as
/// it found it.
#[test]
fn a_failed_plugin_install_puts_the_set_aside_paks_back() {
    let cfg = engine_for_game("pd3").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    let folder = create_folder_op(game, &sp, "Windows", None, cfg).unwrap();
    let source = tmp.path().join("staged.pak");
    fs::write(&source, b"pak").unwrap();
    fs::write(tmp.path().join("staged.utoc"), b"toc").unwrap();
    install_mod_from_path(
        game,
        &sp,
        misplaced_pak(
            "104639_CustomPing_P",
            "CustomPing_P.pak",
            Some(folder.id.clone()),
        ),
        &source,
        Some(folder.id.clone()),
        cfg,
        cfg.primary(),
    )
    .unwrap();
    let before = read_state(&sp).unwrap();
    let dir = mods_base(game, cfg.primary()).join(&before.folders[0].disk_name);
    let files: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert_eq!(files.len(), 2);

    let plugins = cfg.target_for(Some("plugins"));
    let aside =
        plugin_repair::set_aside_superseded_paks(game, &sp, cfg, plugins, Some("59527")).unwrap();
    assert!(read_state(&sp).unwrap().mods.is_empty());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    drop(aside);

    let after = read_state(&sp).unwrap();
    assert_eq!(after.mods.len(), 1);
    assert_eq!(after.mods[0].uid, "104639_CustomPing_P");
    for name in files {
        assert!(dir.join(name).is_file());
    }
    let leftovers: Vec<_> = fs::read_dir(
        mods_base(game, cfg.primary())
            .parent()
            .unwrap()
            .parent()
            .unwrap(),
    )
    .unwrap()
    .flatten()
    .filter(|e| e.file_name().to_string_lossy().contains("superseded"))
    .collect();
    assert!(leftovers.is_empty());
}

/// Dynamic Bodypillow reads user images from its own Textures folder, so an update keeps a
/// file the new release does not ship, while a container the release dropped does not survive.
#[test]
fn an_update_keeps_files_the_user_added_to_the_plugin() {
    let cfg = engine_for_game("pd3").unwrap();
    let plugins = cfg.target_for(Some("plugins"));
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    let v1 = staged_plugin(tmp.path(), "Pillow", b"v1");
    place(&v1, "Content/Paks/Windows/Old_P.pak");
    install_mod_from_path(
        game,
        &sp,
        plugin_record("1", "Pillow"),
        &v1,
        None,
        cfg,
        plugins,
    )
    .unwrap();
    let installed = mods_base(game, plugins).join("Pillow");
    fs::write(installed.join("Textures.png"), b"mine").unwrap();
    place(&installed, "Textures/Custom.png");
    disable_mod_op(game, &sp, "1", cfg, None).unwrap();

    let v2 = staged_plugin(&tmp.path().join("v2"), "Pillow", b"v2");
    install_mod_from_path(
        game,
        &sp,
        plugin_record("2", "Pillow"),
        &v2,
        None,
        cfg,
        plugins,
    )
    .unwrap();

    assert_eq!(fs::read(installed.join("Pillow.uplugin")).unwrap(), b"v2");
    assert_eq!(fs::read(installed.join("Textures.png")).unwrap(), b"mine");
    assert!(installed.join("Textures/Custom.png").is_file());
    assert!(!installed.join("Content/Paks/Windows/Old_P.pak").exists());
    assert!(!disabled_base(game, plugins).join("Pillow").exists());
}
