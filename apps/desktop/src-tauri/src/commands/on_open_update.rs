//! Installing a newer nightly when a nightly build opens, before the renderer starts.
//!
//! The startup hold in startup.rs keeps React from mounting while this runs, and every path
//! here ends by releasing it, so Modrex always opens when no install takes over. Progress
//! across opens lives in app_data_dir()/update-state.json:
//!
//!   stepStarted    set when an open starts the step and cleared when its work ends, so an
//!                  open that died inside the step makes the next one skip it once.
//!   failedStarts   opens that never reached ready. Cleared by the renderer's ready report.
//!   record         the install attempt away from this build: from, to and attempts.
//!
//! A verified package waits in app_cache_dir()/updates/<version>.update for the next open
//! when the splash stops waiting before its download ends. It is installed only while the
//! live feed still offers that exact version.

use super::launchers::try_shell_open_external;
use super::mods::write_atomic;
use super::settings::{read_settings, update_channel, UpdateChannel};
use super::startup::{StartupState, UpdatedNotice};
use super::updater::{check_for_update, release_url, updater_for};
use futures::future::{select, Either};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::utils::{config::BundleType, platform::bundle_type};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::Update;
use tokio::sync::watch;

/// How long the splash waits for a download before Modrex opens and the download continues.
const SPLASH_DOWNLOAD_WAIT: Duration = Duration::from_secs(25);
/// Time since launch after which the splash offers its recovery button even if startup
/// never finished.
const WATCHDOG: Duration = Duration::from_secs(60);
const MAX_INSTALL_ATTEMPTS: u32 = 2;
const FAILED_STARTS_BEFORE_DIALOG: u32 = 3;

/// Whether this build holds the renderer at open. Debug builds never do, so a development
/// run cannot install a release over itself.
pub(crate) fn holding_build() -> bool {
    cfg!(not(debug_assertions)) && env!("CARGO_PKG_VERSION").contains("-nightly.")
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct UpdateState {
    step_started: bool,
    failed_starts: u32,
    record: Option<InstallRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct InstallRecord {
    from: String,
    to: String,
    attempts: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenAction {
    /// No step runs, and the pop-up offers any update.
    KeepPopup,
    /// The last install landed on this build.
    Updated,
    /// The last open died inside the step, or its state could not be read.
    SkipOnce,
    RunStep,
}

struct OpenFacts<'a> {
    running: &'a str,
    channel: UpdateChannel,
    bundle: Option<BundleType>,
    launched_by_link: bool,
    /// None when the state file exists but could not be read or parsed.
    state: Option<&'a UpdateState>,
}

fn plan_open(facts: &OpenFacts) -> OpenAction {
    if !facts.running.contains("-nightly.") {
        return OpenAction::KeepPopup;
    }
    let Some(state) = facts.state else {
        return OpenAction::SkipOnce;
    };
    if state.record.as_ref().is_some_and(|r| r.to == facts.running) {
        return OpenAction::Updated;
    }
    if facts.channel != UpdateChannel::Nightly {
        return OpenAction::KeepPopup;
    }
    // .deb and RPM installs ask for a password, so they keep the pop-up.
    if !matches!(facts.bundle, Some(BundleType::Nsis | BundleType::AppImage)) {
        return OpenAction::KeepPopup;
    }
    if facts.launched_by_link {
        return OpenAction::KeepPopup;
    }
    if state.step_started {
        return OpenAction::SkipOnce;
    }
    OpenAction::RunStep
}

/// What an open persists before any network work. It sets or consumes the step mark.
fn state_at_open(previous: &UpdateState, action: OpenAction, running: &str) -> UpdateState {
    UpdateState {
        step_started: action == OpenAction::RunStep,
        failed_starts: previous.failed_starts.saturating_add(1),
        // Only an attempt away from this exact build is still live. Arriving at its target,
        // or running any other version, retires it.
        record: previous.record.clone().filter(|r| r.from == running),
    }
}

fn warn_failed_starts(previous: &UpdateState) -> bool {
    previous.failed_starts >= FAILED_STARTS_BEFORE_DIALOG
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FoundAction {
    Popup,
    InstallSaved,
    Download,
}

fn plan_found(found: &str, record: Option<&InstallRecord>, saved: bool) -> FoundAction {
    if record.is_some_and(|r| r.to == found && r.attempts >= MAX_INSTALL_ATTEMPTS) {
        return FoundAction::Popup;
    }
    if saved {
        return FoundAction::InstallSaved;
    }
    FoundAction::Download
}

fn state_for_install(current: &UpdateState, from: &str, to: &str) -> UpdateState {
    let attempts = current
        .record
        .as_ref()
        .filter(|r| r.to == to)
        .map_or(0, |r| r.attempts);
    UpdateState {
        step_started: false,
        // The installer ends this process on purpose, so this open is not a failed start.
        failed_starts: current.failed_starts.saturating_sub(1),
        record: Some(InstallRecord {
            from: from.into(),
            to: to.into(),
            attempts: attempts + 1,
        }),
    }
}

/// A package from the live feed that fails its signature stops installing on open for that
/// version, as if it had failed every attempt.
fn state_for_rejected(current: &UpdateState, from: &str, to: &str) -> UpdateState {
    UpdateState {
        record: Some(InstallRecord {
            from: from.into(),
            to: to.into(),
            attempts: MAX_INSTALL_ATTEMPTS,
        }),
        ..current.clone()
    }
}

fn is_signature_error(error: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error;
    matches!(
        error,
        Error::Minisign(_)
            | Error::Base64(_)
            | Error::SignatureUtf8(_)
            | Error::SignedVersionMismatch { .. }
            | Error::MissingSignedVersion
    )
}

/// What the renderer's update check after the gate should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fallback {
    /// The step still owns the update.
    Pending,
    /// Run the ordinary update check, which raises the pop-up.
    Popup,
    /// Nothing to offer this session.
    Done,
}

pub struct OnOpenUpdate {
    fallback: watch::Sender<Fallback>,
    // Bumped by a channel change, so a download that finishes afterwards is discarded.
    epoch: AtomicU64,
    // Serializes saving a package with a channel change deleting the saved packages.
    cache_lock: tokio::sync::Mutex<()>,
}

impl OnOpenUpdate {
    pub fn new(holding: bool) -> Self {
        Self {
            fallback: watch::Sender::new(if holding {
                Fallback::Pending
            } else {
                Fallback::Popup
            }),
            epoch: AtomicU64::new(0),
            cache_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) fn owns_update(&self) -> bool {
        *self.fallback.borrow() == Fallback::Pending
    }
}

// The step, the ready report, a background download and the exit handler can all write the
// state file in one session.
static STATE_LOCK: Mutex<()> = Mutex::new(());

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data folder: {e}"))?;
    Ok(dir.join("update-state.json"))
}

fn read_state(path: &Path) -> Result<UpdateState, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(UpdateState::default()),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    serde_json::from_slice(&bytes).map_err(|e| format!("could not parse {}: {e}", path.display()))
}

fn write_state(path: &Path, state: &UpdateState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).expect("the update state serializes");
    write_atomic(path, &bytes)
}

