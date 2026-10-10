use super::*;

fn catalog() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE games (id INTEGER, name TEXT);
         CREATE TABLE sources (id INTEGER, game_id INTEGER, name TEXT);
         CREATE TABLE mods (id INTEGER, source_id INTEGER, remote_id INTEGER, name TEXT);
         CREATE TABLE resource_entries (
            mod_id INTEGER, sha256 TEXT, resource_kind TEXT, byte_length INTEGER
         );
         INSERT INTO games VALUES (1, 'PAYDAY 3'), (2, 'Crime Boss: Rockay City');
         INSERT INTO sources VALUES (1, 1, 'modworkshop'), (2, 2, 'modworkshop'), (3, 1, 'nexus');
         INSERT INTO mods VALUES (1, 1, 43903, 'Skip startup'), (2, 2, 47773, 'Skip intro'), (3, 3, 43903, 'Other project');
         INSERT INTO resource_entries VALUES
         (1, 'abc', 'movie', 4364),
         (2, 'abc', 'movie', 4364),
         (1, 'config-only', 'config', 0);",
    ).unwrap();
    conn
}

#[test]
fn legacy_duplicate_observations_identify_one_project() {
    let conn = catalog();
    conn.execute_batch(
        "ALTER TABLE resource_entries ADD COLUMN entry_name TEXT;
         ALTER TABLE resource_entries ADD COLUMN version TEXT;
         INSERT INTO resource_entries VALUES (1, 'abc', 'movie', 4364, 'Other.bk2', '2');",
    )
    .unwrap();
    let result = query_movie_hash(&conn, "abc", "PAYDAY 3").unwrap();
    let ResourceRecognition::Matched {
        mod_remote_id,
        mod_name,
        ..
    } = result
    else {
        panic!("Expected exact match");
    };
    assert_eq!(mod_remote_id, 43903);
    assert_eq!(mod_name, "Skip startup");
}

#[test]
fn movie_hash_is_scoped_to_game_and_excludes_configs() {
    assert!(matches!(
        query_movie_hash(&catalog(), "config-only", "PAYDAY 3").unwrap(),
        ResourceRecognition::NoMatch
    ));
    let ResourceRecognition::Matched { mod_remote_id, .. } =
        query_movie_hash(&catalog(), "abc", "Crime Boss: Rockay City").unwrap()
    else {
        panic!("Expected CB match");
    };
    assert_eq!(mod_remote_id, 47773);
}

#[test]
fn same_remote_id_in_another_source_is_ambiguous() {
    let conn = catalog();
    conn.execute(
        "INSERT INTO resource_entries VALUES (3, 'abc', 'movie', 4364)",
        [],
    )
    .unwrap();
    assert!(matches!(
        query_movie_hash(&conn, "abc", "PAYDAY 3").unwrap(),
        ResourceRecognition::Ambiguous
    ));
}

#[test]
fn old_schema_is_unavailable_but_broken_new_schema_is_an_error() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    assert!(matches!(
        query_movie_hash(&conn, "abc", "PAYDAY 3").unwrap(),
        ResourceRecognition::Unavailable
    ));
    conn.execute("CREATE TABLE resource_entries (sha256 TEXT)", [])
        .unwrap();
    assert!(query_movie_hash(&conn, "abc", "PAYDAY 3").is_err());
}
