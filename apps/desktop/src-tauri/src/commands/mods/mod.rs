mod cleanup;
mod companions;
mod crimeboss_settings;
mod decisions;
mod diesel_signals;
mod engine;
mod file_transaction;
mod folders;
mod graphics_config;
mod host_mods;
mod identify;
pub mod identity;
mod ini;
mod install;
#[cfg(test)]
mod install_worker_tests;
mod moves;
pub(crate) mod movies;
mod mp4;
mod naming;
mod native_files;
mod nexus_content;
mod paths;
mod pdmod;
mod plugin_repair;
mod reorder;
mod resource_state;
mod resources;
mod staged;
mod staging_tokens;
pub use self::graphics_config::GraphicsConfigLocations;
pub use self::resource_state::{PendingGameLaunch, ResourceLocks};
pub(crate) use self::resources::ensure_not_running as require_resource_game_idle;
pub(crate) use self::resources::launch_preflight as resource_launch_preflight;
pub(crate) use self::resources::refuse_resource_uid;
pub use self::resources::{IniLocations, ResourceReviews};
pub(crate) use self::staging_tokens::StagingRegistry;
mod state;
mod types;
mod ue4ss_modstxt;
mod unreal_config;
pub(crate) mod unreal_plugin;
mod zip;

// Public API used by lib.rs, launchers/, and other modules
pub use self::companions::LeftoverFiles;
pub use self::engine::{
    backup_dir, engine_for_game, ModEngineConfig, ModUnit, ScanTarget, SharedPaks, StoreLayout,
};
pub use self::identity::IdentityEvidence;
pub use self::install::install_mod_from_path;
pub use self::paths::{find_untracked_host_packs, find_untracked_paks, get_state_path, mods_base};
pub use self::plugin_repair::PluginInstallReport;
use self::state::save_error;
pub use self::state::{get_folder_path, load_for_scan, read_state};
pub use self::types::{
    InstalledMod, InstalledResponse, ModFolder, ModsState, TopLevelItem, UpdateStatus,
};
pub use self::zip::{compute_md5, compute_sha256};

// Mod-identification helpers for the get_installed pipeline, see identify.rs
pub(crate) use self::identify::hash_file;
use self::identify::staged_content_sha256;
#[cfg(test)]
pub(crate) use self::identify::{embedded_modworkshop_id, upgrade_negative_ids_with_conn};
pub(crate) use self::identify::{
    ensure_untracked_folders, hash_untracked, hashable_file_for_mod_dir, identify_untracked,
    regroup_negative_ids_by_name_suffix, restore_install_identities,
    resync_crimeboss_enabled_flags, upgrade_negative_ids,
};
pub(crate) use self::ue4ss_modstxt::entry_name as ue4ss_entry_name;
use crate::commands::analytics::track_mod_installed;

// Internal helpers used by Tauri commands in this file
pub(crate) use self::folders::{
    create_folder_op, delete_folder_op, move_folder_op, rename_folder_op,
};
pub(crate) use self::install::{
    disable_mod_op, enable_mod_op, forget_mod_op, install_host_pack_op,
    move_crimeboss_mod_target_op, uninstall_mod_op,
};
pub(crate) use self::naming::{hash_filename, sidecar_path, strip_priority_prefix, unit_filename};
pub(crate) use self::paths::{active_mod_path, disabled_base, disabled_mod_path, resolve_pak_path};
pub(crate) use self::reorder::{
    move_mod_to_folder_op, reorder_children_op, reorder_mods_in_folder_op,
};
pub(crate) use self::state::{save_state, STATE_FILENAME};
pub(crate) use self::zip::{
    extract_archive_flat, extract_entry, extract_entry_into_crimeboss_skeleton_at,
    extract_loader_package, extract_staged_dir, extract_staged_entry_with_sidecars,
    list_unit_entries, mark_archive_files, resolve_archive_download, InstallPrompt, ModContext,
    ResolveError,
};

// Re-exports needed only in test builds (suppressed in release to avoid unused-import warnings)
#[cfg(test)]
pub(crate) use self::crimeboss_settings::{
    find_content_file_in_dir, read_enabled_from_file, set_enabled_in_file,
    settings_id_from_pak_filename,
};
#[cfg(test)]
pub(crate) use self::engine::{disabled_dir, mods_dir, Activation};
#[cfg(test)]
pub(crate) use self::naming::{
    apply_priority_prefix, derive_content_segment, install_file_id, make_uid, mod_folder_name,
    recover_published_filename,
};
#[cfg(test)]
pub(crate) use self::ue4ss_modstxt::{
    entry_name, read_enabled_from_mods_txt, set_enabled_in_mods_txt,
};
#[cfg(test)]
pub(crate) use self::zip::{
    classify_archive_dirs, copy_capped, detect_archive, extract_budget, has_ue4ss_loader_signature,
    is_unplaceable_pack, is_zip, safe_dest, ArchiveFormat, MIN_EXTRACT_BUDGET,
};

use crate::commands::api::{api_get, http_client, user_agent};
use crate::commands::download::{cancellable, download_file};
use crate::commands::mod_index;
use crate::commands::settings::{self, game_settings, read_settings};
use crate::commands::sources;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Clone, Serialize)]
struct ScanEvent {
    phase: &'static str,
    total: usize,
}

/// Per-game async locks serializing every read-modify-write of a game's .modrex.json.
/// save_state is atomic per write, but two interleaved commands (an nxm:// install
/// landing mid focus-refresh, for example) can each read the same state and the second
/// write silently drops the first's changes. Per game so different games stay parallel;
/// never hold a guard across a network download, only the disk-write + state span.
#[derive(Default)]
pub struct StateLocks(
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
);

impl StateLocks {
    pub async fn acquire(&self, game_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(game_id.to_string())
            .or_default()
            .clone();
        lock.lock_owned().await
    }
}

/// Also taken by launching and restoring, which move the same folders installs write into.
/// Take it after the resource lock, never before, so the two always nest the same way.
pub(crate) async fn lock_game_state(
    app: &AppHandle,
    game_id: &str,
) -> tokio::sync::OwnedMutexGuard<()> {
    use tauri::Manager;
    app.state::<StateLocks>().acquire(game_id).await
}

async fn stage_download(
    app: &AppHandle,
    downloaded: PathBuf,
    cfg: &'static ModEngineConfig,
) -> Result<staged::Staged, ResolveError> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        resolve_archive_download(downloaded, cfg, staged_archives(&app))
    })
    .await
    .map_err(|error| ResolveError::Failure(format!("Archive staging failed: {error}")))?
}

async fn commit_install(
    state_guard: tokio::sync::OwnedMutexGuard<()>,
    commit: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // cancelled_install_caller_keeps_game_locked_until_worker_finishes covers this lifetime.
        let _state_guard = state_guard;
        commit()
    })
    .await
    .map_err(|error| format!("Installation worker failed: {error}"))?
}

async fn stage_archive_choice(
    app: &AppHandle,
    archive_handle: String,
    kind: staging_tokens::StagedArchiveKind,
    entry_id: staging_tokens::ArchiveEntryId,
    cfg: &'static ModEngineConfig,
    target: &'static ScanTarget,
    cb_dir_entry: bool,
) -> Result<(staging_tokens::StagedEntry, PathBuf, cleanup::CleanupPlan), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let registry = staged_archives(&app);
        let zip = registry
            .borrow(&archive_handle, kind)
            .ok_or("this archive is no longer available to install from")?;
        let _borrow = staging_tokens::BorrowGuard::new(registry, &archive_handle);
        let entry = registry
            .entry(&archive_handle, kind, entry_id)
            .ok_or("that archive entry is no longer available to install")?;
        let (_, filename) = entry_names(&entry.display_name);
        let (staged, cleanup) =
            stage_archive_entry(cfg, target, &zip, &entry, cb_dir_entry, &filename)?;
        Ok((entry, staged, cleanup))
    })
    .await
    .map_err(|error| format!("Archive entry staging failed: {error}"))?
}

/// What an install command produced: a finished install, or an archive that needs a
/// user decision first. Returned in the Ok channel so the renderer handles every case
/// with an exhaustive switch instead of parsing sentinel strings out of errors.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum InstallOutcome {
    Installed,
    NeedsPicker(zip::ZipMultiPakPayload),
    NeedsHostChoice(zip::HostPackPayload),
    NeedsCbFlatConfirm(zip::CbFlatPayload),
    NeedsLoaderConfirm(Ue4ssReplacePayload),
    NeedsResourceReview(resources::ResourceReviewPayload),
    Unrecognized,
    Cancelled,
}

/// The mod page a loader package came from. Absent for a dropped file, which has no page
/// behind it, and the loader is then recorded as having none rather than as coming from
/// whichever page happened to be recorded before.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoaderPage {
    pub source: String,
    pub remote_id: String,
    pub file_id: Option<i64>,
    pub version: String,
}

impl LoaderPage {
    fn recorded(self) -> settings::LoaderInstall {
        settings::LoaderInstall {
            source: self.source,
            remote_id: self.remote_id,
            file_id: self.file_id,
            version: self.version,
            installed_at: Utc::now().to_rfc3339(),
        }
    }
}

/// A UE4SS package held back because one is already installed, with what installing it would
/// do to the installation that is there.
///
/// The loader is not tracked in state.json, so replacing it removes files no mod record
/// describes. What those are depends on which release is installed, which is why they are
/// named here rather than described in general terms.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Ue4ssReplacePayload {
    /// Backend-issued handle for the held package. The renderer never learns the path, so it
    /// cannot name a different archive for the replacement to install.
    pub archive_handle: String,
    pub mod_name: String,
    pub page: Option<LoaderPage>,
    /// Files of the installed release the replacement removes.
    pub replaced: Vec<String>,
    /// Mod folders the user added, which it keeps, along with their entries in mods.txt.
    pub preserved: Vec<String>,
}

impl From<InstallPrompt> for InstallOutcome {
    fn from(p: InstallPrompt) -> Self {
        match p {
            InstallPrompt::ZipMultiPak(p) => InstallOutcome::NeedsPicker(p),
            InstallPrompt::HostModPack(p) => InstallOutcome::NeedsHostChoice(p),
            InstallPrompt::CbFlatArchive(p) => InstallOutcome::NeedsCbFlatConfirm(p),
            InstallPrompt::UnrecognizedArchive => InstallOutcome::Unrecognized,
        }
    }
}

