use super::engine::ModEngineConfig;
use super::moves::{exists, Moves};
use super::naming::{apply_priority_prefix, strip_priority_prefix};
use super::paths::{disabled_base, installed_mod_path, mods_base};
use super::state::{get_folder_path, read_state_for_game};
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
    let mut state = read_state_for_game(game_path, state_path, cfg).map_err(|e| e.to_string())?;
    let folder_rel = get_folder_path(&state.folders, folder_id);
    let ordered_mods: Vec<_> = ordered_uids
        .iter()
        .filter_map(|uid| {
            state
                .mods
                .iter()
                .find(|m| &m.uid == uid && m.folder_id.as_deref() == folder_id)
        })
        .map(|m| (m.uid.clone(), cfg.mod_target(m).tag.to_string()))
        .collect();
    let mut moves = Moves::for_game(game_path, cfg)?;

    for m in state.mods.iter_mut() {
        if m.folder_id.as_deref() != folder_id {
            continue;
        }
        let location = cfg.mod_target(m).tag;
        let mut target_order = ordered_mods.iter().filter(|(_, tag)| tag == location);
        let total = target_order.clone().count() as i64;
        let Some(pos) = target_order.position(|(uid, _)| uid == &m.uid) else {
            continue;
        };
        let priority = total - pos as i64;
        m.priority = Some(priority);
        let target = cfg.mod_target(m);
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
    let mut state = read_state_for_game(game_path, state_path, cfg).map_err(|e| e.to_string())?;
    let Some(moving) = state.mods.iter().find(|m| m.uid == uid).cloned() else {
        return Ok(());
    };
    if moving
        .location
        .as_deref()
        .is_some_and(|tag| tag.starts_with("host:"))
        || cfg.mod_target(&moving).tag != cfg.primary().tag
    {
        return Ok(());
    }

    let src_rel = get_folder_path(&state.folders, moving.folder_id.as_deref());
    let tgt_rel = get_folder_path(&state.folders, target_folder_id.as_deref());

    let mut target_mods: Vec<InstalledMod> = state
        .mods
        .iter()
        .filter(|m| {
            m.folder_id == target_folder_id
                && m.uid != uid
                && !m
                    .location
                    .as_deref()
                    .is_some_and(|tag| tag.starts_with("host:"))
                && cfg.mod_target(m).tag == cfg.mod_target(&moving).tag
        })
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
    let native = super::native_files::NativeGuard::load(game_path, cfg)?;
    native.check_path(&destination_dir)?;
    native.verify_unchanged()?;
    fs::create_dir_all(&destination_dir)
        .map_err(|e| format!("could not prepare the destination folder: {e}"))?;

    let mut moves = Moves::with_native_guard(native);
    for m in state.mods.iter_mut() {
        let Some(p) = target_mods.iter().position(|tm| tm.uid == m.uid) else {
            continue;
        };
        let priority = total - p as i64;
        let target = cfg.mod_target(m);
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
    let mut state = read_state_for_game(game_path, state_path, cfg).map_err(|e| e.to_string())?;
    let locations: Vec<_> = items
        .iter()
        .map(|item| match item {
            TopLevelItem::Folder { .. } => Some(cfg.primary().tag.to_string()),
            TopLevelItem::Mod { id } => state
                .mods
                .iter()
                .find(|m| &m.uid == id && m.folder_id.as_deref() == parent_id)
                .map(|m| cfg.mod_target(m).tag.to_string()),
        })
        .collect();
    let folders_before = state.folders.clone();
    let mut moves = Moves::for_game(game_path, cfg)?;

    for (pos, item) in items.iter().enumerate() {
        let priority = locations[pos..]
            .iter()
            .filter(|tag| tag.as_deref() == Some(cfg.primary().tag))
            .count() as i64;
        match item {
            TopLevelItem::Folder { id } => {
                let Some(f) = state
                    .folders
                    .iter_mut()
                    .find(|f| &f.id == id && f.parent_id.as_deref() == parent_id)
                else {
                    continue;
                };
                let disk_name = if cfg.primary().priority_prefix_enabled() {
                    apply_priority_prefix(strip_priority_prefix(&f.disk_name), priority)
                } else {
                    f.disk_name.clone()
                };
                let from_rel =
                    get_folder_path(&folders_before, Some(id)).expect("the folder was found above");
                let parent_rel = get_folder_path(&folders_before, parent_id);
                let to_rel = parent_rel.map_or_else(
                    || disk_name.clone(),
                    |parent| format!("{parent}/{disk_name}"),
                );
                let targets = super::moves::folder_targets(cfg, &folders_before, &state.mods, id)?;
                moves.folder(game_path, &targets, &from_rel, &to_rel)?;
                f.disk_name = disk_name;
                f.priority = priority;
            }
            TopLevelItem::Mod { id } => {
                let Some(m) = state
                    .mods
                    .iter_mut()
                    .find(|m| &m.uid == id && m.folder_id.as_deref() == parent_id)
                else {
                    continue;
                };
                let location = cfg.mod_target(m).tag;
                let priority = locations[pos..]
                    .iter()
                    .filter(|tag| tag.as_deref() == Some(location))
                    .count() as i64;
                m.priority = Some(priority);
                let target = cfg.mod_target(m);
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
