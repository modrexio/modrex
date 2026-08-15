use super::*;

fn setup_db() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("
        CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE sources (id INTEGER PRIMARY KEY, game_id INTEGER);
        CREATE TABLE mods (id INTEGER PRIMARY KEY, source_id INTEGER, remote_id INTEGER, name TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY, mod_id INTEGER, remote_id INTEGER, sha256 TEXT, version TEXT, entry_name TEXT NOT NULL DEFAULT '');

        INSERT INTO games VALUES (1, 'PAYDAY 3');
        INSERT INTO games VALUES (2, 'PAYDAY 2');
        INSERT INTO sources VALUES (1, 1);
        INSERT INTO sources VALUES (2, 2);
        INSERT INTO mods VALUES (1, 1, 100, 'CSA-39 Assault Rifle');
        INSERT INTO mods VALUES (2, 1, 200, 'Dark Matter Skins');
        INSERT INTO mods VALUES (3, 2, 300, 'Better Crosshair Customizer (+customfov)');
        INSERT INTO files VALUES (1, 1, 500, 'aabbcc', '1.0.0', 'csa39.pak');
        INSERT INTO files VALUES (2, 2, 600, 'ddeeff', '2.0.0', 'DarkMatterSkins/zDarkMatter_AG-9.pak');
        INSERT INTO files VALUES (3, 3, 700, 'ff1122', '1.5.0', '');
        INSERT INTO files VALUES (4, 2, 600, '112233', '2.0.0', 'DarkMatterSkins/zDarkMatter_Bison.pak');
        INSERT INTO files VALUES (5, 2, 600, '445566', '2.0.0', '');
    ").unwrap();
    conn
}

// ── query_sha256 ──────────────────────────────────────────────────────────

#[test]
fn sha256_known_hash_returns_match() {
    let conn = setup_db();
    let result = query_sha256(&conn, "aabbcc", "PAYDAY 3").unwrap();
    assert_eq!(result.mod_remote_id, 100);
    assert_eq!(result.mod_name, "CSA-39 Assault Rifle");
    assert_eq!(result.file_remote_id, 500);
    assert_eq!(result.version, "1.0.0");
}

#[test]
fn sha256_unknown_hash_returns_none() {
    let conn = setup_db();
    assert!(query_sha256(&conn, "000000", "PAYDAY 3").is_none());
}

#[test]
fn sha256_wrong_game_returns_none() {
    let conn = setup_db();
    // "aabbcc" is a PD3 file, so it must not match when querying PD2.
    assert!(query_sha256(&conn, "aabbcc", "PAYDAY 2").is_none());
}

#[test]
fn sha256_pd2_hash_returns_pd2_match() {
    let conn = setup_db();
    let result = query_sha256(&conn, "ff1122", "PAYDAY 2").unwrap();
    assert_eq!(result.mod_remote_id, 300);
}

// ── query_by_name ─────────────────────────────────────────────────────────

#[test]
fn by_name_exact_unique_match_returns_id() {
    let conn = setup_db();
    assert_eq!(
        query_by_name(&conn, "CSA-39 Assault Rifle", "PAYDAY 3"),
        Some(100)
    );
}

#[test]
fn by_name_partial_unique_match_returns_id() {
    let conn = setup_db();
    assert_eq!(query_by_name(&conn, "CSA-39", "PAYDAY 3"), Some(100));
}

#[test]
fn by_name_no_match_returns_none() {
    let conn = setup_db();
    assert!(query_by_name(&conn, "nonexistent mod", "PAYDAY 3").is_none());
}

#[test]
fn by_name_ambiguous_two_matches_returns_none() {
    let conn = setup_db();
    // Both PD3 mod names contain "a", so the match is ambiguous within PAYDAY 3.
    assert!(query_by_name(&conn, "a", "PAYDAY 3").is_none());
}

#[test]
fn by_name_wrong_game_returns_none() {
    let conn = setup_db();
    // "Better Crosshair" exists only in PD2, so it must not match when querying PD3.
    assert!(query_by_name(&conn, "Better Crosshair", "PAYDAY 3").is_none());
}

#[test]
fn by_name_pd2_mod_matches_in_pd2() {
    let conn = setup_db();
    assert_eq!(
        query_by_name(&conn, "Better Crosshair", "PAYDAY 2"),
        Some(300)
    );
}

