use super::*;

#[test]
fn bounded_payload_capture_discards_oversized_copies_and_preserves_sources() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("replacement.mp4");
    let bytes = vec![42; 128 * 1024];
    fs::write(&path, &bytes).unwrap();
    assert!(store
        .capture_bounded(&path, bytes.len() as u64 - 1)
        .unwrap_err()
        .contains("resource limit"));
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(fs::read_dir(store.root.join("objects")).unwrap().count(), 0);
    assert!(store.load_manifest().unwrap().deployments.is_empty());
    let captured = store.capture_bounded(&path, bytes.len() as u64).unwrap();
    let Content::Present { sha256, size } = captured else {
        unreachable!()
    };
    assert_eq!(store.read_object(&sha256, size).unwrap(), bytes);
    assert_eq!(
        store.capture(&path).unwrap(),
        Content::Present { sha256, size }
    );
}

#[test]
fn stored_source_reads_reject_extra_bytes_after_an_intact_prefix() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let source = b"[SystemSettings]\nr.MotionBlurQuality=0\n";
    let Content::Present { sha256, size } = store.put_bytes(source).unwrap() else {
        unreachable!()
    };
    let mut changed = source.to_vec();
    changed.extend(vec![b'X'; 128 * 1024]);
    fs::write(store.object_path(&sha256), changed).unwrap();
    assert!(store
        .read_object(&sha256, size)
        .unwrap_err()
        .contains("damaged"));
}

#[test]
fn recovery_folder_lookup_does_not_create_missing_storage() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("resources");
    let store = ResourceStore::at(root.clone());
    assert!(store.recovery_folder().unwrap().is_none());
    assert!(!root.exists());
}

#[test]
fn recovery_folder_lookup_returns_the_store_directory() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("resources");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("manifest.json"), b"unreadable manifest").unwrap();
    let store = ResourceStore::at(root.clone());
    assert_eq!(store.recovery_folder().unwrap(), Some(root.as_path()));
}

#[test]
fn recovery_folder_lookup_refuses_a_file() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("resources");
    fs::write(&file, b"not a directory").unwrap();
    let store = ResourceStore::at(file.clone());
    assert!(store
        .recovery_folder()
        .unwrap_err()
        .contains("not a directory"));
}

#[test]
fn an_unrelated_pending_journal_allows_launch_but_blocks_resource_writes() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Engine.ini");
    fs::write(&path, b"previous config").unwrap();
    let before = store.capture(&path).unwrap();
    let after = store.put_bytes(b"managed config").unwrap();
    let step = Step {
        destination: path.clone(),
        before,
        after,
    };
    let journal = Journal {
        version: 1,
        id: "other-game".into(),
        game_id: "cb".into(),
        revision_after: 1,
        steps: vec![step.clone()],
        decision: RecoveryDecision::Rollback,
    };
    write_atomic(
        &store.journal_dir().join("other-game.json"),
        &serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    store.commit_step(&step).unwrap();

    store.preflight("pd2").unwrap();
    assert!(store.has_pending("cb").unwrap());
    assert_eq!(fs::read(&path).unwrap(), b"managed config");
    assert!(store.apply("pd2", vec![], |_| {}).is_err());
}

#[test]
fn another_games_pending_journal_still_blocks_launch_for_a_shared_config() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Engine.ini");
    fs::write(&path, b"previous config").unwrap();
    let before = store.capture(&path).unwrap();
    let after = store.put_bytes(b"managed config").unwrap();
    let Content::Present { sha256, size } = after.clone() else {
        unreachable!()
    };
    let mut manifest = store.load_manifest().unwrap();
    manifest.deployments.push(Deployment {
        id: "shared-preset".into(),
        game_id: "pd2".into(),
        game_path: temp.path().to_string_lossy().into(),
        canonical_game_path: temp.path().canonicalize().unwrap().to_string_lossy().into(),
        launcher: Some("steam".into()),
        name: "Shared settings".into(),
        version: "1".into(),
        source: None,
        remote_id: None,
        file_id: None,
        installed_at: "t".into(),
        enabled: true,
        body: DeploymentBody::Ini {
            preset: IniPreset {
                config_path: path.to_string_lossy().into(),
                source_entry: "Engine.ini".into(),
                source_sha256: sha256,
                source_size: size,
                created_file: false,
                changes: vec![],
                created_sections: vec![],
            },
        },
    });
    store.save_manifest(&manifest).unwrap();
    let step = Step {
        destination: path.clone(),
        before,
        after,
    };
    let journal = Journal {
        version: 1,
        id: "shared-config".into(),
        game_id: "cb".into(),
        revision_after: 1,
        steps: vec![step.clone()],
        decision: RecoveryDecision::Rollback,
    };
    write_atomic(
        &store.journal_dir().join("shared-config.json"),
        &serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    store.commit_step(&step).unwrap();
    assert!(store
        .preflight("pd2")
        .unwrap_err()
        .contains("files this game uses"));
    assert!(store.has_pending("cb").unwrap());
    assert_eq!(fs::read(&path).unwrap(), b"managed config");
}

