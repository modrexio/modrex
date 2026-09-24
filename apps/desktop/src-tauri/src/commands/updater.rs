use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

pub struct UpdaterState {
    pub update: Mutex<Option<tauri_plugin_updater::Update>>,
    pub bytes: Mutex<Option<Vec<u8>>>,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self {
            update: Mutex::new(None),
            bytes: Mutex::new(None),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn check_for_update(app: AppHandle) -> Result<(), String> {
    let Ok(updater) = app.updater() else {
        return Ok(());
    };
    let Ok(Some(update)) = updater.check().await else {
        return Ok(());
    };

    let version = update.version.clone();
    let body = update.body.clone().unwrap_or_default();
    let release_url = format!(
        "https://github.com/modrexio/modrex/releases/tag/v{}",
        version
    );

    let state = app.state::<UpdaterState>();
    *state.update.lock().await = Some(update);

    let _ = app.emit(
        "updater:update-available",
        serde_json::json!({
            "version": version,
            "strategy": "manual",
            "body": body,
            "releaseUrl": release_url,
        }),
    );

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let guard = state.update.lock().await;
    let update = guard.as_ref().ok_or("no pending update")?;

    let downloaded = Arc::new(AtomicUsize::new(0));
    let downloaded_clone = Arc::clone(&downloaded);
    let app_progress = app.clone();

    let bytes = update
        .download(
            move |chunk, total| {
                let so_far = downloaded_clone.fetch_add(chunk, Ordering::Relaxed) + chunk;
                let percent = total
                    .map(|t| (so_far * 100 / t as usize) as u32)
                    .unwrap_or(0);
                let _ = app_progress.emit("updater:update-progress", percent);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    drop(guard);
    *state.bytes.lock().await = Some(bytes);
    let _ = app.emit("updater:update-ready", ());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let update = state
        .update
        .lock()
        .await
        .take()
        .ok_or("no pending update")?;
    let bytes = state
        .bytes
        .lock()
        .await
        .take()
        .ok_or("update not downloaded")?;
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart()
}
