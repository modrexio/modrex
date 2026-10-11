use super::types::InstalledMod;
use super::{cleanup, decisions, engine, staged, staging_tokens, zip};
use std::fs;
use std::io::Write;
use tempfile::{NamedTempFile, TempDir};

fn archive(entries: &[(&str, &[u8])]) -> NamedTempFile {
    let file = NamedTempFile::new().unwrap();
    let mut archive = ::zip::ZipWriter::new(fs::File::create(file.path()).unwrap());
    for (name, bytes) in entries {
        archive
            .start_file(*name, ::zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(bytes).unwrap();
    }
    archive.finish().unwrap();
    file
}

#[test]
fn shared_archive_single_pak_preserves_author_name_and_drops_inert_docs() {
    let cfg = engine::engine_for_game("ron").unwrap();
    for name in [
        "pakchunk99-Map_HellComesToTheHills.pak",
        "pakchunk999-Mods_FISAJACKET_P.PAK",
    ] {
        let zip = archive(&[(name, b"pak"), ("README.txt", b"instructions")]);
        let staged = zip::resolve_archive_download(
            zip.path().into(),
            cfg,
            &staging_tokens::StagingRegistry::new(),
        )
        .unwrap();
        assert_eq!(staged.root.file_name().unwrap().to_str().unwrap(), name);
        assert_eq!(fs::read(&staged.root).unwrap(), b"pak");
        assert!(!staged.root.parent().unwrap().join("README.txt").exists());
        let filename = decisions::install_filename_for_dropped(cfg, cfg.primary(), name);
        assert_eq!(filename, name);
        cleanup::run_sync(&staged.cleanup);
        cleanup::run_sync(&cleanup::CleanupPlan::RemoveOwnedFile(
            staged.original_archive.unwrap(),
        ));
    }
}

#[test]
fn shared_archive_real_ai_alternatives_issue_explicit_member_grants() {
    let cfg = engine::engine_for_game("ron").unwrap();
    let zip = archive(&[
        ("Created by TheKillerMax", b"author"),
        ("Discord thekillermax", b"contact"),
        ("Hard/pakchunk9999-SixDays_P.pak", b"hard"),
        ("Realistic/pakchunk9999-SixDays_P.pak", b"realistic"),
    ]);
    let registry = staging_tokens::StagingRegistry::new();
    let Err(zip::ResolveError::Prompt(prompt)) =
        zip::resolve_archive_download(zip.path().into(), cfg, &registry)
    else {
        panic!("Alternative profiles must require selection");
    };
    let zip::InstallPrompt::ZipMultiPak(picker) = *prompt else {
        panic!("Expected Pak picker");
    };
    assert!(picker.shared_paks);
    assert_eq!(
        picker.entries,
        [
            "Hard/pakchunk9999-SixDays_P.pak",
            "Realistic/pakchunk9999-SixDays_P.pak"
        ]
    );
    assert_ne!(picker.entry_ids[0], picker.entry_ids[1]);
    registry.restrict_to_nexus(&picker.archive_handle).unwrap();
    assert!(registry
        .borrow(
            &picker.archive_handle,
            staging_tokens::StagedArchiveKind::MultiEntry
        )
        .is_none());
    assert!(registry
        .borrow(
            &picker.archive_handle,
            staging_tokens::StagedArchiveKind::NexusResourcePak
        )
        .is_some());
    registry.release(&picker.archive_handle);
    cleanup::run_sync(&registry.finalize(&picker.archive_handle).unwrap());
    assert!(!zip.path().exists());
}

#[test]
fn shared_archive_refuses_every_unsupported_member_before_issuing_a_grant() {
    let cfg = engine::engine_for_game("ron").unwrap();
    for name in [
        "Music.bank",
        "VO_MOD/TOC/line.ogg",
        "Intro.bk2",
        "Input.ini",
        "GameUserSettings.ini",
        "Scalability.ini",
        "ReShade.ini",
        "mods.txt",
        "mods.json",
        "ue4ss/UE4SS-settings.ini",
        "ue4ss/Mods/Scripts/main.lua",
        "dwmapi.dll",
        "ue4ss/UE4SS.dll",
        "Payload.ucas",
        "Payload.utoc",
        "Payload.sig",
        "installer.exe",
        "unknown.json",
    ] {
        let zip = archive(&[("Payload_P.pak", b"pak"), (name, b"runtime")]);
        let registry = staging_tokens::StagingRegistry::new();
        let Err(zip::ResolveError::Failure(error)) =
            zip::resolve_archive_download(zip.path().into(), cfg, &registry)
        else {
            panic!("Unsupported member {name} must refuse the entire package");
        };
        assert!(error.contains(name), "{error}");
        assert!(error.contains("Nothing was installed"));
        assert!(!zip.path().exists());
    }
}

#[test]
fn shared_archive_loose_drops_keep_the_author_name_and_reject_runtime_formats() {
    let cfg = engine::engine_for_game("ron").unwrap();
    let tmp = TempDir::new().unwrap();
    for extension in [
        "pak", "PAK", "bank", "ini", "dll", "ogg", "mp4", "ucas", "txt",
    ] {
        let path = tmp.path().join(format!("uuid.{extension}"));
        fs::write(&path, b"payload").unwrap();
        let result = zip::resolve_archive_download(
            path.clone(),
            cfg,
            &staging_tokens::StagingRegistry::new(),
        );
        if extension.eq_ignore_ascii_case("pak") {
            let staged = result.unwrap();
            assert_eq!(staged.name_source, staged::NameSource::FromModDisplayName);
            assert_eq!(
                decisions::loose_published_filename(cfg.primary(), "pakchunk999-z Patch_P.pak")
                    .unwrap(),
                "pakchunk999-z Patch_P.pak"
            );
            assert_eq!(
                decisions::loose_published_filename(cfg.primary(), "pakchunk999-z Patch_P.PAK")
                    .unwrap(),
                "pakchunk999-z Patch_P.PAK"
            );
            assert_eq!(
                decisions::install_filename_for_dropped(
                    cfg,
                    cfg.primary(),
                    "pakchunk999-z Patch_P"
                ),
                "pakchunk999-z Patch_P.pak"
            );
            cleanup::run_sync(&staged.cleanup);
            continue;
        }
        if extension.eq_ignore_ascii_case("ini") || extension.eq_ignore_ascii_case("mp4") {
            assert!(matches!(result, Err(zip::ResolveError::Resources(_))));
            assert_eq!(fs::read(&path).unwrap(), b"payload");
            fs::remove_file(&path).unwrap();
            continue;
        }
        assert!(matches!(result, Err(zip::ResolveError::Failure(_))));
        assert!(!path.exists());
    }
    assert!(decisions::loose_published_filename(cfg.primary(), "../Payload.pak").is_err());
    assert!(decisions::loose_published_filename(cfg.primary(), "UE4SS.dll").is_err());
}

#[test]
fn shared_archive_nexus_loose_downloads_refuse_ambiguous_transport_names() {
    let temp = TempDir::new().unwrap();
    for name in [
        "Author_P.pak",
        "Author_P-2759-13-0-1750000000.pak",
        "uuid.pak",
    ] {
        let path = temp.path().join(name);
        fs::write(&path, b"pak").unwrap();
        let error = zip::require_nexus_pak_archive(&path).unwrap_err();
        assert!(error.contains("archive"));
        assert!(error.contains("drop the correctly named file"));
        assert_eq!(fs::read(&path).unwrap(), b"pak");
    }
    let archive = archive(&[("Author_P.pak", b"pak")]);
    assert!(zip::require_nexus_pak_archive(archive.path()).is_ok());
}

#[test]
fn shared_archive_mod_io_paths_are_not_flattened_into_managed_paks() {
    let cfg = engine::engine_for_game("ron").unwrap();
    for name in [
        "ReadyOrNot/Content/Paks/mod.io/3791/mods/27/Payload.pak",
        "Content/Paks/MOD.IO/3791/mods/27/Payload.pak",
        r"Content\Paks\mod.io\3791\mods\27\Payload.pak",
    ] {
        let archive = archive(&[(name, b"external Pak"), ("Regular_P.pak", b"ordinary Pak")]);
        let registry = staging_tokens::StagingRegistry::new();
        let Err(zip::ResolveError::Failure(error)) =
            zip::resolve_archive_download(archive.path().into(), cfg, &registry)
        else {
            panic!("mod.io subscription content must not be partially installed");
        };
        assert!(error.contains("mod.io subscription"));
        assert!(error.contains("Nothing was installed"));
        assert!(!archive.path().exists());
    }
}

#[test]
fn shared_archive_duplicate_normalized_members_fail_before_staging() {
    let cfg = engine::engine_for_game("ron").unwrap();
    for names in [
        ["Raw\\Payload_P.pak", "Raw/Payload_P.pak"],
        ["Raw/Payload_P.pak", "raw/payload_p.PAK"],
        ["Raw/Payload_P.pak", "Raw/Payload_P.pak"],
        ["Raw/Payload_P.pak", "Raw/./Payload_P.pak"],
        ["Raw/Payload_P.pak", "Raw//Payload_P.pak"],
    ] {
        let file = NamedTempFile::new().unwrap();
        let encoder = flate2::write::GzEncoder::new(
            fs::File::create(file.path()).unwrap(),
            flate2::Compression::default(),
        );
        let mut archive = tar::Builder::new(encoder);
        for name in names {
            let mut header = tar::Header::new_gnu();
            header.set_size(3);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, name, &b"pak"[..]).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
        let registry = staging_tokens::StagingRegistry::new();
        let Err(zip::ResolveError::Failure(error)) =
            zip::resolve_archive_download(file.path().into(), cfg, &registry)
        else {
            panic!("Duplicate normalized member names must refuse the archive");
        };
        assert!(error.contains("duplicate package paths"), "{error}");
        assert!(error.contains("Nothing was installed"));
        assert!(!file.path().exists());
    }
}

#[test]
fn shared_archive_local_variant_records_keep_full_member_without_catalog_claims() {
    let cfg = engine::engine_for_game("ron").unwrap();
    let archive = archive(&[
        ("Hard/Payload_P.pak", b"hard"),
        ("Realistic/Payload_P.pak", b"realistic"),
    ]);
    let registry = staging_tokens::StagingRegistry::new();
    let Err(zip::ResolveError::Prompt(prompt)) =
        zip::resolve_archive_download(archive.path().into(), cfg, &registry)
    else {
        panic!("Variants must issue a picker");
    };
    let zip::InstallPrompt::ZipMultiPak(picker) = *prompt else {
        panic!("Expected Pak picker");
    };
    let temp = TempDir::new().unwrap();
    let mut records = Vec::new();
    for (pos, member) in picker.entries.iter().enumerate() {
        let entry = registry
            .entry(
                &picker.archive_handle,
                staging_tokens::StagedArchiveKind::MultiEntry,
                picker.entry_ids[pos],
            )
            .unwrap();
        let (stem, filename) = super::entry_names(member);
        let (staged, cleanup) = super::stage_archive_entry(
            cfg,
            cfg.primary(),
            archive.path(),
            &entry,
            false,
            &filename,
        )
        .unwrap();
        assert_eq!(
            fs::read(&staged).unwrap(),
            if pos == 0 {
                b"hard".as_slice()
            } else {
                b"realistic".as_slice()
            }
        );
        let record = InstalledMod {
            filename,
            enabled: true,
            ..decisions::archive_entry_identity(
                cfg.primary(),
                0,
                -123,
                member,
                &stem,
                "Payload_P.pak",
            )
        };
        assert_eq!(record.uid, format!("local:-123:entry:{member}"));
        assert_eq!(record.source, "local");
        assert!(record.id < 0);
        assert!(record.remote_id.is_none());
        assert!(record.file_id.is_none());
        assert!(record.identity.is_none());
        records.push(record);
        cleanup::run_sync(&cleanup);
    }
    assert_ne!(records[0].uid, records[1].uid);
    let state_path = temp.path().join(".modrex.json");
    super::state::save_state(
        &state_path,
        &super::types::ModsState {
            mods: records,
            folders: vec![],
        },
    )
    .unwrap();
    assert_eq!(super::state::read_state(&state_path).unwrap().mods.len(), 2);
    cleanup::run_sync(&registry.finalize(&picker.archive_handle).unwrap());
    let workshop = decisions::archive_entry_identity(
        cfg.primary(),
        456,
        789,
        "Hard/Payload_P.pak",
        "Payload_P",
        "Payload_P.pak",
    );
    assert_eq!(workshop.uid, "789_Payload_P");
    assert_eq!(workshop.remote_id.as_deref(), Some("456"));
    assert_eq!(workshop.file_id, Some(789));
    let legacy = decisions::archive_entry_identity(
        engine::engine_for_game("pd3").unwrap().primary(),
        -123,
        -123,
        "Hard/Payload_P.pak",
        "Payload_P",
        "Payload_P.pak",
    );
    assert_eq!(legacy.uid, "-123_Payload_P");
}

fn nexus_record(uid: &str, filename: &str) -> InstalledMod {
    InstalledMod {
        uid: uid.into(),
        filename: filename.into(),
        source: "nexus".into(),
        remote_id: Some("2759".into()),
        file_id: Some(30700),
        ..InstalledMod::default()
    }
}

#[test]
fn shared_archive_updates_reuse_exact_members_and_unique_legacy_filenames() {
    let mut member = nexus_record("nexus:2759:30700:entry:Hard/Payload_P.pak", "Payload_P.pak");
    member.folder_id = Some("user-folder".into());
    let records = vec![
        member,
        nexus_record("nexus:2759:30000:Other", "Other_P.pak"),
    ];
    let old = decisions::shared_nexus_update(
        &records,
        2759,
        30800,
        "Payload_P.pak",
        Some("Hard/Payload_P.pak"),
        None,
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(old.uid, records[0].uid);
    assert_eq!(old.folder_id.as_deref(), Some("user-folder"));
    assert!(decisions::shared_nexus_update(
        &records,
        2759,
        30800,
        "Payload_P.pak",
        Some("Realistic/Payload_P.pak"),
        None,
        false
    )
    .is_err());
    let legacy = vec![nexus_record("nexus:2759:30000:Payload_P", "Payload_P.pak")];
    assert_eq!(
        decisions::shared_nexus_update(
            &legacy,
            2759,
            30800,
            "Payload_P.pak",
            Some("Hard/Payload_P.pak"),
            None,
            true
        )
        .unwrap()
        .unwrap()
        .uid,
        legacy[0].uid
    );
    assert!(decisions::shared_nexus_update(
        &legacy,
        2759,
        30800,
        "Payload_P.pak",
        Some("Hard/Payload_P.pak"),
        None,
        false
    )
    .is_err());
    let duplicate = vec![legacy[0].clone(), legacy[0].clone()];
    assert!(decisions::shared_nexus_update(
        &duplicate,
        2759,
        30800,
        "Payload_P.pak",
        Some("Hard/Payload_P.pak"),
        None,
        true
    )
    .is_err());
    assert!(decisions::shared_nexus_update(
        &records,
        1,
        30800,
        "Payload_P.pak",
        Some("Hard/Payload_P.pak"),
        None,
        true
    )
    .unwrap()
    .is_none());
    assert!(decisions::shared_nexus_update(
        &records,
        2759,
        30800,
        "Renamed_P.pak",
        Some("Hard/Renamed_P.pak"),
        None,
        true
    )
    .is_err());
    let mut first_in_batch = nexus_record("nexus:2759:30800:entry:First_P.pak", "First_P.pak");
    first_in_batch.file_id = Some(30800);
    assert!(decisions::shared_nexus_update(
        &[first_in_batch],
        2759,
        30800,
        "Second_P.pak",
        Some("Second_P.pak"),
        None,
        true
    )
    .unwrap()
    .is_none());
}

#[test]
fn shared_archive_single_pak_updates_stay_pending_until_review() {
    let cfg = engine::engine_for_game("ron").unwrap();
    let zip = archive(&[("Renamed_P.pak", b"update")]);
    let registry = staging_tokens::StagingRegistry::new();
    let Err(zip::ResolveError::Prompt(prompt)) =
        zip::shared_pak_update_choice(zip.path().into(), cfg, &registry)
    else {
        panic!("A single Pak update must remain pending for explicit review");
    };
    let zip::InstallPrompt::ZipMultiPak(picker) = *prompt else {
        panic!("Expected Pak picker");
    };
    assert!(picker.shared_paks);
    assert_eq!(picker.entries, ["Renamed_P.pak"]);
    assert!(zip.path().exists());
    cleanup::run_sync(&registry.finalize(&picker.archive_handle).unwrap());
    assert!(!zip.path().exists());
}

#[test]
fn shared_archive_numeric_author_prefixes_keep_distinct_drop_identities() {
    let cfg = engine::engine_for_game("ron").unwrap();
    let temp = TempDir::new().unwrap();
    let mut records = Vec::new();
    for name in ["001_Foo_P.pak", "002_Foo_P.pak"] {
        let filename = decisions::loose_published_filename(cfg.primary(), name).unwrap();
        let uid = decisions::dropped_uid(cfg.primary(), &filename);
        fs::write(temp.path().join(&filename), name.as_bytes()).unwrap();
        records.push(InstalledMod {
            uid,
            filename,
            ..InstalledMod::default()
        });
    }
    assert_ne!(records[0].uid, records[1].uid);
    let path = temp.path().join(".modrex.json");
    super::state::save_state(
        &path,
        &super::types::ModsState {
            mods: records,
            folders: vec![],
        },
    )
    .unwrap();
    let stored = super::state::read_state(&path).unwrap();
    assert_eq!(stored.mods.len(), 2);
    assert_eq!(stored.mods[0].uid, "001_Foo_P.pak");
    assert_eq!(stored.mods[1].uid, "002_Foo_P.pak");
    assert_eq!(
        fs::read(temp.path().join("001_Foo_P.pak")).unwrap(),
        b"001_Foo_P.pak"
    );
    assert_eq!(
        fs::read(temp.path().join("002_Foo_P.pak")).unwrap(),
        b"002_Foo_P.pak"
    );
    assert_eq!(
        decisions::dropped_uid(
            engine::engine_for_game("pd3").unwrap().primary(),
            "001_Foo_P.pak"
        ),
        "Foo_P.pak"
    );
}