#[test]
fn a_corrupt_shared_manifest_cannot_prove_a_game_has_no_managed_resources() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    store.initialize().unwrap();
    fs::write(store.manifest_path(), b"{").unwrap();
    assert!(store
        .preflight("pd2")
        .unwrap_err()
        .contains("manifest is corrupt"));
    assert_eq!(fs::read(store.manifest_path()).unwrap(), b"{");
}

#[test]
fn launch_recovers_a_saved_config_journal_without_movie_install_support() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Engine.ini");
    fs::write(&path, b"previous config").unwrap();
    let before = store.capture(&path).unwrap();
    let after = store.put_bytes(b"managed config").unwrap();
    let step = Step {
        destination: path.clone(),
        before: before.clone(),
        after,
    };
    let journal = Journal {
        version: 1,
        id: "config-only".into(),
        game_id: "pd2".into(),
        revision_after: 1,
        steps: vec![step.clone()],
        decision: RecoveryDecision::Rollback,
    };
    write_atomic(
        &store.journal_dir().join("config-only.json"),
        &serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    store.commit_step(&step).unwrap();
    store.preflight("pd2").unwrap();
    assert_eq!(live_content(&path).unwrap(), before);
    assert!(!store.has_pending("pd2").unwrap());
}

#[test]
fn staging_rejects_a_same_size_object_change_before_replacing_the_live_file() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Intro.bk2");
    fs::write(&path, b"previous").unwrap();
    let before = store.capture(&path).unwrap();
    let after = store.put_bytes(b"replacement").unwrap();
    let Content::Present { ref sha256, .. } = after else {
        unreachable!()
    };
    fs::write(store.object_path(sha256), b"corruptcopy").unwrap();
    let error = store
        .commit_step(&Step {
            destination: path.clone(),
            before,
            after,
        })
        .unwrap_err();
    assert!(
        error.contains("staged replacement did not verify"),
        "{error}"
    );
    assert_eq!(fs::read(path).unwrap(), b"previous");
}

#[test]
fn launch_ignores_archived_ini_copies_but_checks_current_movie_baselines() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Engine.ini");
    let prior = store.put_bytes(b"archived settings").unwrap();
    let Content::Present { ref sha256, .. } = prior else {
        unreachable!()
    };
    let object = store.object_path(sha256);
    let mut manifest = store.load_manifest().unwrap();
    manifest.ini_revisions.push(IniRevision {
        config_path: path.to_string_lossy().into(),
        game_id: "pd3".into(),
        prior: prior.clone(),
        saved_at: "t".into(),
    });
    store.save_manifest(&manifest).unwrap();
    fs::remove_file(object).unwrap();
    store.preflight("pd3").unwrap();
    assert_eq!(store.load_manifest().unwrap().ini_revisions.len(), 1);
    manifest.movie_baselines.push(MovieBaseline {
        destination: temp.path().join("Intro.bk2").to_string_lossy().into(),
        game_id: "pd3".into(),
        prior,
        captured_at: "t".into(),
    });
    store.save_manifest(&manifest).unwrap();
    assert!(store
        .preflight("pd3")
        .unwrap_err()
        .contains("recovery copy"));
}

#[cfg(unix)]
#[test]
fn replacement_refuses_a_directory_retargeted_to_a_link() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let destination = temp.path().join("Movies");
    let external = temp.path().join("External");
    fs::create_dir(&destination).unwrap();
    fs::create_dir(&external).unwrap();
    let path = destination.join("Intro.bk2");
    fs::write(&path, b"previous").unwrap();
    let before = store.capture(&path).unwrap();
    let after = store.put_bytes(b"replacement").unwrap();
    fs::remove_file(&path).unwrap();
    fs::remove_dir(&destination).unwrap();
    fs::write(external.join("Intro.bk2"), b"previous").unwrap();
    std::os::unix::fs::symlink(&external, &destination).unwrap();
    assert!(store
        .apply(
            "pd3",
            vec![Step {
                destination: path,
                before,
                after
            }],
            |_| {}
        )
        .unwrap_err()
        .contains("different destination"));
    assert_eq!(fs::read(external.join("Intro.bk2")).unwrap(), b"previous");
}

