use super::engine::ModEngineConfig;
use super::moves::{exists, folder_targets, Moves};
use super::naming::log_name;
use super::naming::{apply_priority_prefix, strip_priority_prefix};
use super::paths::{active_mod_path, disabled_base, disabled_mod_path, mods_base};
use super::state::{get_folder_path, read_state_for_game, save_error, save_state};
use super::types::ModFolder;
use std::collections::HashMap;
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
    let mut state = read_state_for_game(game_path, state_path, cfg).map_err(|e| e.to_string())?;

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

    if parent_id.is_none() && slug.eq_ignore_ascii_case("disabled") {
        return Err("disabled is reserved for disabled mods".into());
    }

    if let Some(existing) = state
        .folders
        .iter()
        .find(|f| f.parent_id == parent_id && f.display_name == display_name)
    {
        return Ok(existing.clone());
    }

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
    let native = super::native_files::NativeGuard::load(game_path, cfg)?;
    native.check_path(&dir)?;
    native.check_state_path(state_path)?;
    let already_exists = dir.try_exists().map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let folder = ModFolder {
        id,
        disk_name,
        display_name: display_name.to_string(),
        priority,
        parent_id,
    };
    state.folders.push(folder.clone());
    let saved = native
        .check_state_path(state_path)
        .and_then(|()| save_state(state_path, &state).map_err(save_error));
    if let Err(failure) = saved {
        if !already_exists {
            fs::remove_dir(&dir).map_err(|error| {
                format!("{failure}. Could not remove the unsaved folder: {error}")
            })?;
        }
        return Err(failure);
    }
    Ok(folder)
}

pub fn move_folder_op(
    game_path: &str,
    state_path: &Path,
    folder_id: &str,
    target_parent_id: Option<String>,
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state_for_game(game_path, state_path, cfg).map_err(|e| e.to_string())?;
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

    let old_rel = get_folder_path(&state.folders, Some(folder_id)).unwrap_or_default();
    let targets = folder_targets(cfg, &state.folders, &state.mods, folder_id)?;

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
        .filter(|m| cfg.mod_target(m).tag == cfg.primary().tag)
        .filter_map(|m| m.priority)
        .max()
        .unwrap_or(0);
    let new_priority = max_f.max(max_m) + 1;
    let new_disk_name = if cfg.primary().priority_prefix_enabled() {
        apply_priority_prefix(strip_priority_prefix(&folder.disk_name), new_priority)
    } else {
        folder.disk_name.clone()
    };

    for f in state.folders.iter_mut() {
        if f.id == folder_id {
            f.parent_id = target_parent_id.clone();
            f.disk_name = new_disk_name.clone();
            f.priority = new_priority;
        }
    }
    let new_rel = get_folder_path(&state.folders, Some(folder_id)).unwrap_or_default();

    let mut moves = Moves::for_game(game_path, cfg)?;
    moves.folder(game_path, &targets, &old_rel, &new_rel)?;
    moves.run()?.save(state_path, &state)
}

pub fn rename_folder_op(
    game_path: &str,
    state_path: &Path,
    folder_id: &str,
    display_name: &str,
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state_for_game(game_path, state_path, cfg).map_err(|e| e.to_string())?;
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
    if folder.parent_id.is_none() && slug.eq_ignore_ascii_case("disabled") {
        return Err("disabled is reserved for disabled mods".into());
    }
    let new_disk_name = if cfg.primary().priority_prefix_enabled() {
        apply_priority_prefix(&slug, folder.priority)
    } else {
        slug
    };

    let old_rel =
        get_folder_path(&state.folders, Some(folder_id)).expect("the folder was found above");
    let targets = folder_targets(cfg, &state.folders, &state.mods, folder_id)?;
    let entry = state
        .folders
        .iter_mut()
        .find(|entry| entry.id == folder_id)
        .expect("the folder was found above");
    entry.display_name = display_name.to_string();
    entry.disk_name = new_disk_name;
    let new_rel =
        get_folder_path(&state.folders, Some(folder_id)).expect("the folder was found above");
    let mut moves = Moves::for_game(game_path, cfg)?;
    moves.folder(game_path, &targets, &old_rel, &new_rel)?;
    moves.run()?.save(state_path, &state)
}

