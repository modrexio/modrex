use super::*;
use std::fs;

#[test]
fn changed_staged_ini_sources_cannot_replace_disabled_presets() {
    for (changed, expected) in [
        (b"".as_slice(), "sets nothing"),
        (b"[S]\n+A=2\n".as_slice(), "array operator"),
        (b"\xEF\xBB\xBF\xFF".as_slice(), "UTF-8"),
        (b"[S]\r\nA=2\n".as_slice(), "mixes line endings"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let store = ResourceStore::at(temp.path().join("recovery"));
        let config = temp.path().canonicalize().unwrap().join("Engine.ini");
        let original = b"[S]\nA=0\n";
        fs::write(&config, original).unwrap();
        let mut previous = preset(&store, &config, b"[S]\nA=1\n");
        previous.game_id = "ron".into();
        previous.source = Some("nexus".into());
        previous.remote_id = Some("6849".into());
        previous.enabled = false;
        store
            .apply("ron", vec![], |m| m.deployments.push(previous.clone()))
            .unwrap();
        let manifest = store.load_manifest().unwrap();
        let before = serde_json::to_vec(&manifest).unwrap();
        let mut incoming = previous;
        incoming.id = "update".into();
        incoming.version = "2".into();
        let staged = temp.path().join("staged.ini");
        fs::write(&staged, b"[S]\nA=2\n").unwrap();
        assert!(preset_assignments("Engine.ini", &staged).is_ok());
        fs::write(&staged, changed).unwrap();
        let error = install_preset_from_staging(
            &store,
            incoming,
            &staged,
            Some(manifest.revision),
            &live_content(&config).unwrap(),
        )
        .unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert_eq!(fs::read(&config).unwrap(), original);
        assert_eq!(
            serde_json::to_vec(&store.load_manifest().unwrap()).unwrap(),
            before
        );
    }
}

#[test]
fn a_valid_disabled_preset_update_preserves_the_disabled_state_and_live_config() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let config = temp.path().canonicalize().unwrap().join("Engine.ini");
    let original = b"[S]\nA=0\n";
    fs::write(&config, original).unwrap();
    let mut previous = preset(&store, &config, b"[S]\nA=1\n");
    previous.game_id = "ron".into();
    previous.source = Some("nexus".into());
    previous.remote_id = Some("6849".into());
    previous.enabled = false;
    store
        .apply("ron", vec![], |m| m.deployments.push(previous.clone()))
        .unwrap();
    let manifest = store.load_manifest().unwrap();
    let mut incoming = previous;
    incoming.id = "update".into();
    incoming.version = "2".into();
    let staged = temp.path().join("staged.ini");
    let source = b"[S]\nA=2\n";
    fs::write(&staged, source).unwrap();
    install_preset_from_staging(
        &store,
        incoming,
        &staged,
        Some(manifest.revision),
        &live_content(&config).unwrap(),
    )
    .unwrap();
    let manifest = store.load_manifest().unwrap();
    assert_eq!(manifest.deployments.len(), 1);
    let updated = &manifest.deployments[0];
    assert_eq!(updated.id, "update");
    assert_eq!(updated.version, "2");
    assert!(!updated.enabled);
    let body = preset_of(updated).unwrap();
    assert_eq!(body.source_sha256, sha256_hex(source));
    assert_eq!(
        store
            .read_object(&body.source_sha256, body.source_size)
            .unwrap(),
        source
    );
    assert_eq!(fs::read(&config).unwrap(), original);
}

#[test]
fn an_oversized_staged_preset_is_rejected_before_creating_a_recovery_copy() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let config = temp.path().canonicalize().unwrap().join("Engine.ini");
    let original = b"[S]\nA=0\n";
    fs::write(&config, original).unwrap();
    let mut previous = preset(&store, &config, b"[S]\nA=1\n");
    previous.enabled = false;
    store
        .apply("pd3", vec![], |m| m.deployments.push(previous.clone()))
        .unwrap();
    let manifest = store.load_manifest().unwrap();
    let before = serde_json::to_vec(&manifest).unwrap();
    let object_count = fs::read_dir(store.object_path("")).unwrap().count();
    let mut incoming = previous;
    incoming.id = "update".into();
    let staged = temp.path().join("staged.ini");
    fs::write(&staged, b"[S]\nA=2\n").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&staged)
        .unwrap()
        .set_len(MAX_INI_BYTES + 1)
        .unwrap();
    let error = install_preset_from_staging(
        &store,
        incoming,
        &staged,
        Some(manifest.revision),
        &live_content(&config).unwrap(),
    )
    .unwrap_err();
    assert!(error.contains("1 MiB"));
    assert_eq!(
        fs::read_dir(store.object_path("")).unwrap().count(),
        object_count
    );
    assert_eq!(fs::read(&config).unwrap(), original);
    assert_eq!(
        serde_json::to_vec(&store.load_manifest().unwrap()).unwrap(),
        before
    );
}

