mod crimeboss_settings;
mod engine;
mod folders;
mod host_mods;
mod identify;
mod install;
mod naming;
mod nexus_content;
mod paths;
mod pdmod;
mod reorder;
mod state;
mod types;
mod ue4ss_modstxt;
mod zip;

// Public API used by lib.rs, launchers/, and other modules
pub use self::engine::{
    backup_dir, engine_for_game, ModEngineConfig, CRIMEBOSS_ENGINE, PD2_ENGINE, PD3_ENGINE,
    PDTH_ENGINE, RAID_ENGINE,
};
pub use self::install::install_mod_from_path;
pub use self::paths::{find_untracked_host_packs, find_untracked_paks, get_state_path, mods_base};
pub use self::state::{get_folder_path, read_state, reconcile_state};
pub use self::types::{
    InstalledMod, InstalledResponse, ModFolder, ModsState, TopLevelItem, UpdateStatus,
};
pub use self::zip::{compute_md5, compute_sha256};

// Mod-identification helpers (get_installed pipeline) — see identify.rs
#[cfg(test)]
pub(crate) use self::identify::embedded_modworkshop_id;
pub(crate) use self::identify::{
    ensure_untracked_folders, hash_untracked, hashable_file_for_mod_dir, identify_untracked,
    regroup_negative_ids_by_name_suffix, resync_crimeboss_enabled_flags, upgrade_negative_ids,
};

// Internal helpers used by Tauri commands in this file
pub(crate) use self::folders::{
    create_folder_op, delete_folder_op, move_folder_op, rename_folder_op,
};
pub(crate) use self::install::{
    disable_mod_op, enable_mod_op, install_host_pack_op, move_crimeboss_mod_target_op,
    uninstall_mod_op,
};
pub(crate) use self::naming::{hash_filename, pak_filename, strip_priority_prefix};
pub(crate) use self::paths::{active_mod_path, disabled_base, disabled_mod_path};
pub(crate) use self::reorder::{
    move_mod_to_folder_op, reorder_children_op, reorder_mods_in_folder_op,
};
pub(crate) use self::state::save_state;
pub(crate) use self::zip::{
    extract_archive_flat, extract_dir_entry, extract_entry, extract_entry_into_crimeboss_skeleton,
    extract_entry_with_sidecars, list_pak_entries, mark_archive_files, resolve_archive_download,
    InstallPrompt, ModContext, ResolveError,
};

// Re-exports needed only in test builds (suppressed in release to avoid unused-import warnings)
#[cfg(test)]
pub(crate) use self::crimeboss_settings::{
    find_pak_in_dir, read_enabled_from_file, set_enabled_in_file, settings_id_from_pak_filename,
};
#[cfg(test)]
pub(crate) use self::engine::{disabled_dir, mods_dir};
#[cfg(test)]
pub(crate) use self::naming::{
    apply_priority_prefix, derive_content_segment, make_uid, mod_folder_name,
    recover_published_filename,
};
#[cfg(test)]
pub(crate) use self::ue4ss_modstxt::{
    entry_name, read_enabled_from_mods_txt, set_enabled_in_mods_txt,
};
#[cfg(test)]
pub(crate) use self::zip::{
    classify_archive_dirs, detect_archive, has_ue4ss_loader_signature, is_unplaceable_pack, is_zip,
    safe_dest, ArchiveFormat,
};

use crate::commands::api::{api_get, http_client, user_agent};
use crate::commands::download::download_file;
use crate::commands::mod_index;
use crate::commands::settings::{game_settings, read_settings};
use crate::commands::sources;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
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

