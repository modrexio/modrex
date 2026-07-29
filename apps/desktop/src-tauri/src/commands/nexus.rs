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

#[cfg(test)]
#[path = "nexus_tests.rs"]
mod tests;