/// Applies a change to the saved state, writing only when something changed.
fn update_state(app: &AppHandle, change: impl FnOnce(&mut UpdateState)) -> Result<(), String> {
    let path = state_path(app)?;
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = read_state(&path)?;
    let before = state.clone();
    change(&mut state);
    if state == before {
        return Ok(());
    }
    write_state(&path, &state)
}

/// The renderer's first ready report on a holding build: this open started cleanly.
pub(crate) fn reached_ready(app: &AppHandle) {
    if let Err(e) = update_state(app, |s| s.failed_starts = 0) {
        log::warn!("could not record that startup finished: {e}");
    }
}

/// Run on every exit of a holding build and when the step's work ends, so only an open that
/// died inside the step leaves the mark behind.
pub(crate) fn clear_step_mark(app: &AppHandle) {
    if let Err(e) = update_state(app, |s| s.step_started = false) {
        log::warn!("could not clear the update step mark, so the next open skips it: {e}");
    }
}

fn record_open(
    app: &AppHandle,
    running: &str,
    channel: UpdateChannel,
    launched_by_link: bool,
) -> (OpenAction, Option<InstallRecord>) {
    let path = match state_path(app) {
        Ok(path) => path,
        Err(e) => {
            log::warn!("no update state, so Modrex opens without updating: {e}");
            return (OpenAction::KeepPopup, None);
        }
    };
    let guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let previous = read_state(&path)
        .inspect_err(|e| log::warn!("skipping the update once and rewriting its state: {e}"))
        .ok();
    let action = plan_open(&OpenFacts {
        running,
        channel,
        bundle: bundle_type(),
        launched_by_link,
        state: previous.as_ref(),
    });
    let empty = UpdateState::default();
    let mut next = state_at_open(previous.as_ref().unwrap_or(&empty), action, running);
    // A launch link releases the hold before this runs, so ready may already be reported.
    if app.state::<StartupState>().is_ready() {
        next.failed_starts = 0;
    }
    let written = write_state(&path, &next);
    drop(guard);

    if previous.as_ref().is_some_and(warn_failed_starts) {
        show_failed_starts_dialog(app, running);
    }
    if let Err(e) = written {
        log::warn!("could not record this open: {e}");
        // Without the mark a step that crashes would run again on every open.
        if action == OpenAction::RunStep {
            return (OpenAction::KeepPopup, None);
        }
    }
    (action, next.record)
}

