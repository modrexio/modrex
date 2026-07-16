mod crimeboss_settings;
mod engine;
mod folders;
mod host_mods;
mod identify;
mod install;
mod naming;
mod paths;
mod pdmod;
mod reorder;
mod state;
mod types;
mod ue4ss_modstxt;
mod zip;

// Public API used by lib.rs, launchers/, and other modules
pub use self::engine::{backup_dir, engine_for_game, ModEngineConfig};
pub use self::install::install_mod_from_path;
pub use self::paths::{find_untracked_host_packs, find_untracked_paks, get_state_path, mods_base};
pub use self::state::{get_folder_path, read_state, reconcile_state};
pub use self::types::{InstalledMod, InstalledResponse, ModFolder, ModsState, TopLevelItem};
pub use self::zip::compute_sha256;

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
    extract_entry_with_sidecars, mark_archive_files, resolve_archive_download,
};

// Re-exports needed only in test builds (suppressed in release to avoid unused-import warnings)
#[cfg(test)]
pub(crate) use self::crimeboss_settings::{
    find_pak_in_dir, read_enabled_from_file, set_enabled_in_file, settings_id_from_pak_filename,
};
#[cfg(test)]
pub(crate) use self::naming::{apply_priority_prefix, make_uid, mod_folder_name};
#[cfg(test)]
pub(crate) use self::ue4ss_modstxt::{
    entry_name, read_enabled_from_mods_txt, set_enabled_in_mods_txt,
};
#[cfg(test)]
pub(crate) use self::zip::{
    classify_archive_dirs, detect_archive, has_ue4ss_loader_signature, is_unplaceable_pack, is_zip,
    list_pak_entries, safe_dest, ArchiveFormat,
};

use crate::commands::api::{api_get, http_client, user_agent};
use crate::commands::download::download_file;
use crate::commands::mod_index;
use crate::commands::settings::{game_settings, read_settings};
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