// Mod identification (get_installed pipeline) lives in identify.rs
#[tauri::command]
#[specta::specta]
pub async fn get_installed(app: AppHandle, game_id: String) -> Result<InstalledResponse, String> {
    let game_id = game_id.as_str();
    let cfg = engine_for_game(game_id)?;
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, game_id).and_then(|gs| gs.game_path.clone())
    else {
        return Ok(InstalledResponse {
            mods: vec![],
            folders: vec![],
            mods_hidden: false,
            state_unreadable: false,
            resource_error: None,
            resource_recovery_pending: false,
        });
    };

    // Launch preflight takes the resource lock before the game state lock.
    resources::relocate_stale_presets(&app, game_id, &game_path).await;
    let _state_guard = lock_game_state(&app, game_id).await;
    let native_guard = native_files::NativeGuard::load(&game_path, cfg)?;
    let state_path = get_state_path(&game_path, cfg);
    native_guard.check_state_path(&state_path)?;
    let mods_hidden =
        cfg.primary().shared_paks.is_none() && backup_dir(&game_path, cfg.primary()).exists();

    let (mut state, writeback) = load_for_scan(&game_path, &state_path, cfg);
    let repaired = !mods_hidden && repair_installs(&app, &game_path, cfg, &mut state);
    let any_upgraded =
        upgrade_negative_ids(&app, &game_path, cfg, &state.folders, &mut state.mods) || repaired;
    regroup_negative_ids_by_name_suffix(&mut state.mods);

    // The player can also toggle mods from Crime Boss's own Options > Mods screen, so pull
    // that state back in and stop Modrex's tracked flag silently disagreeing with the game.
    let cb_resynced = if decisions::resyncs_enabled_flags(cfg) {
        let launcher = game_settings(&settings, game_id).and_then(|gs| gs.launcher.clone());
        resync_crimeboss_enabled_flags(
            &game_path,
            cfg,
            &state.folders,
            &mut state.mods,
            launcher.as_deref(),
        )
    } else {
        false
    };

    // Recover host-pack sets present on disk but absent from state (e.g. after a state rebuild):
    // they live inside another mod, so the scan-target walk can't find them. Identify each by its
    // representative file's SHA256 against the index (like the untracked pipeline); a hit restores
    // the real id/name/version, a miss leaves a negative-id, folder-named entry whose stored
    // sha256 lets a future index update upgrade it. Either way it's a manageable host-pack entry.
    let mut discovered_hosts = false;
    for (host_id, subpath, set_name, enabled, dir) in
        find_untracked_host_packs(&game_path, cfg, &state.mods, &state.folders)
    {
        let sha256 = match hashable_file_for_mod_dir(&dir, cfg.primary().contained_extension) {
            Some(p) => compute_sha256(&p).await.ok(),
            None => None,
        };
        let hit = sha256
            .as_deref()
            .and_then(|s| mod_index::lookup_sha256(&app, s, cfg.game_id, cfg.index_game_name));
        let location = Some(format!("host:{}:{}", host_id, subpath));
        let entry = match hit {
            Some(h) => InstalledMod {
                uid: format!("{}_{}", h.file_remote_id, set_name),
                name: h.mod_name,
                version: h.version,
                filename: set_name,
                enabled,
                file_id: Some(h.file_remote_id),
                sha256,
                location,
                installed_at: Utc::now().to_rfc3339(),
                ..InstalledMod::from_catalog(
                    "modworkshop",
                    h.mod_remote_id.to_string(),
                    IdentityEvidence::CatalogHash,
                )
            },
            None => InstalledMod {
                uid: set_name.clone(),
                id: hash_filename(&set_name),
                name: set_name.clone(),
                filename: set_name,
                enabled,
                sha256,
                location,
                installed_at: Utc::now().to_rfc3339(),
                ..InstalledMod::default()
            },
        };
        state.mods.push(entry);
        discovered_hosts = true;
    }

    if mods_hidden {
        let index = mod_index::open_index(&app, cfg.game_id);
        let identified = identity::ensure_identities(
            &game_path,
            cfg,
            &state.folders,
            &mut state.mods,
            index.as_ref(),
        );
        if any_upgraded || discovered_hosts || cb_resynced || identified {
            writeback.save(&state_path, &state, "refreshed identities");
        }
        let mut mods = state.mods;
        push_installed_loaders(cfg, &game_path, &settings, &mut mods);
        return Ok(with_resource_rows(
            &app,
            game_id,
            &game_path,
            InstalledResponse {
                mods,
                folders: state.folders,
                mods_hidden: true,
                state_unreadable: writeback.blocked(),
                resource_error: None,
                resource_recovery_pending: false,
            },
        )
        .await);
    }

    let known: HashSet<String> = state
        .mods
        .iter()
        .map(|m| {
            let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
            let rel_path = match rel {
                Some(r) => format!("{}/{}", r, m.filename),
                None => m.filename.clone(),
            };
            format!("{}:{}", m.location.as_deref().unwrap_or(""), rel_path)
        })
        .collect();

    let mut untracked = find_untracked_paks(&game_path, &known, cfg).await;
    let mut native_paths = HashSet::new();
    for (relative, enabled, location) in &untracked {
        let target = cfg.target_for(location.as_deref());
        let active = mods_base(&game_path, target).join(relative);
        if native_guard.protects(&active)? {
            native_paths.insert((relative.clone(), location.clone()));
            continue;
        }
        let path = if *enabled {
            active
        } else {
            disabled_base(&game_path, target)
                .join(format!("{relative}{}", target.disabled_suffix()))
        };
        native_guard.check_file(&path)?;
    }
    untracked.retain(|(relative, _, location)| {
        !native_paths.contains(&(relative.clone(), location.clone()))
    });
    native_guard.verify_unchanged()?;
    if untracked.is_empty() {
        let index = mod_index::open_index(&app, cfg.game_id);
        let identified = identity::ensure_identities(
            &game_path,
            cfg,
            &state.folders,
            &mut state.mods,
            index.as_ref(),
        );
        let (mut mods, any_checked) =
            mark_archive_files(&game_path, &state.folders, state.mods, cfg);
        let containers_changed =
            mark_containers(&game_path, game_id, cfg, &state.folders, &mut mods);
        if any_checked
            || any_upgraded
            || discovered_hosts
            || cb_resynced
            || identified
            || containers_changed
        {
            native_guard.verify_unchanged()?;
            writeback.save(
                &state_path,
                &ModsState {
                    folders: state.folders.clone(),
                    mods: mods.clone(),
                },
                "refreshed identities",
            );
        }
        push_installed_loaders(cfg, &game_path, &settings, &mut mods);
        return Ok(with_resource_rows(
            &app,
            game_id,
            &game_path,
            InstalledResponse {
                mods,
                folders: state.folders,
                mods_hidden: false,
                state_unreadable: writeback.blocked(),
                resource_error: None,
                resource_recovery_pending: false,
            },
        )
        .await);
    }

    let folder_path_to_id = ensure_untracked_folders(&mut state, &untracked);
    let _ = app.emit(
        "installed:scan",
        ScanEvent {
            phase: "hashing",
            total: untracked.len(),
        },
    );
    let sha256s = hash_untracked(&game_path, &untracked, cfg).await;
    let index = mod_index::open_index(&app, cfg.game_id);
    let mods = identify_untracked(
        &mut state,
        &untracked,
        &sha256s,
        &folder_path_to_id,
        cfg,
        &game_path,
        index.as_ref(),
    );

    let folders = state.folders;
    let mut mods = mods;
    identity::ensure_identities(&game_path, cfg, &folders, &mut mods, index.as_ref());
    let (mut mods, _) = mark_archive_files(&game_path, &folders, mods, cfg);
    mark_containers(&game_path, game_id, cfg, &folders, &mut mods);
    native_guard.verify_unchanged()?;
    writeback.save(
        &state_path,
        &ModsState {
            folders: folders.clone(),
            mods: mods.clone(),
        },
        "the scanned state",
    );
    push_installed_loaders(cfg, &game_path, &settings, &mut mods);
    Ok(with_resource_rows(
        &app,
        game_id,
        &game_path,
        InstalledResponse {
            mods,
            folders,
            mods_hidden: false,
            state_unreadable: writeback.blocked(),
            resource_error: None,
            resource_recovery_pending: false,
        },
    )
    .await)
}

/// Appends movie pack and preset rows, which come only from the resource manifest and are
/// added after every state write so they can never be saved into .modrex.json.
async fn with_resource_rows(
    app: &AppHandle,
    game_id: &str,
    game_path: &str,
    mut response: InstalledResponse,
) -> InstalledResponse {
    let resource_app = app.clone();
    let resource_game = game_id.to_string();
    let resource_path = game_path.to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        resources::installed_rows(&resource_app, &resource_game, &resource_path)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    match result {
        Ok((rows, error, recovery_pending)) => {
            response.mods.extend(rows);
            response.resource_error = error;
            response.resource_recovery_pending = recovery_pending;
        }
        Err(e) => {
            log::warn!("get_installed {game_id}: resource records: {e}");
            response.resource_error = Some(e);
        }
    }
    response
}

#[tauri::command]
#[specta::specta]
pub async fn list_leftover_files(
    app: AppHandle,
    game_id: String,
) -> Result<Vec<LeftoverFiles>, String> {
    let cfg = engine_for_game(&game_id)?;
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, &game_id).and_then(|gs| gs.game_path.clone())
    else {
        return Ok(vec![]);
    };
    let _state_guard = lock_game_state(&app, &game_id).await;
    companions::leftover_sets(&game_path, cfg)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_leftover_files(
    app: AppHandle,
    game_id: String,
    sets: Vec<LeftoverFiles>,
) -> Result<(), String> {
    let cfg = engine_for_game(&game_id)?;
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, &game_id).and_then(|gs| gs.game_path.clone())
    else {
        return Err(format!("{game_id} has no configured game path"));
    };
    let _state_guard = lock_game_state(&app, &game_id).await;
    companions::delete_leftover_sets(&game_path, cfg, &sets)
}

/// Puts back what earlier releases broke before anything reads the records: companions a
/// reorder split from their pak, and identities an older build rewrote. True when a record
/// changed. The index stays open only for this, since the index refresh cannot replace a
/// database file that is open on Windows.
fn repair_installs(
    app: &AppHandle,
    game_path: &str,
    cfg: &ModEngineConfig,
    state: &mut ModsState,
) -> bool {
    let index = mod_index::open_index(app, cfg.game_id);
    companions::rejoin_split_companions(
        game_path,
        cfg,
        &state.folders,
        &state.mods,
        index.as_ref(),
    );
    index.as_ref().is_some_and(|conn| {
        restore_install_identities(conn, game_path, cfg, &state.folders, &mut state.mods)
    })
}

fn mark_containers(
    game_path: &str,
    game_id: &str,
    cfg: &ModEngineConfig,
    folders: &[ModFolder],
    mods: &mut [InstalledMod],
) -> bool {
    let Some(crate::game_package::PackageReaderBinding::Unreal { aes_key }) =
        crate::commands::games::game_spec(game_id).and_then(|spec| spec.package_reader)
    else {
        return false;
    };
    companions::mark_container_missing(game_path, cfg, folders, mods, aes_key)
}

