use super::*;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
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

// ── detect_archive / is_zip ───────────────────────────────────────────────────

#[test]
fn is_zip_detects_zip_magic() {
    let zip = make_zip(&[("mod.pak", b"fake pak content")]);
    assert_eq!(detect_archive(zip.path()), Some(ArchiveFormat::Zip));
    assert!(is_zip(zip.path()));
}

#[test]
fn is_zip_rejects_non_zip() {
    let mut f = NamedTempFile::new().unwrap();
    f.write_all(b"\xC1\x83\x2A\x9E").unwrap();
    assert_eq!(detect_archive(f.path()), None);
    assert!(!is_zip(f.path()));
}

#[test]
fn is_zip_rejects_empty_file() {
    let f = NamedTempFile::new().unwrap();
    assert_eq!(detect_archive(f.path()), None);
}

// ── compute_md5 ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn compute_md5_matches_known_digest() {
    let mut f = NamedTempFile::new().unwrap();
    f.write_all(b"hello world").unwrap();
    let digest = compute_md5(f.path()).await.unwrap();
    assert_eq!(digest, "5eb63bbbe01eeed093cb22bb8f5acdc3");
}

// ── recover_dropped_mod_stem ───────────────────────────────────────────────

#[test]
fn recover_dropped_mod_stem_pulls_the_real_pak_name_out_of_a_zip_wrapper() {
    // Mirrors a real Nexus website download: the outer zip is named after Nexus's own
    // download-manager scheme, but the single pak entry inside carries the real name.
    let zip = make_zip(&[("abkarino_RinoHud_P.pak", b"pak bytes")]);
    let cfg = engine_for_game("pd3").unwrap();
    let stem = recover_dropped_mod_stem(
        &cfg.primary().unit,
        false,
        Path::new("irrelevant-for-this-branch"),
        Some(zip.path()),
        "abkarino_RinoHud_P 52 1.8 2026-07-02T19-49Z 9QzrVe4KC",
    );
    assert_eq!(stem, "abkarino_RinoHud_P");
}

#[test]
fn recover_dropped_mod_stem_uses_the_directory_unit_tmp_name() {
    let cfg = engine_for_game("pd2").unwrap();
    let stem = recover_dropped_mod_stem(
        &cfg.primary().unit,
        false,
        Path::new("/tmp/modrex-mod-abc123/Welrod"),
        None,
        "fallback should not be used",
    );
    assert_eq!(stem, "Welrod");
}

#[test]
fn recover_dropped_mod_stem_falls_back_for_a_bare_loose_pak() {
    // No zip wrapper: the dropped file's own OS filename already is the real pak name.
    let cfg = engine_for_game("pd3").unwrap();
    let stem = recover_dropped_mod_stem(
        &cfg.primary().unit,
        false,
        Path::new("irrelevant-for-this-branch"),
        None,
        "Foo",
    );
    assert_eq!(stem, "Foo");
}

#[test]
fn recover_dropped_mod_stem_falls_back_when_the_archive_has_more_than_one_pak() {
    let zip = make_zip(&[("A.pak", b"a"), ("B.pak", b"b")]);
    let cfg = engine_for_game("pd3").unwrap();
    let stem = recover_dropped_mod_stem(
        &cfg.primary().unit,
        false,
        Path::new("irrelevant-for-this-branch"),
        Some(zip.path()),
        "fallback",
    );
    assert_eq!(stem, "fallback");
}

#[test]
fn recover_dropped_mod_stem_reads_the_zip_entry_for_crime_boss_despite_being_directory_unit() {
    // Crime Boss is Directory-unit but its tmp is an opaque synthesized skeleton root with
    // no usable name of its own - it must take the same zip-entry path as File-unit games,
    // not the plain Directory-unit tmp.file_name() shortcut.
    let zip = make_zip(&[("SomeMod-WindowsNoEditor.pak", b"pak bytes")]);
    let cfg = engine_for_game("cb").unwrap();
    let stem = recover_dropped_mod_stem(
        &cfg.primary().unit,
        true,
        Path::new("/tmp/modrex-cb-mod-abc123"),
        Some(zip.path()),
        "fallback should not be used",
    );
    assert_eq!(stem, "SomeMod-WindowsNoEditor");
}

// ── apply_nexus_archive_identity ────────────────────────────────────────────

fn sample_nexus_match() -> crate::commands::nexus::NexusHashMatch {
    crate::commands::nexus::NexusHashMatch {
        mod_id: 52,
        file_id: 222,
        name: "wire name Modrex never uses here".to_string(),
        version: "wire version Modrex never uses here".to_string(),
        file_name: "abkarino_RinoHud_P.pak".to_string(),
        file_size: 1363148,
    }
}

fn sample_nexus_detail() -> crate::commands::domain::ModDetail {
    crate::commands::domain::ModDetail {
        id: 52,
        name: "RinoHud".to_string(),
        desc: String::new(),
        short_desc: String::new(),
        version: "1.8".to_string(),
        downloads: 0,
        likes: 0,
        views: 0,
        published_at: String::new(),
        bumped_at: String::new(),
        category_id: 0,
        has_download: true,
        disable_mod_managers: None,
        thumbnail: Some(crate::commands::domain::ModThumbnail {
            file: "https://example.com/thumb.png".to_string(),
            has_thumb: None,
        }),
        download: None,
        user: crate::commands::domain::ModUser {
            id: None,
            name: "abkarino".to_string(),
            donation_url: None,
            avatar: None,
            avatar_has_thumb: None,
        },
        changelog: None,
        instructions: None,
        license: None,
        repo_url: None,
        donation: None,
        banner: None,
        images: vec![],
        dependencies: vec![],
        instructs_template: None,
        tags: vec![],
        members: vec![],
    }
}

#[test]
fn apply_nexus_archive_identity_overwrites_the_generic_identity() {
    let mut entry = InstalledMod {
        uid: "RinoHud".to_string(),
        id: -12345,
        name: "abkarino_RinoHud_P 52 1.8 2026-07-02T19-49Z 9QzrVe4KC".to_string(),
        version: String::new(),
        update_status: UpdateStatus::Unknown,
        filename: "003_abkarino_RinoHud_P.pak".to_string(),
        enabled: true,
        installed_at: "2024-01-01T00:00:00Z".to_string(),
        sha256: Some("deadbeef".to_string()),
        ..InstalledMod::default()
    };

    apply_nexus_archive_identity(&mut entry, &sample_nexus_match(), &sample_nexus_detail());

    assert_eq!(entry.uid, "nexus:52:222");
    assert_eq!(entry.name, "RinoHud");
    assert_eq!(entry.version, "1.8");
    assert_eq!(entry.update_status, UpdateStatus::Known);
    assert_eq!(entry.source, "nexus");
    assert_eq!(entry.remote_id.as_deref(), Some("52"));
    assert_eq!(entry.file_remote_id.as_deref(), Some("222"));
    assert_eq!(entry.author.as_deref(), Some("abkarino"));
    assert_eq!(
        entry.thumbnail_url.as_deref(),
        Some("https://example.com/thumb.png")
    );
    assert_eq!(entry.file_id, Some(222));
    // filename and sha256 are install-path decisions, not identity - untouched.
    assert_eq!(entry.filename, "003_abkarino_RinoHud_P.pak");
    assert_eq!(entry.sha256.as_deref(), Some("deadbeef"));
}

// ── list_pak_entries (zip path) ───────────────────────────────────────────────

#[test]
fn list_pak_entries_finds_pak_files() {
    let zip = make_zip(&[
        ("readme.txt", b"hello"),
        ("weapons_default.pak", b"pak content"),
        ("weapons_alt.pak", b"pak content 2"),
    ]);
    let mut entries = list_pak_entries(zip.path()).unwrap();
    entries.sort();
    assert_eq!(entries, vec!["weapons_alt.pak", "weapons_default.pak"]);
}

// ── has_ue4ss_loader_signature ────────────────────────────────────────────────

#[test]
fn loader_signature_detects_top_level_settings_ini() {
    let zip = make_zip(&[
        ("dwmapi.dll", b"proxy"),
        ("UE4SS.dll", b"engine"),
        ("UE4SS-settings.ini", b"[General]"),
        ("Mods/mods.txt", b"SomeMod : 1"),
        (
            "Mods/SomeMod/Scripts/main.lua",
            b"-- bundled framework sub-mod",
        ),
    ]);
    assert!(has_ue4ss_loader_signature(zip.path()));
}

#[test]
fn loader_signature_absent_for_a_standalone_lua_submod() {
    // A single Lua sub-mod a user downloads separately: no top-level DLL/ini, just the
    // mod's own folder — must not be misclassified as the full loader package.
    let zip = make_zip(&[("CoolMod/Scripts/main.lua", b"-- a real sub-mod")]);
    assert!(!has_ue4ss_loader_signature(zip.path()));
}

#[test]
fn loader_signature_requires_top_level_ini_not_nested() {
    // A sub-mod could plausibly bundle its own ini somewhere under its own folder —
    // only a *top-level* UE4SS-settings.ini counts as the full loader.
    let zip = make_zip(&[("CoolMod/Config/UE4SS-settings.ini", b"not the real one")]);
    assert!(!has_ue4ss_loader_signature(zip.path()));
}

// ── extract_archive_flat ───────────────────────────────────────────────────────

#[test]
fn extract_archive_flat_preserves_internal_structure() {
    let zip = make_zip(&[
        ("dwmapi.dll", b"proxy"),
        ("UE4SS-settings.ini", b"[General]"),
        ("Mods/CoolMod/Scripts/main.lua", b"-- lua"),
    ]);
    let dest = TempDir::new().unwrap();
    extract_archive_flat(zip.path(), dest.path()).unwrap();
    assert_eq!(fs::read(dest.path().join("dwmapi.dll")).unwrap(), b"proxy");
    assert_eq!(
        fs::read(dest.path().join("UE4SS-settings.ini")).unwrap(),
        b"[General]"
    );
    assert_eq!(
        fs::read(dest.path().join("Mods/CoolMod/Scripts/main.lua")).unwrap(),
        b"-- lua"
    );
}

#[test]
fn extract_archive_flat_rejects_path_traversal() {
    let zip = make_zip(&[("../../evil.dll", b"escape attempt")]);
    let dest = TempDir::new().unwrap();
    extract_archive_flat(zip.path(), dest.path()).unwrap();
    assert!(!dest
        .path()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("evil.dll")
        .exists());
}

// ── resolve_archive_download: standalone UE4SS sub-mod fallback ──────────────

#[test]
fn crimeboss_standalone_submod_resolves_to_ue4ss_mods_target() {
    let zip = make_zip(&[("CoolMod/Scripts/main.lua", b"-- a real sub-mod")]);
    let cfg = engine_for_game("cb").unwrap();

    let (extracted, _orig, location_tag) =
        resolve_archive_download(zip.path().to_path_buf(), cfg).unwrap();
    assert_eq!(location_tag.as_deref(), Some("ue4ss_mods"));
    assert_eq!(extracted.file_name().unwrap(), "CoolMod");
    assert_eq!(
        fs::read(extracted.join("Scripts").join("main.lua")).unwrap(),
        b"-- a real sub-mod"
    );
}

#[test]
fn pd3_standalone_submod_resolves_to_ue4ss_mods_target() {
    // PD3's primary unit is File (paks) — the fallback must still find the secondary
    // Directory target even though it isn't primary.
    let zip = make_zip(&[("CoolMod/Scripts/main.lua", b"-- a real sub-mod")]);
    let cfg = engine_for_game("pd3").unwrap();

    let (extracted, _orig, location_tag) =
        resolve_archive_download(zip.path().to_path_buf(), cfg).unwrap();
    assert_eq!(location_tag.as_deref(), Some("ue4ss_mods"));
    assert_eq!(extracted.file_name().unwrap(), "CoolMod");
}

#[test]
fn genuinely_unplaceable_archive_errors_on_pd3() {
    // PD3 has no marker-less Directory target to fall back to (only ue4ss_mods, which requires
    // Scripts/main.lua), so a flat archive with nothing installable still hard-errors.
    let zip = make_zip(&[("readme.txt", b"nothing installable here")]);
    let cfg = engine_for_game("pd3").unwrap();
    let err = resolve_archive_download(zip.path().to_path_buf(), cfg).unwrap_err();
    assert!(
        matches!(err, ResolveError::Failure(ref m) if m.contains("no .pak files inside")),
        "{err:?}"
    );
}

#[test]
fn flat_crime_boss_archive_surfaces_confirm_sentinel_not_dead_end() {
    // Crime Boss's primary `mods` target blanket-accepts any directory, so a flat archive (no
    // enclosing folder at all) isn't classifiable but also isn't necessarily garbage — surface a
    // confirm dialog instead of deleting the download outright.
    let zip = make_zip(&[("readme.txt", b"nothing installable here")]);
    let cfg = engine_for_game("cb").unwrap();
    let zip_path = zip.path().to_path_buf();
    let err = resolve_archive_download(zip_path.clone(), cfg).unwrap_err();
    assert!(
        matches!(&err, ResolveError::Prompt(p) if matches!(**p, InstallPrompt::CbFlatArchive(_))),
        "{err:?}"
    );
    assert!(
        zip_path.exists(),
        "the source archive must survive so the user can confirm install"
    );
}

#[test]
fn list_pak_entries_empty_when_no_paks() {
    let zip = make_zip(&[("readme.txt", b"hello"), ("data.bin", b"data")]);
    let entries = list_pak_entries(zip.path()).unwrap();
    assert!(entries.is_empty());
}

#[test]
fn list_pak_entries_handles_nested_paths() {
    let zip = make_zip(&[("Real Weapon Names/weapons_default.pak", b"content")]);
    let entries = list_pak_entries(zip.path()).unwrap();
    assert_eq!(entries, vec!["Real Weapon Names/weapons_default.pak"]);
}

// ── extract_entry (zip path) ──────────────────────────────────────────────────

#[test]
fn extract_zip_entry_writes_correct_bytes() {
    let content = b"this is a pak file";
    let zip = make_zip(&[("my_mod.pak", content)]);
    let dest = NamedTempFile::new().unwrap();
    extract_entry(zip.path(), "my_mod.pak", dest.path()).unwrap();
    let written = std::fs::read(dest.path()).unwrap();
    assert_eq!(written, content);
}

#[test]
fn extract_zip_entry_errors_on_missing_entry() {
    let zip = make_zip(&[("other.pak", b"content")]);
    let dest = NamedTempFile::new().unwrap();
    let result = extract_entry(zip.path(), "nonexistent.pak", dest.path());
    assert!(result.is_err());
}

#[test]
fn extract_zip_entry_handles_nested_path() {
    let content = b"nested pak content";
    let zip = make_zip(&[("Real Weapon Names/weapons_default.pak", content)]);
    let dest = NamedTempFile::new().unwrap();
    extract_entry(
        zip.path(),
        "Real Weapon Names/weapons_default.pak",
        dest.path(),
    )
    .unwrap();
    let written = std::fs::read(dest.path()).unwrap();
    assert_eq!(written, content);
}

// ── extract_entry_with_sidecars (IoStore .ucas/.utoc) ────────────────────────

#[test]
fn extract_entry_with_sidecars_pulls_in_ucas_and_utoc() {
    let zip = make_zip(&[
        ("TestMod.pak", b"pak bytes"),
        ("TestMod.ucas", b"ucas bytes"),
        ("TestMod.utoc", b"utoc bytes"),
        ("readme.txt", b"ignore me"),
    ]);
    let dest = NamedTempFile::new().unwrap();
    extract_entry_with_sidecars(zip.path(), "TestMod.pak", dest.path()).unwrap();
    assert_eq!(fs::read(dest.path()).unwrap(), b"pak bytes");
    assert_eq!(
        fs::read(dest.path().with_extension("ucas")).unwrap(),
        b"ucas bytes"
    );
    assert_eq!(
        fs::read(dest.path().with_extension("utoc")).unwrap(),
        b"utoc bytes"
    );
}

