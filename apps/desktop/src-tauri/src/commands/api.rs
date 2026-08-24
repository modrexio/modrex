use reqwest::header::HeaderMap;
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::sync::Semaphore;

/// Raw provider JSON in command signatures, exported to TypeScript as unknown.
/// specta's own impl for serde_json::Value recurses infinitely at export time;
/// serde(transparent) keeps the wire shape identical to a bare Value.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(transparent)]
pub struct Json(pub Value);

impl specta::Type for Json {
    fn definition(_: &mut specta::Types) -> specta::datatype::DataType {
        specta::datatype::DataType::Reference(specta_typescript::define("unknown"))
    }
}

const BASE: &str = "https://api.modworkshop.net";
const MAX_CONCURRENT: usize = 3;
// modworkshop enforces 90 req/min per IP, shared across every endpoint
// (confirmed live via the x-ratelimit-limit response header, which modworkshop
// documents nowhere). Burst up to 4, then 1.3/sec sustained (about 78/min) sits
// deliberately under that ceiling: exceeding it self-inflicts the 429s below.
const RATE_BURST: f64 = 4.0;
const RATE_PER_SEC: f64 = 1.3;

// Last x-ratelimit-remaining seen on any response. -1 means no response yet this
// run. modworkshop exposes no reset timestamp, so an exact wait cannot be computed
// once the budget runs low. A flat precautionary pause backs the client off
// proactively instead of reacting only after a 429 has already happened.
static RATE_REMAINING: AtomicI64 = AtomicI64::new(-1);
const LOW_REMAINING_THRESHOLD: i64 = 5;
const LOW_REMAINING_PAUSE: Duration = Duration::from_secs(3);

// Shared with the Nexus client, which reads its own quota header name.
pub(crate) fn parse_remaining_header(headers: &HeaderMap, name: &str) -> Option<i64> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
}

fn parse_rate_limit_remaining(headers: &HeaderMap) -> Option<i64> {
    parse_remaining_header(headers, "x-ratelimit-remaining")
}

// Shared with the Nexus client, which runs its own instance with its own limits.
pub(crate) struct TokenBucket {
    tokens: f64,
    max: f64,
    refill_per_ms: f64,
    last_refill: Instant,
}

impl TokenBucket {
    pub(crate) fn new(max: f64, per_second: f64) -> Self {
        Self {
            tokens: max,
            max,
            refill_per_ms: per_second / 1000.0,
            last_refill: Instant::now(),
        }
    }

    pub(crate) fn consume(&mut self) -> Duration {
        let now = Instant::now();
        let elapsed_ms = now.duration_since(self.last_refill).as_secs_f64() * 1000.0;
        self.tokens = (self.tokens + elapsed_ms * self.refill_per_ms).min(self.max);
        self.last_refill = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Duration::ZERO
        } else {
            let wait_ms = ((1.0 - self.tokens) / self.refill_per_ms) as u64;
            Duration::from_millis(wait_ms)
        }
    }
}

static RATE_LIMITER: OnceLock<Mutex<TokenBucket>> = OnceLock::new();
static API_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();
static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn rate_limiter() -> &'static Mutex<TokenBucket> {
    RATE_LIMITER.get_or_init(|| Mutex::new(TokenBucket::new(RATE_BURST, RATE_PER_SEC)))
}

fn semaphore() -> &'static Semaphore {
    API_SEMAPHORE.get_or_init(|| Semaphore::new(MAX_CONCURRENT))
}

pub(crate) fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .pool_max_idle_per_host(4)
            .build()
            .expect("failed to build HTTP client")
    })
}

pub(crate) fn user_agent(app: &AppHandle) -> String {
    format!("modrex/{}", app.package_info().version)
}

/// A request failure with the causes reqwest's own Display drops. On its own that
/// Display reads "error sending request for url (...)" whether the name lookup failed,
/// the handshake failed, or a proxy refused, and a bug report carrying only that line
/// cannot be diagnosed.
pub(crate) fn describe_request_error(error: &reqwest::Error) -> String {
    let mut description = error.to_string();
    let mut cause = std::error::Error::source(error);
    while let Some(error) = cause {
        description.push_str(&format!(": {error}"));
        cause = error.source();
    }
    description
}

