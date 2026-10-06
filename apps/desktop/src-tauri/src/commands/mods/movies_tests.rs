use super::*;
use std::fs;

#[test]
fn an_unmanaged_matching_movie_needs_neither_a_write_nor_a_baseline() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Intro.bk2");
    fs::write(&path, b"manual movie").unwrap();
    let payload = store.put_bytes(b"manual movie").unwrap();
    let deployment = pack("matching", &path, &payload);
    let plan = plan_apply(&store, &store.load_manifest().unwrap(), &deployment, None).unwrap();
    assert!(plan.steps.is_empty());
    assert!(plan.new_baselines.is_empty());
    assert_eq!(plan.already_current, [path.to_string_lossy().into_owned()]);
    assert_eq!(fs::read(&path).unwrap(), b"manual movie");
}

#[test]
fn releasing_one_slot_releases_every_transitively_overlapping_pack_without_writing_files() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let first = temp.path().join("First.bk2");
    let second = temp.path().join("Second.bk2");
    let third = temp.path().join("Third.bk2");
    let payload = store.put_bytes(b"personal movie").unwrap();
    for path in [&first, &second, &third] {
        fs::write(path, b"personal movie").unwrap();
    }
    let mut a = pack("a", &first, &payload);
    let mut b = pack("b", &second, &payload);
    let c = pack("c", &third, &payload);
    if let DeploymentBody::Movie { slots } = &mut a.body {
        slots.extend(slots_of(&b).to_vec());
    }
    if let DeploymentBody::Movie { slots } = &mut b.body {
        slots.extend(slots_of(&c).to_vec());
    }
    b.enabled = false;
    let mut manifest = store.load_manifest().unwrap();
    manifest.deployments = vec![a, b];
    store.save_manifest(&manifest).unwrap();
    store
        .keep_current("pd3", vec![first.clone()], None, 0)
        .unwrap();
    assert!(store.load_manifest().unwrap().deployments.is_empty());
    for path in [&first, &second, &third] {
        assert_eq!(fs::read(path).unwrap(), b"personal movie");
    }
    let Content::Present { sha256, size } = payload else {
        unreachable!()
    };
    assert_eq!(store.read_object(&sha256, size).unwrap(), b"personal movie");
}

fn pack(id: &str, destination: &Path, payload: &Content) -> Deployment {
    let Content::Present { sha256, size } = payload else {
        unreachable!()
    };
    Deployment {
        id: id.into(),
        game_id: "pd3".into(),
        game_path: destination.parent().unwrap().to_string_lossy().into(),
        canonical_game_path: destination.parent().unwrap().to_string_lossy().into(),
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
                slot: "Intro.bk2".into(),
                destination: destination.to_string_lossy().into(),
                entry_name: "download.bk2".into(),
                payload_sha256: sha256.clone(),
                payload_size: *size,
            }],
        },
    }
}

#[test]
fn switching_packs_keeps_first_personal_baseline_and_refuses_divergence() {
    let temp = tempfile::tempdir().unwrap();
    let store = ResourceStore::at(temp.path().join("recovery"));
    let path = temp.path().join("Intro.bk2");
    fs::write(&path, b"already replaced before Modrex").unwrap();
    let original = live_content(&path).unwrap();
    let a = pack("a", &path, &store.put_bytes(b"movie a").unwrap());
    let mut manifest = store.load_manifest().unwrap();
    let plan = plan_apply(&store, &manifest, &a, None).unwrap();
    store
        .apply("pd3", plan.steps, |m| {
            m.movie_baselines.extend(plan.new_baselines);
            m.deployments.push(a.clone());
        })
        .unwrap();
    manifest = store.load_manifest().unwrap();
    let b = pack("b", &path, &store.put_bytes(b"movie b").unwrap());
    let plan = plan_apply(&store, &manifest, &b, None).unwrap();
    assert_eq!(plan.switched_off, ["a"]);
    assert!(plan.new_baselines.is_empty());
    store
        .apply("pd3", plan.steps, |m| {
            m.deployments[0].enabled = false;
            m.deployments.push(b.clone());
        })
        .unwrap();
    manifest = store.load_manifest().unwrap();
    assert_eq!(plan_restore(&manifest, &b).unwrap()[0].after, original);
    fs::write(&path, b"store update").unwrap();
    assert!(plan_restore(&manifest, &b).is_err());
    assert!(plan_apply(&store, &manifest, &a, None).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"store update");
}

#[test]
fn container_validation_checks_frame_index_and_known_revisions() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("sample.bk2");
    for (signature, index) in [(b"BIKi", 44usize), (b"KB2i", 48)] {
        let mut bytes = vec![0u8; 64];
        bytes[..4].copy_from_slice(signature);
        for (offset, value) in [
            (4, 56u32),
            (8, 1),
            (12, 16),
            (16, 1),
            (20, 1280),
            (24, 720),
            (28, 30),
            (32, 1),
            (index, (index + 4) as u32),
        ] {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        fs::write(&path, &bytes).unwrap();
        assert!(validate_bink(&path).is_ok());
        bytes[index..index + 4].copy_from_slice(&0u32.to_le_bytes());
        fs::write(&path, &bytes).unwrap();
        assert!(validate_bink(&path).is_err());
        bytes[3] = b'z';
        fs::write(&path, &bytes).unwrap();
        assert!(validate_bink(&path).is_err());
    }
    assert!(is_bk2_name("INTRO.BK2"));
    assert!(!is_bk2_name("intro.bak2"));
    assert!(slot_destination(temp.path(), "../Intro.bk2", &["Intro.bk2".into()]).is_err());
}