fn show_failed_starts_dialog(app: &AppHandle, running: &str) {
    log::warn!(
        "Modrex did not finish starting {FAILED_STARTS_BEFORE_DIALOG} or more times in a row"
    );
    let url = release_url(UpdateChannel::Nightly, running);
    let mut dialog = app
        .dialog()
        .message(
            "Modrex did not finish starting the last few times it opened. If it keeps failing, \
             download the newest nightly from its release page and install it over this one.",
        )
        .kind(MessageDialogKind::Warning);
    // Owned by main, which startup later brings to the front, so the dialog stays above it.
    // Not the splash: closing an owner window destroys the windows it owns.
    match app.get_webview_window("main") {
        Some(main) => dialog = dialog.parent(&main),
        None => log::warn!("no main window to own the failed starts dialog"),
    }
    dialog
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open release page".into(),
            "Close".into(),
        ))
        .show(move |open| {
            if !open {
                return;
            }
            if let Err(e) = try_shell_open_external(&url) {
                log::warn!("could not open the nightly release page: {e}");
            }
        });
}

/// The update step of a holding build's open.
pub(crate) async fn run(app: AppHandle, launched_by_link: bool) {
    let running = app.package_info().version.to_string();
    let channel = update_channel(&read_settings(&app), &running);
    let (action, record) = record_open(&app, &running, channel, launched_by_link);
    match action {
        OpenAction::KeepPopup | OpenAction::SkipOnce => conclude(&app, Fallback::Popup),
        OpenAction::Updated => {
            sweep_saved_updates(&app, None).await;
            app.state::<StartupState>().set_notice(UpdatedNotice {
                release_url: release_url(UpdateChannel::Nightly, &running),
                version: running,
            });
            conclude(&app, Fallback::Popup);
        }
        OpenAction::RunStep => step(&app, &running, record).await,
    }
}

async fn step(app: &AppHandle, running: &str, record: Option<InstallRecord>) {
    // Read before the check, so a channel change while it runs also discards its download.
    let epoch = app.state::<OnOpenUpdate>().epoch.load(Ordering::SeqCst);
    let Some(update) = find_update(app).await else {
        return finish(app, Fallback::Done);
    };
    let saved = match saved_update_path(app, &update.version) {
        Ok(path) => path,
        Err(e) => {
            log::warn!("no saved update folder, so Modrex opens without updating: {e}");
            return finish(app, Fallback::Popup);
        }
    };
    sweep_saved_updates(app, Some(&update.version)).await;
    match plan_found(&update.version, record.as_ref(), saved.is_file()) {
        FoundAction::Popup => {
            log::warn!(
                "update {} failed to install on open before, so it waits for a click",
                update.version
            );
            finish(app, Fallback::Popup);
        }
        FoundAction::InstallSaved => install_saved(app, running, update, saved).await,
        FoundAction::Download => download(app, running, update, epoch).await,
    }
}

// A failed or missing check opens Modrex and never counts as a failed install. A feed that
// keeps its version but lists no platforms fails here, which is how a nightly is paused.
async fn find_update(app: &AppHandle) -> Option<Update> {
    let updater = updater_for(app, UpdateChannel::Nightly)
        .inspect_err(|e| log::warn!("could not prepare the update on open: {e}"))
        .ok()?;
    let found = updater
        .check()
        .await
        .inspect_err(|e| log::warn!("the update check on open failed: {e}"))
        .ok()??;
    // The feed is not signed, so binding the version to the package signature is what stops
    // a higher version number from carrying an older signed package.
    updater
        .restore_update(found.raw_json)
        .inspect_err(|e| log::warn!("the update on open could not be bound: {e}"))
        .ok()?
}

