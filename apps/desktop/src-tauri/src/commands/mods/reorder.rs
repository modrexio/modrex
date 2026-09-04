use super::engine::ModEngineConfig;
use super::naming::log_name;
use super::naming::{apply_priority_prefix, strip_priority_prefix};
use super::paths::{active_mod_path, disabled_base, disabled_mod_path, mods_base};
use super::state::{get_folder_path, read_state, save_state};
use super::types::{InstalledMod, TopLevelItem};
use std::fs;
use std::path::Path;

pub fn reorder_mods_in_folder_op(
    game_path: &str,
    state_path: &Path,
    folder_id: Option<&str>,
    ordered_uids: &[String],
    cfg: &ModEngineConfig,
) {
    let mut state = read_state(state_path);
    let folder_rel = get_folder_path(&state.folders, folder_id);
    let total = ordered_uids.len() as i64;

    for m in state.mods.iter_mut() {
        if m.folder_id.as_deref() != folder_id {
            continue;
        }
        let Some(pos) = ordered_uids.iter().position(|u| u == &m.uid) else {
            continue;
        };
        let priority = total - pos as i64;
        let target = cfg.target_for(m.location.as_deref());
        let new_filename = if target.priority_prefix_enabled() {
            apply_priority_prefix(&m.filename, priority)
        } else {
            m.filename.clone()
        };
        if new_filename != m.filename {
            let old = if m.enabled {
                active_mod_path(game_path, &m.filename, folder_rel.as_deref(), target)
            } else {
                disabled_mod_path(game_path, &m.filename, folder_rel.as_deref(), target)
            };
            let new = if m.enabled {
                active_mod_path(game_path, &new_filename, folder_rel.as_deref(), target)
            } else {
                disabled_mod_path(game_path, &new_filename, folder_rel.as_deref(), target)
            };
            if old.exists() {
                if let Err(e) = fs::rename(&old, &new) {
                    log::warn!("reorder: rename {}: {e}", log_name(&old));
                }
            }
            m.filename = new_filename;
        }
        m.priority = Some(priority);
    }

    save_state(state_path, &state);
}

