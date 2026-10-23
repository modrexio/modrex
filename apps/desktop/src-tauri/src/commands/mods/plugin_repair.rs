//! Loose pak records that belong to a plugin release.
//!
//! Unreal mounts paks under Content/Paks ahead of plugin containers, so a mod's loose paks
//! would keep overriding its plugin, and a plugin install removes them. A loose pak counts as
//! a misplaced plugin only on the mod index's word: the file it came from, or failing that its
//! bytes, was published inside a plugin's Content/Paks/<platform>/ folder and nowhere else.
//! Its folder or file name proves nothing.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::engine::{backup_dir, ModEngineConfig, ModUnit, ScanTarget};
use super::folders::delete_folder_op;
use super::naming::{log_name, sidecar_path};
use super::paths::installed_mod_path;
use super::state::{get_folder_path, read_state, read_state_for_game, save_error, save_state};
use super::types::InstalledMod;
use super::unreal_plugin::is_plugin_container_entry;
use crate::commands::mod_index::{query_published_entries, EntryLookup, PublishedEntry};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MisplacedPlugin {
    /// ModWorkshop ids. file_id is the plugin release to install.
    pub mod_id: i64,
    pub file_id: i64,
    pub name: String,
    /// The pak records that install removes.
    pub uids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallReport {
    /// The plugin target's tag, None for a game without one.
    pub target: Option<String>,
    pub misplaced: Vec<MisplacedPlugin>,
    /// A descriptor's file name in the plugin folder itself, which hides every plugin below it.
    pub root_descriptor: Option<String>,
}

fn is_loose_pak_target(target: &ScanTarget) -> bool {
    matches!(target.unit, ModUnit::File { .. }) && target.native_steam_app.is_none()
}

/// Misplaced records grouped by mod.
pub(crate) fn misplaced_plugins(
    cfg: &ModEngineConfig,
    mods: &[InstalledMod],
    conn: &rusqlite::Connection,
) -> rusqlite::Result<Vec<MisplacedPlugin>> {
    if !cfg.targets.iter().any(|t| t.is_unreal_plugin_unit()) {
        return Ok(Vec::new());
    }
    let mut found: BTreeMap<i64, MisplacedPlugin> = BTreeMap::new();
    for m in mods {
        if !is_loose_pak_target(cfg.mod_target(m)) {
            continue;
        }
        let Some((mod_id, file_id, name)) = plugin_source(m, conn, cfg.index_game_name)? else {
            continue;
        };
        let entry = found.entry(mod_id).or_insert_with(|| MisplacedPlugin {
            mod_id,
            file_id,
            name,
            uids: Vec::new(),
        });
        entry.file_id = entry.file_id.max(file_id);
        entry.uids.push(m.uid.clone());
    }
    Ok(found.into_values().collect())
}

/// Only a ModWorkshop record qualifies, since another source's file ids mean nothing there.
fn plugin_source(
    m: &InstalledMod,
    conn: &rusqlite::Connection,
    game_name: &str,
) -> rusqlite::Result<Option<(i64, i64, String)>> {
    if m.source != "modworkshop" {
        return Ok(None);
    }
    let Some(evidence) = published_as_plugin(m, conn, game_name)? else {
        return Ok(None);
    };
    let first = &evidence[0];
    // The newest release of the same containers, so a repair updates this variant.
    let stems: HashSet<String> = evidence
        .iter()
        .map(|e| container_stem(&e.entry_name))
        .collect();
    let releases = query_published_entries(conn, EntryLookup::Mod(first.mod_remote_id), game_name)?;
    let newest = releases
        .iter()
        .filter(|e| is_plugin_container_entry(&e.entry_name))
        .filter(|e| stems.contains(&container_stem(&e.entry_name)))
        .chain(&evidence)
        .map(|e| e.file_remote_id)
        .max()
        .expect("the evidence holds at least one entry");
    Ok(Some((first.mod_remote_id, newest, first.mod_name.clone())))
}

/// Never empty, and all of one mod.
fn published_as_plugin(
    m: &InstalledMod,
    conn: &rusqlite::Connection,
    game_name: &str,
) -> rusqlite::Result<Option<Vec<PublishedEntry>>> {
    // The installed file decides when the index knows it: an author can publish one
    // container both as a plugin and as a loose pak.
    if let Some(file_id) = m.file_id.filter(|id| *id > 0) {
        let entries = query_published_entries(conn, EntryLookup::File(file_id), game_name)?;
        if !entries.is_empty() {
            return Ok(plugin_entries(entries));
        }
    }
    // A pak copied in by hand counts only when its bytes were published nowhere but a plugin.
    let Some(sha256) = m.sha256.as_deref() else {
        return Ok(None);
    };
    let entries = query_published_entries(conn, EntryLookup::Sha256(sha256), game_name)?;
    if entries
        .iter()
        .any(|entry| !is_plugin_container_entry(&entry.entry_name))
    {
        return Ok(None);
    }
    Ok(plugin_entries(entries))
}

fn plugin_entries(entries: Vec<PublishedEntry>) -> Option<Vec<PublishedEntry>> {
    let first = entries.first()?;
    if entries
        .iter()
        .any(|e| e.mod_remote_id != first.mod_remote_id)
    {
        return None;
    }
    let plugin: Vec<PublishedEntry> = entries
        .into_iter()
        .filter(|e| is_plugin_container_entry(&e.entry_name))
        .collect();
    (!plugin.is_empty()).then_some(plugin)
}

fn container_stem(entry_name: &str) -> String {
    let file = entry_name.rsplit('/').next().unwrap_or(entry_name);
    file.rsplit_once('.')
        .map_or(file, |(stem, _)| stem)
        .to_ascii_lowercase()
}

/// A mod's loose paks moved out of the game's reach for a plugin install, with their records
/// taken out of the state file. commit deletes them once the plugin is in place. Dropped
/// without commit, it puts files and records back, so a failed install loses nothing.
pub(crate) struct SupersededPaks {
    game_path: String,
    state_path: PathBuf,
    cfg: &'static ModEngineConfig,
    quarantine: Option<PathBuf>,
    moved: Vec<(PathBuf, PathBuf)>,
    records: Vec<InstalledMod>,
    pub(crate) all_disabled: bool,
}

/// Sets aside every loose pak record of this ModWorkshop mod before it installs into a plugin
/// target. Nothing is set aside for another target or without a remote id.
pub(crate) fn set_aside_superseded_paks(
    game_path: &str,
    state_path: &Path,
    cfg: &'static ModEngineConfig,
    target: &ScanTarget,
    remote_id: Option<&str>,
) -> Result<SupersededPaks, String> {
    let mut aside = SupersededPaks {
        game_path: game_path.to_string(),
        state_path: state_path.to_path_buf(),
        cfg,
        quarantine: None,
        moved: Vec::new(),
        records: Vec::new(),
        all_disabled: false,
    };
    let Some(remote_id) = remote_id.filter(|_| target.is_unreal_plugin_unit()) else {
        return Ok(aside);
    };
    let mut state = read_state_for_game(game_path, state_path, cfg).map_err(|e| e.to_string())?;
    let (records, kept): (Vec<InstalledMod>, Vec<InstalledMod>) =
        state.mods.into_iter().partition(|m| {
            m.source == "modworkshop"
                && m.remote_id.as_deref() == Some(remote_id)
                && is_loose_pak_target(cfg.mod_target(m))
        });
    state.mods = kept;
    if records.is_empty() {
        return Ok(aside);
    }
    aside.all_disabled = records.iter().all(|m| !m.enabled);
    for (n, m) in records.iter().enumerate() {
        let pak_target = cfg.mod_target(m);
        let ModUnit::File { extension, .. } = &pak_target.unit else {
            unreachable!("is_loose_pak_target admits file units only");
        };
        let folder = get_folder_path(&state.folders, m.folder_id.as_deref());
        let pak = installed_mod_path(
            game_path,
            &m.filename,
            folder.as_deref(),
            pak_target,
            m.enabled,
        );
        if !pak.exists() {
            continue;
        }
        // Beside the pak target's own backup, outside Content/Paks where Unreal mounts.
        let quarantine = aside.quarantine.get_or_insert_with(|| {
            let backup = backup_dir(game_path, pak_target);
            backup.with_file_name(format!(
                "{}.superseded-{}",
                log_name(&backup),
                Uuid::new_v4()
            ))
        });
        let family = std::iter::once(pak.clone()).chain(
            pak_target
                .companions
                .iter()
                .filter_map(|companion| sidecar_path(&pak, extension, companion))
                .filter(|sidecar| sidecar.exists()),
        );
        for file in family {
            let dest = quarantine
                .join(n.to_string())
                .join(file.file_name().expect("a mod file has a name"));
            let moved = fs::create_dir_all(dest.parent().expect("joined under the quarantine"))
                .and_then(|()| fs::rename(&file, &dest));
            // A pak that stays behind keeps overriding the plugin, so the install stops here.
            if let Err(e) = moved {
                return Err(format!(
                    "{} could not be moved and would override the plugin. Close the game and try again. ({e})",
                    log_name(&file)
                ));
            }
            aside.moved.push((file, dest));
        }
    }
    aside.records = records;
    save_state(state_path, &state).map_err(save_error)?;
    Ok(aside)
}

impl SupersededPaks {
    /// Deletes the set-aside paks and the app folders their records leave empty.
    pub(crate) fn commit(mut self) {
        if let Some(quarantine) = self.quarantine.take() {
            if let Err(e) = fs::remove_dir_all(&quarantine) {
                log::warn!(
                    "plugin install: could not delete superseded paks in {}: {e}",
                    quarantine.display()
                );
            }
        }
        self.moved.clear();
        let folders: HashSet<String> = std::mem::take(&mut self.records)
            .into_iter()
            .filter_map(|m| m.folder_id)
            .collect();
        for folder_id in folders {
            let state = match read_state_for_game(&self.game_path, &self.state_path, self.cfg) {
                Ok(state) => state,
                Err(e) => {
                    log::warn!(
                        "plugin install: could not read state to remove emptied folders: {e}"
                    );
                    return;
                }
            };
            let holds_anything = state
                .mods
                .iter()
                .any(|m| m.folder_id.as_deref() == Some(folder_id.as_str()))
                || state
                    .folders
                    .iter()
                    .any(|f| f.parent_id.as_deref() == Some(folder_id.as_str()));
            if holds_anything {
                continue;
            }
            // The paks are gone already, so a folder left behind is only clutter.
            if let Err(e) =
                delete_folder_op(&self.game_path, &self.state_path, &folder_id, self.cfg)
            {
                log::warn!("plugin install: could not remove emptied folder {folder_id}: {e}");
            }
        }
    }
}

impl Drop for SupersededPaks {
    fn drop(&mut self) {
        for (from, to) in self.moved.drain(..).rev() {
            if let Err(e) = fs::rename(&to, &from) {
                log::warn!(
                    "plugin install: could not put back {} from {}: {e}",
                    from.display(),
                    to.display()
                );
            }
        }
        if self.records.is_empty() {
            return;
        }
        let restored = read_state(&self.state_path)
            .map_err(|e| e.to_string())
            .and_then(|mut state| {
                state.mods.append(&mut self.records);
                save_state(&self.state_path, &state).map_err(save_error)
            });
        if let Err(e) = restored {
            log::warn!("plugin install: could not restore the superseded pak records: {e}");
        }
        // Only emptied folders go, so a file that could not be put back stays where the log
        // above says it is.
        if let Some(quarantine) = &self.quarantine {
            for entry in fs::read_dir(quarantine).into_iter().flatten().flatten() {
                let _ = fs::remove_dir(entry.path());
            }
            let _ = fs::remove_dir(quarantine);
        }
    }
}

/// Whether a plugin install should end disabled. A release replacing a disabled plugin of the
/// same name or uid stays disabled, a release replacing all-disabled loose paks does too, and
/// so does each further plugin a picker installs from the same file once the first is.
pub(crate) fn installs_disabled(
    cfg: &ModEngineConfig,
    mods: &[InstalledMod],
    target: &ScanTarget,
    uid: &str,
    folder: &str,
    file_id: i64,
    paks_disabled: bool,
) -> bool {
    if !target.is_unreal_plugin_unit() {
        return paks_disabled;
    }
    let in_target = |m: &&InstalledMod| cfg.mod_target(m).tag == target.tag;
    if let Some(replaced) = mods
        .iter()
        .filter(in_target)
        .find(|m| m.uid == uid || m.filename == folder)
    {
        return !replaced.enabled;
    }
    let siblings: Vec<&InstalledMod> = mods
        .iter()
        .filter(in_target)
        .filter(|m| m.file_id == Some(file_id))
        .collect();
    paks_disabled || (!siblings.is_empty() && siblings.iter().all(|m| !m.enabled))
}

#[cfg(test)]
#[path = "plugin_repair_tests.rs"]
mod tests;