// Mod identification (get_installed pipeline) lives in identify.rs
#[tauri::command]
pub async fn get_installed(
    app: AppHandle,
    game_id: Option<String>,
) -> Result<InstalledResponse, String> {
    let game_id = game_id.as_deref().unwrap_or("pd3");
    let cfg = engine_for_game(game_id);
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, game_id).and_then(|gs| gs.game_path.clone())
    else {
        return Ok(InstalledResponse {
            mods: vec![],
            folders: vec![],
            mods_hidden: false,
        });
    };

    let state_path = get_state_path(&game_path, cfg);
    let mods_hidden = backup_dir(&game_path, cfg.primary()).exists();

    let mut state = reconcile_state(&game_path, &state_path, cfg);
    let any_upgraded = upgrade_negative_ids(&app, &mut state.mods, cfg.index_game_name);
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
            .and_then(|s| mod_index::lookup_sha256(&app, s, cfg.index_game_name));
        let location = Some(format!("host:{}:{}", host_id, subpath));
        let entry = match hit {
            Some(h) => InstalledMod {
                uid: format!("{}_{}", h.file_remote_id, set_name),
                id: h.mod_remote_id,
                name: h.mod_name,
                version: h.version,
                filename: set_name,
                enabled,
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
    let index = mod_index::open_index(&app);
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
pub async fn install_mod(
    app: AppHandle,
    mod_id: u32,
    game_path: String,
    folder_id: Option<String>,
    game_id: Option<String>,
) -> Result<(), String> {
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

    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    let (tmp, zip_orig, location_tag) = match resolve_archive_download(downloaded, cfg) {
        Err(e) if e.starts_with("UE4SS_LOADER:") => {
            let zip_path = PathBuf::from(&e["UE4SS_LOADER:".len()..]);
            let settings = read_settings(&app);
            let launcher = game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
            let result = crate::commands::ue4ss::install_loader(
                cfg.game_id,
                &game_path,
                launcher.as_deref(),
                &zip_path,
            );
            let _ = std::fs::remove_file(&zip_path);
            return result;
        }
        Err(e)
            if e.starts_with("ZIP_MULTI_PAK:")
                || e.starts_with("HOST_MOD_PACK:")
                || e.starts_with("CB_FLAT_ARCHIVE:") =>
        {
            let prefix = e
                .split_once(':')
                .map(|(p, _)| format!("{p}:"))
                .unwrap_or_default();
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&e[prefix.len()..]) {
                v["modId"] = serde_json::json!(remote_id);
                v["modName"] = serde_json::json!(&mod_name);
                v["fileId"] = serde_json::json!(file_id);
                v["fileType"] = serde_json::json!(&file_type);
                v["modVersion"] = serde_json::json!(&mod_version);
                return Err(format!("{}{}", prefix, v));
            }
            return Err(e);
        }
        result => match result {
            Ok(v) => v,
            Err(e) => {
                log::warn!("install_mod {mod_id}: {e}");
                return Err(e);
            }
        },
    };
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
        let sp = get_state_path(&game_path, cfg);
        let saved = read_state(&sp);
        let existing_entry = saved.mods.iter().find(|m| m.uid == uid).or_else(|| {
            if remote_id <= 0 {
                return None;
            }
            let same: Vec<_> = saved.mods.iter().filter(|m| m.id == remote_id).collect();
            // Only inherit for single-entry mods; multi-pak entries span different folders.
            if same.len() == 1 {
                same.into_iter().next()
            } else {
                None
            }
        });
        let was_disabled = existing_entry.map_or(false, |e| !e.enabled);
        // Don't inherit folder when same-id already has multiple files; each pak is placed deliberately.
        let effective_folder_id = folder_id.or_else(|| {
            if remote_id > 0 && saved.mods.iter().filter(|m| m.id == remote_id).count() > 1 {
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
            let same: Vec<_> = saved.mods.iter().filter(|m| m.id == remote_id).collect();
            if same.len() == 1 {
                uninstall_mod_op(&game_path, &sp, &same[0].uid.clone(), cfg);
            }
        }

        install_mod_from_path(
            &game_path,
            &sp,
            InstalledMod {
                uid: uid.clone(),
                id: remote_id,
                name: mod_name,
                version: mod_version,
                filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
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
                "game": game_id.as_deref().unwrap_or("pd3"),
                "mod_id": mod_id,
                "format": file_type,
            }),
        ),
        Err(e) => log::warn!("install_mod {mod_id}: {e}"),
    }
    result
}

#[tauri::command]
pub async fn install_file(
    app: AppHandle,
    mod_id: i64,
    mod_name: String,
    file_id: i64,
    download_url: String,
    file_type: String,
    mod_version: String,
    game_path: String,
    game_id: Option<String>,
) -> Result<(), String> {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    let download_id = format!("file:{mod_id}:{file_id}");
    let downloaded = match download_file(&app, &download_url, &file_type, &download_id).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("install_file {mod_id}/{file_id}: {e}");
            return Err(e);
        }
    };
    let (tmp, zip_orig, location_tag) = match resolve_archive_download(downloaded, cfg) {
        Err(e) if e.starts_with("UE4SS_LOADER:") => {
            let zip_path = PathBuf::from(&e["UE4SS_LOADER:".len()..]);
            let settings = read_settings(&app);
            let launcher = game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
            let result = crate::commands::ue4ss::install_loader(
                cfg.game_id,
                &game_path,
                launcher.as_deref(),
                &zip_path,
            );
            let _ = std::fs::remove_file(&zip_path);
            return result;
        }
        Err(e)
            if e.starts_with("ZIP_MULTI_PAK:")
                || e.starts_with("HOST_MOD_PACK:")
                || e.starts_with("CB_FLAT_ARCHIVE:") =>
        {
            let prefix = e
                .split_once(':')
                .map(|(p, _)| format!("{p}:"))
                .unwrap_or_default();
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&e[prefix.len()..]) {
                v["modId"] = serde_json::json!(mod_id);
                v["modName"] = serde_json::json!(&mod_name);
                v["fileId"] = serde_json::json!(file_id);
                v["fileType"] = serde_json::json!(&file_type);
                v["modVersion"] = serde_json::json!(&mod_version);
                return Err(format!("{}{}", prefix, v));
            }
            return Err(e);
        }
        result => match result {
            Ok(v) => v,
            Err(e) => {
                log::warn!("install_file {mod_id}/{file_id}: {e}");
                return Err(e);
            }
        },
    };
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
        let sp = get_state_path(&game_path, cfg);
        let saved = read_state(&sp);
        let existing_entry = saved.mods.iter().find(|m| m.uid == uid).or_else(|| {
            if mod_id <= 0 {
                return None;
            }
            let same: Vec<_> = saved.mods.iter().filter(|m| m.id == mod_id).collect();
            if same.len() == 1 {
                same.into_iter().next()
            } else {
                None
            }
        });
        // Never inherit folder when this mod_id already has multiple installed files.
        let effective_folder_id =
            if mod_id > 0 && saved.mods.iter().filter(|m| m.id == mod_id).count() > 1 {
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
                id: mod_id,
                name: mod_name,
                version: mod_version,
                filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
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
                "game": game_id.as_deref().unwrap_or("pd3"),
                "mod_id": mod_id,
                "format": file_type,
            }),
        ),
        Err(e) => log::warn!("install_file {mod_id} file={file_id}: {e}"),
    }
    result
}