#[test]
fn stored_ini_sources_keep_the_same_admission_rules_when_enabled() {
    for (source, source_entry, expected) in [
        (
            b"[S]\r\nA=1\n".as_slice(),
            "Engine.ini",
            "mixes line endings",
        ),
        (b"[S]\nA=1\n".as_slice(), "Input.ini", "only Engine.ini"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let store = ResourceStore::at(temp.path().join("recovery"));
        let config = temp.path().canonicalize().unwrap().join("Engine.ini");
        let original = b"[S]\nA=0\n";
        fs::write(&config, original).unwrap();
        let mut deployment = preset(&store, &config, source);
        deployment.enabled = false;
        let DeploymentBody::Ini { preset } = &mut deployment.body else {
            unreachable!()
        };
        preset.source_entry = source_entry.into();
        let manifest = store.load_manifest().unwrap();
        let before = serde_json::to_vec(&manifest).unwrap();
        let error = apply_preset(&store, "pd3", &manifest, deployment, None).unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert_eq!(fs::read(&config).unwrap(), original);
        assert_eq!(
            serde_json::to_vec(&store.load_manifest().unwrap()).unwrap(),
            before
        );
    }
}

#[test]
fn ready_or_not_scalar_presets_preserve_repeated_paths_and_existing_manual_settings() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Engine.ini");
    let original = b"[Core.System]\r\nPaths=../../../Engine/Content\r\nPaths=%GAMEDIR%Content\r\n[SystemSettings]\r\nr.MotionBlurQuality=1\r\nr.Tonemapper.Sharpen=0.5\r\n";
    fs::write(&path, original).unwrap();
    let mut deployment = preset(
        &store,
        &path,
        b"[SystemSettings]\nr.MotionBlurQuality=0\nr.Tonemapper.Sharpen=0.5\n",
    );
    deployment.game_id = "ron".into();
    deployment.source = Some("local".into());
    deployment.remote_id = None;
    deployment.file_id = None;
    apply_preset(
        &store,
        "ron",
        &store.load_manifest().unwrap(),
        deployment,
        None,
    )
    .unwrap();
    let manifest = store.load_manifest().unwrap();
    let deployment = &manifest.deployments[0];
    assert_eq!(preset_of(deployment).unwrap().changes.len(), 1);
    let expected = String::from_utf8(original.to_vec())
        .unwrap()
        .replace("r.MotionBlurQuality=1", "r.MotionBlurQuality=0");
    assert_eq!(fs::read(&path).unwrap(), expected.as_bytes());
    fs::write(&path, format!("{expected}r.Anisotropy=8\r\n")).unwrap();
    release_preset(&store, "ron", deployment, true).unwrap();
    let mut restored = original.to_vec();
    restored.extend_from_slice(b"r.Anisotropy=8\r\n");
    assert_eq!(fs::read(&path).unwrap(), restored);
    assert!(store.load_manifest().unwrap().deployments.is_empty());
}

#[test]
fn a_read_only_ready_or_not_config_refuses_application_without_claiming_the_file() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Engine.ini");
    let original = b"[SystemSettings]\r\nr.MotionBlurQuality=1\r\n";
    fs::write(&path, original).unwrap();
    let mut deployment = preset(&store, &path, b"[SystemSettings]\nr.MotionBlurQuality=0\n");
    deployment.game_id = "ron".into();
    let permissions = fs::metadata(&path).unwrap().permissions();
    let mut read_only = permissions.clone();
    read_only.set_readonly(true);
    fs::set_permissions(&path, read_only).unwrap();
    let before = serde_json::to_vec(&store.load_manifest().unwrap()).unwrap();
    let result = apply_preset(
        &store,
        "ron",
        &store.load_manifest().unwrap(),
        deployment,
        None,
    );
    let preserved = fs::read(&path).unwrap();
    let still_read_only = fs::metadata(&path).unwrap().permissions().readonly();
    fs::set_permissions(&path, permissions).unwrap();
    assert!(result.unwrap_err().contains("read-only"));
    assert_eq!(preserved, original);
    assert!(still_read_only);
    assert_eq!(
        serde_json::to_vec(&store.load_manifest().unwrap()).unwrap(),
        before
    );
}

