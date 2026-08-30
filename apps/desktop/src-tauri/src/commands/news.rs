use std::path::PathBuf;
use std::process::Command;

use scraper::{Html, Selector};
use tauri::{AppHandle, Manager};

const MAX_AGE_SECS: u64 = 3600;

/// A normal browser UA, sent purely so the site's own analytics see a plausible visitor.
/// Curl's TLS/HTTP2 fingerprint is what actually gets through Cloudflare here, not this
/// string (see curl_fetch).
const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    pub title: String,
    pub url: String,
    pub date: String,
    pub excerpt: String,
    pub image: Option<String>,
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsResult {
    pub items: Vec<NewsItem>,
    pub total_pages: u32,
}

fn category_slug(game_id: &str) -> Option<&'static str> {
    crate::games::discovered()
        .iter()
        .find(|(id, _)| *id == game_id)
        .and_then(|(_, pkg)| pkg.news.as_ref())
        .map(|news| news.category_slug.as_str())
}

fn no_news(game_id: &str) -> String {
    match crate::games::discovered()
        .iter()
        .find(|(id, _)| *id == game_id)
    {
        Some((_, pkg)) => format!("{} has no official news source", pkg.display_name),
        None => format!("unknown game '{game_id}'"),
    }
}

fn category_url(game_id: &str, page: u32) -> Option<String> {
    let slug = category_slug(game_id)?;
    Some(if page <= 1 {
        format!("https://www.paydaythegame.com/news/category/{slug}/")
    } else {
        format!("https://www.paydaythegame.com/news/category/{slug}/page/{page}/")
    })
}

fn cache_path(app: &AppHandle, game_id: &str) -> Option<PathBuf> {
    let slug = category_slug(game_id)?;
    Some(
        app.path()
            .app_data_dir()
            .expect("failed to resolve app data dir")
            .join(format!("news-{slug}.json")),
    )
}

/// Picks the 700w variant from a srcset when present (matches the card's thumbnail
/// rendering size), falling back to the plain src.
fn pick_image(img: &scraper::ElementRef) -> Option<String> {
    if let Some(srcset) = img.value().attr("srcset") {
        for part in srcset.split(',') {
            let part = part.trim();
            if part.ends_with("700w") {
                if let Some(url) = part.split_whitespace().next() {
                    return Some(url.to_string());
                }
            }
        }
    }
    img.value().attr("src").map(|s| s.to_string())
}

fn text_of(el: &scraper::ElementRef) -> String {
    el.text().collect::<String>().trim().to_string()
}

/// Pure parser over a paydaythegame.com news category page. Kept free of any I/O so it is
/// directly unit-testable against a saved HTML fixture.
pub fn parse_news_html(html: &str) -> Vec<NewsItem> {
    let document = Html::parse_document(html);
    let article_sel = Selector::parse("article.post-linkxd").unwrap();
    let title_sel = Selector::parse("h3 a").unwrap();
    let date_sel = Selector::parse(".date").unwrap();
    let excerpt_sel = Selector::parse("p.blogexcerptx").unwrap();
    let image_sel = Selector::parse(".post-img img").unwrap();
    let category_sel = Selector::parse(".categories a").unwrap();

    document
        .select(&article_sel)
        .filter_map(|article| {
            let title_link = article.select(&title_sel).next()?;
            let title = text_of(&title_link);
            let url = article
                .value()
                .attr("data-linkxd")
                .map(|s| s.to_string())
                .or_else(|| title_link.value().attr("href").map(|s| s.to_string()))?;
            let date = article
                .select(&date_sel)
                .next()
                .map(|el| text_of(&el))
                .unwrap_or_default();
            let excerpt = article
                .select(&excerpt_sel)
                .next()
                .map(|el| text_of(&el))
                .unwrap_or_default();
            let image = article
                .select(&image_sel)
                .next()
                .and_then(|el| pick_image(&el));
            let categories = article
                .select(&category_sel)
                .map(|el| text_of(&el))
                .filter(|s| !s.is_empty())
                .collect();

            Some(NewsItem {
                title,
                url,
                date,
                excerpt,
                image,
                categories,
            })
        })
        .collect()
}