#[tauri::command]
#[specta::specta]
pub async fn install_mod(
    app: AppHandle,
    mod_id: u32,
    file_id: Option<u32>,
    game_path: String,
    folder_id: Option<String>,
    game_id: String,
) -> Result<InstallOutcome, String> {
    let download_id = match file_id {
        Some(file_id) => format!("file:{mod_id}:{file_id}"),
        None => format!("mod:{mod_id}"),
    };
    let prep = async {
        let mod_val = api_get(&app, &format!("/mods/{}", mod_id), vec![]).await?;

        let mod_name = mod_val["name"].as_str().unwrap_or("").to_string();
        let mod_version = mod_val["version"].as_str().unwrap_or("").to_string();
        let remote_id = mod_val["id"].as_i64().unwrap_or(0);

        let file = match file_id {
            Some(file_id) => {
                let f = api_get(&app, &format!("/files/{file_id}"), vec![]).await?;
                if f["mod_id"].as_i64() != Some(remote_id) {
                    return Err(format!("file {file_id} does not belong to mod {mod_id}"));
                }
                f
            }
            None if !mod_val["download"].is_null() => mod_val["download"].clone(),
            None if mod_val["has_download"].as_bool().unwrap_or(false) => {
                api_get(&app, &format!("/mods/{}/files/latest", mod_id), vec![]).await?
            }
            None => return Err("Mod has no download".to_string()),
        };
        let (file_id, download_url, file_type) = (
            file["id"].as_i64().unwrap_or(0),
            file["download_url"]
                .as_str()
                .ok_or("no download_url")?
                .to_string(),
            file["type"].as_str().unwrap_or("pak").to_string(),
        );

        let source_name = hosted_resource_name(&download_url)
            .or_else(|| file["name"].as_str().map(str::to_owned))
            .unwrap_or_else(|| format!("{mod_name}.{file_type}"));
        let downloaded = download_file(
            &app,
            &download_url,
            &file_type,
            &download_id,
            Some(&game_id),
        )
        .await?;
        Ok::<_, String>((
            mod_name,
            mod_version,
            remote_id,
            file_id,
            file_type,
            downloaded,
            source_name,
        ))
    };
    let Some(prep) = cancellable(&download_id, prep).await else {
        return Ok(InstallOutcome::Cancelled);
    };

    let (mod_name, mod_version, remote_id, file_id, file_type, downloaded, source_name) = match prep
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("install_mod {mod_id}: {e}");
            return Err(e);
        }
    };

    let cfg = engine_for_game(game_id.as_str())?;
    let staged::Staged {
        root: tmp,
        cleanup: cleanup_plan,
        name_source,
        target_tag: location_tag,
        original_archive: zip_orig,
    } = match stage_download(&app, downloaded, cfg).await {
        Err(ResolveError::Ue4ssLoader(zip_path)) => {
            return answer_ue4ss_package(
                &app,
                cfg,
                &game_path,
                zip_path,
                Some(LoaderPage {
                    source: "modworkshop".to_string(),
                    remote_id: remote_id.to_string(),
                    file_id: Some(file_id),
                    version: mod_version.clone(),
                }),
                mod_name.clone(),
            )
            .await;
        }
        Err(ResolveError::Prompt(prompt)) => {
            return Ok((*prompt)
                .with_mod_context(ModContext {
                    mod_id: remote_id,
                    mod_name: mod_name.clone(),
                    file_id,
                    file_type: file_type.clone(),
                    mod_version: mod_version.clone(),
                })
                .into());
        }
        Err(ResolveError::Resources(found)) => {
            return answer_resources(
                &app,
                &game_id,
                &game_path,
                *found,
                &source_name,
                resources::Provenance {
                    name: mod_name.clone(),
                    version: mod_version.clone(),
                    source: Some("modworkshop".to_string()),
                    remote_id: Some(remote_id.to_string()),
                    file_id: Some(file_id),
                    author: None,
                    thumbnail_url: None,
                },
                ModContext {
                    mod_id: remote_id,
                    mod_name: mod_name.clone(),
                    file_id,
                    file_type: file_type.clone(),
                    mod_version: mod_version.clone(),
                },
            )
            .await
            .map(InstallOutcome::NeedsResourceReview)
            .inspect_err(|e| log::warn!("install_mod {mod_id}: {e}"));
        }
        Err(ResolveError::Failure(e)) => {
            log::warn!("install_mod {mod_id}: {e}");
            return Err(e);
        }
        Ok(v) => v,
    };
    let target = cfg.target_for(location_tag.as_deref());

    let result = async {
        let sha256 = staged_content_sha256(target, &tmp).await?;
        let state_guard = lock_game_state(&app, cfg.game_id).await;
        let app = app.clone();
        let file_type = file_type.clone();
        commit_install(state_guard, move || {
            let uid = file_id.to_string();
            // The real modworkshop id, kept as a string for remote_id and identity comparisons.
            // InstalledMod.id is an opaque, source-scoped key (see
            // sources::source_native_local_id) and is never compared against this directly.
            let remote_id_str = remote_id.to_string();
            let sp = get_state_path(&game_path, cfg);
            let superseded = plugin_repair::set_aside_superseded_paks(
                &game_path,
                &sp,
                cfg,
                target,
                Some(&remote_id_str),
            )?;
            let paks_disabled = superseded.all_disabled;
            let saved =
                state::read_state_for_game(&game_path, &sp, cfg).map_err(|e| e.to_string())?;
            let existing_entry = saved.mods.iter().find(|m| m.uid == uid).or_else(|| {
                if remote_id <= 0 {
                    return None;
                }
                let same: Vec<_> = saved
                    .mods
                    .iter()
                    .filter(|m| m.remote_id.as_deref() == Some(remote_id_str.as_str()))
                    .collect();
                // Only inherit for single-entry mods; multi-pak entries span different folders.
                if same.len() == 1 {
                    same.into_iter().next()
                } else {
                    None
                }
            });
            // Don't inherit folder when same-id already has multiple files; each pak is placed deliberately.
            let effective_folder_id = folder_id.or_else(|| {
                if remote_id > 0
                    && saved
                        .mods
                        .iter()
                        .filter(|m| m.remote_id.as_deref() == Some(remote_id_str.as_str()))
                        .count()
                        > 1
                {
                    return None;
                }
                existing_entry.and_then(|e| e.folder_id.clone())
            });
            // A plugin's folder is named after the descriptor this release ships.
            let filename = saved
                .mods
                .iter()
                .find(|m| m.uid == uid && !target.is_unreal_plugin_unit())
                .map(|m| m.filename.clone())
                .unwrap_or_else(|| {
                    decisions::install_filename_from_mod_name(
                        cfg,
                        target,
                        &mod_name,
                        &tmp,
                        name_source,
                    )
                });
            let was_disabled = match existing_entry {
                Some(e) => !e.enabled,
                None => plugin_repair::installs_disabled(
                    cfg,
                    &saved.mods,
                    target,
                    &uid,
                    &filename,
                    file_id,
                    paks_disabled,
                ),
            };

            // If the mod had a single previously-installed entry under a different uid
            // (i.e. an older version with a different file_id), remove it first so
            // install_mod_from_path doesn't produce two entries for the same mod.
            if saved.mods.iter().all(|m| m.uid != uid) && remote_id > 0 {
                let same: Vec<_> = saved
                    .mods
                    .iter()
                    .filter(|m| m.remote_id.as_deref() == Some(remote_id_str.as_str()))
                    .collect();
                if same.len() == 1 {
                    uninstall_mod_op(&game_path, &sp, &same[0].uid.clone(), cfg)?;
                }
            }

            install_mod_from_path(
                &game_path,
                &sp,
                InstalledMod {
                    uid: uid.clone(),
                    name: mod_name,
                    version: mod_version,
                    filename,
                    enabled: true,
                    installed_at: Utc::now().to_rfc3339(),
                    file_id: Some(file_id),
                    file_type: Some(file_type),
                    sha256: Some(sha256),
                    ..InstalledMod::from_catalog(
                        "modworkshop",
                        remote_id_str.clone(),
                        IdentityEvidence::InstallProvenance,
                    )
                },
                &tmp,
                effective_folder_id,
                cfg,
                target,
            )?;
            superseded.commit();

            if was_disabled {
                let settings = read_settings(&app);
                let launcher_str =
                    game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
                disable_mod_op(&game_path, &sp, &uid, cfg, launcher_str.as_deref())?;
            }

            Ok::<(), String>(())
        })
        .await
    }
    .await;

    cleanup::run_staged(&cleanup_plan, zip_orig).await;
    if result.is_ok() {
        register_download(&app, file_id).await;
    }
    match &result {
        Ok(_) => track_mod_installed(&app, game_id.as_str(), mod_id as i64, &file_type),
        Err(e) => log::warn!("install_mod {mod_id}: {e}"),
    }
    result.map(|()| InstallOutcome::Installed)
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn install_file(
    app: AppHandle,
    mod_id: i64,
    mod_name: String,
    file_id: i64,
    download_url: String,
    file_type: String,
    mod_version: String,
    game_path: String,
    game_id: String,
) -> Result<InstallOutcome, String> {
    let cfg = engine_for_game(game_id.as_str())?;
    let source_name =
        hosted_resource_name(&download_url).unwrap_or_else(|| format!("{mod_name}.{file_type}"));
    let download_id = format!("file:{mod_id}:{file_id}");
    let fetch = download_file(
        &app,
        &download_url,
        &file_type,
        &download_id,
        Some(&game_id),
    );
    let Some(fetched) = cancellable(&download_id, fetch).await else {
        return Ok(InstallOutcome::Cancelled);
    };
    let downloaded = match fetched {
        Ok(v) => v,
        Err(e) => {
            log::warn!("install_file {mod_id}/{file_id}: {e}");
            return Err(e);
        }
    };
    let staged::Staged {
        root: tmp,
        cleanup: cleanup_plan,
        name_source,
        target_tag: location_tag,
        original_archive: zip_orig,
    } = match stage_download(&app, downloaded, cfg).await {
        Err(ResolveError::Ue4ssLoader(zip_path)) => {
            return answer_ue4ss_package(
                &app,
                cfg,
                &game_path,
                zip_path,
                Some(LoaderPage {
                    source: "modworkshop".to_string(),
                    remote_id: mod_id.to_string(),
                    file_id: Some(file_id),
                    version: mod_version.clone(),
                }),
                mod_name.clone(),
            )
            .await;
        }
        Err(ResolveError::Prompt(prompt)) => {
            return Ok((*prompt)
                .with_mod_context(ModContext {
                    mod_id,
                    mod_name: mod_name.clone(),
                    file_id,
                    file_type: file_type.clone(),
                    mod_version: mod_version.clone(),
                })
                .into());
        }
        Err(ResolveError::Resources(found)) => {
            return answer_resources(
                &app,
                &game_id,
                &game_path,
                *found,
                &source_name,
                resources::Provenance {
                    name: mod_name.clone(),
                    version: mod_version.clone(),
                    source: Some("modworkshop".to_string()),
                    remote_id: Some(mod_id.to_string()),
                    file_id: Some(file_id),
                    author: None,
                    thumbnail_url: None,
                },
                ModContext {
                    mod_id,
                    mod_name: mod_name.clone(),
                    file_id,
                    file_type: file_type.clone(),
                    mod_version: mod_version.clone(),
                },
            )
            .await
            .map(InstallOutcome::NeedsResourceReview)
            .inspect_err(|e| log::warn!("install_file {mod_id}/{file_id}: {e}"));
        }
        Err(ResolveError::Failure(e)) => {
            log::warn!("install_file {mod_id}/{file_id}: {e}");
            return Err(e);
        }
        Ok(v) => v,
    };
    let target = cfg.target_for(location_tag.as_deref());

    let result = async {
        let sha256 = staged_content_sha256(target, &tmp).await?;
        let state_guard = lock_game_state(&app, cfg.game_id).await;
        let app = app.clone();
        let file_type = file_type.clone();
        commit_install(state_guard, move || {
            let uid = file_id.to_string();
            let mod_id_str = mod_id.to_string();
            let sp = get_state_path(&game_path, cfg);
            let superseded = plugin_repair::set_aside_superseded_paks(
                &game_path,
                &sp,
                cfg,
                target,
                Some(&mod_id_str),
            )?;
            let paks_disabled = superseded.all_disabled;
            let saved =
                state::read_state_for_game(&game_path, &sp, cfg).map_err(|e| e.to_string())?;
            let existing_entry = saved.mods.iter().find(|m| m.uid == uid).or_else(|| {
                if mod_id <= 0 {
                    return None;
                }
                let same: Vec<_> = saved
                    .mods
                    .iter()
                    .filter(|m| m.remote_id.as_deref() == Some(mod_id_str.as_str()))
                    .collect();
                if same.len() == 1 {
                    same.into_iter().next()
                } else {
                    None
                }
            });
            // Never inherit folder when this mod_id already has multiple installed files.
            let effective_folder_id = if mod_id > 0
                && saved
                    .mods
                    .iter()
                    .filter(|m| m.remote_id.as_deref() == Some(mod_id_str.as_str()))
                    .count()
                    > 1
            {
                None
            } else {
                existing_entry.and_then(|e| e.folder_id.clone())
            };
            // A plugin's folder is named after the descriptor this release ships.
            let filename = saved
                .mods
                .iter()
                .find(|m| m.uid == uid && !target.is_unreal_plugin_unit())
                .map(|m| m.filename.clone())
                .unwrap_or_else(|| {
                    decisions::install_filename_for_source_file(
                        cfg,
                        target,
                        &mod_name,
                        file_id,
                        &file_type,
                        &tmp,
                        name_source,
                    )
                });
            let was_disabled = match saved.mods.iter().find(|m| m.uid == uid) {
                Some(e) => !e.enabled,
                None => plugin_repair::installs_disabled(
                    cfg,
                    &saved.mods,
                    target,
                    &uid,
                    &filename,
                    file_id,
                    paks_disabled,
                ),
            };

            install_mod_from_path(
                &game_path,
                &sp,
                InstalledMod {
                    uid: uid.clone(),
                    name: mod_name,
                    version: mod_version,
                    filename,
                    enabled: true,
                    installed_at: Utc::now().to_rfc3339(),
                    file_id: Some(file_id),
                    file_type: Some(file_type),
                    sha256: Some(sha256),
                    ..InstalledMod::from_catalog(
                        "modworkshop",
                        mod_id_str.clone(),
                        IdentityEvidence::InstallProvenance,
                    )
                },
                &tmp,
                effective_folder_id,
                cfg,
                target,
            )?;
            superseded.commit();

            if was_disabled {
                let settings = read_settings(&app);
                let launcher_str =
                    game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
                disable_mod_op(&game_path, &sp, &uid, cfg, launcher_str.as_deref())?;
            }

            Ok::<(), String>(())
        })
        .await
    }
    .await;

    cleanup::run_staged(&cleanup_plan, zip_orig).await;
    if result.is_ok() {
        register_download(&app, file_id).await;
    }
    match &result {
        Ok(_) => track_mod_installed(&app, game_id.as_str(), mod_id, &file_type),
        Err(e) => log::warn!("install_file {mod_id} file={file_id}: {e}"),
    }
    result.map(|()| InstallOutcome::Installed)
}

/// What stops a game's plugin mods from loading: plugin mods installed as loose paks, each with
/// the release that reinstalls it as a plugin, and a descriptor in the plugin folder itself.
#[tauri::command]
#[specta::specta]
pub async fn check_plugin_installs(
    app: AppHandle,
    game_id: String,
) -> Result<PluginInstallReport, String> {
    let cfg = engine_for_game(&game_id)?;
    let Some(target) = cfg.targets.iter().find(|t| t.is_unreal_plugin_unit()) else {
        return Ok(PluginInstallReport::default());
    };
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, &game_id).and_then(|gs| gs.game_path.clone())
    else {
        return Ok(PluginInstallReport::default());
    };
    // A repair installs into folders that launching without mods has moved aside, so it
    // waits until they are restored.
    if cfg
        .targets
        .iter()
        .any(|t| backup_dir(&game_path, t).exists())
    {
        return Ok(PluginInstallReport::default());
    }
    let root_descriptor = unreal_plugin::root_descriptor(&mods_base(&game_path, target));
    let target = Some(target.tag.to_string());
    // Without the index there is no evidence a pak came out of a plugin.
    let Some(conn) = mod_index::open_index(&app, cfg.game_id) else {
        return Ok(PluginInstallReport {
            target,
            misplaced: Vec::new(),
            root_descriptor,
        });
    };
    let _state_guard = lock_game_state(&app, &game_id).await;
    let state = state::read_state_for_game(&game_path, &get_state_path(&game_path, cfg), cfg)
        .map_err(|e| e.to_string())?;
    let misplaced = plugin_repair::misplaced_plugins(cfg, &state.mods, &conn)
        .map_err(|e| format!("the mod index could not be read: {e}"))?;
    Ok(PluginInstallReport {
        target,
        misplaced,
        root_descriptor,
    })
}

pub(crate) struct NexusInstallMeta {
    pub mod_id: u32,
    pub file_id: u32,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub thumbnail_url: Option<String>,
    pub file_type: String,
    /// The downloadable filename supplies resource review entry names.
    pub source_name: String,
}

/// What an nxm download produced: an install, or a resource review that installs nothing
/// until the user applies it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NexusInstallOutcome {
    Installed,
    NeedsResourceReview(String),
}

