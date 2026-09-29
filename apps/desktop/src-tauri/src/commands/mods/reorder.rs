use super::engine::ModEngineConfig;
use super::moves::{exists, Moves};
use super::naming::{apply_priority_prefix, strip_priority_prefix};
use super::paths::{disabled_base, installed_mod_path, mods_base};
use super::state::{get_folder_path, read_state};
use super::types::{InstalledMod, TopLevelItem};
use std::fs;
use std::path::Path;

pub fn reorder_mods_in_folder_op(
    game_path: &str,
    state_path: &Path,
    folder_id: Option<&str>,
    ordered_uids: &[String],
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;
    let folder_rel = get_folder_path(&state.folders, folder_id);
    let total = ordered_uids.len() as i64;
    let mut moves = Moves::default();

    for m in state.mods.iter_mut() {
        if m.folder_id.as_deref() != folder_id {
            continue;
        }
        let Some(pos) = ordered_uids.iter().position(|u| u == &m.uid) else {
            continue;
        };
        let priority = total - pos as i64;
        m.priority = Some(priority);
        let target = cfg.target_for(m.location.as_deref());
        if !target.priority_prefix_enabled() {
            continue;
        }
        let filename = apply_priority_prefix(&m.filename, priority);
        let from = installed_mod_path(
            game_path,
            &m.filename,
            folder_rel.as_deref(),
            target,
            m.enabled,
        );
        if exists(&from)? {
            let to = installed_mod_path(
                game_path,
                &filename,
                folder_rel.as_deref(),
                target,
                m.enabled,
            );
            moves.unit(target, from, to);
        }
        m.filename = filename;
    }

    moves.run()?.save(state_path, &state)
}

pub fn move_mod_to_folder_op(
    game_path: &str,
    state_path: &Path,
    uid: &str,
    target_folder_id: Option<String>,
    target_position: usize,
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;
    let Some(moving) = state.mods.iter().find(|m| m.uid == uid).cloned() else {
        return Ok(());
    };
    if moving.location.is_some() {
        return Ok(());
    }

    let src_rel = get_folder_path(&state.folders, moving.folder_id.as_deref());
    let tgt_rel = get_folder_path(&state.folders, target_folder_id.as_deref());

    let mut target_mods: Vec<InstalledMod> = state
        .mods
        .iter()
        .filter(|m| m.folder_id == target_folder_id && m.uid != uid)
        .cloned()
        .collect();
    target_mods.sort_by_key(|m| std::cmp::Reverse(m.priority.unwrap_or(0)));
    let pos = target_position.min(target_mods.len());
    target_mods.insert(pos, moving.clone());
    let total = target_mods.len() as i64;

    let (active_dir, disabled_dir) = match &tgt_rel {
        Some(r) => (
            mods_base(game_path, cfg.primary()).join(r),
            disabled_base(game_path, cfg.primary()).join(r),
        ),
        None => (
            mods_base(game_path, cfg.primary()),
            disabled_base(game_path, cfg.primary()),
        ),
    };
    let destination_dir = if moving.enabled {
        active_dir
    } else {
        disabled_dir
    };
    fs::create_dir_all(&destination_dir)
        .map_err(|e| format!("could not prepare the destination folder: {e}"))?;

    let mut moves = Moves::default();
    for m in state.mods.iter_mut() {
        let Some(p) = target_mods.iter().position(|tm| tm.uid == m.uid) else {
            continue;
        };
        let priority = total - p as i64;
        let target = cfg.target_for(m.location.as_deref());
        let filename = if target.priority_prefix_enabled() {
            apply_priority_prefix(&m.filename, priority)
        } else {
            m.filename.clone()
        };
        let cur_rel = if m.uid == uid {
            src_rel.as_deref()
        } else {
            tgt_rel.as_deref()
        };
        let from = installed_mod_path(game_path, &m.filename, cur_rel, target, m.enabled);
        if exists(&from)? {
            let to =
                installed_mod_path(game_path, &filename, tgt_rel.as_deref(), target, m.enabled);
            moves.unit(target, from, to);
        }
        m.filename = filename;
        m.priority = Some(priority);
        m.folder_id = target_folder_id.clone();
    }

    moves.run()?.save(state_path, &state)
}

pub fn reorder_children_op(
    game_path: &str,
    state_path: &Path,
    parent_id: Option<&str>,
    items: &[TopLevelItem],
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;
    let parent_rel = get_folder_path(&state.folders, parent_id);
    let (mods_dir, dis_dir) = match &parent_rel {
        Some(r) => (
            mods_base(game_path, cfg.primary()).join(r),
            disabled_base(game_path, cfg.primary()).join(r),
        ),
        None => (
            mods_base(game_path, cfg.primary()),
            disabled_base(game_path, cfg.primary()),
        ),
    };
    let total = items.len() as i64;
    let folders_before = state.folders.clone();
    let mut moves = Moves::default();

    for (pos, item) in items.iter().enumerate() {
        let priority = total - pos as i64;
        match item {
            TopLevelItem::Folder { id } => {
                let Some(f) = state.folders.iter_mut().find(|f| &f.id == id) else {
                    continue;
                };
                let disk_name = if cfg.primary().priority_prefix_enabled() {
                    apply_priority_prefix(strip_priority_prefix(&f.disk_name), priority)
                } else {
                    strip_priority_prefix(&f.disk_name).to_string()
                };
                for base in [&mods_dir, &dis_dir] {
                    let from = base.join(&f.disk_name);
                    if exists(&from)? {
                        moves.path(from, base.join(&disk_name));
                    }
                }
                f.disk_name = disk_name;
                f.priority = priority;
            }
            TopLevelItem::Mod { id } => {
                let Some(m) = state.mods.iter_mut().find(|m| &m.uid == id) else {
                    continue;
                };
                m.priority = Some(priority);
                let target = cfg.target_for(m.location.as_deref());
                if !target.priority_prefix_enabled() {
                    continue;
                }
                let filename = apply_priority_prefix(&m.filename, priority);
                let rel = get_folder_path(&folders_before, m.folder_id.as_deref());
                let from =
                    installed_mod_path(game_path, &m.filename, rel.as_deref(), target, m.enabled);
                if exists(&from)? {
                    let to =
                        installed_mod_path(game_path, &filename, rel.as_deref(), target, m.enabled);
                    moves.unit(target, from, to);
                }
                m.filename = filename;
            }
        }
    }

    moves.run()?.save(state_path, &state)
}
