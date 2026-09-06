use super::engine::{backup_dir, ModEngineConfig, ModUnit};
use super::naming::log_name;
use super::naming::{apply_priority_prefix, make_uid, strip_priority_prefix};
use super::paths::{
    active_mod_path, disabled_base, disabled_mod_path, host_pack_dir, host_pack_disabled_dir,
    mods_base,
};
use super::types::{InstalledMod, ModFolder, ModsState, UpdateStatus};
use crate::commands::sources;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

/// Modrex's own record of what it installed, kept inside the primary target's mods dir.
pub const STATE_FILENAME: &str = ".modrex.json";

pub fn get_folder_path(folders: &[ModFolder], folder_id: Option<&str>) -> Option<String> {
    let folder_id = folder_id?;
    let folder = folders.iter().find(|f| f.id == folder_id)?;
    let parent = get_folder_path(folders, folder.parent_id.as_deref());
    Some(match parent {
        Some(p) => format!("{}/{}", p, folder.disk_name),
        None => folder.disk_name.clone(),
    })
}

// State files written before update_status existed encoded these two states in the version
// string itself. Neither is a plausible real version, so a match is unambiguous. Clearing
// the version afterwards is what stops the sentinel being displayed or compared as one.
fn migrate_version_sentinels(m: &mut InstalledMod) {
    let migrated = match m.version.as_str() {
        "unknown" => UpdateStatus::Unknown,
        "outdated" => UpdateStatus::Outdated,
        _ => return,
    };
    m.update_status = migrated;
    m.version = String::new();
}

/// Why a state file could not be loaded.
///
/// The two cases need opposite handling and must not be collapsed. An unreadable file is
/// intact and often readable again moments later (a virus scanner or another process holding
/// it), so nothing may replace it and no recovery copy may be made. Invalid content will not
/// repair itself, but replacing it with a reconstruction still loses the folders, ordering and
/// per-mod metadata only that file holds. Either way the file stays exactly where it is.
///
/// Messages carry no path: they reach the interface through command errors.
#[derive(Debug)]
pub enum StateLoadError {
    Unreadable(std::io::Error),
    Invalid(String),
}

impl std::fmt::Display for StateLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable(e) => write!(f, "the installed-mod list could not be read: {e}"),
            Self::Invalid(reason) => write!(f, "the installed-mod list is not valid: {reason}"),
        }
    }
}

/// Deserializes one declared collection, rejecting the whole load if any element fails.
///
/// An absent key stays an empty list because a state file has always been allowed to omit
/// one. A present key that is not an array, or an element that does not fit the current
/// schema, invalidates the load: dropping the element instead would silently discard a mod
/// or a folder and the next save would persist that loss.
fn read_collection<T: serde::de::DeserializeOwned>(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Vec<T>, StateLoadError> {
    let Some(value) = object.get(key) else {
        return Ok(Vec::new());
    };
    let Some(array) = value.as_array() else {
        return Err(StateLoadError::Invalid(format!("'{key}' is not a list")));
    };
    array
        .iter()
        .enumerate()
        .map(|(i, v)| {
            serde_json::from_value(v.clone()).map_err(|e| {
                StateLoadError::Invalid(format!("{key} entry {} is not valid: {e}", i + 1))
            })
        })
        .collect()
}

pub fn read_state(state_path: &Path) -> Result<ModsState, StateLoadError> {
    // Taken from the read itself rather than a separate exists() check, so a file appearing or
    // vanishing between the two cannot be mistaken for the other case.
    let content = match fs::read_to_string(state_path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ModsState::default()),
        Err(e) => return Err(StateLoadError::Unreadable(e)),
    };
    let parsed: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| StateLoadError::Invalid(e.to_string()))?;
    let Some(object) = parsed.as_object() else {
        return Err(StateLoadError::Invalid(
            "the top level is not a JSON object".to_string(),
        ));
    };

    let folders = read_collection(object, "folders")?;
    let mut mods: Vec<InstalledMod> = read_collection(object, "mods")?;
    for m in mods.iter_mut() {
        if m.uid.is_empty() {
            m.uid = make_uid(m.file_id, &m.filename);
        }
        migrate_version_sentinels(m);
    }

    Ok(ModsState { folders, mods })
}

