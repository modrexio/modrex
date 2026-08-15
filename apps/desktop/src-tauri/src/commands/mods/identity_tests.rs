use super::*;
use crate::commands::mods::engine::engine_for_game;
use crate::commands::mods::types::InstalledMod;
use crate::commands::mods::{read_state, save_state};
use tempfile::TempDir;

fn signals(updater: Option<(&str, &str)>) -> LocalSignals {
    LocalSignals {
        declared_name: Some("Celer".into()),
        declared_author: Some("TdlQ".into()),
        declared_version: Some("55".into()),
        updater: updater.map(|(a, b)| (a.to_string(), b.to_string())),
        ..LocalSignals::default()
    }
}

fn repository(name: Option<&str>) -> LocalSignals {
    LocalSignals {
        declared_name: name.map(str::to_string),
        repository: Some(("github".into(), "drnewbie/mess".into())),
        ..LocalSignals::default()
    }
}

#[test]
fn a_mod_with_no_catalog_still_gets_an_identity() {
    // The whole point: no ModWorkshop row exists for this mod and it is still known.
    let id = resolve_identity(&signals(Some(("pd2mods.z77.fr", "Celer")))).unwrap();
    assert_eq!(id.namespace, "pd2mods.z77.fr");
    assert_eq!(id.key, "Celer");
    assert_eq!(id.confidence, IdentityConfidence::Strong);
    assert_eq!(id.evidence, IdentityEvidence::UpdaterNamespace);
}

#[test]
fn the_namespace_is_a_field_so_no_consumer_has_to_split_a_key() {
    let updater = resolve_identity(&signals(Some(("pd2mods.z77.fr", "Celer")))).unwrap();
    let legacy = resolve_identity(&LocalSignals {
        legacy: Some(("paydaymods".into(), "Celer".into())),
        ..LocalSignals::default()
    })
    .unwrap();
    // Same key, different worlds: the namespace is what keeps them apart.
    assert_eq!(updater.key, legacy.key);
    assert_ne!(updater.namespace, legacy.namespace);
}

#[test]
fn a_repository_alone_is_never_an_identity() {
    // Surveyed repositories hold up to 130 distinct mods, so the repository only identifies a
    // mod together with the name that mod declares.
    assert_eq!(resolve_identity(&repository(None)), None);

    let id = resolve_identity(&repository(Some("Fast Forwarding Drill"))).unwrap();
    assert_eq!(id.namespace, "github");
    assert_eq!(id.key, "drnewbie/mess#Fast Forwarding Drill");
    assert_eq!(id.evidence, IdentityEvidence::Repository);
}

#[test]
fn two_mods_from_one_repository_keep_separate_identities() {
    let one = resolve_identity(&repository(Some("Text to Speech"))).unwrap();
    let two = resolve_identity(&repository(Some("Armor Enchantment"))).unwrap();
    assert_ne!(one.key, two.key);
}

#[test]
fn a_dead_namespace_still_identifies_without_promising_updates() {
    let id = resolve_identity(&LocalSignals {
        declared_name: Some("Silent Assassin".into()),
        legacy: Some(("paydaymods".into(), "silentassassin".into())),
        ..LocalSignals::default()
    })
    .unwrap();
    assert_eq!(id.namespace, "paydaymods");
    assert_eq!(id.key, "silentassassin");
    // Nothing here says anything about updates; capability lives elsewhere entirely.
    assert_eq!(id.confidence, IdentityConfidence::Strong);
}

#[test]
fn name_and_author_alone_stay_a_candidate() {
    let id = resolve_identity(&LocalSignals {
        declared_name: Some("Better Bots".into()),
        declared_author: Some("See readme".into()),
        ..LocalSignals::default()
    })
    .unwrap();
    assert_eq!(id.confidence, IdentityConfidence::Candidate);
    assert_eq!(id.evidence, IdentityEvidence::NameAuthor);
}

#[test]
fn nothing_declared_means_no_identity() {
    assert_eq!(resolve_identity(&LocalSignals::default()), None);
}

#[test]
fn name_compatibility_accepts_real_title_variation_and_rejects_a_different_project() {
    assert!(names_are_compatible(
        "VanillaHUDPlus",
        "VanillaHUD Plus (WolfHUD Continued)"
    ));
    assert!(names_are_compatible(
        "No Crime.Net Regions",
        "No Crime.net Regions"
    ));
    // What this guard exists for: a mod shipping another project's id.
    assert!(!names_are_compatible(
        "KineticTrackers",
        "PAYDAY 2 Savefile Import/Export Tool"
    ));
}

// ── ensure_identities over tracked state ─────────────────────────────────────

fn pd2_mod_dir(game: &std::path::Path, folder: &str, body: &str) {
    let dir = game.join("mods").join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("mod.txt"), body).unwrap();
}

fn tracked(folder: &str) -> InstalledMod {
    InstalledMod {
        uid: folder.to_string(),
        id: -1,
        name: folder.to_string(),
        filename: folder.to_string(),
        enabled: true,
        ..InstalledMod::default()
    }
}

