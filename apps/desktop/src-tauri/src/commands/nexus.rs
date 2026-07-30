// REST v1's listing endpoints (updated/latest_added/trending) have no
// free-text search; real search goes through the GraphQL v2 mods query
// instead (api.nexusmods.com/v2/graphql, verified live via introspection).

use reqwest::header::HeaderMap;
use serde_json::Value;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

use crate::commands::api::{http_client, parse_remaining_header, user_agent, TokenBucket};
use crate::commands::nexus_oauth;
use crate::commands::sources;

const BASE: &str = "https://api.nexusmods.com/v1";
const GRAPHQL_BASE: &str = "https://api.nexusmods.com/v2/graphql";

// Nexus reports quota per-request via X-RL-Hourly-Remaining, undocumented
// but observed live. No confirmed steady rate exists ahead of time, so this
// bucket starts conservative and the low-remaining pause below is what
// actually protects the budget once real headers come back.
const RATE_BURST: f64 = 2.0;
const RATE_PER_SEC: f64 = 0.5;

static RATE_REMAINING: AtomicI64 = AtomicI64::new(-1);
const LOW_REMAINING_THRESHOLD: i64 = 5;
const LOW_REMAINING_PAUSE: Duration = Duration::from_secs(5);

fn parse_hourly_remaining(headers: &HeaderMap) -> Option<i64> {
    parse_remaining_header(headers, "x-rl-hourly-remaining")
}

static RATE_LIMITER: OnceLock<Mutex<TokenBucket>> = OnceLock::new();

fn rate_limiter() -> &'static Mutex<TokenBucket> {
    RATE_LIMITER.get_or_init(|| Mutex::new(TokenBucket::new(RATE_BURST, RATE_PER_SEC)))
}

// Which games Nexus serves, and the domain slug it knows each by, live in the source
// registry. An unsupported id is a real error, not a silent fallback to a default game.
pub(crate) fn nexus_domain(game_id: &str) -> Result<&'static str, String> {
    sources::native_id("nexus", game_id)
        .ok_or_else(|| format!("nexus: no game domain mapping for '{game_id}'"))
}

// Reverse of nexus_domain, for nxm:// links where Nexus hands us its own
// domain and we need the internal game_id to route the download.
pub(crate) fn game_id_for_domain(domain: &str) -> Result<&'static str, String> {
    sources::game_id_for_native("nexus", domain)
        .ok_or_else(|| format!("nexus: no game id mapping for domain '{domain}'"))
}

// The GraphQL content API filters on Nexus's numeric game id, a different id than
// the domain slug nexus_domain returns. Both name the same game.
pub(crate) fn nexus_numeric_game_id(game_id: &str) -> Result<u32, String> {
    sources::source_spec("nexus")
        .and_then(|s| s.games.iter().find(|g| g.game_id == game_id))
        .and_then(|g| g.numeric_id)
        .ok_or_else(|| format!("nexus: no numeric game id for '{game_id}'"))
}

async fn nexus_headers(app: &AppHandle) -> Result<Vec<(&'static str, String)>, String> {
    let token = nexus_oauth::access_token(app).await?;
    Ok(vec![
        ("Authorization", format!("Bearer {token}")),
        ("User-Agent", user_agent(app)),
        ("Application-Name", "Modrex".to_string()),
        (
            "Application-Version",
            app.package_info().version.to_string(),
        ),
    ])
}

// Shared retry/rate-limit loop for both the REST GET client and the GraphQL
// POST client below, build re-creates the request fresh each attempt
// since a sent RequestBuilder can't be replayed. label is only for errors.
async fn send_with_retry(
    label: &str,
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<Value, String> {
    for attempt in 0u64..3 {
        let wait = rate_limiter()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .consume();
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }

        let remaining = RATE_REMAINING.load(Ordering::Relaxed);
        if (0..=LOW_REMAINING_THRESHOLD).contains(&remaining) {
            tokio::time::sleep(LOW_REMAINING_PAUSE).await;
        }

        let res = build()
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if let Some(remaining) = parse_hourly_remaining(res.headers()) {
            RATE_REMAINING.store(remaining, Ordering::Relaxed);
        }

        if res.status() == 429 {
            let base_ms = 1000u64 << attempt.min(3);
            tokio::time::sleep(Duration::from_millis(base_ms)).await;
            continue;
        }

        if res.status() == 403 {
            return Err(
                "nexus: 403 — this endpoint may require Premium, or the credentials are invalid"
                    .to_string(),
            );
        }

        if !res.status().is_success() {
            return Err(format!("nexus API {}: {label}", res.status()));
        }
        return res.json().await.map_err(|e| e.to_string());
    }

    Err(format!("nexus API 429: {label}"))
}

