use futures::StreamExt;
use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncWrite, AsyncWriteExt};
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

/// Downloads url to a temp file and emits cumulative progress at a bounded rate.
pub async fn download_file(
    app: &AppHandle,
    url: &str,
    ext: &str,
    download_id: &str,
    game_id: Option<&str>,
) -> Result<PathBuf, String> {
    let dest = std::env::temp_dir().join(format!("modrex-{}.{}", Uuid::new_v4(), ext));

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