async fn install_saved(app: &AppHandle, running: &str, update: Update, saved: PathBuf) {
    let candidate = update.clone();
    let path = saved.clone();
    let verified = tauri::async_runtime::spawn_blocking(move || {
        let bytes =
            std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
        candidate.verify(&bytes).map_err(|e| e.to_string())?;
        Ok::<_, String>(bytes)
    })
    .await
    .expect("verifying the saved update does not panic");
    match verified {
        Ok(bytes) => install(app, running, update, bytes).await,
        Err(e) => {
            log::warn!(
                "the saved update {} is rejected and deleted: {e}",
                update.version
            );
            if let Err(e) = std::fs::remove_file(&saved) {
                log::warn!("could not delete {}: {e}", saved.display());
            }
            finish(app, Fallback::Popup);
        }
    }
}

#[derive(Debug)]
enum FetchFailure {
    Signature(String),
    Failed,
    Stale,
}

async fn download(app: &AppHandle, running: &str, update: Update, epoch: u64) {
    let startup = app.state::<StartupState>();
    let waiting = startup.set_updating(app);
    // An owned task, because ending the wait must not cancel the download.
    let mut fetch = tauri::async_runtime::spawn(fetch(app.clone(), update, epoch));
    if waiting {
        let released = std::pin::pin!(gate_released(startup.subscribe()));
        match tokio::time::timeout(SPLASH_DOWNLOAD_WAIT, select(&mut fetch, released)).await {
            Ok(Either::Left((Ok(Ok((update, bytes))), _))) => {
                return install(app, running, update, bytes).await;
            }
            Ok(Either::Left((result, _))) => return settle(app, running, result),
            // The splash was skipped, so the download finishes for the next open.
            Ok(Either::Right(_)) => {}
            Err(_) => {
                log::info!(
                    "the update is still downloading, so Modrex opens and installs it next time"
                );
                startup.release(app);
            }
        }
    }
    let result = fetch.await;
    settle(app, running, result);
}

async fn gate_released(mut released: watch::Receiver<bool>) {
    released
        .wait_for(|open| *open)
        .await
        .expect("the startup state outlives the update step");
}

// Downloads, verifies and saves. It never installs, so a download that outlives the splash
// can only serve the next open.
async fn fetch(
    app: AppHandle,
    update: Update,
    epoch: u64,
) -> Result<(Update, Vec<u8>), FetchFailure> {
    let progress = app.clone();
    let mut received = 0usize;
    let downloaded = update
        .download(
            move |chunk, total| {
                received += chunk;
                if !progress.state::<StartupState>().holding() {
                    return;
                }
                let percent = total.map_or(0, |t| (received as u64 * 100 / t) as u32);
                let _ = progress.emit_to("splash", "updater:update-progress", percent);
            },
            || {},
        )
        .await;
    let bytes = match downloaded {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!(
                "the update {} failed to download on open: {e}",
                update.version
            );
            if is_signature_error(&e) {
                return Err(FetchFailure::Signature(update.version.clone()));
            }
            return Err(FetchFailure::Failed);
        }
    };
    let bytes = save(&app, &update.version, bytes, epoch).await?;
    Ok((update, bytes))
}

async fn save(
    app: &AppHandle,
    version: &str,
    bytes: Vec<u8>,
    epoch: u64,
) -> Result<Vec<u8>, FetchFailure> {
    let on_open = app.state::<OnOpenUpdate>();
    let _guard = on_open.cache_lock.lock().await;
    if on_open.epoch.load(Ordering::SeqCst) != epoch {
        log::info!("the update channel changed while {version} downloaded, so it is discarded");
        return Err(FetchFailure::Stale);
    }
    let path = match saved_update_path(app, version) {
        Ok(path) => path,
        Err(e) => {
            log::warn!("could not save update {version} for the next open: {e}");
            return Ok(bytes);
        }
    };
    let (bytes, written) = tauri::async_runtime::spawn_blocking(move || {
        let written = write_atomic(&path, &bytes);
        (bytes, written)
    })
    .await
    .expect("saving the update does not panic");
    if let Err(e) = written {
        log::warn!("could not save update {version} for the next open: {e}");
    }
    Ok(bytes)
}