/// Installs a mod from a local file the user dropped onto the window (Explorer drag-drop).
/// The file carries no modworkshop identity, so it is installed as an unidentified entry
/// (negative id, "unknown" version) exactly like an ambiently-discovered pak — `get_installed`'s
/// SHA256 upgrade resolves its real identity on the next refresh. The dropped file is copied into
/// temp first so resolution/cleanup never touches the user's original.
#[tauri::command]
pub async fn install_dropped_file(
    app: AppHandle,
    path: String,
    game_path: String,
    folder_id: Option<String>,
    game_id: Option<String>,
) -> Result<(), String> {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
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
        Err(e) if e.starts_with("UE4SS_LOADER:") => {
            let zip_path = PathBuf::from(&e["UE4SS_LOADER:".len()..]);
            let settings = read_settings(&app);
            let launcher = game_settings(&settings, cfg.game_id).and_then(|gs| gs.launcher.clone());
            let result = crate::commands::ue4ss::install_loader(
                cfg.game_id,
                &game_path,
                launcher.as_deref(),
                &zip_path,
            );
            let _ = std::fs::remove_file(&zip_path);
            return result;
        }
        // The picker / host-pack / CB-flat modals install directly from the temp copy (which they
        // delete afterwards), so forward the sentinel enriched with a synthetic identity, mirroring
        // install_file. get_installed reconciles the resulting entries by SHA256 on the next refresh.
        // UNRECOGNIZED_ARCHIVE is intentionally not forwarded — its modal fetches a modworkshop mod
        // page a local file has no id for — so it falls through to the plain-error arm below.
        Err(e)
            if e.starts_with("ZIP_MULTI_PAK:")
                || e.starts_with("HOST_MOD_PACK:")
                || e.starts_with("CB_FLAT_ARCHIVE:") =>
        {
            let prefix = e
                .split_once(':')
                .map(|(p, _)| format!("{p}:"))
                .unwrap_or_default();
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&e[prefix.len()..]) {
                let syn = hash_filename(&file_stem);
                v["modId"] = serde_json::json!(syn);
                v["modName"] = serde_json::json!(&file_stem);
                v["fileId"] = serde_json::json!(syn);
                v["fileType"] =
                    serde_json::json!(src.extension().and_then(|s| s.to_str()).unwrap_or("zip"));
                v["modVersion"] = serde_json::json!("unknown");
                return Err(format!("{}{}", prefix, v));
            }
            return Err(e);
        }
        result => match result {
            Ok(v) => v,
            Err(e) => {
                let _ = tokio::fs::remove_file(&temp).await;
                log::warn!("install_dropped_file {path}: {e}");
                return Err(e);
            }
        },
    };
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
        // Discovery-matching identity: filename drives the uid/id the untracked-scan would assign,
        // so a later manual refresh reconciles this entry instead of duplicating it.
        let filename = match &target.unit {
            engine::ModUnit::File { .. } => pak_filename(&file_stem),
            engine::ModUnit::Directory { .. } if cfg.game_id == "cb" => {
                naming::mod_folder_name(&file_stem)
            }
            engine::ModUnit::Directory { .. } => tmp
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&file_stem)
                .to_string(),
        };
        let uid = strip_priority_prefix(&filename).to_string();
        let id = hash_filename(&filename);
        let sp = get_state_path(&game_path, cfg);

        install_mod_from_path(
            &game_path,
            &sp,
            InstalledMod {
                uid,
                id,
                name: file_stem.clone(),
                version: "unknown".to_string(),
                filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
                sha256: Some(sha256),
                ..InstalledMod::default()
            },
            &tmp,
            folder_id,
            cfg,
            target,
        )?;
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
                "game": game_id.as_deref().unwrap_or("pd3"),
                "mod_id": -1,
                "format": "local",
            }),
        ),
        Err(e) => log::warn!("install_dropped_file {path}: {e}"),
    }
    result
}

