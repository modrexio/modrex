use super::*;
use std::fs;

#[test]
fn configuration_location_checks_do_not_create_a_missing_file_or_parent() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("not-created/Engine.ini");
    let destination = IniDestination {
        path: path.clone(),
        chosen: false,
    };
    assert!(matches!(
        inspect_engine_ini(destination).unwrap(),
        EngineIniLocation::Missing { path: found } if found == path.to_string_lossy()
    ));
    assert!(!path.parent().unwrap().exists());
    assert!(IniDestination {
        path,
        chosen: false
    }
    .validate()
    .is_err());
}

#[test]
fn configuration_location_checks_validate_an_existing_file_without_changing_it() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().canonicalize().unwrap().join("Engine.ini");
    fs::write(&path, b"[S]\r\nA=1\r\n").unwrap();
    assert!(matches!(
        inspect_engine_ini(IniDestination { path: path.clone(), chosen: true }).unwrap(),
        EngineIniLocation::Found { path: found } if found == path.to_string_lossy()
    ));
    assert_eq!(fs::read(&path).unwrap(), b"[S]\r\nA=1\r\n");
}

#[test]
fn configuration_location_checks_report_invalid_files_as_errors() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Engine.ini");
    fs::create_dir(&path).unwrap();
    assert!(inspect_engine_ini(IniDestination {
        path,
        chosen: false
    })
    .unwrap_err()
    .contains("not a regular file"));
}

#[cfg(windows)]
#[test]
fn system_editor_paths_preserve_drive_unc_and_unicode_without_verbatim_prefixes() {
    for (input, expected) in [
        (
            r"\\?\G:\Config & Files\Engine.ini",
            r"G:\Config & Files\Engine.ini",
        ),
        (
            r"\\?\UNC\server\share\Config\Engine.ini",
            r"\\server\share\Config\Engine.ini",
        ),
        (r"C:\Config\Engine.ini", r"C:\Config\Engine.ini"),
        (r"\\?\C:\Ігри\Engine.ini", r"C:\Ігри\Engine.ini"),
    ] {
        let path = Path::new(input);
        assert_eq!(shell_ini_path(path), PathBuf::from(expected));
    }
}

#[test]
fn a_shared_configuration_checks_every_bound_game_before_writing() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Engine.ini");
    let mut payday = preset(&store, &path, b"[S]\nA=1\n");
    let mut crimeboss = payday.clone();
    payday.id = "payday".into();
    crimeboss.id = "crimeboss".into();
    crimeboss.game_id = "cb".into();
    let manifest = Manifest {
        deployments: vec![payday, crimeboss],
        ..Manifest::default()
    };
    assert_eq!(affected_games(&manifest, "pd3", &[path]), ["cb", "pd3"]);
}

fn preset(store: &ResourceStore, path: &Path, source: &[u8]) -> Deployment {
    let Content::Present { sha256, size } = store.put_bytes(source).unwrap() else {
        unreachable!()
    };
    Deployment {
        id: "preset".into(),
        game_id: "pd3".into(),
        game_path: path.parent().unwrap().to_string_lossy().into(),
        canonical_game_path: path.parent().unwrap().to_string_lossy().into(),
        launcher: Some("steam".into()),
        name: "Small UI".into(),
        version: "1".into(),
        source: Some("modworkshop".into()),
        remote_id: Some("46831".into()),
        file_id: Some(1),
        installed_at: "t".into(),
        enabled: true,
        body: DeploymentBody::Ini {
            preset: IniPreset {
                config_path: path.to_string_lossy().into(),
                source_entry: "6/Engine.ini".into(),
                source_sha256: sha256,
                source_size: size,
                changes: vec![],
                created_sections: vec![],
                created_file: false,
            },
        },
    }
}

#[test]
fn matching_preexisting_movie_is_not_adopted_and_never_becomes_a_baseline() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Intro.bk2");
    fs::write(&path, b"existing manual replacement").unwrap();
    let Content::Present { sha256, size } =
        store.put_bytes(b"existing manual replacement").unwrap()
    else {
        unreachable!()
    };
    let mut deployment = preset(&store, &path, b"[S]\nA=1\n");
    deployment.body = DeploymentBody::Movie {
        slots: vec![MovieSlot {
            slot: "Intro.bk2".into(),
            destination: path.to_string_lossy().into(),
            entry_name: "Intro.bk2".into(),
            payload_sha256: sha256,
            payload_size: size,
        }],
    };
    let already_current = apply_movie_pack(
        &store,
        "pd3",
        &store.load_manifest().unwrap(),
        deployment,
        None,
    )
    .unwrap();
    assert!(!already_current.installed);
    assert_eq!(
        already_current.already_current_movies,
        [path.to_string_lossy().into_owned()]
    );
    let manifest = store.load_manifest().unwrap();
    assert!(manifest.deployments.is_empty());
    assert!(manifest.movie_baselines.is_empty());
    assert_eq!(fs::read(&path).unwrap(), b"existing manual replacement");
}

