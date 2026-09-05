use super::crimeboss_settings;
use super::engine::{Activation, ModEngineConfig, ModUnit, ScanTarget};
use super::host_mods::{host_target_by_id, parse_host_location};
use super::naming::log_name;
use super::naming::{apply_priority_prefix, mod_folder_name, sidecar_path, strip_priority_prefix};
use super::paths::{
    active_mod_path, disabled_base, disabled_mod_path, host_pack_dir, host_pack_disabled_dir,
    mods_base, resolve_host_mod_dir,
};
use super::state::{get_folder_path, read_state, save_error, save_state};
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
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;
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
    )
    .map_err(save_error)?;
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
    let state = read_state(state_path).map_err(|e| e.to_string())?;
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
    )
    .map_err(save_error)?;
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
    let state = read_state(state_path).map_err(|e| e.to_string())?;
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
        disable_mod_op(game_path, state_path, uid, cfg, launcher)?;
    }

    // install_mod_from_path's own "existing" cleanup computes the old path inside the new
    // target's directory using the old filename, which never matches a cross-target move. The
    // real old location, under the old target's directory, is removed here instead.
    let removed = match &old_target.unit {
        ModUnit::File { extension, .. } => {
            remove_file_with_sidecars(&old_path, extension, old_target.companions)
        }
        ModUnit::Directory { .. } => fs::remove_dir_all(&old_path)
            .map_err(|e| format!("could not remove {}: {e}", log_name(&old_path))),
    };
    // The mod now exists under both targets and the game would load it twice, which is the
    // one outcome this move exists to prevent. Nothing can undo the copy safely at this
    // point, so say so instead of reporting a clean move.
    removed.map_err(|e| {
        format!("the mod was moved but its old copy is still in place, so the game may load it twice: {e}")
    })?;

    Ok(())
}

