use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};
use std::io::{BufRead, BufReader, Cursor, Seek};
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

// Two grid columns of about 490 CSS px at 2x scale.
const CARD_WIDTH: u32 = 960;

#[derive(Clone, Copy, Default, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ThumbnailSize {
    #[default]
    Small,
    Card,
    Full,
}

fn card_cache_name(filename: &str, alpha: bool) -> Result<String, String> {
    let extension = if alpha { "png" } else { "jpg" };
    let name = format!("card_{filename}.{extension}");
    if !is_safe_thumb_filename(&name) {
        return Err(format!("invalid card thumbnail filename: {name}"));
    }
    Ok(name)
}

// The skip decisions read only the header, so originals that need no card are never
// decoded. Browsers honor EXIF orientation and ICC profiles on the original, so the card
// applies the orientation and carries the profile or it would render rotated or shifted.
fn encode_card(source: impl BufRead + Seek) -> Result<Option<(Vec<u8>, bool)>, String> {
    let mut reader = ImageReader::new(source)
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    if reader.format() == Some(ImageFormat::Gif) {
        return Ok(None);
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let (width, height) = decoder.dimensions();
    let displayed_width = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => height,
        _ => width,
    };
    if displayed_width <= CARD_WIDTH {
        return Ok(None);
    }
    let icc_profile = decoder.icc_profile().map_err(|e| e.to_string())?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    image.apply_orientation(orientation);
    let alpha = image.color().has_alpha();
    let resized = image.resize(CARD_WIDTH, u32::MAX, image::imageops::FilterType::Triangle);
    let mut output = Cursor::new(Vec::new());
    if alpha {
        let mut encoder = image::codecs::png::PngEncoder::new(&mut output);
        if let Some(profile) = icc_profile {
            encoder
                .set_icc_profile(profile)
                .map_err(|e| e.to_string())?;
        }
        let rgba = resized.to_rgba8();
        encoder
            .write_image(
                &rgba,
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?;
    } else {
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 85);
        if let Some(profile) = icc_profile {
            encoder
                .set_icc_profile(profile)
                .map_err(|e| e.to_string())?;
        }
        let rgb = resized.to_rgb8();
        encoder
            .write_image(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(Some((output.into_inner(), alpha)))
}

fn cache_card(original: &Path, filename: &str) -> Result<String, String> {
    let file = std::fs::File::open(original).map_err(|e| e.to_string())?;
    let Some((bytes, alpha)) = encode_card(BufReader::new(file))? else {
        return Ok(filename.to_string());
    };
    let name = card_cache_name(filename, alpha)?;
    let path = original.with_file_name(&name);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Caches a small CDN thumbnail, a card image, or the original for detail views.
#[tauri::command]
#[specta::specta]
pub async fn get_thumbnail(
    app: AppHandle,
    filename: String,
    size: Option<ThumbnailSize>,
) -> Result<String, String> {
    if !is_safe_thumb_filename(&filename) {
        return Err(format!("invalid thumbnail filename: {filename}"));
    }
    let size = size.unwrap_or_default();
    let cache_name = match size {
        ThumbnailSize::Small => format!("thumbnail_{filename}"),
        ThumbnailSize::Card | ThumbnailSize::Full => filename.clone(),
    };
    if !is_safe_thumb_filename(&cache_name) {
        return Err(format!("invalid thumbnail filename: {cache_name}"));
    }
    let path = cache_path(&app, &cache_name)?;
    if !matches!(size, ThumbnailSize::Card) && path.exists() {
        return Ok(cache_name);
    }
    let _permit = semaphore().acquire().await.map_err(|e| e.to_string())?;

    if matches!(size, ThumbnailSize::Card) {
        for alpha in [false, true] {
            let name = card_cache_name(&filename, alpha)?;
            if cache_path(&app, &name)?.exists() {
                return Ok(name);
            }
        }
    }

    if !path.exists() {
        tokio::fs::create_dir_all(path.parent().expect("cache path has parent"))
            .await
            .map_err(|e| e.to_string())?;
        let bytes = match size {
            ThumbnailSize::Small => match fetch_image(&app, &cache_name).await {
                Ok(bytes) => bytes,
                Err(_) => fetch_image(&app, &filename).await?,
            },
            ThumbnailSize::Card | ThumbnailSize::Full => fetch_image(&app, &filename).await?,
        };
        let tmp = path.with_extension("tmp");
        tokio::fs::write(&tmp, &bytes)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(&tmp, &path)
            .await
            .map_err(|e| e.to_string())?;
    }
    if !matches!(size, ThumbnailSize::Card) {
        return Ok(cache_name);
    }
    let original_name = filename.clone();
    let result = tauri::async_runtime::spawn_blocking(move || cache_card(&path, &filename))
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result);
    match result {
        Ok(name) => Ok(name),
        Err(error) => {
            log::warn!("Card thumbnail failed for {original_name}: {error}");
            Ok(original_name)
        }
    }
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