// Nexus files retain their source identity even when ModWorkshop has identical bytes.
pub(crate) async fn install_nexus_download(
    app: &AppHandle,
    game_id: &str,
    game_path: &str,
    downloaded: PathBuf,
    meta: NexusInstallMeta,
) -> Result<NexusInstallOutcome, String> {
    let NexusInstallMeta {
        mod_id: nexus_mod_id,
        file_id: nexus_file_id,
        name: mod_name,
        version: mod_version,
        author: mod_author,
        thumbnail_url,
        file_type,
        source_name,
    } = meta;
    let cfg = engine_for_game(game_id)?;
    let dl_path = downloaded.clone();
    if cfg.primary().shared_paks.is_some()
        && (file_type.eq_ignore_ascii_case("pak")
            || downloaded.extension().is_some_and(|extension| {
                cfg.primary()
                    .content_extension()
                    .is_some_and(|expected| extension.eq_ignore_ascii_case(expected))
            }))
    {
        if let Err(error) = zip::require_nexus_pak_archive(&downloaded) {
            cleanup::run(&cleanup::CleanupPlan::RemoveOwnedFile(dl_path)).await;
            return Err(error);
        }
    }
    let needs_update_choice =
        if cfg.primary().shared_paks.is_some() && zip::detect_archive(&downloaded).is_some() {
            let _guard = lock_game_state(app, game_id).await;
            let saved =
                match state::read_state_for_game(game_path, &get_state_path(game_path, cfg), cfg) {
                    Ok(saved) => saved,
                    Err(error) => {
                        cleanup::run(&cleanup::CleanupPlan::RemoveOwnedFile(dl_path.clone())).await;
                        return Err(format!(
                            "Could not read the installed Nexus variants: {error}"
                        ));
                    }
                };
            saved.mods.iter().any(|record| {
                record.source == "nexus"
                    && record.remote_id.as_deref() == Some(&nexus_mod_id.to_string())
            })
        } else {
            false
        };
    let worker_app = app.clone();
    let resolved = match tauri::async_runtime::spawn_blocking(move || {
        let registry = staged_archives(&worker_app);
        if needs_update_choice {
            return zip::shared_pak_update_choice(downloaded, cfg, registry);
        }
        resolve_archive_download(downloaded, cfg, registry)
    })
    .await
    {
        Ok(resolved) => resolved,
        Err(error) => Err(ResolveError::Failure(format!(
            "Nexus archive staging failed: {error}"
        ))),
    };
    let resolved = match resolved {
        Err(ResolveError::Prompt(prompt)) => match *prompt {
            InstallPrompt::ZipMultiPak(picker) => {
                Err(ResolveError::Resources(Box::new(zip::ResourceArchive {
                    downloaded: dl_path.clone(),
                    is_archive: true,
                    members: Vec::new(),
                    pak_picker: Some(picker),
                })))
            }
            prompt => Err(ResolveError::Prompt(Box::new(prompt))),
        },
        resolved => resolved,
    };
    let staged::Staged {
        root: tmp,
        cleanup: cleanup_plan,
        name_source,
        target_tag: location_tag,
        original_archive: zip_orig,
    } = match resolved {
        Err(ResolveError::Ue4ssLoader(zip_path)) => {
            // Replacing a loader is only offered where the user can be shown what it removes
            // first, and this path has no channel to ask on. So it installs where there is
            // nothing to lose and refuses otherwise, rather than replacing silently.
            let settings = read_settings(app);
            let launcher = game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
            if crate::commands::ue4ss::is_installed(cfg.game_id, game_path, launcher.as_deref()) {
                cleanup::run(&cleanup::CleanupPlan::RemoveOwnedFile(zip_path)).await;
                return Err(format!(
                    "'{mod_name}' would replace the UE4SS already installed; install it from its mod page, where Modrex can show you what that changes first"
                ));
            }
            return install_ue4ss_loader_from(
                app,
                cfg,
                game_path,
                zip_path,
                Some(
                    LoaderPage {
                        source: "nexus".to_string(),
                        remote_id: nexus_mod_id.to_string(),
                        file_id: Some(i64::from(nexus_file_id)),
                        version: mod_version.clone(),
                    }
                    .recorded(),
                ),
            )
            .await
            .map(|()| NexusInstallOutcome::Installed);
        }
        Err(ResolveError::Prompt(prompt)) => {
            cleanup::run(&cleanup::CleanupPlan::RemoveOwnedFile(dl_path.clone())).await;
            let kind = match *prompt {
                InstallPrompt::ZipMultiPak(_) => "ZIP_MULTI_PAK",
                InstallPrompt::HostModPack(_) => "HOST_MOD_PACK",
                InstallPrompt::CbFlatArchive(_) => "CB_FLAT_ARCHIVE",
                InstallPrompt::UnrecognizedArchive => "UNRECOGNIZED_ARCHIVE",
            };
            return Err(format!(
                "nexus: '{mod_name}' needs a manual install choice ({kind}) that Nexus downloads don't support yet"
            ));
        }
        Err(ResolveError::Resources(found)) => {
            if let Some(picker) = &found.pak_picker {
                staged_archives(app)
                    .restrict_to_nexus(&picker.archive_handle)
                    .expect("The Nexus download just issued this unused archive grant");
            }
            return answer_resources(
                app,
                game_id,
                game_path,
                *found,
                &source_name,
                resources::Provenance {
                    name: mod_name.clone(),
                    version: mod_version.clone(),
                    source: Some("nexus".to_string()),
                    remote_id: Some(nexus_mod_id.to_string()),
                    file_id: Some(i64::from(nexus_file_id)),
                    author: mod_author,
                    thumbnail_url,
                },
                ModContext {
                    mod_id: i64::from(nexus_mod_id),
                    mod_name,
                    file_id: i64::from(nexus_file_id),
                    file_type,
                    mod_version,
                },
            )
            .await
            .map(|payload| NexusInstallOutcome::NeedsResourceReview(payload.review_handle))
            .inspect_err(|e| {
                log::warn!("install_nexus_download {nexus_mod_id}/{nexus_file_id}: {e}")
            });
        }
        Err(ResolveError::Failure(e)) => {
            cleanup::run(&cleanup::CleanupPlan::RemoveOwnedFile(dl_path.clone())).await;
            log::warn!("install_nexus_download {nexus_mod_id}/{nexus_file_id}: {e}");
            return Err(e);
        }
        Ok(v) => v,
    };
    let target = cfg.target_for(location_tag.as_deref());

    let result = async {
        let sha256 = staged_content_sha256(target, &tmp).await?;
        let state_guard = lock_game_state(app, cfg.game_id).await;
        let game_path = game_path.to_owned();
        commit_install(state_guard, move || {
            let mut uid = format!("nexus:{nexus_mod_id}:{nexus_file_id}");
            let sp = get_state_path(&game_path, cfg);
            let saved =
                state::read_state_for_game(&game_path, &sp, cfg).map_err(|e| e.to_string())?;
            let author_filename = decisions::install_filename_from_mod_name(
                cfg,
                target,
                &mod_name,
                &tmp,
                name_source,
            );
            let existing = if target.shared_paks.is_some() {
                decisions::shared_nexus_update(
                    &saved.mods,
                    nexus_mod_id,
                    i64::from(nexus_file_id),
                    &author_filename,
                    None,
                    location_tag.as_deref(),
                    true,
                )?
            } else {
                saved.mods.iter().find(|m| m.uid == uid)
            };
            if let Some(existing) = existing {
                uid = existing.uid.clone();
            }
            let folder_id = existing.and_then(|e| e.folder_id.clone());
            let filename = existing
                .map(|m| m.filename.clone())
                .unwrap_or(author_filename);

            install_mod_from_path(
                &game_path,
                &sp,
                InstalledMod {
                    uid,
                    name: mod_name.clone(),
                    version: mod_version,
                    filename,
                    enabled: true,
                    installed_at: Utc::now().to_rfc3339(),
                    file_remote_id: Some(nexus_file_id.to_string()),
                    author: mod_author,
                    thumbnail_url,
                    file_id: Some(nexus_file_id as i64),
                    file_type: Some(file_type),
                    sha256: Some(sha256),
                    ..InstalledMod::from_catalog(
                        "nexus",
                        nexus_mod_id.to_string(),
                        IdentityEvidence::InstallProvenance,
                    )
                },
                &tmp,
                folder_id,
                cfg,
                target,
            )
        })
        .await
    }
    .await;

    cleanup::run_staged(&cleanup_plan, zip_orig).await;
    if let Err(e) = &result {
        log::warn!("install_nexus_download {nexus_mod_id}/{nexus_file_id}: {e}");
    }
    result.map(|()| NexusInstallOutcome::Installed)
}