/// One wording for a failed persist, so the interface reads the same wherever it surfaces.
/// Carries no path, for the reason given on StateLoadError.
pub fn save_error(e: std::io::Error) -> String {
    format!("the installed-mod list could not be saved: {e}")
}

pub fn save_state(state_path: &Path, state: &ModsState) -> std::io::Result<()> {
    let parent = state_path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the mod list path has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let body = serde_json::to_string_pretty(state)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut tmp_name = state_path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("state"))
        .to_os_string();
    tmp_name.push(".tmp");
    let tmp = state_path.with_file_name(tmp_name);
    fs::write(&tmp, body)?;
    if let Err(e) = fs::rename(&tmp, state_path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn compact_folder_priorities(
    folders: &[ModFolder],
    mods_base: &Path,
    dis_base: &Path,
    priority_prefix_enabled: bool,
) -> (Vec<ModFolder>, bool) {
    let mut compacted = folders.to_vec();
    let mut any_changed = false;

    let parent_ids: std::collections::BTreeSet<Option<String>> = {
        let mut ids = std::collections::BTreeSet::new();
        ids.insert(None);
        for f in folders {
            ids.insert(f.parent_id.clone());
        }
        ids
    };

    for parent_id in parent_ids {
        let mut siblings: Vec<(usize, i64)> = compacted
            .iter()
            .enumerate()
            .filter(|(_, f)| f.parent_id == parent_id)
            .map(|(i, f)| (i, f.priority))
            .collect();
        siblings.sort_by_key(|&(_, p)| p);

        for (rank, &(idx, _)) in siblings.iter().enumerate() {
            let new_priority = (rank + 1) as i64;
            let f = &compacted[idx];
            if f.priority == new_priority {
                continue;
            }

            let old_disk_name = f.disk_name.clone();
            let new_disk_name = if priority_prefix_enabled {
                apply_priority_prefix(strip_priority_prefix(&old_disk_name), new_priority)
            } else {
                strip_priority_prefix(&old_disk_name).to_string()
            };
            let parent_rel = get_folder_path(&compacted, parent_id.as_deref());

            let (old_active, new_active) = match &parent_rel {
                Some(r) => (
                    mods_base.join(r).join(&old_disk_name),
                    mods_base.join(r).join(&new_disk_name),
                ),
                None => (
                    mods_base.join(&old_disk_name),
                    mods_base.join(&new_disk_name),
                ),
            };

            if old_active.exists() {
                if let Err(e) = fs::rename(&old_active, &new_active) {
                    log::warn!(
                        "compact_folder_priorities: rename {}: {e}",
                        log_name(&old_active)
                    );
                    continue;
                }
            }

            let (old_dis, new_dis) = match &parent_rel {
                Some(r) => (
                    dis_base.join(r).join(&old_disk_name),
                    dis_base.join(r).join(&new_disk_name),
                ),
                None => (dis_base.join(&old_disk_name), dis_base.join(&new_disk_name)),
            };
            if old_dis.exists() {
                if let Err(e) = fs::rename(&old_dis, &new_dis) {
                    log::warn!(
                        "compact_folder_priorities: rename disabled {}: {e}",
                        log_name(&old_dis)
                    );
                }
            }

            compacted[idx].priority = new_priority;
            compacted[idx].disk_name = new_disk_name;
            any_changed = true;
        }
    }

    (compacted, any_changed)
}

/// Permission to write the state file back, held only when it could be read.
///
/// A scan can always rebuild a mod list, but writing that rebuild over a file Modrex failed to
/// read would replace the folders, ordering and per-mod metadata that live only in the file.
/// Every writeback in get_installed goes through this rather than through a flag each exit has
/// to remember to check, so a new exit cannot persist a rebuild by omission.
#[derive(Clone, Copy, Debug)]
pub struct Writeback(bool);

impl Writeback {
    /// True when the state was unreadable, which is what get_installed reports to the interface.
    pub fn blocked(self) -> bool {
        !self.0
    }

    /// Saves unless the state this was derived from could not be read.
    ///
    /// A failed save is logged and swallowed: the scan result is still correct to show, and the
    /// next call reaches the same point again.
    pub fn save(self, state_path: &Path, state: &ModsState, what: &str) {
        if !self.0 {
            return;
        }
        if let Err(e) = save_state(state_path, state) {
            log::warn!("get_installed: could not persist {what}: {e}");
        }
    }
}

/// Loads the state a scan starts from, degrading to an empty one that must not be written back.
pub fn load_for_scan(
    game_path: &str,
    state_path: &Path,
    cfg: &ModEngineConfig,
) -> (ModsState, Writeback) {
    match reconcile_state(game_path, state_path, cfg) {
        Ok(state) => (state, Writeback(true)),
        Err(e) => {
            log::warn!("get_installed: {e}");
            (ModsState::default(), Writeback(false))
        }
    }
}

pub fn reconcile_state(
    game_path: &str,
    state_path: &Path,
    cfg: &ModEngineConfig,
) -> Result<ModsState, StateLoadError> {
    let bak = backup_dir(game_path, cfg.primary());
    if bak.exists() {
        if cfg.primary().is_directory_unit() {
            // BLT: state file stays in mods/ because only user mod dirs were moved to backup.
            return read_state(state_path);
        }
        // PD3: the entire mods folder was renamed, so the state file is inside the backup.
        return read_state(&bak.join(STATE_FILENAME));
    }

    // Migrate legacy state file name from .pd3mm.json to .modrex.json.
    let legacy = state_path.with_file_name(".pd3mm.json");
    if legacy.exists() && !state_path.exists() {
        let _ = fs::rename(&legacy, state_path);
    }

    let mut state = read_state(state_path)?;

    // Recover source-native identity for entries written before remote_id existed:
    // their uid already encodes it as {source}:{mod_id}:{file_id} (the nexus install
    // convention), so migration is a pure parse.
    let mut identity_migrated = false;
    for m in state.mods.iter_mut() {
        if m.source == "modworkshop" || m.remote_id.is_some() {
            continue;
        }
        let mut parts = m.uid.splitn(3, ':');
        if parts.next() != Some(m.source.as_str()) {
            continue;
        }
        let (Some(mod_id), Some(file_id)) = (parts.next(), parts.next()) else {
            continue;
        };
        if mod_id.is_empty() || file_id.is_empty() {
            continue;
        }
        m.remote_id = Some(mod_id.to_string());
        m.file_remote_id = Some(file_id.to_string());
        identity_migrated = true;
    }

    // A positive id on a modworkshop entry already IS the real modworkshop id, so this is a
    // plain fill-in, never a re-derivation. Must run before upgrade_negative_ids: it cannot
    // tell "never identified" from "identified before remote_id existed", and its name
    // fallback would mass-mark pre-existing installs Outdated during a plain data migration.
    for m in state.mods.iter_mut() {
        if m.remote_id.is_some() || m.id < 0 || m.source != "modworkshop" {
            continue;
        }
        m.remote_id = Some(m.id.to_string());
        identity_migrated = true;
    }

    // A source-native entry's id must always be source_native_local_id(source, remote_id),
    // which is what a Nexus mod's card badge and its per-source update check both key off.
    // An entry whose id was reassigned to a cross-posted modworkshop listing stays stuck on
    // the wrong record: upgrade_negative_ids only looks at still-negative ids, so nothing
    // else notices. This repairs it on every load.
    let mut identity_id_repaired = false;
    for m in state.mods.iter_mut() {
        let Some(remote_id) = m.remote_id.as_deref() else {
            continue;
        };
        let expected = sources::source_native_local_id(&m.source, remote_id);
        if m.id != expected {
            m.id = expected;
            identity_id_repaired = true;
        }
    }
    let state = state;

    // Removes auto-discovered, never-installed entries whose directory has no scan_marker
    // file on disk, or whose name is on the target's excluded_names list. The first case
    // purges DAHM framework modules (base.lua, no mod.txt). The second purges UE4SS's
    // bundled framework sub-mods (e.g. ActorDumperMod), whose marker file is genuinely
    // present, so the first check alone never catches them. Entries with a file_id
    // (Modrex-installed) or a remote_id (identified against any source) are kept.
    let cleanup_removed: HashSet<String> = state
        .mods
        .iter()
        .filter(|m| {
            if m.file_id.is_some() || m.remote_id.is_some() {
                return false;
            }
            let target = cfg.target_for(m.location.as_deref());
            let ModUnit::Directory {
                scan_markers,
                excluded_names,
                ..
            } = &target.unit
            else {
                return false;
            };
            if excluded_names.contains(&m.filename.as_str()) {
                return true;
            }
            if scan_markers.is_empty() {
                return false;
            }
            let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
            let dir = active_mod_path(game_path, &m.filename, rel.as_deref(), target);
            !scan_markers.iter().any(|marker| dir.join(marker).exists())
        })
        .map(|m| m.uid.clone())
        .collect();
    let cleanup_changed = !cleanup_removed.is_empty();
    let state = if cleanup_changed {
        let mods = state
            .mods
            .into_iter()
            .filter(|m| !cleanup_removed.contains(&m.uid))
            .collect();
        ModsState {
            mods,
            folders: state.folders,
        }
    } else {
        state
    };

    // Migrate legacy disabled paths: disabled/foo.pak becomes disabled/foo.pak.disabled
    let dis_dir = disabled_base(game_path, cfg.primary());
    let disabled_mods: Vec<InstalledMod> =
        state.mods.iter().filter(|m| !m.enabled).cloned().collect();
    for m in &disabled_mods {
        let folder_rel = get_folder_path(&state.folders, m.folder_id.as_deref());
        let new_path = disabled_mod_path(
            game_path,
            &m.filename,
            folder_rel.as_deref(),
            cfg.target_for(m.location.as_deref()),
        );
        let legacy = dis_dir.join(&m.filename);
        if !new_path.exists() && legacy.exists() {
            if let Some(rel) = &folder_rel {
                if let Err(e) = fs::create_dir_all(dis_dir.join(rel)) {
                    log::warn!("migrate legacy path: create_dir_all: {e}");
                }
            }
            if let Err(e) = fs::rename(&legacy, &new_path) {
                log::warn!("migrate legacy path {}: {e}", log_name(&legacy));
            }
        }
    }

    let checks: Vec<bool> = state
        .mods
        .iter()
        .map(|m| {
            // Host packs live inside another mod's folder (enabled) or our disabled area.
            if m.location
                .as_deref()
                .is_some_and(|l| l.starts_with("host:"))
            {
                let active = host_pack_dir(game_path, cfg, &state.mods, &state.folders, m)
                    .is_some_and(|p| p.exists());
                let disabled =
                    host_pack_disabled_dir(game_path, cfg, m).is_some_and(|p| p.exists());
                return active || disabled;
            }
            let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
            let target = cfg.target_for(m.location.as_deref());
            active_mod_path(game_path, &m.filename, rel.as_deref(), target).exists()
                || disabled_mod_path(game_path, &m.filename, rel.as_deref(), target).exists()
        })
        .collect();

    let reconciled: Vec<InstalledMod> = state
        .mods
        .iter()
        .zip(checks.iter())
        .map(|(m, &found)| {
            let mut m = m.clone();
            m.missing = if found { None } else { Some(true) };
            m
        })
        .collect();

    let state_changed = reconciled
        .iter()
        .zip(state.mods.iter())
        .any(|(r, o)| r.missing != o.missing);

    let mods_base_path = mods_base(game_path, cfg.primary());
    // Phantom: no mods, no child folders, and active directory absent.
    // Ignores the disabled directory so an empty leftover disabled/ subdir doesn't prevent cleanup.
    let phantom_ids: HashSet<String> = state
        .folders
        .iter()
        .filter(|f| {
            let has_mods = state
                .mods
                .iter()
                .any(|m| m.folder_id.as_deref() == Some(f.id.as_str()));
            let has_children = state
                .folders
                .iter()
                .any(|cf| cf.parent_id.as_deref() == Some(f.id.as_str()));
            if has_mods || has_children {
                return false;
            }
            get_folder_path(&state.folders, Some(f.id.as_str()))
                .map(|rel| !mods_base_path.join(&rel).exists())
                .unwrap_or(true)
        })
        .map(|f| f.id.clone())
        .collect();

    let cleaned_folders: Vec<ModFolder> = if phantom_ids.is_empty() {
        state.folders.clone()
    } else {
        for f in state.folders.iter().filter(|f| phantom_ids.contains(&f.id)) {
            if let Some(rel) = get_folder_path(&state.folders, Some(f.id.as_str())) {
                // remove_dir succeeds only on an empty directory, so this is safe unconditionally.
                let _ = fs::remove_dir(dis_dir.join(&rel));
            }
        }
        state
            .folders
            .iter()
            .filter(|f| !phantom_ids.contains(&f.id))
            .cloned()
            .collect()
    };

    // Compact folder priorities to sequential (1, 2, 3, ...), repairing any gaps.
    let (final_folders, any_compacted) = compact_folder_priorities(
        &cleaned_folders,
        &mods_base_path,
        &dis_dir,
        cfg.primary().priority_prefix_enabled(),
    );

    if state_changed
        || !phantom_ids.is_empty()
        || any_compacted
        || cleanup_changed
        || identity_migrated
        || identity_id_repaired
    {
        // Class C: everything written here is re-derived on the next load, and the folder
        // renames compact_folder_priorities already performed converge to the same names on
        // that load. Failing the whole read over a repeatable write would take the installed
        // list down for a loss that costs nothing.
        if let Err(e) = save_state(
            state_path,
            &ModsState {
                folders: final_folders.clone(),
                mods: reconciled.clone(),
            },
        ) {
            log::warn!("reconcile_state: could not persist the reconciled state: {e}");
        }
    }

    if reconciled.iter().any(|m| m.priority.is_none()) {
        let mut max_by_folder: HashMap<Option<String>, i64> = HashMap::new();
        for m in &reconciled {
            if let Some(p) = m.priority {
                let key = m.folder_id.clone();
                let entry = max_by_folder.entry(key).or_insert(0);
                *entry = (*entry).max(p);
            }
        }
        let migrated: Vec<InstalledMod> = reconciled
            .iter()
            .map(|m| {
                if m.priority.is_some() {
                    return m.clone();
                }
                let key = m.folder_id.clone();
                let entry = max_by_folder.entry(key).or_insert(0);
                *entry += 1;
                let mut m = m.clone();
                m.priority = Some(*entry);
                m
            })
            .collect();
        // Class C: the priority backfill recomputes identically on the next load.
        if let Err(e) = save_state(
            state_path,
            &ModsState {
                folders: final_folders.clone(),
                mods: migrated.clone(),
            },
        ) {
            log::warn!("reconcile_state: could not persist the priority backfill: {e}");
        }
        return Ok(ModsState {
            folders: final_folders,
            mods: migrated,
        });
    }

    Ok(ModsState {
        folders: final_folders,
        mods: reconciled,
    })
}
