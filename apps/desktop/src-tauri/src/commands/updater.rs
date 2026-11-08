use super::settings::{read_settings, update_channel, update_settings, UpdateChannel};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tokio::sync::Mutex;

const RELEASES_URL: &str = "https://github.com/modrexio/modrex/releases";
const NIGHTLY_ENDPOINT: &str =
    "https://github.com/modrexio/modrex/releases/download/nightly/latest.json";

// The whole check request, connecting included.
const CHECK_LIMIT: Duration = Duration::from_secs(5);
const CONNECT_LIMIT: Duration = Duration::from_secs(3);
// The longest wait for the next bytes. A download has no total limit, so a slow link
// still finishes while a stalled one fails.
const READ_STALL_LIMIT: Duration = Duration::from_secs(8);

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

// Every updater shares these limits, since the plugin sets none and a stalled request would
// never end. Stable keeps the endpoint from tauri.conf.json, which check-updater.mts validates.
fn updater_for(
    app: &AppHandle,
    channel: UpdateChannel,
) -> tauri_plugin_updater::Result<Updater> {
    let builder = app
        .updater_builder()
        .timeout(CHECK_LIMIT)
        .configure_client(|client| {
            client
                .connect_timeout(CONNECT_LIMIT)
                .read_timeout(READ_STALL_LIMIT)
        })
        // The default hook hides every window ahead of the installer launch, so a launch that
        // fails would leave Modrex running with nothing on screen.
        .on_before_exit(|| {});
    if channel == UpdateChannel::Stable {
        return builder.build();
    }
    let endpoint =
        tauri::Url::parse(NIGHTLY_ENDPOINT).expect("the nightly endpoint is a valid URL");
    builder.endpoints(vec![endpoint])?.build()
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

/// Moves a stable build to the newest nightly and restarts. Returns false when no nightly is newer.
#[tauri::command]
#[specta::specta]
pub async fn install_nightly(app: AppHandle) -> Result<bool, String> {
    let result = move_to_nightly(&app).await;
    if let Err(e) = &result {
        log::warn!("install_nightly: {e}");
    }
    result
}

async fn move_to_nightly(app: &AppHandle) -> Result<bool, String> {
    let updater = updater_for(app, UpdateChannel::Nightly)
        .map_err(|e| format!("could not prepare the update check: {e}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("the update check failed: {e}"))?
    else {
        return Ok(false);
    };
    let bytes = download(app, &update).await?;

    // Saved before installing because the Windows installer ends this process.
    let previous = update_settings(app, |s| s.update_channel.replace(UpdateChannel::Nightly));
    if let Err(e) = update.install(bytes) {
        update_settings(app, |s| s.update_channel = previous);
        return Err(e.to_string());
    }
    app.restart()
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

async fn download(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    let downloaded = Arc::new(AtomicUsize::new(0));
    let downloaded_clone = Arc::clone(&downloaded);
    let app_progress = app.clone();

    update
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
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let guard = state.update.lock().await;
    let update = guard.as_ref().ok_or("no pending update")?;
    let bytes = download(&app, update).await?;
    drop(guard);
    *state.bytes.lock().await = Some(bytes);
    let _ = app.emit("updater:update-ready", ());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let result = install_downloaded(&app).await;
    if let Err(e) = &result {
        log::warn!("install_update: {e}");
    }
    result
}

// The update and its bytes stay in place when installing fails, so the next click retries.
// Neither lock is held while installing, which can wait on a password prompt on Linux.
async fn install_downloaded(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let update = state
        .update
        .lock()
        .await
        .clone()
        .ok_or("no pending update")?;
    let bytes = state
        .bytes
        .lock()
        .await
        .take()
        .ok_or("update not downloaded")?;
    if let Err(e) = update.install(&bytes) {
        *state.bytes.lock().await = Some(bytes);
        return Err(e.to_string());
    }
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