#[tauri::command]
pub async fn install_from_zip_entry(
    app: AppHandle,
    zip_path: String,
    entry_name: String,
    mod_id: i64,
    mod_name: String,
    file_id: i64,
    file_type: String,
    mod_version: String,
    game_path: String,
    folder_id: Option<String>,
    game_id: Option<String>,
    location_tag: Option<String>,
    entry_kind: Option<String>,
) -> Result<(), String> {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
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

        // Reuse existing uid by SHA256 so a reinstall moves the entry in-place rather than duplicating.
        let sha256_match = saved
            .mods
            .iter()
            .find(|m| m.sha256.as_deref() == Some(sha256.as_str()));
        let uid = sha256_match.map(|m| m.uid.clone()).unwrap_or(uid);

        // If the mod had a single previously-installed entry under a different uid (e.g. an
        // older version that shipped as a bare file rather than this archive entry's uid scheme),
        // remove it first so install_mod_from_path doesn't produce two entries for the same mod.
        if saved.mods.iter().all(|m| m.uid != uid) && mod_id > 0 {
            let same: Vec<_> = saved.mods.iter().filter(|m| m.id == mod_id).collect();
            if same.len() == 1 {
                uninstall_mod_op(&game_path, &sp, &same[0].uid.clone(), cfg);
            }
        }

        // Never inherit folderId from existing entries; callers always supply the target folder.
        let effective_folder_id = folder_id;

        install_mod_from_path(
            &game_path,
            &sp,
            InstalledMod {
                uid,
                id: mod_id,
                name: mod_name,
                version: mod_version,
                filename: install_filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
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
                "game": game_id.as_deref().unwrap_or("pd3"),
                "mod_id": mod_id,
                "format": install_format,
            }),
        ),
        Err(e) => log::warn!("install_from_zip_entry {mod_id} file={file_id}: {e}"),
    }
    result
}

/// Installs a Crime Boss archive whose content has no enclosing folder (every entry sits at the
/// zip root) — the renderer reaches this after a user confirms a `CB_FLAT_ARCHIVE` dialog. There's
/// only one possible destination (the primary `mods` target, which blanket-accepts any directory),
/// so unlike `install_from_zip_entry` there's no entry to pick: the whole archive is extracted flat
/// and installed as a single `mods/<name>` folder named from the mod's display name.
#[tauri::command]
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
    let cfg = engine_for_game("cb");
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
                id: mod_id,
                name: mod_name,
                version: mod_version,
                filename,
                enabled: true,
                installed_at: Utc::now().to_rfc3339(),
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
/// Menu Backgrounds set into `mods/Menu Backgrounds/Assets/`). The renderer reaches this after a
/// `HOST_MOD_PACK` sentinel; the zip is left in place for multi-set installs (caller deletes it).
#[tauri::command]
pub async fn install_host_pack(
    app: AppHandle,
    zip_path: String,
    entry_name: String,
    mod_id: i64,
    mod_name: String,
    file_id: i64,
    file_type: String,
    mod_version: String,
    game_path: String,
    host_mod_id: i64,
    host_subpath: String,
    game_id: Option<String>,
) -> Result<(), String> {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    let sp = get_state_path(&game_path, cfg);
    let install_format = file_type.clone();
    let mod_data = InstalledMod {
        id: mod_id,
        name: mod_name,
        version: mod_version,
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
            "game": game_id.as_deref().unwrap_or("pd3"),
            "mod_id": mod_id,
            "format": install_format,
        }),
    );
    Ok(())
}

#[tauri::command]
pub async fn delete_temp_file(path: String) {
    let _ = tokio::fs::remove_file(&path).await;
}

#[tauri::command]
pub fn uninstall_mod(app: AppHandle, game_path: String, uid: String, game_id: Option<String>) {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    uninstall_mod_op(&game_path, &get_state_path(&game_path, cfg), &uid, cfg);
    crate::commands::analytics::track(
        &app,
        "mod_uninstalled",
        serde_json::json!({ "game": game_id.as_deref().unwrap_or("pd3") }),
    );
}