pub fn uninstall_mod_op(
    game_path: &str,
    state_path: &Path,
    uid: &str,
    cfg: &ModEngineConfig,
) -> Result<(), String> {
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;
    let Some(m) = state.mods.iter().find(|m| m.uid == uid).cloned() else {
        return Ok(());
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
        save_state(state_path, &state).map_err(save_error)?;
        return Ok(());
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
    save_state(state_path, &state).map_err(save_error)?;
    Ok(())
}

/// Where a mod's primary object actually sits.
///
/// Each location is checked against the kind its target expects, because a bare exists() says
/// only that the path is taken. A directory standing where a pak belongs is exactly what an
/// interrupted move leaves behind, and reading that as "the mod is here" gets the answer
/// backwards in the one case this check exists for.
#[derive(Debug, PartialEq, Eq)]
enum Placement {
    Active,
    Disabled,
    /// Both locations hold it. The active copy is the one the game loads, but a duplicate is
    /// reported rather than quietly resolved to a boolean.
    Both,
    /// Neither holds it, so nothing on disk says whether this mod is enabled.
    Missing,
}

fn holds_mod(target: &ScanTarget, path: &Path) -> bool {
    match &target.unit {
        ModUnit::File { .. } => path.is_file(),
        ModUnit::Directory { .. } => path.is_dir(),
    }
}

fn observe_placement(active: &Path, disabled: &Path, target: &ScanTarget) -> Placement {
    match (holds_mod(target, active), holds_mod(target, disabled)) {
        (true, false) => Placement::Active,
        (false, true) => Placement::Disabled,
        (true, true) => Placement::Both,
        (false, false) => Placement::Missing,
    }
}

fn move_mod_object(from: &Path, to: &Path, target: &ScanTarget) -> Result<(), String> {
    match &target.unit {
        ModUnit::File { extension, .. } => {
            rename_with_sidecars(from, to, extension, target.companions)
        }
        // A directory unit has no companions, so its move is the single rename.
        ModUnit::Directory { .. } => {
            fs::rename(from, to).map_err(|e| format!("could not move {}: {e}", log_name(from)))
        }
    }
}

pub fn enable_mod_op(
    game_path: &str,
    state_path: &Path,
    uid: &str,
    cfg: &ModEngineConfig,
    launcher: Option<&str>,
) -> Result<(), String> {
    set_activation(game_path, state_path, uid, cfg, launcher, true)
}

pub fn disable_mod_op(
    game_path: &str,
    state_path: &Path,
    uid: &str,
    cfg: &ModEngineConfig,
    launcher: Option<&str>,
) -> Result<(), String> {
    set_activation(game_path, state_path, uid, cfg, launcher, false)
}

/// Moves a mod between the active and disabled locations and records the result, in that
/// order.
///
/// The order is what makes the failure cases honest. A move that did not happen returns
/// before the flag is touched, so nothing claims a change the disk does not show. A save that
/// fails after a successful move puts the files back, because the record cannot describe them
/// otherwise: the scan reads a mod as known wherever it sits, so a disagreement between the
/// two would never be noticed again.
fn set_activation(
    game_path: &str,
    state_path: &Path,
    uid: &str,
    cfg: &ModEngineConfig,
    launcher: Option<&str>,
    enable: bool,
) -> Result<(), String> {
    let mut state = read_state(state_path).map_err(|e| e.to_string())?;
    let Some(m) = state
        .mods
        .iter()
        .find(|m| m.uid == uid && m.enabled != enable)
        .cloned()
    else {
        return Ok(());
    };
    let action = if enable { "enable" } else { "disable" };
    log::info!("{action}: {} ({})", m.name, m.uid);

    // Host packs live inside another mod's folder rather than at a target root.
    if is_host_pack(&m) {
        return move_host_pack(game_path, state_path, &mut state, &m, uid, cfg, enable);
    }

    let target = cfg.target_for(m.location.as_deref());
    if target.enabled_state == Activation::Ue4ssModsTxt {
        return set_activation_in_mods_txt(
            game_path, state_path, &mut state, &m, uid, target, enable,
        );
    }

    let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
    let active = active_mod_path(game_path, &m.filename, rel.as_deref(), target);
    let disabled = disabled_mod_path(game_path, &m.filename, rel.as_deref(), target);
    let (from, to) = if enable {
        (&disabled, &active)
    } else {
        (&active, &disabled)
    };
    let destination_parent = if enable {
        match &rel {
            Some(r) => mods_base(game_path, target).join(r),
            None => mods_base(game_path, target),
        }
    } else {
        match &rel {
            Some(r) => disabled_base(game_path, target).join(r),
            None => disabled_base(game_path, target),
        }
    };
    fs::create_dir_all(&destination_parent)
        .map_err(|e| format!("could not prepare the destination folder: {e}"))?;

    // Crime Boss's own mod loader reads activation from its settings file, not from where the
    // files sit, so that write is the one that takes effect and the move below is bookkeeping.
    // resync_crimeboss_enabled_flags also flips the tracked flag without moving anything, so a
    // mod whose files are not where Modrex expects is normal here.
    let activation_is_external = cfg.game_id == "cb";
    if activation_is_external {
        let cb_path = if from.exists() { from } else { to };
        crimeboss_settings::sync_enabled(cb_path, target.is_directory_unit(), launcher, enable);
    }

    // Only a move that actually happened can be put back, so the branches that move nothing
    // say so rather than leaving a reversal to undo something this call never did.
    let moved = match observe_placement(&active, &disabled, target) {
        // Already where this operation wanted it. The record is what is out of step, so
        // correct that and move nothing.
        p if p == wanted_placement(enable) => false,
        Placement::Both => {
            return Err(format!(
                "'{}' is in both the active and disabled folders, so Modrex will not guess which copy to keep",
                m.name
            ))
        }
        Placement::Missing if !activation_is_external => {
            return Err(format!("'{}' is no longer where Modrex installed it", m.name))
        }
        Placement::Missing => false,
        _ => {
            move_mod_object(from, to, target)?;
            true
        }
    };

    for m in state.mods.iter_mut() {
        if m.uid == uid {
            m.enabled = enable;
        }
    }
    let Err(e) = save_state(state_path, &state) else {
        return Ok(());
    };
    let failure = save_error(e);
    if !moved {
        return Err(failure);
    }
    Err(undo_after_failed_save(to, from, target, failure))
}

fn wanted_placement(enable: bool) -> Placement {
    if enable {
        Placement::Active
    } else {
        Placement::Disabled
    }
}

/// Puts the files back after the record could not be written, and composes both failures.
///
/// No second save follows a complete reversal: the file on disk was never replaced, so it
/// already describes the restored layout. A reversal that fails leaves the move standing and
/// the record behind it, which the message has to say outright.
fn undo_after_failed_save(
    from: &Path,
    to: &Path,
    target: &ScanTarget,
    save_failure: String,
) -> String {
    match move_mod_object(from, to, target) {
        Ok(()) => save_failure,
        Err(undo) => {
            format!("{save_failure}; the files were moved and could not be put back either: {undo}")
        }
    }
}

/// UE4SS loads whichever folders its own mods.txt lists, so that file is the activation and
/// the folder never moves. A record that cannot be written is put back the same way a file
/// move is.
fn set_activation_in_mods_txt(
    game_path: &str,
    state_path: &Path,
    state: &mut ModsState,
    m: &InstalledMod,
    uid: &str,
    target: &ScanTarget,
    enable: bool,
) -> Result<(), String> {
    let mods_txt = mods_base(game_path, target).join("mods.txt");
    ue4ss_modstxt::set_enabled(&mods_txt, &m.filename, enable)?;
    for x in state.mods.iter_mut() {
        if x.uid == uid {
            x.enabled = enable;
        }
    }
    let Err(e) = save_state(state_path, state) else {
        return Ok(());
    };
    let failure = save_error(e);
    Err(
        match ue4ss_modstxt::set_enabled(&mods_txt, &m.filename, !enable) {
            Ok(()) => failure,
            Err(undo) => {
                format!("{failure}; the loader's own list could not be put back either: {undo}")
            }
        },
    )
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
) -> Result<(), String> {
    let (Some(active), Some(disabled)) = (
        host_pack_dir(game_path, cfg, &state.mods, &state.folders, m),
        host_pack_disabled_dir(game_path, cfg, m),
    ) else {
        return Err(format!(
            "'{}' is a content pack for a mod that is no longer installed",
            m.name
        ));
    };
    let (from, to) = if enable {
        (disabled, active)
    } else {
        (active, disabled)
    };
    // A pack that is already at the destination only needs its record corrected.
    let moved = if from.is_dir() {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("could not prepare the destination folder: {e}"))?;
        }
        fs::rename(&from, &to).map_err(|e| format!("could not move {}: {e}", log_name(&from)))?;
        true
    } else if !to.is_dir() {
        return Err(format!(
            "'{}' is no longer where Modrex installed it",
            m.name
        ));
    } else {
        false
    };

    for x in state.mods.iter_mut() {
        if x.uid == uid {
            x.enabled = enable;
        }
    }
    let Err(e) = save_state(state_path, state) else {
        return Ok(());
    };
    let failure = save_error(e);
    if !moved {
        return Err(failure);
    }
    Err(match fs::rename(&to, &from) {
        Ok(()) => failure,
        Err(undo) => {
            format!("{failure}; the pack was moved and could not be put back either: {undo}")
        }
    })
}