#[test]
fn extract_entry_with_sidecars_ok_when_no_sidecars_present() {
    let zip = make_zip(&[("TestMod.pak", b"pak only")]);
    let dest = NamedTempFile::new().unwrap();
    extract_entry_with_sidecars(zip.path(), "TestMod.pak", dest.path()).unwrap();
    assert_eq!(fs::read(dest.path()).unwrap(), b"pak only");
    assert!(!dest.path().with_extension("ucas").exists());
    assert!(!dest.path().with_extension("utoc").exists());
}

#[test]
fn extract_entry_with_sidecars_matches_nested_path_siblings_only() {
    let zip = make_zip(&[
        (
            "Mod/Content/Paks/WindowsNoEditor/Mod-WindowsNoEditor.pak",
            b"pak",
        ),
        (
            "Mod/Content/Paks/WindowsNoEditor/Mod-WindowsNoEditor.ucas",
            b"right ucas",
        ),
        ("OtherFolder/Mod-WindowsNoEditor.ucas", b"wrong ucas"),
    ]);
    let dest = NamedTempFile::new().unwrap();
    extract_entry_with_sidecars(
        zip.path(),
        "Mod/Content/Paks/WindowsNoEditor/Mod-WindowsNoEditor.pak",
        dest.path(),
    )
    .unwrap();
    assert_eq!(
        fs::read(dest.path().with_extension("ucas")).unwrap(),
        b"right ucas"
    );
}

// ── strip_priority_prefix ─────────────────────────────────────────────────

#[test]
fn strip_prefix_no_prefix() {
    assert_eq!(strip_priority_prefix("foo.pak"), "foo.pak");
}

#[test]
fn strip_prefix_single_digit() {
    assert_eq!(strip_priority_prefix("1_foo.pak"), "foo.pak");
}

#[test]
fn strip_prefix_multi_digit() {
    assert_eq!(strip_priority_prefix("012_foo.pak"), "foo.pak");
}

#[test]
fn strip_prefix_digits_without_underscore() {
    assert_eq!(strip_priority_prefix("123foo.pak"), "123foo.pak");
}

#[test]
fn strip_prefix_empty() {
    assert_eq!(strip_priority_prefix(""), "");
}

// ── apply_priority_prefix ─────────────────────────────────────────────────

#[test]
fn apply_prefix_unprefixed() {
    assert_eq!(apply_priority_prefix("foo.pak", 3), "003_foo.pak");
}

#[test]
fn apply_prefix_already_prefixed() {
    assert_eq!(apply_priority_prefix("012_foo.pak", 3), "003_foo.pak");
}

// ── recover_published_filename ────────────────────────────────────────────

#[test]
fn recover_published_filename_strips_priority_prefix() {
    assert_eq!(
        recover_published_filename("003_Foo.pak", ".disabled"),
        "Foo.pak"
    );
}

#[test]
fn recover_published_filename_strips_disabled_suffix() {
    assert_eq!(
        recover_published_filename("Foo.pak.disabled", ".disabled"),
        "Foo.pak"
    );
}

#[test]
fn recover_published_filename_strips_both() {
    assert_eq!(
        recover_published_filename("003_Foo.pak.disabled", ".disabled"),
        "Foo.pak"
    );
}

#[test]
fn recover_published_filename_leaves_a_plain_name_alone() {
    assert_eq!(
        recover_published_filename("Foo.pak", ".disabled"),
        "Foo.pak"
    );
}

// ── derive_content_segment ────────────────────────────────────────────────

#[test]
fn derive_content_segment_passes_through_a_bare_folder_name() {
    assert_eq!(derive_content_segment("Welrod"), Some("Welrod"));
}

#[test]
fn derive_content_segment_strips_mod_overrides_prefix() {
    assert_eq!(
        derive_content_segment("assets/mod_overrides/Welrod"),
        Some("Welrod")
    );
}

#[test]
fn derive_content_segment_is_none_for_no_usable_segment() {
    assert_eq!(derive_content_segment(""), None);
    assert_eq!(derive_content_segment("assets/mod_overrides/"), None);
}

#[test]
fn apply_prefix_zero() {
    assert_eq!(apply_priority_prefix("foo.pak", 0), "000_foo.pak");
}

#[test]
fn apply_prefix_large_number() {
    assert_eq!(apply_priority_prefix("foo.pak", 999), "999_foo.pak");
}

// ── pak_filename ──────────────────────────────────────────────────────────

#[test]
fn pak_filename_spaces_become_underscores() {
    assert_eq!(pak_filename("My Mod"), "My_Mod.pak");
}

#[test]
fn pak_filename_consecutive_spaces_collapse() {
    assert_eq!(pak_filename("My  Mod"), "My_Mod.pak");
}

#[test]
fn pak_filename_leading_trailing_stripped() {
    assert_eq!(pak_filename("  My Mod  "), "My_Mod.pak");
}

#[test]
fn pak_filename_allowed_chars_preserved() {
    assert_eq!(
        pak_filename("CSA-39_Assault.Rifle"),
        "CSA-39_Assault.Rifle.pak"
    );
}

#[test]
fn pak_filename_special_chars_removed() {
    // trailing separator from '>' is trimmed by trim_matches('_')
    assert_eq!(pak_filename("Mod: \"Test\" <v1>"), "Mod_Test_v1.pak");
}

// ── hash_filename ─────────────────────────────────────────────────────────

#[test]
fn hash_filename_is_deterministic() {
    assert_eq!(hash_filename("foo.pak"), hash_filename("foo.pak"));
}

#[test]
fn hash_filename_is_negative() {
    let h = hash_filename("foo.pak");
    assert!(h < 0);
}

#[test]
fn hash_filename_different_inputs_differ() {
    assert_ne!(hash_filename("foo.pak"), hash_filename("bar.pak"));
}

#[test]
fn hash_filename_empty_returns_minus_one() {
    assert_eq!(hash_filename(""), -1);
}

// ── make_uid ──────────────────────────────────────────────────────────────

#[test]
fn make_uid_with_file_id() {
    assert_eq!(make_uid(Some(42), "003_foo.pak"), "42");
}

#[test]
fn make_uid_without_file_id_prefixed() {
    assert_eq!(make_uid(None, "003_foo.pak"), "foo.pak");
}

#[test]
fn make_uid_without_file_id_unprefixed() {
    assert_eq!(make_uid(None, "foo.pak"), "foo.pak");
}

// ── get_folder_path ───────────────────────────────────────────────────────

fn folder(id: &str, disk_name: &str, parent_id: Option<&str>) -> ModFolder {
    ModFolder {
        id: id.to_string(),
        disk_name: disk_name.to_string(),
        display_name: disk_name.to_string(),
        priority: 1,
        parent_id: parent_id.map(str::to_string),
    }
}

#[test]
fn folder_path_none_id() {
    assert_eq!(get_folder_path(&[], None), None);
}

#[test]
fn folder_path_id_not_in_list() {
    assert_eq!(get_folder_path(&[], Some("missing")), None);
}

#[test]
fn folder_path_root_folder() {
    let folders = vec![folder("a", "001_weapons", None)];
    assert_eq!(
        get_folder_path(&folders, Some("a")),
        Some("001_weapons".to_string())
    );
}

#[test]
fn folder_path_one_level_nested() {
    let folders = vec![
        folder("a", "001_weapons", None),
        folder("b", "002_rifles", Some("a")),
    ];
    assert_eq!(
        get_folder_path(&folders, Some("b")),
        Some("001_weapons/002_rifles".to_string())
    );
}

#[test]
fn folder_path_two_levels_nested() {
    let folders = vec![
        folder("a", "001_weapons", None),
        folder("b", "002_rifles", Some("a")),
        folder("c", "003_ak47", Some("b")),
    ];
    assert_eq!(
        get_folder_path(&folders, Some("c")),
        Some("001_weapons/002_rifles/003_ak47".to_string())
    );
}

// ── read_state ────────────────────────────────────────────────────────────

#[test]
fn read_state_missing_file_returns_default() {
    let path = std::path::Path::new("/nonexistent/path/.pd3mm.json");
    let state = read_state(path);
    assert!(state.mods.is_empty());
    assert!(state.folders.is_empty());
}

#[test]
fn read_state_invalid_json_returns_default() {
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "not valid json").unwrap();
    let state = read_state(f.path());
    assert!(state.mods.is_empty());
}

#[test]
fn read_state_valid_json_round_trips() {
    let json = r#"{
        "folders": [],
        "mods": [{
            "uid": "42",
            "id": 100,
            "name": "Test Mod",
            "version": "1.0",
            "filename": "001_Test_Mod.pak",
            "enabled": true,
            "installedAt": "2024-01-01T00:00:00Z"
        }]
    }"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", json).unwrap();
    let state = read_state(f.path());
    assert_eq!(state.mods.len(), 1);
    assert_eq!(state.mods[0].uid, "42");
    assert_eq!(state.mods[0].name, "Test Mod");
    assert!(state.mods[0].enabled);
}

#[test]
fn read_state_missing_uid_synthesized_from_file_id() {
    let json = r#"{
        "folders": [],
        "mods": [{
            "id": 100,
            "name": "Test Mod",
            "version": "1.0",
            "filename": "001_Test_Mod.pak",
            "enabled": true,
            "installedAt": "2024-01-01T00:00:00Z",
            "fileId": 55
        }]
    }"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", json).unwrap();
    let state = read_state(f.path());
    assert_eq!(state.mods[0].uid, "55");
}

#[test]
fn read_state_missing_uid_and_file_id_uses_stripped_filename() {
    let json = r#"{
        "folders": [],
        "mods": [{
            "id": 100,
            "name": "Test Mod",
            "version": "1.0",
            "filename": "001_Test_Mod.pak",
            "enabled": true,
            "installedAt": "2024-01-01T00:00:00Z"
        }]
    }"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", json).unwrap();
    let state = read_state(f.path());
    assert_eq!(state.mods[0].uid, "Test_Mod.pak");
}

#[test]
fn read_state_missing_parent_id_defaults_to_none() {
    let json = r#"{
        "folders": [{
            "id": "f1",
            "diskName": "001_weapons",
            "displayName": "weapons",
            "priority": 1
        }],
        "mods": []
    }"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", json).unwrap();
    let state = read_state(f.path());
    assert_eq!(state.folders[0].parent_id, None);
}

// ── InstalledMod.location field ───────────────────────────────────────────

#[test]
fn read_state_location_field_round_trips() {
    let json = r#"{
        "folders": [],
        "mods": [{
            "uid": "99",
            "id": 1,
            "name": "BeardLib Mod",
            "version": "1.0",
            "filename": "some_mod",
            "enabled": true,
            "installedAt": "2024-01-01T00:00:00Z",
            "location": "mod_overrides"
        }]
    }"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", json).unwrap();
    let state = read_state(f.path());
    assert_eq!(state.mods[0].location.as_deref(), Some("mod_overrides"));
}

#[test]
fn read_state_missing_location_is_none() {
    let json = r#"{
        "folders": [],
        "mods": [{
            "uid": "42",
            "id": 100,
            "name": "Test Mod",
            "version": "1.0",
            "filename": "001_Test_Mod.pak",
            "enabled": true,
            "installedAt": "2024-01-01T00:00:00Z"
        }]
    }"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", json).unwrap();
    let state = read_state(f.path());
    assert_eq!(state.mods[0].location, None);
}

// ── InstalledMod.nexus_content_missed field ───────────────────────────────

#[test]
fn read_state_without_nexus_content_missed_still_deserializes() {
    let json = r#"{
        "folders": [],
        "mods": [{
            "uid": "42",
            "id": 100,
            "name": "Test Mod",
            "version": "1.0",
            "filename": "001_Test_Mod.pak",
            "enabled": true,
            "installedAt": "2024-01-01T00:00:00Z"
        }]
    }"#;
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{}", json).unwrap();
    let state = read_state(f.path());
    assert_eq!(state.mods[0].nexus_content_missed, None);
}

#[test]
fn nexus_content_missed_survives_a_save_and_read_round_trip() {
    let temp = TempDir::new().unwrap();
    let state_path = temp.path().join(".modrex.json");
    let mods = vec![InstalledMod {
        uid: "1".to_string(),
        id: -1,
        name: "Unidentified".to_string(),
        filename: "Unidentified".to_string(),
        installed_at: "2024-01-01T00:00:00Z".to_string(),
        nexus_content_missed: Some(true),
        ..InstalledMod::default()
    }];
    save_state(
        &state_path,
        &ModsState {
            mods,
            folders: vec![],
        },
    );

    let state = read_state(&state_path);
    assert_eq!(state.mods[0].nexus_content_missed, Some(true));
}

#[test]
fn uninstall_mod_keeps_empty_folder() {
    let temp = TempDir::new().unwrap();
    let game = temp.path().to_str().unwrap();
    let cfg = engine_for_game("pd3").unwrap();
    let state_path = get_state_path(game, cfg);
    let folders = vec![folder("f1", "001_KeepMe", None)];
    let folder_rel = get_folder_path(&folders, Some("f1")).unwrap();
    let filename = "001_Test_Mod.pak";

    let folder_dir = mods_base(game, cfg.primary()).join(&folder_rel);
    fs::create_dir_all(&folder_dir).unwrap();
    fs::write(folder_dir.join(filename), b"pak").unwrap();
    save_state(
        &state_path,
        &ModsState {
            folders: folders.clone(),
            mods: vec![InstalledMod {
                uid: "mod1".to_string(),
                id: 1,
                name: "Test Mod".to_string(),
                version: "1.0".to_string(),
                filename: filename.to_string(),
                enabled: true,
                installed_at: "2024-01-01T00:00:00Z".to_string(),
                folder_id: Some("f1".to_string()),
                priority: Some(1),
                ..InstalledMod::default()
            }],
        },
    );

    uninstall_mod_op(game, &state_path, "mod1", cfg);

    let state = read_state(&state_path);
    assert!(state.mods.is_empty());
    assert_eq!(state.folders.len(), 1);
    assert_eq!(state.folders[0].id, "f1");
    assert!(folder_dir.exists());
}

#[test]
fn create_folder_reuses_existing_same_name_sibling() {
    let temp = TempDir::new().unwrap();
    let game = temp.path().to_str().unwrap();
    let cfg = engine_for_game("cb").unwrap();
    let state_path = get_state_path(game, cfg);

    let first = create_folder_op(game, &state_path, "ImprovedRogue", None, cfg).unwrap();
    let second = create_folder_op(game, &state_path, "ImprovedRogue", None, cfg).unwrap();

    assert_eq!(first.id, second.id);
    let state = read_state(&state_path);
    assert_eq!(state.folders.len(), 1);
}

// ── PD2 multi-target engine ───────────────────────────────────────────────

#[test]
fn pd2_engine_has_two_targets() {
    let cfg = engine_for_game("pd2").unwrap();
    assert_eq!(cfg.targets.len(), 2);
    assert_eq!(cfg.targets[0].tag, "mods");
    assert_eq!(cfg.targets[1].tag, "mod_overrides");
}

// ── RAID single blanket-accept engine ─────────────────────────────────────
// RAID's loader reads both BLT script mods and asset packs from one mods/<name>/ folder
// (assets/mod_overrides was removed), so the engine is a single blanket-accept target that
// excludes only BLT infrastructure dirs — see RAID_ENGINE in engine.rs.