async fn nexus_get(
    app: &AppHandle,
    path: &str,
    query: Vec<(&str, String)>,
) -> Result<Value, String> {
    let mut url = reqwest::Url::parse(&format!("{BASE}{path}")).map_err(|e| e.to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in &query {
            pairs.append_pair(k, v);
        }
    }
    let headers = nexus_headers(app).await?;

    send_with_retry(path, || {
        let mut req = http_client()
            .get(url.clone())
            .header("Accept", "application/json");
        for (k, v) in &headers {
            req = req.header(*k, v);
        }
        req
    })
    .await
}

pub(crate) async fn nexus_get_mod(
    app: AppHandle,
    game_id: String,
    mod_id: u32,
) -> Result<Value, String> {
    let domain = nexus_domain(&game_id)?;
    nexus_get(&app, &format!("/games/{domain}/mods/{mod_id}.json"), vec![]).await
}

// Renderer-facing detail fetch for the Nexus mod detail page. Reuses the same
// pub(crate) nexus_get_mod the nxm flow already calls. Only the parse into the
// neutral ModDetail shape is new.
#[tauri::command]
#[specta::specta]
pub async fn nexus_get_mod_detail(
    app: AppHandle,
    game_id: String,
    mod_id: u32,
) -> Result<crate::commands::domain::ModDetail, String> {
    let value = nexus_get_mod(app, game_id, mod_id).await?;
    crate::commands::domain::parse_nexus_detail(value)
}

// Renderer-facing file list for the Nexus mod detail page's Downloads tab. Same
// pub(crate) nexus_get the search/detail calls already use.
#[tauri::command]
#[specta::specta]
pub async fn nexus_list_mod_files(
    app: AppHandle,
    game_id: String,
    mod_id: u32,
) -> Result<crate::commands::domain::FilePage, String> {
    let domain = nexus_domain(&game_id)?;
    let value = nexus_get(
        &app,
        &format!("/games/{domain}/mods/{mod_id}/files.json"),
        vec![],
    )
    .await?;
    crate::commands::domain::parse_nexus_files(value, domain, mod_id)
}

// Single-file details; carries file_name, which the nxm flow needs when the
// download URI's path has no usable filename.
pub(crate) async fn nexus_get_file(
    app: &AppHandle,
    game_id: &str,
    mod_id: u32,
    file_id: u32,
) -> Result<Value, String> {
    let domain = nexus_domain(game_id)?;
    nexus_get(
        app,
        &format!("/games/{domain}/mods/{mod_id}/files/{file_id}.json"),
        vec![],
    )
    .await
}

// key/expires come from a real nxm:// link, proof the download was
// authorized via a site click — passing them lets this endpoint succeed for
// free accounts too. Omitted, it 403s free accounts by design (confirmed
// live, not a bug here); that direct path is for Premium only.
pub(crate) async fn nexus_get_download_link(
    app: AppHandle,
    game_id: String,
    mod_id: u32,
    file_id: u32,
    key: Option<String>,
    expires: Option<String>,
) -> Result<Value, String> {
    let domain = nexus_domain(&game_id)?;
    let path = format!("/games/{domain}/mods/{mod_id}/files/{file_id}/download_link.json");
    let query = match (key, expires) {
        (Some(key), Some(expires)) => vec![("key", key), ("expires", expires)],
        (None, None) => vec![],
        _ => return Err("nexus: key and expires must be provided together".to_string()),
    };
    nexus_get(&app, &path, query).await
}

// Verified live against the real schema via introspection; ModsFilter's
// name field takes WILDCARD-op predicates.
const SEARCH_QUERY: &str = r#"
query ModrexSearch($filter: ModsFilter, $sort: [ModsSort!], $count: Int, $offset: Int) {
    mods(filter: $filter, sort: $sort, count: $count, offset: $offset) {
        totalCount
        nodes {
            modId
            name
            summary
            pictureUrl
            author
            downloads
            endorsements
            updatedAt
        }
    }
}
"#;

const PAGE_SIZE: u32 = 24;

fn validate_sort_field(sort: &str) -> Result<&str, String> {
    match sort {
        "relevance" | "downloads" | "endorsements" | "updatedAt" => Ok(sort),
        other => Err(format!("nexus: unknown sort field '{other}'")),
    }
}

