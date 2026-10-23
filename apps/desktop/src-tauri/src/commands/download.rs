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
use tokio::io::AsyncWriteExt;
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

/// Downloads url to a temp file with the given extension, emitting download:progress
/// events as chunks arrive. Returns the temp file path.
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

    let total = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| e.to_string())?;

    let mut last_progress: Option<Instant> = None;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        // Every event re-renders each page showing installs, so one per chunk keeps the
        // window too busy to answer clicks until the download ends.
        if last_progress.is_some_and(|at| at.elapsed() < PROGRESS_INTERVAL) {
            continue;
        }
        last_progress = Some(Instant::now());
        let _ = app.emit(
            "download:progress",
            DownloadProgress {
                download_id: download_id.to_string(),
                game_id: game_id.map(str::to_string),
                downloaded,
                total,
            },
        );
    }

    file.flush().await.map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_cancel_reaches_the_download_with_that_id() {
        let download = Cancellable::register("file:1:2");
        cancel_download("file:1:2".to_string());
        // The signal waits for the download's next await, so this resolves at once.
        download.signal.notified().await;
    }

    #[tokio::test]
    async fn a_cancel_stops_a_fetch_that_is_still_waiting() {
        let fetch = cancellable("mod:5", std::future::pending::<()>());
        let cancel = async {
            tokio::task::yield_now().await;
            cancel_download("mod:5".to_string());
        };
        let (fetched, ()) = futures::join!(fetch, cancel);
        assert!(fetched.is_none());
    }

    #[test]
    fn an_unfinished_download_deletes_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("partial.zip");
        std::fs::write(&path, b"part").unwrap();
        drop(TempDownload {
            path: path.clone(),
            complete: false,
        });
        assert!(!path.exists());
    }

    #[test]
    fn a_finished_download_leaves_no_entry_but_keeps_a_newer_one() {
        let first = Cancellable::register("file:3:4");
        let second = Cancellable::register("file:3:4");
        drop(first);
        assert!(cancels().lock().unwrap().contains_key("file:3:4"));
        drop(second);
        assert!(!cancels().lock().unwrap().contains_key("file:3:4"));
    }
}