#[test]
fn explicit_recovery_keeps_external_bytes_and_removes_the_pending_journal() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Intro.bk2");
    fs::write(&path, b"previous personal mod").unwrap();
    let before = store.capture(&path).unwrap();
    let after = store.put_bytes(b"managed").unwrap();
    let journal = Journal {
        version: 1,
        id: "interrupted".into(),
        game_id: "pd3".into(),
        revision_after: 1,
        steps: vec![Step {
            destination: path.clone(),
            before: before.clone(),
            after,
        }],
        decision: RecoveryDecision::Rollback,
    };
    write_atomic(
        &store.journal_dir().join("interrupted.json"),
        &serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    fs::write(&path, b"external repair").unwrap();
    assert!(store.recover("pd3").is_err());
    let (id, paths) = store.recovery_paths("pd3").unwrap();
    assert!(store
        .keep_current("pd3", paths.clone(), Some(&id), 9)
        .is_err());
    store.keep_current("pd3", paths, Some(&id), 0).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"external repair");
    assert!(!store.has_pending("pd3").unwrap());
    store.object_present(&before).unwrap();
    assert_eq!(store.load_manifest().unwrap().revision, 1);
}

#[test]
fn durable_keep_current_decision_finishes_after_restart_without_restoring_files() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Engine.ini");
    fs::write(&path, b"user choice").unwrap();
    store.capture(&path).unwrap();
    let journal = Journal {
        version: 1,
        id: "decision".into(),
        game_id: "pd3".into(),
        revision_after: 1,
        steps: vec![],
        decision: RecoveryDecision::KeepCurrent {
            paths: vec![path.clone()],
        },
    };
    write_atomic(
        &store.journal_dir().join("decision.json"),
        &serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    store.recover("pd3").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"user choice");
    assert_eq!(store.load_manifest().unwrap().revision, 1);
    assert!(!store.has_pending("pd3").unwrap());
}

#[test]
fn failed_windows_replacement_can_return_its_backup_without_overwriting_external_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Engine.ini");
    let backup = temp.path().join("replacement.bak");
    fs::write(&backup, b"previous").unwrap();
    let before = live_content(&backup).unwrap();
    restore_failed_replacement(&path, &backup, &before).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"previous");
    fs::write(&backup, b"previous").unwrap();
    fs::write(&path, b"external edit").unwrap();
    assert!(restore_failed_replacement(&path, &backup, &before).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"external edit");
    assert_eq!(fs::read(&backup).unwrap(), b"previous");
}

#[test]
fn snapshots_are_independent_and_distinguish_absent_from_empty() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Engine.ini");
    assert_eq!(store.capture(&path).unwrap(), Content::Absent);
    fs::write(&path, b"").unwrap();
    let empty = store.capture(&path).unwrap();
    assert!(matches!(empty, Content::Present { size: 0, .. }));
    fs::write(&path, b"changed").unwrap();
    let Content::Present { sha256, size } = empty else {
        unreachable!()
    };
    assert_eq!(store.read_object(&sha256, size).unwrap(), b"");
}

#[test]
fn interrupted_write_restores_previous_bytes_but_preserves_external_edits() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Intro.bk2");
    fs::write(&path, b"previous personal mod").unwrap();
    let before = store.capture(&path).unwrap();
    let after = store.put_bytes(b"managed movie").unwrap();
    let step = Step {
        destination: path.clone(),
        before: before.clone(),
        after,
    };
    let journal = Journal {
        version: 1,
        id: "operation".into(),
        game_id: "pd3".into(),
        revision_after: 1,
        steps: vec![step.clone()],
        decision: RecoveryDecision::Rollback,
    };
    let journal_path = store.journal_dir().join("operation.json");
    write_atomic(&journal_path, &serde_json::to_vec(&journal).unwrap()).unwrap();
    store.commit_step(&step).unwrap();
    fs::write(&path, b"external repair").unwrap();
    assert!(store.recover("pd3").unwrap_err().contains("preserved"));
    assert_eq!(fs::read(&path).unwrap(), b"external repair");
    assert!(journal_path.exists());
    assert!(store.apply("cb", vec![], |_| {}).is_err());
    fs::write(&path, b"managed movie").unwrap();
    store.recover("pd3").unwrap();
    assert_eq!(live_content(&path).unwrap(), before);
    assert!(!journal_path.exists());
}