// One query for both browse and search: an empty query string omits the
// name filter entirely rather than sending a WILDCARD match-everything.
#[tauri::command]
#[specta::specta]
pub async fn nexus_search_mods(
    app: AppHandle,
    game_id: String,
    query: String,
    sort: String,
    offset: Option<u32>,
) -> Result<crate::commands::domain::ModPage, String> {
    let domain = nexus_domain(&game_id)?;
    let headers = nexus_headers(&app).await?;
    let sort_field = validate_sort_field(&sort)?;

    let mut filter = serde_json::json!({
        "op": "AND",
        "gameDomainName": [{ "op": "EQUALS", "value": domain }],
    });
    if !query.trim().is_empty() {
        filter["name"] = serde_json::json!([{ "op": "WILDCARD", "value": query.trim() }]);
    }

    // json! doesn't support a computed key, and the sort field name is one
    // of the four validated above, so build that one object by hand.
    let mut sort_entry = serde_json::Map::new();
    sort_entry.insert(
        sort_field.to_string(),
        serde_json::json!({ "direction": "DESC" }),
    );

    let body = serde_json::json!({
        "query": SEARCH_QUERY,
        "variables": {
            "filter": filter,
            "sort": [Value::Object(sort_entry)],
            "count": PAGE_SIZE,
            "offset": offset.unwrap_or(0),
        },
    });

    let value = send_with_retry("search", || {
        let mut req = http_client().post(GRAPHQL_BASE).json(&body);
        for (k, v) in &headers {
            req = req.header(*k, v);
        }
        req
    })
    .await?;

    if let Some(errors) = value.get("errors") {
        return Err(format!("nexus graphql error: {errors}"));
    }
    let mods = value
        .get("data")
        .and_then(|d| d.get("mods"))
        .cloned()
        .ok_or_else(|| "nexus: malformed graphql response".to_string())?;
    let page = offset.unwrap_or(0) / PAGE_SIZE + 1;
    crate::commands::domain::parse_nexus_page(mods, page as i64, PAGE_SIZE as i64)
}

// fileHash is the archive-level lookup: the MD5 of the whole published archive as
// uploaded, not the extracted-content SHA256 Modrex already tracks. modFile.version
// is a real, populated version here (unlike SEARCH_QUERY's mods, which carries none —
// see the empty-version note in domain.rs), so a hit from this path may set version.
const FILE_HASHES_QUERY: &str = r#"
query ModrexFileHashes($md5s: [String]!) {
    fileHashes(md5s: $md5s) {
        md5 fileName fileSize gameId modFileId
        modFile { modId fileId name version }
    }
}
"#;

#[derive(Debug, Clone, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NexusHashMatch {
    pub mod_id: u32,
    pub file_id: u32,
    pub name: String,
    pub version: String,
    pub file_name: String,
    pub file_size: i64,
}

// BigInt scalars (fileSize here) are not guaranteed to arrive as a JSON number —
// some GraphQL servers serialize them as a string to avoid JS float-precision loss
// on large values, matching the quoted-string convention the input filter already
// uses for the same field (see the modFileContents fileSize filter note).
fn parse_big_int(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}

fn parse_hash_matches(value: &Value, want_game_id: u32) -> Result<Vec<NexusHashMatch>, String> {
    if let Some(errors) = value.get("errors") {
        return Err(format!("nexus graphql error: {errors}"));
    }

    let hashes = value
        .get("data")
        .and_then(|d| d.get("fileHashes"))
        .and_then(|h| h.as_array())
        .ok_or_else(|| "nexus: malformed graphql response".to_string())?;

    // A hash Nexus has seen but never associated with a mod file carries no
    // modFile; that is a real "not identifiable this way" outcome, not a
    // parse failure, so it is dropped rather than erroring the whole lookup.
    Ok(hashes
        .iter()
        .filter(|h| h.get("gameId").and_then(Value::as_u64) == Some(want_game_id as u64))
        .filter_map(|h| {
            let mod_file = h.get("modFile")?;
            Some(NexusHashMatch {
                mod_id: mod_file.get("modId")?.as_u64()? as u32,
                file_id: mod_file.get("fileId")?.as_u64()? as u32,
                name: mod_file.get("name")?.as_str()?.to_string(),
                version: mod_file.get("version")?.as_str()?.to_string(),
                file_name: h.get("fileName")?.as_str()?.to_string(),
                file_size: parse_big_int(h.get("fileSize")?)?,
            })
        })
        .collect())
}

