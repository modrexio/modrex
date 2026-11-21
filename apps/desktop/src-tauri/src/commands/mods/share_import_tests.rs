use super::*;
use crate::commands::mods::tests::make_zip;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

struct Game {
    root: TempDir,
    state: PathBuf,
    cfg: &'static mods::ModEngineConfig,
}

impl Game {
    fn new(id: &str) -> Self {
        let root = TempDir::new().unwrap();
        let cfg = mods::engine_for_game(id).unwrap();
        let state = mods::get_state_path(root.path().to_str().unwrap(), cfg);
        Self { root, cfg, state }
    }

    fn install(&self) -> Install<'_> {
        Install {
            game_path: self.root.path().to_str().unwrap(),
            state_path: &self.state,
            cfg: self.cfg,
            launcher: None,
        }
    }

    fn store(&self) -> ProfileStore {
        ProfileStore::new(self.install().game_path)
    }
}

fn workshop(id: u32, file: u32, name: &str) -> Value {
    json!({"file":{"source":"modworkshop","modId":id,"fileId":file},"enabled":true,"installedName":name})
}

fn setup(
    game: &Game,
    members: Vec<Value>,
    folders: Value,
    root: Value,
) -> (String, Vec<ImportRow>) {
    let share = super::super::parse(&json!({
        "format":"modrex-profile","schemaVersion":1,"gameId":game.cfg.game_id,"profileName":"Shared",
        "members":members,"folders":folders,"root":root,"loaders":[]
    }).to_string()).unwrap();
    let mut rows = share
        .members
        .iter()
        .enumerate()
        .map(|(i, member)| {
            let (workshop, file_id) = match member.file {
                ShareFile::ModWorkshop {
                    mod_id, file_id, ..
                } => (file_id.map(|id| (mod_id, id)), file_id),
                ShareFile::Nexus { file_id, .. } => (None, file_id),
            };
            ImportRow {
                workshop,
                newer: false,
                lookup_failed: false,
                pending: PendingReference {
                    member: member.clone(),
                    priority: member.priority,
                    reason: "Waiting".into(),
                    member_key: i + 1,
                    game_id: game.cfg.game_id.into(),
                    install_id: uuid::Uuid::new_v4().to_string(),
                    file_id,
                    folder_id: None,
                    needs_install_flow: false,
                },
            }
        })
        .collect::<Vec<_>>();
    let id = begin(
        &game.store(),
        &game.install(),
        &share,
        "Recipient",
        &mut rows,
    )
    .unwrap();
    (id, rows)
}

fn archive(entries: &[(&str, &[u8])]) -> PathBuf {
    make_zip(entries).into_temp_path().keep().unwrap()
}

async fn deliver(
    game: &Game,
    id: &str,
    row: &ImportRow,
    entries: &[(&str, &[u8])],
) -> MemberOutcome {
    let (mod_id, file_id) = row.workshop.unwrap();
    let download = mods::WorkshopDownload {
        remote_id: mod_id.into(),
        file_id: file_id.into(),
        mod_name: "Fixture".into(),
        mod_version: "2".into(),
        downloaded: archive(entries),
        file_type: "zip".into(),
        source_name: "fixture.zip".into(),
        workshop_file_name: Some("Fixture".into()),
        workshop_file_label: None,
    };
    let result = install_workshop_download(&game.install(), row, mod_id, file_id, download).await;
    persist_result(&game.store(), id, row.pending.member_key, result)
}

