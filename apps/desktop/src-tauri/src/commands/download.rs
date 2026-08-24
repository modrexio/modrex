use futures::StreamExt;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub download_id: String,
    pub downloaded: u64,
    pub total: u64,
}

/// Downloads url to a temp file with the given extension, emitting download:progress
/// events as chunks arrive. Returns the temp file path.
pub async fn download_file(
    app: &AppHandle,
    url: &str,
    ext: &str,
    download_id: &str,
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

    let total = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| e.to_string())?;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        let _ = app.emit(
            "download:progress",
            DownloadProgress {
                download_id: download_id.to_string(),
                downloaded,
                total,
            },
        );
    }

    file.flush().await.map_err(|e| e.to_string())?;
    Ok(dest)
}