#[test]
fn raid_engine_has_single_blanket_mods_target() {
    let cfg = engine_for_game("raid").unwrap();
    assert_eq!(cfg.targets.len(), 1);
    assert_eq!(cfg.targets[0].tag, "mods");
    // Blanket-accept: no markers, so every non-infra folder in mods/ is a user mod.
    match &cfg.targets[0].unit {
        super::engine::ModUnit::Directory {
            entry_markers,
            scan_markers,
            excluded_names,
            ..
        } => {
            assert!(entry_markers.is_empty());
            assert!(scan_markers.is_empty());
            for infra in ["base", "downloads", "logs", "saves"] {
                assert!(
                    excluded_names.contains(&infra),
                    "missing exclusion: {infra}"
                );
            }
        }
        _ => panic!("RAID mods target must be a Directory unit"),
    }
}

#[test]
fn raid_classify_script_and_asset_mods_all_route_to_mods() {
    // A BLT script mod (supermod.xml), a legacy RaidBLT mod (mod.xml), and a marker-less asset
    // pack (soundbanks/) all install into the one mods target (primary tag, location None).
    let names: Vec<String> = [
        "WolfgangHUD/supermod.xml",
        "CarryStacker/mod.xml",
        "CODWW2Soundpack/soundbanks/weapon_thompson.bnk",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let dirs = classify_archive_dirs(&names, engine_for_game("raid").unwrap());
    assert_eq!(dirs.len(), 3);
    assert_eq!(tag_of(&dirs, "WolfgangHUD"), Some(&None));
    assert_eq!(tag_of(&dirs, "CarryStacker"), Some(&None));
    assert_eq!(tag_of(&dirs, "CODWW2Soundpack"), Some(&None));
}

// ── classify_archive_dirs ────────────────────────────────────────────────

fn classify(names: &[&str]) -> Vec<(String, Option<String>)> {
    let owned: Vec<String> = names.iter().map(|s| s.to_string()).collect();
    classify_archive_dirs(&owned, engine_for_game("pd2").unwrap())
}

fn tag_of<'a>(v: &'a [(String, Option<String>)], dir: &str) -> Option<&'a Option<String>> {
    v.iter().find(|(d, _)| d == dir).map(|(_, t)| t)
}

#[test]
fn classify_single_beardlib_mod_routes_to_primary() {
    let dirs = classify(&["MyMod/main.xml", "MyMod/assets/x.texture"]);
    assert_eq!(dirs, vec![("MyMod".to_string(), None)]);
}

#[test]
fn classify_single_blt_mod_routes_to_primary() {
    let dirs = classify(&["MyMod/mod.txt", "MyMod/lua/x.lua"]);
    assert_eq!(dirs, vec![("MyMod".to_string(), None)]);
}

#[test]
fn classify_single_override_mod_routes_to_overrides() {
    let dirs = classify(&["MyOverride/guis/x.texture"]);
    assert_eq!(
        dirs,
        vec![("MyOverride".to_string(), Some("mod_overrides".to_string()))]
    );
}

#[test]
fn classify_multiple_overrides_all_secondary() {
    let dirs = classify(&["OverrideA/guis/a.texture", "OverrideB/units/b.unit"]);
    assert_eq!(
        tag_of(&dirs, "OverrideA"),
        Some(&Some("mod_overrides".into()))
    );
    assert_eq!(
        tag_of(&dirs, "OverrideB"),
        Some(&Some("mod_overrides".into()))
    );
}

#[test]
fn classify_mixed_modpack_routes_each_dir_to_its_target() {
    // RAMP-shaped: a wrapper with a "mods" folder and an "overrides" folder; the overrides
    // folder mixes BeardLib mods (have main.xml → must go to mods/) and asset-only dirs.
    let dirs = classify(&[
        "Pack/mods folder/BeardlibMod/main.xml",
        "Pack/mods folder/BltMod/mod.txt",
        "Pack/overrides folder/BeardlibOverride/main.xml",
        "Pack/overrides folder/AssetMod/guis/x.texture",
        "Pack/overrides folder/AssetMod2/units/y.unit",
    ]);
    // Marker dirs → primary (mods), regardless of which folder they were packaged in.
    assert_eq!(tag_of(&dirs, "Pack/mods folder/BeardlibMod"), Some(&None));
    assert_eq!(tag_of(&dirs, "Pack/mods folder/BltMod"), Some(&None));
    assert_eq!(
        tag_of(&dirs, "Pack/overrides folder/BeardlibOverride"),
        Some(&None)
    );
    // Marker-less sibling dirs → overrides.
    assert_eq!(
        tag_of(&dirs, "Pack/overrides folder/AssetMod"),
        Some(&Some("mod_overrides".into()))
    );
    assert_eq!(
        tag_of(&dirs, "Pack/overrides folder/AssetMod2"),
        Some(&Some("mod_overrides".into()))
    );
}

#[test]
fn classify_excludes_wrapper_and_nested_paths() {
    let dirs = classify(&[
        "Pack/mods folder/BltMod/mod.txt",
        "Pack/overrides folder/AssetMod/guis/x.texture",
    ]);
    // The wrapper and the destination folders (ancestors of mod dirs) are never installed.
    assert_eq!(tag_of(&dirs, "Pack"), None);
    assert_eq!(tag_of(&dirs, "Pack/mods folder"), None);
    assert_eq!(tag_of(&dirs, "Pack/overrides folder"), None);
    // Nested content under an override mod is not a separate mod.
    assert_eq!(tag_of(&dirs, "Pack/overrides folder/AssetMod/guis"), None);
    assert_eq!(dirs.len(), 2);
}

#[test]
fn classify_empty_archive_is_empty() {
    assert!(classify(&["readme.txt"]).is_empty());
}

#[test]
fn classify_unwraps_inner_mod_overrides_segment() {
    // HQ-Inventory-Icons shape: an override mod re-wrapped inside its own
    // assets/mod_overrides/<name>, sitting next to an inner BLT mod with a marker.
    let dirs = classify(&[
        "Pack/overrides folder/HQ/assets/mod_overrides/HQ/guis/x.texture",
        "Pack/overrides folder/HQ/mods/HQ/mod.txt",
    ]);
    // The asset half installs un-nested (the dir inside the segment, not the outer wrapper).
    assert_eq!(
        tag_of(&dirs, "Pack/overrides folder/HQ/assets/mod_overrides/HQ"),
        Some(&Some("mod_overrides".into()))
    );
    // The inner BLT mod still routes to mods/.
    assert_eq!(
        tag_of(&dirs, "Pack/overrides folder/HQ/mods/HQ"),
        Some(&None)
    );
    // The outer wrapper is never installed directly (would double-nest).
    assert_eq!(tag_of(&dirs, "Pack/overrides folder/HQ"), None);
    assert_eq!(dirs.len(), 2);
}

#[test]
fn classify_mixes_bare_and_wrapped_overrides() {
    let dirs = classify(&[
        "Pack/mods folder/BltMod/mod.txt",
        "Pack/overrides folder/Bare/units/x.unit",
        "Pack/overrides folder/Wrapped/assets/mod_overrides/Wrapped/guis/y.texture",
    ]);
    assert_eq!(tag_of(&dirs, "Pack/mods folder/BltMod"), Some(&None));
    assert_eq!(
        tag_of(&dirs, "Pack/overrides folder/Bare"),
        Some(&Some("mod_overrides".into()))
    );
    assert_eq!(
        tag_of(
            &dirs,
            "Pack/overrides folder/Wrapped/assets/mod_overrides/Wrapped"
        ),
        Some(&Some("mod_overrides".into()))
    );
    assert_eq!(tag_of(&dirs, "Pack/overrides folder/Wrapped"), None);
    assert_eq!(dirs.len(), 3);
}

#[test]
fn classify_ignores_beardlib_internal_overrides() {
    // A BeardLib mod (has main.xml) that carries its own assets/mod_overrides internally must
    // stay a single mods/ mod — its internals are not separate override mods.
    let dirs = classify(&[
        "Pack/mods folder/BeardMod/main.xml",
        "Pack/mods folder/BeardMod/assets/mod_overrides/Internal/x.texture",
    ]);
    assert_eq!(dirs, vec![("Pack/mods folder/BeardMod".to_string(), None)]);
}

// ── ue4ss_mods target ──────────────────────────────────────────────────────

#[test]
fn classify_ue4ss_submod_routes_to_ue4ss_mods_tag() {
    // Scripts/main.lua is a nested marker — classification must resolve to the mod's own
    // folder (Mods/CoolMod), not the Scripts/ subfolder the marker actually lives in.
    let names = vec!["Mods/CoolMod/Scripts/main.lua".to_string()];
    let dirs = classify_archive_dirs(&names, engine_for_game("cb").unwrap());
    assert_eq!(
        dirs,
        vec![("Mods/CoolMod".to_string(), Some("ue4ss_mods".to_string()))]
    );
}

#[test]
fn target_for_ue4ss_mods_resolves_on_both_games() {
    for game_id in ["cb", "pd3"] {
        let cfg = engine_for_game(game_id).unwrap();
        let target = cfg.target_for(Some("ue4ss_mods"));
        assert_eq!(target.tag, "ue4ss_mods");
        assert!(target.is_directory_unit());
    }
}

#[tokio::test]
async fn find_untracked_paks_excludes_bundled_ue4ss_submods() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp
        .path()
        .join("CrimeBoss")
        .join("Binaries")
        .join("Win64")
        .join("Mods");
    let make_lua_mod = |name: &str| {
        let dir = mods_dir.join(name).join("Scripts");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.lua"), b"-- mod").unwrap();
    };
    make_lua_mod("ActorDumperMod"); // bundled framework internal — must be excluded
    make_lua_mod("CoolMod"); // a genuine user sub-mod — must be reported

    let cfg = engine_for_game("cb").unwrap();
    let results = find_untracked_paks(tmp.path().to_str().unwrap(), &HashSet::new(), cfg).await;
    let ue4ss_results: Vec<_> = results
        .iter()
        .filter(|(_, _, loc)| loc.as_deref() == Some("ue4ss_mods"))
        .collect();

    assert_eq!(ue4ss_results.len(), 1);
    assert_eq!(ue4ss_results[0].0, "CoolMod");
}

#[test]
fn reconcile_state_purges_already_tracked_bundled_ue4ss_submods() {
    // Simulates state.json entries collected by an earlier ambient scan, before excluded_names
    // existed — the marker file is still genuinely on disk, so the scan_markers-presence check
    // alone would never catch these; only the excluded_names check does.
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("cb").unwrap();
    let sp = get_state_path(game, cfg);

    let mods_dir = tmp
        .path()
        .join("CrimeBoss")
        .join("Binaries")
        .join("Win64")
        .join("Mods");
    for name in ["ActorDumperMod", "CoolMod"] {
        let dir = mods_dir.join(name).join("Scripts");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.lua"), b"-- mod").unwrap();
    }

    let stale_entry = |filename: &str| InstalledMod {
        uid: filename.to_string(),
        id: -1,
        name: filename.to_string(),
        filename: filename.to_string(),
        enabled: true,
        location: Some("ue4ss_mods".to_string()),
        ..InstalledMod::default()
    };
    save_state(
        &sp,
        &ModsState {
            folders: vec![],
            mods: vec![stale_entry("ActorDumperMod"), stale_entry("CoolMod")],
        },
    );

    let state = reconcile_state(game, &sp, cfg);
    let names: Vec<&str> = state.mods.iter().map(|m| m.filename.as_str()).collect();
    assert_eq!(names, vec!["CoolMod"]);
}

#[test]
fn reconcile_state_recovers_source_identity_from_uid() {
    // Entries written before remote_id existed carry their identity only in the
    // uid ({source}:{mod_id}:{file_id}); reconcile parses it back and persists.
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd3").unwrap();
    let sp = get_state_path(game, cfg);

    let nexus_entry = InstalledMod {
        uid: "nexus:123:456".to_string(),
        id: -123,
        name: "Nexus Mod".to_string(),
        filename: "nexus_mod.pak".to_string(),
        enabled: true,
        source: "nexus".to_string(),
        file_id: Some(456),
        ..InstalledMod::default()
    };
    let workshop_entry = InstalledMod {
        uid: "789".to_string(),
        id: 42,
        name: "Workshop Mod".to_string(),
        filename: "workshop_mod.pak".to_string(),
        enabled: true,
        file_id: Some(789),
        ..InstalledMod::default()
    };
    save_state(
        &sp,
        &ModsState {
            folders: vec![],
            mods: vec![nexus_entry, workshop_entry],
        },
    );

    let state = reconcile_state(game, &sp, cfg);
    let nexus = state.mods.iter().find(|m| m.source == "nexus").unwrap();
    assert_eq!(nexus.remote_id.as_deref(), Some("123"));
    assert_eq!(nexus.file_remote_id.as_deref(), Some("456"));
    // The workshop entry's old id (42) WAS its real modworkshop id, before id became
    // opaque for every source — reconcile backfills remote_id from it directly (no
    // SHA256/name re-derivation) and only then re-derives id as the opaque local key.
    let workshop = state.mods.iter().find(|m| m.uid == "789").unwrap();
    assert_eq!(workshop.remote_id.as_deref(), Some("42"));
    assert_eq!(workshop.file_remote_id, None);

    // Persisted, so the parse never needs to run for these entries again.
    let saved = read_state(&sp);
    let nexus = saved.mods.iter().find(|m| m.source == "nexus").unwrap();
    assert_eq!(nexus.remote_id.as_deref(), Some("123"));
    assert_eq!(nexus.file_remote_id.as_deref(), Some("456"));
}

#[test]
fn reconcile_state_leaves_unparsable_source_uid_alone() {
    // A non-modworkshop entry whose uid does not carry the {source}:{mod}:{file}
    // shape stays unmigrated rather than gaining a guessed identity.
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd3").unwrap();
    let sp = get_state_path(game, cfg);

    let entry = InstalledMod {
        uid: "odd-uid".to_string(),
        id: -7,
        name: "Odd".to_string(),
        filename: "odd.pak".to_string(),
        enabled: true,
        source: "nexus".to_string(),
        ..InstalledMod::default()
    };
    save_state(
        &sp,
        &ModsState {
            folders: vec![],
            mods: vec![entry],
        },
    );

    let state = reconcile_state(game, &sp, cfg);
    assert_eq!(state.mods[0].remote_id, None);
    assert_eq!(state.mods[0].file_remote_id, None);
}

#[test]
fn reconcile_state_backfills_remote_id_for_a_legacy_modworkshop_entry_without_touching_version() {
    // Reproduces the upgrade path for every existing user: a modworkshop mod installed
    // before remote_id existed for that source has a real positive id and no remote_id at
    // all. Without the backfill, upgrade_negative_ids (identify.rs) can't tell that apart
    // from "genuinely never identified" and would run its fuzzy SHA256/name fallback on
    // it — the name-match branch specifically wipes the version and marks it Outdated,
    // which must not happen here since this entry was already correctly identified.
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd3").unwrap();
    let sp = get_state_path(game, cfg);

    let legacy = InstalledMod {
        uid: "100088".to_string(),
        id: 58065,
        name: "Alternative RinoHUD Icons".to_string(),
        version: "1.2.1".to_string(),
        filename: "alt_rinohud.pak".to_string(),
        enabled: true,
        file_id: Some(100088),
        sha256: Some("nomatchhere".to_string()),
        ..InstalledMod::default()
    };
    save_state(
        &sp,
        &ModsState {
            folders: vec![],
            mods: vec![legacy],
        },
    );

    let mut state = reconcile_state(game, &sp, cfg);
    let expected_id = crate::commands::sources::source_native_local_id("modworkshop", "58065");
    assert_eq!(state.mods[0].remote_id.as_deref(), Some("58065"));
    assert_eq!(state.mods[0].id, expected_id);
    assert_eq!(
        state.mods[0].version, "1.2.1",
        "backfill must not touch version"
    );
    assert_eq!(state.mods[0].update_status, UpdateStatus::Known);

    // The scenario that motivated this: an empty index (or a genuine SHA256/name miss)
    // must not retroactively "re-identify" an already-identified entry.
    let conn = setup_identify_index();
    let changed =
        super::identify::upgrade_negative_ids_with_conn(&conn, &mut state.mods, "PAYDAY 3");
    assert!(!changed);
    assert_eq!(state.mods[0].version, "1.2.1");
    assert_eq!(state.mods[0].update_status, UpdateStatus::Known);
}