#[test]
fn corruption_and_missing_manifest_block_changes() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Engine.ini");
    fs::write(&path, b"old").unwrap();
    let path = path.canonicalize().unwrap();
    let before = store.capture(&path).unwrap();
    let after = store.put_bytes(b"new").unwrap();
    let Content::Present { ref sha256, .. } = after else {
        unreachable!()
    };
    fs::write(store.object_path(sha256), b"corrupt").unwrap();
    let error = store
        .apply(
            "pd3",
            vec![Step {
                destination: path.clone(),
                before,
                after,
            }],
            |_| {},
        )
        .unwrap_err();
    assert!(error.contains("is missing or damaged"), "{error}");
    assert_eq!(fs::read(&path).unwrap(), b"old");
    fs::remove_file(store.manifest_path()).unwrap();
    assert!(store.load_manifest().is_err());
    assert!(store.put_bytes(b"more").is_err());
}

#[test]
fn transaction_rolls_back_when_manifest_commit_is_invalid() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Engine.ini");
    fs::write(&path, b"old").unwrap();
    let path = path.canonicalize().unwrap();
    let before = store.capture(&path).unwrap();
    let after = store.put_bytes(b"new").unwrap();
    let error = store
        .apply(
            "pd3",
            vec![Step {
                destination: path.clone(),
                before,
                after,
            }],
            |manifest| {
                manifest.ini_revisions.push(IniRevision {
                    config_path: path.to_string_lossy().into(),
                    game_id: "pd3".into(),
                    prior: Content::Present {
                        sha256: "bad".into(),
                        size: 1,
                    },
                    saved_at: "t".into(),
                });
            },
        )
        .unwrap_err();
    assert!(error.contains("every file was put back"));
    assert!(error.contains("invalid content digest"), "{error}");
    assert_eq!(fs::read(&path).unwrap(), b"old");
    assert!(!store.has_pending("pd3").unwrap());
}

#[tokio::test]
async fn garbage_collection_keeps_every_referenced_copy_and_deletes_the_rest() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ResourceStore::at(root.join("recovery"));
    let digest = |content: &Content| match content {
        Content::Present { sha256, .. } => sha256.clone(),
        Content::Absent => unreachable!(),
    };
    let payload = store.put_bytes(b"installed payload").unwrap();
    let original = store.put_bytes(b"original movie").unwrap();
    let pending = store.put_bytes(b"pending journal copy").unwrap();
    let released = store.put_bytes(b"released pack payload").unwrap();
    let destination = root.join("Intro.bk2");
    let mut manifest = store.load_manifest().unwrap();
    manifest.deployments.push(Deployment {
        id: "pack".into(),
        game_id: "pd3".into(),
        game_path: root.to_string_lossy().into_owned(),
        canonical_game_path: root.to_string_lossy().into_owned(),
        launcher: None,
        name: "Pack".into(),
        version: String::new(),
        source: None,
        remote_id: None,
        file_id: None,
        installed_at: String::new(),
        enabled: true,
        body: DeploymentBody::Movie {
            slots: vec![MovieSlot {
                slot: "Intro.bk2".into(),
                destination: destination.to_string_lossy().into_owned(),
                entry_name: "Intro.bk2".into(),
                payload_sha256: digest(&payload),
                payload_size: 17,
            }],
        },
    });
    manifest.movie_baselines.push(MovieBaseline {
        destination: destination.to_string_lossy().into_owned(),
        game_id: "pd3".into(),
        prior: original.clone(),
        captured_at: String::new(),
    });
    store.save_manifest(&manifest).unwrap();
    let journal = Journal {
        version: 1,
        id: "pending".into(),
        game_id: "cb".into(),
        revision_after: 1,
        steps: vec![Step {
            destination: root.join("Engine.ini"),
            before: Content::Absent,
            after: pending.clone(),
        }],
        decision: RecoveryDecision::Rollback,
    };
    write_atomic(
        &store.journal_dir().join("pending.json"),
        &serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    let leftover = store.root.join("objects").join(".object-crash.tmp");
    fs::write(&leftover, b"half").unwrap();

    let guard = ResourceLocks::default().acquire().await;
    let freed = store.collect_garbage(&guard).unwrap();

    assert_eq!(freed, b"released pack payload".len() as u64 + 4);
    for kept in [&payload, &original, &pending] {
        assert!(store.object_path(&digest(kept)).exists());
    }
    assert!(!store.object_path(&digest(&released)).exists());
    assert!(!leftover.exists());
    assert_eq!(store.collect_garbage(&guard).unwrap(), 0);
}