// Per-archive identification: given the whole downloaded archive's MD5, find the
// Nexus mod(s) it belongs to. Only ever the current game's matches are returned —
// discarding a cross-game gameId is the same isolation mod_index.rs enforces via
// games.name, and it matters here because Nexus's md5 index is global.
pub(crate) async fn nexus_lookup_by_md5(
    app: AppHandle,
    game_id: String,
    md5s: Vec<String>,
) -> Result<Vec<NexusHashMatch>, String> {
    let want = nexus_numeric_game_id(&game_id)?;
    let headers = nexus_headers(&app).await?;

    let body = serde_json::json!({
        "query": FILE_HASHES_QUERY,
        "variables": { "md5s": md5s },
    });

    let value = send_with_retry("fileHashes", || {
        let mut req = http_client().post(GRAPHQL_BASE).json(&body);
        for (k, v) in &headers {
            req = req.header(*k, v);
        }
        req
    })
    .await?;

    parse_hash_matches(&value, want)
}

/// What identifying a dropped archive against Nexus produced. Returned in the Ok
/// channel, mirroring InstallOutcome (mods/mod.rs), so the renderer handles every
/// case explicitly instead of guessing from an empty list.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NexusArchiveIdentity {
    NotFound,
    Identified(NexusHashMatch),
    /// The same archive bytes are published under more than one Nexus mod (a real,
    /// observed shape — cross-posted content) and fileSize could not tell them apart
    /// because they are, by definition, the same size. The caller must ask the user.
    Ambiguous(Vec<NexusHashMatch>),
}

// Never picks a match on its own beyond what the data actually disambiguates: exactly
// one candidate is the only case that resolves silently. fileSize matching the local
// archive is a genuine discriminator when fileHashes ever returns candidates of
// different sizes; when every candidate is the same size (typical, since they are
// duplicates of the same bytes) this correctly falls through to Ambiguous.
fn resolve_archive_identity(matches: Vec<NexusHashMatch>, local_size: i64) -> NexusArchiveIdentity {
    match matches.len() {
        0 => NexusArchiveIdentity::NotFound,
        1 => {
            NexusArchiveIdentity::Identified(matches.into_iter().next().expect("len checked above"))
        }
        _ => {
            let mut by_size: Vec<NexusHashMatch> = matches
                .iter()
                .filter(|m| m.file_size == local_size)
                .cloned()
                .collect();
            if by_size.len() == 1 {
                NexusArchiveIdentity::Identified(by_size.remove(0))
            } else {
                NexusArchiveIdentity::Ambiguous(matches)
            }
        }
    }
}

/// Identifies a whole archive file against Nexus's fileHash index by MD5. Shared by
/// the renderer-facing identify_dropped_archive command and install_dropped_file's own
/// best-effort identification at install time (mods/mod.rs), so both go through the
/// same disambiguation rule instead of duplicating it.
pub(crate) async fn identify_archive_by_md5(
    app: AppHandle,
    game_id: String,
    file: &std::path::Path,
) -> Result<NexusArchiveIdentity, String> {
    let local_size = tokio::fs::metadata(file)
        .await
        .map_err(|e| e.to_string())?
        .len() as i64;
    let md5 = crate::commands::mods::compute_md5(file).await?;

    let matches = nexus_lookup_by_md5(app, game_id, vec![md5]).await?;
    Ok(resolve_archive_identity(matches, local_size))
}

/// Renderer-facing wrapper for a dropped file the user is about to install manually
/// (e.g. from a picker UI) rather than through install_dropped_file's own automatic
/// attempt. A NotFound or Ambiguous result is not an error — the caller falls through
/// to the existing unidentified install path either way.
#[tauri::command]
#[specta::specta]
pub async fn identify_dropped_archive(
    app: AppHandle,
    game_id: String,
    path: String,
) -> Result<NexusArchiveIdentity, String> {
    identify_archive_by_md5(app, game_id, std::path::Path::new(&path)).await
}

// modFileContents carries no hash, unlike fileHash(es) above — this is the closest
// legal equivalent to a SHA256 lookup Nexus permits, matching on the file(s) Modrex
// already has extracted on disk instead of an archive it may no longer hold. Which
// variant applies is a ModUnit decision, made by the caller in mods/, not here: this
// module only knows how to ask Nexus each shape of question, not which one a given
// game's mods need.
const CONTENT_QUERY: &str = r#"
query ModrexFileContents($filter: ModFileContentSearchFilter, $count: Int) {
    modFileContents(filter: $filter, count: $count) {
        totalCount
        nodes { modId fileSize }
    }
}
"#;