#[tokio::test]
async fn workshop_siblings_survive_archive_replay_and_a_profile_switch() {
    let game = Game::new("pd3");
    let original = profiles::create(
        &game.store(),
        &game.install(),
        "Original",
        profiles::ProfileSource::Current,
    )
    .unwrap();
    let mut exact = workshop(42, 11, "Other.pak");
    exact["archiveMember"] = json!("dark/A.pak");
    exact["priority"] = json!(3);
    let mut fallback = workshop(42, 12, "B.pak");
    fallback["archiveMember"] = json!("removed/B.pak");
    fallback["enabled"] = json!(false);
    fallback["priority"] = json!(1);
    let mut nested = workshop(51, 13, "C.pak");
    nested["folder"] = json!(2);
    nested["priority"] = json!(7);
    let (id, rows) = setup(
        &game,
        vec![exact, fallback, nested],
        json!([{"name":"HUD","children":[{"folder":2}]},{"name":"Inner","children":[{"mod":3}]}]),
        json!([{"mod":1},{"folder":1},{"mod":2}]),
    );
    let snapshot = || game.store().get(&id).unwrap();
    assert_eq!(snapshot().pending.len(), 3);
    assert!(game.install().read().unwrap().mods.is_empty());
    let files: &[(&str, &[u8])] = &[
        ("dark/A.pak", b"first"),
        ("light/B.pak", b"second"),
        ("light/C.pak", b"third"),
    ];
    for (index, row) in rows.iter().enumerate() {
        let outcome = deliver(&game, &id, row, files).await;
        assert!(
            matches!(outcome, MemberOutcome::Installed { ref install_id } if install_id == &row.pending.install_id),
            "{outcome:?}"
        );
        let reloaded = snapshot();
        assert_eq!(reloaded.pending.len(), 2 - index);
        assert!(reloaded.pending.iter().all(|p| p.member_key > index + 1));
    }
    let assert_layout = || {
        let install = game.install();
        let live = mods::state::reconcile_state(install.game_path, &game.state, game.cfg).unwrap();
        assert_eq!(live.mods.len(), 3);
        let hud = live
            .folders
            .iter()
            .find(|f| f.display_name == "HUD")
            .unwrap();
        let inner = live
            .folders
            .iter()
            .find(|f| f.display_name == "Inner")
            .unwrap();
        assert_eq!(hud.priority, 1);
        assert_eq!(inner.parent_id.as_deref(), Some(hud.id.as_str()));
        for (key, priority, on, bytes) in [
            (0, 3, true, b"first".as_slice()),
            (1, 1, false, b"second"),
            (2, 7, true, b"third"),
        ] {
            let m = live
                .mods
                .iter()
                .find(|m| m.install_id == rows[key].pending.install_id)
                .unwrap();
            assert_eq!((m.enabled, m.priority), (on, Some(priority)));
            assert_eq!(m.folder_id.as_ref(), (key == 2).then_some(&inner.id));
            let folder = mods::get_folder_path(&live.folders, m.folder_id.as_deref());
            let path = mods::paths::installed_mod_path(
                install.game_path,
                &m.filename,
                folder.as_deref(),
                game.cfg.primary(),
                on,
            );
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    };
    assert_layout();
    profiles::switch(&game.store(), &game.install(), &original.id).unwrap();
    assert!(game.install().read().unwrap().mods.is_empty());
    profiles::switch(&game.store(), &game.install(), &id).unwrap();
    assert_layout();
}

#[tokio::test]
async fn ambiguous_and_missing_archive_names_stay_pending() {
    let game = Game::new("pd3");
    let (id, rows) = setup(
        &game,
        vec![workshop(9, 23, "HUD.pak")],
        json!([]),
        json!([{"mod":1}]),
    );
    for entries in [
        vec![("A/HUD.pak", b"x".as_slice()), ("B/HUD.pak", b"y")],
        vec![("Only.pak", b"z")],
    ] {
        assert!(
            matches!(deliver(&game,&id,&rows[0],&entries).await, MemberOutcome::Pending { reason } if reason.contains("Choose"))
        );
        assert!(game.install().read().unwrap().mods.is_empty());
        assert_eq!(game.store().get(&id).unwrap().pending.len(), 1);
    }
}

#[tokio::test]
async fn host_set_waits_for_its_host_and_installs_after_a_shared_host() {
    let game = Game::new("pd2");
    let mut pack = workshop(220, 12, "Sunset");
    pack["hostPackSet"] = json!("Sunset");
    let (id, rows) = setup(
        &game,
        vec![pack, workshop(17160, 11, "Menu Backgrounds")],
        json!([]),
        json!([{"mod":1},{"mod":2}]),
    );
    let set: &[(&str, &[u8])] = &[
        ("Sunset/standard.png", b"1"),
        ("Sunset/crimenet.png", b"2"),
        ("Sunset/briefing.png", b"3"),
    ];
    assert!(
        matches!(deliver(&game,&id,&rows[0],set).await,MemberOutcome::Pending { reason } if reason.contains("Menu Backgrounds"))
    );
    assert_eq!(install_order(&rows), [1, 0]);
    for i in install_order(&rows) {
        let files = if i == 1 {
            &[("Menu Backgrounds/mod.txt", b"{}".as_slice())][..]
        } else {
            set
        };
        let outcome = deliver(&game, &id, &rows[i], files).await;
        assert!(
            matches!(outcome, MemberOutcome::Installed { .. }),
            "{outcome:?}"
        );
    }
    assert_eq!(
        fs::read(
            mods::mods_base(game.install().game_path, game.cfg.primary())
                .join("Menu Backgrounds/Assets/Sunset/standard.png")
        )
        .unwrap(),
        b"1"
    );
}

#[tokio::test]
async fn nexus_completion_matches_the_active_copy_pin_and_replays_placement() {
    let game = Game::new("pd3");
    let member = json!({"file":{"source":"nexus","modId":5,"fileId":9},"folder":1,"priority":7,"enabled":false,"installedName":"HUD.pak","archiveMember":"B/HUD.pak"});
    let (id, rows) = setup(
        &game,
        vec![member],
        json!([{"name":"HUD","children":[{"mod":1}]}]),
        json!([{"folder":1}]),
    );
    for (g, m, f) in [("pd2", 5, 9), ("pd3", 6, 9), ("pd3", 5, 8)] {
        assert!(matching_nexus(&game.store(), g, m, f).unwrap().is_none());
    }
    assert!(matching_nexus(&Game::new("pd3").store(), "pd3", 5, 9)
        .unwrap()
        .is_none());
    let other = profiles::create(
        &game.store(),
        &game.install(),
        "Other",
        profiles::ProfileSource::Empty {
            keep_loaders: false,
        },
    )
    .unwrap();
    profiles::switch(&game.store(), &game.install(), &other.id).unwrap();
    assert!(matching_nexus(&game.store(), "pd3", 5, 9)
        .unwrap()
        .is_none());
    profiles::switch(&game.store(), &game.install(), &id).unwrap();
    let (matched, pins) = matching_nexus(&game.store(), "pd3", 5, 9).unwrap().unwrap();
    let meta = mods::NexusInstallMeta {
        mod_id: 5,
        file_id: 9,
        name: "Interface".into(),
        version: "1".into(),
        author: None,
        thumbnail_url: None,
        file_type: "zip".into(),
        source_name: "HUD.zip".into(),
    };
    let outcome = install_nexus_member(
        &game.store(),
        &matched,
        &game.install(),
        &pins[0],
        &archive(&[("A/HUD.pak", b"unused"), ("B/HUD.pak", b"wanted")]),
        &meta,
    )
    .await
    .unwrap();
    assert!(
        matches!(outcome, MemberOutcome::Installed { .. }),
        "{outcome:?}"
    );
    let live = game.install().read().unwrap();
    let m = &live.mods[0];
    assert_eq!(m.source, "nexus");
    assert_eq!(m.folder_id, rows[0].pending.folder_id);
    assert_eq!(m.priority, Some(7));
    assert!(!m.enabled);
    assert_eq!(m.archive_member.as_deref(), Some("B/HUD.pak"));
    let folder = mods::get_folder_path(&live.folders, m.folder_id.as_deref());
    assert_eq!(
        fs::read(mods::disabled_mod_path(
            game.install().game_path,
            &m.filename,
            folder.as_deref(),
            game.cfg.primary()
        ))
        .unwrap(),
        b"wanted"
    );
    assert!(matching_nexus(&game.store(), "pd3", 5, 9)
        .unwrap()
        .is_none());
}

#[test]
fn import_refuses_unsaved_mods_set_aside_mods_and_an_unfinished_switch() {
    let game = Game::new("pd3");
    let install = game.install();
    let store = game.store();
    profiles::require_importable(&store, &install).unwrap();
    let staged = game.root.path().join("source.pak");
    fs::write(&staged, b"x").unwrap();
    mods::install_mod_from_path(
        install.game_path,
        &game.state,
        mods::InstalledMod {
            uid: "1".into(),
            filename: "Mod.pak".into(),
            file_id: Some(1),
            ..Default::default()
        },
        &staged,
        None,
        game.cfg,
        game.cfg.primary(),
    )
    .unwrap();
    assert!(profiles::require_importable(&store, &install)
        .unwrap_err()
        .starts_with("No profile is active."));
    assert!(store.list().unwrap().is_empty());
    let id = profiles::create(&store, &install, "Main", profiles::ProfileSource::Current)
        .unwrap()
        .id;
    let without_mods = mods::engine::vanilla_dir(install.game_path, game.cfg.primary());
    fs::create_dir_all(&without_mods).unwrap();
    assert!(profiles::require_importable(&store, &install)
        .unwrap_err()
        .contains("set aside"));
    fs::remove_dir(without_mods).unwrap();
    fs::write(
        game.root.path().join(".modrex/switch.json"),
        json!({"schemaVersion":1,"profileId":id}).to_string(),
    )
    .unwrap();
    assert!(profiles::require_importable(&store, &install)
        .unwrap_err()
        .contains("stopped part way"));
}

#[test]
fn old_profile_without_pending_references_reads_as_empty() {
    let game = Game::new("pd3");
    let id = uuid::Uuid::new_v4().to_string();
    let dir = game.root.path().join(".modrex/profiles");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join(format!("{id}.json")),
        json!({"schemaVersion":1,"id":id,"name":"Old","members":[]}).to_string(),
    )
    .unwrap();
    assert!(game.store().get(&id).unwrap().pending.is_empty());
}