pub fn delete_folder_op(
    game_path: &str,
    state_path: &Path,
    folder_id: &str,
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state_for_game(game_path, state_path, cfg).map_err(|e| e.to_string())?;
    let Some(folder) = state.folders.iter().find(|f| f.id == folder_id).cloned() else {
        return Ok(());
    };

    let target_parent_id = folder.parent_id.clone();
    let folder_rel = get_folder_path(&state.folders, Some(folder_id)).unwrap_or_default();
    let target_parent_rel = get_folder_path(&state.folders, target_parent_id.as_deref());

    let max_folder_priority = state
        .folders
        .iter()
        .filter(|f| f.parent_id == target_parent_id && f.id != folder_id)
        .map(|f| f.priority)
        .max()
        .unwrap_or(0);
    let mut target_priorities = HashMap::new();
    target_priorities.insert(cfg.primary().tag, max_folder_priority);
    for m in state
        .mods
        .iter()
        .filter(|m| m.folder_id == target_parent_id)
    {
        let priority = target_priorities.entry(cfg.mod_target(m).tag).or_insert(0);
        *priority = (*priority).max(m.priority.unwrap_or(0));
    }

    let targets = folder_targets(cfg, &state.folders, &state.mods, folder_id)?;
    let children: Vec<_> = state
        .folders
        .iter()
        .filter(|f| f.parent_id.as_deref() == Some(folder_id))
        .map(|f| {
            let mut child_targets = folder_targets(cfg, &state.folders, &state.mods, &f.id)?;
            child_targets.retain(|target| targets.iter().any(|parent| parent.tag == target.tag));
            Ok((f.id.clone(), child_targets))
        })
        .collect::<Result<_, String>>()?;
    let mut moves = Moves::for_game(game_path, cfg)?;

    for m in state.mods.iter_mut() {
        if m.folder_id.as_deref() != Some(folder_id) {
            continue;
        }
        let target = cfg.mod_target(m);
        let priority = target_priorities.entry(target.tag).or_insert(0);
        *priority += 1;
        let new_filename = if target.priority_prefix_enabled() {
            apply_priority_prefix(&m.filename, *priority)
        } else {
            m.filename.clone()
        };
        for (old, new) in [
            (
                active_mod_path(game_path, &m.filename, Some(&folder_rel), target),
                active_mod_path(
                    game_path,
                    &new_filename,
                    target_parent_rel.as_deref(),
                    target,
                ),
            ),
            (
                disabled_mod_path(game_path, &m.filename, Some(&folder_rel), target),
                disabled_mod_path(
                    game_path,
                    &new_filename,
                    target_parent_rel.as_deref(),
                    target,
                ),
            ),
        ] {
            if !exists(&old)? {
                continue;
            }
            moves.unit(target, old, new);
        }
        m.filename = new_filename;
        m.priority = Some(*priority);
        m.folder_id = target_parent_id.clone();
    }

    for (cf_id, child_targets) in &children {
        let cf = state
            .folders
            .iter()
            .find(|f| &f.id == cf_id)
            .cloned()
            .unwrap();
        let priority = target_priorities
            .get_mut(cfg.primary().tag)
            .expect("the primary target priority is initialized above");
        *priority += 1;
        let new_priority = *priority;
        let new_disk = if cfg.primary().priority_prefix_enabled() {
            apply_priority_prefix(strip_priority_prefix(&cf.disk_name), new_priority)
        } else {
            cf.disk_name.clone()
        };
        let old_rel = get_folder_path(&state.folders, Some(cf_id)).unwrap_or_default();

        let new_rel = target_parent_rel
            .as_ref()
            .map_or_else(|| new_disk.clone(), |parent| format!("{parent}/{new_disk}"));
        moves.folder(game_path, child_targets, &old_rel, &new_rel)?;

        for f in state.folders.iter_mut() {
            if &f.id == cf_id {
                f.parent_id = target_parent_id.clone();
                f.disk_name = new_disk.clone();
                f.priority = new_priority;
            }
        }
    }

    let native = super::native_files::NativeGuard::load(game_path, cfg)?;
    native.check_state_path(state_path)?;
    let applied = moves.run()?;
    state.folders.retain(|f| f.id != folder_id);
    applied.save(state_path, &state)?;

    if let Err(error) = native.verify_unchanged() {
        log::warn!("delete_folder: kept the empty folders: {error}");
        return Ok(());
    }
    for base in targets.iter().flat_map(|target| {
        [
            mods_base(game_path, target),
            disabled_base(game_path, target),
        ]
    }) {
        let dir = base.join(&folder_rel);
        if let Err(error) = native.check_tree(&dir) {
            log::warn!("delete_folder: kept {}: {error}", log_name(&dir));
            continue;
        }
        remove_emptied(&dir);
    }
    Ok(())
}

/// Removes dir and the empty folders under it. Anything else Modrex does not track, such as a
/// file the user put there, keeps its folder in place.
fn remove_emptied(dir: &Path) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("delete_folder: read {}: {e}", log_name(dir));
            return;
        }
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            remove_emptied(&entry.path());
        }
    }
    if let Err(e) = fs::remove_dir(dir) {
        log::info!("delete_folder: kept {}: {e}", log_name(dir));
    }
}