#[test]
fn by_name_unique_match_with_multiple_files_returns_id() {
    let conn = setup_db();
    // "Dark Matter Skins" (remote 200) has three file rows. The files join must not turn a
    // single multi-file mod into a false ambiguity: DISTINCT collapses it back to one match.
    assert_eq!(query_by_name(&conn, "Dark Matter", "PAYDAY 3"), Some(200));
}

#[test]
fn by_name_escapes_like_wildcards() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("
        CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE sources (id INTEGER PRIMARY KEY, game_id INTEGER);
        CREATE TABLE mods (id INTEGER PRIMARY KEY, source_id INTEGER, remote_id INTEGER, name TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY, mod_id INTEGER, remote_id INTEGER, sha256 TEXT, version TEXT, entry_name TEXT NOT NULL DEFAULT '');
        INSERT INTO games VALUES (2, 'PAYDAY 2');
        INSERT INTO sources VALUES (2, 2);
        INSERT INTO mods VALUES (1, 2, 111, 'Ammo_Pickup');
        INSERT INTO mods VALUES (2, 2, 222, 'AmmoXPickup');
        INSERT INTO mods VALUES (3, 2, 333, '50% Off');
        INSERT INTO mods VALUES (4, 2, 444, '5000 Off Deluxe');
        INSERT INTO files VALUES (1, 1, 501, 'h1', '1.0', '');
        INSERT INTO files VALUES (2, 2, 502, 'h2', '1.0', '');
        INSERT INTO files VALUES (3, 3, 503, 'h3', '1.0', '');
        INSERT INTO files VALUES (4, 4, 504, 'h4', '1.0', '');
    ").unwrap();
    // A name carrying a LIKE metacharacter must match literally, not as a wildcard: without
    // escaping, "Ammo_Pickup" also matches "AmmoXPickup" (the _ standing in for any char) and
    // "50% Off" also matches "5000 Off Deluxe", so a real unique mod would read as ambiguous
    // and resolve to nothing.
    assert_eq!(query_by_name(&conn, "Ammo_Pickup", "PAYDAY 2"), Some(111));
    assert_eq!(query_by_name(&conn, "50% Off", "PAYDAY 2"), Some(333));
}

fn word_boundary_db() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("
        CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE sources (id INTEGER PRIMARY KEY, game_id INTEGER);
        CREATE TABLE mods (id INTEGER PRIMARY KEY, source_id INTEGER, remote_id INTEGER, name TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY, mod_id INTEGER, remote_id INTEGER, sha256 TEXT, version TEXT, entry_name TEXT NOT NULL DEFAULT '');
        INSERT INTO games VALUES (2, 'PAYDAY 2');
        INSERT INTO sources VALUES (2, 2);
        INSERT INTO mods VALUES (1, 2, 18504, 'Blue Bodybag Contour');
        INSERT INTO mods VALUES (2, 2, 38390, 'Useful Bots: Future Edition');
        INSERT INTO mods VALUES (3, 2, 39694, 'Show Ammo Pickup Amount in HUD');
        INSERT INTO files VALUES (1, 1, 501, 'h1', '1.0', '');
        INSERT INTO files VALUES (2, 2, 502, 'h2', '1.0', '');
        INSERT INTO files VALUES (3, 3, 503, 'h3', '1.0', '');
    ").unwrap();
    conn
}

#[test]
fn by_name_rejects_a_match_that_starts_inside_a_word() {
    let conn = word_boundary_db();
    // The real case: a folder named "Bag Contour" (TdlQ's mod, not on ModWorkshop) is the
    // tail of "Blue Bodybag Contour", so LIKE alone hands it a stranger's identity.
    assert_eq!(query_by_name(&conn, "Bag Contour", "PAYDAY 2"), None);
}

#[test]
fn by_name_keeps_partial_matches_that_fall_on_word_boundaries() {
    let conn = word_boundary_db();
    // Both are real: authors publish under a longer title than the folder they ship.
    assert_eq!(query_by_name(&conn, "Useful Bots", "PAYDAY 2"), Some(38390));
    assert_eq!(
        query_by_name(&conn, "Ammo Pickup Amount in HUD", "PAYDAY 2"),
        Some(39694)
    );
}