#[test]
fn newer_versions_follow_the_catalog_update_policy() {
    assert!(newer_version(Some("v2.10"), Some("2.9")));
    assert!(!newer_version(Some("1.3"), Some("1.3.0")));
    assert!(!newer_version(Some("1.2"), Some("1.3")));
    assert!(!newer_version(None, Some("1.3")));
}

#[test]
fn pending_members_link_their_source_and_can_be_dismissed() {
    let game = Game::new("pd3");
    let nexus = json!({"file":{"source":"nexus","modId":27,"fileId":89},"enabled":true,"installedName":"N.pak"});
    let page_only =
        json!({"file":{"source":"nexus","modId":28},"enabled":true,"installedName":"P.pak"});
    let (id, _) = setup(
        &game,
        vec![workshop(42, 11, "A.pak"), nexus, page_only],
        json!([]),
        json!([{"mod":1},{"mod":2},{"mod":3}]),
    );
    let urls: Vec<_> = pending_members(&game.store().get(&id).unwrap())
        .into_iter()
        .map(|p| serde_json::to_value(p).unwrap()["url"].clone())
        .collect();
    assert_eq!(
        urls,
        [
            json!("https://modworkshop.net/mod/42"),
            json!("https://www.nexusmods.com/payday3/mods/27?tab=files&file_id=89&nmm=1"),
            json!("https://www.nexusmods.com/payday3/mods/28?tab=files"),
        ]
    );
    dismiss(&game.store(), 2).unwrap();
    let keys: Vec<_> = game
        .store()
        .get(&id)
        .unwrap()
        .pending
        .iter()
        .map(|p| p.member_key)
        .collect();
    assert_eq!(keys, [1, 3]);
    assert!(dismiss(&game.store(), 2)
        .unwrap_err()
        .contains("no longer waiting"));
}