#[test]
fn a_locally_identified_mod_needs_no_catalog_row() {
    let game = TempDir::new().unwrap();
    pd2_mod_dir(
        game.path(),
        "Celer",
        r#"{ "name": "Celer", "author": "TdlQ", "version": "55",
             "simple_update_url": "http://pd2mods.z77.fr/update/Celer.zip" }"#,
    );
    let cfg = engine_for_game("pd2").unwrap();
    let mut mods = vec![tracked("Celer")];

    let changed = ensure_identities(game.path().to_str().unwrap(), cfg, &[], &mut mods, None);

    assert!(changed);
    let m = &mods[0];
    let identity = m.identity.as_ref().unwrap();
    assert_eq!(identity.namespace, "pd2mods.z77.fr");
    assert_eq!(identity.key, "Celer");
    // Identity did not invent a catalog: browsing and updating stay unavailable.
    assert_eq!(m.remote_id, None);
    assert_eq!(m.declared.as_ref().unwrap().author.as_deref(), Some("TdlQ"));
    assert_eq!(m.declared.as_ref().unwrap().version.as_deref(), Some("55"));
}

#[test]
fn mods_sharing_an_updater_tool_do_not_collapse_onto_one_identity() {
    let game = TempDir::new().unwrap();
    for folder in ["Iter", "Keepers", "Celer"] {
        pd2_mod_dir(
            game.path(),
            folder,
            &format!(
                r#"{{ "name": "{folder}",
                      "simple_update_url": "http://pd2mods.z77.fr/update/{folder}.zip",
                      "updates": [ {{ "identifier": "SimpleModUpdater",
                        "host": {{ "meta": "http://pd2mods.z77.fr/meta/SimpleModUpdater" }} }} ] }}"#
            ),
        );
    }
    let cfg = engine_for_game("pd2").unwrap();
    let mut mods = vec![tracked("Iter"), tracked("Keepers"), tracked("Celer")];

    ensure_identities(game.path().to_str().unwrap(), cfg, &[], &mut mods, None);

    let keys: Vec<_> = mods
        .iter()
        .map(|m| m.identity.as_ref().unwrap().key.clone())
        .collect();
    assert_eq!(keys, vec!["Iter", "Keepers", "Celer"]);
}

#[test]
fn a_folder_rename_does_not_change_the_identity() {
    let cfg = engine_for_game("pd2").unwrap();
    let body = r#"{ "name": "Check For Wallbangs", "author": "vojin154",
                    "updates": [ { "identifier": "check_for_wallbangs", "host": { "meta":
                      "https://raw.githubusercontent.com/vojin154/pd2_check_for_wallbangs/main/meta.json" } } ] }"#;
    let mut keys = vec![];
    // The same mod as GitHub's source archive unpacks it, and after a user renames the folder.
    for folder in [
        "pd2_check_for_wallbangs-main",
        "wallbangs",
        "pd2_check_for_wallbangs-master",
    ] {
        let game = TempDir::new().unwrap();
        pd2_mod_dir(game.path(), folder, body);
        let mut mods = vec![tracked(folder)];
        ensure_identities(game.path().to_str().unwrap(), cfg, &[], &mut mods, None);
        keys.push(mods[0].identity.as_ref().unwrap().key.clone());
    }
    assert_eq!(keys[0], keys[1]);
    assert_eq!(keys[1], keys[2]);
    assert_eq!(
        keys[0],
        "vojin154/pd2_check_for_wallbangs#Check For Wallbangs"
    );
}

#[test]
fn identity_is_stable_while_the_installed_version_moves() {
    let cfg = engine_for_game("pd2").unwrap();
    let mut keys = vec![];
    for version in ["11.2.5", "11.3.1"] {
        let game = TempDir::new().unwrap();
        pd2_mod_dir(
            game.path(),
            "Bot Weapons and Equipment",
            &format!(
                r#"{{ "name": "Bot Weapons and Equipment", "version": "{version}",
                      "updates": [ {{ "identifier": "pd2-bot-weapons",
                        "host": {{ "meta": "https://updates.hoppip.at/pd2-bot-weapons" }} }} ] }}"#
            ),
        );
        let mut mods = vec![tracked("Bot Weapons and Equipment")];
        ensure_identities(game.path().to_str().unwrap(), cfg, &[], &mut mods, None);
        keys.push(mods[0].identity.as_ref().unwrap().key.clone());
        assert_eq!(
            mods[0].declared.as_ref().unwrap().version.as_deref(),
            Some(version)
        );
    }
    assert_eq!(keys[0], keys[1]);
}