/// Removes the download once the loader installer has taken it.
/// Lists a game's installed loaders alongside its mods.
///
/// A loader is not a mod: it is presence-detected from the files it leaves next to the game
/// and is never recorded in state.json, so it cannot be enabled, reordered or removed here.
/// It is listed anyway because the question it answers is one only this list can answer, and
/// only for the page it was actually installed from: which loader is installed, and is it the
/// current version. A loader installed outside Modrex has no recorded page, and reads as
/// present with an unknown version rather than as absent.
fn push_installed_loaders(
    cfg: &ModEngineConfig,
    game_path: &str,
    settings: &crate::commands::settings::Settings,
    mods: &mut Vec<InstalledMod>,
) {
    let launcher = game_settings(settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
    let recorded = game_settings(settings, cfg.game_id).map(|gs| &gs.loaders);
    for (game_id, spec, _) in crate::commands::loaders::scoped_bindings() {
        if game_id != cfg.game_id || spec.id != "ue4ss" {
            continue;
        }
        let found = crate::commands::ue4ss::presence(cfg.game_id, game_path, launcher.as_deref());
        if !found.installed {
            continue;
        }
        // The files outrank the record. A record says Modrex installed a release once; the
        // bytes on disk say what is there now, and anything could have replaced them since.
        // A record is used only for what the bytes cannot show, and only when the two agree
        // on which release it is.
        let record = recorded.and_then(|r| r.get(spec.id)).filter(|r| {
            found
                .modworkshop_id
                .is_none_or(|id| r.source == "modworkshop" && r.remote_id == id.to_string())
        });
        let identity = match (found.modworkshop_id, record) {
            (Some(id), _) => Some(("modworkshop".to_string(), id.to_string())),
            (None, Some(r)) => Some((r.source.clone(), r.remote_id.clone())),
            (None, None) => None,
        };
        let entry = InstalledMod {
            uid: format!("loader:{}", spec.id),
            name: spec.id.to_uppercase(),
            version: found
                .version
                .clone()
                .or_else(|| record.map(|r| r.version.clone()))
                .unwrap_or_default(),
            filename: spec.id.to_string(),
            enabled: true,
            location: Some(format!("loader:{}", spec.id)),
            installed_at: record.map(|r| r.installed_at.clone()).unwrap_or_default(),
            file_id: record.and_then(|r| r.file_id),
            ..match identity {
                // Identified from the proxy DLL's own bytes, or from the install that put it
                // there. Either is real provenance; a loader nobody can attribute gets none
                // invented for it.
                Some((source, remote_id)) => InstalledMod::from_catalog(
                    &source,
                    remote_id,
                    IdentityEvidence::InstallProvenance,
                ),
                None => InstalledMod {
                    id: hash_filename(spec.id),
                    update_status: UpdateStatus::Unknown,
                    ..InstalledMod::default()
                },
            }
        };
        mods.push(entry);
    }
}

/// Answers a UE4SS package: installs it outright when there is nothing to lose, and otherwise
/// holds it and asks first.
///
/// A replacement removes the installed release's own files, and which files those are depends
/// on which release is installed, so the user is shown them before it happens rather than told
/// afterwards. A first install replaces nothing and has nothing to ask about.
async fn answer_ue4ss_package(
    app: &AppHandle,
    cfg: &ModEngineConfig,
    game_path: &str,
    zip_path: PathBuf,
    page: Option<LoaderPage>,
    mod_name: String,
) -> Result<InstallOutcome, String> {
    let settings = read_settings(app);
    let launcher = game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
    if !crate::commands::ue4ss::is_installed(cfg.game_id, game_path, launcher.as_deref()) {
        return install_ue4ss_loader_from(
            app,
            cfg,
            game_path,
            zip_path,
            page.map(LoaderPage::recorded),
        )
        .await
        .map(|()| InstallOutcome::Installed);
    }
    let plan =
        crate::commands::ue4ss::plan_replacement(cfg.game_id, game_path, launcher.as_deref())?;
    let archive_handle = staged_archives(app)
        .register(
            staging_tokens::StagedArchiveKind::Ue4ssLoader,
            &zip_path,
            cleanup::CleanupPlan::RemoveOwnedFile(zip_path.clone()),
            Vec::new(),
        )
        .map_err(|()| "this UE4SS download could not be held for you to confirm".to_string())?;
    Ok(InstallOutcome::NeedsLoaderConfirm(Ue4ssReplacePayload {
        archive_handle,
        mod_name,
        page,
        replaced: plan.replaced,
        preserved: plan.preserved,
    }))
}

/// Reads the published filename from a ModWorkshop storage URL.
fn hosted_resource_name(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let name = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "filename").then(|| value.into_owned()))?;
    Path::new(&name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

async fn answer_resources(
    app: &AppHandle,
    game_id: &str,
    game_path: &str,
    mut found: zip::ResourceArchive,
    source_name: &str,
    provenance: resources::Provenance,
    ctx: ModContext,
) -> Result<resources::ResourceReviewPayload, String> {
    if let Some(picker) = found.pak_picker.take() {
        let InstallPrompt::ZipMultiPak(filled) =
            InstallPrompt::ZipMultiPak(picker).with_mod_context(ctx)
        else {
            unreachable!("with_mod_context keeps the prompt kind");
        };
        found.pak_picker = Some(filled);
    }
    let picker_handle = found.pak_picker.as_ref().map(|p| p.archive_handle.clone());
    let downloaded = found.downloaded.clone();
    let review_app = app.clone();
    let review_game = game_id.to_string();
    let review_path = game_path.to_string();
    let review_source = source_name.to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        resources::open_review(
            &review_app,
            &review_game,
            &review_path,
            found,
            &review_source,
            provenance,
        )
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    match result {
        Ok(review_handle) => Ok(resources::ResourceReviewPayload { review_handle }),
        Err(e) => {
            let plan = match picker_handle {
                Some(handle) => staged_archives(app).finalize(&handle),
                None => Some(cleanup::CleanupPlan::RemoveOwnedFile(downloaded)),
            };
            if let Some(plan) = plan {
                cleanup::run_sync(&plan);
            }
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_resource_review(
    app: AppHandle,
    review_handle: String,
) -> Result<resources::ResourceReview, String> {
    tauri::async_runtime::spawn_blocking(move || resources::get_review(&app, &review_handle))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn install_reviewed_resources(
    app: AppHandle,
    review_handle: String,
    selections: Vec<resources::ResourceSelection>,
) -> Result<resources::ResourceInstallResult, String> {
    let nexus = resources::nexus_completion(&app, &review_handle);
    let result = resources::install_reviewed(&app, &review_handle, selections)
        .await
        .inspect_err(|e| log::warn!("install_reviewed_resources: {e}"));
    // A failed preset leaves the review open, but a movie pack applied before it is installed.
    let installed = result.as_ref().is_ok_and(|result| result.installed)
        || (nexus
            .as_ref()
            .is_some_and(|before| !before.movie_pack_applied)
            && resources::nexus_completion(&app, &review_handle)
                .is_some_and(|after| after.movie_pack_applied));
    if let Some(nexus) = nexus {
        if installed {
            report_nexus_installed(
                &app,
                &nexus.game_id,
                nexus.mod_id,
                nexus.file_id,
                &nexus.name,
            );
        } else if result.is_ok() {
            report_nexus_review_closed(&app, &nexus);
        }
    }
    result
}

/// Reports completion after a Nexus review installs a selected component.
fn report_nexus_installed(app: &AppHandle, game_id: &str, mod_id: u32, file_id: i64, name: &str) {
    if let Err(e) = crate::commands::nxm::emit_install_complete(app, game_id, mod_id, file_id, name)
    {
        log::warn!("nexus review {mod_id}/{file_id}: completion not sent: {e}");
    }
}

#[tauri::command]
#[specta::specta]
pub fn cancel_resource_review(app: AppHandle, review_handle: String) {
    let nexus = resources::nexus_completion(&app, &review_handle);
    resources::cancel_review(&app, &review_handle);
    if let Some(nexus) = nexus {
        report_nexus_review_closed(&app, &nexus);
    }
}

fn report_nexus_review_closed(app: &AppHandle, nexus: &resources::NexusCompletion) {
    if let Err(error) =
        crate::commands::nxm::emit_review_closed(app, &nexus.game_id, nexus.mod_id, nexus.file_id)
    {
        log::warn!("Nexus review close notification failed: {error}");
    }
}

#[tauri::command]
#[specta::specta]
pub async fn review_resource_recovery(
    app: AppHandle,
    game_id: String,
    uid: Option<String>,
) -> Result<resources::ResourceRecoveryReview, String> {
    engine_for_game(&game_id)?;
    resources::review_recovery(&app, &game_id, uid).await
}

#[tauri::command]
#[specta::specta]
pub async fn keep_current_resources(app: AppHandle, review_handle: String) -> Result<(), String> {
    resources::keep_current(&app, &review_handle).await
}

#[tauri::command]
#[specta::specta]
pub fn cancel_resource_recovery(app: AppHandle, review_handle: String) {
    resources::cancel_recovery(&app, &review_handle);
}

#[tauri::command]
#[specta::specta]
pub async fn open_resource_recovery_folder(app: AppHandle) -> Result<bool, String> {
    resources::open_recovery_folder(&app).await
}

/// Removes every open review's staged payloads, for application exit.
pub(crate) fn discard_all_resource_reviews(app: &AppHandle) {
    resources::discard_all_reviews(app);
}

#[tauri::command]
#[specta::specta]
pub async fn get_engine_ini_location(
    app: AppHandle,
    game_id: String,
) -> Result<resources::ConfigFileLocation, String> {
    resources::get_engine_ini_location(&app, &game_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn open_engine_ini(app: AppHandle, game_id: String) -> Result<(), String> {
    resources::open_engine_ini(&app, &game_id).await
}

/// title comes from the renderer already localized, like pick_folder's.
#[tauri::command]
#[specta::specta]
pub async fn pick_engine_ini(
    app: AppHandle,
    game_id: String,
    title: String,
    folder: bool,
) -> Result<Option<String>, String> {
    resources::pick_engine_ini(&app, &game_id, title, folder).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_graphics_config_location(
    app: AppHandle,
    game_id: String,
) -> Result<resources::ConfigFileLocation, String> {
    graphics_config::get_location(&app, &game_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn pick_graphics_config(
    app: AppHandle,
    game_id: String,
    title: String,
) -> Result<Option<String>, String> {
    graphics_config::pick(&app, &game_id, title).await
}

#[tauri::command]
#[specta::specta]
pub async fn open_graphics_config(app: AppHandle, game_id: String) -> Result<(), String> {
    graphics_config::open(&app, &game_id).await
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmLoaderArgs {
    pub archive_handle: String,
    pub game_id: String,
    pub game_path: String,
    pub page: Option<LoaderPage>,
}

/// Carries out a replacement the user confirmed after being shown what it removes and keeps.
#[tauri::command]
#[specta::specta]
pub async fn install_confirmed_loader(
    app: AppHandle,
    args: ConfirmLoaderArgs,
) -> Result<(), String> {
    let cfg = engine_for_game(args.game_id.as_str())?;
    let state_guard = lock_game_state(&app, cfg.game_id).await;
    let worker_app = app.clone();
    let archive_handle = args.archive_handle.clone();
    let result = commit_install(state_guard, move || {
        let registry = staged_archives(&worker_app);
        let zip = registry
            .borrow(
                &args.archive_handle,
                staging_tokens::StagedArchiveKind::Ue4ssLoader,
            )
            .ok_or("this UE4SS download is no longer available to install from")?;
        let _borrow = staging_tokens::BorrowGuard::new(registry, &args.archive_handle);
        replace_ue4ss_loader_op(
            &worker_app,
            cfg.game_id,
            &args.game_path,
            &zip,
            args.page.map(LoaderPage::recorded),
        )
    })
    .await;
    finish_with_archive(staged_archives(&app), &archive_handle).await;
    result
}

/// Installs the UE4SS package, then removes the download it came from.
async fn install_ue4ss_loader_from(
    app: &AppHandle,
    cfg: &ModEngineConfig,
    game_path: &str,
    zip_path: PathBuf,
    provenance: Option<settings::LoaderInstall>,
) -> Result<(), String> {
    let result = replace_ue4ss_loader(app, cfg, game_path, &zip_path, provenance).await;
    cleanup::run(&cleanup::CleanupPlan::RemoveOwnedFile(zip_path)).await;
    result
}

/// Installs the UE4SS package and records which page it came from.
///
/// The installed files carry no identity: several pages distribute this loader, and one
/// detected proxy DLL says nothing about which of them wrote it or what version it is.
/// Provenance is absent only for a drop, which has no page behind it.
async fn replace_ue4ss_loader(
    app: &AppHandle,
    cfg: &ModEngineConfig,
    game_path: &str,
    zip_path: &std::path::Path,
    provenance: Option<settings::LoaderInstall>,
) -> Result<(), String> {
    let state_guard = lock_game_state(app, cfg.game_id).await;
    let app = app.clone();
    let game_id = cfg.game_id;
    let game_path = game_path.to_owned();
    let zip_path = zip_path.to_owned();
    commit_install(state_guard, move || {
        replace_ue4ss_loader_op(&app, game_id, &game_path, &zip_path, provenance)
    })
    .await
}

fn replace_ue4ss_loader_op(
    app: &AppHandle,
    game_id: &str,
    game_path: &str,
    zip_path: &Path,
    provenance: Option<settings::LoaderInstall>,
) -> Result<(), String> {
    let settings = read_settings(app);
    let launcher = game_settings(&settings, game_id).and_then(|gs| gs.launcher.clone());
    let result =
        crate::commands::ue4ss::install_loader(game_id, game_path, launcher.as_deref(), zip_path);
    // Recorded whenever the files actually changed, and always: a replacement whose source is
    // unknown must clear the page the previous one claimed rather than leave it describing
    // files it did not put there. A failure that changed nothing leaves the record alone,
    // because the install it describes is still the one on disk.
    match result {
        Ok(()) => {
            settings::record_loader_install(app, game_id, "ue4ss", provenance);
            Ok(())
        }
        Err(crate::commands::ue4ss::LoaderError::Installed(message)) => {
            settings::record_loader_install(app, game_id, "ue4ss", provenance);
            Err(message)
        }
        Err(unchanged) => Err(unchanged.message()),
    }
}

/// Reports a completed download to modworkshop. Best effort: a failure here never affects
/// the install that already succeeded.
async fn register_download(app: &AppHandle, file_id: i64) {
    let result = http_client()
        .post(format!(
            "https://api.modworkshop.net/files/{}/register-download",
            file_id
        ))
        .header("User-Agent", user_agent(app))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => log::warn!(
            "register_download {file_id}: server returned {}",
            response.status()
        ),
        Err(error) => log::warn!("register_download {file_id}: {error}"),
    }
}

/// Recovers a dropped mod's real name, for both display and the on-disk filename. The
/// dropped archive's own OS filename is often a download manager's naming scheme (Nexus's
/// website downloads are "{Name} {id} {version} {timestamp} {hash}.zip"), not the mod's
/// real name. fallback, the dropped file's own stem, is only correct when nothing better is
/// available, which is exactly the case for a bare loose .pak dropped with no zip wrapper.
///
/// Whether the staged root carries the mod's own name is the producer's to say, so this
/// reads name_source instead of re-deriving it from the destination unit and the game.
fn recover_dropped_mod_stem(
    name_source: staged::NameSource,
    tmp: &std::path::Path,
    zip_orig: Option<&std::path::Path>,
    fallback: &str,
    content_extension: Option<&str>,
) -> String {
    if name_source == staged::NameSource::FromArchive {
        return tmp
            .file_name()
            .and_then(|s| s.to_str())
            .map(String::from)
            .unwrap_or_else(|| fallback.to_string());
    }
    zip_orig
        .zip(content_extension)
        .and_then(|(orig, extension)| list_unit_entries(orig, extension).ok())
        .and_then(|entries| match entries.as_slice() {
            [entry] => std::path::Path::new(entry)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(String::from),
            _ => None,
        })
        .unwrap_or_else(|| fallback.to_string())
}

/// The folder a dropped install lands in. A drop carries no folder of its own, so an
/// archive that replaces an entry already filed in one has to stay there; without this it
/// would be rewritten to the mods root and the copy inside the folder deleted, while the
/// same mod reinstalled from its page keeps its folder (see install_mod's effective_folder_id).
fn dropped_install_folder_id(
    folder_id: Option<String>,
    mods: &[InstalledMod],
    uid: &str,
) -> Option<String> {
    folder_id.or_else(|| {
        mods.iter()
            .find(|m| m.uid == uid)
            .and_then(|m| m.folder_id.clone())
    })
}

/// Overwrites the generic unidentified fields on a freshly built InstalledMod with a
/// confirmed Nexus identity. uid switches to Tier 1's own "nexus:{mod_id}:{file_id}"
/// scheme so a later nxm:// install of the same file reconciles onto this entry
/// instead of creating a duplicate.
fn apply_nexus_archive_identity(
    entry: &mut InstalledMod,
    m: &crate::commands::nexus::NexusHashMatch,
    detail: &crate::commands::domain::ModDetail,
    file_version: &str,
) {
    entry.uid = format!("nexus:{}:{}", m.mod_id, m.file_id);
    entry.attach_catalog("nexus", m.mod_id.to_string(), IdentityEvidence::CatalogHash);
    entry.name = detail.name.clone();
    entry.version = file_version.to_string();
    entry.update_status = UpdateStatus::Known;
    entry.file_remote_id = Some(m.file_id.to_string());
    entry.author = Some(detail.user.name.clone());
    entry.thumbnail_url = detail.thumbnail.as_ref().map(|t| t.file.clone());
    entry.file_id = Some(m.file_id as i64);
}

/// The dropped file's name without the directory it came from, which is normally inside the
/// user's profile and reaches logs that are attached to public bug reports.
fn dropped_file_name(path: &str) -> &str {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
}

/// Installs a mod from a local file the user dropped onto the window (Explorer drag-drop).
/// The file carries no modworkshop identity, so it is installed as an unidentified entry
/// (negative id, "unknown" version) exactly like an ambiently-discovered pak; get_installed's
/// SHA256 upgrade resolves its real identity on the next refresh. The dropped file is copied into
/// temp first so resolution/cleanup never touches the user's original.
#[tauri::command]
#[specta::specta]
pub async fn install_dropped_file(
    app: AppHandle,
    path: String,
    game_path: String,
    folder_id: Option<String>,
    game_id: String,
) -> Result<InstallOutcome, String> {
    let cfg = engine_for_game(game_id.as_str())?;
    let src = PathBuf::from(&path);
    let file_stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "invalid file name".to_string())?;

    let temp = std::env::temp_dir().join(match src.extension().and_then(|s| s.to_str()) {
        Some(ext) => format!("modrex-drop-{}.{}", Uuid::new_v4(), ext),
        None => format!("modrex-drop-{}", Uuid::new_v4()),
    });
    tokio::fs::copy(&src, &temp)
        .await
        .map_err(|e| format!("could not read dropped file: {e}"))?;

    let staged::Staged {
        root: tmp,
        cleanup: cleanup_plan,
        name_source,
        target_tag: location_tag,
        original_archive: zip_orig,
    } = match stage_download(&app, temp.clone(), cfg).await {
        Err(ResolveError::Ue4ssLoader(zip_path)) => {
            return answer_ue4ss_package(&app, cfg, &game_path, zip_path, None, file_stem.clone())
                .await;
        }
        Err(ResolveError::Prompt(prompt)) => {
            let syn = hash_filename(&file_stem);
            return Ok((*prompt)
                .with_mod_context(ModContext {
                    mod_id: if cfg.primary().shared_paks.is_some() {
                        0
                    } else {
                        syn
                    },
                    mod_name: file_stem.clone(),
                    file_id: syn,
                    file_type: src
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("zip")
                        .to_string(),
                    mod_version: String::new(),
                })
                .into());
        }
        // Reviewed from the temp copy. The user's dropped original is never touched.
        Err(ResolveError::Resources(found)) => {
            let syn = hash_filename(&file_stem);
            return answer_resources(
                &app,
                &game_id,
                &game_path,
                *found,
                dropped_file_name(&path),
                resources::Provenance {
                    name: file_stem.clone(),
                    version: String::new(),
                    source: None,
                    remote_id: None,
                    file_id: None,
                    author: None,
                    thumbnail_url: None,
                },
                ModContext {
                    mod_id: syn,
                    mod_name: file_stem.clone(),
                    file_id: syn,
                    file_type: src
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("zip")
                        .to_string(),
                    mod_version: String::new(),
                },
            )
            .await
            .map(InstallOutcome::NeedsResourceReview)
            .inspect_err(|e| log::warn!("install_dropped_file {}: {e}", dropped_file_name(&path)));
        }
        Err(ResolveError::Failure(e)) => {
            cleanup::run(&cleanup::CleanupPlan::RemoveOwnedFile(temp.clone())).await;
            log::warn!("install_dropped_file {}: {e}", dropped_file_name(&path));
            return Err(e);
        }

        Ok(v) => v,
    };
    let target = cfg.target_for(location_tag.as_deref());
    let display_stem = recover_dropped_mod_stem(
        name_source,
        &tmp,
        zip_orig.as_deref(),
        &file_stem,
        target.content_extension(),
    );

    // Best-effort Nexus identification: only possible when the whole downloaded
    // archive is still available (zip_orig - a bare loose .pak drop has nothing
    // Nexus's archive-MD5 index could ever match) and the game has a Nexus presence.
    // A miss, an ambiguous result, or a lookup failure all fall through to the
    // ordinary unidentified install below - this only ever adds an identity on top
    // of it, never blocks or fails the install itself.
    let nexus_match = match &zip_orig {
        Some(archive) if sources::native_id("nexus", &game_id).is_some() => {
            match crate::commands::nexus::identify_archive_by_md5(
                app.clone(),
                game_id.clone(),
                archive,
            )
            .await
            {
                Ok(crate::commands::nexus::NexusArchiveIdentity::Identified(m)) => Some(m),
                Ok(_) => None,
                Err(e) => {
                    log::warn!("install_dropped_file: nexus identification failed: {e}");
                    None
                }
            }
        }
        _ => None,
    };
    // Identification needs the matched file's upload version, not the current mod version.
    let nexus_detail = match &nexus_match {
        Some(m) => {
            let metadata = async {
                let value =
                    crate::commands::nexus::nexus_get_mod(app.clone(), game_id.clone(), m.mod_id)
                        .await?;
                let detail = crate::commands::domain::parse_nexus_detail(value)?;
                let file =
                    crate::commands::nexus::nexus_get_file(&app, &game_id, m.mod_id, m.file_id)
                        .await?;
                let version =
                    crate::commands::domain::nexus_installed_file_version(&file, &detail.version);
                Ok::<_, String>((detail, version))
            }
            .await;
            match metadata {
                Ok(metadata) => Some(metadata),
                Err(e) => {
                    log::warn!("install_dropped_file: nexus metadata failed: {e}");
                    None
                }
            }
        }
        None => None,
    };

    let result = async {
        let sha256 = staged_content_sha256(target, &tmp).await?;
        let state_guard = lock_game_state(&app, cfg.game_id).await;
        let path = path.clone();
        let loose_file = zip_orig.is_none();
        commit_install(state_guard, move || {
            // Discovery-matching identity: filename drives the uid/id the untracked-scan would assign,
            // so a later manual refresh reconciles this entry instead of duplicating it.
            let filename = if target.keeps_archive_filename() && loose_file {
                decisions::loose_published_filename(target, dropped_file_name(&path))?
            } else {
                decisions::install_filename_for_dropped(cfg, target, &display_stem)
            };
            let sp = get_state_path(&game_path, cfg);

            let mut mod_entry = InstalledMod {
                uid: decisions::dropped_uid(target, &filename),
                id: hash_filename(&filename),
                name: display_stem.clone(),
                version: String::new(),
                update_status: UpdateStatus::Unknown,
                filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
                sha256: Some(sha256),
                ..InstalledMod::default()
            };
            if let (Some(m), Some((detail, version))) = (&nexus_match, &nexus_detail) {
                apply_nexus_archive_identity(&mut mod_entry, m, detail, version);
            }

            let saved =
                state::read_state_for_game(&game_path, &sp, cfg).map_err(|e| e.to_string())?;
            let effective_folder_id =
                dropped_install_folder_id(folder_id, &saved.mods, &mod_entry.uid);

            install_mod_from_path(
                &game_path,
                &sp,
                mod_entry,
                &tmp,
                effective_folder_id,
                cfg,
                target,
            )?;
            Ok::<(), String>(())
        })
        .await
    }
    .await;

    cleanup::run_staged(&cleanup_plan, zip_orig).await;
    cleanup::run(&cleanup::CleanupPlan::RemoveOwnedFile(temp)).await;

    match &result {
        Ok(_) => track_mod_installed(&app, game_id.as_str(), -1, "local"),
        Err(e) => log::warn!("install_dropped_file {}: {e}", dropped_file_name(&path)),
    }
    result.map(|()| InstallOutcome::Installed)
}

/// Records an archive entry install replaces. Siblings from the same file are kept, or a
/// multi-entry batch install would delete each entry it had just installed.
fn stale_entries_for_zip_install<'a>(
    mods: &'a [InstalledMod],
    uid: &str,
    mod_id: i64,
    file_id: i64,
    filename: &str,
    location: Option<&str>,
    folder_id: Option<&str>,
) -> Vec<&'a InstalledMod> {
    if mod_id <= 0 {
        return Vec::new();
    }
    let mod_id_str = mod_id.to_string();
    let sibling = format!("{file_id}_");
    let stem = uid.strip_prefix(&sibling);
    let same: Vec<_> = mods
        .iter()
        .filter(|m| m.remote_id.as_deref() == Some(mod_id_str.as_str()))
        .collect();
    let stale: Vec<_> = same
        .iter()
        .copied()
        .filter(|m| m.uid != uid && !m.uid.starts_with(&sibling))
        .filter(|m| {
            let same_entry = stem.is_some_and(|stem| {
                m.uid
                    .split_once('_')
                    .is_some_and(|(old, s)| s == stem && old.parse::<i64>().is_ok())
            });
            let same_path = (m.filename == filename
                || strip_priority_prefix(&m.filename) == filename)
                && m.location.as_deref() == location
                && m.folder_id.as_deref() == folder_id;
            same_entry || same_path
        })
        .collect();
    if !stale.is_empty() || mods.iter().any(|m| m.uid == uid) {
        return stale;
    }
    if same.len() != 1 || same[0].uid.starts_with(&sibling) {
        return Vec::new();
    }
    same
}

/// A Crime Boss mod's entries share one folder, so a shared path only loses its record.
fn remove_stale_zip_entry(
    game_path: &str,
    state_path: &Path,
    cfg: &ModEngineConfig,
    mods: &[InstalledMod],
    stale: &InstalledMod,
) -> Result<(), String> {
    let shared = mods.iter().any(|m| {
        m.uid != stale.uid
            && m.filename == stale.filename
            && m.location == stale.location
            && m.folder_id == stale.folder_id
    });
    if shared {
        return forget_mod_op(state_path, &stale.uid);
    }
    uninstall_mod_op(game_path, state_path, &stale.uid, cfg)
}

// The arg list outgrew specta's function arity; the renderer passes these under one args key.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallFromZipEntryArgs {
    /// Backend-issued handle for the staged archive. The renderer never receives the
    /// path, so it cannot point this at another local archive.
    pub archive_handle: String,
    /// Which entry of that archive to install, as issued when it was listed.
    pub entry_id: staging_tokens::ArchiveEntryId,
    pub mod_id: i64,
    pub mod_name: String,
    pub file_id: i64,
    pub file_type: String,
    pub mod_version: String,
    pub game_path: String,
    pub folder_id: Option<String>,
    pub game_id: String,
    pub location_tag: Option<String>,
    pub entry_kind: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn install_from_zip_entry(
    app: AppHandle,
    args: InstallFromZipEntryArgs,
) -> Result<(), String> {
    let InstallFromZipEntryArgs {
        archive_handle,
        entry_id,
        mod_id,
        mod_name,
        file_id,
        file_type,
        mod_version,
        game_path,
        folder_id,
        game_id,
        location_tag,
        entry_kind,
    } = args;
    let cfg = engine_for_game(game_id.as_str())?;
    let target = cfg.target_for(location_tag.as_deref());
    let cb_dir_entry = decisions::is_cb_dir_entry(cfg, entry_kind.as_deref());
    let (entry, ext, entry_cleanup) = stage_archive_choice(
        &app,
        archive_handle,
        staging_tokens::StagedArchiveKind::MultiEntry,
        entry_id,
        cfg,
        target,
        cb_dir_entry,
    )
    .await
    .inspect_err(|e| log::warn!("install_from_zip_entry {mod_id} file={file_id}: {e}"))?;
    let entry_name = entry.display_name;
    let (entry_stem, entry_filename) = entry_names(&entry_name);
    let install_format = file_type.clone();

    let install_filename =
        decisions::install_filename_for_zip_entry(cfg, &mod_name, &entry_filename);
    let identity = decisions::archive_entry_identity(
        target,
        mod_id,
        file_id,
        &entry_name,
        &entry_stem,
        &install_filename,
    );
    let local = decisions::is_local_archive(mod_id);
    // Shared packages are variants of one mod, so they keep the archive's name.
    let mod_name = if local && target.shared_paks.is_none() {
        decisions::local_entry_name(cfg, target, cb_dir_entry, &entry_stem, &entry_filename)
    } else {
        mod_name
    };

    let result = async {
        let sha256 = staged_content_sha256(target, &ext).await?;
        let state_guard = lock_game_state(&app, cfg.game_id).await;
        let app = app.clone();
        commit_install(state_guard, move || {
            let sp = get_state_path(&game_path, cfg);
            let remote = (mod_id > 0).then(|| mod_id.to_string());
            let superseded = plugin_repair::set_aside_superseded_paks(
                &game_path,
                &sp,
                cfg,
                target,
                remote.as_deref(),
            )?;
            let paks_disabled = superseded.all_disabled;
            let saved =
                state::read_state_for_game(&game_path, &sp, cfg).map_err(|e| e.to_string())?;

            // A dropped archive's entry is matched by its own uid only. A shared Pak hash can be
            // identical across distinct author choices, and a marker file's hash says nothing
            // about which folder a record owns.
            let sha256_match = (!local)
                .then(|| {
                    saved
                        .mods
                        .iter()
                        .find(|m| m.sha256.as_deref() == Some(sha256.as_str()))
                })
                .flatten();
            let uid = sha256_match
                .map(|m| m.uid.clone())
                .unwrap_or_else(|| identity.uid.clone());
            let was_disabled = plugin_repair::installs_disabled(
                cfg,
                &saved.mods,
                target,
                &uid,
                &install_filename,
                file_id,
                paks_disabled,
            );

            let primary = std::ptr::eq(target, cfg.primary());
            let stale = stale_entries_for_zip_install(
                &saved.mods,
                &uid,
                mod_id,
                file_id,
                &install_filename,
                (!primary).then_some(target.tag),
                folder_id.as_deref().filter(|_| primary),
            );
            for stale in stale {
                remove_stale_zip_entry(&game_path, &sp, cfg, &saved.mods, stale)?;
            }

            // Never inherit folderId from existing entries; callers always supply the target folder.
            let effective_folder_id = folder_id;

            install_mod_from_path(
                &game_path,
                &sp,
                InstalledMod {
                    uid: uid.clone(),
                    name: mod_name,
                    version: mod_version,
                    filename: install_filename,
                    enabled: true,
                    installed_at: Utc::now().to_rfc3339(),
                    file_type: Some(file_type),
                    sha256: Some(sha256),
                    ..identity
                },
                &ext,
                effective_folder_id,
                cfg,
                target,
            )?;
            superseded.commit();

            if was_disabled {
                let settings = read_settings(&app);
                let launcher =
                    game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
                disable_mod_op(&game_path, &sp, &uid, cfg, launcher.as_deref())?;
            }

            Ok::<(), String>(())
        })
        .await
    }
    .await;

    if result.is_ok() && !local {
        register_download(&app, file_id).await;
    }
    // Keep the zip alive for multi-entry installs; only remove the extracted temp here.
    cleanup::run(&entry_cleanup).await;
    match &result {
        Ok(_) if local => track_mod_installed(&app, game_id.as_str(), -1, "local"),
        Ok(_) => track_mod_installed(&app, game_id.as_str(), mod_id, &install_format),
        Err(e) => log::warn!("install_from_zip_entry {mod_id} file={file_id}: {e}"),
    }
    result
}

/// An archive entry's stem and file name, the last component of its display name.
fn entry_names(entry_name: &str) -> (String, String) {
    let path = Path::new(entry_name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(entry_name);
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(entry_name);
    (stem.to_string(), filename.to_string())
}

/// Extracts one staged archive entry to where install_mod_from_path reads it, returning that
/// path and the plan that removes the extracted copy. The archive itself is left in place.
fn stage_archive_entry(
    cfg: &ModEngineConfig,
    target: &ScanTarget,
    zip: &Path,
    entry: &staging_tokens::StagedEntry,
    cb_dir_entry: bool,
    entry_filename: &str,
) -> Result<(PathBuf, cleanup::CleanupPlan), String> {
    // The second element is the directory cleanup removes, None when the staged path is a
    // bare temp file.
    let (staged, tmp_parent) = match decisions::entry_staging(cfg, target, cb_dir_entry) {
        decisions::EntryStaging::CrimeBossSkeleton => {
            let skeleton_root =
                extract_entry_into_crimeboss_skeleton_at(zip, entry, cfg.primary().companions)?;
            (skeleton_root.clone(), Some(skeleton_root))
        }
        decisions::EntryStaging::DirectoryUnderNewParent => {
            let parent = std::env::temp_dir().join(format!("modrex-mod-{}", Uuid::new_v4()));
            (parent.join(entry_filename), Some(parent))
        }
        decisions::EntryStaging::SingleTempFile => {
            let p = std::env::temp_dir().join(format!(
                "modrex-mod-{}.{}",
                Uuid::new_v4(),
                target.content_extension().unwrap_or("bin")
            ));
            (p, None)
        }
    };
    let entry_cleanup = match tmp_parent {
        Some(parent) => cleanup::CleanupPlan::RemoveOwnedDirectory(parent),
        None => cleanup::CleanupPlan::RemoveOwnedFileWithSidecars {
            path: staged.clone(),
            companions: target.companions,
        },
    };
    let extracted = match decisions::entry_extraction(cfg, target, cb_dir_entry) {
        decisions::EntryExtraction::DirEntry => extract_staged_dir(zip, entry, &staged),
        decisions::EntryExtraction::EntryWithSidecars => {
            extract_staged_entry_with_sidecars(zip, entry, &staged, target.companions)
        }
        decisions::EntryExtraction::AlreadyStaged => Ok(()),
    };
    if let Err(e) = extracted {
        cleanup::run_sync(&entry_cleanup);
        return Err(e);
    }
    Ok((staged, entry_cleanup))
}

// The arg list outgrew specta's function arity; the renderer passes these under one args key.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallNexusReviewPakArgs {
    pub review_handle: String,
    /// Which entry of the review's package picker to install, as issued when it was listed.
    pub entry_id: staging_tokens::ArchiveEntryId,
    pub folder_id: Option<String>,
}

/// Installs one package a Nexus resource review offers. The game, install, archive, target
/// and Nexus identity all come from the review, never from the renderer, and the review stays
/// open afterwards so its movies and presets can still be chosen or the review cancelled.
#[tauri::command]
#[specta::specta]
pub async fn install_nexus_review_pak(
    app: AppHandle,
    args: InstallNexusReviewPakArgs,
) -> Result<(), String> {
    let (held, choice) = resources::hold_nexus_pak_review(&app, &args.review_handle)?;
    let result = install_nexus_review_entry(&app, &choice, args.entry_id, args.folder_id).await;
    resources::release_review(&app, held);
    match &result {
        Ok(()) => report_nexus_installed(
            &app,
            &choice.game_id,
            choice.mod_id,
            choice.file_id,
            &choice.name,
        ),
        Err(e) => log::warn!(
            "install_nexus_review_pak {}/{}: {e}",
            choice.mod_id,
            choice.file_id
        ),
    }
    result
}

async fn install_nexus_review_entry(
    app: &AppHandle,
    choice: &resources::NexusPakChoice,
    entry_id: staging_tokens::ArchiveEntryId,
    folder_id: Option<String>,
) -> Result<(), String> {
    let cfg = engine_for_game(&choice.game_id)?;
    let picker = &choice.picker;
    let location_tag = match &picker.entry_tags {
        Some(tags) => tags.get(entry_id.0 as usize).cloned().flatten(),
        None => picker.target_tag.clone(),
    };
    let target = cfg.target_for(location_tag.as_deref());
    let cb_dir_entry = decisions::is_cb_dir_entry(cfg, picker.entry_kind.as_deref());
    let (entry, staged, entry_cleanup) = stage_archive_choice(
        app,
        picker.archive_handle.clone(),
        staging_tokens::StagedArchiveKind::NexusResourcePak,
        entry_id,
        cfg,
        target,
        cb_dir_entry,
    )
    .await?;
    let (entry_stem, entry_filename) = entry_names(&entry.display_name);

    let result = async {
        let sha256 = staged_content_sha256(target, &staged).await?;
        let state_guard = lock_game_state(app, cfg.game_id).await;
        let app = app.clone();
        let choice = choice.clone();
        commit_install(state_guard, move || {
            let picker = &choice.picker;
            resources::validate_nexus_pak_choice(&app, &choice)?;
            let sp = get_state_path(&choice.game_path, cfg);
            let mut uid = if target.shared_paks.is_some() {
                format!(
                    "nexus:{}:{}:entry:{}",
                    choice.mod_id, choice.file_id, entry.display_name
                )
            } else {
                nexus_entry_uid(choice.mod_id, choice.file_id, &entry_stem)
            };
            let mut filename =
                decisions::install_filename_for_zip_entry(cfg, &choice.name, &entry_filename);
            let mut destination_folder = folder_id;
            if target.shared_paks.is_some() {
                let saved = state::read_state_for_game(&choice.game_path, &sp, cfg)
                    .map_err(|error| error.to_string())?;
                let filename_is_unique = picker
                    .entries
                    .iter()
                    .filter(|name| entry_names(name).1 == entry_filename)
                    .count()
                    == 1;
                if let Some(existing) = decisions::shared_nexus_update(
                    &saved.mods,
                    choice.mod_id,
                    choice.file_id,
                    &entry_filename,
                    Some(&entry.display_name),
                    location_tag.as_deref(),
                    filename_is_unique,
                )? {
                    uid = existing.uid.clone();
                    filename = existing.filename.clone();
                    destination_folder = existing.folder_id.clone();
                }
            }
            install_mod_from_path(
                &choice.game_path,
                &sp,
                InstalledMod {
                    uid,
                    name: choice.name.clone(),
                    version: choice.version.clone(),
                    filename,
                    enabled: true,
                    installed_at: Utc::now().to_rfc3339(),
                    file_remote_id: Some(choice.file_id.to_string()),
                    author: choice.author.clone(),
                    thumbnail_url: choice.thumbnail_url.clone(),
                    file_id: Some(choice.file_id),
                    file_type: Some(choice.file_type.clone()),
                    sha256: Some(sha256),
                    ..InstalledMod::from_catalog(
                        "nexus",
                        choice.mod_id.to_string(),
                        IdentityEvidence::InstallProvenance,
                    )
                },
                &staged,
                destination_folder,
                cfg,
                target,
            )
        })
        .await
    }
    .await;
    cleanup::run(&entry_cleanup).await;
    result
}

/// The uid of one package installed from a Nexus file. It extends the single-file
/// nexus:{mod}:{file} scheme with the entry, so reinstalling the same entry replaces it in
/// place and never matches a ModWorkshop {file_id}_{stem} record.
fn nexus_entry_uid(mod_id: u32, file_id: i64, entry_stem: &str) -> String {
    format!("nexus:{mod_id}:{file_id}:{entry_stem}")
}

/// Installs a Crime Boss archive whose content has no enclosing folder (every entry sits at the
/// zip root); the renderer reaches this after a user confirms a CB_FLAT_ARCHIVE dialog. There's
/// only one possible destination (the primary mods target, which blanket-accepts any directory),
/// so unlike install_from_zip_entry there's no entry to pick: the whole archive is extracted flat
/// and installed as a single mods/<name> folder named from the mod's display name.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn install_cb_flat_archive(
    app: AppHandle,
    archive_handle: String,
    mod_id: i64,
    mod_name: String,
    file_id: i64,
    file_type: String,
    mod_version: String,
    game_path: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let cfg = engine_for_game("cb")?;
    let target = cfg.primary();
    let tmp_dir = std::env::temp_dir().join(format!("modrex-mod-{}", Uuid::new_v4()));

    let result = async {
        let worker_app = app.clone();
        let worker_handle = archive_handle.clone();
        let extraction_dir = tmp_dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let registry = staged_archives(&worker_app);
            let zip = registry
                .borrow(
                    &worker_handle,
                    staging_tokens::StagedArchiveKind::CrimeBossFlat,
                )
                .ok_or("this archive is no longer available to install from")?;
            let _borrow = staging_tokens::BorrowGuard::new(registry, &worker_handle);
            extract_archive_flat(&zip, &extraction_dir)
        })
        .await
        .map_err(|error| format!("Crime Boss archive staging failed: {error}"))??;
        let hash_path = hashable_file_for_mod_dir(&tmp_dir, cfg.primary().contained_extension)
            .ok_or_else(|| "mod directory is empty".to_string())?;
        let sha256 = compute_sha256(&hash_path).await?;
        let state_guard = lock_game_state(&app, cfg.game_id).await;
        let tmp_dir = tmp_dir.clone();
        let file_type = file_type.clone();
        commit_install(state_guard, move || {
            let sp = get_state_path(&game_path, cfg);
            let saved =
                state::read_state_for_game(&game_path, &sp, cfg).map_err(|e| e.to_string())?;
            let uid = format!("{}_flat", file_id);
            // A dropped archive is matched by its own uid only, as in install_from_zip_entry.
            let sha256_match = (!decisions::is_local_archive(mod_id))
                .then(|| {
                    saved
                        .mods
                        .iter()
                        .find(|m| m.sha256.as_deref() == Some(sha256.as_str()))
                })
                .flatten();
            let uid = sha256_match.map(|m| m.uid.clone()).unwrap_or(uid);
            let filename = naming::mod_folder_name(&mod_name);
            let provenance = decisions::archive_provenance(mod_id, file_id, &filename);

            install_mod_from_path(
                &game_path,
                &sp,
                InstalledMod {
                    uid,
                    name: mod_name,
                    version: mod_version,
                    filename,
                    enabled: true,
                    installed_at: Utc::now().to_rfc3339(),
                    file_type: Some(file_type),
                    sha256: Some(sha256),
                    ..provenance
                },
                &tmp_dir,
                folder_id,
                cfg,
                target,
            )?;

            Ok::<(), String>(())
        })
        .await
    }
    .await;

    cleanup::run(&cleanup::CleanupPlan::RemoveOwnedDirectory(tmp_dir.clone())).await;
    finish_with_archive(staged_archives(&app), &archive_handle).await;
    let local = decisions::is_local_archive(mod_id);
    if result.is_ok() && !local {
        register_download(&app, file_id).await;
    }

    match &result {
        Ok(_) if local => track_mod_installed(&app, "cb", -1, "local"),
        Ok(_) => track_mod_installed(&app, "cb", mod_id, &file_type),
        Err(e) => log::warn!("install_cb_flat_archive {mod_id} file={file_id}: {e}"),
    }
    result
}

/// Installs a content set from an already-downloaded archive into a host mod's folder (e.g. a
/// Menu Backgrounds set into mods/Menu Backgrounds/Assets/). The renderer reaches this after a
/// HOST_MOD_PACK sentinel; the zip is left in place for multi-set installs (caller deletes it).
// The arg list outgrew specta's function arity; the renderer passes these under one args key.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallHostPackArgs {
    /// Backend-issued handle for the staged archive. The renderer never receives the
    /// path, so it cannot point this at another local archive.
    pub archive_handle: String,
    pub entry_name: String,
    pub mod_id: i64,
    pub mod_name: String,
    pub file_id: i64,
    pub file_type: String,
    pub mod_version: String,
    pub game_path: String,
    pub host_mod_id: i64,
    pub host_subpath: String,
    pub game_id: String,
}

#[tauri::command]
#[specta::specta]
pub async fn install_host_pack(app: AppHandle, args: InstallHostPackArgs) -> Result<(), String> {
    let InstallHostPackArgs {
        archive_handle,
        entry_name,
        mod_id,
        mod_name,
        file_id,
        file_type,
        mod_version,
        game_path,
        host_mod_id,
        host_subpath,
        game_id,
    } = args;
    let cfg = engine_for_game(game_id.as_str())?;
    let install_format = file_type.clone();
    let state_guard = lock_game_state(&app, cfg.game_id).await;
    let worker_app = app.clone();
    commit_install(state_guard, move || {
        let app = worker_app;
        let registry = staged_archives(&app);
        let zip = registry
            .borrow(&archive_handle, staging_tokens::StagedArchiveKind::HostPack)
            .ok_or("this archive is no longer available to install from")?;
        let _borrow = staging_tokens::BorrowGuard::new(registry, &archive_handle);
        if !registry.offers_entry_named(
            &archive_handle,
            staging_tokens::StagedArchiveKind::HostPack,
            &entry_name,
        ) {
            return Err("that entry is not part of this archive".to_string());
        }
        let sp = get_state_path(&game_path, cfg);
        let mod_data = InstalledMod {
            name: mod_name,
            version: mod_version,
            file_type: Some(file_type),
            location: Some(format!("host:{}:{}", host_mod_id, host_subpath)),
            ..decisions::archive_provenance(mod_id, file_id, &entry_name)
        };
        install_host_pack_op(&game_path, &sp, &zip, &entry_name, mod_data, cfg)?;

        Ok(())
    })
    .await?;

    if decisions::is_local_archive(mod_id) {
        track_mod_installed(&app, game_id.as_str(), -1, "local");
        return Ok(());
    }
    register_download(&app, file_id).await;
    track_mod_installed(&app, game_id.as_str(), mod_id, &install_format);
    Ok(())
}

/// Removes every archive still registered, for application exit.
pub(crate) fn discard_all_staged_archives(app: &AppHandle) {
    for plan in staged_archives(app).drain() {
        cleanup::run_sync(&plan);
    }
}

/// The one registry this application owns, held as Tauri managed state so every caller names
/// the same instance instead of reaching for a process global.
pub(crate) fn staged_archives(app: &AppHandle) -> &staging_tokens::StagingRegistry {
    use tauri::Manager;
    app.state::<staging_tokens::StagingRegistry>().inner()
}

/// Ends a workflow's hold on its archive and removes it through the plan the registry holds.
async fn finish_with_archive(registry: &staging_tokens::StagingRegistry, handle: &str) {
    match registry.finalize(handle) {
        Some(plan) => cleanup::run(&plan).await,
        None => log::warn!("staged archives: nothing to finish for this handle"),
    }
}

/// Discards a staged archive the renderer was offered a prompt for. Takes the handle from
/// that prompt rather than a path, so the only file this can remove is one the backend
/// registered, and only once.
#[tauri::command]
#[specta::specta]
pub async fn discard_staged_archive(app: AppHandle, token: String) {
    let Some(plan) = staged_archives(&app).finalize(&token) else {
        log::warn!("discard_staged_archive: unknown, in-use, or already-finished handle");
        return;
    };
    cleanup::run(&plan).await;
}

#[tauri::command]
#[specta::specta]
pub async fn uninstall_mod(
    app: AppHandle,
    game_path: String,
    uid: String,
    game_id: String,
) -> Result<(), String> {
    if resources::is_resource_uid(&uid) {
        return resources::act(
            &app,
            &game_id,
            &game_path,
            &uid,
            resources::ResourceAction::Uninstall,
        )
        .await;
    }
    let _state_guard = lock_game_state(&app, game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    uninstall_mod_op(&game_path, &get_state_path(&game_path, cfg), &uid, cfg)?;
    crate::commands::analytics::track(
        &app,
        "mod_uninstalled",
        serde_json::json!({ "game": game_id.as_str() }),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn enable_mod(
    app: AppHandle,
    game_path: String,
    uid: String,
    game_id: String,
) -> Result<(), String> {
    if resources::is_resource_uid(&uid) {
        return resources::act(
            &app,
            &game_id,
            &game_path,
            &uid,
            resources::ResourceAction::Enable,
        )
        .await;
    }
    let _state_guard = lock_game_state(&app, game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    let settings = read_settings(&app);
    let launcher = game_settings(&settings, game_id.as_str()).and_then(|gs| gs.launcher.clone());
    enable_mod_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &uid,
        cfg,
        launcher.as_deref(),
    )?;
    crate::commands::analytics::track(
        &app,
        "mod_enabled",
        serde_json::json!({ "game": game_id.as_str() }),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn disable_mod(
    app: AppHandle,
    game_path: String,
    uid: String,
    game_id: String,
) -> Result<(), String> {
    if resources::is_resource_uid(&uid) {
        return resources::act(
            &app,
            &game_id,
            &game_path,
            &uid,
            resources::ResourceAction::Disable,
        )
        .await;
    }
    let _state_guard = lock_game_state(&app, game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    let settings = read_settings(&app);
    let launcher = game_settings(&settings, game_id.as_str()).and_then(|gs| gs.launcher.clone());
    disable_mod_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &uid,
        cfg,
        launcher.as_deref(),
    )?;
    crate::commands::analytics::track(
        &app,
        "mod_disabled",
        serde_json::json!({ "game": game_id.as_str() }),
    );
    Ok(())
}

/// User-initiated Tier 3 identification (see nexus_content.rs): looks up one already-
/// installed, unidentified mod against Nexus's content index. Never called from
/// get_installed. The renderer calls this per-mod from an explicit "Identify" action,
/// same shape as the ModWorkshop identification pipeline being automatic (SHA256) while
/// this one, lacking a hash to key on, cannot safely be.
#[tauri::command]
#[specta::specta]
pub async fn identify_mod_via_nexus_content(
    app: AppHandle,
    game_path: String,
    uid: String,
    game_id: String,
) -> Result<nexus_content::NexusContentIdentifyOutcome, String> {
    resources::refuse_resource_uid(&uid, "Nexus identification")?;
    let _state_guard = lock_game_state(&app, game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    let state_path = get_state_path(&game_path, cfg);
    let mut state =
        state::read_state_for_game(&game_path, &state_path, cfg).map_err(|e| e.to_string())?;
    let native = native_files::NativeGuard::load(&game_path, cfg)?;

    let Some(m) = state.mods.iter_mut().find(|m| m.uid == uid) else {
        return Err(format!(
            "identify_mod_via_nexus_content: no mod with uid '{uid}'"
        ));
    };
    let target = cfg.target_for(m.location.as_deref());

    if target.shared_paks.is_some() {
        let folder = get_folder_path(&state.folders, m.folder_id.as_deref());
        native.check_file(&active_mod_path(
            &game_path,
            &m.filename,
            folder.as_deref(),
            target,
        ))?;
        native.check_file(&paths::installed_mod_path(
            &game_path,
            &m.filename,
            folder.as_deref(),
            target,
            m.enabled,
        ))?;
    }

    let outcome = nexus_content::identify_via_nexus_content_op(
        &app,
        game_id.as_str(),
        &game_path,
        &state.folders,
        target,
        m,
    )
    .await?;

    if outcome != nexus_content::NexusContentIdentifyOutcome::Skipped {
        native.check_state_path(&state_path)?;
        save_state(&state_path, &state).map_err(save_error)?;
    }
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub async fn move_crimeboss_mod_target(
    app: AppHandle,
    game_path: String,
    uid: String,
) -> Result<(), String> {
    resources::refuse_resource_uid(&uid, "Moving between Crime Boss mod folders")?;
    let _state_guard = lock_game_state(&app, "cb").await;
    let cfg = engine_for_game("cb")?;
    let settings = read_settings(&app);
    let launcher = game_settings(&settings, "cb").and_then(|gs| gs.launcher.clone());
    let result = move_crimeboss_mod_target_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &uid,
        cfg,
        launcher.as_deref(),
    );
    if result.is_ok() {
        crate::commands::analytics::track(
            &app,
            "mod_target_moved",
            serde_json::json!({ "game": "cb" }),
        );
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn reorder_in_folder(
    state: tauri::State<'_, StateLocks>,
    game_path: String,
    folder_id: Option<String>,
    ordered_uids: Vec<String>,
    game_id: String,
) -> Result<(), String> {
    for uid in &ordered_uids {
        resources::refuse_resource_uid(uid, "Load order")?;
    }
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    reorder_mods_in_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        folder_id.as_deref(),
        &ordered_uids,
        cfg,
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn move_to_folder(
    state: tauri::State<'_, StateLocks>,
    game_path: String,
    uid: String,
    target_folder_id: Option<String>,
    target_position: usize,
    game_id: String,
) -> Result<(), String> {
    resources::refuse_resource_uid(&uid, "Moving into a folder")?;
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    move_mod_to_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &uid,
        target_folder_id,
        target_position,
        cfg,
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn reorder_children(
    state: tauri::State<'_, StateLocks>,
    game_path: String,
    parent_id: Option<String>,
    items: Vec<TopLevelItem>,
    game_id: String,
) -> Result<(), String> {
    for item in &items {
        if let TopLevelItem::Mod { id } = item {
            resources::refuse_resource_uid(id, "Load order")?;
        }
    }
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    reorder_children_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        parent_id.as_deref(),
        &items,
        cfg,
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn move_folder(
    state: tauri::State<'_, StateLocks>,
    game_path: String,
    folder_id: String,
    target_parent_id: Option<String>,
    game_id: String,
) -> Result<(), String> {
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    move_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &folder_id,
        target_parent_id,
        cfg,
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn create_folder(
    state: tauri::State<'_, StateLocks>,
    game_path: String,
    display_name: String,
    parent_id: Option<String>,
    game_id: String,
) -> Result<ModFolder, String> {
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    create_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &display_name,
        parent_id,
        cfg,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn rename_folder(
    state: tauri::State<'_, StateLocks>,
    game_path: String,
    folder_id: String,
    display_name: String,
    game_id: String,
) -> Result<(), String> {
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    rename_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &folder_id,
        &display_name,
        cfg,
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_folder(
    state: tauri::State<'_, StateLocks>,
    game_path: String,
    folder_id: String,
    game_id: String,
) -> Result<(), String> {
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    delete_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &folder_id,
        cfg,
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn open_mods_folder(app: AppHandle, game_id: String) -> Result<(), String> {
    let gid = game_id.as_str();
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, gid).and_then(|gs| gs.game_path.clone()) else {
        return Ok(());
    };
    let cfg = engine_for_game(gid)?;
    let dir = mods_base(&game_path, cfg.primary());
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "linux")]
    let _ = crate::commands::launchers::outside_bundle(
        std::process::Command::new("xdg-open").arg(&dir),
    )
    .spawn();
    Ok(())
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModFolderInfo {
    pub tag: String,
    pub label_key: String,
    pub label_name: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn list_mod_folders(game_id: String) -> Result<Vec<ModFolderInfo>, String> {
    let cfg = engine_for_game(game_id.as_str())?;
    Ok(cfg
        .targets
        .iter()
        .map(|t| ModFolderInfo {
            tag: t.tag.to_string(),
            label_key: t.label_key.to_string(),
            label_name: t.label_name.map(str::to_string),
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn open_mod_folder(app: AppHandle, game_id: String, tag: String) -> Result<(), String> {
    let gid = game_id.as_str();
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, gid).and_then(|gs| gs.game_path.clone()) else {
        return Ok(());
    };
    let cfg = engine_for_game(gid)?;
    let dir = mods_base(&game_path, cfg.target_for(Some(&tag)));
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "linux")]
    let _ = crate::commands::launchers::outside_bundle(
        std::process::Command::new("xdg-open").arg(&dir),
    )
    .spawn();
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod shared_archive_tests;

#[cfg(test)]
mod mp4_tests;

#[cfg(test)]
#[path = "decisions_tests.rs"]
mod decisions_tests;

#[cfg(test)]
#[path = "cleanup_tests.rs"]
mod cleanup_tests;

#[cfg(test)]
#[path = "staged_tests.rs"]
mod staged_tests;

#[cfg(test)]
#[path = "marker_contract_tests.rs"]
mod marker_contract_tests;

#[cfg(test)]
#[path = "plugin_install_tests.rs"]
mod plugin_install_tests;