#[test]
fn loose_presets_require_the_author_filename_before_scalar_review() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("download.ini");
    let bytes = b"[SystemSettings]\nr.MotionBlurQuality=0\n";
    fs::write(&path, bytes).unwrap();
    assert!(preset_assignments("Engine.ini", &path).is_ok());
    for name in ["Input.ini", "Engine-6849-1-0.ini", "GameUserSettings.ini"] {
        assert!(preset_assignments(name, &path).is_err(), "{name}");
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[tokio::test]
async fn pending_launch_blocks_writers_during_preparation_and_delayed_store_handoff() {
    let locks = ResourceLocks::default();
    let launch = locks.reserve_launch(locks.acquire().await, "pd3").unwrap();
    let writer = locks.acquire().await;
    let preparing = locks.pending_launch("pd3");
    assert_eq!(
        preparing.as_ref().unwrap().state,
        super::super::resource_state::PendingGameLaunch::Preparing
    );
    assert!(require_game_idle(&locks, "pd3", preparing.as_ref(), false).is_err());
    assert!(require_game_idle(&locks, "cb", None, false).is_ok());
    assert!(locks
        .cancel_pending_launch("pd3", preparing.as_ref().unwrap(), |_| Ok(()))
        .is_err());
    drop(writer);
    launch.handoff(|| Ok(())).unwrap();
    let _writer = locks.acquire().await;
    for _ in 0..5 {
        let pending = locks.pending_launch("pd3");
        assert!(require_game_idle(&locks, "pd3", pending.as_ref(), false)
            .unwrap_err()
            .contains("launch is pending"));
    }
    let pending = locks.pending_launch("pd3");
    assert!(require_game_idle(&locks, "pd3", pending.as_ref(), true).is_err());
    assert!(locks.pending_launch("pd3").is_none());
    assert!(require_game_idle(&locks, "pd3", None, false).is_ok());
}

#[tokio::test]
async fn launch_waits_for_a_writer_and_sees_its_committed_manifest() {
    use std::future::Future;
    use std::task::{Context, Poll};

    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().canonicalize().unwrap().join("Engine.ini");
    fs::write(&path, b"old").unwrap();
    let locks = ResourceLocks::default();
    let writer = locks.acquire().await;
    let mut launch = Box::pin(locks.acquire());
    let mut context = Context::from_waker(futures::task::noop_waker_ref());
    assert!(matches!(launch.as_mut().poll(&mut context), Poll::Pending));
    store
        .apply(
            "pd3",
            vec![Step {
                destination: path.clone(),
                before: store.capture(&path).unwrap(),
                after: store.put_bytes(b"new").unwrap(),
            }],
            |_| {},
        )
        .unwrap();
    drop(writer);
    let launch = locks.reserve_launch(launch.await, "pd3").unwrap();
    store.preflight("pd3").unwrap();
    launch
        .handoff(|| {
            assert_eq!(fs::read(&path).unwrap(), b"new");
            assert_eq!(store.load_manifest().unwrap().revision, 1);
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn failed_or_abandoned_launch_preparation_releases_its_reservation() {
    let locks = ResourceLocks::default();
    let launch = locks.reserve_launch(locks.acquire().await, "pd3").unwrap();
    let error = launch
        .handoff(|| Err("launcher spawn failed".into()))
        .unwrap_err();
    assert_eq!(error, "launcher spawn failed");
    assert!(locks.pending_launch("pd3").is_none());
    assert!(require_game_idle(&locks, "pd3", None, false).is_ok());
    let launch = locks.reserve_launch(locks.acquire().await, "pd3").unwrap();
    drop(launch);
    assert!(locks.pending_launch("pd3").is_none());
    let _writer = locks.acquire().await;
}

#[tokio::test]
async fn pending_launch_blocks_shared_destinations_and_allows_independent_games() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let shared = temp.path().join("Engine.ini");
    let mut deployment = preset(&store, &shared, b"[S]\nA=1\n");
    deployment.game_id = "cb".into();
    let manifest = Manifest {
        deployments: vec![deployment],
        ..Manifest::default()
    };
    let locks = ResourceLocks::default();
    locks
        .reserve_launch(locks.acquire().await, "cb")
        .unwrap()
        .handoff(|| Ok(()))
        .unwrap();
    let _writer = locks.acquire().await;
    for game in affected_games(&manifest, "pd3", &[temp.path().join("Other.ini")]) {
        assert!(
            require_game_idle(&locks, &game, locks.pending_launch(&game).as_ref(), false).is_ok()
        );
    }
    let games = affected_games(&manifest, "pd3", &[shared]);
    assert_eq!(games, ["cb", "pd3"]);
    assert!(games.iter().any(|game| {
        require_game_idle(&locks, game, locks.pending_launch(game).as_ref(), false).is_err()
    }));
}

#[tokio::test]
async fn stale_process_observation_cannot_release_a_new_launch_reservation() {
    let locks = ResourceLocks::default();
    locks
        .reserve_launch(locks.acquire().await, "pd3")
        .unwrap()
        .handoff(|| Ok(()))
        .unwrap();
    let stale = locks.pending_launch("pd3").unwrap();
    locks
        .cancel_pending_launch("pd3", &stale, |_| Ok(()))
        .unwrap();
    let launch = locks.reserve_launch(locks.acquire().await, "pd3").unwrap();
    assert_eq!(
        locks.observe_launch("pd3", Some(&stale), true),
        Some(super::super::resource_state::PendingGameLaunch::Preparing)
    );
    launch.handoff(|| Ok(())).unwrap();
    assert_eq!(
        locks.observe_launch("pd3", Some(&stale), true),
        Some(super::super::resource_state::PendingGameLaunch::HandedOff)
    );
    assert!(locks.pending_launch("pd3").is_some());
    locks
        .cancel_pending_launch("pd3", &locks.pending_launch("pd3").unwrap(), |_| Ok(()))
        .unwrap();
    assert!(require_game_idle(&locks, "pd3", None, false).is_ok());
}

#[tokio::test]
async fn a_stale_false_process_probe_stays_blocked_after_another_probe_observes_the_game() {
    let locks = ResourceLocks::default();
    locks
        .reserve_launch(locks.acquire().await, "pd3")
        .unwrap()
        .handoff(|| Ok(()))
        .unwrap();
    let pending = locks.pending_launch("pd3").unwrap();
    assert_eq!(locks.observe_launch("pd3", Some(&pending), true), None);
    assert_eq!(
        locks.observe_launch("pd3", Some(&pending), false),
        Some(super::super::resource_state::PendingGameLaunch::HandedOff)
    );
    assert!(locks
        .cancel_pending_launch("pd3", &pending, |_| panic!(
            "a stale reset must not restore files"
        ))
        .is_err());
    assert!(require_game_idle(&locks, "pd3", Some(&pending), false).is_err());
    assert!(require_game_idle(&locks, "pd3", None, true).is_err());
}

#[test]
fn recovery_opener_reports_an_early_failure_and_accepts_success() {
    for code in [0, 4] {
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new("cmd.exe");
            command
                .creation_flags(0x08000000)
                .args(["/C", "exit", "/B"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = std::process::Command::new("sh");
            command.arg("-c");
            command
        };
        #[cfg(windows)]
        command.arg(code.to_string());
        #[cfg(not(windows))]
        command.arg(format!("exit {code}"));
        let mut child = command.spawn().unwrap();
        child.wait().unwrap();
        let result = wait_for_recovery_opener(&mut child);
        if code == 0 {
            assert!(result.is_ok());
            continue;
        }
        assert!(result.unwrap_err().contains("opener failed"));
    }
}

#[test]
fn recovery_opener_does_not_wait_for_or_kill_a_running_file_manager() {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("powershell.exe");
        command.creation_flags(0x08000000).args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 10",
        ]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = std::process::Command::new("sleep");
        command.arg("10");
        command
    };
    let mut child = command.spawn().unwrap();
    let result = wait_for_recovery_opener(&mut child);
    let running = child.try_wait().unwrap().is_none();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(result.is_ok());
    assert!(running);
}

#[test]
fn movies_in_the_wrong_declared_format_are_rejected_without_staging() {
    for (game_id, name, extension) in [("pd3", "trailer.mp4", "bk2"), ("ron", "trailer.bk2", "mp4")]
    {
        let spec = game_spec(game_id).unwrap();
        let (kind, verdict) = assess(name, None, &Ok(vec![]), spec.movie_replacement, None);
        assert!(matches!(kind, ResourceEntryKind::Movie));
        assert!(verdict.unwrap_err().contains(&format!(".{extension}")));
    }
}

#[test]
fn config_presets_can_be_reviewed_without_movie_support() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Engine.ini");
    fs::write(&path, b"[S]\nA=1\n").unwrap();
    let config = ConfigPresets::UnrealEngineIni {};
    let no_movies = Err("Movie replacements are not supported".into());
    let (kind, verdict) = assess("Engine.ini", Some(&path), &no_movies, None, Some(&config));
    assert!(matches!(kind, ResourceEntryKind::Ini));
    assert!(verdict.is_ok());
    assert!(assess(
        "Engine.ini",
        Some(&path),
        &Ok(vec!["Intro.bk2".into()]),
        None,
        None
    )
    .1
    .unwrap_err()
    .contains("not supported"));
}

#[test]
fn undeclared_configs_and_unknown_games_cannot_choose_a_config_location() {
    assert!(config_presets("pd2").unwrap_err().contains("not supported"));
    assert!(config_presets("not-a-game")
        .unwrap_err()
        .contains("unknown game"));
}

#[test]
fn saved_resource_rows_remain_visible_without_movie_install_support() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Engine.ini");
    fs::write(&path, b"[S]\nA=1\n").unwrap();
    let mut deployment = preset(&store, &path, b"[S]\nA=1\n");
    deployment.game_id = "pd2".into();
    let mut manifest = store.load_manifest().unwrap();
    manifest.deployments.push(deployment);
    store.save_manifest(&manifest).unwrap();
    let (rows, error, pending) =
        installed_rows_for(&store, "pd2", temp.path().to_str().unwrap()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].filename, "Engine.ini");
    assert!(error.is_none());
    assert!(!pending);
}

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
        ConfigFileLocation::Missing { path: found } if found == path.to_string_lossy()
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
        ConfigFileLocation::Found { path: found } if found == path.to_string_lossy()
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
fn unreadable_ini_status_reports_the_parse_error_without_changing_the_file() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Engine.ini");
    let invalid = b"\xEF\xBB\xBF\xFF";
    fs::write(&path, invalid).unwrap();
    let deployment = preset(&store, &path, b"[S]\nA=1\n");
    assert!(status_of(&deployment).unwrap_err().contains("UTF-8"));
    assert_eq!(fs::read(path).unwrap(), invalid);
}