fn settle(
    app: &AppHandle,
    running: &str,
    result: tauri::Result<Result<(Update, Vec<u8>), FetchFailure>>,
) {
    let fallback = match result {
        Ok(Ok(_)) | Ok(Err(FetchFailure::Stale)) => Fallback::Done,
        Ok(Err(FetchFailure::Failed)) => Fallback::Popup,
        Ok(Err(FetchFailure::Signature(version))) => {
            if let Err(e) = update_state(app, |s| *s = state_for_rejected(s, running, &version)) {
                log::warn!("could not record that {version} failed its signature: {e}");
            }
            Fallback::Popup
        }
        Err(e) => {
            log::warn!("the update download on open ended unexpectedly: {e}");
            Fallback::Popup
        }
    };
    finish(app, fallback);
}

async fn install(app: &AppHandle, running: &str, update: Update, bytes: Vec<u8>) {
    let startup = app.state::<StartupState>();
    // Claimed before the attempt is recorded, so no release or ready report can change the
    // state between the two. Nothing runs after the installer takes over, so the record
    // is written before it starts.
    if !startup.begin_install() {
        return finish(app, Fallback::Done);
    }
    if let Err(e) = update_state(app, |s| *s = state_for_install(s, running, &update.version)) {
        log::warn!("could not record the install attempt, so Modrex opens without it: {e}");
        startup.end_install(app);
        return finish(app, Fallback::Popup);
    }

    if let Err(e) = app.emit_to("splash", "updater:update-ready", ()) {
        log::warn!("could not hide the splash button before installing: {e}");
    }
    let version = update.version.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(&bytes)).await;
    // On Windows a successful install ends this process. Linux relaunches from here, off the
    // main thread, so the exit events still run.
    let failure = match installed {
        Ok(Ok(())) => app.restart(),
        Ok(Err(e)) => e.to_string(),
        Err(e) => e.to_string(),
    };
    log::warn!("the update to {version} did not install, so Modrex opens: {failure}");
    startup.end_install(app);
    conclude(app, Fallback::Popup);
}

fn finish(app: &AppHandle, fallback: Fallback) {
    clear_step_mark(app);
    conclude(app, fallback);
}

fn conclude(app: &AppHandle, fallback: Fallback) {
    app.state::<OnOpenUpdate>().fallback.send_replace(fallback);
    app.state::<StartupState>().release(app);
}

fn saved_updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no app cache folder: {e}"))?;
    Ok(dir.join("updates"))
}

// The name carries the version, so the rename commits both together. A semver version holds
// no path separators, and its dots rule out with_extension.
fn saved_update_path(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    Ok(saved_updates_dir(app)?.join(format!("{version}.update")))
}

/// Deletes every saved package other than keep's, leftover temporary files included.
async fn sweep_saved_updates(app: &AppHandle, keep: Option<&str>) {
    let dir = match saved_updates_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            log::warn!("could not clear saved updates: {e}");
            return;
        }
    };
    let keep = keep.map(|version| format!("{version}.update"));
    let on_open = app.state::<OnOpenUpdate>();
    let _guard = on_open.cache_lock.lock().await;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("could not list {}: {e}", dir.display());
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!("could not list {}: {e}", dir.display());
                continue;
            }
        };
        if keep
            .as_deref()
            .is_some_and(|keep| entry.file_name() == keep)
        {
            continue;
        }
        let path = entry.path();
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("could not delete {}: {e}", path.display());
        }
    }
}

/// A channel change: a download still running is discarded and nothing saved is installed.
pub(crate) async fn forget_saved_updates(app: &AppHandle) {
    app.state::<OnOpenUpdate>()
        .epoch
        .fetch_add(1, Ordering::SeqCst);
    sweep_saved_updates(app, None).await;
}

/// The watchdog of a holding build's open.
pub(crate) async fn watchdog(app: AppHandle) {
    tokio::time::sleep(WATCHDOG).await;
    app.state::<StartupState>().expire(&app);
}

/// The renderer's update check after the startup gate. Rust decides whether the pop-up
/// runs, and the renderer asks after mount so the pop-up's listener is registered.
#[tauri::command]
#[specta::specta]
pub async fn check_after_startup_gate(app: AppHandle) -> Result<Option<String>, String> {
    let outcome = *app
        .state::<OnOpenUpdate>()
        .fallback
        .subscribe()
        .wait_for(|f| *f != Fallback::Pending)
        .await
        .map_err(|_| "the update on open ended without an outcome".to_string())?;
    if outcome == Fallback::Done {
        return Ok(None);
    }
    check_for_update(app).await
}

#[cfg(test)]
#[path = "on_open_update_tests.rs"]
mod tests;