#[test]
fn a_catalog_reference_from_an_older_state_file_claims_no_install_history() {
    // The one case where provenance genuinely cannot be recovered: the reference was already
    // persisted, and nothing recorded how it was found. It must not be dressed up as an install.
    let game = TempDir::new().unwrap();
    pd2_mod_dir(
        game.path(),
        "VanillaHUD Plus",
        r#"{ "name": "VanillaHUDPlus", "author": "Test1" }"#,
    );
    let cfg = engine_for_game("pd2").unwrap();
    let mut mods = vec![InstalledMod {
        remote_id: Some("25629".into()),
        ..tracked("VanillaHUD Plus")
    }];

    ensure_identities(game.path().to_str().unwrap(), cfg, &[], &mut mods, None);

    let identity = mods[0].identity.as_ref().unwrap();
    assert_eq!(identity.namespace, "modworkshop");
    assert_eq!(identity.key, "25629");
    assert_eq!(identity.evidence, IdentityEvidence::CatalogReference);
    assert_eq!(identity.confidence, IdentityConfidence::Strong);
}

#[test]
fn a_recorded_identity_is_never_recomputed_from_disk() {
    // Identification and installation write identity as they establish the association, so
    // this pass exists only to fill gaps. Re-deriving here would let a marker file edit
    // silently move an install onto another project.
    let game = TempDir::new().unwrap();
    pd2_mod_dir(
        game.path(),
        "Celer",
        r#"{ "name": "Celer", "simple_update_url": "http://pd2mods.z77.fr/update/Celer.zip" }"#,
    );
    let cfg = engine_for_game("pd2").unwrap();
    let mut mods = vec![InstalledMod {
        identity: Some(ModIdentity::new(
            "modworkshop",
            "25629",
            IdentityEvidence::InstallProvenance,
        )),
        ..tracked("Celer")
    }];

    let changed = ensure_identities(game.path().to_str().unwrap(), cfg, &[], &mut mods, None);

    assert!(!changed);
    assert_eq!(mods[0].identity.as_ref().unwrap().key, "25629");
}

// ── persistence ──────────────────────────────────────────────────────────────

fn state_with_mod(game: &TempDir, mod_json: &str) -> std::path::PathBuf {
    let state_path = game.path().join("mods").join(".modrex.json");
    std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();
    std::fs::write(
        &state_path,
        format!(r#"{{"folders":[],"mods":[{mod_json}]}}"#),
    )
    .unwrap();
    state_path
}

#[test]
fn old_state_without_the_new_fields_loads_enriches_saves_and_reloads() {
    let game = TempDir::new().unwrap();
    pd2_mod_dir(
        game.path(),
        "Celer",
        r#"{ "name": "Celer", "author": "TdlQ", "version": "55",
             "simple_update_url": "http://pd2mods.z77.fr/update/Celer.zip" }"#,
    );
    // Exactly the shape a state file written before this feature has.
    let state_path = state_with_mod(
        &game,
        r#"{"uid":"Celer","id":-64991831,"name":"Celer","version":"","filename":"Celer",
            "enabled":true,"installedAt":"2026-06-18T13:17:55Z","source":"modworkshop",
            "sha256":"b021ffae","updateStatus":"unknown"}"#,
    );

    let mut state = read_state(&state_path);
    assert_eq!(state.mods[0].identity, None);

    let cfg = engine_for_game("pd2").unwrap();
    let changed = ensure_identities(
        game.path().to_str().unwrap(),
        cfg,
        &state.folders,
        &mut state.mods,
        None,
    );
    assert!(changed);
    save_state(&state_path, &state);

    let reloaded = read_state(&state_path);
    let identity = reloaded.mods[0].identity.as_ref().unwrap();
    assert_eq!(identity.namespace, "pd2mods.z77.fr");
    assert_eq!(identity.key, "Celer");
    assert_eq!(reloaded.mods[0].uid, "Celer");
    assert_eq!(reloaded.mods[0].id, -64991831);
}

#[test]
fn an_identity_whose_namespace_was_still_a_key_prefix_still_loads() {
    let game = TempDir::new().unwrap();
    let state_path = state_with_mod(
        &game,
        r#"{"uid":"Celer","id":-1,"name":"Celer","version":"","filename":"Celer","enabled":true,
            "installedAt":"2026-06-18T13:17:55Z","source":"modworkshop",
            "identity":{"key":"github:vojin154/repo#Check For Wallbangs","evidence":"repository"}}"#,
    );

    let identity = read_state(&state_path).mods[0].identity.clone().unwrap();

    assert_eq!(identity.namespace, "github");
    assert_eq!(identity.key, "vojin154/repo#Check For Wallbangs");
}

#[test]
fn a_persisted_confidence_never_overrides_the_evidence_it_came_from() {
    let game = TempDir::new().unwrap();
    let state_path = state_with_mod(
        &game,
        r#"{"uid":"x","id":-1,"name":"x","version":"","filename":"x","enabled":true,
            "installedAt":"2026-06-18T13:17:55Z","source":"modworkshop",
            "identity":{"namespace":"local","key":"Better Bots@See readme",
                        "evidence":"nameAuthor","confidence":"exact"}}"#,
    );

    let identity = read_state(&state_path).mods[0].identity.clone().unwrap();

    assert_eq!(identity.confidence, IdentityConfidence::Candidate);
}
