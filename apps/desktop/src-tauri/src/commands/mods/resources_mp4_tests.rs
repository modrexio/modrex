use super::*;
use std::fs;

fn pack(store: &ResourceStore, path: &Path, id: &str, payload: &[u8]) -> Deployment {
    let Content::Present { sha256, size } = store.put_bytes(payload).unwrap() else {
        unreachable!()
    };
    Deployment {
        id: id.into(),
        game_id: "ron".into(),
        game_path: path.parent().unwrap().to_string_lossy().into(),
        canonical_game_path: path.parent().unwrap().to_string_lossy().into(),
        launcher: Some("steam".into()),
        name: id.into(),
        version: "1".into(),
        source: None,
        remote_id: None,
        file_id: None,
        installed_at: "t".into(),
        enabled: true,
        body: DeploymentBody::Movie {
            slots: vec![MovieSlot {
                slot: "ReadyOrNot_StartupMovie.mp4".into(),
                destination: path.to_string_lossy().into(),
                entry_name: "arbitrary author filename.mp4".into(),
                payload_sha256: sha256,
                payload_size: size,
            }],
        },
    }
}

#[test]
fn mp4_pack_switch_and_enable_preserve_the_first_manual_baseline() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp
        .path()
        .canonicalize()
        .unwrap()
        .join("ReadyOrNot_StartupMovie.mp4");
    let manual = b"manual setup before Modrex";
    fs::write(&path, manual).unwrap();
    let first = super::super::mp4_tests::sample_mp4();
    let mut second = first.clone();
    second.extend(b"\0\0\0\x08free");
    let a = pack(&store, &path, "a", &first);
    let b = pack(&store, &path, "b", &second);
    apply_movie_pack(
        &store,
        "ron",
        &store.load_manifest().unwrap(),
        a.clone(),
        None,
    )
    .unwrap();
    assert_eq!(fs::read(&path).unwrap(), first);
    let baselines = store.load_manifest().unwrap().movie_baselines;
    assert_eq!(baselines.len(), 1);
    let initial_baseline = serde_json::to_vec(&baselines).unwrap();
    apply_movie_pack(
        &store,
        "ron",
        &store.load_manifest().unwrap(),
        b.clone(),
        None,
    )
    .unwrap();
    assert_eq!(fs::read(&path).unwrap(), second);
    let manifest = store.load_manifest().unwrap();
    assert_eq!(
        serde_json::to_vec(&manifest.movie_baselines).unwrap(),
        initial_baseline
    );
    assert!(
        !manifest
            .deployments
            .iter()
            .find(|d| d.id == "a")
            .unwrap()
            .enabled
    );
    let restore = movies::plan_restore(&manifest, &b).unwrap();
    store
        .apply("ron", restore, |m| {
            m.deployments
                .iter_mut()
                .find(|d| d.id == "b")
                .unwrap()
                .enabled = false
        })
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), manual);
    apply_movie_pack(
        &store,
        "ron",
        &store.load_manifest().unwrap(),
        a.clone(),
        None,
    )
    .unwrap();
    assert_eq!(fs::read(&path).unwrap(), first);
    let manifest = store.load_manifest().unwrap();
    assert_eq!(
        serde_json::to_vec(&manifest.movie_baselines).unwrap(),
        initial_baseline
    );
    let restore = movies::plan_restore(&manifest, &a).unwrap();
    store
        .apply("ron", restore, |m| {
            m.deployments.clear();
            movies::prune_baselines(m);
        })
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), manual);
    assert!(store.load_manifest().unwrap().movie_baselines.is_empty());
}

#[test]
fn identical_preexisting_mp4_does_not_claim_a_baseline_or_deployment() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp
        .path()
        .canonicalize()
        .unwrap()
        .join("ReadyOrNot_StartupMovie.mp4");
    let payload = super::super::mp4_tests::sample_mp4();
    fs::write(&path, &payload).unwrap();
    let deployment = pack(&store, &path, "a", &payload);
    let result = apply_movie_pack(
        &store,
        "ron",
        &store.load_manifest().unwrap(),
        deployment,
        None,
    )
    .unwrap();
    assert!(!result.installed);
    assert_eq!(
        result.already_current_movies,
        [path.to_string_lossy().into_owned()]
    );
    let manifest = store.load_manifest().unwrap();
    assert!(manifest.deployments.is_empty());
    assert!(manifest.movie_baselines.is_empty());
    assert_eq!(fs::read(&path).unwrap(), payload);
}

#[test]
fn movie_assessment_and_saved_payload_apply_reject_the_wrong_format_without_writes() {
    let temp = tempfile::tempdir().unwrap();
    let staged = temp.path().join("payload");
    let payload = super::super::mp4_tests::sample_mp4();
    fs::write(&staged, &payload).unwrap();
    let ron = game_spec("ron").unwrap().movie_replacement;
    let bink = game_spec("pd3").unwrap().movie_replacement;
    let inventory = Ok(vec!["ReadyOrNot_StartupMovie.mp4".into()]);
    assert!(
        assess("arbitrary source.mp4", Some(&staged), &inventory, ron, None)
            .1
            .is_ok()
    );
    assert!(assess("Intro.bk2", Some(&staged), &inventory, ron, None)
        .1
        .unwrap_err()
        .contains(".mp4"));
    assert!(assess("Intro.mp4", Some(&staged), &inventory, bink, None)
        .1
        .unwrap_err()
        .contains(".bk2"));
    fs::write(&staged, b"modified after review").unwrap();
    assert!(movies::validate_payload("ron", &staged).is_err());
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp
        .path()
        .canonicalize()
        .unwrap()
        .join("ReadyOrNot_StartupMovie.mp4");
    let manual = b"manual setup";
    fs::write(&path, manual).unwrap();
    let manifest = store.load_manifest().unwrap();
    let before = serde_json::to_vec(&manifest).unwrap();
    let mut deployment = pack(&store, &path, "bad", &payload);
    assert!(apply_movie_pack(&store, "pd3", &manifest, deployment.clone(), None).is_err());
    let Content::Present { sha256, size } = store.capture(&staged).unwrap() else {
        unreachable!()
    };
    let DeploymentBody::Movie { slots } = &mut deployment.body else {
        unreachable!()
    };
    slots[0].payload_sha256 = sha256;
    slots[0].payload_size = size;
    assert!(apply_movie_pack(&store, "ron", &manifest, deployment, None).is_err());
    assert_eq!(fs::read(&path).unwrap(), manual);
    assert_eq!(
        serde_json::to_vec(&store.load_manifest().unwrap()).unwrap(),
        before
    );
}
