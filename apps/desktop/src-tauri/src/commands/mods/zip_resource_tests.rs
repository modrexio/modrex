use super::*;
use crate::game_package::{ConfigPresets, MovieReplacement, Storefront};
use std::io::Write;

fn archive(name: &str) -> tempfile::NamedTempFile {
    archive_entries(&[(name, b"reviewed payload")])
}

fn archive_entries(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
    let file = tempfile::NamedTempFile::new().unwrap();
    let mut archive = ::zip::ZipWriter::new(File::create(file.path()).unwrap());
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
fn config_and_movie_archive_routing_use_independent_declarations() {
    let cfg = super::super::engine::engine_for_game("pd3").unwrap();
    let registry = StagingRegistry::new();
    let movies = MovieReplacement::Bink {
        directory: vec!["Media".into()],
        storefronts: vec![Storefront::Steam],
        absent_slots: vec![],
    };
    let config = ConfigPresets::UnrealEngineIni {};
    let ini = archive("Engine.ini");
    let movie = archive("Intro.bk2");

    assert!(
        detect_resource_download(ini.path(), cfg, &registry, None, Some(&config))
            .unwrap()
            .is_some()
    );
    assert!(
        detect_resource_download(ini.path(), cfg, &registry, Some(&movies), None)
            .unwrap()
            .is_none()
    );
    assert!(
        detect_resource_download(movie.path(), cfg, &registry, Some(&movies), None)
            .unwrap()
            .is_some()
    );
    assert!(
        detect_resource_download(movie.path(), cfg, &registry, None, Some(&config))
            .unwrap()
            .is_none()
    );
}

#[test]
fn loose_resources_require_their_own_declared_mechanism() {
    let cfg = super::super::engine::engine_for_game("pd3").unwrap();
    let registry = StagingRegistry::new();
    let movies = MovieReplacement::Bink {
        directory: vec!["Media".into()],
        storefronts: vec![Storefront::Steam],
        absent_slots: vec![],
    };
    let config = ConfigPresets::UnrealEngineIni {};
    let temp = tempfile::tempdir().unwrap();
    let ini = temp.path().join("Engine.ini");
    let movie = temp.path().join("Intro.bk2");
    let mp4 = temp.path().join("Intro.mp4");
    std::fs::write(&ini, b"original config").unwrap();
    std::fs::write(&movie, b"original movie").unwrap();
    std::fs::write(&mp4, b"original mp4").unwrap();

    assert!(matches!(
        detect_resource_download(&ini, cfg, &registry, Some(&movies), None),
        Err(ResolveError::Failure(_))
    ));
    assert!(matches!(
        detect_resource_download(&movie, cfg, &registry, None, Some(&config)),
        Err(ResolveError::Failure(_))
    ));
    assert!(
        detect_resource_download(&ini, cfg, &registry, None, Some(&config))
            .unwrap()
            .is_some()
    );
    assert!(
        detect_resource_download(&movie, cfg, &registry, Some(&movies), None)
            .unwrap()
            .is_some()
    );
    let Err(ResolveError::Failure(error)) =
        detect_resource_download(&mp4, cfg, &registry, Some(&movies), Some(&config))
    else {
        panic!("A loose movie must use the declared format");
    };
    assert!(error.contains("accepts .bk2 movie replacements"));
    assert_eq!(std::fs::read(&ini).unwrap(), b"original config");
    assert_eq!(std::fs::read(&movie).unwrap(), b"original movie");
    assert_eq!(std::fs::read(&mp4).unwrap(), b"original mp4");
}

#[test]
fn shared_resources_reach_review_on_fresh_installs_and_existing_nexus_updates() {
    let cfg = super::super::engine::engine_for_game("ron").unwrap();
    for name in [
        "Profile/Engine.ini",
        "ReadyOrNot/Content/Movies/ReadyOrNot_StartupMovie.mp4",
    ] {
        for updating in [false, true] {
            let archive = archive(name);
            let registry = StagingRegistry::with_limits(0, std::time::Duration::ZERO);
            let result = if updating {
                shared_pak_update_choice(archive.path().into(), cfg, &registry)
            } else {
                resolve_archive_download(archive.path().into(), cfg, &registry)
            };
            let Err(ResolveError::Resources(resource)) = result else {
                panic!("{name} must reach resource review before Pak fallback");
            };
            assert!(resource.is_archive);
            assert_eq!(resource.members, [(Some(0), name.into())]);
            assert!(resource.pak_picker.is_none());
            assert!(archive.path().exists());
        }
    }
}

#[test]
fn shared_mixed_resources_keep_author_names_and_nexus_bound_member_grants() {
    let cfg = super::super::engine::engine_for_game("ron").unwrap();
    let entries: &[(&str, &[u8])] = &[
        ("Profile/Engine.ini", b"[S]\nA=1\n"),
        ("Clips/startup alternative.mp4", b"movie for review"),
        ("Hard/Payload_P.pak", b"hard"),
        ("Realistic/Payload_P.pak", b"realistic"),
        ("README.txt", b"instructions"),
    ];
    for updating in [false, true] {
        let archive = archive_entries(entries);
        let registry = StagingRegistry::new();
        let result = if updating {
            shared_pak_update_choice(archive.path().into(), cfg, &registry)
        } else {
            resolve_archive_download(archive.path().into(), cfg, &registry)
        };
        let Err(ResolveError::Resources(resource)) = result else {
            panic!("Mixed supported packages must reach resource review");
        };
        assert_eq!(
            resource.members,
            [
                (Some(0), "Profile/Engine.ini".into()),
                (Some(1), "Clips/startup alternative.mp4".into()),
                (Some(4), "README.txt".into()),
            ]
        );
        let picker = resource.pak_picker.unwrap();
        assert!(picker.shared_paks);
        assert_eq!(
            picker.entries,
            ["Hard/Payload_P.pak", "Realistic/Payload_P.pak"]
        );
        assert_ne!(picker.entry_ids[0], picker.entry_ids[1]);
        assert!(picker.target_tag.is_none());
        assert!(picker.entry_tags.is_none());
        registry.restrict_to_nexus(&picker.archive_handle).unwrap();
        assert!(registry
            .entry(
                &picker.archive_handle,
                StagedArchiveKind::MultiEntry,
                picker.entry_ids[0]
            )
            .is_none());
        for (position, source_index) in [2, 3].into_iter().enumerate() {
            let entry = registry
                .entry(
                    &picker.archive_handle,
                    StagedArchiveKind::NexusResourcePak,
                    picker.entry_ids[position],
                )
                .unwrap();
            assert_eq!(
                entry.source,
                StagedEntrySource::File {
                    index: source_index
                }
            );
            assert_eq!(entry.display_name, picker.entries[position]);
        }
        cleanup::run_sync(&registry.finalize(&picker.archive_handle).unwrap());
        assert!(!archive.path().exists());
        assert!(registry
            .borrow(&picker.archive_handle, StagedArchiveKind::NexusResourcePak)
            .is_none());
    }
}

#[test]
fn shared_resource_hybrids_refuse_before_resource_or_pak_grants() {
    let cfg = super::super::engine::engine_for_game("ron").unwrap();
    for member in [
        "FMOD/Desktop/Sins Level.bank",
        "GameUserSettings.ini",
        "Input.ini",
        "Scalability.ini",
        "Game.ini",
        "ReShade.ini",
        "Binaries/Win64/dxgi.dll",
        "ReShade/Shaders/Effect.fx",
        "VO_MOD/TOC/line.ogg",
        "Mods/Scripts/main.lua",
        "Intro.bk2",
        "Payload.utoc",
        "Content/Paks/mod.io/3791/mods/27/Payload.pak",
    ] {
        for updating in [false, true] {
            let archive = archive_entries(&[
                ("Engine.ini", b"[S]\nA=1\n"),
                ("ReadyOrNot_StartupMovie.mp4", b"movie"),
                ("Payload_P.pak", b"pak"),
                (member, b"required component"),
            ]);
            let registry = StagingRegistry::with_limits(0, std::time::Duration::ZERO);
            let result = if updating {
                shared_pak_update_choice(archive.path().into(), cfg, &registry)
            } else {
                resolve_archive_download(archive.path().into(), cfg, &registry)
            };
            let Err(ResolveError::Failure(error)) = result else {
                panic!("Unsupported {member} must refuse the whole hybrid");
            };
            assert!(error.contains("Nothing was installed"), "{error}");
            assert!(!error.contains("Too many archives"), "{error}");
            assert!(!archive.path().exists());
        }
    }
}

#[test]
fn shared_resource_unsafe_and_ambiguous_paths_refuse_before_grants() {
    let cfg = super::super::engine::engine_for_game("ron").unwrap();
    for members in [
        ["../Engine.ini", "Payload_P.pak"],
        ["/Engine.ini", "Payload_P.pak"],
        ["C:/Engine.ini", "Payload_P.pak"],
        ["C:Profile/Engine.ini", "Payload_P.pak"],
        [r"C:\Engine.ini", "Payload_P.pak"],
        [r"..\Engine.ini", "Payload_P.pak"],
        [r"\\server\share\Engine.ini", "Payload_P.pak"],
        ["Profile/Engine.ini", "Profile/./Engine.ini"],
        ["Profile/Engine.ini", "Profile//Engine.ini"],
        ["Profile/Engine.ini", "profile/ENGINE.ini"],
    ] {
        for updating in [false, true] {
            let archive = archive_entries(&[(members[0], b"first"), (members[1], b"second")]);
            let registry = StagingRegistry::with_limits(0, std::time::Duration::ZERO);
            let result = if updating {
                shared_pak_update_choice(archive.path().into(), cfg, &registry)
            } else {
                resolve_archive_download(archive.path().into(), cfg, &registry)
            };
            let Err(ResolveError::Failure(error)) = result else {
                panic!("Archive paths must refuse before review: {members:?}, updating={updating}");
            };
            assert!(
                error.contains("Nothing was installed"),
                "{members:?}, updating={updating}: {error}"
            );
            assert!(
                !error.contains("Too many archives"),
                "{members:?}, updating={updating}: {error}"
            );
            assert!(!archive.path().exists());
        }
    }
}

#[test]
fn shared_correctly_named_loose_config_stays_pending_for_scalar_review() {
    let cfg = super::super::engine::engine_for_game("ron").unwrap();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Engine.ini");
    let bytes = b"[SystemSettings]\nr.MotionBlurQuality=0\n";
    std::fs::write(&path, bytes).unwrap();
    let result = resolve_archive_download(path.clone(), cfg, &StagingRegistry::new());
    let Err(ResolveError::Resources(resource)) = result else {
        panic!("Correctly named loose Engine.ini requires review");
    };
    assert!(!resource.is_archive);
    assert!(resource.members.is_empty());
    assert!(resource.pak_picker.is_none());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[cfg(windows)]
#[test]
fn shared_resource_windows_ordinal_aliases_refuse_before_grants() {
    let cfg = super::super::engine::engine_for_game("ron").unwrap();
    for members in [
        ["Profile/ΟΣ/Engine.ini", "Profile/οσ/Engine.ini"],
        ["ΟΣ.mp4", "οσ.mp4"],
        ["ΟΣ.pak", "οσ.pak"],
    ] {
        for updating in [false, true] {
            let archive = archive_entries(&[(members[0], b"first"), (members[1], b"second")]);
            let registry = StagingRegistry::with_limits(0, std::time::Duration::ZERO);
            let result = if updating {
                shared_pak_update_choice(archive.path().into(), cfg, &registry)
            } else {
                resolve_archive_download(archive.path().into(), cfg, &registry)
            };
            let Err(ResolveError::Failure(error)) = result else {
                panic!("Windows ordinal aliases must refuse before review");
            };
            assert!(error.contains("Windows ordinal"), "{error}");
            assert!(error.contains("Nothing was installed"), "{error}");
            assert!(!archive.path().exists());
        }
    }
}