pub fn move_mod_to_folder_op(
    game_path: &str,
    state_path: &Path,
    uid: &str,
    target_folder_id: Option<String>,
    target_position: usize,
    cfg: &ModEngineConfig,
) {
    let mut state = read_state(state_path);
    let Some(moving) = state.mods.iter().find(|m| m.uid == uid).cloned() else {
        return;
    };
    if moving.location.is_some() {
        return;
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

    if let Some(r) = &tgt_rel {
        if let Err(e) = fs::create_dir_all(mods_base(game_path, cfg.primary()).join(r)) {
            log::warn!("move_to_folder: create_dir_all active: {e}");
        }
    }
    if !moving.enabled {
        let dis = match &tgt_rel {
            Some(r) => disabled_base(game_path, cfg.primary()).join(r),
            None => disabled_base(game_path, cfg.primary()),
        };
        if let Err(e) = fs::create_dir_all(&dis) {
            log::warn!("move_to_folder: create_dir_all disabled: {e}");
        }
    }

    for m in state.mods.iter_mut() {
        let Some(p) = target_mods.iter().position(|tm| tm.uid == m.uid) else {
            continue;
        };
        let priority = total - p as i64;
        let target = cfg.target_for(m.location.as_deref());
        let new_filename = if target.priority_prefix_enabled() {
            apply_priority_prefix(&m.filename, priority)
        } else {
            m.filename.clone()
        };
        let cur_rel = if m.uid == uid {
            src_rel.clone()
        } else {
            tgt_rel.clone()
        };

        if new_filename != m.filename || (m.uid == uid && src_rel != tgt_rel) {
            let old = if m.enabled {
                active_mod_path(game_path, &m.filename, cur_rel.as_deref(), target)
            } else {
                disabled_mod_path(game_path, &m.filename, cur_rel.as_deref(), target)
            };
            let new = if m.enabled {
                active_mod_path(game_path, &new_filename, tgt_rel.as_deref(), target)
            } else {
                disabled_mod_path(game_path, &new_filename, tgt_rel.as_deref(), target)
            };
            if old.exists() {
                if let Err(e) = fs::rename(&old, &new) {
                    log::warn!("move_to_folder: rename {}: {e}", log_name(&old));
                }
            }
        }

        m.filename = new_filename;
        m.priority = Some(priority);
        m.folder_id = target_folder_id.clone();
    }

    save_state(state_path, &state);
}

pub fn reorder_children_op(
    game_path: &str,
    state_path: &Path,
    parent_id: Option<&str>,
    items: &[TopLevelItem],
    cfg: &ModEngineConfig,
) {
    let mut state = read_state(state_path);
    let parent_rel = get_folder_path(&state.folders, parent_id);
    let mods_dir = match &parent_rel {
        Some(r) => mods_base(game_path, cfg.primary()).join(r),
        None => mods_base(game_path, cfg.primary()),
    };
    let dis_dir = match &parent_rel {
        Some(r) => disabled_base(game_path, cfg.primary()).join(r),
        None => disabled_base(game_path, cfg.primary()),
    };
    let total = items.len() as i64;

    struct FolderRename {
        id: String,
        old: String,
        new: String,
    }
    let folder_renames: Vec<FolderRename> = items
        .iter()
        .enumerate()
        .filter_map(|(pos, item)| {
            let TopLevelItem::Folder { id } = item else {
                return None;
            };
            let f = state.folders.iter().find(|f| &f.id == id)?;
            let priority = total - pos as i64;
            let new = if cfg.primary().priority_prefix_enabled() {
                apply_priority_prefix(strip_priority_prefix(&f.disk_name), priority)
            } else {
                strip_priority_prefix(&f.disk_name).to_string()
            };
            if new != f.disk_name {
                Some(FolderRename {
                    id: id.clone(),
                    old: f.disk_name.clone(),
                    new,
                })
            } else {
                None
            }
        })
        .collect();

    struct ModRename {
        old: String,
        new: String,
        rel: Option<String>,
        enabled: bool,
        location: Option<String>,
    }
    let mod_renames: Vec<ModRename> = items
        .iter()
        .enumerate()
        .filter_map(|(pos, item)| {
            let TopLevelItem::Mod { id } = item else {
                return None;
            };
            let m = state.mods.iter().find(|m| &m.uid == id)?;
            let priority = total - pos as i64;
            let target = cfg.target_for(m.location.as_deref());
            let new = if target.priority_prefix_enabled() {
                apply_priority_prefix(&m.filename, priority)
            } else {
                m.filename.clone()
            };
            if new == m.filename {
                return None;
            }
            let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
            Some(ModRename {
                old: m.filename.clone(),
                new,
                rel,
                enabled: m.enabled,
                location: m.location.clone(),
            })
        })
        .collect();

    for r in &folder_renames {
        let tmp = format!("__modrex_tmp_{}", r.id);
        let a = mods_dir.join(&r.old);
        if a.exists() {
            if let Err(e) = fs::rename(&a, mods_dir.join(&tmp)) {
                log::warn!("reorder_children: tmp rename active {a:?}: {e}");
            }
        }
        let d = dis_dir.join(&r.old);
        if d.exists() {
            if let Err(e) = fs::rename(&d, dis_dir.join(&tmp)) {
                log::warn!("reorder_children: tmp rename disabled {d:?}: {e}");
            }
        }
    }
    for r in &folder_renames {
        let tmp = format!("__modrex_tmp_{}", r.id);
        let a = mods_dir.join(&tmp);
        if a.exists() {
            if let Err(e) = fs::rename(&a, mods_dir.join(&r.new)) {
                log::warn!("reorder_children: final rename active {a:?}: {e}");
            }
        }
        let d = dis_dir.join(&tmp);
        if d.exists() {
            if let Err(e) = fs::rename(&d, dis_dir.join(&r.new)) {
                log::warn!("reorder_children: final rename disabled {d:?}: {e}");
            }
        }
    }

    for r in &mod_renames {
        let target = cfg.target_for(r.location.as_deref());
        let old_path = if r.enabled {
            active_mod_path(game_path, &r.old, r.rel.as_deref(), target)
        } else {
            disabled_mod_path(game_path, &r.old, r.rel.as_deref(), target)
        };
        let new_path = if r.enabled {
            active_mod_path(game_path, &r.new, r.rel.as_deref(), target)
        } else {
            disabled_mod_path(game_path, &r.new, r.rel.as_deref(), target)
        };
        if old_path.exists() {
            if let Err(e) = fs::rename(&old_path, &new_path) {
                log::warn!("reorder_children: mod rename {}: {e}", log_name(&old_path));
            }
        }
    }

    for (pos, item) in items.iter().enumerate() {
        let priority = total - pos as i64;
        match item {
            TopLevelItem::Folder { id } => {
                if let Some(f) = state.folders.iter_mut().find(|f| &f.id == id) {
                    f.disk_name = if cfg.primary().priority_prefix_enabled() {
                        apply_priority_prefix(strip_priority_prefix(&f.disk_name), priority)
                    } else {
                        strip_priority_prefix(&f.disk_name).to_string()
                    };
                    f.priority = priority;
                }
            }
            TopLevelItem::Mod { id } => {
                if let Some(m) = state.mods.iter_mut().find(|m| &m.uid == id) {
                    let target = cfg.target_for(m.location.as_deref());
                    if target.priority_prefix_enabled() {
                        m.filename = apply_priority_prefix(&m.filename, priority);
                    }
                    m.priority = Some(priority);
                }
            }
        }
    }

    save_state(state_path, &state);
}