#[test]
fn absent_and_empty_configs_restore_to_different_states() {
    for exists in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store = ResourceStore::at(temp.path().join("recovery"));
        let path = temp.path().canonicalize().unwrap().join("Engine.ini");
        if exists {
            fs::write(&path, b"").unwrap();
        }
        let deployment = preset(&store, &path, b"[S]\r\nA=1\r\n");
        apply_preset(
            &store,
            "pd3",
            &store.load_manifest().unwrap(),
            deployment,
            None,
        )
        .unwrap();
        assert!(path.exists());
        let deployment = store.load_manifest().unwrap().deployments.remove(0);
        assert_eq!(preset_of(&deployment).unwrap().created_file, !exists);
        release_preset(&store, "pd3", &deployment, true).unwrap();
        assert_eq!(path.exists(), exists);
        if exists {
            assert_eq!(fs::read(&path).unwrap(), b"");
        }
    }
}

#[test]
fn changed_owned_keys_and_external_removal_block_automatic_restore() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Engine.ini");
    fs::write(&path, b"; own\r\n[S]\r\nA=old\r\nOther=1\r\n").unwrap();
    let deployment = preset(&store, &path, b"[S]\r\nA=new\r\nB=2\r\n");
    apply_preset(
        &store,
        "pd3",
        &store.load_manifest().unwrap(),
        deployment,
        None,
    )
    .unwrap();
    let deployment = store.load_manifest().unwrap().deployments.remove(0);
    fs::write(&path, b"; own\r\n[S]\r\nA=user\r\nOther=9\r\nB=2\r\n").unwrap();
    assert!(release_preset(&store, "pd3", &deployment, false)
        .unwrap_err()
        .contains("[S] A"));
    assert_eq!(
        fs::read(&path).unwrap(),
        b"; own\r\n[S]\r\nA=user\r\nOther=9\r\nB=2\r\n"
    );
    let revision = store.load_manifest().unwrap().revision;
    store
        .keep_current("pd3", vec![path.clone()], None, revision)
        .unwrap();
    assert!(store.load_manifest().unwrap().deployments.is_empty());
    let deployment = preset(&store, &path, b"[S]\r\nA=new\r\nB=2\r\n");
    apply_preset(
        &store,
        "pd3",
        &store.load_manifest().unwrap(),
        deployment,
        None,
    )
    .unwrap();
    let deployment = store.load_manifest().unwrap().deployments.remove(0);
    fs::remove_file(&path).unwrap();
    assert!(release_preset(&store, "pd3", &deployment, true).is_err());
    assert!(!path.exists());
}

#[test]
fn equal_existing_values_have_no_ownership_or_revision_and_duplicate_presets_do_not_write() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Engine.ini");
    let original = b"[S]\nA=1";
    fs::write(&path, original).unwrap();
    let deployment = preset(&store, &path, b"[S]\nA=1\n");
    apply_preset(
        &store,
        "pd3",
        &store.load_manifest().unwrap(),
        deployment,
        None,
    )
    .unwrap();
    let manifest = store.load_manifest().unwrap();
    assert!(manifest.ini_revisions.is_empty());
    assert!(preset_of(&manifest.deployments[0])
        .unwrap()
        .changes
        .is_empty());
    assert_eq!(fs::read(&path).unwrap(), original);
    let deployment = preset(&store, &path, b"[S]\nA=1\nA=2\n");
    assert!(apply_preset(&store, "pd3", &manifest, deployment, Some("preset".into())).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
}

fn review_from(source: Option<&str>, picker: Option<ZipMultiPakPayload>) -> Review {
    Review {
        handle: "review".into(),
        context: InstallContext {
            game_id: "pd3".into(),
            game_path: "/games/pd3".into(),
            canonical_game_path: "/games/pd3".into(),
            launcher: Some("steam".into()),
        },
        provenance: Provenance {
            name: "Skip Intro".into(),
            version: "1.2".into(),
            source: source.map(str::to_string),
            remote_id: source.map(|_| "197".to_string()),
            file_id: source.map(|_| 842),
            author: None,
            thumbnail_url: None,
        },
        staging_dir: PathBuf::from("/nonexistent/staging"),
        entries: Vec::new(),
        movie_slots: Vec::new(),
        config_path: None,
        config_revision: None,
        manifest_revision: None,
        pak_picker: picker,
        movie_pack_applied: false,
        movie_deployment_id: "movie".into(),
        ini_deployment_id: "ini".into(),
        issued: Instant::now(),
    }
}