pub(crate) async fn api_get(
    app: &AppHandle,
    path: &str,
    params: Vec<(&str, String)>,
) -> Result<Value, String> {
    let mut url = reqwest::Url::parse(&format!("{}{}", BASE, path)).map_err(|e| e.to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in &params {
            pairs.append_pair(k, v);
        }
    }
    let client = http_client();
    let ua = user_agent(app);

    for attempt in 0u64..3 {
        // Bucket refills during backoff sleep, so this is usually instant on retry.
        let wait = rate_limiter()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .consume();
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }

        // Proactive slowdown: the last response said the per-minute budget is
        // nearly gone. Pause before even taking a semaphore permit, on top of
        // the token bucket's normal pacing above.
        let remaining = RATE_REMAINING.load(Ordering::Relaxed);
        if (0..=LOW_REMAINING_THRESHOLD).contains(&remaining) {
            tokio::time::sleep(LOW_REMAINING_PAUSE).await;
        }

        let _permit = semaphore().acquire().await.map_err(|e| e.to_string())?;
        let res = client
            .get(url.clone())
            .header("Accept", "application/json")
            .header("User-Agent", &ua)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| describe_request_error(&e))?;

        if let Some(remaining) = parse_rate_limit_remaining(res.headers()) {
            RATE_REMAINING.store(remaining, Ordering::Relaxed);
        }

        if res.status() == 429 {
            drop(_permit);
            let retry_ms = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .map(|s| s * 1000)
                .unwrap_or_else(|| {
                    let base_ms = 1000u64 << attempt.min(3);
                    let jitter = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .subsec_nanos() as u64
                        % 1000;
                    base_ms + jitter
                });
            tokio::time::sleep(Duration::from_millis(retry_ms)).await;
            continue;
        }

        if !res.status().is_success() {
            return Err(format!("modworkshop API {}: {}", res.status(), path));
        }
        return res.json().await.map_err(|e| e.to_string());
    }

    Err(format!("modworkshop API 429: {}", path))
}

#[derive(Debug, Deserialize, specta::Type)]
pub struct ListModsParams {
    pub query: Option<String>,
    pub limit: Option<u32>,
    pub sort: Option<String>,
    pub category_id: Option<u32>,
    pub page: Option<u32>,
    // Filters the listing down to exactly these mod ids (undocumented modworkshop
    // feature, verified live: /games/{id}/mods?ids[]=A&ids[]=B returns just A and B
    // in full list-item shape). Lets a bulk metadata refresh use one request per
    // ~50 ids instead of one get_mod per id.
    pub ids: Option<Vec<u32>>,
    pub tags: Option<Vec<u32>>,
    pub block_tags: Option<Vec<u32>>,
}

#[tauri::command]
#[specta::specta]
pub async fn list_mods(
    app: AppHandle,
    game_id: u32,
    params: Option<ListModsParams>,
) -> Result<crate::commands::domain::ModPage, String> {
    let mut query: Vec<(&str, String)> = vec![];
    if let Some(p) = &params {
        if let Some(v) = &p.query {
            query.push(("query", v.clone()));
        }
        if let Some(v) = p.limit {
            query.push(("limit", v.to_string()));
        }
        if let Some(v) = &p.sort {
            query.push(("sort", v.clone()));
        }
        if let Some(v) = p.category_id {
            query.push(("category_id", v.to_string()));
        }
        if let Some(v) = p.page {
            query.push(("page", v.to_string()));
        }
        if let Some(ids) = &p.ids {
            for id in ids {
                query.push(("ids[]", id.to_string()));
            }
        }
        if let Some(tags) = &p.tags {
            for id in tags {
                query.push(("tags[]", id.to_string()));
            }
        }
        if let Some(block) = &p.block_tags {
            for id in block {
                query.push(("block_tags[]", id.to_string()));
            }
        }
    }
    let value = api_get(&app, &format!("/games/{}/mods", game_id), query).await?;
    crate::commands::domain::parse_mod_page(value)
}

#[tauri::command]
#[specta::specta]
pub async fn get_mod(
    app: AppHandle,
    id: u32,
) -> Result<crate::commands::domain::ModDetail, String> {
    let value = api_get(&app, &format!("/mods/{}", id), vec![]).await?;
    crate::commands::domain::parse_mod_detail(value)
}

#[tauri::command]
#[specta::specta]
pub async fn list_mod_files(
    app: AppHandle,
    mod_id: u32,
) -> Result<crate::commands::domain::FilePage, String> {
    let value = api_get(&app, &format!("/mods/{}/files", mod_id), vec![]).await?;
    crate::commands::domain::parse_file_page(value)
}

#[tauri::command]
#[specta::specta]
pub async fn list_mod_links(
    app: AppHandle,
    mod_id: u32,
) -> Result<crate::commands::domain::LinkPage, String> {
    let value = api_get(&app, &format!("/mods/{}/links", mod_id), vec![]).await?;
    crate::commands::domain::parse_link_page(value)
}

#[tauri::command]
#[specta::specta]
pub async fn list_categories(app: AppHandle, game_id: u32) -> Result<Json, String> {
    api_get(&app, &format!("/games/{}/categories", game_id), vec![])
        .await
        .map(Json)
}

#[tauri::command]
#[specta::specta]
pub async fn list_tags(app: AppHandle, game_id: u32) -> Result<Json, String> {
    // global must be sent as 1, never true: params go out as a query string and
    // modworkshop's Laravel boolean rule 422s on the literal "true". It folds site-wide
    // tags in on top of the game's own, and the server still drops any the game hides.
    api_get(
        &app,
        &format!("/games/{}/tags", game_id),
        vec![("type", "mod".to_string()), ("global", "1".to_string())],
    )
    .await
    .map(Json)
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;