/// Puts back the moves a failed group move already made, most recent first so each
/// destination is free before the one before it is restored.
fn undo_moves(moved: &[(std::path::PathBuf, std::path::PathBuf)]) -> Result<(), String> {
    let problems: Vec<String> = moved
        .iter()
        .rev()
        .filter_map(|(from, to)| match fs::rename(from, to) {
            Ok(()) => None,
            Err(e) => Some(format!("{}: {e}", log_name(to))),
        })
        .collect();
    if problems.is_empty() {
        return Ok(());
    }
    Err(problems.join("; "))
}

/// Copies src to dest, plus any companion sharing src's stem, as one unit.
///
/// A missing companion is normal. A companion that fails to copy is not: an Unreal pak
/// mounts the container its ucas and utoc hold, so a pak installed without them is a mod the
/// game loads and cannot read. The outputs this call created are removed, leaving a
/// destination that already existed alone, since undoing an overwrite would need a copy of
/// what was there.
pub(super) fn copy_file_with_sidecars(
    src: &Path,
    dest: &Path,
    main_ext: &str,
    companions: &[&str],
) -> Result<(), String> {
    let dest_existed = dest.exists();
    fs::copy(src, dest).map_err(|e| format!("could not copy {}: {e}", log_name(src)))?;
    let mut created: Vec<std::path::PathBuf> = Vec::new();
    if !dest_existed {
        created.push(dest.to_path_buf());
    }
    for ext in companions {
        let Some(sidecar) = sidecar_path(src, main_ext, ext) else {
            continue;
        };
        if !sidecar.exists() {
            continue;
        }
        let Some(dest_sidecar) = sidecar_path(dest, main_ext, ext) else {
            continue;
        };
        let sidecar_existed = dest_sidecar.exists();
        if let Err(e) = fs::copy(&sidecar, &dest_sidecar) {
            let failed = format!("could not copy {}: {e}", log_name(&sidecar));
            let leftovers: Vec<String> = created
                .iter()
                .rev()
                .filter_map(|p| {
                    fs::remove_file(p)
                        .err()
                        .map(|e| format!("{}: {e}", log_name(p)))
                })
                .collect();
            if leftovers.is_empty() {
                return Err(failed);
            }
            return Err(format!(
                "{failed}; and the partial copy could not be cleaned up: {}",
                leftovers.join("; ")
            ));
        }
        if !sidecar_existed {
            created.push(dest_sidecar);
        }
    }
    Ok(())
}

