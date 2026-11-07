use super::settings::{read_settings, update_channel, update_settings, UpdateChannel};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Updater, UpdaterExt};
use tokio::sync::Mutex;

const RELEASES_URL: &str = "https://github.com/modrexio/modrex/releases";
const NIGHTLY_ENDPOINT: &str =
    "https://github.com/modrexio/modrex/releases/download/nightly/latest.json";

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

fn release_url(channel: UpdateChannel, version: &str) -> String {
    match channel {
        UpdateChannel::Stable => format!("{RELEASES_URL}/tag/v{version}"),
        UpdateChannel::Nightly => format!("{RELEASES_URL}/tag/nightly"),
    }
}

// Stable keeps the endpoint from tauri.conf.json, which check-updater.mts validates.
fn updater_for(app: &AppHandle, channel: UpdateChannel) -> tauri_plugin_updater::Result<Updater> {
    if channel == UpdateChannel::Stable {
        return app.updater();
    }
    let endpoint =
        tauri::Url::parse(NIGHTLY_ENDPOINT).expect("the nightly endpoint is a valid URL");
    app.updater_builder().endpoints(vec![endpoint])?.build()
}

/// Returns the version found, or None when this build is up to date.
#[tauri::command]
#[specta::specta]
pub async fn check_for_update(app: AppHandle) -> Result<Option<String>, String> {
    let app_version = app.package_info().version.to_string();
    let channel = update_channel(&read_settings(&app), &app_version);
    let updater = updater_for(&app, channel)
        .map_err(|e| format!("could not prepare the update check: {e}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("the update check failed: {e}"))?
    else {
        return Ok(None);
    };

    let version = update.version.clone();
    let body = update.body.clone().unwrap_or_default();
    let release_url = release_url(channel, &version);

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

    Ok(Some(version))
}

/// Saves the channel and forgets any update found on the previous one.
#[tauri::command]
#[specta::specta]
pub async fn set_update_channel(app: AppHandle, channel: UpdateChannel) {
    update_settings(&app, |s| s.update_channel = Some(channel));
    let state = app.state::<UpdaterState>();
    *state.update.lock().await = None;
    *state.bytes.lock().await = None;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_links_to_its_version_tag() {
        assert_eq!(
            release_url(UpdateChannel::Stable, "0.17.0"),
            "https://github.com/modrexio/modrex/releases/tag/v0.17.0"
        );
    }

    #[test]
    fn nightly_links_to_the_rolling_release() {
        assert_eq!(
            release_url(UpdateChannel::Nightly, "0.17.0-nightly.20261107.1"),
            "https://github.com/modrexio/modrex/releases/tag/nightly"
        );
    }
}