#[test]
fn waiting_entries_offer_the_action_their_state_needs() {
    let game = Game::new("pd3");
    let nexus = json!({"file":{"source":"nexus","modId":27,"fileId":89},"enabled":true,"installedName":"N.pak"});
    let page_only =
        json!({"file":{"source":"nexus","modId":28},"enabled":true,"installedName":"P.pak"});
    let (id, _) = setup(
        &game,
        vec![
            workshop(42, 11, "A.pak"),
            workshop(43, 12, "B.pak"),
            nexus,
            page_only,
        ],
        json!([]),
        json!([{"mod":1},{"mod":2},{"mod":3},{"mod":4}]),
    );
    let store = game.store();
    let failed = MemberOutcome::Failed {
        error: "Download failed".into(),
    };
    record_outcome(&store, &id, 1, &failed).unwrap();
    let asks = MemberOutcome::Pending {
        reason: "Choose a file from the archive".into(),
    };
    record_outcome(&store, &id, 2, &asks).unwrap();
    let actions: Vec<_> = pending_members(&store.get(&id).unwrap())
        .into_iter()
        .map(|p| serde_json::to_value(p).unwrap()["action"].clone())
        .collect();
    assert_eq!(
        actions,
        [
            json!("tryAgain"),
            json!("openMod"),
            json!("nexusDownload"),
            json!("chooseFile")
        ]
    );
}

