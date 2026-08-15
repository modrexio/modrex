use sha2::Digest;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const INDEX_MANIFEST_URL: &str = "https://index.modrex.net/catalog/latest.json";
const INDEX_BASE_URL: &str = "https://index.modrex.net";

#[derive(serde::Deserialize)]
struct IndexManifest {
    games: HashMap<String, IndexGeneration>,
}

#[derive(serde::Deserialize)]
struct IndexGeneration {
    key: String,
    sha256: String,
    size: u64,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct IndexCacheEntry {
    sha256: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMatch {
    pub mod_remote_id: i64,
    pub mod_name: String,
    pub file_remote_id: i64,
    pub version: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexModFile {
    pub file_remote_id: i64,
    pub entry_name: String,
}

pub(crate) fn legacy_index_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to resolve app data dir")
        .join("mod-index.db")
}

pub fn index_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to resolve app data dir")
        .join("indexes")
}

pub fn index_path(app: &AppHandle, game_id: &str) -> PathBuf {
    index_dir(app).join(format!("{game_id}.db"))
}

fn index_cache_path(app: &AppHandle, game_id: &str) -> PathBuf {
    index_dir(app).join(format!("{game_id}.json"))
}

pub async fn ensure_index(app: AppHandle) {
    let games = crate::commands::settings::read_settings(&app)
        .games
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(game_id, settings)| {
            settings
                .game_path
                .as_deref()
                .filter(|path| Path::new(path).exists())
                .and_then(|_| crate::commands::games::game_spec(&game_id))
                .map(|spec| spec.id)
        })
        .collect::<Vec<_>>();
    let outcome = refresh_indexes(&app, &games).await;
    crate::commands::analytics::track(
        &app,
        "index_refresh",
        serde_json::json!({ "outcome": outcome }),
    );
}

async fn refresh_indexes(app: &AppHandle, games: &[&str]) -> &'static str {
    if games.is_empty() {
        return "not_configured";
    }

    let manifest = match crate::commands::api::http_client()
        .get(INDEX_MANIFEST_URL)
        .header("User-Agent", crate::commands::api::user_agent(app))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            match response.json::<IndexManifest>().await {
                Ok(manifest) => manifest,
                Err(error) => {
                    log::warn!("mod_index: manifest decode failed: {error}");
                    return "manifest_error";
                }
            }
        }
        Ok(response) => {
            log::warn!("mod_index: manifest failed: HTTP {}", response.status());
            return "manifest_error";
        }
        Err(error) => {
            log::warn!("mod_index: manifest request failed: {error}");
            return "network_error";
        }
    };

    let mut updated = false;
    for game_id in games {
        let Some(generation) = manifest.games.get(*game_id) else {
            log::warn!("mod_index: manifest omitted {game_id}");
            continue;
        };
        match refresh_game_index(app, game_id, generation).await {
            Ok(did_update) => updated |= did_update,
            Err(error) => log::warn!("mod_index: {game_id} refresh failed: {error}"),
        }
    }
    if updated {
        "updated"
    } else {
        "cached"
    }
}