#[test]
fn reconcile_state_repairs_a_source_native_id_wrongly_promoted_to_modworkshop() {
    // Reproduces a real corrupted save: an older, unguarded upgrade_negative_ids let a
    // Nexus-installed mod's id drift to a modworkshop id (an exact SHA256 match against a
    // cross-posted file), while source/remote_id stayed "nexus"/"52" — the sign of id is
    // what a Nexus mod's card badge and its own per-source update check both rely on, so a
    // stuck-positive id needs an active repair, not just a guard against new occurrences.
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd3").unwrap();
    let sp = get_state_path(game, cfg);

    let expected_id = crate::commands::sources::source_native_local_id("nexus", "52");
    let corrupted = InstalledMod {
        uid: "nexus:52:640".to_string(),
        id: 55809,
        name: "RinoHud".to_string(),
        filename: "rinohud.pak".to_string(),
        enabled: true,
        source: "nexus".to_string(),
        remote_id: Some("52".to_string()),
        file_remote_id: Some("640".to_string()),
        file_id: Some(640),
        ..InstalledMod::default()
    };
    save_state(
        &sp,
        &ModsState {
            folders: vec![],
            mods: vec![corrupted],
        },
    );

    let state = reconcile_state(game, &sp, cfg);
    assert_eq!(state.mods[0].id, expected_id);
    assert_eq!(state.mods[0].name, "RinoHud", "only id is repaired");

    // Persisted, so the repair never needs to run again for this entry.
    let saved = read_state(&sp);
    assert_eq!(saved.mods[0].id, expected_id);
}

#[test]
fn reconcile_state_leaves_a_correct_source_native_id_alone() {
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd3").unwrap();
    let sp = get_state_path(game, cfg);

    let expected_id = crate::commands::sources::source_native_local_id("nexus", "52");
    let entry = InstalledMod {
        uid: "nexus:52:640".to_string(),
        id: expected_id,
        name: "RinoHud".to_string(),
        filename: "rinohud.pak".to_string(),
        enabled: true,
        source: "nexus".to_string(),
        remote_id: Some("52".to_string()),
        file_remote_id: Some("640".to_string()),
        ..InstalledMod::default()
    };
    save_state(
        &sp,
        &ModsState {
            folders: vec![],
            mods: vec![entry],
        },
    );

    let state = reconcile_state(game, &sp, cfg);
    assert_eq!(state.mods[0].id, expected_id);
}

// ── upgrade_negative_ids_with_conn ─────────────────────────────────────────────

fn setup_identify_index() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE sources (id INTEGER PRIMARY KEY, game_id INTEGER);
        CREATE TABLE mods (id INTEGER PRIMARY KEY, source_id INTEGER, remote_id INTEGER, name TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY, mod_id INTEGER, remote_id INTEGER, sha256 TEXT, version TEXT, entry_name TEXT NOT NULL DEFAULT '');

        INSERT INTO games VALUES (1, 'PAYDAY 3');
        INSERT INTO sources VALUES (1, 1);
        INSERT INTO mods VALUES (1, 1, 55809, 'Alternative RinoHUD Icons');
        INSERT INTO files VALUES (1, 1, 640, 'crosspostedsha', '1.2.2', '');
        ",
    )
    .unwrap();
    conn
}

#[test]
fn upgrade_negative_ids_never_promotes_a_source_native_entry_even_on_an_exact_sha256_hit() {
    // A Nexus-installed file that happens to byte-match a modworkshop file (a real
    // cross-post) must not have its id reassigned to that modworkshop mod's id — the
    // corruption this reproduces: same sha256, entry ends up positive while source and
    // remote_id still say "nexus", desyncing its card badge and its own update check.
    let conn = setup_identify_index();
    let mut mods = vec![InstalledMod {
        uid: "nexus:52:640".to_string(),
        id: -52,
        name: "RinoHud".to_string(),
        filename: "rinohud.pak".to_string(),
        enabled: true,
        source: "nexus".to_string(),
        remote_id: Some("52".to_string()),
        file_remote_id: Some("640".to_string()),
        sha256: Some("crosspostedsha".to_string()),
        ..InstalledMod::default()
    }];
    let changed = super::identify::upgrade_negative_ids_with_conn(&conn, &mut mods, "PAYDAY 3");
    assert!(!changed);
    assert_eq!(mods[0].id, -52);
    assert_eq!(mods[0].name, "RinoHud");
}

#[test]
fn upgrade_negative_ids_still_upgrades_a_genuinely_unidentified_entry_by_sha256() {
    let conn = setup_identify_index();
    let mut mods = vec![InstalledMod {
        uid: "rinohud.pak".to_string(),
        id: -1,
        name: "some_local_pak".to_string(),
        filename: "rinohud.pak".to_string(),
        enabled: true,
        sha256: Some("crosspostedsha".to_string()),
        ..InstalledMod::default()
    }];
    let changed = super::identify::upgrade_negative_ids_with_conn(&conn, &mut mods, "PAYDAY 3");
    assert!(changed);
    assert_eq!(mods[0].remote_id.as_deref(), Some("55809"));
    assert_eq!(
        mods[0].id,
        crate::commands::sources::source_native_local_id("modworkshop", "55809")
    );
    assert_eq!(mods[0].name, "Alternative RinoHUD Icons");
}

#[test]
fn regroup_by_name_suffix_skips_entries_with_source_identity() {
    let base_id = crate::commands::sources::source_native_local_id("modworkshop", "100");
    let base = InstalledMod {
        uid: "100".to_string(),
        id: base_id,
        remote_id: Some("100".to_string()),
        name: "Cool Mod".to_string(),
        filename: "cool_mod.pak".to_string(),
        enabled: true,
        ..InstalledMod::default()
    };
    let unidentified = InstalledMod {
        uid: "cool_mod_2".to_string(),
        id: -5,
        name: "Cool Mod 456".to_string(),
        filename: "cool_mod_2.pak".to_string(),
        enabled: true,
        ..InstalledMod::default()
    };
    let sourced = InstalledMod {
        uid: "nexus:9:9".to_string(),
        id: -9,
        name: "Cool Mod 789".to_string(),
        filename: "cool_mod_3.pak".to_string(),
        enabled: true,
        source: "nexus".to_string(),
        remote_id: Some("9".to_string()),
        file_remote_id: Some("9".to_string()),
        ..InstalledMod::default()
    };

    let mut mods = vec![base, unidentified, sourced];
    super::identify::regroup_negative_ids_by_name_suffix(&mut mods);

    assert_eq!(mods[1].id, base_id);
    assert_eq!(mods[2].id, -9);
}

// ── host-mod pack detection ───────────────────────────────────────────────

fn detect_host(names: &[&str]) -> Option<super::host_mods::HostPackMatch> {
    let owned: Vec<String> = names.iter().map(|s| s.to_string()).collect();
    super::host_mods::detect_host_pack(&owned)
}

#[test]
fn detect_menu_background_pack() {
    let m = detect_host(&[
        "Nijigaku Original Ten/standard.png",
        "Nijigaku Original Ten/loading.png",
        "Nijigaku Original Ten/briefing.png",
        "Nijigaku Original Ten/crimenet.png",
        "Nijigaku Original Ten/endscreen.png",
        "Nijigaku Original Ten/loot.png",
    ])
    .expect("should detect a Menu Backgrounds set");
    assert_eq!(m.host.host_mod_id, 17160);
    assert_eq!(m.dirs, vec!["Nijigaku Original Ten".to_string()]);
}

#[test]
fn detect_menu_background_pack_with_wrapper() {
    let m = detect_host(&[
        "Pack/My Set/standard.png",
        "Pack/My Set/crimenet.png",
        "Pack/My Set/briefing.png",
    ])
    .expect("wrapped set should still be detected");
    assert_eq!(m.dirs, vec!["Pack/My Set".to_string()]);
}

#[test]
fn detect_multiple_background_sets() {
    let m = detect_host(&[
        "SetA/standard.png",
        "SetA/crimenet.png",
        "SetA/briefing.png",
        "SetB/standard.dds",
        "SetB/loading.dds",
        "SetB/endscreen.dds",
    ])
    .expect("two sets");
    assert_eq!(m.dirs, vec!["SetA".to_string(), "SetB".to_string()]);
}

#[test]
fn detect_rejects_below_min_matches() {
    assert!(detect_host(&["My Set/standard.png", "My Set/crimenet.png"]).is_none());
}

#[test]
fn detect_rejects_real_override_mod() {
    assert!(detect_host(&[
        "Cool Texture Mod/guis/textures/pd2/x.texture",
        "Cool Texture Mod/units/y.unit",
    ])
    .is_none());
}

#[test]
fn detect_rejects_mod_with_marker() {
    // Has a marker → it's a real mod even though it carries background-named images.
    assert!(detect_host(&[
        "Some Mod/mod.txt",
        "Some Mod/standard.png",
        "Some Mod/crimenet.png",
        "Some Mod/briefing.png",
    ])
    .is_none());
}

#[test]
fn detect_ignores_non_image_signature_files() {
    // Right names, wrong (non-image) extensions → not a background set.
    assert!(detect_host(&["Set/standard.lua", "Set/crimenet.txt", "Set/briefing.json",]).is_none());
}

// ── is_unplaceable_pack ───────────────────────────────────────────────────

fn unplaceable(names: &[&str]) -> bool {
    is_unplaceable_pack(
        &names.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        &[],
    )
}

#[test]
fn unplaceable_flags_loose_media_pack() {
    // A background set: a folder of loose images, no nesting, no marker.
    assert!(unplaceable(&[
        "Nijigaku Original Ten/standard.png",
        "Nijigaku Original Ten/loot.png"
    ]));
}

#[test]
fn unplaceable_allows_real_override() {
    // Files nested under a category dir → a placeable asset-override mod.
    assert!(!unplaceable(&["3D weapon rails/units/x.unit"]));
}

#[test]
fn unplaceable_allows_marker_mod() {
    assert!(!unplaceable(&["Some Mod/mod.txt", "Some Mod/standard.png"]));
}

// ── host-pack install / tracking ──────────────────────────────────────────

#[test]
fn parse_host_location_roundtrip() {
    use super::host_mods::parse_host_location;
    assert_eq!(
        parse_host_location("host:17160:Assets"),
        Some((17160, "Assets".to_string()))
    );
    assert_eq!(parse_host_location("mod_overrides"), None);
    assert_eq!(parse_host_location("host:abc:Assets"), None);
}

/// A game dir with Menu Backgrounds (id 17160) installed at `mods/Menu Backgrounds`, plus a zip
/// holding one background set. Returns `(tempdir, state_path, zip)`.
fn host_fixture() -> (TempDir, std::path::PathBuf, NamedTempFile) {
    let tmp = TempDir::new().unwrap();
    let game = tmp.path();
    let cfg = engine_for_game("pd2").unwrap();
    let host_dir = game.join("mods").join("Menu Backgrounds");
    fs::create_dir_all(&host_dir).unwrap();
    fs::write(host_dir.join("main.xml"), b"").unwrap();
    let sp = get_state_path(game.to_str().unwrap(), cfg);
    save_state(
        &sp,
        &ModsState {
            folders: vec![],
            mods: vec![InstalledMod {
                uid: "Menu Backgrounds".into(),
                id: 17160,
                remote_id: Some("17160".into()),
                name: "Menu Backgrounds".into(),
                filename: "Menu Backgrounds".into(),
                enabled: true,
                ..InstalledMod::default()
            }],
        },
    );
    let zip = make_zip(&[
        ("My Set/standard.png", b"a"),
        ("My Set/crimenet.png", b"b"),
        ("My Set/briefing.png", b"c"),
    ]);
    (tmp, sp, zip)
}

fn bg_mod_data() -> InstalledMod {
    InstalledMod {
        id: 57135,
        remote_id: Some("57135".into()),
        name: "BG Mod".into(),
        version: "1".into(),
        file_id: Some(999),
        location: Some("host:17160:Assets".into()),
        ..InstalledMod::default()
    }
}

#[test]
fn install_host_pack_op_places_set_and_records() {
    let (tmp, sp, zip) = host_fixture();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd2").unwrap();
    install_host_pack_op(game, &sp, zip.path(), "My Set", bg_mod_data(), cfg).unwrap();

    // Files land un-nested under the host's Assets folder.
    assert!(tmp
        .path()
        .join("mods/Menu Backgrounds/Assets/My Set/standard.png")
        .exists());
    // Recorded with a host location.
    let rec = read_state(&sp)
        .mods
        .into_iter()
        .find(|m| m.name == "BG Mod")
        .expect("recorded");
    assert_eq!(rec.location.as_deref(), Some("host:17160:Assets"));
    assert_eq!(rec.filename, "My Set");
}

#[test]
fn install_host_pack_op_errors_when_host_missing() {
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd2").unwrap();
    let sp = get_state_path(game, cfg);
    let zip = make_zip(&[("My Set/standard.png", b"a")]);
    let err =
        install_host_pack_op(game, &sp, zip.path(), "My Set", bg_mod_data(), cfg).unwrap_err();
    assert!(err.starts_with("HOST_MOD_MISSING:"), "{err}");
}

#[test]
fn reconcile_keeps_installed_host_pack() {
    let (tmp, sp, zip) = host_fixture();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd2").unwrap();
    install_host_pack_op(game, &sp, zip.path(), "My Set", bg_mod_data(), cfg).unwrap();

    let state = reconcile_state(game, &sp, cfg);
    let rec = state.mods.iter().find(|m| m.name == "BG Mod").unwrap();
    assert_eq!(
        rec.missing, None,
        "installed host pack must not read as missing"
    );
}

#[test]
fn uninstall_removes_host_pack() {
    let (tmp, sp, zip) = host_fixture();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd2").unwrap();
    install_host_pack_op(game, &sp, zip.path(), "My Set", bg_mod_data(), cfg).unwrap();

    uninstall_mod_op(game, &sp, "999_My Set", cfg);

    assert!(!tmp
        .path()
        .join("mods/Menu Backgrounds/Assets/My Set")
        .exists());
    assert!(read_state(&sp).mods.iter().all(|m| m.id != 57135));
}

fn host_only_entry() -> InstalledMod {
    InstalledMod {
        uid: "Menu Backgrounds".into(),
        id: 17160,
        name: "Menu Backgrounds".into(),
        filename: "Menu Backgrounds".into(),
        enabled: true,
        ..InstalledMod::default()
    }
}

