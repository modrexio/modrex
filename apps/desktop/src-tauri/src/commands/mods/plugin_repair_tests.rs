use super::*;
use crate::commands::mods::engine_for_game;

/// Entries as the published snapshot records them for PAYDAY 3. Custom Ping and Reimu ship
/// only as plugins, Beta HUD has a plugin file and an older loose pak file, and one container
/// was published both inside a plugin and as a loose pak by the same mod.
fn index() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE sources (id INTEGER PRIMARY KEY, game_id INTEGER);
        CREATE TABLE mods (id INTEGER PRIMARY KEY, source_id INTEGER, remote_id INTEGER, name TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY, mod_id INTEGER, remote_id INTEGER, sha256 TEXT, version TEXT, entry_name TEXT NOT NULL DEFAULT '');
        INSERT INTO games VALUES (1, 'PAYDAY 3');
        INSERT INTO sources VALUES (1, 1);
        INSERT INTO mods VALUES (1, 1, 59527, 'Custom Ping');
        INSERT INTO mods VALUES (2, 1, 49074, '[PDML] Reimu Hakurei replaces Clover');
        INSERT INTO mods VALUES (3, 1, 46399, 'Beta HUD');
        INSERT INTO mods VALUES (4, 1, 70000, 'Shared Container');
        INSERT INTO mods VALUES (5, 1, 59255, 'PAYDAY 3 MOD LOADER');
        INSERT INTO files VALUES (1, 1, 104639, 'ping-pak', '1.0.0', 'Content/Paks/Windows/CustomPing_P.pak');
        INSERT INTO files VALUES (2, 1, 104639, 'ping-utoc', '1.0.0', 'Content/Paks/Windows/CustomPing_P.utoc');
        INSERT INTO files VALUES (3, 2, 104617, 'reimu-old', '2.0.0', 'Content/Paks/Windows/HakureiReimuV5_P.pak');
        INSERT INTO files VALUES (4, 3, 104605, 'hud-plugin', '3.0.0', 'Content/Paks/Windows/BetaHUD_P.pak');
        INSERT INTO files VALUES (5, 3, 95507, 'hud-loose', '2.0.3', '46399_113369_x.pak');
        INSERT INTO files VALUES (6, 4, 800, 'shared', '1.0', 'Content/Paks/Windows/Shared_P.pak');
        INSERT INTO files VALUES (7, 4, 801, 'shared', '1.0', 'Shared_P.pak');
        INSERT INTO files VALUES (8, 5, 104449, 'pdml-010', '0.1.0', 'Content/Paks/Windows/PDML_P.pak');
        INSERT INTO files VALUES (9, 5, 104861, 'pdml-012', '0.1.2', 'Content/Paks/Windows/PDML_P.utoc');
        INSERT INTO files VALUES (10, 5, 104900, 'pdml-other', '0.2.0', 'Content/Paks/Windows/PDMLExtras_P.pak');
        ",
    )
    .unwrap();
    conn
}

fn pak(uid: &str, file_id: Option<i64>, sha256: &str) -> InstalledMod {
    InstalledMod {
        uid: uid.to_string(),
        filename: format!("{uid}.pak"),
        file_id,
        sha256: Some(sha256.to_string()),
        ..InstalledMod::default()
    }
}

fn found(mods: &[InstalledMod]) -> Vec<MisplacedPlugin> {
    misplaced_plugins(engine_for_game("pd3").unwrap(), mods, &index()).unwrap()
}

#[test]
fn paks_from_one_plugin_download_are_one_repair() {
    let result = found(&[
        pak("104639_CustomPing_P", Some(104639), "ping-pak"),
        pak("104639_CustomPing_P_gdk", Some(104639), "ping-pak"),
    ]);
    assert_eq!(
        result,
        vec![MisplacedPlugin {
            mod_id: 59527,
            file_id: 104639,
            name: "Custom Ping".to_string(),
            uids: vec![
                "104639_CustomPing_P".to_string(),
                "104639_CustomPing_P_gdk".to_string()
            ],
        }]
    );
}

#[test]
fn bytes_from_an_older_plugin_release_still_point_at_that_release() {
    let result = found(&[pak("hand-copied", None, "reimu-old")]);
    assert_eq!(result.len(), 1);
    assert_eq!((result[0].mod_id, result[0].file_id), (49074, 104617));
}

#[test]
fn a_misplaced_release_is_repaired_with_the_newest_release_of_the_same_plugin() {
    let result = found(&[pak("104449_PDML_P", Some(104449), "pdml-010")]);
    assert_eq!(result.len(), 1);
    assert_eq!((result[0].mod_id, result[0].file_id), (59255, 104861));
}

#[test]
fn a_pak_installed_from_a_loose_pak_file_is_where_it_belongs() {
    assert!(found(&[pak("95507", Some(95507), "hud-loose")]).is_empty());
}

#[test]
fn the_installed_file_decides_over_bytes_published_both_ways() {
    assert!(found(&[pak("801", Some(801), "shared")]).is_empty());
    assert!(found(&[pak("copied", None, "shared")]).is_empty());
    assert_eq!(found(&[pak("800", Some(800), "shared")]).len(), 1);
}

#[test]
fn a_record_from_another_source_is_never_repaired_from_modworkshop() {
    let nexus = InstalledMod {
        source: "nexus".to_string(),
        ..pak("nexus:197:842", Some(842), "ping-pak")
    };
    assert!(found(&[nexus]).is_empty());
}

#[test]
fn a_plugin_already_in_the_plugin_folder_is_left_alone() {
    let installed = InstalledMod {
        location: Some("plugins".to_string()),
        ..pak("104639", Some(104639), "ping-utoc")
    };
    assert!(found(&[installed]).is_empty());
}

#[test]
fn a_game_without_a_plugin_folder_has_nothing_to_repair() {
    let result = misplaced_plugins(
        engine_for_game("cb").unwrap(),
        &[pak("104639_CustomPing_P", Some(104639), "ping-pak")],
        &index(),
    )
    .unwrap();
    assert!(result.is_empty());
}
