use futures::future::{select, Either};
use futures::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::Notify;
use uuid::Uuid;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub download_id: String,
    pub game_id: Option<String>,
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Clone, Serialize)]
struct DownloadFinished {
    download_id: String,
    game_id: Option<String>,
}

fn cancels() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static CANCELS: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    CANCELS.get_or_init(Default::default)
}

/// Keeps an install's fetch cancellable by its download id while it runs.
struct Cancellable {
    download_id: String,
    signal: Arc<Notify>,
}

impl Cancellable {
    fn register(download_id: &str) -> Self {
        let signal = Arc::new(Notify::new());
        cancels()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(download_id.to_string(), signal.clone());
        Self {
            download_id: download_id.to_string(),
            signal,
        }
    }
}

impl Drop for Cancellable {
    fn drop(&mut self) {
        let mut cancels = cancels().lock().unwrap_or_else(|e| e.into_inner());
        // A second download under the same id replaced this entry and owns it now.
        if cancels
            .get(&self.download_id)
            .is_some_and(|signal| Arc::ptr_eq(signal, &self.signal))
        {
            cancels.remove(&self.download_id);
        }
    }
}

/// Cancels an install still fetching its file. Nothing happens when no fetch has this id,
/// since it may have finished a moment before.
#[tauri::command]
#[specta::specta]
pub fn cancel_download(download_id: String) {
    let cancels = cancels().lock().unwrap_or_else(|e| e.into_inner());
    let Some(signal) = cancels.get(&download_id) else {
        log::info!("download {download_id}: cancel requested after the fetch ended");
        return;
    };
    log::info!("download {download_id}: cancelled");
    // notify_one keeps the signal when the fetch is between awaits.
    signal.notify_one();
}

/// Runs an install's fetch, the API lookups and the download, so cancel_download with
/// the same id can stop it. None when it was cancelled.
pub async fn cancellable<T>(download_id: &str, fetch: impl Future<Output = T>) -> Option<T> {
    let cancellable = Cancellable::register(download_id);
    let cancelled = pin!(cancellable.signal.notified());
    let fetch = pin!(fetch);
    match select(cancelled, fetch).await {
        Either::Left(_) => None,
        Either::Right((fetched, _)) => Some(fetched),
    }
}

/// Deletes a download's temp file unless the download completes, so one that fails or is
/// cancelled leaves nothing behind.
struct TempDownload {
    path: PathBuf,
    complete: bool,
}

impl Drop for TempDownload {
    fn drop(&mut self) {
        if self.complete {
            return;
        }
        if let Err(e) = std::fs::remove_file(&self.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "could not delete the unfinished download {}: {e}",
                    self.path.display()
                );
            }
        }
    }
}

/// Downloads url to a temp file and emits cumulative progress at a bounded rate.
pub async fn download_file(
    app: &AppHandle,
    url: &str,
    ext: &str,
    download_id: &str,
    game_id: Option<&str>,
) -> Result<PathBuf, String> {
    // Declared before the file handle, so the handle closes before the delete on drop.
    let mut temp = TempDownload {
        path: std::env::temp_dir().join(format!("modrex-{}.{}", Uuid::new_v4(), ext)),
        complete: false,
    };
    let dest = temp.path.clone();

    let res = crate::commands::api::http_client()
        .get(url)
        .header("User-Agent", crate::commands::api::user_agent(app))
        .send()
        .await
        .map_err(|e| crate::commands::api::describe_request_error(&e))?;

    if !res.status().is_success() {
        return Err(format!("download failed {}: {}", res.status(), url));
    }

    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| e.to_string())?;
    let mut progress_warning_logged = false;
    write_download(res, &mut file, |downloaded, total| {
        if let Err(error) = app.emit(
            "download:progress",
            DownloadProgress {
                download_id: download_id.to_string(),
                game_id: game_id.map(str::to_string),
                downloaded,
                total,
            },
        ) {
            if progress_warning_logged {
                return;
            }
            log::warn!("download {download_id}: progress notification failed: {error}");
            progress_warning_logged = true;
        }
    })
    .await?;
    drop(file);
    if let Err(error) = app.emit(
        "download:finished",
        DownloadFinished {
            download_id: download_id.to_string(),
            game_id: game_id.map(str::to_string),
        },
    ) {
        log::warn!("download {download_id}: finished notification failed: {error}");
    }
    temp.complete = true;
    Ok(dest)
}

fn take_progress_update(last_update: &mut Instant, now: Instant) -> bool {
    if now.duration_since(*last_update) < PROGRESS_INTERVAL {
        return false;
    }
    *last_update = now;
    true
}

async fn write_download(
    response: reqwest::Response,
    file: &mut (impl AsyncWrite + Unpin),
    mut report_progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0;
    let mut stream = response.bytes_stream();
    report_progress(0, total);
    let mut last_update = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if take_progress_update(&mut last_update, Instant::now()) {
            report_progress(downloaded, total);
        }
    }

    file.flush().await.map_err(|e| e.to_string())?;
    report_progress(downloaded, total);
    Ok(())
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