#[test]
fn discovers_untracked_host_packs_excluding_bundled() {
    let tmp = TempDir::new().unwrap();
    let game = tmp.path();
    let cfg = engine_for_game("pd2").unwrap();
    let assets = game.join("mods/Menu Backgrounds/Assets");
    fs::create_dir_all(game.join("mods/Menu Backgrounds")).unwrap();
    fs::write(game.join("mods/Menu Backgrounds/main.xml"), b"").unwrap();
    fs::create_dir_all(assets.join("The Diamond")).unwrap(); // host's bundled default
    fs::create_dir_all(assets.join("astolfo bg")).unwrap(); // user pack, active
    fs::create_dir_all(game.join("mods/disabled/host-17160/old set")).unwrap(); // user pack, disabled

    let found = find_untracked_host_packs(game.to_str().unwrap(), cfg, &[host_only_entry()], &[]);
    let names: Vec<&str> = found.iter().map(|(_, _, n, _, _)| n.as_str()).collect();
    assert!(names.contains(&"astolfo bg"));
    assert!(names.contains(&"old set"));
    assert!(
        !names.contains(&"The Diamond"),
        "bundled default must be excluded"
    );
    assert!(
        found
            .iter()
            .find(|(_, _, n, _, _)| n == "astolfo bg")
            .unwrap()
            .3
    ); // active → enabled
    assert!(
        !found
            .iter()
            .find(|(_, _, n, _, _)| n == "old set")
            .unwrap()
            .3
    ); // disabled
}

#[test]
fn skips_already_tracked_host_packs() {
    let tmp = TempDir::new().unwrap();
    let game = tmp.path();
    let cfg = engine_for_game("pd2").unwrap();
    let assets = game.join("mods/Menu Backgrounds/Assets");
    fs::create_dir_all(game.join("mods/Menu Backgrounds")).unwrap();
    fs::write(game.join("mods/Menu Backgrounds/main.xml"), b"").unwrap();
    fs::create_dir_all(assets.join("astolfo bg")).unwrap();

    let tracked = InstalledMod {
        uid: "98785_astolfo bg".into(),
        id: 39800,
        filename: "astolfo bg".into(),
        enabled: true,
        location: Some("host:17160:Assets".into()),
        ..InstalledMod::default()
    };
    let found = find_untracked_host_packs(
        game.to_str().unwrap(),
        cfg,
        &[host_only_entry(), tracked],
        &[],
    );
    assert!(
        found.is_empty(),
        "an already-tracked set must not be rediscovered"
    );
}

#[test]
fn no_host_packs_when_host_absent() {
    let tmp = TempDir::new().unwrap();
    let cfg = engine_for_game("pd2").unwrap();
    assert!(find_untracked_host_packs(tmp.path().to_str().unwrap(), cfg, &[], &[]).is_empty());
}

#[test]
fn disable_then_enable_host_pack_moves_files() {
    let (tmp, sp, zip) = host_fixture();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd2").unwrap();
    install_host_pack_op(game, &sp, zip.path(), "My Set", bg_mod_data(), cfg).unwrap();
    let active = tmp.path().join("mods/Menu Backgrounds/Assets/My Set");
    let disabled = tmp.path().join("mods/disabled/host-17160/My Set");
    assert!(active.exists() && !disabled.exists());

    disable_mod_op(game, &sp, "999_My Set", cfg, None);
    assert!(
        !active.exists() && disabled.exists(),
        "disable moves the set out of the host"
    );
    assert!(
        !read_state(&sp)
            .mods
            .iter()
            .find(|m| m.name == "BG Mod")
            .unwrap()
            .enabled
    );

    enable_mod_op(game, &sp, "999_My Set", cfg, None);
    assert!(
        active.exists() && !disabled.exists(),
        "enable moves the set back into the host"
    );
    assert!(
        read_state(&sp)
            .mods
            .iter()
            .find(|m| m.name == "BG Mod")
            .unwrap()
            .enabled
    );
}

#[test]
fn reconcile_keeps_disabled_host_pack() {
    let (tmp, sp, zip) = host_fixture();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd2").unwrap();
    install_host_pack_op(game, &sp, zip.path(), "My Set", bg_mod_data(), cfg).unwrap();
    disable_mod_op(game, &sp, "999_My Set", cfg, None);

    let state = reconcile_state(game, &sp, cfg);
    let rec = state.mods.iter().find(|m| m.name == "BG Mod").unwrap();
    assert_eq!(
        rec.missing, None,
        "a disabled host pack must not read as missing"
    );
}

#[test]
fn uninstall_removes_disabled_host_pack() {
    let (tmp, sp, zip) = host_fixture();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("pd2").unwrap();
    install_host_pack_op(game, &sp, zip.path(), "My Set", bg_mod_data(), cfg).unwrap();
    disable_mod_op(game, &sp, "999_My Set", cfg, None);

    uninstall_mod_op(game, &sp, "999_My Set", cfg);

    assert!(!tmp.path().join("mods/disabled/host-17160/My Set").exists());
    assert!(read_state(&sp).mods.iter().all(|m| m.id != 57135));
}

#[test]
fn classify_pure_wrapped_override_pack() {
    // No markers anywhere, override content wrapped in a destination segment.
    let dirs = classify(&[
        "Pack/assets/mod_overrides/Foo/guis/a.texture",
        "Pack/assets/mod_overrides/Bar/units/b.unit",
    ]);
    assert_eq!(
        tag_of(&dirs, "Pack/assets/mod_overrides/Foo"),
        Some(&Some("mod_overrides".into()))
    );
    assert_eq!(
        tag_of(&dirs, "Pack/assets/mod_overrides/Bar"),
        Some(&Some("mod_overrides".into()))
    );
    assert_eq!(tag_of(&dirs, "Pack"), None);
    assert_eq!(dirs.len(), 2);
}

// ── find_untracked_paks multi-target ─────────────────────────────────────

fn make_dir_mod(parent: &std::path::Path, name: &str, marker: &str) {
    let dir = parent.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(marker), b"").unwrap();
}

#[tokio::test]
async fn find_untracked_paks_primary_has_no_location() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    fs::create_dir_all(&mods_dir).unwrap();
    make_dir_mod(&mods_dir, "my_blt_mod", "mod.txt");

    let cfg = engine_for_game("pd2").unwrap();
    let results = find_untracked_paks(tmp.path().to_str().unwrap(), &HashSet::new(), cfg).await;

    assert_eq!(results.len(), 1);
    let (rel, enabled, location) = &results[0];
    assert_eq!(rel, "my_blt_mod");
    assert!(*enabled);
    assert_eq!(*location, None);
}

#[tokio::test]
async fn find_untracked_paks_secondary_has_location_tag() {
    let tmp = TempDir::new().unwrap();
    let mo_dir = tmp.path().join("assets").join("mod_overrides");
    fs::create_dir_all(&mo_dir).unwrap();
    make_dir_mod(&mo_dir, "my_beardlib_mod", "main.xml");

    let cfg = engine_for_game("pd2").unwrap();
    let results = find_untracked_paks(tmp.path().to_str().unwrap(), &HashSet::new(), cfg).await;

    assert_eq!(results.len(), 1);
    let (rel, enabled, location) = &results[0];
    assert_eq!(rel, "my_beardlib_mod");
    assert!(*enabled);
    assert_eq!(location.as_deref(), Some("mod_overrides"));
}

#[tokio::test]
async fn find_untracked_paks_known_filter_isolates_by_target() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    let mo_dir = tmp.path().join("assets").join("mod_overrides");
    fs::create_dir_all(&mods_dir).unwrap();
    fs::create_dir_all(&mo_dir).unwrap();
    make_dir_mod(&mods_dir, "shared_name", "mod.txt");
    make_dir_mod(&mo_dir, "shared_name", "main.xml");

    let cfg = engine_for_game("pd2").unwrap();
    // Mark the primary-target entry as known; secondary entry must still be reported.
    let known: HashSet<String> = [":shared_name".to_string()].into();
    let results = find_untracked_paks(tmp.path().to_str().unwrap(), &known, cfg).await;

    assert_eq!(results.len(), 1);
    let (rel, _, location) = &results[0];
    assert_eq!(rel, "shared_name");
    assert_eq!(location.as_deref(), Some("mod_overrides"));
}

#[tokio::test]
async fn find_untracked_paks_skips_target_when_backup_exists() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    let mods_bak = tmp.path().join("mods.bak");
    let mo_dir = tmp.path().join("assets").join("mod_overrides");
    fs::create_dir_all(&mods_dir).unwrap();
    fs::create_dir_all(&mods_bak).unwrap();
    fs::create_dir_all(&mo_dir).unwrap();
    make_dir_mod(&mods_dir, "blt_mod", "mod.txt");
    make_dir_mod(&mo_dir, "beardlib_mod", "main.xml");

    let cfg = engine_for_game("pd2").unwrap();
    let results = find_untracked_paks(tmp.path().to_str().unwrap(), &HashSet::new(), cfg).await;

    // Primary skipped (backup exists), only secondary returned.
    assert_eq!(results.len(), 1);
    let (rel, _, location) = &results[0];
    assert_eq!(rel, "beardlib_mod");
    assert_eq!(location.as_deref(), Some("mod_overrides"));
}

#[tokio::test]
async fn find_untracked_paks_skips_blt_basemod() {
    let tmp = TempDir::new().unwrap();
    let mods_dir = tmp.path().join("mods");
    fs::create_dir_all(&mods_dir).unwrap();
    make_dir_mod(&mods_dir, "base", "mod.txt");
    make_dir_mod(&mods_dir, "my_blt_mod", "mod.txt");

    let cfg = engine_for_game("pd2").unwrap();
    let results = find_untracked_paks(tmp.path().to_str().unwrap(), &HashSet::new(), cfg).await;

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, "my_blt_mod");
}

#[tokio::test]
async fn find_untracked_paks_keeps_base_in_secondary_target() {
    let tmp = TempDir::new().unwrap();
    let mo_dir = tmp.path().join("assets").join("mod_overrides");
    fs::create_dir_all(mo_dir.join("base")).unwrap();

    let cfg = engine_for_game("pd2").unwrap();
    let results = find_untracked_paks(tmp.path().to_str().unwrap(), &HashSet::new(), cfg).await;

    assert_eq!(results.len(), 1);
    let (rel, _, location) = &results[0];
    assert_eq!(rel, "base");
    assert_eq!(location.as_deref(), Some("mod_overrides"));
}

// ── safe_dest (Zip-Slip guard) ────────────────────────────────────────────

#[test]
fn safe_dest_allows_normal_nested_path() {
    let dest = std::path::Path::new("/tmp/out");
    assert_eq!(
        safe_dest(dest, "sub/file.pak"),
        Some(std::path::PathBuf::from("/tmp/out/sub/file.pak"))
    );
}

#[test]
fn safe_dest_allows_current_dir_segments() {
    let dest = std::path::Path::new("/tmp/out");
    assert_eq!(
        safe_dest(dest, "./file.pak"),
        Some(std::path::PathBuf::from("/tmp/out/./file.pak"))
    );
}

#[test]
fn safe_dest_rejects_parent_traversal() {
    let dest = std::path::Path::new("/tmp/out");
    assert_eq!(safe_dest(dest, "../escape.pak"), None);
    assert_eq!(safe_dest(dest, "sub/../../escape.pak"), None);
}

#[test]
fn safe_dest_rejects_absolute_path() {
    let dest = std::path::Path::new("/tmp/out");
    assert_eq!(safe_dest(dest, "/etc/passwd"), None);
}

// ── extract_dir_entry Zip-Slip behavior ───────────────────────────────────

#[test]
fn extract_dir_entry_drops_traversal_entries() {
    // An archive whose mod directory smuggles a `../` entry must not write outside dest.
    let zip = make_zip(&[
        ("mymod/main.xml", b"safe"),
        ("mymod/../escape.pak", b"malicious"),
    ]);
    let out = TempDir::new().unwrap();
    let dest = out.path().join("extracted");
    extract_dir_entry(zip.path(), "mymod", &dest).unwrap();

    assert_eq!(fs::read(dest.join("main.xml")).unwrap(), b"safe");
    // The traversal target (sibling of dest) must never be created.
    assert!(!out.path().join("escape.pak").exists());
}

// ── embedded_modworkshop_id (BeardLib / RAID BLT marker files) ────────────────

fn dir_with_marker(name: &str, content: &str) -> TempDir {
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join(name), content).unwrap();
    tmp
}

fn dir_with_main_xml(content: &str) -> TempDir {
    dir_with_marker("main.xml", content)
}

#[test]
fn embedded_id_reads_standard_assetupdates() {
    let d = dir_with_main_xml(
        r#"<mod name="x"><AssetUpdates id="19169" version="1.859" provider="modworkshop"/></mod>"#,
    );
    assert_eq!(
        embedded_modworkshop_id(d.path()),
        Some((19169, Some("1.859".to_string())))
    );
}

