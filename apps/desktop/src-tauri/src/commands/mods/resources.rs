//! Reviewed installation of movie packs and Engine.ini presets, their enable, disable and
//! uninstall operations, their installed-list rows, and the Engine.ini editor sessions.
//!
//! Every write goes through resource_state's journaled apply while holding the destination
//! path locks and the manifest lock, after recovering any interrupted operation for the game
//! and confirming the game is not running. Nothing here performs network I/O.

use super::cleanup::{self, CleanupPlan};
use super::identity::IdentityEvidence;
use super::ini;
use super::movies;
use super::naming::hash_filename;
use super::resource_state::{
    deployment_paths, live_content, overlapping_paths, refuse_read_only, sha256_hex, Content,
    Deployment, DeploymentBody, IniPreset, IniRevision, Manifest, MovieSlot, ResourceGuard,
    ResourceLocks, ResourceStore, Step,
};
use super::types::{InstalledMod, ResourceDeployment, ResourceStatus, UpdateStatus};
use super::zip::{extract_entry_at_budget, safe_dest, ResourceArchive, ZipMultiPakPayload};
use crate::commands::settings::{game_settings, read_settings};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub(crate) const RESOURCE_UID_PREFIX: &str = "resource:";

pub(crate) fn is_resource_uid(uid: &str) -> bool {
    uid.starts_with(RESOURCE_UID_PREFIX)
}

