use super::engine::ModEngineConfig;
use super::naming::log_name;
use super::naming::{apply_priority_prefix, strip_priority_prefix};
use super::paths::{active_mod_path, disabled_base, disabled_mod_path, mods_base};
use super::state::{get_folder_path, read_state, save_error, save_state};
use super::types::ModFolder;
use std::fs;
use std::path::Path;
use uuid::Uuid;

pub fn create_folder_op(
    game_path: &str,
    state_path: &Path,
    display_name: &str,
    parent_id: Option<String>,
    cfg: &ModEngineConfig,
) -> Result<ModFolder, String> {
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;

    if let Some(existing) = state
        .folders
        .iter()
        .find(|f| f.parent_id == parent_id && f.display_name == display_name)
    {
        return Ok(existing.clone());
    }

    let slug: String = display_name
        .trim()
        .chars()
        .filter(|&c| !"\\/:*?\"<>|".contains(c))
        .collect();
    let slug = if slug.is_empty() {
        "folder".to_string()
    } else {
        slug
    };

    let max_folders = state
        .folders
        .iter()
        .filter(|f| f.parent_id == parent_id)
        .map(|f| f.priority)
        .max()
        .unwrap_or(0);
    let priority = max_folders + 1;
    let disk_name = if cfg.primary().priority_prefix_enabled() {
        apply_priority_prefix(&slug, priority)
    } else {
        slug
    };
    let id = Uuid::new_v4().to_string();

    let parent_rel = get_folder_path(&state.folders, parent_id.as_deref());
    let dir = match &parent_rel {
        Some(r) => mods_base(game_path, cfg.primary()).join(r).join(&disk_name),
        None => mods_base(game_path, cfg.primary()).join(&disk_name),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let folder = ModFolder {
        id,
        disk_name,
        display_name: display_name.to_string(),
        priority,
        parent_id,
    };
    state.folders.push(folder.clone());
    save_state(state_path, &state).map_err(save_error)?;
    Ok(folder)
}

pub fn move_folder_op(
    game_path: &str,
    state_path: &Path,
    folder_id: &str,
    target_parent_id: Option<String>,
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;
    let Some(folder) = state.folders.iter().find(|f| f.id == folder_id).cloned() else {
        return Ok(());
    };
    if folder.parent_id == target_parent_id {
        return Ok(());
    }

    let mut cur = target_parent_id.clone();
    while let Some(ref cid) = cur {
        if cid == folder_id {
            return Ok(());
        }
        cur = state
            .folders
            .iter()
            .find(|f| &f.id == cid)
            .and_then(|f| f.parent_id.clone());
    }

    let mods_b = mods_base(game_path, cfg.primary());
    let dis_b = disabled_base(game_path, cfg.primary());
    let old_rel = get_folder_path(&state.folders, Some(folder_id)).unwrap_or_default();

    let max_f = state
        .folders
        .iter()
        .filter(|f| f.parent_id == target_parent_id)
        .map(|f| f.priority)
        .max()
        .unwrap_or(0);
    let max_m = state
        .mods
        .iter()
        .filter(|m| m.folder_id == target_parent_id)
        .filter_map(|m| m.priority)
        .max()
        .unwrap_or(0);
    let new_priority = max_f.max(max_m) + 1;
    let new_disk_name = if cfg.primary().priority_prefix_enabled() {
        apply_priority_prefix(strip_priority_prefix(&folder.disk_name), new_priority)
    } else {
        strip_priority_prefix(&folder.disk_name).to_string()
    };

    for f in state.folders.iter_mut() {
        if f.id == folder_id {
            f.parent_id = target_parent_id.clone();
            f.disk_name = new_disk_name.clone();
            f.priority = new_priority;
        }
    }
    let new_rel = get_folder_path(&state.folders, Some(folder_id)).unwrap_or_default();

    let tgt_parent_rel = get_folder_path(&state.folders, target_parent_id.as_deref());
    let active_tgt_parent = match &tgt_parent_rel {
        Some(r) => mods_b.join(r),
        None => mods_b.clone(),
    };
    let dis_tgt_parent = match &tgt_parent_rel {
        Some(r) => dis_b.join(r),
        None => dis_b.clone(),
    };

    let old_a = mods_b.join(&old_rel);
    if old_a.exists() {
        if let Err(e) = fs::create_dir_all(&active_tgt_parent) {
            log::warn!("move_folder: create_dir_all active: {e}");
        }
        if let Err(e) = fs::rename(&old_a, mods_b.join(&new_rel)) {
            log::warn!("move_folder: rename active {}: {e}", log_name(&old_a));
        }
    }
    let old_d = dis_b.join(&old_rel);
    if old_d.exists() {
        if let Err(e) = fs::create_dir_all(&dis_tgt_parent) {
            log::warn!("move_folder: create_dir_all disabled: {e}");
        }
        if let Err(e) = fs::rename(&old_d, dis_b.join(&new_rel)) {
            log::warn!("move_folder: rename disabled {}: {e}", log_name(&old_d));
        }
    }

    save_state(state_path, &state).map_err(save_error)?;
    Ok(())
}

pub fn rename_folder_op(
    game_path: &str,
    state_path: &Path,
    folder_id: &str,
    display_name: &str,
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;
    let Some(folder) = state.folders.iter().find(|f| f.id == folder_id).cloned() else {
        return Ok(());
    };

    let slug: String = display_name
        .trim()
        .chars()
        .filter(|&c| !"\\/:*?\"<>|".contains(c))
        .collect();
    let slug = if slug.is_empty() {
        "folder".to_string()
    } else {
        slug
    };
    let new_disk_name = if cfg.primary().priority_prefix_enabled() {
        apply_priority_prefix(&slug, folder.priority)
    } else {
        slug
    };

    if new_disk_name != folder.disk_name {
        let parent_rel = get_folder_path(&state.folders, folder.parent_id.as_deref());
        let mods_b = mods_base(game_path, cfg.primary());
        let dis_b = disabled_base(game_path, cfg.primary());

        let (old_a, new_a) = match &parent_rel {
            Some(r) => (
                mods_b.join(r).join(&folder.disk_name),
                mods_b.join(r).join(&new_disk_name),
            ),
            None => (mods_b.join(&folder.disk_name), mods_b.join(&new_disk_name)),
        };
        if old_a.exists() {
            if let Err(e) = fs::rename(&old_a, &new_a) {
                log::warn!("rename_folder: rename active {}: {e}", log_name(&old_a));
            }
        }

        let (old_d, new_d) = match &parent_rel {
            Some(r) => (
                dis_b.join(r).join(&folder.disk_name),
                dis_b.join(r).join(&new_disk_name),
            ),
            None => (dis_b.join(&folder.disk_name), dis_b.join(&new_disk_name)),
        };
        if old_d.exists() {
            if let Err(e) = fs::rename(&old_d, &new_d) {
                log::warn!("rename_folder: rename disabled {}: {e}", log_name(&old_d));
            }
        }
    }

    for f in state.folders.iter_mut() {
        if f.id == folder_id {
            f.display_name = display_name.to_string();
            f.disk_name = new_disk_name.clone();
        }
    }
    save_state(state_path, &state).map_err(save_error)?;
    Ok(())
}

pub fn delete_folder_op(
    game_path: &str,
    state_path: &Path,
    folder_id: &str,
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;
    let Some(folder) = state.folders.iter().find(|f| f.id == folder_id).cloned() else {
        return Ok(());
    };

    let target_parent_id = folder.parent_id.clone();
    let folder_rel = get_folder_path(&state.folders, Some(folder_id)).unwrap_or_default();
    let target_parent_rel = get_folder_path(&state.folders, target_parent_id.as_deref());

    let mods_b = mods_base(game_path, cfg.primary());
    let dis_b = disabled_base(game_path, cfg.primary());

    if let Some(r) = &target_parent_rel {
        if let Err(e) = fs::create_dir_all(mods_b.join(r)) {
            log::warn!("delete_folder: create_dir_all target: {e}");
        }
    }

    let mut max_p = {
        let f = state
            .folders
            .iter()
            .filter(|f| f.parent_id == target_parent_id && f.id != folder_id)
            .map(|f| f.priority)
            .max()
            .unwrap_or(0);
        let m = state
            .mods
            .iter()
            .filter(|m| m.folder_id == target_parent_id)
            .filter_map(|m| m.priority)
            .max()
            .unwrap_or(0);
        f.max(m)
    };

    for m in state.mods.iter_mut() {
        if m.folder_id.as_deref() != Some(folder_id) {
            continue;
        }
        max_p += 1;
        let target = cfg.target_for(m.location.as_deref());
        let new_filename = if target.priority_prefix_enabled() {
            apply_priority_prefix(&m.filename, max_p)
        } else {
            m.filename.clone()
        };
        let old = if m.enabled {
            active_mod_path(game_path, &m.filename, Some(&folder_rel), target)
        } else {
            disabled_mod_path(game_path, &m.filename, Some(&folder_rel), target)
        };
        let new = if m.enabled {
            active_mod_path(
                game_path,
                &new_filename,
                target_parent_rel.as_deref(),
                target,
            )
        } else {
            disabled_mod_path(
                game_path,
                &new_filename,
                target_parent_rel.as_deref(),
                target,
            )
        };
        if old.exists() {
            if let Err(e) = fs::rename(&old, &new) {
                log::warn!("delete_folder: move mod {}: {e}", log_name(&old));
            }
        }
        m.filename = new_filename;
        m.priority = Some(max_p);
        m.folder_id = target_parent_id.clone();
    }

    let child_ids: Vec<String> = state
        .folders
        .iter()
        .filter(|f| f.parent_id.as_deref() == Some(folder_id))
        .map(|f| f.id.clone())
        .collect();

    for cf_id in &child_ids {
        let cf = state
            .folders
            .iter()
            .find(|f| &f.id == cf_id)
            .cloned()
            .unwrap();
        max_p += 1;
        let new_disk = if cfg.primary().priority_prefix_enabled() {
            apply_priority_prefix(strip_priority_prefix(&cf.disk_name), max_p)
        } else {
            strip_priority_prefix(&cf.disk_name).to_string()
        };
        let old_rel = get_folder_path(&state.folders, Some(cf_id)).unwrap_or_default();

        let old_a = mods_b.join(&old_rel);
        let new_a = match &target_parent_rel {
            Some(r) => mods_b.join(r).join(&new_disk),
            None => mods_b.join(&new_disk),
        };
        if old_a.exists() {
            if let Err(e) = fs::rename(&old_a, &new_a) {
                log::warn!(
                    "delete_folder: move subfolder active {}: {e}",
                    log_name(&old_a)
                );
            }
        }

        let old_d = dis_b.join(&old_rel);
        let new_d = match &target_parent_rel {
            Some(r) => dis_b.join(r).join(&new_disk),
            None => dis_b.join(&new_disk),
        };
        if old_d.exists() {
            if let Err(e) = fs::rename(&old_d, &new_d) {
                log::warn!(
                    "delete_folder: move subfolder disabled {}: {e}",
                    log_name(&old_d)
                );
            }
        }

        for f in state.folders.iter_mut() {
            if &f.id == cf_id {
                f.parent_id = target_parent_id.clone();
                f.disk_name = new_disk.clone();
                f.priority = max_p;
            }
        }
    }

    let active_dir = mods_b.join(&folder_rel);
    if active_dir.exists() {
        if let Err(e) = fs::remove_dir_all(&active_dir) {
            log::warn!("delete_folder: remove_dir_all active {folder_rel:?}: {e}");
        }
    }
    let dis_dir = dis_b.join(&folder_rel);
    if dis_dir.exists() {
        if let Err(e) = fs::remove_dir_all(&dis_dir) {
            log::warn!("delete_folder: remove_dir_all disabled {folder_rel:?}: {e}");
        }
    }

    state.folders.retain(|f| f.id != folder_id);
    save_state(state_path, &state).map_err(save_error)?;
    Ok(())
}