#[test]
fn embedded_id_is_attribute_order_independent() {
    let d = dir_with_main_xml(r#"<AssetUpdates provider="modworkshop" id="51099"/>"#);
    assert_eq!(embedded_modworkshop_id(d.path()), Some((51099, None)));
}

#[test]
fn embedded_id_defaults_provider_to_modworkshop() {
    let d = dir_with_main_xml(r#"<AssetUpdates id="123" version="2"/>"#);
    assert_eq!(
        embedded_modworkshop_id(d.path()),
        Some((123, Some("2".to_string())))
    );
}

#[test]
fn embedded_id_rejects_other_providers() {
    let d = dir_with_main_xml(r#"<AssetUpdates id="5" provider="github"/>"#);
    assert_eq!(embedded_modworkshop_id(d.path()), None);
}

#[test]
fn embedded_id_none_without_assetupdates() {
    let d = dir_with_main_xml(r#"<mod name="gray_cowl" author="HedyL"></mod>"#);
    assert_eq!(embedded_modworkshop_id(d.path()), None);
}

#[test]
fn embedded_id_none_without_main_xml() {
    let tmp = TempDir::new().unwrap();
    assert_eq!(embedded_modworkshop_id(tmp.path()), None);
}

#[test]
fn embedded_id_rejects_non_numeric_id() {
    let d = dir_with_main_xml(r#"<AssetUpdates id="abc" provider="modworkshop"/>"#);
    assert_eq!(embedded_modworkshop_id(d.path()), None);
}

#[test]
fn embedded_id_ignores_substring_attribute_names() {
    // `someid="7"` must not be mistaken for `id`.
    let d = dir_with_main_xml(r#"<AssetUpdates someid="7" id="42" provider="modworkshop"/>"#);
    assert_eq!(embedded_modworkshop_id(d.path()), Some((42, None)));
}

#[test]
fn embedded_id_reads_raid_supermod_update_with_root_version() {
    // Real RAID-SuperBLT shape (WolfgangHUD): identifier on the update element inside an
    // updates wrapper, version on the multi-line root mod element.
    let d = dir_with_marker(
        "supermod.xml",
        "<mod name=\"WolfgangHUD\"\n\tauthor=\"BangL\"\n\tversion=\"2.36.0\">\n\t<updates>\n\t\t<update provider=\"modworkshop\" identifier=\"24551\"/>\n\t</updates>\n</mod>",
    );
    assert_eq!(
        embedded_modworkshop_id(d.path()),
        Some((24551, Some("2.36.0".to_string())))
    );
}

#[test]
fn embedded_id_supermod_skips_non_modworkshop_updates() {
    let d = dir_with_marker(
        "supermod.xml",
        r#"<mod name="x"><updates><update provider="github" identifier="1"/><update provider="modworkshop" identifier="7"/></updates></mod>"#,
    );
    assert_eq!(embedded_modworkshop_id(d.path()), Some((7, None)));
}

#[test]
fn embedded_id_reads_legacy_raidblt_auto_updates() {
    // Real legacy RaidBLT shape (Carry Stacker): auto_updates element in mod.xml.
    let d = dir_with_marker(
        "mod.xml",
        r#"<table name="Carry Stacker"><auto_updates provider="modworkshop" id="25166" version="2" important="true"/></table>"#,
    );
    assert_eq!(
        embedded_modworkshop_id(d.path()),
        Some((25166, Some("2".to_string())))
    );
}

// ── identify_untracked (hash → embedded-id → name priority) ───────────────────

fn make_index() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
         CREATE TABLE sources (id INTEGER PRIMARY KEY, game_id INTEGER);
         CREATE TABLE mods (id INTEGER PRIMARY KEY, source_id INTEGER, remote_id INTEGER, name TEXT);
         CREATE TABLE files (id INTEGER PRIMARY KEY, mod_id INTEGER, remote_id INTEGER, sha256 TEXT, version TEXT, entry_name TEXT NOT NULL DEFAULT '');
         INSERT INTO games VALUES (2, 'PAYDAY 2');
         INSERT INTO sources VALUES (2, 2);",
    )
    .unwrap();
    conn
}

fn make_mod_dir(
    game: &std::path::Path,
    location: Option<&str>,
    name: &str,
    marker: &str,
    body: &str,
) {
    let base = match location {
        Some("mod_overrides") => game.join("assets").join("mod_overrides"),
        _ => game.join("mods"),
    };
    let dir = base.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(marker), body).unwrap();
}

fn run_identify(
    game: &std::path::Path,
    untracked: Vec<(String, bool, Option<String>)>,
    sha256s: Vec<Option<String>>,
    conn: &rusqlite::Connection,
) -> Vec<InstalledMod> {
    let mut state = ModsState::default();
    identify_untracked(
        &mut state,
        &untracked,
        &sha256s,
        &std::collections::HashMap::new(),
        engine_for_game("pd2").unwrap(),
        game.to_str().unwrap(),
        Some(conn),
    )
}

#[test]
fn identify_untracked_uses_embedded_id_when_hash_misses() {
    let game = TempDir::new().unwrap();
    make_mod_dir(
        game.path(),
        None,
        "My Cool Mod",
        "main.xml",
        r#"<AssetUpdates id="300" version="2.0" provider="modworkshop"/>"#,
    );
    let conn = make_index();
    conn.execute_batch(
        "INSERT INTO mods VALUES (1, 2, 300, 'Cool Mod (Official Name)');
         INSERT INTO files VALUES (1, 1, 700, 'indexsha', '2.5', 'x/main.xml');",
    )
    .unwrap();

    let mods = run_identify(
        game.path(),
        vec![("My Cool Mod".to_string(), true, None)],
        vec![Some("does-not-match".to_string())],
        &conn,
    );

    assert_eq!(mods.len(), 1);
    let m = &mods[0];
    // identified by the embedded modworkshop id; id itself is an opaque source-scoped key
    assert_eq!(m.remote_id.as_deref(), Some("300"));
    assert_eq!(
        m.id,
        crate::commands::sources::source_native_local_id("modworkshop", "300")
    );
    assert_eq!(m.name, "Cool Mod (Official Name)"); // real name pulled from the index
    assert_eq!(m.file_id, None); // a drifted install pins no specific file
    assert_eq!(m.version, "2.0"); // installed version = the mod's own declaration
}

#[test]
fn identify_untracked_hash_beats_embedded_id() {
    let game = TempDir::new().unwrap();
    make_mod_dir(
        game.path(),
        None,
        "My Cool Mod",
        "main.xml",
        r#"<AssetUpdates id="300" version="2.0" provider="modworkshop"/>"#,
    );
    let conn = make_index();
    conn.execute_batch(
        "INSERT INTO mods VALUES (1, 2, 300, 'Embedded Mod');
         INSERT INTO mods VALUES (2, 2, 999, 'Hash Match Mod');
         INSERT INTO files VALUES (1, 2, 555, 'deadbeef', '9.0', 'x/main.xml');",
    )
    .unwrap();

    let mods = run_identify(
        game.path(),
        vec![("My Cool Mod".to_string(), true, None)],
        vec![Some("deadbeef".to_string())], // marker hash matches mod 999
        &conn,
    );

    let m = &mods[0];
    // exact hash wins over the embedded id 300
    assert_eq!(m.remote_id.as_deref(), Some("999"));
    assert_eq!(
        m.id,
        crate::commands::sources::source_native_local_id("modworkshop", "999")
    );
    assert_eq!(m.name, "Hash Match Mod");
    assert_eq!(m.file_id, Some(555));
    assert_eq!(m.version, "9.0");
}

#[test]
fn identify_untracked_embedded_without_version_uses_index_version() {
    let game = TempDir::new().unwrap();
    make_mod_dir(
        game.path(),
        Some("mod_overrides"),
        "Beardlib Mod",
        "main.xml",
        r#"<AssetUpdates id="301" provider="modworkshop"/>"#,
    );
    let conn = make_index();
    conn.execute_batch(
        "INSERT INTO mods VALUES (1, 2, 301, 'Beardlib Mod Official');
         INSERT INTO files VALUES (1, 1, 800, 'sha', '3.3', 'x/main.xml');",
    )
    .unwrap();

    let mods = run_identify(
        game.path(),
        vec![(
            "Beardlib Mod".to_string(),
            true,
            Some("mod_overrides".to_string()),
        )],
        vec![Some("nomatch".to_string())],
        &conn,
    );

    let m = &mods[0];
    assert_eq!(m.remote_id.as_deref(), Some("301"));
    assert_eq!(
        m.id,
        crate::commands::sources::source_native_local_id("modworkshop", "301")
    );
    assert_eq!(m.version, "3.3"); // no declared version → index's current version (avoids false update)
    assert_eq!(m.file_id, None);
}

#[test]
fn identify_untracked_falls_back_to_name_without_embedded() {
    let game = TempDir::new().unwrap();
    // mod.txt mod — no main.xml, so no embedded id; resolution drops to name match.
    make_mod_dir(game.path(), None, "SomeMod", "mod.txt", "{}");
    let conn = make_index();
    conn.execute_batch(
        "INSERT INTO mods VALUES (1, 2, 555, 'SomeMod');
         INSERT INTO files VALUES (1, 1, 900, 'othersha', '1.0', 'x/mod.txt');",
    )
    .unwrap();

    let mods = run_identify(
        game.path(),
        vec![("SomeMod".to_string(), true, None)],
        vec![Some("nomatch".to_string())],
        &conn,
    );

    let m = &mods[0];
    // matched by name
    assert_eq!(m.remote_id.as_deref(), Some("555"));
    assert_eq!(
        m.id,
        crate::commands::sources::source_native_local_id("modworkshop", "555")
    );
    assert_eq!(m.file_id, None);
    // SHA256 missed the index's current file, so the installed bytes are known-stale.
    // Outdated (not Unknown) is what surfaces an update instead of suppressing it, and
    // the version stays empty because no comparable value was ever recovered.
    assert_eq!(m.update_status, UpdateStatus::Outdated);
    assert_eq!(m.version, "");
}

// ── File-unit install/enable/disable/uninstall carry IoStore sidecars ────────
// Crime Boss (and some PAYDAY 3) mods ship a .pak plus .ucas/.utoc siblings sharing one
// stem; every File-unit op must move all three together even though InstalledMod only
// ever stores the .pak filename.

fn iostore_mod_source() -> (TempDir, std::path::PathBuf) {
    let src = TempDir::new().unwrap();
    let pak = src.path().join("TestMod.pak");
    fs::write(&pak, b"pak header").unwrap();
    fs::write(src.path().join("TestMod.ucas"), b"bulk data").unwrap();
    fs::write(src.path().join("TestMod.utoc"), b"table of contents").unwrap();
    (src, pak)
}

fn iostore_mod_data() -> InstalledMod {
    InstalledMod {
        uid: "1".into(),
        id: 1,
        name: "Test Mod".into(),
        filename: "TestMod.pak".into(),
        enabled: true,
        file_id: Some(1),
        ..InstalledMod::default()
    }
}

#[test]
fn install_carries_iostore_sidecars_alongside_pak() {
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("cb").unwrap();
    let sp = get_state_path(game, cfg);
    let (_src, pak) = iostore_mod_source();

    install_mod_from_path(
        game,
        &sp,
        iostore_mod_data(),
        &pak,
        None,
        cfg,
        cfg.target_for(Some("paks")),
    )
    .unwrap();

    let filename = read_state(&sp).mods[0].filename.clone();
    let stem = std::path::Path::new(&filename)
        .file_stem()
        .unwrap()
        .to_str()
        .unwrap();
    let active_dir = tmp.path().join("CrimeBoss/Content/Paks/~mods");
    assert_eq!(fs::read(active_dir.join(&filename)).unwrap(), b"pak header");
    assert_eq!(
        fs::read(active_dir.join(format!("{stem}.ucas"))).unwrap(),
        b"bulk data"
    );
    assert_eq!(
        fs::read(active_dir.join(format!("{stem}.utoc"))).unwrap(),
        b"table of contents"
    );
}

#[test]
fn disable_then_enable_carries_iostore_sidecars() {
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("cb").unwrap();
    let sp = get_state_path(game, cfg);
    let (_src, pak) = iostore_mod_source();
    install_mod_from_path(
        game,
        &sp,
        iostore_mod_data(),
        &pak,
        None,
        cfg,
        cfg.target_for(Some("paks")),
    )
    .unwrap();

    let filename = read_state(&sp).mods[0].filename.clone();
    let stem = std::path::Path::new(&filename)
        .file_stem()
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let active_dir = tmp.path().join("CrimeBoss/Content/Paks/~mods");
    let disabled_dir = active_dir.join("disabled");

    disable_mod_op(game, &sp, "1", cfg, None);
    assert!(!active_dir.join(format!("{stem}.ucas")).exists());
    assert!(!active_dir.join(format!("{stem}.utoc")).exists());
    // Disabled File-unit mods get both a different directory and a `.disabled`-suffixed
    // filename (see naming::sidecar_path) — sidecars must carry the same suffix.
    assert!(disabled_dir.join(format!("{stem}.ucas.disabled")).exists());
    assert!(disabled_dir.join(format!("{stem}.utoc.disabled")).exists());

    enable_mod_op(game, &sp, "1", cfg, None);
    assert!(active_dir.join(format!("{stem}.ucas")).exists());
    assert!(active_dir.join(format!("{stem}.utoc")).exists());
    assert!(!disabled_dir.join(format!("{stem}.ucas")).exists());
    assert!(!disabled_dir.join(format!("{stem}.utoc")).exists());
}

#[test]
fn uninstall_removes_iostore_sidecars() {
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("cb").unwrap();
    let sp = get_state_path(game, cfg);
    let (_src, pak) = iostore_mod_source();
    install_mod_from_path(
        game,
        &sp,
        iostore_mod_data(),
        &pak,
        None,
        cfg,
        cfg.target_for(Some("paks")),
    )
    .unwrap();

    let filename = read_state(&sp).mods[0].filename.clone();
    let stem = std::path::Path::new(&filename)
        .file_stem()
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let active_dir = tmp.path().join("CrimeBoss/Content/Paks/~mods");

    uninstall_mod_op(game, &sp, "1", cfg);

    assert!(!active_dir.join(&filename).exists());
    assert!(!active_dir.join(format!("{stem}.ucas")).exists());
    assert!(!active_dir.join(format!("{stem}.utoc")).exists());
}

// Real-world Crime Boss ModKit "Package Mod" output is a folder users are told to copy into
// `CrimeBoss/Mods/<name>/`: `<name>/Content/Paks/WindowsNoEditor/<name>-WindowsNoEditor.{pak,ucas,utoc}`
// (verified against the actual "More Multiplayer Jobs" download from modworkshop, mod id 54316).
// `CrimeBoss/Mods/` is the primary install target (the official UGC mod-loader there merges
// multiple mods' Data Table Extensions additively; the legacy `~mods` target is generic Unreal
// pak-mounting with no merge semantics — see engine.rs's CRIMEBOSS_ENGINE comment). Regardless
// of how the archive nests the triplet, Modrex always synthesizes the canonical
// `Content/Paks/WindowsNoEditor/` skeleton itself rather than copying the archive's wrapper
// folder as-is.
#[test]
fn modkit_packaged_archive_installs_into_crimeboss_mods_skeleton() {
    let zip = make_zip(&[
        ("MoreMPJobs/", b""),
        ("MoreMPJobs/Content/", b""),
        ("MoreMPJobs/Content/Paks/", b""),
        ("MoreMPJobs/Content/Paks/WindowsNoEditor/", b""),
        (
            "MoreMPJobs/Content/Paks/WindowsNoEditor/MoreMPJobsCrimeBoss-WindowsNoEditor.pak",
            b"pak header",
        ),
        (
            "MoreMPJobs/Content/Paks/WindowsNoEditor/MoreMPJobsCrimeBoss-WindowsNoEditor.ucas",
            b"bulk data",
        ),
        (
            "MoreMPJobs/Content/Paks/WindowsNoEditor/MoreMPJobsCrimeBoss-WindowsNoEditor.utoc",
            b"table of contents",
        ),
    ]);

    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("cb").unwrap();
    let sp = get_state_path(game, cfg);

    let (extracted, _orig, location_tag) =
        resolve_archive_download(zip.path().to_path_buf(), cfg).unwrap();
    assert_eq!(
        location_tag, None,
        "new installs always resolve to the primary Mods/ target"
    );

    let mod_name = "More Multiplayer Jobs";
    let mod_data = InstalledMod {
        uid: "1".into(),
        id: 1,
        name: mod_name.into(),
        filename: mod_folder_name(mod_name),
        enabled: true,
        file_id: Some(1),
        ..InstalledMod::default()
    };
    install_mod_from_path(game, &sp, mod_data, &extracted, None, cfg, cfg.primary()).unwrap();

    let pak_dir = tmp
        .path()
        .join("CrimeBoss/Mods/More_Multiplayer_Jobs/Content/Paks/WindowsNoEditor");
    assert_eq!(
        fs::read(pak_dir.join("MoreMPJobsCrimeBoss-WindowsNoEditor.pak")).unwrap(),
        b"pak header"
    );
    assert_eq!(
        fs::read(pak_dir.join("MoreMPJobsCrimeBoss-WindowsNoEditor.ucas")).unwrap(),
        b"bulk data"
    );
    assert_eq!(
        fs::read(pak_dir.join("MoreMPJobsCrimeBoss-WindowsNoEditor.utoc")).unwrap(),
        b"table of contents"
    );
    // The legacy loose-triplet target is never touched by a new install.
    assert!(!tmp.path().join("CrimeBoss/Content/Paks/~mods").exists());
}

// The loose-triplet convention (no wrapper folder at all — e.g. modworkshop's #1 most-downloaded
// Crime Boss mod, "Total Mission Value") must resolve into the exact same Mods/ skeleton.
#[test]
fn loose_triplet_archive_also_installs_into_crimeboss_mods_skeleton() {
    let zip = make_zip(&[
        ("Nadz_TotalMissionValue_P.pak", b"pak header"),
        ("Nadz_TotalMissionValue_P.ucas", b"bulk data"),
        ("Nadz_TotalMissionValue_P.utoc", b"table of contents"),
    ]);

    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("cb").unwrap();
    let sp = get_state_path(game, cfg);

    let (extracted, _orig, location_tag) =
        resolve_archive_download(zip.path().to_path_buf(), cfg).unwrap();
    assert_eq!(location_tag, None);

    let mod_name = "Total Mission Value";
    let mod_data = InstalledMod {
        uid: "1".into(),
        id: 1,
        name: mod_name.into(),
        filename: mod_folder_name(mod_name),
        enabled: true,
        file_id: Some(1),
        ..InstalledMod::default()
    };
    install_mod_from_path(game, &sp, mod_data, &extracted, None, cfg, cfg.primary()).unwrap();

    let pak_dir = tmp
        .path()
        .join("CrimeBoss/Mods/Total_Mission_Value/Content/Paks/WindowsNoEditor");
    assert_eq!(
        fs::read(pak_dir.join("Nadz_TotalMissionValue_P.pak")).unwrap(),
        b"pak header"
    );
    assert_eq!(
        fs::read(pak_dir.join("Nadz_TotalMissionValue_P.ucas")).unwrap(),
        b"bulk data"
    );
}

// Identification of pre-existing/manually-placed Mods/ content must hash the .pak specifically,
// not "first file alphabetically" — a sibling Config/ folder (custom gameplay tags, per the
// ModKit docs) sorts before Content/ and would otherwise be hashed instead.
#[test]
fn hashable_file_for_mod_dir_prefers_pak_over_alphabetically_first_file() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("Config/Tags")).unwrap();
    fs::write(dir.path().join("Config/Tags/Tags.ini"), b"[Mod]\n").unwrap();
    let pak_dir = dir.path().join("Content/Paks/WindowsNoEditor");
    fs::create_dir_all(&pak_dir).unwrap();
    fs::write(pak_dir.join("SomeMod-WindowsNoEditor.pak"), b"pak bytes").unwrap();

    let hashed = hashable_file_for_mod_dir(dir.path()).unwrap();
    assert_eq!(hashed, pak_dir.join("SomeMod-WindowsNoEditor.pak"));
}

// RAID BLT mods: the marker must win over the alphabetical-first file (which sorts before
// supermod.xml for typical mods, e.g. WolfgangHUD's WolfgangHUDTweakData.lua) because
// modrex-index records SHA256 for the marker, not the first file.
#[test]
fn hashable_file_for_mod_dir_prefers_raid_supermod_marker() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("AaaFirst.lua"), b"lua").unwrap();
    fs::write(dir.path().join("supermod.xml"), b"<mod/>").unwrap();
    assert_eq!(
        hashable_file_for_mod_dir(dir.path()).unwrap(),
        dir.path().join("supermod.xml")
    );
}