/// WP-PageNavi never shows a link to the page you are currently on (no .last link on the
/// last page, no link back to page 1 from page 1), so the total is the max page number
/// across every link plus whichever page is marked .current, not just .last's target.
pub fn extract_total_pages(html: &str) -> u32 {
    let document = Html::parse_document(html);
    let nav_link_sel = Selector::parse(".wp-pagenavi a").unwrap();
    let current_sel = Selector::parse(".wp-pagenavi .current").unwrap();

    let mut max_page = 1u32;
    for link in document.select(&nav_link_sel) {
        if let Some(href) = link.value().attr("href") {
            if let Some(n) = href
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .and_then(|s| s.parse::<u32>().ok())
            {
                max_page = max_page.max(n);
            }
        }
    }
    if let Some(current) = document.select(&current_sel).next() {
        if let Ok(n) = text_of(&current).parse::<u32>() {
            max_page = max_page.max(n);
        }
    }
    max_page
}

fn read_cache(path: &std::path::Path) -> Option<NewsResult> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_cache(path: &std::path::Path, result: &NewsResult) -> Result<(), String> {
    let bytes = serde_json::to_vec(result).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn cache_age_secs(path: &std::path::Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .elapsed()
        .ok()
        .map(|e| e.as_secs())
}

/// paydaythegame.com sits behind Cloudflare bot management that 403s every library HTTP
/// client tried, reqwest and .NET HttpClient alike, regardless of UA or headers: it is a
/// TLS/HTTP2 fingerprint check. A renderer-side fetch fails too, since the site sends no
/// Access-Control-Allow-Origin header and CORS blocks the response before JS sees it.
/// curl.exe is the one client that passed live testing, so this shells out to it, matching
/// steam.rs's reg query and xbox.rs's powershell.
fn curl_fetch(url: &str) -> Result<String, String> {
    let mut cmd = Command::new("curl");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = crate::commands::launchers::outside_bundle(&mut cmd)
        .args(["-sL", "--max-time", "15", "-A", BROWSER_UA, url])
        .output()
        .map_err(|e| format!("curl unavailable: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "curl exited with status {:?}",
            output.status.code()
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

async fn download_news(game_id: &str, page: u32) -> Result<NewsResult, String> {
    let Some(url) = category_url(game_id, page) else {
        return Err(no_news(game_id));
    };
    let html = tokio::task::spawn_blocking(move || curl_fetch(&url))
        .await
        .map_err(|e| e.to_string())??;
    Ok(NewsResult {
        items: parse_news_html(&html),
        total_pages: extract_total_pages(&html),
    })
}

/// Page 1 only: the cached, TTL-backed entry point used on first
/// load and by the Refresh button.
#[tauri::command]
#[specta::specta]
pub async fn fetch_news(app: AppHandle, game_id: String) -> Result<NewsResult, String> {
    let Some(path) = cache_path(&app, &game_id) else {
        return Err(no_news(&game_id));
    };
    if cache_age_secs(&path).is_some_and(|age| age < MAX_AGE_SECS) {
        if let Some(result) = read_cache(&path) {
            return Ok(result);
        }
    }
    let result = download_news(&game_id, 1).await?;
    let _ = write_cache(&path, &result);
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_news(app: AppHandle, game_id: String) -> Result<NewsResult, String> {
    let Some(path) = cache_path(&app, &game_id) else {
        return Err(no_news(&game_id));
    };
    let result = download_news(&game_id, 1).await?;
    let _ = write_cache(&path, &result);
    Ok(result)
}

/// Pages other than 1, fetched on demand, never cached (the disk cache
/// exists to make the default page-1 view instant, not to mirror the whole
/// site).
#[tauri::command]
#[specta::specta]
pub async fn fetch_news_page(game_id: String, page: u32) -> Result<NewsResult, String> {
    download_news(&game_id, page.max(1)).await
}

#[cfg(test)]
#[path = "news_tests.rs"]
mod tests;