/// Renames from to to, plus any companion sharing from's stem, as one unit.
///
/// Used by enable and disable, which move a mod between the active and disabled locations. A
/// companion left behind would split the mod across both, so the moves already made are put
/// back. The failure is reported either way: a move that had to be undone did not happen.
pub(super) fn rename_with_sidecars(
    from: &Path,
    to: &Path,
    main_ext: &str,
    companions: &[&str],
) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| format!("could not move {}: {e}", log_name(from)))?;
    let mut moved = vec![(to.to_path_buf(), from.to_path_buf())];
    for ext in companions {
        let Some(sidecar) = sidecar_path(from, main_ext, ext) else {
            continue;
        };
        if !sidecar.exists() {
            continue;
        }
        let Some(to_sidecar) = sidecar_path(to, main_ext, ext) else {
            continue;
        };
        if let Err(e) = fs::rename(&sidecar, &to_sidecar) {
            let failed = format!("could not move {}: {e}", log_name(&sidecar));
            return Err(match undo_moves(&moved) {
                Ok(()) => failed,
                Err(undo) => format!("{failed}; and putting the mod back failed: {undo}"),
            });
        }
        moved.push((to_sidecar, sidecar));
    }
    Ok(())
}

/// Removes path, plus any companion sharing its stem.
///
/// Deletion has no counterpart to undo it, so a companion that will not go is reported and
/// the caller decides what that means for the mod's record.
pub(super) fn remove_file_with_sidecars(
    path: &Path,
    main_ext: &str,
    companions: &[&str],
) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| format!("could not remove {}: {e}", log_name(path)))?;
    let problems: Vec<String> = companions
        .iter()
        .filter_map(|ext| sidecar_path(path, main_ext, ext))
        .filter(|sidecar| sidecar.exists())
        .filter_map(|sidecar| {
            fs::remove_file(&sidecar)
                .err()
                .map(|e| format!("{}: {e}", log_name(&sidecar)))
        })
        .collect();
    if problems.is_empty() {
        return Ok(());
    }
    Err(problems.join("; "))
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