// ── query_mod_files ───────────────────────────────────────────────────────

#[test]
fn mod_files_returns_named_entries_in_id_order() {
    let conn = setup_db();
    let result = query_mod_files(&conn, 200, "PAYDAY 3");
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].file_remote_id, 600);
    assert_eq!(result[0].entry_name, "DarkMatterSkins/zDarkMatter_AG-9.pak");
    assert_eq!(
        result[1].entry_name,
        "DarkMatterSkins/zDarkMatter_Bison.pak"
    );
}

#[test]
fn mod_files_excludes_rows_without_entry_name() {
    let conn = setup_db();
    // mod 300's only row predates the entry_name column (empty)
    assert!(query_mod_files(&conn, 300, "PAYDAY 2").is_empty());
}

#[test]
fn mod_files_wrong_game_returns_empty() {
    let conn = setup_db();
    assert!(query_mod_files(&conn, 200, "PAYDAY 2").is_empty());
}

#[test]
fn mod_files_unknown_mod_returns_empty() {
    let conn = setup_db();
    assert!(query_mod_files(&conn, 999, "PAYDAY 3").is_empty());
}

#[test]
fn mod_files_old_schema_without_column_returns_empty() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("
        CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE sources (id INTEGER PRIMARY KEY, game_id INTEGER);
        CREATE TABLE mods (id INTEGER PRIMARY KEY, source_id INTEGER, remote_id INTEGER, name TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY, mod_id INTEGER, remote_id INTEGER, sha256 TEXT, version TEXT);
        INSERT INTO games VALUES (1, 'PAYDAY 3');
        INSERT INTO sources VALUES (1, 1);
        INSERT INTO mods VALUES (1, 1, 100, 'CSA-39 Assault Rifle');
        INSERT INTO files VALUES (1, 1, 500, 'aabbcc', '1.0.0');
    ").unwrap();
    assert!(query_mod_files(&conn, 100, "PAYDAY 3").is_empty());
}

// ── query_mod_by_id ────────────────────────────────────────────────────────

#[test]
fn mod_by_id_returns_name_and_current_file() {
    let conn = setup_db();
    let m = query_mod_by_id(&conn, 100, "PAYDAY 3").unwrap();
    assert_eq!(m.mod_remote_id, 100);
    assert_eq!(m.mod_name, "CSA-39 Assault Rifle");
    assert_eq!(m.file_remote_id, 500);
    assert_eq!(m.version, "1.0.0");
}

#[test]
fn mod_by_id_is_scoped_by_game() {
    let conn = setup_db();
    // remote_id 100 is a PD3 mod, so it must miss under PD2.
    assert!(query_mod_by_id(&conn, 100, "PAYDAY 2").is_none());
    assert_eq!(
        query_mod_by_id(&conn, 300, "PAYDAY 2")
            .unwrap()
            .mod_remote_id,
        300
    );
}

#[test]
fn mod_by_id_unknown_returns_none() {
    let conn = setup_db();
    assert!(query_mod_by_id(&conn, 999, "PAYDAY 3").is_none());
}

#[test]
fn mod_by_id_picks_newest_file() {
    // The index is append-only: an updated mod keeps old file rows. The newest (highest
    // file id) must win, so update detection compares against the current version.
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE sources (id INTEGER PRIMARY KEY, game_id INTEGER);
        CREATE TABLE mods (id INTEGER PRIMARY KEY, source_id INTEGER, remote_id INTEGER, name TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY, mod_id INTEGER, remote_id INTEGER, sha256 TEXT, version TEXT, entry_name TEXT NOT NULL DEFAULT '');
        INSERT INTO games VALUES (2, 'PAYDAY 2');
        INSERT INTO sources VALUES (2, 2);
        INSERT INTO mods VALUES (1, 2, 39694, 'Ammo Pickup Amount in HUD');
        INSERT INTO files VALUES (1, 1, 800, 'old', '1.0.0', 'm/mod.txt');
        INSERT INTO files VALUES (2, 1, 900, 'new', '1.1.0', 'm/mod.txt');
    ",
    )
    .unwrap();
    let m = query_mod_by_id(&conn, 39694, "PAYDAY 2").unwrap();
    assert_eq!(m.file_remote_id, 900);
    assert_eq!(m.version, "1.1.0");
}
