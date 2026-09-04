use super::crimeboss_settings;
use super::engine::{Activation, ModEngineConfig, ModUnit, ScanTarget};
use super::host_mods::{host_target_by_id, parse_host_location};
use super::naming::log_name;
use super::naming::{apply_priority_prefix, mod_folder_name, sidecar_path, strip_priority_prefix};
use super::paths::{
    active_mod_path, disabled_base, disabled_mod_path, host_pack_dir, host_pack_disabled_dir,
    mods_base, resolve_host_mod_dir,
};
use super::state::{get_folder_path, read_state, save_state};
use super::types::{InstalledMod, ModsState};
use super::ue4ss_modstxt;
use super::zip::extract_dir_entry;
use chrono::Utc;
use std::fs;
use std::path::Path;
use uuid::Uuid;

fn is_host_pack(m: &InstalledMod) -> bool {
    m.location
        .as_deref()
        .is_some_and(|l| l.starts_with("host:"))
}

/// Installs a host-mod content pack (e.g. a Menu Backgrounds set) into the host mod's folder
/// at <host dir>/<subpath>/<set name>/ and records it in state so it can be managed. Returns
/// a HOST_MOD_MISSING: error when the host mod is not installed.
pub fn install_host_pack_op(
    game_path: &str,
    state_path: &Path,
    zip: &Path,
    entry_name: &str,
    mod_data: InstalledMod,
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let (host_id, host_subpath) = mod_data
        .location
        .as_deref()
        .and_then(parse_host_location)
        .ok_or("install_host_pack: mod_data.location is not a host location")?;
    let mut state = read_state(state_path);
    let host_dir = resolve_host_mod_dir(game_path, cfg, &state.mods, &state.folders, host_id)
        .ok_or_else(|| {
            let name = host_target_by_id(host_id)
                .map(|h| h.host_name)
                .unwrap_or("");
            format!(
                "HOST_MOD_MISSING:{}",
                serde_json::json!({ "hostModId": host_id, "hostName": name })
            )
        })?;

    let set_name = Path::new(entry_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("set")
        .to_string();
    let mut dest = host_dir;
    for seg in host_subpath.split('/').filter(|s| !s.is_empty()) {
        dest = dest.join(seg);
    }
    let dest = dest.join(&set_name);
    if dest.exists() {
        let _ = fs::remove_dir_all(&dest); // clean reinstall
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    extract_dir_entry(zip, entry_name, &dest)?;

    let uid = format!("{}_{}", mod_data.file_id.unwrap_or(0), set_name);
    state.mods.retain(|x| x.uid != uid);
    state.mods.push(InstalledMod {
        uid,
        filename: set_name,
        enabled: true,
        folder_id: None,
        installed_at: Utc::now().to_rfc3339(),
        ..mod_data
    });
    save_state(
        state_path,
        &ModsState {
            folders: state.folders,
            mods: state.mods,
        },
    );
    Ok(())
}

pub fn install_mod_from_path(
    game_path: &str,
    state_path: &Path,
    mod_data: InstalledMod,
    source: &Path,
    folder_id: Option<String>,
    cfg: &ModEngineConfig,
    target: &ScanTarget,
) -> Result<(), String> {
    // BeardLib (mod_overrides) scans one level deep, so nested dirs are never loaded.
    let folder_id = if std::ptr::eq(target, cfg.primary()) {
        folder_id
    } else {
        None
    };
    let state = read_state(state_path);
    let folder_rel = get_folder_path(&state.folders, folder_id.as_deref());

    let dest_dir = match &folder_rel {
        Some(rel) => mods_base(game_path, target).join(rel),
        None => mods_base(game_path, target),
    };
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let existing = state.mods.iter().find(|m| m.uid == mod_data.uid).cloned();

    let max_mod = state
        .mods
        .iter()
        .filter(|m| m.folder_id == folder_id)
        .filter_map(|m| m.priority)
        .max()
        .unwrap_or(0);
    let max_folder = state
        .folders
        .iter()
        .filter(|f| f.parent_id == folder_id)
        .map(|f| f.priority)
        .max()
        .unwrap_or(0);
    let priority = existing
        .as_ref()
        .and_then(|e| e.priority)
        .unwrap_or(max_mod.max(max_folder) + 1);
    let filename = if target.priority_prefix_enabled() {
        apply_priority_prefix(&mod_data.filename, priority)
    } else {
        mod_data.filename.clone()
    };

    let dest = active_mod_path(game_path, &filename, folder_rel.as_deref(), target);
    match &target.unit {
        ModUnit::File { extension, .. } => {
            copy_file_with_sidecars(source, &dest, extension, target.companions)?;
        }
        ModUnit::Directory { .. } => {
            copy_dir_all(source, &dest)?;
        }
    }

    if let Some(ref ex) = existing {
        let ex_rel = get_folder_path(&state.folders, ex.folder_id.as_deref());
        let old = if ex.enabled {
            active_mod_path(game_path, &ex.filename, ex_rel.as_deref(), target)
        } else {
            disabled_mod_path(game_path, &ex.filename, ex_rel.as_deref(), target)
        };
        let new_active = active_mod_path(game_path, &filename, folder_rel.as_deref(), target);
        if old != new_active && old.exists() {
            match &target.unit {
                ModUnit::File { extension, .. } => {
                    if let Err(e) = remove_file_with_sidecars(&old, extension, target.companions) {
                        log::warn!("install: remove old pak {}: {e}", log_name(&old));
                    }
                }
                ModUnit::Directory { .. } => {
                    if let Err(e) = fs::remove_dir_all(&old) {
                        log::warn!("install: remove old mod dir {}: {e}", log_name(&old));
                    }
                }
            }
        }
    }

    let mut new_mods: Vec<InstalledMod> = state
        .mods
        .into_iter()
        .filter(|m| {
            m.uid != mod_data.uid && existing.as_ref().map(|e| m.uid != e.uid).unwrap_or(true)
        })
        .collect();

    let location = (!std::ptr::eq(target, cfg.primary())).then(|| target.tag.to_string());
    log::info!(
        "install: {} ({}) -> {} [{}]",
        mod_data.name,
        mod_data.uid,
        target.tag,
        filename
    );
    new_mods.push(InstalledMod {
        filename,
        priority: Some(priority),
        folder_id,
        enabled: true,
        location,
        installed_at: Utc::now().to_rfc3339(),
        ..mod_data
    });

    save_state(
        state_path,
        &ModsState {
            folders: state.folders,
            mods: new_mods,
        },
    );
    Ok(())
}

/// Toggles a Crime Boss mod between the primary mods/<name>/ ModKit skeleton and the legacy
/// ~mods flat-pak target. No file content tells Modrex whether a .pak was built by the
/// official ModKit (safe for Mods/, gets the Data Table additive merge) or is a loose pak
/// needing ~mods with no merge semantics, so this is a user-initiated override rather than
/// something inferred. Crime Boss only: other games' secondary targets are not alternate
/// shapes of the same content, so there is nothing to toggle there.
pub fn move_crimeboss_mod_target_op(
    game_path: &str,
    state_path: &Path,
    uid: &str,
    cfg: &ModEngineConfig,
    launcher: Option<&str>,
) -> Result<(), String> {
    let state = read_state(state_path);
    let m = state
        .mods
        .iter()
        .find(|m| m.uid == uid)
        .cloned()
        .ok_or_else(|| "mod not found".to_string())?;

    let old_target = cfg.target_for(m.location.as_deref());
    let new_target = if std::ptr::eq(old_target, cfg.primary()) {
        cfg.targets
            .iter()
            .find(|t| t.tag == "paks")
            .ok_or_else(|| "no legacy paks target for this game".to_string())?
    } else {
        cfg.primary()
    };

    let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
    let old_path = if m.enabled {
        active_mod_path(game_path, &m.filename, rel.as_deref(), old_target)
    } else {
        disabled_mod_path(game_path, &m.filename, rel.as_deref(), old_target)
    };
    if !old_path.exists() {
        return Err("mod files not found on disk".to_string());
    }

    // Builds the new target's on-disk shape in a temp location first, either unwrapping the
    // skeleton to a flat pak or wrapping a flat pak into one, so install_mod_from_path can
    // write it exactly like a normal install.
    let (source, new_filename, tmp_root) = match (&old_target.unit, &new_target.unit) {
        (ModUnit::Directory { .. }, ModUnit::File { extension, .. }) => {
            let pak_dir = old_path
                .join("Content")
                .join("Paks")
                .join("WindowsNoEditor");
            let pak = crimeboss_settings::find_content_file_in_dir(&pak_dir, extension)
                .ok_or_else(|| format!("no .{extension} found inside this mod's folder"))?;
            let filename = pak
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| "that mod's file has no usable name".to_string())?
                .to_string();
            let tmp_root = std::env::temp_dir().join(format!("modrex-move-{}", Uuid::new_v4()));
            fs::create_dir_all(&tmp_root).map_err(|e| e.to_string())?;
            let dest = tmp_root.join(&filename);
            copy_file_with_sidecars(&pak, &dest, extension, new_target.companions)?;
            (dest, filename, tmp_root)
        }
        (ModUnit::File { extension, .. }, ModUnit::Directory { .. }) => {
            let canonical = strip_priority_prefix(&m.filename).to_string();
            let tmp_root = std::env::temp_dir().join(format!("modrex-move-{}", Uuid::new_v4()));
            let skeleton_dir = tmp_root
                .join("Content")
                .join("Paks")
                .join("WindowsNoEditor");
            fs::create_dir_all(&skeleton_dir).map_err(|e| e.to_string())?;
            copy_file_with_sidecars(
                &old_path,
                &skeleton_dir.join(&canonical),
                extension,
                old_target.companions,
            )?;
            (tmp_root.clone(), mod_folder_name(&m.name), tmp_root)
        }
        _ => return Err("unsupported target shapes for this move".to_string()),
    };

    let mod_data = InstalledMod {
        filename: new_filename,
        ..m.clone()
    };
    let result = install_mod_from_path(
        game_path,
        state_path,
        mod_data,
        &source,
        m.folder_id.clone(),
        cfg,
        new_target,
    );
    let _ = fs::remove_dir_all(&tmp_root);
    result?;

    // install_mod_from_path always installs as enabled, being written for fresh installs, so
    // restore the disabled state here if the mod wasn't active before the move.
    if !m.enabled {
        disable_mod_op(game_path, state_path, uid, cfg, launcher);
    }

    // install_mod_from_path's own "existing" cleanup computes the old path inside the new
    // target's directory using the old filename, which never matches a cross-target move. The
    // real old location, under the old target's directory, is removed here instead.
    match &old_target.unit {
        ModUnit::File { extension, .. } => {
            let _ = remove_file_with_sidecars(&old_path, extension, old_target.companions);
        }
        ModUnit::Directory { .. } => {
            let _ = fs::remove_dir_all(&old_path);
        }
    }

    Ok(())
}

pub fn uninstall_mod_op(game_path: &str, state_path: &Path, uid: &str, cfg: &ModEngineConfig) {
    let mut state = read_state(state_path);
    let Some(m) = state.mods.iter().find(|m| m.uid == uid).cloned() else {
        return;
    };
    log::info!("uninstall: {} ({})", m.name, m.uid);
    // Host packs live inside another mod's folder or in the disabled area. Remove either.
    if is_host_pack(&m) {
        for p in [
            host_pack_dir(game_path, cfg, &state.mods, &state.folders, &m),
            host_pack_disabled_dir(game_path, cfg, &m),
        ]
        .into_iter()
        .flatten()
        {
            if p.exists() {
                if let Err(e) = fs::remove_dir_all(&p) {
                    log::warn!("uninstall host pack: remove {p:?}: {e}");
                }
            }
        }
        state.mods.retain(|x| x.uid != uid);
        save_state(state_path, &state);
        return;
    }
    let target = cfg.target_for(m.location.as_deref());
    let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
    let path = if m.enabled {
        active_mod_path(game_path, &m.filename, rel.as_deref(), target)
    } else {
        disabled_mod_path(game_path, &m.filename, rel.as_deref(), target)
    };
    if path.exists() {
        match &target.unit {
            ModUnit::File { extension, .. } => {
                if let Err(e) = remove_file_with_sidecars(&path, extension, target.companions) {
                    log::warn!("uninstall: remove {}: {e}", log_name(&path));
                }
            }
            ModUnit::Directory { .. } => {
                if let Err(e) = fs::remove_dir_all(&path) {
                    log::warn!("uninstall: remove dir {}: {e}", log_name(&path));
                }
            }
        }
    }
    state.mods.retain(|m| m.uid != uid);
    save_state(state_path, &state);
}

pub fn enable_mod_op(
    game_path: &str,
    state_path: &Path,
    uid: &str,
    cfg: &ModEngineConfig,
    launcher: Option<&str>,
) {
    let mut state = read_state(state_path);
    let Some(m) = state
        .mods
        .iter()
        .find(|m| m.uid == uid && !m.enabled)
        .cloned()
    else {
        return;
    };
    log::info!("enable: {} ({})", m.name, m.uid);
    // Host packs move back from our disabled area into the host mod's folder.
    if is_host_pack(&m) {
        move_host_pack(game_path, state_path, &mut state, &m, uid, cfg, true);
        return;
    }
    let target = cfg.target_for(m.location.as_deref());
    if target.enabled_state == Activation::Ue4ssModsTxt {
        let mods_txt = mods_base(game_path, target).join("mods.txt");
        ue4ss_modstxt::sync_enabled(&mods_txt, &m.filename, true);
        for m in state.mods.iter_mut() {
            if m.uid == uid {
                m.enabled = true;
            }
        }
        save_state(state_path, &state);
        return;
    }
    let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
    if let Some(r) = &rel {
        if let Err(e) = fs::create_dir_all(mods_base(game_path, target).join(r)) {
            log::warn!("enable_mod: create_dir_all: {e}");
        }
    }
    let from = disabled_mod_path(game_path, &m.filename, rel.as_deref(), target);
    let to = active_mod_path(game_path, &m.filename, rel.as_deref(), target);
    // The game's own UGC mod-loader, not this file move, is what actually controls whether a
    // Crime Boss mod is active. See crimeboss_settings.rs.
    // resync_crimeboss_enabled_flags flips m.enabled without moving files, so from may not
    // exist. Fall back to to when deriving the settings path from the pak.
    if cfg.game_id == "cb" {
        let cb_path = if from.exists() { &from } else { &to };
        crimeboss_settings::sync_enabled(cb_path, target.is_directory_unit(), launcher, true);
    }
    if from.exists() {
        let renamed = match &target.unit {
            ModUnit::File { extension, .. } => {
                rename_with_sidecars(&from, &to, extension, target.companions)
            }
            ModUnit::Directory { .. } => fs::rename(&from, &to),
        };
        if let Err(e) = renamed {
            log::warn!("enable_mod: rename {from:?} -> {to:?}: {e}");
        }
    }
    for m in state.mods.iter_mut() {
        if m.uid == uid {
            m.enabled = true;
        }
    }
    save_state(state_path, &state);
}

/// Moves a host pack between the host mod's folder and Modrex's disabled area, then flips its
/// enabled flag and persists. enable = true restores it into the host, false disables it.
fn move_host_pack(
    game_path: &str,
    state_path: &Path,
    state: &mut ModsState,
    m: &InstalledMod,
    uid: &str,
    cfg: &ModEngineConfig,
    enable: bool,
) {
    let active = host_pack_dir(game_path, cfg, &state.mods, &state.folders, m);
    let disabled = host_pack_disabled_dir(game_path, cfg, m);
    if let (Some(active), Some(disabled)) = (active, disabled) {
        let (from, to) = if enable {
            (disabled, active)
        } else {
            (active, disabled)
        };
        if from.exists() {
            if let Some(parent) = to.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Err(e) = fs::rename(&from, &to) {
                log::warn!("move host pack {from:?} -> {to:?}: {e}");
            }
        }
    }
    for x in state.mods.iter_mut() {
        if x.uid == uid {
            x.enabled = enable;
        }
    }
    save_state(state_path, state);
}

pub fn disable_mod_op(
    game_path: &str,
    state_path: &Path,
    uid: &str,
    cfg: &ModEngineConfig,
    launcher: Option<&str>,
) {
    let mut state = read_state(state_path);
    let Some(m) = state
        .mods
        .iter()
        .find(|m| m.uid == uid && m.enabled)
        .cloned()
    else {
        return;
    };
    log::info!("disable: {} ({})", m.name, m.uid);
    // Host packs move out of the host mod's folder into our disabled area.
    if is_host_pack(&m) {
        move_host_pack(game_path, state_path, &mut state, &m, uid, cfg, false);
        return;
    }
    let target = cfg.target_for(m.location.as_deref());
    if target.enabled_state == Activation::Ue4ssModsTxt {
        let mods_txt = mods_base(game_path, target).join("mods.txt");
        ue4ss_modstxt::sync_enabled(&mods_txt, &m.filename, false);
        for m in state.mods.iter_mut() {
            if m.uid == uid {
                m.enabled = false;
            }
        }
        save_state(state_path, &state);
        return;
    }
    let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
    let dis_dir = match &rel {
        Some(r) => disabled_base(game_path, target).join(r),
        None => disabled_base(game_path, target),
    };
    if let Err(e) = fs::create_dir_all(&dis_dir) {
        log::warn!("disable_mod: create_dir_all failed: {e}");
    }
    let from = active_mod_path(game_path, &m.filename, rel.as_deref(), target);
    let to = disabled_mod_path(game_path, &m.filename, rel.as_deref(), target);
    if cfg.game_id == "cb" {
        let cb_path = if from.exists() { &from } else { &to };
        crimeboss_settings::sync_enabled(cb_path, target.is_directory_unit(), launcher, false);
    }
    if from.exists() {
        let renamed = match &target.unit {
            ModUnit::File { extension, .. } => {
                rename_with_sidecars(&from, &to, extension, target.companions)
            }
            ModUnit::Directory { .. } => fs::rename(&from, &to),
        };
        if let Err(e) = renamed {
            log::warn!("disable_mod: rename {from:?} -> {to:?}: {e}");
        }
    }
    for m in state.mods.iter_mut() {
        if m.uid == uid {
            m.enabled = false;
        }
    }
    save_state(state_path, &state);
}

/// Copies src to dest, plus any companion siblings sharing src's stem, to the matching
/// siblings of dest. A missing companion is not an error.
fn copy_file_with_sidecars(
    src: &Path,
    dest: &Path,
    main_ext: &str,
    companions: &[&str],
) -> Result<(), String> {
    fs::copy(src, dest).map_err(|e| e.to_string())?;
    for ext in companions {
        let Some(sidecar) = sidecar_path(src, main_ext, ext) else {
            continue;
        };
        if sidecar.exists() {
            if let Some(dest_sidecar) = sidecar_path(dest, main_ext, ext) {
                let _ = fs::copy(&sidecar, dest_sidecar);
            }
        }
    }
    Ok(())
}

/// Renames from to to, plus any companion siblings of from to the matching siblings of to.
/// Used for enable and disable, which move a mod between active and disabled directories.
fn rename_with_sidecars(
    from: &Path,
    to: &Path,
    main_ext: &str,
    companions: &[&str],
) -> std::io::Result<()> {
    fs::rename(from, to)?;
    for ext in companions {
        let Some(sidecar) = sidecar_path(from, main_ext, ext) else {
            continue;
        };
        if sidecar.exists() {
            if let Some(to_sidecar) = sidecar_path(to, main_ext, ext) {
                let _ = fs::rename(&sidecar, to_sidecar);
            }
        }
    }
    Ok(())
}

/// Removes path, plus any companion siblings sharing its stem.
fn remove_file_with_sidecars(
    path: &Path,
    main_ext: &str,
    companions: &[&str],
) -> std::io::Result<()> {
    fs::remove_file(path)?;
    for ext in companions {
        let Some(sidecar) = sidecar_path(path, main_ext, ext) else {
            continue;
        };
        if sidecar.exists() {
            let _ = fs::remove_file(&sidecar);
        }
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let dest = dst.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
