use super::*;
use crate::game_package::{ConfigPresets, MovieReplacement, Storefront};
use std::io::Write;

fn archive(name: &str) -> tempfile::NamedTempFile {
    let file = tempfile::NamedTempFile::new().unwrap();
    let mut archive = ::zip::ZipWriter::new(File::create(file.path()).unwrap());
    archive
        .start_file(name, ::zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(b"reviewed payload").unwrap();
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
    let config = ConfigPresets::UnrealEngineIni { locations: vec![] };
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
    let config = ConfigPresets::UnrealEngineIni { locations: vec![] };
    let temp = tempfile::tempdir().unwrap();
    let ini = temp.path().join("Engine.ini");
    let movie = temp.path().join("Intro.bk2");
    std::fs::write(&ini, b"original config").unwrap();
    std::fs::write(&movie, b"original movie").unwrap();

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
    assert_eq!(std::fs::read(&ini).unwrap(), b"original config");
    assert_eq!(std::fs::read(&movie).unwrap(), b"original movie");
}
