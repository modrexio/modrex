use super::*;

fn catalog() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE games (id INTEGER, name TEXT);
         CREATE TABLE sources (id INTEGER, game_id INTEGER, name TEXT);
         CREATE TABLE mods (id INTEGER, source_id INTEGER, remote_id INTEGER, name TEXT);
         CREATE TABLE resource_entries (
            mod_id INTEGER, observation_id INTEGER, download_kind TEXT,
            download_remote_id INTEGER, version TEXT, source_filename TEXT,
            entry_name TEXT, sha256 TEXT, resource_kind TEXT, byte_length INTEGER,
            detected_format TEXT, validation_status TEXT
         );
         INSERT INTO games VALUES (1, 'PAYDAY 3'), (2, 'Crime Boss: Rockay City');
         INSERT INTO sources VALUES (1, 1, 'modworkshop'), (2, 2, 'modworkshop'), (3, 1, 'nexus');
         INSERT INTO mods VALUES (1, 1, 43903, 'Skip startup'), (2, 2, 47773, 'Skip intro'), (3, 3, 43903, 'Other project');
         INSERT INTO resource_entries VALUES
         (1, 1, 'file', 67497, '1', 'SkipStartup.rar', 'StartUp_SBZ.bk2', 'abc', 'movie', 4364, 'bink1', 'valid'),
         (1, 1, 'file', 67497, '1', 'SkipStartup.rar', 'StartUp_Unreal.bk2', 'abc', 'movie', 4364, 'bink1', 'valid'),
         (1, 2, 'file', 67498, '2', 'SkipStartup.rar', 'StartUp_SBZ.bk2', 'abc', 'movie', 4364, 'bink1', 'valid'),
         (2, 3, 'file', 74833, '1', 'SkipIntro.zip', 'UE4_Logo.bk2', 'abc', 'movie', 4364, 'bink1', 'valid'),
         (1, 4, 'file', 89501, '1', 'potato.rar', 'Engine.ini', 'empty', 'config', 0, 'empty', 'unsupported');",
    ).unwrap();
    conn
}

#[test]
fn repeated_names_and_historical_versions_survive_exact_recognition() {
    let result = query_resource_hash(&catalog(), "abc", "PAYDAY 3", ResourceKind::Movie).unwrap();
    let ResourceRecognition::Matched {
        mod_remote_id,
        entries,
        ..
    } = result
    else {
        panic!("Expected exact match");
    };
    assert_eq!(mod_remote_id, 43903);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[1].entry_name, "StartUp_Unreal.bk2");
    assert_eq!(entries[2].version, "2");
}

#[test]
fn resource_hash_is_scoped_to_game_and_advertised_kind() {
    assert!(matches!(
        query_resource_hash(&catalog(), "abc", "PAYDAY 3", ResourceKind::Config).unwrap(),
        ResourceRecognition::NoMatch
    ));
    let ResourceRecognition::Matched { mod_remote_id, .. } = query_resource_hash(
        &catalog(),
        "abc",
        "Crime Boss: Rockay City",
        ResourceKind::Movie,
    )
    .unwrap() else {
        panic!("Expected CB match");
    };
    assert_eq!(mod_remote_id, 47773);
}

#[test]
fn same_remote_id_in_another_source_is_ambiguous() {
    let conn = catalog();
    conn.execute("INSERT INTO resource_entries SELECT 3, 5, download_kind, download_remote_id, version, source_filename, entry_name, sha256, resource_kind, byte_length, detected_format, validation_status FROM resource_entries WHERE observation_id=2", []).unwrap();
    assert!(matches!(
        query_resource_hash(&conn, "abc", "PAYDAY 3", ResourceKind::Movie).unwrap(),
        ResourceRecognition::Ambiguous
    ));
}

#[test]
fn unsupported_bytes_can_be_recognized_without_install_authority() {
    let ResourceRecognition::Matched { entries, .. } =
        query_resource_hash(&catalog(), "empty", "PAYDAY 3", ResourceKind::Config).unwrap()
    else {
        panic!("Expected recorded bytes");
    };
    assert_eq!(entries[0].validation_status, "unsupported");
}

#[test]
fn old_schema_is_unavailable_but_broken_new_schema_is_an_error() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    assert!(matches!(
        query_resource_hash(&conn, "abc", "PAYDAY 3", ResourceKind::Movie).unwrap(),
        ResourceRecognition::Unavailable
    ));
    conn.execute("CREATE TABLE resource_entries (sha256 TEXT)", [])
        .unwrap();
    assert!(query_resource_hash(&conn, "abc", "PAYDAY 3", ResourceKind::Movie).is_err());
}