#[tauri::command]
pub fn enable_mod(app: AppHandle, game_path: String, uid: String, game_id: Option<String>) {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    let settings = read_settings(&app);
    let launcher = game_settings(&settings, game_id.as_deref().unwrap_or("pd3"))
        .and_then(|gs| gs.launcher.clone());
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
        serde_json::json!({ "game": game_id.as_deref().unwrap_or("pd3") }),
    );
}

#[tauri::command]
pub fn disable_mod(app: AppHandle, game_path: String, uid: String, game_id: Option<String>) {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    let settings = read_settings(&app);
    let launcher = game_settings(&settings, game_id.as_deref().unwrap_or("pd3"))
        .and_then(|gs| gs.launcher.clone());
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
        serde_json::json!({ "game": game_id.as_deref().unwrap_or("pd3") }),
    );
}

#[tauri::command]
pub fn move_crimeboss_mod_target(
    app: AppHandle,
    game_path: String,
    uid: String,
) -> Result<(), String> {
    let cfg = engine_for_game("cb");
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
pub fn reorder_in_folder(
    game_path: String,
    folder_id: Option<String>,
    ordered_uids: Vec<String>,
    game_id: Option<String>,
) {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    reorder_mods_in_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        folder_id.as_deref(),
        &ordered_uids,
        cfg,
    );
}

#[tauri::command]
pub fn move_to_folder(
    game_path: String,
    uid: String,
    target_folder_id: Option<String>,
    target_position: usize,
    game_id: Option<String>,
) {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    move_mod_to_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &uid,
        target_folder_id,
        target_position,
        cfg,
    );
}

#[tauri::command]
pub fn reorder_children(
    game_path: String,
    parent_id: Option<String>,
    items: Vec<TopLevelItem>,
    game_id: Option<String>,
) {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    reorder_children_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        parent_id.as_deref(),
        &items,
        cfg,
    );
}

#[tauri::command]
pub fn move_folder(
    game_path: String,
    folder_id: String,
    target_parent_id: Option<String>,
    game_id: Option<String>,
) {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    move_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &folder_id,
        target_parent_id,
        cfg,
    );
}

#[tauri::command]
pub fn create_folder(
    game_path: String,
    display_name: String,
    parent_id: Option<String>,
    game_id: Option<String>,
) -> Result<ModFolder, String> {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    create_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &display_name,
        parent_id,
        cfg,
    )
}

#[tauri::command]
pub fn rename_folder(
    game_path: String,
    folder_id: String,
    display_name: String,
    game_id: Option<String>,
) {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    rename_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &folder_id,
        &display_name,
        cfg,
    );
}

#[tauri::command]
pub fn delete_folder(game_path: String, folder_id: String, game_id: Option<String>) {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    delete_folder_op(
        &game_path,
        &get_state_path(&game_path, cfg),
        &folder_id,
        cfg,
    );
}

#[tauri::command]
pub fn open_mods_folder(app: AppHandle, game_id: Option<String>) {
    let gid = game_id.as_deref().unwrap_or("pd3");
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, gid).and_then(|gs| gs.game_path.clone()) else {
        return;
    };
    let cfg = engine_for_game(gid);
    let dir = mods_base(&game_path, cfg.primary());
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModFolderInfo {
    pub tag: String,
    pub label_key: String,
}

#[tauri::command]
pub fn list_mod_folders(game_id: Option<String>) -> Vec<ModFolderInfo> {
    let cfg = engine_for_game(game_id.as_deref().unwrap_or("pd3"));
    cfg.targets
        .iter()
        .map(|t| ModFolderInfo {
            tag: t.tag.to_string(),
            label_key: t.label_key.to_string(),
        })
        .collect()
}

#[tauri::command]
pub fn open_mod_folder(app: AppHandle, game_id: Option<String>, tag: String) {
    let gid = game_id.as_deref().unwrap_or("pd3");
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, gid).and_then(|gs| gs.game_path.clone()) else {
        return;
    };
    let cfg = engine_for_game(gid);
    let dir = mods_base(&game_path, cfg.target_for(Some(&tag)));
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
}

#[cfg(test)]
mod tests;