async fn lock_game_state(app: &AppHandle, game_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    use tauri::Manager;
    app.state::<StateLocks>().acquire(game_id).await
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
    Unrecognized,
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
        });
    };

    let _state_guard = lock_game_state(&app, game_id).await;
    let state_path = get_state_path(&game_path, cfg);
    let mods_hidden = backup_dir(&game_path, cfg.primary()).exists();

    let mut state = reconcile_state(&game_path, &state_path, cfg);
    let any_upgraded =
        upgrade_negative_ids(&app, &mut state.mods, cfg.game_id, cfg.index_game_name);
    regroup_negative_ids_by_name_suffix(&mut state.mods);

    // The player can also toggle mods from Crime Boss's own Options > Mods screen — pull that
    // back in so Modrex's tracked flag doesn't silently disagree with the game.
    let cb_resynced = if cfg.game_id == "cb" {
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
        let sha256 = match hashable_file_for_mod_dir(&dir) {
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
                id: sources::source_native_local_id("modworkshop", &h.mod_remote_id.to_string()),
                name: h.mod_name,
                version: h.version,
                filename: set_name,
                enabled,
                remote_id: Some(h.mod_remote_id.to_string()),
                file_id: Some(h.file_remote_id),
                sha256,
                location,
                installed_at: Utc::now().to_rfc3339(),
                ..InstalledMod::default()
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
        if any_upgraded || discovered_hosts || cb_resynced {
            save_state(&state_path, &state);
        }
        return Ok(InstalledResponse {
            mods: state.mods,
            folders: state.folders,
            mods_hidden: true,
        });
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

    let untracked = find_untracked_paks(&game_path, &known, cfg).await;
    if untracked.is_empty() {
        let (mods, any_checked) = mark_archive_files(&game_path, &state.folders, state.mods, cfg);
        if any_checked || any_upgraded || discovered_hosts || cb_resynced {
            save_state(
                &state_path,
                &ModsState {
                    folders: state.folders.clone(),
                    mods: mods.clone(),
                },
            );
        }
        return Ok(InstalledResponse {
            mods,
            folders: state.folders,
            mods_hidden: false,
        });
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
    let (mods, _) = mark_archive_files(&game_path, &folders, mods, cfg);
    save_state(
        &state_path,
        &ModsState {
            folders: folders.clone(),
            mods: mods.clone(),
        },
    );
    Ok(InstalledResponse {
        mods,
        folders,
        mods_hidden: false,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn install_mod(
    app: AppHandle,
    mod_id: u32,
    game_path: String,
    folder_id: Option<String>,
    game_id: String,
) -> Result<InstallOutcome, String> {
    let prep = async {
        let mod_val = api_get(&app, &format!("/mods/{}", mod_id), vec![]).await?;

        let mod_name = mod_val["name"].as_str().unwrap_or("").to_string();
        let mod_version = mod_val["version"].as_str().unwrap_or("").to_string();
        let remote_id = mod_val["id"].as_i64().unwrap_or(0);

        let (file_id, download_url, file_type) = if !mod_val["download"].is_null() {
            let dl = &mod_val["download"];
            (
                dl["id"].as_i64().unwrap_or(0),
                dl["download_url"]
                    .as_str()
                    .ok_or("no download_url")?
                    .to_string(),
                dl["type"].as_str().unwrap_or("pak").to_string(),
            )
        } else if mod_val["has_download"].as_bool().unwrap_or(false) {
            let f = api_get(&app, &format!("/mods/{}/files/latest", mod_id), vec![]).await?;
            (
                f["id"].as_i64().unwrap_or(0),
                f["download_url"]
                    .as_str()
                    .ok_or("no download_url")?
                    .to_string(),
                f["type"].as_str().unwrap_or("pak").to_string(),
            )
        } else {
            return Err("Mod has no download".to_string());
        };

        let download_id = format!("mod:{mod_id}");
        let downloaded = download_file(&app, &download_url, &file_type, &download_id).await?;
        Ok::<_, String>((
            mod_name,
            mod_version,
            remote_id,
            file_id,
            file_type,
            downloaded,
        ))
    }
    .await;

    let (mod_name, mod_version, remote_id, file_id, file_type, downloaded) = match prep {
        Ok(v) => v,
        Err(e) => {
            log::warn!("install_mod {mod_id}: {e}");
            return Err(e);
        }
    };

    let cfg = engine_for_game(game_id.as_str())?;
    let (tmp, zip_orig, location_tag) = match resolve_archive_download(downloaded, cfg) {
        Err(ResolveError::Ue4ssLoader(zip_path)) => {
            let settings = read_settings(&app);
            let launcher = game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
            let result = crate::commands::ue4ss::install_loader(
                cfg.game_id,
                &game_path,
                launcher.as_deref(),
                &zip_path,
            );
            let _ = std::fs::remove_file(&zip_path);
            return result.map(|()| InstallOutcome::Installed);
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
        Err(ResolveError::Failure(e)) => {
            log::warn!("install_mod {mod_id}: {e}");
            return Err(e);
        }
        Ok(v) => v,
    };
    let _state_guard = lock_game_state(&app, game_id.as_str()).await;
    let target = cfg.target_for(location_tag.as_deref());

    let result = async {
        let sha256 = match &target.unit {
            engine::ModUnit::File { .. } => compute_sha256(&tmp).await?,
            engine::ModUnit::Directory { entry_markers, .. } => {
                let hash_path = if entry_markers.is_empty() {
                    hashable_file_for_mod_dir(&tmp)
                        .ok_or_else(|| "mod directory is empty".to_string())?
                } else {
                    entry_markers
                        .iter()
                        .map(|m| tmp.join(m))
                        .find(|p| p.exists())
                        .unwrap_or_else(|| tmp.join(entry_markers[0]))
                };
                compute_sha256(&hash_path).await?
            }
        };
        let uid = file_id.to_string();
        // The real modworkshop id, kept as a string for remote_id and identity
        // comparisons — InstalledMod.id itself is an opaque, source-scoped key (see
        // sources::source_native_local_id) and is never compared against this directly.
        let remote_id_str = remote_id.to_string();
        let local_id = sources::source_native_local_id("modworkshop", &remote_id_str);
        let sp = get_state_path(&game_path, cfg);
        let saved = read_state(&sp);
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
        let was_disabled = existing_entry.is_some_and(|e| !e.enabled);
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
        let filename = saved
            .mods
            .iter()
            .find(|m| m.uid == uid)
            .map(|m| m.filename.clone())
            .unwrap_or_else(|| match &target.unit {
                engine::ModUnit::File { .. } => pak_filename(&mod_name),
                engine::ModUnit::Directory { .. } if cfg.game_id == "cb" => {
                    naming::mod_folder_name(&mod_name)
                }
                engine::ModUnit::Directory { .. } => tmp
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&mod_name)
                    .to_string(),
            });

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
                uninstall_mod_op(&game_path, &sp, &same[0].uid.clone(), cfg);
            }
        }

        install_mod_from_path(
            &game_path,
            &sp,
            InstalledMod {
                uid: uid.clone(),
                id: local_id,
                name: mod_name,
                version: mod_version,
                filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
                remote_id: Some(remote_id_str.clone()),
                file_id: Some(file_id),
                file_type: Some(file_type.clone()),
                sha256: Some(sha256),
                ..InstalledMod::default()
            },
            &tmp,
            effective_folder_id,
            cfg,
            target,
        )?;

        if was_disabled {
            let settings = read_settings(&app);
            let launcher_str =
                game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
            disable_mod_op(&game_path, &sp, &uid, cfg, launcher_str.as_deref());
        }

        let _ = http_client()
            .post(format!(
                "https://api.modworkshop.net/files/{}/register-download",
                file_id
            ))
            .header("User-Agent", user_agent(&app))
            .send()
            .await;

        Ok::<(), String>(())
    }
    .await;

    match &target.unit {
        engine::ModUnit::File { .. } => {
            let _ = tokio::fs::remove_file(&tmp).await;
            for ext in naming::PAK_SIDECAR_EXTENSIONS {
                let _ = tokio::fs::remove_file(tmp.with_extension(ext)).await;
            }
        }
        // Crime Boss's synthesized skeleton is `tmp` itself (one level under the OS temp dir),
        // not `{uuid_dir}/{dir_name}` like PD2/PDTH — `tmp.parent()` there would be the OS temp
        // dir itself, which must never be passed to remove_dir_all.
        engine::ModUnit::Directory { .. } if cfg.game_id == "cb" => {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
        }
        engine::ModUnit::Directory { .. } => {
            if let Some(parent) = tmp.parent() {
                let _ = tokio::fs::remove_dir_all(parent).await;
            }
        }
    }
    if let Some(orig) = zip_orig {
        let _ = tokio::fs::remove_file(&orig).await;
    }
    match &result {
        Ok(_) => crate::commands::analytics::track(
            &app,
            "mod_installed",
            serde_json::json!({
                "game": game_id.as_str(),
                "mod_id": mod_id,
                "format": file_type,
            }),
        ),
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
    let download_id = format!("file:{mod_id}:{file_id}");
    let downloaded = match download_file(&app, &download_url, &file_type, &download_id).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("install_file {mod_id}/{file_id}: {e}");
            return Err(e);
        }
    };
    let (tmp, zip_orig, location_tag) = match resolve_archive_download(downloaded, cfg) {
        Err(ResolveError::Ue4ssLoader(zip_path)) => {
            let settings = read_settings(&app);
            let launcher = game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
            let result = crate::commands::ue4ss::install_loader(
                cfg.game_id,
                &game_path,
                launcher.as_deref(),
                &zip_path,
            );
            let _ = std::fs::remove_file(&zip_path);
            return result.map(|()| InstallOutcome::Installed);
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
        Err(ResolveError::Failure(e)) => {
            log::warn!("install_file {mod_id}/{file_id}: {e}");
            return Err(e);
        }
        Ok(v) => v,
    };
    let _state_guard = lock_game_state(&app, game_id.as_str()).await;
    let target = cfg.target_for(location_tag.as_deref());

    let result = async {
        let sha256 = match &target.unit {
            engine::ModUnit::File { .. } => compute_sha256(&tmp).await?,
            engine::ModUnit::Directory { entry_markers, .. } => {
                let hash_path = if entry_markers.is_empty() {
                    hashable_file_for_mod_dir(&tmp)
                        .ok_or_else(|| "mod directory is empty".to_string())?
                } else {
                    entry_markers
                        .iter()
                        .map(|m| tmp.join(m))
                        .find(|p| p.exists())
                        .unwrap_or_else(|| tmp.join(entry_markers[0]))
                };
                compute_sha256(&hash_path).await?
            }
        };
        let uid = file_id.to_string();
        let mod_id_str = mod_id.to_string();
        let local_id = sources::source_native_local_id("modworkshop", &mod_id_str);
        let sp = get_state_path(&game_path, cfg);
        let saved = read_state(&sp);
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
        let filename = saved
            .mods
            .iter()
            .find(|m| m.uid == uid)
            .map(|m| m.filename.clone())
            .unwrap_or_else(|| match &target.unit {
                engine::ModUnit::File { .. } => {
                    if file_type == "main" {
                        pak_filename(&mod_name)
                    } else {
                        pak_filename(&format!("{}_{}", mod_name, file_id))
                    }
                }
                engine::ModUnit::Directory { .. } if cfg.game_id == "cb" => {
                    naming::mod_folder_name(&mod_name)
                }
                engine::ModUnit::Directory { .. } => tmp
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&mod_name)
                    .to_string(),
            });

        install_mod_from_path(
            &game_path,
            &sp,
            InstalledMod {
                uid,
                id: local_id,
                name: mod_name,
                version: mod_version,
                filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
                remote_id: Some(mod_id_str.clone()),
                file_id: Some(file_id),
                file_type: Some(file_type.clone()),
                sha256: Some(sha256),
                ..InstalledMod::default()
            },
            &tmp,
            effective_folder_id,
            cfg,
            target,
        )?;

        let _ = http_client()
            .post(format!(
                "https://api.modworkshop.net/files/{}/register-download",
                file_id
            ))
            .header("User-Agent", user_agent(&app))
            .send()
            .await;

        Ok::<(), String>(())
    }
    .await;

    match &target.unit {
        engine::ModUnit::File { .. } => {
            let _ = tokio::fs::remove_file(&tmp).await;
            for ext in naming::PAK_SIDECAR_EXTENSIONS {
                let _ = tokio::fs::remove_file(tmp.with_extension(ext)).await;
            }
        }
        // See the matching comment in install_mod: tmp.parent() must never be removed for Crime
        // Boss, since tmp is the synthesized skeleton root itself, not a {uuid_dir}/{dir_name}
        // child like PD2/PDTH.
        engine::ModUnit::Directory { .. } if cfg.game_id == "cb" => {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
        }
        engine::ModUnit::Directory { .. } => {
            if let Some(parent) = tmp.parent() {
                let _ = tokio::fs::remove_dir_all(parent).await;
            }
        }
    }
    if let Some(orig) = zip_orig {
        let _ = tokio::fs::remove_file(&orig).await;
    }
    match &result {
        Ok(_) => crate::commands::analytics::track(
            &app,
            "mod_installed",
            serde_json::json!({
                "game": game_id.as_str(),
                "mod_id": mod_id,
                "format": file_type,
            }),
        ),
        Err(e) => log::warn!("install_file {mod_id} file={file_id}: {e}"),
    }
    result.map(|()| InstallOutcome::Installed)
}

pub(crate) struct NexusInstallMeta {
    pub mod_id: u32,
    pub file_id: u32,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub thumbnail_url: Option<String>,
    pub file_type: String,
}

// Nexus identity always stays its own tracked entry, never merged into a modworkshop
// one even when a byte-identical cross-posted file exists elsewhere (see identify.rs's
// upgrade_negative_ids, which never reassigns an entry that already carries a
// remote_id). Picker sentinels cannot be forwarded because their UI requires
// modworkshop metadata that this handoff does not have.
pub(crate) async fn install_nexus_download(
    app: &AppHandle,
    game_id: &str,
    game_path: &str,
    downloaded: PathBuf,
    meta: NexusInstallMeta,
) -> Result<(), String> {
    let NexusInstallMeta {
        mod_id: nexus_mod_id,
        file_id: nexus_file_id,
        name: mod_name,
        version: mod_version,
        author: mod_author,
        thumbnail_url,
        file_type,
    } = meta;
    let cfg = engine_for_game(game_id)?;
    let dl_path = downloaded.clone();
    let (tmp, zip_orig, location_tag) = match resolve_archive_download(downloaded, cfg) {
        Err(ResolveError::Ue4ssLoader(zip_path)) => {
            let settings = read_settings(app);
            let launcher = game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
            let result = crate::commands::ue4ss::install_loader(
                cfg.game_id,
                game_path,
                launcher.as_deref(),
                &zip_path,
            );
            let _ = std::fs::remove_file(&zip_path);
            return result;
        }
        Err(ResolveError::Prompt(prompt)) => {
            let _ = std::fs::remove_file(&dl_path);
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
        Err(ResolveError::Failure(e)) => {
            log::warn!("install_nexus_download {nexus_mod_id}/{nexus_file_id}: {e}");
            return Err(e);
        }
        Ok(v) => v,
    };
    let _state_guard = lock_game_state(app, game_id).await;
    let target = cfg.target_for(location_tag.as_deref());

    let result = async {
        let sha256 = match &target.unit {
            engine::ModUnit::File { .. } => compute_sha256(&tmp).await?,
            engine::ModUnit::Directory { entry_markers, .. } => {
                let hash_path = if entry_markers.is_empty() {
                    hashable_file_for_mod_dir(&tmp)
                        .ok_or_else(|| "mod directory is empty".to_string())?
                } else {
                    entry_markers
                        .iter()
                        .map(|m| tmp.join(m))
                        .find(|p| p.exists())
                        .unwrap_or_else(|| tmp.join(entry_markers[0]))
                };
                compute_sha256(&hash_path).await?
            }
        };
        let uid = format!("nexus:{nexus_mod_id}:{nexus_file_id}");
        let sp = get_state_path(game_path, cfg);
        let saved = read_state(&sp);
        let existing = saved.mods.iter().find(|m| m.uid == uid);
        let folder_id = existing.and_then(|e| e.folder_id.clone());
        let filename = existing
            .map(|m| m.filename.clone())
            .unwrap_or_else(|| match &target.unit {
                engine::ModUnit::File { .. } => pak_filename(&mod_name),
                engine::ModUnit::Directory { .. } if cfg.game_id == "cb" => {
                    naming::mod_folder_name(&mod_name)
                }
                engine::ModUnit::Directory { .. } => tmp
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&mod_name)
                    .to_string(),
            });

        install_mod_from_path(
            game_path,
            &sp,
            InstalledMod {
                uid,
                id: crate::commands::sources::source_native_local_id(
                    "nexus",
                    &nexus_mod_id.to_string(),
                ),
                name: mod_name.clone(),
                version: mod_version,
                filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
                source: "nexus".to_string(),
                remote_id: Some(nexus_mod_id.to_string()),
                file_remote_id: Some(nexus_file_id.to_string()),
                author: mod_author,
                thumbnail_url,
                file_id: Some(nexus_file_id as i64),
                file_type: Some(file_type.clone()),
                sha256: Some(sha256),
                ..InstalledMod::default()
            },
            &tmp,
            folder_id,
            cfg,
            target,
        )
    }
    .await;

    match &target.unit {
        engine::ModUnit::File { .. } => {
            let _ = tokio::fs::remove_file(&tmp).await;
            for ext in naming::PAK_SIDECAR_EXTENSIONS {
                let _ = tokio::fs::remove_file(tmp.with_extension(ext)).await;
            }
        }
        // Crime Boss's synthesized skeleton is tmp itself, one level under the OS
        // temp dir; tmp.parent() there would be the OS temp dir, which must never
        // be passed to remove_dir_all.
        engine::ModUnit::Directory { .. } if cfg.game_id == "cb" => {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
        }
        engine::ModUnit::Directory { .. } => {
            if let Some(parent) = tmp.parent() {
                let _ = tokio::fs::remove_dir_all(parent).await;
            }
        }
    }
    if let Some(orig) = zip_orig {
        let _ = tokio::fs::remove_file(&orig).await;
    }
    if let Err(e) = &result {
        log::warn!("install_nexus_download {nexus_mod_id}/{nexus_file_id}: {e}");
    }
    result
}

/// Recovers a dropped mod's real name, for both display and the on-disk filename. The
/// dropped archive's own OS filename is often a download manager's naming scheme (Nexus's
/// website downloads are "{Name} {id} {version} {timestamp} {hash}.zip"), not the mod's
/// real name — `fallback` (the dropped file's own stem) is only correct when nothing
/// better is available, which is exactly the case for a bare loose .pak dropped with no
/// zip wrapper around it.
///
/// Directory-unit's `tmp` already carries the real folder name (resolve_archive_download's
/// two-level temp makes `tmp.file_name()` the mod's own directory name), but File-unit's
/// `tmp` is a random-uuid path and Crime Boss's is an opaque skeleton root with no readable
/// name of its own (see extract_entry_into_crimeboss_skeleton) — both need the real name
/// pulled back out of the original archive's single pak entry instead.
fn recover_dropped_mod_stem(
    unit: &engine::ModUnit,
    is_crimeboss: bool,
    tmp: &std::path::Path,
    zip_orig: Option<&std::path::Path>,
    fallback: &str,
) -> String {
    if matches!(unit, engine::ModUnit::Directory { .. }) && !is_crimeboss {
        return tmp
            .file_name()
            .and_then(|s| s.to_str())
            .map(String::from)
            .unwrap_or_else(|| fallback.to_string());
    }
    zip_orig
        .and_then(|orig| list_pak_entries(orig).ok())
        .and_then(|entries| match entries.as_slice() {
            [entry] => std::path::Path::new(entry)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(String::from),
            _ => None,
        })
        .unwrap_or_else(|| fallback.to_string())
}

/// Overwrites the generic unidentified fields on a freshly built InstalledMod with a
/// confirmed Nexus identity. uid switches to Tier 1's own "nexus:{mod_id}:{file_id}"
/// scheme so a later nxm:// install of the same file reconciles onto this entry
/// instead of creating a duplicate.
fn apply_nexus_archive_identity(
    entry: &mut InstalledMod,
    m: &crate::commands::nexus::NexusHashMatch,
    detail: &crate::commands::domain::ModDetail,
) {
    entry.uid = format!("nexus:{}:{}", m.mod_id, m.file_id);
    entry.id = sources::source_native_local_id("nexus", &m.mod_id.to_string());
    entry.name = detail.name.clone();
    entry.version = detail.version.clone();
    entry.update_status = UpdateStatus::Known;
    entry.source = "nexus".to_string();
    entry.remote_id = Some(m.mod_id.to_string());
    entry.file_remote_id = Some(m.file_id.to_string());
    entry.author = Some(detail.user.name.clone());
    entry.thumbnail_url = detail.thumbnail.as_ref().map(|t| t.file.clone());
    entry.file_id = Some(m.file_id as i64);
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

    let (tmp, zip_orig, location_tag) = match resolve_archive_download(temp.clone(), cfg) {
        Err(ResolveError::Ue4ssLoader(zip_path)) => {
            let settings = read_settings(&app);
            let launcher = game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
            let result = crate::commands::ue4ss::install_loader(
                cfg.game_id,
                &game_path,
                launcher.as_deref(),
                &zip_path,
            );
            let _ = std::fs::remove_file(&zip_path);
            return result.map(|()| InstallOutcome::Installed);
        }
        // The picker / host-pack / CB-flat modals install directly from the temp copy (which they
        // delete afterwards), so forward the prompt enriched with a synthetic identity, mirroring
        // install_file. get_installed reconciles the resulting entries by SHA256 on the next refresh.
        Err(ResolveError::Prompt(prompt)) => {
            let syn = hash_filename(&file_stem);
            return Ok((*prompt)
                .with_mod_context(ModContext {
                    mod_id: syn,
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
        Err(ResolveError::Failure(e)) => {
            let _ = tokio::fs::remove_file(&temp).await;
            log::warn!("install_dropped_file {path}: {e}");
            return Err(e);
        }

        Ok(v) => v,
    };
    let _state_guard = lock_game_state(&app, game_id.as_str()).await;
    let target = cfg.target_for(location_tag.as_deref());
    let display_stem = recover_dropped_mod_stem(
        &target.unit,
        cfg.game_id == "cb",
        &tmp,
        zip_orig.as_deref(),
        &file_stem,
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
    // A hash match without its enrichment detail is not installed as identified -
    // apply_nexus_archive_identity only runs when both are present - but the failure
    // is still worth a log line, same as the identification lookup above.
    let nexus_detail = match &nexus_match {
        Some(m) => {
            match crate::commands::nexus::nexus_get_mod(app.clone(), game_id.clone(), m.mod_id)
                .await
            {
                Ok(value) => match crate::commands::domain::parse_nexus_detail(value) {
                    Ok(detail) => Some(detail),
                    Err(e) => {
                        log::warn!("install_dropped_file: nexus detail parse failed: {e}");
                        None
                    }
                },
                Err(e) => {
                    log::warn!("install_dropped_file: nexus detail fetch failed: {e}");
                    None
                }
            }
        }
        None => None,
    };

    let result = async {
        let sha256 = match &target.unit {
            engine::ModUnit::File { .. } => compute_sha256(&tmp).await?,
            engine::ModUnit::Directory { entry_markers, .. } => {
                let hash_path = if entry_markers.is_empty() {
                    hashable_file_for_mod_dir(&tmp)
                        .ok_or_else(|| "mod directory is empty".to_string())?
                } else {
                    entry_markers
                        .iter()
                        .map(|m| tmp.join(m))
                        .find(|p| p.exists())
                        .unwrap_or_else(|| tmp.join(entry_markers[0]))
                };
                compute_sha256(&hash_path).await?
            }
        };
        // Discovery-matching identity: filename drives the uid/id the untracked-scan would assign,
        // so a later manual refresh reconciles this entry instead of duplicating it.
        let filename = match &target.unit {
            engine::ModUnit::File { .. } => pak_filename(&display_stem),
            engine::ModUnit::Directory { .. } if cfg.game_id == "cb" => {
                naming::mod_folder_name(&display_stem)
            }
            engine::ModUnit::Directory { .. } => display_stem.clone(),
        };
        let sp = get_state_path(&game_path, cfg);

        let mut mod_entry = InstalledMod {
            uid: strip_priority_prefix(&filename).to_string(),
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
        if let (Some(m), Some(detail)) = (&nexus_match, &nexus_detail) {
            apply_nexus_archive_identity(&mut mod_entry, m, detail);
        }

        install_mod_from_path(&game_path, &sp, mod_entry, &tmp, folder_id, cfg, target)?;
        Ok::<(), String>(())
    }
    .await;

    match &target.unit {
        engine::ModUnit::File { .. } => {
            let _ = tokio::fs::remove_file(&tmp).await;
            for ext in naming::PAK_SIDECAR_EXTENSIONS {
                let _ = tokio::fs::remove_file(tmp.with_extension(ext)).await;
            }
        }
        engine::ModUnit::Directory { .. } if cfg.game_id == "cb" => {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
        }
        engine::ModUnit::Directory { .. } => {
            if let Some(parent) = tmp.parent() {
                let _ = tokio::fs::remove_dir_all(parent).await;
            }
        }
    }
    if let Some(orig) = zip_orig {
        let _ = tokio::fs::remove_file(&orig).await;
    }
    let _ = tokio::fs::remove_file(&temp).await;

    match &result {
        Ok(_) => crate::commands::analytics::track(
            &app,
            "mod_installed",
            serde_json::json!({
                "game": game_id.as_str(),
                "mod_id": -1,
                "format": "local",
            }),
        ),
        Err(e) => log::warn!("install_dropped_file {path}: {e}"),
    }
    result.map(|()| InstallOutcome::Installed)
}

/// The single same-mod entry to uninstall before an archive-entry install lands under a new uid:
/// an older version under a different file id, or this file's previous bare-pak packaging
/// (uid == "{file_id}"). An archive-scheme sibling of the same file (uid "{file_id}_...") is
/// another entry of the archive being installed right now — removing it would make a multi-entry
/// batch install delete each predecessor, leaving only the last selected entry.
fn stale_entry_for_zip_install<'a>(
    mods: &'a [InstalledMod],
    uid: &str,
    mod_id: i64,
    mod_id_str: &str,
    file_id: i64,
) -> Option<&'a InstalledMod> {
    if mod_id <= 0 || mods.iter().any(|m| m.uid == uid) {
        return None;
    }
    let same: Vec<_> = mods
        .iter()
        .filter(|m| m.remote_id.as_deref() == Some(mod_id_str))
        .collect();
    if same.len() != 1 || same[0].uid.starts_with(&format!("{file_id}_")) {
        return None;
    }
    Some(same[0])
}

// The arg list outgrew specta's function arity; the renderer passes these under one args key.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallFromZipEntryArgs {
    pub zip_path: String,
    pub entry_name: String,
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
    let _state_guard = lock_game_state(&app, args.game_id.as_str()).await;
    let InstallFromZipEntryArgs {
        zip_path,
        entry_name,
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
    let zip = PathBuf::from(&zip_path);
    let install_format = file_type.clone(); // file_type is moved before the success emit below

    // Set only by classify_archive_dirs's ZIP_MULTI_PAK payload (a ue4ss_mods sub-mod folder, or
    // a candidate mod folder) — see the (ext, tmp_parent) branch below.
    let cb_dir_entry = cfg.game_id == "cb" && entry_kind.as_deref() == Some("dir");

    // entry_stem / entry_filename are the last path component of entry_name.
    let entry_stem = std::path::Path::new(&entry_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&entry_name);
    let entry_filename = std::path::Path::new(&entry_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&entry_name)
        .to_string();

    // For File mods: ext is a temp .pak file.
    // For Directory mods: ext is {tmp_parent}/{dir_name} (two-level, consistent with resolve_archive_download).
    // Crime Boss pak entries are neither: the chosen .pak entry (plus its .ucas/.utoc siblings) is
    // wrapped in a synthesized Content/Paks/WindowsNoEditor skeleton — see
    // extract_entry_into_crimeboss_skeleton. Crime Boss directory entries (cb_dir_entry) use the
    // same two-level scheme as every other Directory-unit game.
    let (ext, tmp_parent) = if cfg.game_id == "cb" && !cb_dir_entry {
        let skeleton_root = extract_entry_into_crimeboss_skeleton(&zip, &entry_name)?;
        (skeleton_root.clone(), Some(skeleton_root))
    } else if cb_dir_entry {
        let parent = std::env::temp_dir().join(format!("modrex-mod-{}", Uuid::new_v4()));
        let p = parent.join(&entry_filename);
        (p, Some(parent))
    } else {
        match &target.unit {
            engine::ModUnit::File { .. } => {
                let p = std::env::temp_dir().join(format!("modrex-mod-{}.pak", Uuid::new_v4()));
                (p, None)
            }
            engine::ModUnit::Directory { .. } => {
                let parent = std::env::temp_dir().join(format!("modrex-mod-{}", Uuid::new_v4()));
                let p = parent.join(&entry_filename);
                (p, Some(parent))
            }
        }
    };

    let uid = format!("{}_{}", file_id, entry_stem);
    // Crime Boss installs into its own named folder, not the archive entry's pak filename.
    let install_filename = if cfg.game_id == "cb" {
        naming::mod_folder_name(&mod_name)
    } else {
        entry_filename.clone()
    };

    let result = async {
        if cb_dir_entry {
            extract_dir_entry(&zip, &entry_name, &ext)?
        } else if cfg.game_id != "cb" {
            match &target.unit {
                engine::ModUnit::File { .. } => {
                    extract_entry_with_sidecars(&zip, &entry_name, &ext)?
                }
                engine::ModUnit::Directory { .. } => extract_dir_entry(&zip, &entry_name, &ext)?,
            }
        }
        let sha256 = match &target.unit {
            engine::ModUnit::File { .. } => compute_sha256(&ext).await?,
            engine::ModUnit::Directory { entry_markers, .. } => {
                let hash_path = if entry_markers.is_empty() {
                    hashable_file_for_mod_dir(&ext)
                        .ok_or_else(|| "mod directory is empty".to_string())?
                } else {
                    entry_markers
                        .iter()
                        .map(|m| ext.join(m))
                        .find(|p| p.exists())
                        .unwrap_or_else(|| ext.join(entry_markers[0]))
                };
                compute_sha256(&hash_path).await?
            }
        };
        let sp = get_state_path(&game_path, cfg);
        let saved = read_state(&sp);
        let mod_id_str = mod_id.to_string();
        let local_id = sources::source_native_local_id("modworkshop", &mod_id_str);

        // Reuse existing uid by SHA256 so a reinstall moves the entry in-place rather than duplicating.
        let sha256_match = saved
            .mods
            .iter()
            .find(|m| m.sha256.as_deref() == Some(sha256.as_str()));
        let uid = sha256_match.map(|m| m.uid.clone()).unwrap_or(uid);

        if let Some(stale) =
            stale_entry_for_zip_install(&saved.mods, &uid, mod_id, &mod_id_str, file_id)
        {
            let stale_uid = stale.uid.clone();
            uninstall_mod_op(&game_path, &sp, &stale_uid, cfg);
        }

        // Never inherit folderId from existing entries; callers always supply the target folder.
        let effective_folder_id = folder_id;

        install_mod_from_path(
            &game_path,
            &sp,
            InstalledMod {
                uid,
                id: local_id,
                name: mod_name,
                version: mod_version,
                filename: install_filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
                remote_id: Some(mod_id_str.clone()),
                file_id: Some(file_id),
                file_type: Some(file_type),
                sha256: Some(sha256),
                ..InstalledMod::default()
            },
            &ext,
            effective_folder_id,
            cfg,
            target,
        )?;

        let _ = http_client()
            .post(format!(
                "https://api.modworkshop.net/files/{}/register-download",
                file_id
            ))
            .header("User-Agent", user_agent(&app))
            .send()
            .await;

        Ok::<(), String>(())
    }
    .await;

    // Keep the zip alive for multi-entry installs; only remove the extracted temp here.
    if let Some(parent) = tmp_parent {
        let _ = tokio::fs::remove_dir_all(parent).await;
    } else {
        let _ = tokio::fs::remove_file(&ext).await;
        for sidecar_ext in naming::PAK_SIDECAR_EXTENSIONS {
            let _ = tokio::fs::remove_file(ext.with_extension(sidecar_ext)).await;
        }
    }
    match &result {
        Ok(_) => crate::commands::analytics::track(
            &app,
            "mod_installed",
            serde_json::json!({
                "game": game_id.as_str(),
                "mod_id": mod_id,
                "format": install_format,
            }),
        ),
        Err(e) => log::warn!("install_from_zip_entry {mod_id} file={file_id}: {e}"),
    }
    result
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
    zip_path: String,
    mod_id: i64,
    mod_name: String,
    file_id: i64,
    file_type: String,
    mod_version: String,
    game_path: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let _state_guard = lock_game_state(&app, "cb").await;
    let cfg = engine_for_game("cb")?;
    let target = cfg.primary();
    let zip = PathBuf::from(&zip_path);
    let tmp_dir = std::env::temp_dir().join(format!("modrex-mod-{}", Uuid::new_v4()));

    let result = async {
        extract_archive_flat(&zip, &tmp_dir)?;
        let hash_path = hashable_file_for_mod_dir(&tmp_dir)
            .ok_or_else(|| "mod directory is empty".to_string())?;
        let sha256 = compute_sha256(&hash_path).await?;
        let sp = get_state_path(&game_path, cfg);
        let saved = read_state(&sp);
        let uid = format!("{}_flat", file_id);
        let sha256_match = saved
            .mods
            .iter()
            .find(|m| m.sha256.as_deref() == Some(sha256.as_str()));
        let uid = sha256_match.map(|m| m.uid.clone()).unwrap_or(uid);
        let filename = naming::mod_folder_name(&mod_name);

        install_mod_from_path(
            &game_path,
            &sp,
            InstalledMod {
                uid,
                id: sources::source_native_local_id("modworkshop", &mod_id.to_string()),
                name: mod_name,
                version: mod_version,
                filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
                remote_id: Some(mod_id.to_string()),
                file_id: Some(file_id),
                file_type: Some(file_type.clone()),
                sha256: Some(sha256),
                ..InstalledMod::default()
            },
            &tmp_dir,
            folder_id,
            cfg,
            target,
        )?;

        let _ = http_client()
            .post(format!(
                "https://api.modworkshop.net/files/{}/register-download",
                file_id
            ))
            .header("User-Agent", user_agent(&app))
            .send()
            .await;

        Ok::<(), String>(())
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    let _ = tokio::fs::remove_file(&zip).await;

    match &result {
        Ok(_) => crate::commands::analytics::track(
            &app,
            "mod_installed",
            serde_json::json!({
                "game": "cb",
                "mod_id": mod_id,
                "format": file_type,
            }),
        ),
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
    pub zip_path: String,
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
    let _state_guard = lock_game_state(&app, args.game_id.as_str()).await;
    let InstallHostPackArgs {
        zip_path,
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
    let sp = get_state_path(&game_path, cfg);
    let install_format = file_type.clone();
    let mod_data = InstalledMod {
        id: sources::source_native_local_id("modworkshop", &mod_id.to_string()),
        name: mod_name,
        version: mod_version,
        remote_id: Some(mod_id.to_string()),
        file_id: Some(file_id),
        file_type: Some(file_type),
        location: Some(format!("host:{}:{}", host_mod_id, host_subpath)),
        ..InstalledMod::default()
    };
    install_host_pack_op(
        &game_path,
        &sp,
        &PathBuf::from(&zip_path),
        &entry_name,
        mod_data,
        cfg,
    )?;

    let _ = http_client()
        .post(format!(
            "https://api.modworkshop.net/files/{}/register-download",
            file_id
        ))
        .header("User-Agent", user_agent(&app))
        .send()
        .await;

    crate::commands::analytics::track(
        &app,
        "mod_installed",
        serde_json::json!({
            "game": game_id.as_str(),
            "mod_id": mod_id,
            "format": install_format,
        }),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_temp_file(path: String) {
    let _ = tokio::fs::remove_file(&path).await;
}

#[tauri::command]
#[specta::specta]
pub async fn uninstall_mod(
    app: AppHandle,
    game_path: String,
    uid: String,
    game_id: String,
) -> Result<(), String> {
    let _state_guard = lock_game_state(&app, game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    uninstall_mod_op(&game_path, &get_state_path(&game_path, cfg), &uid, cfg);
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
    );
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
    );
    crate::commands::analytics::track(
        &app,
        "mod_disabled",
        serde_json::json!({ "game": game_id.as_str() }),
    );
    Ok(())
}

/// User-initiated Tier 3 identification (see nexus_content.rs): looks up one already-
/// installed, unidentified mod against Nexus's content index. Never called from
/// get_installed — the renderer calls this per-mod from an explicit "Identify" action,
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
    let _state_guard = lock_game_state(&app, game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    let state_path = get_state_path(&game_path, cfg);
    let mut state = read_state(&state_path);

    let Some(m) = state.mods.iter_mut().find(|m| m.uid == uid) else {
        return Err(format!(
            "identify_mod_via_nexus_content: no mod with uid '{uid}'"
        ));
    };
    let target = cfg.target_for(m.location.as_deref());

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
        save_state(&state_path, &state);
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
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    reorder_mods_in_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        folder_id.as_deref(),
        &ordered_uids,
        cfg,
    );
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
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    move_mod_to_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &uid,
        target_folder_id,
        target_position,
        cfg,
    );
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
    let _state_guard = state.acquire(game_id.as_str()).await;
    let cfg = engine_for_game(game_id.as_str())?;
    reorder_children_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        parent_id.as_deref(),
        &items,
        cfg,
    );
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
    );
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
    );
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
    );
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
    let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    Ok(())
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModFolderInfo {
    pub tag: String,
    pub label_key: String,
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
    let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    Ok(())
}

#[cfg(test)]
mod tests;