async fn refresh_game_index(
    app: &AppHandle,
    game_id: &str,
    generation: &IndexGeneration,
) -> Result<bool, String> {
    if !generation.key.starts_with("catalog/")
        || !generation.key.ends_with(&format!("/{game_id}.db"))
    {
        return Err("invalid manifest key".to_string());
    }
    let path = index_path(app, game_id);
    let cache_path = index_cache_path(app, game_id);
    if path.exists()
        && std::fs::read(&cache_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<IndexCacheEntry>(&bytes).ok())
            .is_some_and(|cache| cache.sha256 == generation.sha256)
    {
        return Ok(false);
    }

    let url = format!("{INDEX_BASE_URL}/{}", generation.key);
    let response = crate::commands::api::http_client()
        .get(url)
        .header("User-Agent", crate::commands::api::user_agent(app))
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("download returned HTTP {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 != generation.size {
        return Err("download size did not match manifest".to_string());
    }
    let sha256 = hex::encode(sha2::Sha256::digest(&bytes));
    if sha256 != generation.sha256 {
        return Err("download SHA-256 did not match manifest".to_string());
    }

    std::fs::create_dir_all(index_dir(app)).map_err(|error| error.to_string())?;
    let temporary_path = path.with_extension("db.tmp");
    std::fs::write(&temporary_path, &bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary_path, &path).map_err(|error| error.to_string())?;
    let temporary_cache_path = cache_path.with_extension("json.tmp");
    std::fs::write(
        &temporary_cache_path,
        serde_json::to_vec(&IndexCacheEntry {
            sha256: generation.sha256.clone(),
        })
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    std::fs::rename(&temporary_cache_path, &cache_path).map_err(|error| error.to_string())?;
    Ok(true)
}

fn open_conn(path: &std::path::Path) -> Option<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// Opens the on-disk index once so a caller can run several queries against one connection
/// instead of reopening per lookup. Returns None when the index is absent.
pub(crate) fn open_index(app: &AppHandle, game_id: &str) -> Option<rusqlite::Connection> {
    let path = index_path(app, game_id);
    open_conn(&path).or_else(|| open_conn(&legacy_index_path(app)))
}

/// Returns true when the index contains at least one mod entry for the given game name.
/// Used to gate index-gated scanning: if the game isn't indexed yet, we can't reliably
/// distinguish framework modules from user mods, so we show everything instead of nothing.
pub(crate) fn has_game(conn: &rusqlite::Connection, game_name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM games WHERE name = ?1 LIMIT 1",
        rusqlite::params![game_name],
        |_| Ok(()),
    )
    .is_ok()
}

pub(crate) fn query_sha256(
    conn: &rusqlite::Connection,
    sha256: &str,
    game_name: &str,
) -> Option<IndexMatch> {
    conn.query_row(
        "SELECT m.remote_id, m.name, f.remote_id, f.version
         FROM files f
         JOIN mods m ON m.id = f.mod_id
         JOIN sources s ON s.id = m.source_id
         JOIN games g ON g.id = s.game_id
         WHERE f.sha256 = ?1 AND g.name = ?2
         LIMIT 1",
        rusqlite::params![sha256, game_name],
        |row| {
            Ok(IndexMatch {
                mod_remote_id: row.get(0)?,
                mod_name: row.get(1)?,
                file_remote_id: row.get(2)?,
                version: row.get(3)?,
            })
        },
    )
    .ok()
}

/// Resolves a modworkshop mod id to its name and current (latest indexed) file. Used to
/// enrich mods identified by an embedded AssetUpdates id. The index is append-only, so the
/// highest file id is the newest version.
pub(crate) fn query_mod_by_id(
    conn: &rusqlite::Connection,
    mod_remote_id: i64,
    game_name: &str,
) -> Option<IndexMatch> {
    conn.query_row(
        "SELECT m.remote_id, m.name, f.remote_id, f.version
         FROM files f
         JOIN mods m ON m.id = f.mod_id
         JOIN sources s ON s.id = m.source_id
         JOIN games g ON g.id = s.game_id
         WHERE m.remote_id = ?1 AND g.name = ?2
         ORDER BY f.id DESC
         LIMIT 1",
        rusqlite::params![mod_remote_id, game_name],
        |row| {
            Ok(IndexMatch {
                mod_remote_id: row.get(0)?,
                mod_name: row.get(1)?,
                file_remote_id: row.get(2)?,
                version: row.get(3)?,
            })
        },
    )
    .ok()
}

/// Whether needle sits in haystack without either end landing inside a word. LIKE has no
/// notion of a word, so "Bag Contour" matches the mod "Blue Bodybag Contour" and a real
/// PAYDAY 2 mod gets handed a stranger's identity. Partial matches themselves are wanted and
/// common ("Useful Bots" is published as "Useful Bots: Future Edition"), so the boundary is
/// what separates a shortened title from an accidental substring.
fn matches_at_word_boundary(needle: &str, haystack: &str) -> bool {
    let needle = needle.to_lowercase();
    let haystack = haystack.to_lowercase();
    if needle.is_empty() {
        return false;
    }
    let wordish = |c: char| c.is_alphanumeric();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(&needle) {
        let at = from + rel;
        let before = haystack[..at].chars().next_back();
        let after = haystack[at + needle.len()..].chars().next();
        if !before.is_some_and(wordish) && !after.is_some_and(wordish) {
            return true;
        }
        from = at + 1;
    }
    false
}