#[test]
fn hashable_file_for_mod_dir_prefers_supermod_over_legacy_mod_xml() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("mod.xml"), b"<table/>").unwrap();
    fs::write(dir.path().join("supermod.xml"), b"<mod/>").unwrap();
    assert_eq!(
        hashable_file_for_mod_dir(dir.path()).unwrap(),
        dir.path().join("supermod.xml")
    );
}

// ── crimeboss_settings: ModSettings id derivation / file sync ────────────────
// Derivation and schema verified against real installs (see CLAUDE.md's Crime Boss section):
// e.g. DallasPDCrimeBoss-WindowsNoEditor.pak <-> Saved/ModSettings/dallaspd.json.

#[test]
fn settings_id_strips_suffix_and_lowercases() {
    assert_eq!(
        settings_id_from_pak_filename("DallasPDCrimeBoss-WindowsNoEditor.pak"),
        Some("dallaspd".to_string())
    );
    assert_eq!(
        settings_id_from_pak_filename("MoreWeaponVariantsCrimeBoss-WindowsNoEditor.pak"),
        Some("moreweaponvariants".to_string())
    );
}

#[test]
fn settings_id_strips_legacy_priority_prefix_first() {
    // The legacy `~mods` target applies a load-order prefix (e.g. `001_`) that the in-game id has
    // no awareness of — stripping it must happen before suffix-matching, not after.
    assert_eq!(
        settings_id_from_pak_filename("001_DallasPDCrimeBoss-WindowsNoEditor.pak"),
        Some("dallaspd".to_string())
    );
}

#[test]
fn settings_id_none_for_non_modkit_naming() {
    // "Total Mission Value" — a real mod predating/bypassing the ModKit's standard pipeline.
    assert_eq!(
        settings_id_from_pak_filename("Nadz_TotalMissionValue_P.pak"),
        None
    );
    assert_eq!(
        settings_id_from_pak_filename("CrimeBoss-WindowsNoEditor.pak"),
        None
    );
    assert_eq!(settings_id_from_pak_filename("NotEvenAPak.txt"), None);
}

#[test]
fn find_pak_in_dir_finds_the_pak_and_ignores_siblings() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("SomeMod-WindowsNoEditor.ucas"), b"").unwrap();
    fs::write(dir.path().join("SomeMod-WindowsNoEditor.pak"), b"").unwrap();
    assert_eq!(
        find_pak_in_dir(dir.path()),
        Some(dir.path().join("SomeMod-WindowsNoEditor.pak"))
    );
}

#[test]
fn find_pak_in_dir_none_when_missing() {
    let dir = TempDir::new().unwrap();
    assert_eq!(find_pak_in_dir(dir.path()), None);
    assert_eq!(find_pak_in_dir(&dir.path().join("nonexistent")), None);
}

#[test]
fn set_enabled_in_file_noops_when_file_missing() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nonexistent.json");
    set_enabled_in_file(&path, false).unwrap();
    assert!(!path.exists());
}

#[test]
fn set_enabled_in_file_flips_value_preserving_other_entries() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("mod.json");
    fs::write(
        &path,
        r#"[{"name":"enabled","value":"true"},{"name":"volume","value":"0.8"}]"#,
    )
    .unwrap();

    set_enabled_in_file(&path, false).unwrap();

    let entries: Vec<serde_json::Value> =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(entries.len(), 2, "custom setting must survive the write");
    let enabled = entries
        .iter()
        .find(|e| e["name"] == "enabled")
        .expect("enabled entry");
    assert_eq!(enabled["value"], "false");
    let volume = entries
        .iter()
        .find(|e| e["name"] == "volume")
        .expect("volume entry untouched");
    assert_eq!(volume["value"], "0.8");
}

#[test]
fn set_enabled_in_file_appends_entry_when_absent() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("mod.json");
    fs::write(&path, r#"[{"name":"volume","value":"0.8"}]"#).unwrap();

    set_enabled_in_file(&path, true).unwrap();

    let entries: Vec<serde_json::Value> =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .any(|e| e["name"] == "enabled" && e["value"] == "true"));
}

#[test]
fn read_enabled_from_file_reads_the_current_value() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("mod.json");
    fs::write(&path, r#"[{"name":"enabled","value":"false"}]"#).unwrap();
    assert_eq!(read_enabled_from_file(&path), Some(false));
}

#[test]
fn read_enabled_from_file_none_when_missing_or_malformed() {
    let dir = TempDir::new().unwrap();
    assert_eq!(
        read_enabled_from_file(&dir.path().join("nonexistent.json")),
        None
    );

    let bad = dir.path().join("bad.json");
    fs::write(&bad, "not json").unwrap();
    assert_eq!(read_enabled_from_file(&bad), None);

    let no_enabled_entry = dir.path().join("no_enabled.json");
    fs::write(&no_enabled_entry, r#"[{"name":"volume","value":"0.8"}]"#).unwrap();
    assert_eq!(read_enabled_from_file(&no_enabled_entry), None);
}

// ── enable after in-game disable (M40 / resync bug) ──────────────────────────
// resync_crimeboss_enabled_flags sets m.enabled=false without moving files, leaving them at the
// active path. enable_mod_op must still sync the settings file in that state.
#[test]
fn enable_mod_op_syncs_settings_when_files_are_at_active_path_but_state_says_disabled() {
    let game_tmp = TempDir::new().unwrap();
    let game = game_tmp.path().to_str().unwrap();
    let cfg = engine_for_game("cb").unwrap();
    let sp = get_state_path(game, cfg);

    // Lay down the pak at the active location (files are here, as after a first install).
    let pak_dir = game_tmp
        .path()
        .join("CrimeBoss/Mods/M40_Dallas_Payday/Content/Paks/WindowsNoEditor");
    fs::create_dir_all(&pak_dir).unwrap();
    fs::write(
        pak_dir.join("M40DallasPDCrimeBoss-WindowsNoEditor.pak"),
        b"pak",
    )
    .unwrap();

    // State as left by resync_crimeboss_enabled_flags: enabled=false but files at active path.
    let mut s = read_state(&sp);
    s.mods.push(InstalledMod {
        uid: "1".into(),
        id: 1,
        name: "M40 Dallas Payday".into(),
        filename: "M40_Dallas_Payday".into(),
        enabled: false,
        ..InstalledMod::default()
    });
    save_state(&sp, &s);

    // ModSettings file exists (game created it on first launch) with "false".
    let profile_tmp = TempDir::new().unwrap();
    let settings_dir = profile_tmp
        .path()
        .join("Saved Games/CrimeBoss/Steam/Saved/ModSettings");
    fs::create_dir_all(&settings_dir).unwrap();
    let settings_file = settings_dir.join("m40dallaspd.json");
    fs::write(&settings_file, r#"[{"name":"enabled","value":"false"}]"#).unwrap();

    std::env::set_var("USERPROFILE", profile_tmp.path());

    enable_mod_op(game, &sp, "1", cfg, Some("steam"));

    std::env::remove_var("USERPROFILE");

    let entries: Vec<serde_json::Value> =
        serde_json::from_str(&fs::read_to_string(&settings_file).unwrap()).unwrap();
    let enabled_val = entries
        .iter()
        .find(|e| e["name"] == "enabled")
        .and_then(|e| e["value"].as_str())
        .unwrap_or("missing");
    assert_eq!(
        enabled_val, "true",
        "settings file must be synced to true so the next resync doesn't immediately re-disable"
    );
    assert!(
        read_state(&sp).mods[0].enabled,
        "state must reflect enabled"
    );
}

// ── ue4ss_modstxt: UE4SS mods.txt sync ────────────────────────────────────────
// Fixture matches the real UE4SS-CB mods.txt byte-for-byte (BOM, CRLF, blank lines, comment,
// trailing "do not move up" warning) — verified against the actual downloaded release.

const UE4SS_MODSTXT_FIXTURE: &str = "\u{FEFF}CheatManagerEnablerMod : 1\r\nActorDumperMod : 0\r\nConsoleCommandsMod : 1\r\nConsoleEnablerMod : 1\r\n\r\n\r\n; Built-in keybinds, do not move up!\r\nKeybinds : 1\r\n";

#[test]
fn entry_name_ignores_bom_blanks_and_comments() {
    assert_eq!(
        entry_name("\u{FEFF}CheatManagerEnablerMod : 1"),
        Some("CheatManagerEnablerMod")
    );
    assert_eq!(entry_name("ActorDumperMod : 0"), Some("ActorDumperMod"));
    assert_eq!(entry_name(""), None);
    assert_eq!(entry_name("; Built-in keybinds, do not move up!"), None);
}

#[test]
fn set_enabled_in_mods_txt_noops_when_file_missing() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("mods.txt");
    set_enabled_in_mods_txt(&path, "Anything", true).unwrap();
    assert!(!path.exists());
}

#[test]
fn set_enabled_in_mods_txt_flips_first_entry_despite_leading_bom() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("mods.txt");
    fs::write(&path, UE4SS_MODSTXT_FIXTURE).unwrap();

    set_enabled_in_mods_txt(&path, "CheatManagerEnablerMod", false).unwrap();
    assert_eq!(
        read_enabled_from_mods_txt(&path, "CheatManagerEnablerMod"),
        Some(false)
    );
    // Untouched entries keep their values.
    assert_eq!(
        read_enabled_from_mods_txt(&path, "ActorDumperMod"),
        Some(false)
    );
    assert_eq!(
        read_enabled_from_mods_txt(&path, "ConsoleCommandsMod"),
        Some(true)
    );
}

#[test]
fn set_enabled_in_mods_txt_preserves_comments_and_blank_lines() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("mods.txt");
    fs::write(&path, UE4SS_MODSTXT_FIXTURE).unwrap();

    set_enabled_in_mods_txt(&path, "Keybinds", false).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains("; Built-in keybinds, do not move up!"));
    assert!(content.contains("\r\n\r\n\r\n"));
    assert_eq!(read_enabled_from_mods_txt(&path, "Keybinds"), Some(false));
}

#[test]
fn set_enabled_in_mods_txt_appends_a_new_line_for_an_unknown_mod() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("mods.txt");
    fs::write(&path, UE4SS_MODSTXT_FIXTURE).unwrap();

    set_enabled_in_mods_txt(&path, "MyNewSubMod", true).unwrap();
    assert_eq!(read_enabled_from_mods_txt(&path, "MyNewSubMod"), Some(true));
    // Existing entries are still intact.
    assert_eq!(read_enabled_from_mods_txt(&path, "Keybinds"), Some(true));
}

#[test]
fn disable_then_enable_ue4ss_submod_edits_mods_txt_not_files() {
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let cfg = engine_for_game("cb").unwrap();
    let sp = get_state_path(game, cfg);
    let target = cfg.target_for(Some("ue4ss_mods"));

    // The source folder a fresh install would extract: Mods/CoolMod/Scripts/main.lua.
    let src_parent = TempDir::new().unwrap();
    let src = src_parent.path().join("CoolMod");
    fs::create_dir_all(src.join("Scripts")).unwrap();
    fs::write(src.join("Scripts").join("main.lua"), b"-- lua").unwrap();

    let mod_data = InstalledMod {
        uid: "1".into(),
        id: 1,
        name: "Cool Mod".into(),
        filename: "CoolMod".into(),
        enabled: true,
        file_id: Some(1),
        ..InstalledMod::default()
    };
    install_mod_from_path(game, &sp, mod_data, &src, None, cfg, target).unwrap();

    // UE4SS owns mods.txt — simulate it already existing with this mod enabled.
    let mods_txt = mods_base(game, target).join("mods.txt");
    fs::write(&mods_txt, "CoolMod : 1\r\n").unwrap();
    let main_lua = mods_base(game, target)
        .join("CoolMod")
        .join("Scripts")
        .join("main.lua");
    assert!(main_lua.exists());

    disable_mod_op(game, &sp, "1", cfg, None);
    // The files never move — only the mods.txt line and the tracked flag change.
    assert!(main_lua.exists());
    assert_eq!(
        read_enabled_from_mods_txt(&mods_txt, "CoolMod"),
        Some(false)
    );
    assert!(!read_state(&sp).mods[0].enabled);

    enable_mod_op(game, &sp, "1", cfg, None);
    assert!(main_lua.exists());
    assert_eq!(read_enabled_from_mods_txt(&mods_txt, "CoolMod"), Some(true));
    assert!(read_state(&sp).mods[0].enabled);
}

#[test]
fn read_enabled_from_mods_txt_none_when_missing_or_unknown() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("mods.txt");
    assert_eq!(read_enabled_from_mods_txt(&path, "Anything"), None);

    fs::write(&path, UE4SS_MODSTXT_FIXTURE).unwrap();
    assert_eq!(read_enabled_from_mods_txt(&path, "NotInFile"), None);
}

// ── Crime Boss multi-pak bundle archives (ZIP_MULTI_PAK) ──────────────────────
// Real-world shape verified against modworkshop mod id 56196 ("Career Criminal Janitor Set"):
// two independent mods ("The Cleaner", "The Sweeper") bundled in one archive, each with its own
// Content/Paks/WindowsNoEditor triplet. install_from_zip_entry (the command this exercises the
// underlying pieces of) can't be unit-tested directly — it needs an AppHandle and makes a network
// call — but resolve_archive_download's detection and extract_entry_into_crimeboss_skeleton's
// per-entry extraction are exactly what it relies on, and both are directly testable.