fn picker() -> ZipMultiPakPayload {
    ZipMultiPakPayload {
        archive_handle: "grant".into(),
        entries: vec!["Skip_P.pak".into()],
        entry_ids: Vec::new(),
        target_tag: None,
        entry_tags: None,
        entry_kind: None,
        mod_id: Some(197),
        mod_name: Some("Skip Intro".into()),
        file_id: Some(842),
        file_type: Some("zip".into()),
        mod_version: Some("1.2".into()),
    }
}

#[test]
fn a_nexus_package_choice_carries_the_reviews_exact_identity_and_install() {
    let choice = nexus_pak_choice(&review_from(Some("nexus"), Some(picker()))).unwrap();
    assert_eq!(choice.game_id, "pd3");
    assert_eq!(choice.game_path, "/games/pd3");
    assert_eq!((choice.mod_id, choice.file_id), (197, 842));
    assert_eq!(choice.file_type, "zip");
    assert_eq!(choice.picker.archive_handle, "grant");
}

#[test]
fn only_a_nexus_review_with_packages_offers_a_nexus_package_choice() {
    assert!(nexus_pak_choice(&review_from(Some("modworkshop"), Some(picker()))).is_err());
    assert!(nexus_pak_choice(&review_from(None, Some(picker()))).is_err());
    assert!(nexus_pak_choice(&review_from(Some("nexus"), None)).is_err());
}

#[test]
fn only_a_nexus_review_reports_a_nexus_completion() {
    assert_eq!(
        nexus_completion_of(&review_from(Some("modworkshop"), None)),
        None
    );
    assert_eq!(nexus_completion_of(&review_from(None, None)), None);
    let mut review = review_from(Some("nexus"), None);
    review.movie_pack_applied = true;
    assert_eq!(
        nexus_completion_of(&review),
        Some(NexusCompletion {
            game_id: "pd3".into(),
            mod_id: 197,
            file_id: 842,
            name: "Skip Intro".into(),
            movie_pack_applied: true,
        })
    );
}

#[test]
#[ignore = "Requires researched ModWorkshop archives in MODREX_RESOURCE_FIXTURES"]
fn real_archives_keep_slot_names_validate_movies_and_reject_duplicate_presets() {
    let fixtures =
        PathBuf::from(std::env::var_os("MODREX_RESOURCE_FIXTURES").expect("fixture directory"));
    let temp = tempfile::tempdir().unwrap();
    for (file, count, movie) in [
        ("modrex-cb-skip-intro.zip", 4, true),
        ("modrex-pd3-skip-intro.rar", 3, true),
        ("modrex-small-ui-validation.zip", 4, false),
        ("modrex-pd3-engine-good.rar", 1, false),
        ("modrex-pd3-engine-potato.rar", 1, false),
    ] {
        let archive = fixtures.join(file);
        let entries = super::super::zip::list_entries_for_test(&archive);
        let resources: Vec<_> = entries
            .iter()
            .enumerate()
            .filter(|(_, name)| extension_of(name) == if movie { "bk2" } else { "ini" })
            .collect();
        assert_eq!(resources.len(), count, "{file}");
        let mut remaining: u64 = 1024 * 1024 * 1024;
        for (index, name) in resources {
            let destination = temp.path().join(format!("{index}.data"));
            let mut budget = remaining.min(if movie {
                512 * 1024 * 1024
            } else {
                MAX_INI_BYTES
            });
            let available = budget;
            extract_entry_at_budget(&archive, index as u32, &destination, &mut budget).unwrap();
            remaining -= available - budget;
            if movie {
                assert_eq!(
                    movies::validate_bink(&destination).unwrap(),
                    movies::BinkGeneration::Bink1,
                    "{name}"
                );
                continue;
            }
            let decoded = ini::decode(&fs::read(&destination).unwrap()).unwrap();
            assert_eq!(
                ini::scalar_assignments(&decoded.text).is_ok(),
                file.contains("small-ui"),
                "{file}: {name}"
            );
        }
    }
}