/// Refusal for every ordinary operation that would treat a resource row as a mod file.
pub(crate) fn refuse_resource_uid(uid: &str, operation: &str) -> Result<(), String> {
    if is_resource_uid(uid) {
        return Err(format!(
            "{operation} does not apply to movie packs or Engine.ini presets"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// IPC shapes
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReviewPayload {
    pub review_handle: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ResourceEntryKind {
    Movie,
    Ini,
    Other,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReviewEntry {
    pub entry_id: u32,
    pub name: String,
    pub kind: ResourceEntryKind,
    pub supported: bool,
    pub reason: Option<String>,
    pub changes: Vec<super::resource_state::KeyChange>,
    pub keys: Vec<ResourceIniKey>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceIniKey {
    pub section: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMovieConflict {
    pub name: String,
    pub slots: Vec<String>,
    pub replacing: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceIniConflict {
    pub name: String,
    pub changes: Vec<super::resource_state::KeyChange>,
    pub replacing: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReview {
    pub review_handle: String,
    pub game_id: String,
    pub game_path: String,
    pub mod_name: String,
    pub entries: Vec<ResourceReviewEntry>,
    pub movie_slots: Vec<String>,
    pub config_path: Option<String>,
    pub pak_picker: Option<ZipMultiPakPayload>,
    /// The catalog the download came from, None for a dropped file. A Nexus review's packages
    /// install through install_nexus_review_pak, never the ModWorkshop entry installer.
    pub source: Option<String>,
    pub movie_pack_applied: bool,
    pub movie_conflicts: Vec<ResourceMovieConflict>,
    pub ini_conflicts: Vec<ResourceIniConflict>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSelection {
    pub entry_id: u32,
    pub slot: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInstallResult {
    pub installed: bool,
    pub already_current_movies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IniEditorSession {
    pub session_handle: String,
    pub context_key: String,
    pub game_id: String,
    pub game_path: String,
    pub path: String,
    pub text: String,
    pub read_only: bool,
    pub read_only_reason: Option<String>,
    pub sha256: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRecoveryFile {
    pub path: String,
    pub current: Content,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRecoveryReview {
    pub review_handle: String,
    pub game_id: String,
    pub deployments: Vec<String>,
    pub files: Vec<ResourceRecoveryFile>,
}

/// Where a reviewed download came from. Independent of the catalog: a dropped file has none.
#[derive(Debug, Clone)]
pub(crate) struct Provenance {
    pub name: String,
    pub version: String,
    pub source: Option<String>,
    pub remote_id: Option<String>,
    pub file_id: Option<i64>,
    pub author: Option<String>,
    pub thumbnail_url: Option<String>,
}

// ---------------------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------------------

/// The install a resource operation is bound to: the saved game path and launcher.
#[derive(Debug, Clone, PartialEq, Eq)]
struct InstallContext {
    game_id: String,
    game_path: String,
    canonical_game_path: String,
    launcher: Option<String>,
}

fn current_context(app: &AppHandle, game_id: &str) -> Result<InstallContext, String> {
    let settings = read_settings(app);
    let gs =
        game_settings(&settings, game_id).ok_or_else(|| format!("{game_id} is not configured"))?;
    let game_path = gs
        .game_path
        .clone()
        .ok_or_else(|| format!("{game_id} has no game folder set"))?;
    let canonical_game_path = std::fs::canonicalize(&game_path)
        .map_err(|error| format!("The game folder could not be resolved: {error}"))?
        .to_string_lossy()
        .into_owned();
    Ok(InstallContext {
        game_id: game_id.to_string(),
        game_path,
        canonical_game_path,
        launcher: gs.launcher.clone(),
    })
}

/// Rejects an operation whose install changed since it was prepared.
fn require_context(app: &AppHandle, bound: &InstallContext) -> Result<(), String> {
    if current_context(app, &bound.game_id)? != *bound {
        return Err(
            "the selected game install or store changed since this was prepared; nothing was written"
                .to_string(),
        );
    }
    Ok(())
}

fn locks(app: &AppHandle) -> &ResourceLocks {
    app.state::<ResourceLocks>().inner()
}

async fn ensure_not_running(game_id: &str) -> Result<(), String> {
    let id = game_id.to_string();
    let running =
        tauri::async_runtime::spawn_blocking(move || crate::commands::launchers::game_running(&id))
            .await
            .map_err(|e| e.to_string())??;
    if running {
        return Err(
            "close the game first; Modrex does not change movies or Engine.ini while it runs"
                .to_string(),
        );
    }
    Ok(())
}

/// Takes the locks for paths, then recovers any interrupted operation for the game.
async fn lock_and_recover(
    app: &AppHandle,
    game_id: &str,
    paths: &[PathBuf],
) -> Result<(ResourceGuard, ResourceStore), String> {
    ensure_not_running(game_id).await?;
    let guard = locks(app).acquire(paths).await;
    let store = ResourceStore::for_app(app)?;
    let (ownership_store, bound_game, bound_paths) =
        (store.clone(), game_id.to_string(), paths.to_vec());
    let affected = blocking(move || {
        let mut destinations = bound_paths;
        if ownership_store.has_pending(&bound_game)? {
            destinations.extend(ownership_store.recovery_paths(&bound_game)?.1);
        }
        let manifest = ownership_store.load_manifest()?;
        Ok(affected_games(&manifest, &bound_game, &destinations))
    })
    .await?;
    for game in &affected {
        ensure_not_running(game).await?;
    }
    let (s, id) = (store.clone(), game_id.to_string());
    tauri::async_runtime::spawn_blocking(move || s.recover(&id))
        .await
        .map_err(|e| e.to_string())??;
    for game in &affected {
        ensure_not_running(game).await?;
    }
    Ok((guard, store))
}

fn affected_games(manifest: &Manifest, game_id: &str, paths: &[PathBuf]) -> Vec<String> {
    let paths = overlapping_paths(manifest, paths);
    let mut games: Vec<_> = manifest
        .deployments
        .iter()
        .filter(|d| deployment_paths(d).iter().any(|path| paths.contains(path)))
        .map(|d| d.game_id.clone())
        .collect();
    games.push(game_id.to_string());
    games.sort();
    games.dedup();
    games
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Launch preflight: interrupted resource operations must finish or fail visibly, and every
/// record must still reach its recovery data.
pub(crate) async fn launch_preflight(app: &AppHandle, game_id: &str) -> Result<(), String> {
    if !movies::supports_movies(game_id) {
        return Ok(());
    }
    let store = ResourceStore::for_app(app)?;
    let _guard = locks(app).acquire(&[]).await;
    let (s, id) = (store.clone(), game_id.to_string());
    if blocking(move || s.has_pending(&id)).await? {
        let (s, id) = (store.clone(), game_id.to_string());
        let games = blocking(move || {
            let paths = s.recovery_paths(&id)?.1;
            Ok(affected_games(&s.load_manifest()?, &id, &paths))
        })
        .await?;
        for game in &games {
            ensure_not_running(game).await?;
        }
    }
    let id = game_id.to_string();
    blocking(move || store.preflight(&id)).await
}

// ---------------------------------------------------------------------------------------
// Engine.ini destinations
// ---------------------------------------------------------------------------------------

/// The one Engine.ini location with primary evidence: PAYDAY 3 on Windows Steam, from
/// ModWorkshop's PAYDAY 3 integration. Every other combination needs the user to pick it.
fn verified_engine_ini(game_id: &str, launcher: Option<&str>) -> Result<Option<PathBuf>, String> {
    #[cfg(windows)]
    {
        if game_id == "pd3" && launcher == Some("steam") {
            return local_app_data()
                .map(|dir| Some(dir.join("PAYDAY3/Saved/Config/WindowsClient/Engine.ini")));
        }
    }
    let _ = (game_id, launcher);
    Ok(None)
}

#[cfg(windows)]
fn local_app_data() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHGetKnownFolderPath(
            id: *const Guid,
            flags: u32,
            token: *mut std::ffi::c_void,
            path: *mut *mut u16,
        ) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoTaskMemFree(memory: *mut std::ffi::c_void);
    }
    let id = Guid {
        data1: 0xf1b32785,
        data2: 0x6fba,
        data3: 0x4fcf,
        data4: [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91],
    };
    let mut pointer = std::ptr::null_mut();
    let result = unsafe { SHGetKnownFolderPath(&id, 0, std::ptr::null_mut(), &mut pointer) };
    if result < 0 {
        unsafe {
            CoTaskMemFree(pointer.cast());
        }
        return Err(format!(
            "Windows could not resolve Local AppData: {result:#x}"
        ));
    }
    let mut length = 0;
    unsafe {
        while *pointer.add(length) != 0 {
            length += 1;
        }
        let path = std::ffi::OsString::from_wide(std::slice::from_raw_parts(pointer, length));
        CoTaskMemFree(pointer.cast());
        Ok(PathBuf::from(path))
    }
}

/// Checks a candidate Engine.ini and returns its canonical path. Links at the file itself and
/// hard-link aliases are refused, so a lease can never be turned into write access elsewhere.
fn validate_engine_ini(path: &Path) -> Result<PathBuf, String> {
    let is_engine_ini = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("Engine.ini"));
    if !is_engine_ini {
        return Err("only a file named Engine.ini can be opened".to_string());
    }
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or("Engine.ini has no parent folder")?
                .canonicalize()
                .map_err(|error| format!("Choose an existing configuration folder: {error}"))?;
            return Ok(parent.join(path.file_name().expect("Engine.ini filename was checked")));
        }
        Err(error) => return Err(format!("{} could not be opened: {error}", path.display())),
    };
    if !meta.file_type().is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return Err(format!("{} is hard-linked elsewhere", path.display()));
        }
    }
    path.canonicalize()
        .map_err(|e| format!("{} could not be resolved: {e}", path.display()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lease {
    Verified,
    Picked,
}

#[derive(Debug, Clone)]
struct PickedLease {
    context: InstallContext,
    path: PathBuf,
}

struct IniSession {
    context: InstallContext,
    lease: Lease,
    path: PathBuf,
    sha256: String,
    revision: Content,
    decoded: Result<ini::Decoded, String>,
}

/// Open editor sessions and the Engine.ini files the user deliberately picked this session.
#[derive(Default)]
pub struct IniSessions {
    sessions: Mutex<HashMap<String, IniSession>>,
    leases: Mutex<HashMap<String, PickedLease>>,
}

fn sessions(app: &AppHandle) -> &IniSessions {
    app.state::<IniSessions>().inner()
}

/// The Engine.ini a context resolves to: the verified location, else a lease the user picked
/// for this same install. None means the user has to pick it.
fn resolve_engine_ini(
    app: &AppHandle,
    ctx: &InstallContext,
) -> Result<Option<(PathBuf, Lease)>, String> {
    let lease = sessions(app)
        .leases
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&ctx.game_id)
        .cloned();
    let Some(lease) = lease.filter(|l| l.context == *ctx) else {
        return verified_engine_ini(&ctx.game_id, ctx.launcher.as_deref())?
            .map(|path| validate_engine_ini(&path).map(|path| (path, Lease::Verified)))
            .transpose();
    };
    let canonical = validate_engine_ini(&lease.path)?;
    if canonical != lease.path {
        return Err(
            "the Engine.ini you chose now resolves somewhere else; choose it again".to_string(),
        );
    }
    Ok(Some((canonical, Lease::Picked)))
}

fn open_session(
    app: &AppHandle,
    ctx: InstallContext,
    path: PathBuf,
    lease: Lease,
    running: bool,
) -> Result<IniEditorSession, String> {
    let (bytes, revision) = read_ini_bytes(&path)?;
    let decoded = ini::decode(&bytes);
    let session = IniSession {
        context: ctx,
        lease,
        path,
        sha256: sha256_hex(&bytes),
        revision,
        decoded,
    };
    let handle = Uuid::new_v4().to_string();
    let view = session_view(&handle, &session, running)?;
    sessions(app)
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(handle, session);
    Ok(view)
}

fn session_view(handle: &str, s: &IniSession, running: bool) -> Result<IniEditorSession, String> {
    let read_only = match std::fs::metadata(&s.path) {
        Ok(metadata) => metadata.permissions().readonly(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Cannot inspect Engine.ini permissions: {error}")),
    };
    let reason = if let Err(error) = &s.decoded {
        Some(format!("This file cannot be edited: {error}"))
    } else if read_only {
        Some("the file is read-only; change that in your file manager to edit it here".to_string())
    } else if s.decoded.as_ref().expect("decoded errors were handled").eol == ini::LineEnding::Mixed
    {
        Some(
            "the file mixes line-ending styles, so saving would change lines you did not edit"
                .to_string(),
        )
    } else if running {
        Some("the game is running; close it to save changes".to_string())
    } else {
        None
    };
    Ok(IniEditorSession {
        session_handle: handle.to_string(),
        context_key: editor_context_key(&s.context, &s.path)?,
        game_id: s.context.game_id.clone(),
        game_path: s.context.game_path.clone(),
        path: s.path.to_string_lossy().to_string(),
        text: match &s.decoded {
            Ok(decoded) => decoded.text.clone(),
            Err(_) => String::new(),
        },
        read_only: reason.is_some(),
        read_only_reason: reason,
        sha256: s.sha256.clone(),
        exists: s.revision != Content::Absent,
    })
}

fn editor_context_key(context: &InstallContext, path: &Path) -> Result<String, String> {
    let identity = (
        &context.game_id,
        &context.game_path,
        &context.canonical_game_path,
        &context.launcher,
        path,
    );
    let bytes = serde_json::to_vec(&identity).map_err(|error| {
        format!("Could not bind the editor draft to this installation: {error}")
    })?;
    Ok(sha256_hex(&bytes))
}

async fn running_now(game_id: &str) -> Result<bool, String> {
    let id = game_id.to_string();
    blocking(move || crate::commands::launchers::game_running(&id)).await
}

pub(crate) async fn open_engine_ini(
    app: &AppHandle,
    game_id: &str,
) -> Result<IniEditorSession, String> {
    let ctx = current_context(app, game_id)?;
    let (path, lease) = resolve_engine_ini(app, &ctx)?.ok_or_else(|| {
        "Modrex has no verified Engine.ini location for this game and store; choose the file to open it".to_string()
    })?;
    let running = running_now(game_id).await?;
    open_session(app, ctx, path, lease, running)
}

pub(crate) async fn pick_engine_ini(
    app: &AppHandle,
    game_id: &str,
    title: String,
    folder: bool,
) -> Result<Option<IniEditorSession>, String> {
    use tauri_plugin_dialog::DialogExt;
    let ctx = current_context(app, game_id)?;
    let dialog_app = app.clone();
    let picked = blocking(move || {
        let dialog = dialog_app.dialog().file().set_title(title);
        Ok(if folder {
            dialog.blocking_pick_folder()
        } else {
            dialog
                .add_filter("Engine.ini", &["ini"])
                .blocking_pick_file()
        })
    })
    .await?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let mut picked = picked.into_path().map_err(|e| e.to_string())?;
    if folder {
        picked.push("Engine.ini");
    }
    require_context(app, &ctx)?;
    let path = validate_engine_ini(&picked)?;
    sessions(app)
        .leases
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            game_id.to_string(),
            PickedLease {
                context: ctx.clone(),
                path: path.clone(),
            },
        );
    let running = running_now(game_id).await?;
    open_session(app, ctx, path, Lease::Picked, running).map(Some)
}

pub(crate) fn close_engine_ini(app: &AppHandle, handle: &str) {
    sessions(app)
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(handle);
}

pub(crate) async fn save_engine_ini(
    app: &AppHandle,
    handle: &str,
    text: String,
    release_preset: bool,
) -> Result<IniEditorSession, String> {
    let (ctx, lease, path, revision, decoded) = {
        let map = sessions(app)
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let s = map
            .get(handle)
            .ok_or("this editor session has ended; reopen Engine.ini")?;
        (
            s.context.clone(),
            s.lease,
            s.path.clone(),
            s.revision.clone(),
            s.decoded.clone()?,
        )
    };
    require_context(app, &ctx)?;
    let resolved = resolve_engine_ini(app, &ctx)?;
    if resolved != Some((path.clone(), lease)) {
        return Err("Engine.ini now resolves to a different file; reopen it".to_string());
    }
    let new_bytes = ini::encode(&text, decoded.encoding, decoded.eol)?;
    if new_bytes.len() as u64 > MAX_INI_BYTES {
        return Err("Engine.ini exceeds the 1 MiB editor limit".into());
    }
    let (_guard, store) = lock_and_recover(app, &ctx.game_id, std::slice::from_ref(&path)).await?;
    require_context(app, &ctx)?;
    if resolve_engine_ini(app, &ctx)? != Some((path.clone(), lease)) {
        return Err("Engine.ini now resolves to a different file; reopen it".into());
    }
    if live_content(&path)? != revision {
        return Err(
            "Engine.ini changed since you opened it; reload it and review your edits".into(),
        );
    }
    if revision != Content::Absent
        && new_bytes == ini::encode(&decoded.text, decoded.encoding, decoded.eol)?
    {
        let map = sessions(app)
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let s = map
            .get(handle)
            .ok_or("this editor session has ended; reopen Engine.ini")?;
        return session_view(handle, s, false);
    }
    refuse_read_only(&path)?;
    let game_id = ctx.game_id.clone();
    let config = path.clone();
    let old_text = decoded.text.clone();
    let new_text = text.clone();
    let bytes = new_bytes.clone();
    blocking(move || {
        let before = store.capture(&config)?;
        if before != revision {
            return Err(
                "Engine.ini changed since you opened it; reload it and review your edits"
                    .to_string(),
            );
        }
        let manifest = store.load_manifest()?;
        let config_key = config.to_string_lossy().to_string();
        let mut affected = Vec::new();
        let mut owned = Vec::new();
        for d in manifest.deployments.iter().filter(|d| d.enabled) {
            let DeploymentBody::Ini { preset } = &d.body else {
                continue;
            };
            if preset.config_path != config_key {
                continue;
            }
            let changed = ini::owned_changes(&old_text, &new_text, &preset.changes);
            if changed.is_empty() {
                continue;
            }
            owned.extend(changed.iter().map(|c| format!("[{}] {}", c.section, c.key)));
            affected.push((d.id.clone(), changed));
        }
        if !affected.is_empty() && !release_preset {
            return Err(format!("OWNED_KEYS_CHANGED: {}", owned.join(", ")));
        }
        let after = store.put_bytes(&bytes)?;
        let step = Step {
            destination: config.clone(),
            before: before.clone(),
            after,
        };
        store.apply(&game_id, vec![step], |m| {
            release_edited_keys(m, &affected);
            m.ini_revisions.push(IniRevision {
                config_path: config_key,
                game_id: game_id.clone(),
                prior: before,
                saved_at: chrono::Utc::now().to_rfc3339(),
            });
        })
    })
    .await?;
    let decoded = ini::decode(&new_bytes)?;
    let mut map = sessions(app)
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let s = map
        .get_mut(handle)
        .ok_or("this editor session has ended; reopen Engine.ini")?;
    s.sha256 = sha256_hex(&new_bytes);
    s.revision = Content::Present {
        sha256: s.sha256.clone(),
        size: new_bytes.len() as u64,
    };
    s.decoded = Ok(decoded);
    session_view(handle, s, false)
}

fn release_edited_keys(
    manifest: &mut Manifest,
    affected: &[(String, Vec<super::resource_state::KeyChange>)],
) {
    for deployment in &mut manifest.deployments {
        let Some((_, changed)) = affected.iter().find(|(id, _)| *id == deployment.id) else {
            continue;
        };
        let DeploymentBody::Ini { preset } = &mut deployment.body else {
            continue;
        };
        preset.changes.retain(|change| !changed.contains(change));
        preset.created_file = false;
    }
    manifest.deployments.retain(|deployment| {
        !affected.iter().any(|(id, _)| *id == deployment.id)
            || preset_of(deployment).is_some_and(|preset| !preset.changes.is_empty())
    });
}

// ---------------------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------------------

struct StagedResource {
    entry: ResourceReviewEntry,
    /// The independent staged copy, present only for a supported entry.
    staged: Option<PathBuf>,
}

struct Review {
    handle: String,
    context: InstallContext,
    provenance: Provenance,
    staging_dir: PathBuf,
    entries: Vec<StagedResource>,
    movie_slots: Vec<String>,
    config_path: Option<PathBuf>,
    config_revision: Option<Content>,
    manifest_revision: Option<u64>,
    pak_picker: Option<ZipMultiPakPayload>,
    movie_pack_applied: bool,
    movie_deployment_id: String,
    ini_deployment_id: String,
    issued: Instant,
}

const REVIEW_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_REVIEWS: usize = 16;

/// Open reviews. A review is taken out while it installs, so a concurrent cancel or a second
/// install of the same handle finds nothing.
#[derive(Default)]
pub struct ResourceReviews(Mutex<Vec<Review>>, Mutex<HashMap<String, RecoveryReview>>);

#[derive(Clone)]
struct RecoveryReview {
    context: InstallContext,
    revision: u64,
    journal_id: Option<String>,
    paths: Vec<PathBuf>,
    current: Vec<Content>,
    games: Vec<String>,
    issued: Instant,
}

fn reviews(app: &AppHandle) -> &ResourceReviews {
    app.state::<ResourceReviews>().inner()
}

/// Removes a closed review's staged payloads and the archive its package picker still holds.
/// A picker that already finished has finalized its grant, so that finalize is a miss.
fn discard_review(app: &AppHandle, review: Review) {
    let picker_plan = review
        .pak_picker
        .as_ref()
        .and_then(|picker| super::staged_archives(app).finalize(&picker.archive_handle));
    if let Some(plan) = picker_plan {
        cleanup::run_sync(&plan);
    }
    cleanup::run_sync(&CleanupPlan::RemoveOwnedDirectory(review.staging_dir));
}

/// Removes every open review's staged payloads, for application exit.
pub(crate) fn discard_all_reviews(app: &AppHandle) {
    let all = std::mem::take(&mut *reviews(app).0.lock().unwrap_or_else(|e| e.into_inner()));
    for review in all {
        discard_review(app, review);
    }
}

fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn file_name_of(name: &str) -> &str {
    name.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(name)
}

/// Classifies one staged member and explains anything that cannot be installed.
fn assess(
    name: &str,
    staged: Option<&Path>,
    movies: &Result<Vec<String>, String>,
    config: &Result<Option<PathBuf>, String>,
) -> (ResourceEntryKind, Result<(), String>) {
    let ext = extension_of(name);
    if name.ends_with('/') {
        return (
            ResourceEntryKind::Other,
            Err("UE4SS mod folders in this archive are not installed by this review; install them from an archive of their own".to_string()),
        );
    }
    let kind = match ext.as_str() {
        "bk2" => ResourceEntryKind::Movie,
        "ini" => ResourceEntryKind::Ini,
        _ => ResourceEntryKind::Other,
    };
    if safe_dest(Path::new("/"), name).is_none() {
        return (
            kind,
            Err("the archive entry has an unsafe path".to_string()),
        );
    }
    let verdict = match kind {
        ResourceEntryKind::Other if ext == "bak2" => {
            Err(".bak2 is not a movie format Modrex installs; rename it yourself only if you know the game reads it".to_string())
        }
        ResourceEntryKind::Other => Err("not a movie or Engine.ini".to_string()),
        ResourceEntryKind::Movie => movies
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|_| movies::validate_bink(staged.expect("movies are staged")).map(|_| ())),
        ResourceEntryKind::Ini => assess_ini(name, staged.expect("INIs are staged"), config),
    };
    (kind, verdict)
}

fn assess_ini(
    name: &str,
    staged: &Path,
    config: &Result<Option<PathBuf>, String>,
) -> Result<(), String> {
    if !file_name_of(name).eq_ignore_ascii_case("Engine.ini") {
        return Err("only Engine.ini presets are supported".to_string());
    }
    match config {
        Err(e) => return Err(e.clone()),
        Ok(None) => {
            return Err("Modrex has no verified Engine.ini location for this game and store; open it with Choose file in the Engine.ini editor first".to_string())
        }
        Ok(Some(_)) => {}
    }
    let (bytes, revision) = read_ini_bytes(staged)?;
    if revision == Content::Absent {
        return Err("The staged preset is missing".into());
    }
    let decoded = ini::decode(&bytes)?;
    if decoded.eol == ini::LineEnding::Mixed {
        return Err("The preset mixes line endings. Review it in the editor".into());
    }
    let assignments = ini::scalar_assignments(&decoded.text)
        .map_err(|e| format!("{e}; apply it by hand in the Engine.ini editor instead"))?;
    if let Ok(Some(path)) = config {
        let (_, target, _) = read_config(path)?;
        ini::merge(&target.text, &assignments)?;
    }
    Ok(())
}

/// Stages a resource download for review and returns its handle.
///
/// Each member is copied out on its own, so the review never depends on the archive, the
/// pak picker's grant, or a dropped original. The downloaded temp file is removed here unless
/// the pak picker's grant owns it.
pub(crate) fn open_review(
    app: &AppHandle,
    game_id: &str,
    game_path: &str,
    found: ResourceArchive,
    source_name: &str,
    provenance: Provenance,
) -> Result<String, String> {
    let ctx = current_context(app, game_id)?;
    if ctx.game_path != game_path {
        return Err(
            "the selected game install changed while this downloaded; install it again".to_string(),
        );
    }
    let staging_dir = std::env::temp_dir().join(format!("modrex-resources-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;
    let built = build_review(app, &ctx, &found, source_name, &staging_dir);
    if found.pak_picker.is_none() {
        cleanup::run_sync(&CleanupPlan::RemoveOwnedFile(found.downloaded.clone()));
    }
    let (entries, movie_slots, config_path) = match built {
        Ok(v) => v,
        Err(e) => {
            cleanup::run_sync(&CleanupPlan::RemoveOwnedDirectory(staging_dir));
            return Err(e);
        }
    };
    let handle = Uuid::new_v4().to_string();
    let review = Review {
        handle: handle.clone(),
        context: ctx,
        provenance,
        staging_dir,
        entries,
        movie_slots,
        config_path,
        config_revision: None,
        manifest_revision: None,
        pak_picker: found.pak_picker,
        movie_pack_applied: false,
        movie_deployment_id: Uuid::new_v4().to_string(),
        ini_deployment_id: Uuid::new_v4().to_string(),
        issued: Instant::now(),
    };
    let mut expired = Vec::new();
    let mut list = reviews(app).0.lock().unwrap_or_else(|e| e.into_inner());
    let mut i = 0;
    while i < list.len() {
        if list[i].issued.elapsed() > REVIEW_TTL {
            expired.push(list.remove(i));
            continue;
        }
        i += 1;
    }
    if list.len() >= MAX_REVIEWS {
        drop(list);
        discard_review(app, review);
        expired
            .into_iter()
            .for_each(|review| discard_review(app, review));
        return Err(
            "Too many install reviews are open. Finish or close them and try again.".to_string(),
        );
    }
    list.push(review);
    drop(list);
    expired
        .into_iter()
        .for_each(|review| discard_review(app, review));
    Ok(handle)
}

type BuiltReview = (Vec<StagedResource>, Vec<String>, Option<PathBuf>);

fn build_review(
    app: &AppHandle,
    ctx: &InstallContext,
    found: &ResourceArchive,
    source_name: &str,
    staging_dir: &Path,
) -> Result<BuiltReview, String> {
    let launcher = ctx.launcher.as_deref();
    let slots = movies::movies_dir(&ctx.game_id, &ctx.game_path, launcher)
        .and_then(|dir| movies::slot_inventory(&ctx.game_id, &dir, launcher));
    let config = resolve_engine_ini(app, ctx).map(|r| r.map(|(p, _)| p));
    let members: Vec<(Option<u32>, String)> = if found.is_archive {
        found.members.clone()
    } else {
        vec![(None, source_name.to_string())]
    };
    let mut entries = Vec::new();
    let mut remaining: u64 = 1024 * 1024 * 1024;
    for (entry_id, (index, name)) in members.into_iter().enumerate() {
        let entry_id = entry_id as u32;
        let ext = if found.is_archive {
            extension_of(&name)
        } else {
            extension_of(&found.downloaded.to_string_lossy())
        };
        let wanted = !name.ends_with('/') && (ext == "bk2" || ext == "ini");
        if wanted
            && entries
                .iter()
                .filter(|entry: &&StagedResource| entry.staged.is_some())
                .count()
                >= 128
        {
            return Err("Archive contains more than 128 resource entries".into());
        }
        let limit = if ext == "ini" {
            MAX_INI_BYTES
        } else {
            512 * 1024 * 1024
        };
        let mut budget = remaining.min(limit);
        let available = budget;
        let staged = staging_dir.join(entry_id.to_string());
        let staged = match (wanted, found.is_archive, index) {
            (false, _, _) => None,
            (true, false, _) => {
                let mut source =
                    std::fs::File::open(&found.downloaded).map_err(|e| e.to_string())?;
                let mut destination = std::fs::File::create(&staged).map_err(|e| e.to_string())?;
                super::zip::copy_capped(&mut source, &mut destination, &mut budget)?;
                Some(staged)
            }
            (true, true, Some(index)) => {
                extract_entry_at_budget(&found.downloaded, index, &staged, &mut budget)?;
                Some(staged)
            }
            (true, true, None) => None,
        };
        remaining -= available - budget;
        let assessment_name = if !found.is_archive && ext == "bk2" && !movies::is_bk2_name(&name) {
            format!("{name}.bk2")
        } else {
            name.clone()
        };
        let (kind, verdict) = assess(&assessment_name, staged.as_deref(), &slots, &config);
        let supported = verdict.is_ok();
        entries.push(StagedResource {
            entry: ResourceReviewEntry {
                entry_id,
                name,
                kind,
                supported,
                reason: verdict.err(),
                changes: Vec::new(),
                keys: Vec::new(),
            },
            staged,
        });
    }
    Ok((entries, slots.unwrap_or_default(), config.ok().flatten()))
}

pub(crate) fn get_review(app: &AppHandle, handle: &str) -> Result<ResourceReview, String> {
    let mut list = reviews(app).0.lock().unwrap_or_else(|e| e.into_inner());
    let r = list
        .iter_mut()
        .find(|r| r.handle == handle)
        .ok_or("this install review is no longer available")?;
    if r.issued.elapsed() >= REVIEW_TTL {
        return Err("This install review has expired. Close it and reopen the download".into());
    }
    require_context(app, &r.context)?;
    let manifest = ResourceStore::for_app(app)?.load_manifest()?;
    r.manifest_revision = Some(manifest.revision);
    r.movie_pack_applied |= manifest
        .deployments
        .iter()
        .any(|d| d.id == r.movie_deployment_id);
    let config = resolve_engine_ini(app, &r.context).map(|value| value.map(|(path, _)| path));
    r.config_path = config.as_ref().ok().and_then(|path| path.clone());
    let target = match &config {
        Ok(Some(path)) => read_config(path).map(|(_, decoded, revision)| Some((decoded, revision))),
        Ok(None) => Ok(None),
        Err(error) => Err(error.clone()),
    };
    r.config_revision = target
        .as_ref()
        .ok()
        .and_then(|value| value.as_ref().map(|(_, revision)| revision.clone()));
    for entry in r
        .entries
        .iter_mut()
        .filter(|entry| entry.entry.kind == ResourceEntryKind::Ini)
    {
        let verdict = match &target {
            Err(error) => Err(error.clone()),
            Ok(_) => assess_ini(
                &entry.entry.name,
                entry.staged.as_deref().expect("INI entry was staged"),
                &config,
            ),
        };
        entry.entry.supported = verdict.is_ok();
        entry.entry.reason = verdict.err();
        entry.entry.changes.clear();
        entry.entry.keys.clear();
        if entry.entry.supported {
            let source = read_ini_bytes(entry.staged.as_deref().expect("INI entry was staged"))?.0;
            let assignments = ini::scalar_assignments(&ini::decode(&source)?.text)?;
            entry.entry.keys = assignments
                .iter()
                .map(|assignment| ResourceIniKey {
                    section: assignment.section.clone(),
                    key: assignment.key.clone(),
                })
                .collect();
            let (target, _) = target
                .as_ref()
                .expect("Supported preset has a readable config")
                .as_ref()
                .expect("Supported preset has a config path");
            let merged = ini::merge(&target.text, &assignments)?;
            entry.entry.changes = assignments
                .iter()
                .map(|assignment| {
                    merged
                        .changes
                        .iter()
                        .find(|change| {
                            same_key(&change.section, &assignment.section)
                                && same_key(&change.key, &assignment.key)
                        })
                        .cloned()
                        .unwrap_or_else(|| super::resource_state::KeyChange {
                            section: assignment.section.clone(),
                            key: assignment.key.clone(),
                            before: Some(assignment.value.clone()),
                            applied: assignment.value.clone(),
                        })
                })
                .collect();
        }
    }
    let candidate_movie = new_deployment(r, DeploymentBody::Movie { slots: Vec::new() });
    let movie_previous = same_project(&manifest, &candidate_movie).map(|d| d.id.as_str());
    let movie_conflicts = manifest
        .deployments
        .iter()
        .filter(|d| {
            d.enabled && d.game_id == r.context.game_id && d.game_path == r.context.game_path
        })
        .filter_map(|d| {
            let DeploymentBody::Movie { slots } = &d.body else {
                return None;
            };
            Some(ResourceMovieConflict {
                name: d.name.clone(),
                slots: slots.iter().map(|slot| slot.slot.clone()).collect(),
                replacing: movie_previous == Some(d.id.as_str()),
            })
        })
        .collect();
    let ini_conflicts = manifest
        .deployments
        .iter()
        .filter(|d| d.enabled)
        .filter_map(|d| {
            let preset = preset_of(d)?;
            if Some(Path::new(&preset.config_path)) != r.config_path.as_deref() {
                return None;
            }
            Some(ResourceIniConflict {
                name: format!("{} ({})", d.name, d.game_id),
                changes: preset.changes.clone(),
                replacing: d.source == r.provenance.source
                    && d.remote_id.is_some()
                    && d.remote_id == r.provenance.remote_id
                    && d.game_id == r.context.game_id
                    && d.game_path == r.context.game_path,
            })
        })
        .collect();
    Ok(ResourceReview {
        review_handle: r.handle.clone(),
        game_id: r.context.game_id.clone(),
        game_path: r.context.game_path.clone(),
        mod_name: r.provenance.name.clone(),
        entries: r.entries.iter().map(|e| e.entry.clone()).collect(),
        movie_slots: r.movie_slots.clone(),
        config_path: r
            .config_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string()),
        pak_picker: r.pak_picker.clone(),
        source: r.provenance.source.clone(),
        movie_pack_applied: r.movie_pack_applied,
        movie_conflicts,
        ini_conflicts,
    })
}

pub(crate) fn read_review_ini(
    app: &AppHandle,
    handle: &str,
    entry_id: u32,
) -> Result<String, String> {
    let list = reviews(app)
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let review = list
        .iter()
        .find(|review| review.handle == handle)
        .ok_or("This install review has ended")?;
    require_context(app, &review.context)?;
    let entry = review
        .entries
        .iter()
        .find(|entry| entry.entry.entry_id == entry_id)
        .ok_or("This entry is not in the review")?;
    if entry.entry.kind != ResourceEntryKind::Ini
        || !file_name_of(&entry.entry.name).eq_ignore_ascii_case("Engine.ini")
        || safe_dest(Path::new("/"), &entry.entry.name).is_none()
    {
        return Err("Only a safe Engine.ini entry can be reviewed in the editor".into());
    }
    let path = entry
        .staged
        .as_deref()
        .ok_or("This entry has no staged data")?;
    let (bytes, revision) = read_ini_bytes(path)?;
    if revision == Content::Absent {
        return Err("The staged preset is missing".into());
    }
    Ok(ini::decode(&bytes)?.text)
}

pub(crate) fn cancel_review(app: &AppHandle, handle: &str) {
    let taken = {
        let mut list = reviews(app).0.lock().unwrap_or_else(|e| e.into_inner());
        list.iter()
            .position(|r| r.handle == handle)
            .map(|i| list.remove(i))
    };
    match taken {
        Some(review) => discard_review(app, review),
        None => log::warn!("cancel_resource_review: unknown or busy review"),
    }
}

fn take_review(app: &AppHandle, handle: &str) -> Result<Review, String> {
    let mut list = reviews(app).0.lock().unwrap_or_else(|e| e.into_inner());
    let i = list
        .iter()
        .position(|r| r.handle == handle)
        .ok_or("this install review is no longer available")?;
    if list[i].issued.elapsed() >= REVIEW_TTL {
        return Err("This install review has expired. Close it and reopen the download".into());
    }
    Ok(list.remove(i))
}

fn return_review(app: &AppHandle, review: Review) {
    reviews(app)
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(review);
}

/// A review taken out of the open list while one of its packages installs, so a concurrent
/// cancel cannot discard its archive mid-install.
pub(crate) struct HeldReview(Review);

/// A package choice a Nexus review offers, bound to the install and the exact Nexus mod and
/// file the review was opened for. The renderer supplies neither.
#[derive(Debug, Clone)]
pub(crate) struct NexusPakChoice {
    context: InstallContext,
    pub game_id: String,
    pub game_path: String,
    pub mod_id: u32,
    pub file_id: i64,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub thumbnail_url: Option<String>,
    pub file_type: String,
    pub picker: ZipMultiPakPayload,
}

/// install_nexus_download records the nxm link's numeric mod id as the remote id.
fn nexus_mod_id(provenance: &Provenance) -> u32 {
    provenance
        .remote_id
        .as_deref()
        .and_then(|id| id.parse().ok())
        .expect("a Nexus review records its numeric mod id")
}

fn nexus_pak_choice(review: &Review) -> Result<NexusPakChoice, String> {
    let provenance = &review.provenance;
    if provenance.source.as_deref() != Some("nexus") {
        return Err("This review did not come from a Nexus download".into());
    }
    let picker = review
        .pak_picker
        .clone()
        .ok_or("This download has no packages to install")?;
    Ok(NexusPakChoice {
        context: review.context.clone(),
        game_id: review.context.game_id.clone(),
        game_path: review.context.game_path.clone(),
        mod_id: nexus_mod_id(provenance),
        file_id: provenance.file_id.expect("a Nexus review records its file"),
        name: provenance.name.clone(),
        version: provenance.version.clone(),
        author: provenance.author.clone(),
        thumbnail_url: provenance.thumbnail_url.clone(),
        file_type: picker
            .file_type
            .clone()
            .expect("a Nexus review's picker carries the download's type"),
        picker,
    })
}

/// Takes a Nexus review out for a package install. It is returned on any refusal, so a
/// changed install leaves the review open to be cancelled.
pub(crate) fn hold_nexus_pak_review(
    app: &AppHandle,
    handle: &str,
) -> Result<(HeldReview, NexusPakChoice), String> {
    let review = take_review(app, handle)?;
    let choice = nexus_pak_choice(&review)
        .and_then(|choice| require_context(app, &review.context).map(|()| choice));
    match choice {
        Ok(choice) => Ok((HeldReview(review), choice)),
        Err(error) => {
            return_review(app, review);
            Err(error)
        }
    }
}

/// Puts a held review back, whether its package installed or not.
pub(crate) fn release_review(app: &AppHandle, held: HeldReview) {
    return_review(app, held.0);
}

pub(crate) fn validate_nexus_pak_choice(
    app: &AppHandle,
    choice: &NexusPakChoice,
) -> Result<(), String> {
    require_context(app, &choice.context)
}

/// What an open Nexus review reports once something it offered is actually installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NexusCompletion {
    pub game_id: String,
    pub mod_id: u32,
    pub file_id: i64,
    pub name: String,
    pub movie_pack_applied: bool,
}

fn nexus_completion_of(review: &Review) -> Option<NexusCompletion> {
    if review.provenance.source.as_deref() != Some("nexus") {
        return None;
    }
    Some(NexusCompletion {
        game_id: review.context.game_id.clone(),
        mod_id: nexus_mod_id(&review.provenance),
        file_id: review
            .provenance
            .file_id
            .expect("a Nexus review records its file"),
        name: review.provenance.name.clone(),
        movie_pack_applied: review.movie_pack_applied,
    })
}

/// The completion an open review would report, None for a review from anywhere but Nexus or
/// one that is no longer open.
pub(crate) fn nexus_completion(app: &AppHandle, handle: &str) -> Option<NexusCompletion> {
    reviews(app)
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|review| review.handle == handle)
        .and_then(nexus_completion_of)
}

/// Installs reviewed selections and retains the review after failure.
/// A movie pack applied before a later preset fails remains installed.
pub(crate) async fn install_reviewed(
    app: &AppHandle,
    handle: &str,
    selections: Vec<ResourceSelection>,
) -> Result<ResourceInstallResult, String> {
    let mut review = take_review(app, handle)?;
    let result = install_selected(app, &mut review, &selections).await;
    match &result {
        Ok(_) => discard_review(app, review),
        Err(_) => return_review(app, review),
    }
    result
}

struct MovieChoice {
    entry_name: String,
    staged: PathBuf,
    slot: String,
}

async fn install_selected(
    app: &AppHandle,
    review: &mut Review,
    selections: &[ResourceSelection],
) -> Result<ResourceInstallResult, String> {
    let expected_revision = review
        .manifest_revision
        .ok_or("Review the current destinations before applying this download")?;
    if selections.is_empty() {
        return Err("choose at least one file to install, or close the review".to_string());
    }
    require_context(app, &review.context)?;
    let mut movie_choices: Vec<MovieChoice> = Vec::new();
    let mut ini_choice: Option<(String, PathBuf)> = None;
    let mut selected_ids = std::collections::HashSet::new();
    for sel in selections {
        if !selected_ids.insert(sel.entry_id) {
            return Err("A resource entry was selected more than once".into());
        }
        let entry = review
            .entries
            .iter()
            .find(|e| e.entry.entry_id == sel.entry_id)
            .ok_or("a selected file is not part of this review")?;
        if !entry.entry.supported {
            return Err(format!(
                "{} cannot be installed: {}",
                entry.entry.name,
                entry
                    .entry
                    .reason
                    .as_deref()
                    .expect("unsupported entry has a reason")
            ));
        }
        let Some(staged) = entry.staged.clone() else {
            return Err(format!("{} cannot be installed", entry.entry.name));
        };
        match entry.entry.kind {
            ResourceEntryKind::Movie => {
                if review.movie_pack_applied {
                    return Err("The movie pack in this review has already been applied".into());
                }
                movies::validate_bink(&staged)?;
                let slot = sel
                    .slot
                    .clone()
                    .ok_or_else(|| format!("choose which movie {} replaces", entry.entry.name))?;
                if movie_choices
                    .iter()
                    .any(|c| c.slot.eq_ignore_ascii_case(&slot))
                {
                    return Err(format!("two files are mapped to {slot}"));
                }
                movie_choices.push(MovieChoice {
                    entry_name: entry.entry.name.clone(),
                    staged,
                    slot,
                });
            }
            ResourceEntryKind::Ini => {
                if sel.slot.is_some() {
                    return Err("an Engine.ini preset has no movie slot".to_string());
                }
                if ini_choice.is_some() {
                    return Err("choose only one Engine.ini variant".to_string());
                }
                ini_choice = Some((entry.entry.name.clone(), staged));
            }
            ResourceEntryKind::Other => {
                return Err(format!("{} cannot be installed", entry.entry.name))
            }
        }
    }
    let mut result = ResourceInstallResult {
        installed: false,
        already_current_movies: Vec::new(),
    };
    if !movie_choices.is_empty() {
        result = install_movie_pack(app, review, movie_choices).await?;
        review.movie_pack_applied = result.installed;
        review.manifest_revision = Some(
            expected_revision
                .checked_add(1)
                .expect("The completed resource operation checked revision overflow"),
        );
    }
    if let Some((name, staged)) = ini_choice {
        install_preset(app, review, &name, staged)
            .await
            .map_err(|error| {
                if !result.installed {
                    return error;
                }
                format!("The movie pack was installed, but the Engine.ini preset was not: {error}")
            })?;
        result.installed = true;
    }
    Ok(result)
}

fn new_deployment(review: &Review, body: DeploymentBody) -> Deployment {
    Deployment {
        id: match &body {
            DeploymentBody::Movie { .. } => review.movie_deployment_id.clone(),
            DeploymentBody::Ini { .. } => review.ini_deployment_id.clone(),
        },
        game_id: review.context.game_id.clone(),
        game_path: review.context.game_path.clone(),
        canonical_game_path: review.context.canonical_game_path.clone(),
        launcher: review.context.launcher.clone(),
        name: review.provenance.name.clone(),
        version: review.provenance.version.clone(),
        source: review.provenance.source.clone(),
        remote_id: review.provenance.remote_id.clone(),
        file_id: review.provenance.file_id,
        installed_at: chrono::Utc::now().to_rfc3339(),
        enabled: true,
        body,
    }
}

/// The deployment an install updates: the same project's same kind on the same install.
/// A dropped file has no project, so it never updates anything.
fn same_project<'a>(manifest: &'a Manifest, new: &Deployment) -> Option<&'a Deployment> {
    let remote = new.remote_id.as_ref()?;
    manifest.deployments.iter().find(|d| {
        d.game_id == new.game_id
            && d.game_path == new.game_path
            && d.source == new.source
            && d.remote_id.as_ref() == Some(remote)
            && std::mem::discriminant(&d.body) == std::mem::discriminant(&new.body)
    })
}

fn upsert(manifest: &mut Manifest, d: Deployment) {
    match manifest.deployments.iter_mut().find(|x| x.id == d.id) {
        Some(slot) => *slot = d,
        None => manifest.deployments.push(d),
    }
}

async fn install_movie_pack(
    app: &AppHandle,
    review: &Review,
    choices: Vec<MovieChoice>,
) -> Result<ResourceInstallResult, String> {
    let ctx = &review.context;
    let dir = movies::movies_dir(&ctx.game_id, &ctx.game_path, ctx.launcher.as_deref())?;
    let inventory = movies::slot_inventory(&ctx.game_id, &dir, ctx.launcher.as_deref())?;
    let mut destinations = Vec::new();
    for c in &choices {
        destinations.push(movies::slot_destination(&dir, &c.slot, &inventory)?);
    }
    let (_guard, store) = lock_and_recover(app, &ctx.game_id, &destinations).await?;
    require_context(app, ctx)?;
    let mut pack = new_deployment(review, DeploymentBody::Movie { slots: Vec::new() });
    let game_id = ctx.game_id.clone();
    let review_manifest_revision = review.manifest_revision;
    blocking(move || {
        let mut slots = Vec::new();
        for (c, dest) in choices.into_iter().zip(destinations) {
            let Content::Present { sha256, size } = store.capture(&c.staged)? else {
                return Err(format!("{} disappeared from staging", c.entry_name));
            };
            slots.push(MovieSlot {
                slot: c.slot,
                destination: dest.to_string_lossy().to_string(),
                entry_name: c.entry_name,
                payload_sha256: sha256,
                payload_size: size,
            });
        }
        pack.body = DeploymentBody::Movie { slots };
        let manifest = store.load_manifest()?;
        if Some(manifest.revision) != review_manifest_revision {
            return Err(
                "Managed resources changed after this review. Review the destinations again".into(),
            );
        }
        if manifest.deployments.iter().any(|d| d.id == pack.id) {
            return Ok(ResourceInstallResult {
                installed: true,
                already_current_movies: Vec::new(),
            });
        }
        let previous = same_project(&manifest, &pack).cloned();
        if let Some(old) = previous.as_ref().filter(|old| !old.enabled) {
            // An update of a disabled pack must not activate it.
            pack.enabled = false;
            store.apply(&game_id, Vec::new(), |m| {
                m.deployments.retain(|d| d.id != old.id);
                upsert(m, pack);
                movies::prune_baselines(m);
            })?;
            return Ok(ResourceInstallResult {
                installed: true,
                already_current_movies: Vec::new(),
            });
        }
        apply_movie_pack(&store, &game_id, &manifest, pack, previous.map(|p| p.id))
    })
    .await
}

fn apply_movie_pack(
    store: &ResourceStore,
    game_id: &str,
    manifest: &Manifest,
    mut pack: Deployment,
    replacing: Option<String>,
) -> Result<ResourceInstallResult, String> {
    let plan = movies::plan_apply(store, manifest, &pack, replacing.as_deref())?;
    if let DeploymentBody::Movie { slots } = &mut pack.body {
        slots.retain(|slot| !plan.already_current.contains(&slot.destination));
    }
    pack.enabled = true;
    let installed = replacing.is_some()
        || !plan.steps.is_empty()
        || matches!(&pack.body, DeploymentBody::Movie { slots } if !slots.is_empty());
    store.apply(game_id, plan.steps, |m| {
        if let Some(old) = &replacing {
            m.deployments.retain(|d| &d.id != old);
        }
        for d in m
            .deployments
            .iter_mut()
            .filter(|d| plan.switched_off.contains(&d.id))
        {
            d.enabled = false;
        }
        if !matches!(&pack.body, DeploymentBody::Movie { slots } if slots.is_empty()) {
            upsert(m, pack);
        }
        m.movie_baselines.extend(plan.new_baselines);
        movies::prune_baselines(m);
    })?;
    Ok(ResourceInstallResult {
        installed,
        already_current_movies: plan.already_current,
    })
}

async fn install_preset(
    app: &AppHandle,
    review: &Review,
    entry_name: &str,
    staged: PathBuf,
) -> Result<(), String> {
    let config = resolve_engine_ini(app, &review.context)?
        .map(|(p, _)| p)
        .ok_or("Modrex has no Engine.ini location for this install any more")?;
    if Some(&config) != review.config_path.as_ref() {
        return Err(
            "Engine.ini now resolves to a different file; review this install again".to_string(),
        );
    }
    let (_guard, store) =
        lock_and_recover(app, &review.context.game_id, std::slice::from_ref(&config)).await?;
    require_context(app, &review.context)?;
    if resolve_engine_ini(app, &review.context)?.map(|(path, _)| path) != Some(config.clone()) {
        return Err("Engine.ini changed destination while preparing the install".into());
    }
    let mut preset = new_deployment(
        review,
        DeploymentBody::Ini {
            preset: IniPreset {
                config_path: config.to_string_lossy().to_string(),
                source_entry: entry_name.to_string(),
                source_sha256: String::new(),
                source_size: 0,
                created_file: false,
                changes: Vec::new(),
                created_sections: Vec::new(),
            },
        },
    );
    let game_id = review.context.game_id.clone();
    let review_manifest_revision = review.manifest_revision;
    let review_config_revision = review
        .config_revision
        .clone()
        .ok_or("Review the configuration destination before applying the preset")?;
    blocking(move || {
        let Content::Present { sha256, size } = store.capture(&staged)? else {
            return Err("the preset disappeared from staging".to_string());
        };
        if let DeploymentBody::Ini { preset: p } = &mut preset.body {
            p.source_sha256 = sha256;
            p.source_size = size;
        }
        let manifest = store.load_manifest()?;
        if manifest.deployments.iter().any(|d| d.id == preset.id) {
            return Ok(());
        }
        if Some(manifest.revision) != review_manifest_revision {
            return Err(
                "Managed resources changed after this review. Review the destinations again".into(),
            );
        }
        if live_content(&config)? != review_config_revision {
            return Err("Engine.ini changed after this review. Review its settings again".into());
        }
        let previous = same_project(&manifest, &preset).cloned();
        if let Some(old) = previous.as_ref().filter(|old| !old.enabled) {
            // An update of a disabled preset must not activate it.
            preset.enabled = false;
            return store.apply(&game_id, Vec::new(), |m| {
                m.deployments.retain(|d| d.id != old.id);
                upsert(m, preset);
            });
        }
        apply_preset(&store, &game_id, &manifest, preset, previous.map(|p| p.id))
    })
    .await
}

fn preset_of(d: &Deployment) -> Option<&IniPreset> {
    match &d.body {
        DeploymentBody::Ini { preset } => Some(preset),
        DeploymentBody::Movie { .. } => None,
    }
}

const MAX_INI_BYTES: u64 = 1024 * 1024;

fn read_ini_bytes(path: &Path) -> Result<(Vec<u8>, Content), String> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), Content::Absent))
        }
        Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
    };
    let mut bytes = Vec::new();
    file.take(MAX_INI_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_INI_BYTES {
        return Err("Engine.ini exceeds the 1 MiB editor limit".into());
    }
    let revision = Content::Present {
        sha256: sha256_hex(&bytes),
        size: bytes.len() as u64,
    };
    Ok((bytes, revision))
}

/// Refuses mixed line endings, because merging would rewrite unrelated lines.
fn read_config(path: &Path) -> Result<(Vec<u8>, ini::Decoded, Content), String> {
    let canonical = validate_engine_ini(path)?;
    if canonical != path {
        return Err(format!("{} now resolves somewhere else", path.display()));
    }
    let (bytes, revision) = read_ini_bytes(path)?;
    let decoded = ini::decode(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    if decoded.eol == ini::LineEnding::Mixed {
        return Err(format!(
            "{} mixes line-ending styles. Review it in the Engine.ini editor and make the line endings consistent with an external editor before applying a preset",
            path.display()
        ));
    }
    Ok((bytes, decoded, revision))
}

/// One Engine.ini rewrite: captures the prior revision and builds the step, or no step at all
/// when the bytes are unchanged.
fn config_step(
    store: &ResourceStore,
    path: &Path,
    original: &Content,
    new_bytes: &[u8],
) -> Result<Option<(Step, Content)>, String> {
    let after = Content::Present {
        sha256: sha256_hex(new_bytes),
        size: new_bytes.len() as u64,
    };
    if after == *original {
        return Ok(None);
    }
    let before = store.capture(path)?;
    if before != *original {
        return Err(format!(
            "{} changed while Modrex was reading it",
            path.display()
        ));
    }
    let after = store.put_bytes(new_bytes)?;
    Ok(Some((
        Step {
            destination: path.to_path_buf(),
            before: before.clone(),
            after,
        },
        before,
    )))
}

fn same_key(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn restore_owned_ini(text: &str, preset: &IniPreset) -> Result<String, String> {
    let (restored, kept) = ini::restore(text, &preset.changes, &preset.created_sections)?;
    if !kept.is_empty() {
        let settings = kept
            .iter()
            .map(|change| format!("[{}] {}", change.section, change.key))
            .collect::<Vec<_>>();
        return Err(format!("Managed settings changed outside Modrex: {}. Review Engine.ini or use Resource recovery to keep the current files. Nothing was written", settings.join(", ")));
    }
    Ok(restored)
}

fn apply_preset(
    store: &ResourceStore,
    game_id: &str,
    manifest: &Manifest,
    mut preset: Deployment,
    replacing: Option<String>,
) -> Result<(), String> {
    let p = preset_of(&preset).expect("an INI deployment").clone();
    let path = PathBuf::from(&p.config_path);
    let (_original, decoded, original_revision) = read_config(&path)?;
    let source = store.read_object(&p.source_sha256, p.source_size)?;
    let assignments = ini::scalar_assignments(&ini::decode(&source)?.text)?;
    let mut text = decoded.text.clone();
    let mut switched_off = Vec::new();
    for d in manifest
        .deployments
        .iter()
        .filter(|d| d.enabled && d.id != preset.id)
    {
        let Some(other) = preset_of(d).filter(|o| o.config_path == p.config_path) else {
            continue;
        };
        let overlaps = replacing.as_deref() == Some(d.id.as_str())
            || other.changes.iter().any(|c| {
                assignments
                    .iter()
                    .any(|a| same_key(&a.section, &c.section) && same_key(&a.key, &c.key))
            });
        if !overlaps {
            continue;
        }
        text = restore_owned_ini(&text, other)?;
        switched_off.push(d.id.clone());
    }
    let merged = ini::merge(&text, &assignments)?;
    let new_bytes = ini::encode(&merged.text, decoded.encoding, decoded.eol)?;
    if let DeploymentBody::Ini { preset: body } = &mut preset.body {
        body.changes = merged.changes;
        body.created_sections = merged.created_sections;
        body.created_file = original_revision == Content::Absent
            || manifest.deployments.iter().any(|d| {
                d.enabled
                    && preset_of(d)
                        .is_some_and(|p| p.config_path == body.config_path && p.created_file)
            });
    }
    preset.enabled = true;
    let step = config_step(store, &path, &original_revision, &new_bytes)?;
    let (steps, revision) = match step {
        Some((step, before)) => (vec![step], Some(before)),
        None => (Vec::new(), None),
    };
    let config_path = p.config_path.clone();
    store.apply(game_id, steps, |m| {
        if let Some(old) = &replacing {
            m.deployments.retain(|d| &d.id != old);
        }
        for d in m
            .deployments
            .iter_mut()
            .filter(|d| switched_off.contains(&d.id))
        {
            d.enabled = false;
            if let DeploymentBody::Ini { preset } = &mut d.body {
                preset.changes.clear();
                preset.created_sections.clear();
            }
        }
        upsert(m, preset);
        if let Some(prior) = revision {
            m.ini_revisions.push(IniRevision {
                config_path,
                game_id: game_id.to_string(),
                prior,
                saved_at: chrono::Utc::now().to_rfc3339(),
            });
        }
    })
}

/// Restores a preset's owned settings, refusing changed or ambiguous assignments.
fn release_preset(
    store: &ResourceStore,
    game_id: &str,
    preset: &Deployment,
    remove: bool,
) -> Result<(), String> {
    let p = preset_of(preset).expect("an INI deployment").clone();
    let id = preset.id.clone();
    let mut steps = Vec::new();
    let mut revision = None;
    if preset.enabled {
        let path = PathBuf::from(&p.config_path);
        let (_original, decoded, original_revision) = read_config(&path)?;
        let restored = restore_owned_ini(&decoded.text, &p)?;
        let new_bytes = ini::encode(&restored, decoded.encoding, decoded.eol)?;
        if p.created_file
            && restored.is_empty()
            && ini::preset_intact(&decoded.text, &p.changes)
            && !p.changes.is_empty()
        {
            let before = store.capture(&path)?;
            if before != original_revision {
                return Err("Engine.ini changed while restoring the preset".into());
            }
            steps.push(Step {
                destination: path.clone(),
                before: before.clone(),
                after: Content::Absent,
            });
            revision = Some(before);
        } else if original_revision != Content::Absent {
            if let Some((step, before)) = config_step(store, &path, &original_revision, &new_bytes)?
            {
                steps.push(step);
                revision = Some(before);
            }
        }
    }
    store.apply(game_id, steps, |m| {
        if remove {
            m.deployments.retain(|d| d.id != id);
        }
        if let Some(d) = m.deployments.iter_mut().find(|d| d.id == id) {
            d.enabled = false;
            if let DeploymentBody::Ini { preset } = &mut d.body {
                preset.changes.clear();
                preset.created_sections.clear();
            }
        }
        if let Some(prior) = revision {
            m.ini_revisions.push(IniRevision {
                config_path: p.config_path,
                game_id: game_id.to_string(),
                prior,
                saved_at: chrono::Utc::now().to_rfc3339(),
            });
        }
    })
}

// ---------------------------------------------------------------------------------------
// Enable, disable, uninstall
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResourceAction {
    Enable,
    Disable,
    Uninstall,
}

pub(crate) async fn review_recovery(
    app: &AppHandle,
    game_id: &str,
    uid: Option<String>,
) -> Result<ResourceRecoveryReview, String> {
    let context = current_context(app, game_id)?;
    let store = ResourceStore::for_app(app)?;
    let _guard = locks(app).acquire(&[]).await;
    require_context(app, &context)?;
    let bound = context.clone();
    let (grant, deployments, files) = blocking(move || {
        let manifest = store.load_manifest()?;
        let (journal_id, initial) = match uid {
            Some(uid) => {
                let id = uid
                    .strip_prefix(RESOURCE_UID_PREFIX)
                    .ok_or("Choose a movie pack or INI preset")?;
                let deployment = manifest
                    .deployments
                    .iter()
                    .find(|d| d.id == id)
                    .ok_or("This resource is no longer managed")?;
                if deployment.game_id != bound.game_id || deployment.game_path != bound.game_path {
                    return Err("This resource belongs to another game install".into());
                }
                (None, deployment_paths(deployment))
            }
            None => {
                let (id, paths) = store.recovery_paths(&bound.game_id)?;
                (Some(id), paths)
            }
        };
        let paths = overlapping_paths(&manifest, &initial);
        let current = paths
            .iter()
            .map(|path| live_content(path))
            .collect::<Result<Vec<_>, _>>()?;
        let affected: Vec<_> = manifest
            .deployments
            .iter()
            .filter(|d| deployment_paths(d).iter().any(|path| paths.contains(path)))
            .collect();
        let deployments = affected
            .iter()
            .map(|d| format!("{} ({})", d.name, d.game_id))
            .collect();
        let mut games: Vec<_> = affected.iter().map(|d| d.game_id.clone()).collect();
        games.push(bound.game_id.clone());
        games.sort();
        games.dedup();
        let files = paths
            .iter()
            .zip(&current)
            .map(|(path, current)| ResourceRecoveryFile {
                path: path.to_string_lossy().into_owned(),
                current: current.clone(),
            })
            .collect();
        Ok((
            RecoveryReview {
                context: bound,
                revision: manifest.revision,
                journal_id,
                paths,
                current,
                games,
                issued: Instant::now(),
            },
            deployments,
            files,
        ))
    })
    .await?;
    let handle = Uuid::new_v4().to_string();
    let mut grants = reviews(app).1.lock().unwrap_or_else(|e| e.into_inner());
    grants.retain(|_, grant| grant.issued.elapsed() < REVIEW_TTL);
    if grants.len() >= MAX_REVIEWS {
        return Err("Too many recovery reviews are open. Close them before trying again".into());
    }
    grants.insert(handle.clone(), grant);
    Ok(ResourceRecoveryReview {
        review_handle: handle,
        game_id: context.game_id,
        deployments,
        files,
    })
}

pub(crate) async fn keep_current(app: &AppHandle, handle: &str) -> Result<(), String> {
    let grant = reviews(app)
        .1
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(handle)
        .cloned()
        .ok_or("This recovery review has ended. Review the files again")?;
    if grant.issued.elapsed() >= REVIEW_TTL {
        return Err("This recovery review has expired. Review the files again".into());
    }
    require_context(app, &grant.context)?;
    for game in &grant.games {
        ensure_not_running(game).await?;
    }
    let store = ResourceStore::for_app(app)?;
    let _guard = locks(app).acquire(&grant.paths).await;
    require_context(app, &grant.context)?;
    for game in &grant.games {
        ensure_not_running(game).await?;
    }
    blocking(move || {
        for (path, expected) in grant.paths.iter().zip(&grant.current) {
            if live_content(path)? != *expected {
                return Err("A file changed since this recovery review. Review it again".into());
            }
        }
        store.keep_current(
            &grant.context.game_id,
            grant.paths,
            grant.journal_id.as_deref(),
            grant.revision,
        )
    })
    .await?;
    cancel_recovery(app, handle);
    Ok(())
}

pub(crate) fn cancel_recovery(app: &AppHandle, handle: &str) {
    reviews(app)
        .1
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(handle);
}

/// Routes an installed-list action on a resource row to its real operation.
pub(crate) async fn act(
    app: &AppHandle,
    game_id: &str,
    game_path: &str,
    uid: &str,
    action: ResourceAction,
) -> Result<(), String> {
    let id = uid
        .strip_prefix(RESOURCE_UID_PREFIX)
        .ok_or("not a resource row")?
        .to_string();
    let store = ResourceStore::for_app(app)?;
    let found = store
        .load_manifest()?
        .deployments
        .into_iter()
        .find(|d| d.id == id)
        .ok_or("this movie pack or preset is no longer installed")?;
    if found.game_id != game_id || found.game_path != game_path {
        return Err("this belongs to another game install; switch to it to change it".to_string());
    }
    require_context(
        app,
        &InstallContext {
            game_id: found.game_id.clone(),
            game_path: found.game_path.clone(),
            canonical_game_path: found.canonical_game_path.clone(),
            launcher: found.launcher.clone(),
        },
    )?;
    let paths = deployment_paths(&found);
    let (_guard, store) = lock_and_recover(app, game_id, &paths).await?;
    require_context(
        app,
        &InstallContext {
            game_id: found.game_id.clone(),
            game_path: found.game_path.clone(),
            canonical_game_path: found.canonical_game_path.clone(),
            launcher: found.launcher.clone(),
        },
    )?;
    let game_id = game_id.to_string();
    blocking(move || {
        let manifest = store.load_manifest()?;
        let d = manifest
            .deployments
            .iter()
            .find(|d| d.id == id)
            .cloned()
            .ok_or("this movie pack or preset is no longer installed")?;
        validate_deployment_paths(&d)?;
        let is_movie = matches!(d.body, DeploymentBody::Movie { .. });
        match (is_movie, action) {
            (_, ResourceAction::Enable) if d.enabled => Ok(()),
            (_, ResourceAction::Disable) if !d.enabled => Ok(()),
            (true, ResourceAction::Enable) => {
                apply_movie_pack(&store, &game_id, &manifest, d, None).map(|_| ())
            }
            (true, ResourceAction::Disable | ResourceAction::Uninstall) => {
                let mut steps = Vec::new();
                if d.enabled {
                    steps = movies::plan_restore(&manifest, &d)?;
                }
                let remove = action == ResourceAction::Uninstall;
                store.apply(&game_id, steps, |m| {
                    if remove {
                        m.deployments.retain(|x| x.id != d.id);
                    }
                    if let Some(x) = m.deployments.iter_mut().find(|x| x.id == d.id) {
                        x.enabled = false;
                    }
                    movies::prune_baselines(m);
                })
            }
            (false, ResourceAction::Enable) => apply_preset(&store, &game_id, &manifest, d, None),
            (false, ResourceAction::Disable) => release_preset(&store, &game_id, &d, false),
            (false, ResourceAction::Uninstall) => release_preset(&store, &game_id, &d, true),
        }
    })
    .await
}

fn validate_deployment_paths(deployment: &Deployment) -> Result<(), String> {
    let DeploymentBody::Movie { slots } = &deployment.body else {
        let preset = preset_of(deployment).expect("an INI deployment");
        if validate_engine_ini(Path::new(&preset.config_path))?
            != PathBuf::from(&preset.config_path)
        {
            return Err("The preset destination now resolves to a different file".into());
        }
        return Ok(());
    };
    let dir = movies::movies_dir(
        &deployment.game_id,
        &deployment.game_path,
        deployment.launcher.as_deref(),
    )?;
    let inventory =
        movies::slot_inventory(&deployment.game_id, &dir, deployment.launcher.as_deref())?;
    for slot in slots {
        if movies::slot_destination(&dir, &slot.slot, &inventory)?
            != PathBuf::from(&slot.destination)
        {
            return Err(format!(
                "The destination of {} now resolves to a different file",
                slot.slot
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Installed list
// ---------------------------------------------------------------------------------------

fn status_of(d: &Deployment) -> Result<ResourceStatus, String> {
    if !d.enabled {
        return Ok(ResourceStatus::Disabled);
    }
    let diverged = match &d.body {
        DeploymentBody::Movie { .. } => movies::pack_diverged(d)?,
        DeploymentBody::Ini { preset } => {
            let (bytes, revision) = read_ini_bytes(Path::new(&preset.config_path))?;
            if revision == Content::Absent {
                return Ok(ResourceStatus::Diverged);
            }
            match ini::decode(&bytes) {
                Ok(decoded) => !ini::preset_intact(&decoded.text, &preset.changes),
                Err(_) => true,
            }
        }
    };
    if diverged {
        return Ok(ResourceStatus::Diverged);
    }
    Ok(ResourceStatus::Applied)
}

fn row(d: &Deployment, status: ResourceStatus) -> InstalledMod {
    let (deployment, location, filename) = match &d.body {
        DeploymentBody::Movie { slots } => (
            ResourceDeployment::Movie,
            "movie",
            slots
                .iter()
                .map(|s| s.slot.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        ),
        DeploymentBody::Ini { .. } => (ResourceDeployment::Ini, "ini", "Engine.ini".to_string()),
    };
    let mut m = InstalledMod {
        uid: format!("{RESOURCE_UID_PREFIX}{}", d.id),
        id: hash_filename(&d.id),
        name: d.name.clone(),
        version: d.version.clone(),
        filename,
        enabled: d.enabled,
        installed_at: d.installed_at.clone(),
        file_id: d.file_id,
        location: Some(location.to_string()),
        deployment: Some(deployment),
        resource_status: Some(status),
        update_status: UpdateStatus::Unknown,
        ..InstalledMod::default()
    };
    if let (Some(source), Some(remote_id)) = (&d.source, &d.remote_id) {
        m.attach_catalog(
            source,
            remote_id.clone(),
            IdentityEvidence::InstallProvenance,
        );
        m.update_status = UpdateStatus::Known;
    }
    m
}

/// Installed-list rows for this install, derived only from the resource manifest.
pub(crate) fn installed_rows(
    app: &AppHandle,
    game_id: &str,
    game_path: &str,
) -> Result<(Vec<InstalledMod>, Option<String>), String> {
    if !movies::supports_movies(game_id) {
        return Ok((Vec::new(), None));
    }
    let store = ResourceStore::for_app(app)?;
    let manifest = store.load_manifest()?;
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    for d in manifest
        .deployments
        .iter()
        .filter(|d| d.game_id == game_id && d.game_path == game_path)
    {
        let status = match status_of(d) {
            Ok(status) => status,
            Err(error) => {
                errors.push(format!("{}: {error}", d.name));
                ResourceStatus::Blocked
            }
        };
        rows.push(row(d, status));
    }
    if store.has_pending(game_id)? {
        errors.push("An interrupted movie or Engine.ini change is pending. Review recovery in game settings".into());
    }
    Ok((
        rows,
        if errors.is_empty() {
            None
        } else {
            Some(errors.join("\n"))
        },
    ))
}

#[cfg(test)]
#[path = "resources_tests.rs"]
mod tests;