pub(crate) fn query_by_name(
    conn: &rusqlite::Connection,
    name: &str,
    game_name: &str,
) -> Option<i64> {
    // Escape LIKE metacharacters so a mod name that literally contains % or _ matches as
    // itself instead of as a wildcard. Escape the backslash first, or it would double-escape
    // the escapes added for % and _ on the following lines.
    let escaped = name
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{}%", escaped);
    // Join files so a name resolves only to a mod that actually has indexed content: a mod
    // with no files cannot be the source of an installed pak. DISTINCT collapses the one row
    // per file the join would otherwise produce, so a many-file mod still reads as a single
    // match instead of tripping the ambiguity guard below.
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT m.remote_id, m.name FROM mods m
             JOIN files f ON f.mod_id = m.id
             JOIN sources s ON s.id = m.source_id
             JOIN games g ON g.id = s.game_id
             WHERE m.name LIKE ?1 ESCAPE '\\' AND g.name = ?2
             LIMIT 2",
        )
        .ok()?;
    let rows: Vec<(i64, String)> = stmt
        .query_map(rusqlite::params![pattern, game_name], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .ok()?
        .filter_map(|r| r.ok())
        .collect();
    // The boundary check only ever removes the single surviving candidate, never picks between
    // several: an ambiguous set stays ambiguous, so this cannot resolve a name onto a mod that
    // the ambiguity guard was already refusing.
    let [(remote_id, matched_name)] = rows.as_slice() else {
        return None;
    };
    matches_at_word_boundary(name, matched_name).then_some(*remote_id)
}

fn query_mod_files(
    conn: &rusqlite::Connection,
    mod_remote_id: i64,
    game_name: &str,
) -> Vec<IndexModFile> {
    let mut stmt = match conn.prepare(
        "SELECT f.remote_id, f.entry_name
         FROM files f
         JOIN mods m ON m.id = f.mod_id
         JOIN sources s ON s.id = m.source_id
         JOIN games g ON g.id = s.game_id
         WHERE m.remote_id = ?1 AND g.name = ?2 AND f.entry_name != ''
         ORDER BY f.id",
    ) {
        Ok(s) => s,
        // An index predating the entry_name column, still reachable through the legacy
        // fallback in open_index.
        Err(_) => return Vec::new(),
    };
    stmt.query_map(rusqlite::params![mod_remote_id, game_name], |row| {
        Ok(IndexModFile {
            file_remote_id: row.get(0)?,
            entry_name: row.get(1)?,
        })
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

pub fn lookup_mod_files(
    app: &AppHandle,
    mod_remote_id: i64,
    game_id: &str,
    game_name: &str,
) -> Vec<IndexModFile> {
    match open_index(app, game_id) {
        Some(conn) => query_mod_files(&conn, mod_remote_id, game_name),
        None => Vec::new(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_index_mod_files(
    app: AppHandle,
    mod_id: i64,
    game_id: String,
) -> Result<Vec<IndexModFile>, String> {
    let cfg = crate::commands::mods::engine_for_game(game_id.as_str())?;
    Ok(lookup_mod_files(
        &app,
        mod_id,
        cfg.game_id,
        cfg.index_game_name,
    ))
}

pub fn lookup_sha256(
    app: &AppHandle,
    sha256: &str,
    game_id: &str,
    game_name: &str,
) -> Option<IndexMatch> {
    let conn = open_index(app, game_id)?;
    query_sha256(&conn, sha256, game_name)
}

#[cfg(test)]
#[path = "mod_index_tests.rs"]
mod tests;