#[test]
fn a_normal_workshop_install_takes_the_place_its_entry_waited_for() {
    let game = Game::new("pd3");
    let mut member = workshop(42, 11, "HUD.pak");
    member["enabled"] = json!(false);
    member["folder"] = json!(1);
    member["priority"] = json!(5);
    let (id, _) = setup(
        &game,
        vec![member],
        json!([{"name":"HUD","children":[{"mod":1}]}]),
        json!([{"folder":1}]),
    );
    let staged = game.root.path().join("staged.pak");
    fs::write(&staged, b"chosen through the normal flow").unwrap();
    let record = mods::InstalledMod {
        uid: "99".into(),
        name: "HUD".into(),
        filename: "HUD.pak".into(),
        file_id: Some(99),
        ..mods::InstalledMod::from_catalog(
            "modworkshop",
            "42".into(),
            mods::IdentityEvidence::InstallProvenance,
        )
    };
    let install = game.install();
    mods::install_mod_from_path(
        install.game_path,
        install.state_path,
        record,
        &staged,
        None,
        game.cfg,
        game.cfg.primary(),
    )
    .unwrap();
    adopt_workshop(&install, "99").unwrap();
    let live = install.read().unwrap();
    let hud = live
        .folders
        .iter()
        .find(|f| f.display_name == "HUD")
        .unwrap();
    let placed = live.mods.iter().find(|m| m.uid == "99").unwrap();
    assert_eq!(placed.folder_id.as_deref(), Some(hud.id.as_str()));
    assert_eq!(placed.priority, Some(5));
    assert!(!placed.enabled);
    assert!(game.store().get(&id).unwrap().pending.is_empty());
}

#[test]
fn an_install_of_another_mod_leaves_waiting_entries_alone() {
    let game = Game::new("pd3");
    let (id, _) = setup(
        &game,
        vec![workshop(42, 11, "HUD.pak")],
        json!([]),
        json!([{"mod":1}]),
    );
    let staged = game.root.path().join("staged.pak");
    fs::write(&staged, b"unrelated").unwrap();
    let record = mods::InstalledMod {
        uid: "7".into(),
        name: "Other".into(),
        filename: "Other.pak".into(),
        file_id: Some(7),
        ..mods::InstalledMod::from_catalog(
            "modworkshop",
            "77".into(),
            mods::IdentityEvidence::InstallProvenance,
        )
    };
    let install = game.install();
    mods::install_mod_from_path(
        install.game_path,
        install.state_path,
        record,
        &staged,
        None,
        game.cfg,
        game.cfg.primary(),
    )
    .unwrap();
    adopt_workshop(&install, "7").unwrap();
    assert_eq!(game.store().get(&id).unwrap().pending.len(), 1);
}