fn janitor_bundle_zip() -> NamedTempFile {
    make_zip(&[
        ("The Cleaner/", b""),
        ("The Cleaner/Content/", b""),
        ("The Cleaner/Content/Paks/", b""),
        ("The Cleaner/Content/Paks/WindowsNoEditor/", b""),
        (
            "The Cleaner/Content/Paks/WindowsNoEditor/Slippery_JanitorCrimeBoss-WindowsNoEditor.pak",
            b"cleaner pak",
        ),
        (
            "The Cleaner/Content/Paks/WindowsNoEditor/Slippery_JanitorCrimeBoss-WindowsNoEditor.ucas",
            b"cleaner bulk data",
        ),
        (
            "The Cleaner/Content/Paks/WindowsNoEditor/Slippery_JanitorCrimeBoss-WindowsNoEditor.utoc",
            b"cleaner toc",
        ),
        ("The Sweeper/", b""),
        ("The Sweeper/Content/", b""),
        ("The Sweeper/Content/Paks/", b""),
        ("The Sweeper/Content/Paks/WindowsNoEditor/", b""),
        (
            "The Sweeper/Content/Paks/WindowsNoEditor/Career_Criminal_JanitorCrimeBoss-WindowsNoEditor.pak",
            b"sweeper pak",
        ),
        (
            "The Sweeper/Content/Paks/WindowsNoEditor/Career_Criminal_JanitorCrimeBoss-WindowsNoEditor.ucas",
            b"sweeper bulk data",
        ),
        (
            "The Sweeper/Content/Paks/WindowsNoEditor/Career_Criminal_JanitorCrimeBoss-WindowsNoEditor.utoc",
            b"sweeper toc",
        ),
    ])
}

#[test]
fn crimeboss_bundle_archive_resolves_to_zip_multi_pak_with_both_entries() {
    let zip = janitor_bundle_zip();
    let cfg = engine_for_game("cb").unwrap();

    let err = resolve_archive_download(zip.path().to_path_buf(), cfg).unwrap_err();
    let ResolveError::Prompt(prompt) = err else {
        panic!("expected a prompt, got {err:?}");
    };
    let InstallPrompt::ZipMultiPak(zip) = *prompt else {
        panic!("expected a multi-pak prompt");
    };
    // Assert on the serialized shape: it is the renderer wire payload.
    let payload = serde_json::to_value(&zip).unwrap();
    let entries: Vec<&str> = payload["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.as_str().unwrap())
        .collect();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|e| e.contains("Slippery_Janitor")));
    assert!(entries
        .iter()
        .any(|e| e.contains("Career_Criminal_Janitor")));
}

#[test]
fn crimeboss_bundle_archive_each_entry_installs_independently_without_cross_contamination() {
    let zip = janitor_bundle_zip();
    let cfg = engine_for_game("cb").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);

    for (entry, mod_name, expected_pak, expected_bytes) in [
        (
            "The Cleaner/Content/Paks/WindowsNoEditor/Slippery_JanitorCrimeBoss-WindowsNoEditor.pak",
            "The Cleaner",
            "Slippery_JanitorCrimeBoss-WindowsNoEditor.pak",
            b"cleaner pak".as_slice(),
        ),
        (
            "The Sweeper/Content/Paks/WindowsNoEditor/Career_Criminal_JanitorCrimeBoss-WindowsNoEditor.pak",
            "The Sweeper",
            "Career_Criminal_JanitorCrimeBoss-WindowsNoEditor.pak",
            b"sweeper pak".as_slice(),
        ),
    ] {
        let skeleton = extract_entry_into_crimeboss_skeleton(zip.path(), entry).unwrap();
        let mod_data = InstalledMod {
            uid: entry.to_string(),
            id: 1,
            name: mod_name.to_string(),
            filename: mod_folder_name(mod_name),
            enabled: true,
            file_id: Some(1),
            ..InstalledMod::default()
        };
        install_mod_from_path(game, &sp, mod_data, &skeleton, None, cfg, cfg.primary()).unwrap();

        let pak_dir = tmp
            .path()
            .join("CrimeBoss/Mods")
            .join(mod_folder_name(mod_name))
            .join("Content/Paks/WindowsNoEditor");
        assert_eq!(fs::read(pak_dir.join(expected_pak)).unwrap(), expected_bytes);
    }

    // Neither install's content leaked into the other's folder.
    let cleaner_dir = tmp
        .path()
        .join("CrimeBoss/Mods/The_Cleaner/Content/Paks/WindowsNoEditor");
    let sweeper_dir = tmp
        .path()
        .join("CrimeBoss/Mods/The_Sweeper/Content/Paks/WindowsNoEditor");
    assert!(!cleaner_dir
        .join("Career_Criminal_JanitorCrimeBoss-WindowsNoEditor.pak")
        .exists());
    assert!(!sweeper_dir
        .join("Slippery_JanitorCrimeBoss-WindowsNoEditor.pak")
        .exists());
}

// ── reorder respects each target's priority_prefix flag ──────────────────────

#[test]
fn reorder_skips_priority_prefix_for_targets_that_dont_use_it() {
    // Crime Boss's primary `mods` target manages order via ModSettings JSON, not filename
    // prefixes (engine.rs: priority_prefix: false) — reordering must leave the folder name as-is.
    let cfg = engine_for_game("cb").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    save_state(
        &sp,
        &ModsState {
            folders: vec![],
            mods: vec![
                InstalledMod {
                    uid: "a".to_string(),
                    filename: "Foo".to_string(),
                    enabled: true,
                    ..InstalledMod::default()
                },
                InstalledMod {
                    uid: "b".to_string(),
                    filename: "Bar".to_string(),
                    enabled: true,
                    ..InstalledMod::default()
                },
            ],
        },
    );

    reorder_mods_in_folder_op(game, &sp, None, &["b".to_string(), "a".to_string()], cfg);

    let state = read_state(&sp);
    let filenames: Vec<&str> = state.mods.iter().map(|m| m.filename.as_str()).collect();
    assert_eq!(filenames, vec!["Foo", "Bar"]);
}

#[test]
fn reorder_applies_priority_prefix_for_targets_that_use_it() {
    // PD3's `paks` target relies on the numeric prefix for UE5's alphabetical pak load order.
    let cfg = engine_for_game("pd3").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);
    save_state(
        &sp,
        &ModsState {
            folders: vec![],
            mods: vec![
                InstalledMod {
                    uid: "a".to_string(),
                    filename: "Foo.pak".to_string(),
                    enabled: true,
                    ..InstalledMod::default()
                },
                InstalledMod {
                    uid: "b".to_string(),
                    filename: "Bar.pak".to_string(),
                    enabled: true,
                    ..InstalledMod::default()
                },
            ],
        },
    );

    reorder_mods_in_folder_op(game, &sp, None, &["b".to_string(), "a".to_string()], cfg);

    let state = read_state(&sp);
    let filenames: Vec<&str> = state.mods.iter().map(|m| m.filename.as_str()).collect();
    assert_eq!(filenames, vec!["001_Foo.pak", "002_Bar.pak"]);
}

// ── move_crimeboss_mod_target_op ──────────────────────────────────────────────

fn write_skeleton_pak(skeleton_root: &Path, pak_name: &str, content: &[u8]) {
    let pak_dir = skeleton_root
        .join("Content")
        .join("Paks")
        .join("WindowsNoEditor");
    fs::create_dir_all(&pak_dir).unwrap();
    fs::write(pak_dir.join(pak_name), content).unwrap();
}

#[test]
fn move_crimeboss_mod_unwraps_skeleton_into_legacy_paks() {
    let cfg = engine_for_game("cb").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);

    let skeleton = tmp.path().join("src-skeleton");
    write_skeleton_pak(&skeleton, "FooCrimeBoss-WindowsNoEditor.pak", b"pak bytes");
    install_mod_from_path(
        game,
        &sp,
        InstalledMod {
            uid: "a".to_string(),
            name: "Foo".to_string(),
            filename: mod_folder_name("Foo"),
            enabled: true,
            file_id: Some(1),
            ..InstalledMod::default()
        },
        &skeleton,
        None,
        cfg,
        cfg.primary(),
    )
    .unwrap();

    move_crimeboss_mod_target_op(game, &sp, "a", cfg, None).unwrap();

    let state = read_state(&sp);
    let m = state.mods.iter().find(|m| m.uid == "a").unwrap();
    assert_eq!(m.location.as_deref(), Some("paks"));
    assert_eq!(m.filename, "001_FooCrimeBoss-WindowsNoEditor.pak");
    assert!(!tmp
        .path()
        .join("CrimeBoss/Mods")
        .join(mod_folder_name("Foo"))
        .exists());
    let moved = tmp
        .path()
        .join("CrimeBoss/Content/Paks/~mods")
        .join(&m.filename);
    assert_eq!(fs::read(&moved).unwrap(), b"pak bytes");
}

#[test]
fn move_crimeboss_mod_wraps_legacy_pak_into_skeleton() {
    let cfg = engine_for_game("cb").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);

    let pak_src = tmp.path().join("FooCrimeBoss-WindowsNoEditor.pak");
    fs::write(&pak_src, b"pak bytes").unwrap();
    let paks_target = cfg.targets.iter().find(|t| t.tag == "paks").unwrap();
    install_mod_from_path(
        game,
        &sp,
        InstalledMod {
            uid: "a".to_string(),
            name: "Foo".to_string(),
            filename: "FooCrimeBoss-WindowsNoEditor.pak".to_string(),
            enabled: true,
            file_id: Some(1),
            ..InstalledMod::default()
        },
        &pak_src,
        None,
        cfg,
        paks_target,
    )
    .unwrap();
    // priority_prefix is enabled for the legacy target — confirms the fixture matches real installs.
    let state = read_state(&sp);
    assert_eq!(
        state.mods[0].filename,
        "001_FooCrimeBoss-WindowsNoEditor.pak"
    );

    move_crimeboss_mod_target_op(game, &sp, "a", cfg, None).unwrap();

    let state = read_state(&sp);
    let m = state.mods.iter().find(|m| m.uid == "a").unwrap();
    assert_eq!(m.location, None);
    assert_eq!(m.filename, mod_folder_name("Foo"));
    assert!(!tmp
        .path()
        .join("CrimeBoss/Content/Paks/~mods/001_FooCrimeBoss-WindowsNoEditor.pak")
        .exists());
    let moved = tmp
        .path()
        .join("CrimeBoss/Mods")
        .join(mod_folder_name("Foo"))
        .join("Content/Paks/WindowsNoEditor/FooCrimeBoss-WindowsNoEditor.pak");
    assert_eq!(fs::read(&moved).unwrap(), b"pak bytes");
}

#[test]
fn move_crimeboss_mod_preserves_disabled_state() {
    let cfg = engine_for_game("cb").unwrap();
    let tmp = TempDir::new().unwrap();
    let game = tmp.path().to_str().unwrap();
    let sp = get_state_path(game, cfg);

    let skeleton = tmp.path().join("src-skeleton");
    write_skeleton_pak(&skeleton, "FooCrimeBoss-WindowsNoEditor.pak", b"pak bytes");
    install_mod_from_path(
        game,
        &sp,
        InstalledMod {
            uid: "a".to_string(),
            name: "Foo".to_string(),
            filename: mod_folder_name("Foo"),
            enabled: true,
            file_id: Some(1),
            ..InstalledMod::default()
        },
        &skeleton,
        None,
        cfg,
        cfg.primary(),
    )
    .unwrap();
    disable_mod_op(game, &sp, "a", cfg, None);
    assert!(!read_state(&sp).mods[0].enabled);

    move_crimeboss_mod_target_op(game, &sp, "a", cfg, None).unwrap();

    let state = read_state(&sp);
    let m = state.mods.iter().find(|m| m.uid == "a").unwrap();
    assert!(!m.enabled);
    assert_eq!(m.location.as_deref(), Some("paks"));
    let disabled_path = tmp
        .path()
        .join("CrimeBoss/Content/Paks/~mods/disabled")
        .join(format!("{}.disabled", m.filename));
    assert!(disabled_path.exists());
}

// ── stale_entry_for_zip_install ───────────────────────────────────────────────
// Real-world regression shape (Dark Matter Skins, modworkshop 56976): a select-all batch
// install of a 36-entry archive left only the last entry, because every install saw exactly
// one same-id entry — the sibling installed a moment earlier — and pre-removed it.

fn zip_install_entry(uid: &str, remote_id: i64, file_id: i64) -> InstalledMod {
    InstalledMod {
        uid: uid.to_string(),
        id: crate::commands::sources::source_native_local_id("modworkshop", &remote_id.to_string()),
        remote_id: Some(remote_id.to_string()),
        filename: format!("{uid}.pak"),
        enabled: true,
        file_id: Some(file_id),
        ..InstalledMod::default()
    }
}

#[test]
fn stale_entry_keeps_same_archive_sibling() {
    let mods = vec![zip_install_entry("98276_zDarkMatter_AG-9", 56976, 98276)];
    assert!(
        stale_entry_for_zip_install(&mods, "98276_zDarkMatter_ATK-7", 56976, "56976", 98276)
            .is_none()
    );
}

#[test]
fn stale_entry_removes_bare_packaging_of_same_file() {
    let mods = vec![zip_install_entry("98276", 56976, 98276)];
    let stale = stale_entry_for_zip_install(&mods, "98276_zDarkMatter_AG-9", 56976, "56976", 98276);
    assert_eq!(stale.map(|m| m.uid.as_str()), Some("98276"));
}

#[test]
fn stale_entry_removes_older_file_id() {
    for old_uid in ["90000", "90000_OldEntry"] {
        let mods = vec![zip_install_entry(old_uid, 56976, 90000)];
        let stale =
            stale_entry_for_zip_install(&mods, "98276_zDarkMatter_AG-9", 56976, "56976", 98276);
        assert_eq!(stale.map(|m| m.uid.as_str()), Some(old_uid));
    }
}

#[test]
fn stale_entry_none_when_uid_already_installed() {
    let mods = vec![zip_install_entry("98276_zDarkMatter_AG-9", 56976, 98276)];
    assert!(
        stale_entry_for_zip_install(&mods, "98276_zDarkMatter_AG-9", 56976, "56976", 98276)
            .is_none()
    );
}

#[test]
fn stale_entry_none_for_multi_entry_mods_and_negative_ids() {
    let mods = vec![
        zip_install_entry("90000", 56976, 90000),
        zip_install_entry("90001", 56976, 90001),
    ];
    assert!(
        stale_entry_for_zip_install(&mods, "98276_zDarkMatter_AG-9", 56976, "56976", 98276)
            .is_none()
    );

    let mods = vec![zip_install_entry("Foo", -42, 0)];
    assert!(
        stale_entry_for_zip_install(&mods, "98276_zDarkMatter_AG-9", -42, "-42", 98276).is_none()
    );
}

// ── Legacy version-sentinel migration ────────────────────────────────────────

#[test]
fn read_state_migrates_legacy_version_sentinels() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join(".modrex.json");
    // Written by a build predating update_status: the two states were encoded in the
    // version string itself, so an unmigrated read would compare them as real versions.
    fs::write(
        &path,
        r#"{"folders":[],"mods":[
            {"uid":"1","id":1,"name":"Stale","version":"outdated","filename":"a.pak",
             "enabled":true,"installedAt":"2024-01-01"},
            {"uid":"2","id":-2,"name":"Mystery","version":"unknown","filename":"b.pak",
             "enabled":true,"installedAt":"2024-01-01"},
            {"uid":"3","id":3,"name":"Real","version":"2.11","filename":"c.pak",
             "enabled":true,"installedAt":"2024-01-01"}]}"#,
    )
    .unwrap();

    let state = read_state(&path);
    assert_eq!(state.mods[0].update_status, UpdateStatus::Outdated);
    assert_eq!(
        state.mods[0].version, "",
        "sentinel must not survive as a version"
    );
    assert_eq!(state.mods[1].update_status, UpdateStatus::Unknown);
    assert_eq!(state.mods[1].version, "");
    // A real version is left completely alone.
    assert_eq!(state.mods[2].update_status, UpdateStatus::Known);
    assert_eq!(state.mods[2].version, "2.11");
}