#[test]
fn matching_preexisting_movie_is_not_adopted_and_never_becomes_a_baseline() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Intro.bk2");
    let mut payload = vec![0u8; 64];
    payload[..4].copy_from_slice(b"KB2i");
    for (offset, value) in [
        (4, 56u32),
        (8, 1),
        (12, 16),
        (20, 1280),
        (24, 720),
        (28, 30),
        (32, 1),
        (48, 52),
    ] {
        payload[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    fs::write(&path, &payload).unwrap();
    let Content::Present { sha256, size } = store.put_bytes(&payload).unwrap() else {
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
    assert_eq!(fs::read(&path).unwrap(), payload);
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
        shared_paks: false,
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

fn relocation_fixture() -> (tempfile::TempDir, ResourceStore, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let old = root.join("WindowsClient/Engine.ini");
    let new = root.join("Windows/Engine.ini");
    fs::create_dir_all(old.parent().unwrap()).unwrap();
    fs::create_dir_all(new.parent().unwrap()).unwrap();
    fs::write(&old, b"[S]\nA=0\nOther=keep\n").unwrap();
    fs::write(&new, b"[S]\nA=7\nNew=keep\n").unwrap();
    let store = ResourceStore::at(root.join("recovery"));
    let deployment = preset(&store, &old, b"[S]\nA=1\n");
    apply_preset(
        &store,
        "pd3",
        &store.load_manifest().unwrap(),
        deployment,
        None,
    )
    .unwrap();
    (temp, store, old, new)
}

#[test]
fn enabled_preset_relocation_restores_old_keys_and_recalculates_new_ownership() {
    let (_temp, store, old, new) = relocation_fixture();
    let before = store.load_manifest().unwrap();
    let deployment = &before.deployments[0];
    relocate_preset(&store, &before, deployment, &new).unwrap();
    assert_eq!(fs::read(&old).unwrap(), b"[S]\nA=0\nOther=keep\n");
    assert_eq!(fs::read(&new).unwrap(), b"[S]\nA=1\nNew=keep\n");
    let after = store.load_manifest().unwrap();
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(after.deployments.len(), 1);
    assert_eq!(after.deployments[0].id, deployment.id);
    assert!(after.deployments[0].enabled);
    assert_eq!(
        preset_of(&after.deployments[0]).unwrap().source_sha256,
        preset_of(deployment).unwrap().source_sha256
    );
    assert_eq!(after.ini_revisions.len(), before.ini_revisions.len() + 2);
    release_preset(&store, "pd3", &after.deployments[0], false).unwrap();
    assert_eq!(fs::read(&new).unwrap(), b"[S]\nA=7\nNew=keep\n");
}

#[test]
fn disabled_preset_relocation_only_moves_the_record() {
    let (_temp, store, old, new) = relocation_fixture();
    let deployment = store.load_manifest().unwrap().deployments.remove(0);
    release_preset(&store, "pd3", &deployment, false).unwrap();
    let before = store.load_manifest().unwrap();
    let old_bytes = fs::read(&old).unwrap();
    let new_bytes = fs::read(&new).unwrap();
    relocate_preset(&store, &before, &before.deployments[0], &new).unwrap();
    let after = store.load_manifest().unwrap();
    assert!(!after.deployments[0].enabled);
    assert_eq!(
        preset_of(&after.deployments[0]).unwrap().config_path,
        new.to_string_lossy()
    );
    assert_eq!(after.ini_revisions.len(), before.ini_revisions.len());
    assert_eq!(fs::read(old).unwrap(), old_bytes);
    assert_eq!(fs::read(new).unwrap(), new_bytes);
}

#[test]
fn relocation_refuses_external_edits_readonly_and_ambiguous_files_without_writes() {
    for problem in [
        "external",
        "old_readonly",
        "new_readonly",
        "ambiguous",
        "missing_source",
    ] {
        let (_temp, store, old, new) = relocation_fixture();
        let before = store.load_manifest().unwrap();
        let permissions = [&old, &new].map(|path| fs::metadata(path).unwrap().permissions());
        match problem {
            "external" => fs::write(&old, b"[S]\nA=99\nOther=keep\n").unwrap(),
            "old_readonly" | "new_readonly" => {
                let path = if problem == "old_readonly" {
                    &old
                } else {
                    &new
                };
                let mut permissions = fs::metadata(path).unwrap().permissions();
                permissions.set_readonly(true);
                fs::set_permissions(path, permissions).unwrap();
            }
            "ambiguous" => fs::write(&new, b"[S]\nA=7\nA=8\n").unwrap(),
            "missing_source" => fs::remove_file(
                store.object_path(&preset_of(&before.deployments[0]).unwrap().source_sha256),
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let old_bytes = fs::read(&old).unwrap();
        let new_bytes = fs::read(&new).unwrap();
        assert!(
            relocate_preset(&store, &before, &before.deployments[0], &new).is_err(),
            "{problem}"
        );
        assert_eq!(
            serde_json::to_vec(&store.load_manifest().unwrap()).unwrap(),
            serde_json::to_vec(&before).unwrap(),
            "{problem}"
        );
        assert_eq!(fs::read(&old).unwrap(), old_bytes, "{problem}");
        assert_eq!(fs::read(&new).unwrap(), new_bytes, "{problem}");
        for (path, permissions) in [&old, &new].into_iter().zip(permissions) {
            fs::set_permissions(path, permissions).unwrap();
        }
    }
}

#[test]
fn cross_path_catalog_update_keeps_ownership_until_both_files_commit() {
    for blocked in [false, true] {
        let (_temp, store, old, new) = relocation_fixture();
        let before = store.load_manifest().unwrap();
        let mut update = preset(&store, &new, b"[S]\nA=2\n");
        update.id = "update".into();
        update.game_path = before.deployments[0].game_path.clone();
        update.canonical_game_path = before.deployments[0].canonical_game_path.clone();
        if blocked {
            fs::write(&old, b"[S]\nA=99\n").unwrap();
        }
        let staged = new.parent().unwrap().join("staged.ini");
        fs::write(&staged, b"[S]\nA=2\n").unwrap();
        let result = install_preset_from_staging(
            &store,
            update,
            &staged,
            Some(before.revision),
            &live_content(&new).unwrap(),
        );
        if blocked {
            assert!(result.is_err());
            assert_eq!(
                store.load_manifest().unwrap().deployments[0].id,
                before.deployments[0].id
            );
            assert_eq!(fs::read(&new).unwrap(), b"[S]\nA=7\nNew=keep\n");
            continue;
        }
        result.unwrap();
        let after = store.load_manifest().unwrap();
        assert_eq!(after.deployments.len(), 1);
        assert_eq!(after.deployments[0].id, "update");
        assert_eq!(fs::read(&old).unwrap(), b"[S]\nA=0\nOther=keep\n");
        assert_eq!(fs::read(&new).unwrap(), b"[S]\nA=2\nNew=keep\n");
    }
}

#[test]
fn relocation_only_qualifies_sibling_platform_folders_inside_the_declared_root() {
    let root = Path::new("Config");
    let new = root.join("Windows/Engine.ini");
    assert!(stale_platform_path(
        &root.join("WindowsClient/Engine.ini"),
        root,
        &new
    ));
    assert!(!stale_platform_path(&new, root, &new));
    assert!(!stale_platform_path(
        Path::new("Picked/WindowsClient/Engine.ini"),
        root,
        &new
    ));
    assert!(!stale_platform_path(
        &root.join("nested/WindowsClient/Engine.ini"),
        root,
        &new
    ));
}

#[tokio::test]
async fn running_game_prevents_the_relocation_transaction() {
    let (_temp, store, old, new) = relocation_fixture();
    let before = store.load_manifest().unwrap();
    let old_bytes = fs::read(&old).unwrap();
    let new_bytes = fs::read(&new).unwrap();
    let locks = ResourceLocks::default();
    let _guard = locks.acquire().await;
    let result = require_game_idle(&locks, "pd3", None, true)
        .and_then(|()| relocate_preset(&store, &before, &before.deployments[0], &new));
    assert!(result.is_err());
    assert_eq!(store.load_manifest().unwrap().revision, before.revision);
    assert_eq!(fs::read(&old).unwrap(), old_bytes);
    assert_eq!(fs::read(&new).unwrap(), new_bytes);
}

#[test]
fn same_id_retry_relocates_before_duplicate_install_short_circuit() {
    let (_temp, store, old, new) = relocation_fixture();
    let before = store.load_manifest().unwrap();
    let mut retry = before.deployments[0].clone();
    if let DeploymentBody::Ini { preset } = &mut retry.body {
        preset.config_path = new.to_string_lossy().into_owned();
    }
    let staged = new.parent().unwrap().join("source.ini");
    fs::write(&staged, b"[S]\nA=1\n").unwrap();
    install_preset_from_staging(
        &store,
        retry,
        &staged,
        Some(before.revision),
        &live_content(&new).unwrap(),
    )
    .unwrap();
    let after = store.load_manifest().unwrap();
    assert_eq!(after.deployments.len(), 1);
    assert_eq!(
        preset_of(&after.deployments[0]).unwrap().config_path,
        new.to_string_lossy()
    );
    assert_eq!(fs::read(old).unwrap(), b"[S]\nA=0\nOther=keep\n");
}

#[cfg(unix)]
#[test]
fn hardlinked_engine_ini_is_not_a_valid_destination() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Engine.ini");
    fs::write(&path, "").unwrap();
    fs::hard_link(&path, temp.path().join("alias.ini")).unwrap();
    assert!(validate_engine_ini(&path)
        .unwrap_err()
        .contains("hard-linked"));
}
