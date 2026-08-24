use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

const CACHE_MAX_AGE: Duration = Duration::from_secs(90 * 24 * 60 * 60);

const THUMBNAIL_BASE_URL: &str = "https://storage.modworkshop.net/mods/images";

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_max_idle_per_host(6)
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap()
    })
}

fn semaphore() -> &'static Semaphore {
    SEMAPHORE.get_or_init(|| Semaphore::new(6))
}

fn cache_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("thumbnails").join(filename))
}

async fn fetch_image(app: &AppHandle, file: &str) -> Result<Vec<u8>, String> {
    let url = format!("{}/{}", THUMBNAIL_BASE_URL, file);
    let resp = client()
        .get(&url)
        .header(
            "User-Agent",
            format!("modrex/{}", app.package_info().version),
        )
        .send()
        .await
        .map_err(|e| crate::commands::api::describe_request_error(&e))?;
    if !resp.status().is_success() {
        return Err(format!("status {} for {}", resp.status(), url));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| e.to_string())
}

/// Caches an image and returns the cache filename for the renderer to build its thumb://
/// URL from. Default is the pre-generated small variant (thumbnail_{file}, 10-20x smaller
/// than an original that can run to several MB), falling back to the original for old
/// images without one (has_thumb: false). With full = true it caches the original under
/// {filename}, which the detail page needs because the CDN sends no cache headers.
#[tauri::command]
#[specta::specta]
pub async fn get_thumbnail(
    app: AppHandle,
    filename: String,
    full: Option<bool>,
) -> Result<String, String> {
    if !is_safe_thumb_filename(&filename) {
        return Err(format!("invalid thumbnail filename: {filename}"));
    }
    let full = full.unwrap_or(false);
    let cache_name = if full {
        filename.clone()
    } else {
        format!("thumbnail_{filename}")
    };
    let path = cache_path(&app, &cache_name)?;

    if path.exists() {
        return Ok(cache_name);
    }

    let _permit = semaphore().acquire().await.map_err(|e| e.to_string())?;

    // Re-check: a concurrent call may have downloaded it while we waited
    if path.exists() {
        return Ok(cache_name);
    }

    tokio::fs::create_dir_all(path.parent().expect("cache path has parent"))
        .await
        .map_err(|e| e.to_string())?;

    let bytes = if full {
        fetch_image(&app, &filename).await?
    } else {
        match fetch_image(&app, &cache_name).await {
            Ok(b) => b,
            Err(_) => fetch_image(&app, &filename).await?,
        }
    };

    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(cache_name)
}

/// True when filename is a single safe path segment. get_thumbnail's filename
/// comes straight from modworkshop mod metadata (thumbnail.file, banner.file,
/// images[].file), so it is attacker-controlled. A "..", separator, or
/// absolute/drive-prefixed value would let the cache write and the {base}/{file}
/// fetch escape the thumbnails directory (path traversal).
pub(crate) fn is_safe_thumb_filename(filename: &str) -> bool {
    !filename.is_empty()
        && !filename.contains('/')
        && !filename.contains('\\')
        && !filename.contains("..")
        && !Path::new(filename).is_absolute()
}

/// Returns the bare filename when the raw URI path is a single safe path segment, and
/// rejects anything that could escape the thumbnails directory.
pub(crate) fn sanitize_thumb_filename(raw_path: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(raw_path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?;
    let name = decoded.as_ref();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return None;
    }
    Some(name.to_string())
}

pub(crate) fn thumb_content_type(filename: &str) -> &'static str {
    match Path::new(filename).extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

/// Serves thumb:// requests from the thumbnail disk cache. Unlike Tauri's asset protocol,
/// responses carry an immutable Cache-Control header: CDN filenames are content-unique, so
/// the webview reuses cached and decoded images across page remounts. Without the header,
/// every game or tab switch re-loads the whole grid.
pub(crate) fn handle_thumb_protocol(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    fn not_found() -> tauri::http::Response<Vec<u8>> {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("static response")
    }

    let Some(filename) = sanitize_thumb_filename(request.uri().path()) else {
        return not_found();
    };
    let Ok(path) = cache_path(app, &filename) else {
        return not_found();
    };
    match std::fs::read(&path) {
        Ok(bytes) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", thumb_content_type(&filename))
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(bytes)
            .expect("valid thumb response"),
        Err(_) => not_found(),
    }
}

pub(crate) fn cleanup_dir(dir: &Path, max_age: Duration) {
    let cutoff = SystemTime::now() - max_age;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < cutoff {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub async fn cleanup_thumbnail_cache(app: AppHandle) {
    let dir = match app.path().app_cache_dir() {
        Ok(d) => d.join("thumbnails"),
        Err(_) => return,
    };
    tokio::task::spawn_blocking(move || cleanup_dir(&dir, CACHE_MAX_AGE))
        .await
        .ok();
}

#[cfg(test)]
#[path = "thumbnails_tests.rs"]
mod tests;