const CONTENT_PAGE_SIZE: u32 = 50;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum NexusContentQuery {
    /// File-unit games (PD3, Crime Boss): the .pak's published name. fileSize is not
    /// sent as a filter (see content_filter_json) — it is only used client-side, and
    /// only when the name alone is ambiguous.
    FileNameAndSize { file_name: String, file_size: i64 },
    /// Directory-unit games (PD2, PDTH, RAID): the mod's folder name as a path segment.
    FolderSegment { segment: String },
}

// fileSize is deliberately never sent as a Nexus-side filter for FileNameAndSize: a
// mod's currently-published file is often a newer upload than what's installed
// locally, so an exact byte-size match against the live index silently rejects a
// fileName match that is otherwise unique (confirmed live: a real installed archive's
// byte size no longer matched Nexus's current index for that same mod, even though
// its fileName alone resolved to exactly one mod). fileSize is still requested in the
// response and used to disambiguate client-side, only when fileName alone returns
// more than one candidate — see parse_content_mod_ids.
fn content_filter_json(want_game_id: u32, query: &NexusContentQuery) -> Value {
    let mut filter = serde_json::json!({
        "gameId": [{ "value": want_game_id, "op": "EQUALS" }],
    });
    match query {
        NexusContentQuery::FileNameAndSize { file_name, .. } => {
            filter["fileNameWildcard"] =
                serde_json::json!([{ "value": file_name, "op": "EQUALS" }]);
        }
        NexusContentQuery::FolderSegment { segment } => {
            filter["filePathPartsExact"] =
                serde_json::json!([{ "value": segment, "op": "EQUALS" }]);
        }
    }
    filter
}

fn content_node_ids(nodes: &[Value]) -> Vec<u32> {
    let mut ids: Vec<u32> = nodes
        .iter()
        .filter_map(|n| n.get("modId").and_then(Value::as_u64))
        .map(|id| id as u32)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// `disambiguate_by_size` is the local file's byte size for a FileNameAndSize query,
/// None for FolderSegment (which has no analogous per-node signal to fall back on).
/// Only consulted when fileName alone returns more than one distinct mod — see
/// content_filter_json for why fileSize is never sent as a request filter.
fn parse_content_mod_ids(
    value: &Value,
    disambiguate_by_size: Option<i64>,
) -> Result<Vec<u32>, String> {
    if let Some(errors) = value.get("errors") {
        return Err(format!("nexus graphql error: {errors}"));
    }

    let nodes = value
        .get("data")
        .and_then(|d| d.get("modFileContents"))
        .and_then(|c| c.get("nodes"))
        .and_then(|n| n.as_array())
        .ok_or_else(|| "nexus: malformed graphql response".to_string())?;

    let ids = content_node_ids(nodes);
    let (Some(target_size), true) = (disambiguate_by_size, ids.len() > 1) else {
        return Ok(ids);
    };

    let size_matched_nodes: Vec<Value> = nodes
        .iter()
        .filter(|n| {
            n.get("fileSize")
                .and_then(parse_big_int)
                .is_some_and(|s| s == target_size)
        })
        .cloned()
        .collect();
    let by_size = content_node_ids(&size_matched_nodes);
    // A miss here just means the fileSize signal did not narrow it down further
    // (e.g. none of the candidates' currently-indexed size matches) — fall back to
    // the full name-matched set rather than manufacturing a false empty result.
    Ok(if by_size.len() == 1 { by_size } else { ids })
}

/// Distinct Nexus mod ids whose published content matches query. Zero is a normal,
/// expected outcome (roughly a quarter of mods are never indexed) — never treat an
/// empty result as an error. More than one means the match was not unique; the caller
/// must not guess which mod it is.
pub(crate) async fn nexus_lookup_content_mod_ids(
    app: AppHandle,
    game_id: String,
    query: NexusContentQuery,
) -> Result<Vec<u32>, String> {
    let want = nexus_numeric_game_id(&game_id)?;
    let headers = nexus_headers(&app).await?;
    let filter = content_filter_json(want, &query);
    let disambiguate_by_size = match &query {
        NexusContentQuery::FileNameAndSize { file_size, .. } => Some(*file_size),
        NexusContentQuery::FolderSegment { .. } => None,
    };

    let body = serde_json::json!({
        "query": CONTENT_QUERY,
        "variables": { "filter": filter, "count": CONTENT_PAGE_SIZE },
    });

    let value = send_with_retry("modFileContents", || {
        let mut req = http_client().post(GRAPHQL_BASE).json(&body);
        for (k, v) in &headers {
            req = req.header(*k, v);
        }
        req
    })
    .await?;

    parse_content_mod_ids(&value, disambiguate_by_size)
}

#[cfg(test)]
#[path = "nexus_tests.rs"]
mod tests;
