//! Per-game mod profiles, kept in the game's .modrex folder.
//!
//! Each profile has its own mods and its own app folders. The mods of the active profile are
//! installed as usual. The mods of every other profile are parked: their files in
//! .modrex/parked/<install_id>, outside every folder the game loads, and their records in
//! .modrex/parked.json, so the Installed page and every scan see only the active profile. A mod
//! two profiles share is one installation, live or parked as one. A profile's folders live in
//! its own file and are put in place, empty directories and all, when it becomes active.
//!
//! A profile lists installations by install_id, with the enabled flag, folder and order each
//! had. The live profile is never read back from its file. The file is a snapshot taken when
//! the user switches away, and every live mod is a member, so a new install joins the active
//! profile without any install path knowing about profiles. Two kinds of live record belong to
//! no profile: one whose files are missing keeps what each profile already said about it, and
//! a loader tracked as a mod (PDML) stays live in every profile, because the mods of every
//! profile need it. Ready or Not's mods share Paks with the game's own files and Modrex moves
//! nothing out of Paks, so a mod outside the active profile stays there, disabled and listed.
//!
//! A switch turns mods off and on through the operations the Installed page uses, so each
//! loader keeps its own way of doing it (file moves, mods.txt, Crime Boss's settings file),
//! and parks a mod only once it is off. It writes a journal naming the target before it
//! touches anything, and every step changes a mod only when it is not already where the
//! target puts it, so finishing an interrupted switch is running it again. The journal does
//! not cover a process killed inside one per-mod operation, which leaves what a single toggle
//! killed at that point leaves.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::bundle::disabled_store;
use super::engine::{modrex_dir, set_aside_dir, Activation, ModEngineConfig};
use super::install::{disable_mod_op, enable_mod_op, is_host_pack};
use super::moves::Moves;
use super::paths::{
    active_mod_path, disabled_base, disabled_mod_path, host_pack_disabled_dir, mods_base,
};
use super::reorder::{move_mod_to_folder_op, reorder_mods_in_folder_op};
use super::resource_state::write_atomic;
use super::state::{get_folder_path, read_state_for_game, reconcile_state, save_state};
use super::types::{InstalledMod, ModFolder, ModsState};

/// Bump when a profile, journal or parked record holds data an older build would drop or
/// misread.
const PROFILE_SCHEMA_VERSION: u32 = 1;

const NAME_LIMIT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMember {
    pub install_id: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
}

impl ProfileMember {
    fn of(m: &InstalledMod) -> Self {
        Self {
            install_id: m.install_id.clone(),
            enabled: m.enabled,
            folder_id: m.folder_id.clone(),
            priority: m.priority,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub members: Vec<ProfileMember>,
    #[serde(default)]
    pub folders: Vec<ModFolder>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Versioned<T> {
    schema_version: u32,
    #[serde(flatten)]
    body: T,
}

/// A switch that has started and not finished.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    profile_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMarker {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_profile: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Parked {
    mods: Vec<InstalledMod>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileList {
    pub profiles: Vec<ProfileSummary>,
    pub active: Option<String>,
    /// The profile a switch was heading for when it stopped. Switching to it again finishes it.
    pub unfinished_switch: Option<String>,
}

/// What a new profile starts as.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProfileSource {
    /// The mods as they are installed right now.
    Current,
    /// No mods, so switching to it parks every mod.
    Empty,
    /// Another profile's members.
    #[serde(rename_all = "camelCase")]
    Copy { profile_id: String },
}

fn read_versioned<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text =
        fs::read_to_string(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{} is not valid: {e}", path.display()))?;
    let version = value.get("schemaVersion").and_then(|v| v.as_u64());
    if version.is_some_and(|v| v > u64::from(PROFILE_SCHEMA_VERSION)) {
        return Err(format!(
            "{} was saved by a newer version of Modrex",
            path.display()
        ));
    }
    serde_json::from_value::<Versioned<T>>(value)
        .map(|v| v.body)
        .map_err(|e| format!("{} is not valid: {e}", path.display()))
}

fn write_versioned<T: Serialize>(path: &Path, body: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&Versioned {
        schema_version: PROFILE_SCHEMA_VERSION,
        body,
    })
    .map_err(|e| e.to_string())?;
    write_atomic(path, &bytes)
}

/// A profile id names a file, so it is checked before it is joined to a path.
fn checked_id(id: &str) -> Result<&str, String> {
    Uuid::parse_str(id)
        .map(|_| id)
        .map_err(|_| "that is not a profile of this game".to_string())
}

fn checked_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a profile needs a name".to_string());
    }
    if name.chars().count() > NAME_LIMIT {
        return Err(format!(
            "a profile name can be at most {NAME_LIMIT} characters"
        ));
    }
    Ok(name.to_string())
}

fn exists(path: &Path) -> Result<bool, String> {
    path.try_exists()
        .map_err(|e| format!("could not check {}: {e}", path.display()))
}

/// The profiles, parked mods and switch journal of one copy of a game, in its .modrex folder.
pub(crate) struct ProfileStore {
    root: PathBuf,
}

impl ProfileStore {
    pub(crate) fn new(game_path: &str) -> Self {
        Self {
            root: modrex_dir(game_path),
        }
    }

    fn profile_path(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self
            .root
            .join("profiles")
            .join(format!("{}.json", checked_id(id)?)))
    }

    pub(crate) fn list(&self) -> Result<Vec<Profile>, String> {
        let dir = self.root.join("profiles");
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("could not read the profiles: {e}")),
        };
        let mut profiles = Vec::new();
        for entry in entries {
            let path = entry
                .map_err(|e| format!("could not read the profiles: {e}"))?
                .path();
            let Some(id) = path
                .file_stem()
                .filter(|_| path.extension().is_some_and(|ext| ext == "json"))
            else {
                continue;
            };
            profiles.push(read_profile(&path, &id.to_string_lossy())?);
        }
        // The id breaks ties, since the directory listing has no stable order.
        profiles
            .sort_by(|a, b| (a.name.to_lowercase(), &a.id).cmp(&(b.name.to_lowercase(), &b.id)));
        Ok(profiles)
    }

    pub(crate) fn get(&self, id: &str) -> Result<Profile, String> {
        self.find(id)?
            .ok_or_else(|| "that profile no longer exists".to_string())
    }

    fn find(&self, id: &str) -> Result<Option<Profile>, String> {
        let path = self.profile_path(id)?;
        if !exists(&path)? {
            return Ok(None);
        }
        read_profile(&path, id).map(Some)
    }

    pub(crate) fn save(&self, profile: &Profile) -> Result<(), String> {
        write_versioned(&self.profile_path(&profile.id)?, profile)
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        let path = self.profile_path(id)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not delete the profile: {e}")),
        }
    }

    fn journal_path(&self) -> PathBuf {
        self.root.join("switch.json")
    }

    /// The switch that started and did not finish, if any.
    fn pending(&self) -> Result<Option<Journal>, String> {
        let path = self.journal_path();
        if !exists(&path)? {
            return Ok(None);
        }
        read_versioned(&path).map(Some)
    }

    fn begin(&self, journal: &Journal) -> Result<(), String> {
        write_versioned(&self.journal_path(), journal)
    }

    fn finish(&self) -> Result<(), String> {
        fs::remove_file(self.journal_path())
            .map_err(|e| format!("could not close the profile journal: {e}"))
    }

    fn marker_path(&self) -> PathBuf {
        self.root.join("install.json")
    }

    /// The profile this copy of the game is set up as, if any.
    pub(crate) fn active(&self) -> Result<Option<String>, String> {
        let path = self.marker_path();
        if !exists(&path)? {
            return Ok(None);
        }
        Ok(read_versioned::<InstallMarker>(&path)?.active_profile)
    }

    fn set_active(&self, id: Option<&str>) -> Result<(), String> {
        write_versioned(
            &self.marker_path(),
            &InstallMarker {
                active_profile: id.map(str::to_string),
            },
        )
    }

    fn parked(&self) -> Result<Vec<InstalledMod>, String> {
        let path = self.root.join("parked.json");
        if !exists(&path)? {
            return Ok(Vec::new());
        }
        Ok(read_versioned::<Parked>(&path)?.mods)
    }

    fn save_parked(&self, mods: Vec<InstalledMod>) -> Result<(), String> {
        write_versioned(&self.root.join("parked.json"), &Parked { mods })
    }

    /// Where a parked mod's files sit. The install id names a folder, so it is checked first.
    fn parked_dir(&self, m: &InstalledMod) -> Result<PathBuf, String> {
        Uuid::parse_str(&m.install_id)
            .map_err(|_| format!("'{}' has no install id Modrex can park it under", m.name))?;
        Ok(self.root.join("parked").join(&m.install_id))
    }
}

/// A file that names a profile must hold that profile, or saving it would overwrite another.
fn read_profile(path: &Path, id: &str) -> Result<Profile, String> {
    let profile: Profile = read_versioned(path)?;
    if profile.id != id {
        return Err(format!("{} holds another profile", path.display()));
    }
    Ok(profile)
}

/// What a switch needs from the caller beyond the target: which copy and how to toggle there.
pub(crate) struct Install<'a> {
    pub game_path: &'a str,
    pub state_path: &'a Path,
    pub cfg: &'static ModEngineConfig,
    pub launcher: Option<&'a str>,
}

impl Install<'_> {
    fn read(&self) -> Result<ModsState, String> {
        read_state_for_game(self.game_path, self.state_path, self.cfg).map_err(|e| e.to_string())
    }

    /// The installed mods as the Installed page sees them. The missing flags a plain read
    /// returns are only as fresh as the last scan, and a file deleted by hand since then would
    /// fail its toggle halfway through a switch.
    fn scan(&self) -> Result<ModsState, String> {
        reconcile_state(self.game_path, self.state_path, self.cfg).map_err(|e| e.to_string())
    }

    /// Where a mod's files sit while it is off, which is where parking takes them from.
    fn off_slot(&self, folders: &[ModFolder], m: &InstalledMod) -> Result<PathBuf, String> {
        let target = self.cfg.mod_target(m);
        if is_host_pack(m) {
            return host_pack_disabled_dir(self.game_path, self.cfg, m)
                .ok_or_else(|| format!("'{}' names no host mod", m.name));
        }
        if target.is_bundle() {
            return Ok(disabled_store(self.game_path, target, &m.uid));
        }
        let rel = get_folder_path(folders, m.folder_id.as_deref());
        // UE4SS reads a mod that is off from mods.txt, so its folder stays where it is.
        if target.enabled_state == Activation::Ue4ssModsTxt {
            return Ok(active_mod_path(
                self.game_path,
                &m.filename,
                rel.as_deref(),
                target,
            ));
        }
        Ok(disabled_mod_path(
            self.game_path,
            &m.filename,
            rel.as_deref(),
            target,
        ))
    }

    /// Moves a mod's files between its off slot and its parked folder, with companions.
    fn move_files(&self, m: &InstalledMod, from: PathBuf, to: PathBuf) -> Result<(), String> {
        let parent = to.parent().expect("a mod path has a parent directory");
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not prepare {}: {e}", parent.display()))?;
        let mut moves = Moves::for_game(self.game_path, self.cfg)?;
        moves.unit(self.cfg.mod_target(m), from, to);
        moves.run().map(|_| ())
    }
}

/// The modworkshop pages this game publishes a loader under. A record installed from one is a
/// loader tracked as a mod.
fn loader_pages(cfg: &ModEngineConfig) -> HashSet<String> {
    crate::commands::loaders::scoped_bindings()
        .into_iter()
        .filter(|(game_id, _, _)| *game_id == cfg.game_id)
        .flat_map(|(_, _, ids)| ids)
        .map(|id| id.to_string())
        .collect()
}

/// The live records profiles decide, see the module comment.
fn decided(cfg: &ModEngineConfig, mods: &[InstalledMod]) -> Vec<InstalledMod> {
    let loaders = loader_pages(cfg);
    let is_loader = |m: &InstalledMod| {
        m.source == "modworkshop" && m.remote_id.as_ref().is_some_and(|id| loaders.contains(id))
    };
    mods.iter()
        .filter(|m| m.missing != Some(true) && !is_loader(m))
        .cloned()
        .collect()
}

/// Whether a mod outside the active profile can leave the game's folders. See the module
/// comment for Ready or Not.
fn parkable(cfg: &ModEngineConfig, m: &InstalledMod) -> bool {
    cfg.mod_target(m).shared_paks.is_none()
}

/// The members a profile has once the decided live records are written back into it. Every
/// one of them is a member, except a mod that cannot be parked and is off, which is one only
/// when the profile listed it. Members with no live record stay as they were, since the record
/// may be missing or parked.
fn snapshot(
    cfg: &ModEngineConfig,
    previous: &[ProfileMember],
    live: &[InstalledMod],
) -> Vec<ProfileMember> {
    let listed: HashSet<&str> = previous.iter().map(|p| p.install_id.as_str()).collect();
    let present: HashSet<&str> = live.iter().map(|m| m.install_id.as_str()).collect();
    live.iter()
        .filter(|m| parkable(cfg, m) || m.enabled || listed.contains(m.install_id.as_str()))
        .map(ProfileMember::of)
        .chain(
            previous
                .iter()
                .filter(|p| !present.contains(p.install_id.as_str()))
                .cloned(),
        )
        .collect()
}

/// Writes the live setup back into the active profile before it is left.
fn save_active(
    store: &ProfileStore,
    install: &Install,
    live: &ModsState,
) -> Result<Option<String>, String> {
    let Some(id) = store.active()? else {
        return Ok(None);
    };
    // A marker naming a deleted profile is a profile the user removed, not one to bring back.
    let Some(mut profile) = store.find(&id)? else {
        return Ok(None);
    };
    profile.members = snapshot(
        install.cfg,
        &profile.members,
        &decided(install.cfg, &live.mods),
    );
    profile.folders = live.folders.clone();
    store.save(&profile)?;
    Ok(Some(id))
}

/// Takes a mod that is off out of the game: the record goes to parked.json first, then the
/// files move, and the state drops the record last, so a stop at any point leaves the mod in
/// both lists, which the next switch settles.
fn park(store: &ProfileStore, install: &Install, uid: &str) -> Result<(), String> {
    let state = install.read()?;
    let Some(m) = state.mods.iter().find(|m| m.uid == uid).cloned() else {
        return Ok(());
    };
    let mut parked = store.parked()?;
    if !parked.iter().any(|p| p.install_id == m.install_id) {
        parked.push(m.clone());
        store.save_parked(parked)?;
    }
    let slot = install.off_slot(&state.folders, &m)?;
    let dest = store
        .parked_dir(&m)?
        .join(slot.file_name().expect("a mod path names a file"));
    if exists(&slot)? && !exists(&dest)? {
        install.move_files(&m, slot, dest)?;
    }
    let rest = ModsState {
        folders: state.folders,
        mods: state.mods.into_iter().filter(|r| r.uid != uid).collect(),
    };
    save_state(install.state_path, &rest).map_err(|e| e.to_string())
}

/// Brings a parked mod back, off: the state gains the record first, then the files move, and
/// parked.json drops it last. A record found in both lists is finished the same way.
fn unpark(store: &ProfileStore, install: &Install, record: &InstalledMod) -> Result<(), String> {
    let mut state = install.read()?;
    let m = match state
        .mods
        .iter()
        .find(|m| m.install_id == record.install_id)
    {
        Some(live) => live.clone(),
        None => {
            if state.mods.iter().any(|m| m.uid == record.uid) {
                return Err(format!(
                    "'{}' is installed twice, once in this profile and once in another. Uninstall one of them, then switch again.",
                    record.name
                ));
            }
            // A folder deleted while the mod was parked leaves it at the top level.
            let folder_id = record
                .folder_id
                .clone()
                .filter(|id| state.folders.iter().any(|f| &f.id == id));
            let m = InstalledMod {
                enabled: false,
                folder_id,
                ..record.clone()
            };
            state.mods.push(m.clone());
            save_state(install.state_path, &state).map_err(|e| e.to_string())?;
            m
        }
    };
    let slot = install.off_slot(&state.folders, &m)?;
    let parked_dir = store.parked_dir(&m)?;
    let source = parked_dir.join(slot.file_name().expect("a mod path names a file"));
    if exists(&source)? && !exists(&slot)? {
        install.move_files(&m, source, slot)?;
    }
    // remove_dir leaves a folder that still holds something, which is then kept for review.
    fs::remove_dir(&parked_dir).ok();
    let parked = store.parked()?;
    store.save_parked(
        parked
            .into_iter()
            .filter(|p| p.install_id != m.install_id)
            .collect(),
    )
}

/// Takes away the folders the profile does not have and puts back the ones it has. A folder a
/// mod that stays live sits in is kept with its parents, since those mods stay in every
/// profile. A folder arriving gets its directory, which an empty folder needs to outlast the
/// next scan.
fn settle_folders(install: &Install, wanted: &[ModFolder]) -> Result<(), String> {
    let mut state = install.read()?;
    let wanted_ids: HashSet<&str> = wanted.iter().map(|f| f.id.as_str()).collect();
    let mut kept: HashSet<String> = state
        .mods
        .iter()
        .filter_map(|m| m.folder_id.clone())
        .collect();
    loop {
        let parents: Vec<String> = state
            .folders
            .iter()
            .filter(|f| kept.contains(&f.id))
            .filter_map(|f| f.parent_id.clone())
            .filter(|id| !kept.contains(id))
            .collect();
        if parents.is_empty() {
            break;
        }
        kept.extend(parents);
    }
    let leaving: HashSet<String> = state
        .folders
        .iter()
        .filter(|f| !wanted_ids.contains(f.id.as_str()) && !kept.contains(&f.id))
        .map(|f| f.id.clone())
        .collect();
    let mut gone_dirs: Vec<String> = leaving
        .iter()
        .filter_map(|id| get_folder_path(&state.folders, Some(id)))
        .collect();
    let present: HashSet<String> = state.folders.iter().map(|f| f.id.clone()).collect();
    let arriving: Vec<ModFolder> = wanted
        .iter()
        .filter(|f| !present.contains(&f.id))
        .cloned()
        .collect();
    if leaving.is_empty() && arriving.is_empty() {
        return Ok(());
    }
    state.folders.retain(|f| !leaving.contains(&f.id));
    state.folders.extend(arriving.iter().cloned());
    save_state(install.state_path, &state).map_err(|e| e.to_string())?;

    // Deepest first, so a parent is empty by the time its turn comes. remove_dir leaves a
    // directory that still holds something, which the scan then shows rather than losing it.
    gone_dirs.sort_by_key(|rel| std::cmp::Reverse(rel.matches('/').count()));
    for rel in &gone_dirs {
        for target in install.cfg.targets {
            for base in [
                mods_base(install.game_path, target),
                disabled_base(install.game_path, target),
            ] {
                fs::remove_dir(base.join(rel)).ok();
            }
        }
    }
    for f in &arriving {
        let rel = get_folder_path(&state.folders, Some(&f.id))
            .expect("a folder that is in the state has a path");
        let dir = mods_base(install.game_path, install.cfg.primary()).join(rel);
        fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create the folder {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Brings this copy of the game to a profile: parks what it does not have and brings back
/// what it has, then sets enabled flags, folders and order through the per-mod operations.
///
/// Disabling runs first and enabling last, so two mods that claim the same file are never on
/// at once in between. Only decided records are touched. Each half fixes that set before its
/// first operation, since every operation rewrites the state the later reads return, and the
/// second half scans again because the mods brought back may have lost files while parked.
fn apply(store: &ProfileStore, install: &Install, target: &Profile) -> Result<(), String> {
    let wanted: HashMap<&str, &ProfileMember> = target
        .members
        .iter()
        .map(|m| (m.install_id.as_str(), m))
        .collect();
    let enabled_in_profile =
        |m: &InstalledMod| wanted.get(m.install_id.as_str()).is_some_and(|w| w.enabled);

    let scanned = install.scan()?.mods;
    let leaving = decided(install.cfg, &scanned);
    for m in &leaving {
        if m.enabled && !enabled_in_profile(m) {
            disable_mod_op(
                install.game_path,
                install.state_path,
                &m.uid,
                install.cfg,
                install.launcher,
            )?;
        }
    }
    // A record in both lists was being parked when a switch stopped. Its files may already be
    // parked, which the scan reads as missing, so it is settled whatever the scan says.
    let halfway: HashSet<String> = store.parked()?.into_iter().map(|m| m.install_id).collect();
    let halfway = scanned.iter().filter(|m| halfway.contains(&m.install_id));
    for m in leaving.iter().chain(halfway) {
        if !wanted.contains_key(m.install_id.as_str()) && parkable(install.cfg, m) {
            park(store, install, &m.uid)?;
        }
    }
    settle_folders(install, &target.folders)?;
    for record in store.parked()? {
        if wanted.contains_key(record.install_id.as_str()) {
            unpark(store, install, &record)?;
        }
    }

    let switchable: HashSet<String> = decided(install.cfg, &install.scan()?.mods)
        .into_iter()
        .map(|m| m.uid)
        .collect();
    let switchable = |m: &InstalledMod| switchable.contains(&m.uid);

    let state = install.read()?;
    let folders: HashSet<&str> = state.folders.iter().map(|f| f.id.as_str()).collect();
    for m in state.mods.iter().filter(|m| switchable(m)) {
        let Some(want) = wanted.get(m.install_id.as_str()) else {
            continue;
        };
        // A folder deleted since the profile was saved leaves the mod where it is.
        let folder_exists = want
            .folder_id
            .as_deref()
            .is_none_or(|id| folders.contains(id));
        if want.folder_id != m.folder_id && folder_exists {
            move_mod_to_folder_op(
                install.game_path,
                install.state_path,
                &m.uid,
                want.folder_id.clone(),
                0,
                install.cfg,
            )?;
        }
    }

    let state = install.read()?;
    for (folder_id, ordered) in profile_order(&state.mods, &wanted) {
        reorder_mods_in_folder_op(
            install.game_path,
            install.state_path,
            folder_id.as_deref(),
            &ordered,
            install.cfg,
        )?;
    }

    let state = install.read()?;
    for m in state.mods.iter().filter(|m| switchable(m)) {
        if !m.enabled && enabled_in_profile(m) {
            enable_mod_op(
                install.game_path,
                install.state_path,
                &m.uid,
                install.cfg,
                install.launcher,
            )?;
        }
    }
    Ok(())
}

/// The folders whose order the profile changes, each with its mods highest priority first, as
/// reorder_mods_in_folder_op takes them. A mod the profile does not place keeps its own
/// priority, and ties keep the current order.
fn profile_order(
    mods: &[InstalledMod],
    wanted: &HashMap<&str, &ProfileMember>,
) -> Vec<(Option<String>, Vec<String>)> {
    let mut by_folder: HashMap<Option<String>, Vec<&InstalledMod>> = HashMap::new();
    // A host pack sits inside another mod's folder, where no priority prefix belongs.
    for m in mods.iter().filter(|m| !is_host_pack(m)) {
        by_folder.entry(m.folder_id.clone()).or_default().push(m);
    }
    let mut changes = Vec::new();
    for (folder_id, mut in_folder) in by_folder {
        in_folder.sort_by_key(|m| std::cmp::Reverse(m.priority.unwrap_or(0)));
        let current: Vec<&str> = in_folder.iter().map(|m| m.uid.as_str()).collect();
        let desired_priority = |m: &InstalledMod| {
            wanted
                .get(m.install_id.as_str())
                .and_then(|w| w.priority)
                .or(m.priority)
                .unwrap_or(0)
        };
        in_folder.sort_by_key(|m| std::cmp::Reverse(desired_priority(m)));
        let ordered: Vec<String> = in_folder.iter().map(|m| m.uid.clone()).collect();
        if ordered
            .iter()
            .map(String::as_str)
            .ne(current.iter().copied())
        {
            changes.push((folder_id, ordered));
        }
    }
    changes
}

/// Mods set aside for a launch without mods are not where any operation expects them.
fn refuse_while_set_aside(install: &Install) -> Result<(), String> {
    let set_aside = install
        .cfg
        .targets
        .iter()
        .filter(|t| t.shared_paks.is_none())
        .any(|t| set_aside_dir(install.game_path, t).is_some());
    if set_aside {
        return Err("Mods are set aside for a launch without mods. Start the game normally once to restore them, then switch profiles.".to_string());
    }
    Ok(())
}

fn refuse_while_unfinished(store: &ProfileStore, action: &str) -> Result<(), String> {
    if store.pending()?.is_some() {
        return Err(format!(
            "A profile switch stopped part way. Finish it or switch to another profile, then {action}."
        ));
    }
    Ok(())
}

/// Switches this copy of the game to a profile. The caller holds the game state lock and has
/// checked that the game is not running.
///
/// After a stopped switch the mods match no profile, and the profile that switch left was
/// saved when it began, so nothing is saved from them. Any profile can then be the target,
/// which keeps a profile that cannot be applied from holding every other switch back.
pub(crate) fn switch(
    store: &ProfileStore,
    install: &Install,
    profile_id: &str,
) -> Result<(), String> {
    refuse_while_set_aside(install)?;
    let unfinished = store.pending()?.is_some();
    if !unfinished {
        let live = install.scan()?;
        if save_active(store, install, &live)?.is_none()
            && decided(install.cfg, &live.mods)
                .iter()
                .any(|m| parkable(install.cfg, m))
        {
            // Parked mods are only ever brought back by a profile that lists them.
            return Err(
                "No profile is active. Save the current setup as a profile first, so its mods are not lost."
                    .to_string(),
            );
        }
    }
    let target = store.get(profile_id)?;
    store.begin(&Journal {
        profile_id: target.id.clone(),
    })?;
    log::info!(
        "profiles: switching {} to '{}'",
        install.cfg.game_id,
        target.name
    );
    apply(store, install, &target)?;
    store.set_active(Some(&target.id))?;
    store.finish()
}

pub(crate) fn list(store: &ProfileStore) -> Result<ProfileList, String> {
    let profiles = store.list()?;
    let active = store
        .active()?
        .filter(|id| profiles.iter().any(|p| &p.id == id));
    Ok(ProfileList {
        profiles: profiles
            .into_iter()
            .map(|p| ProfileSummary {
                id: p.id,
                name: p.name,
            })
            .collect(),
        active,
        unfinished_switch: store.pending()?.map(|j| j.profile_id),
    })
}

/// Creates a profile. One made from the current setup while no profile is active becomes the
/// active one, since it describes exactly what is installed.
pub(crate) fn create(
    store: &ProfileStore,
    install: &Install,
    name: &str,
    source: ProfileSource,
) -> Result<ProfileSummary, String> {
    let name = checked_name(name)?;
    // The active profile is saved from the live setup first, and set aside it reads as empty.
    refuse_while_set_aside(install)?;
    // A stopped switch leaves a mix of two profiles, which neither saving nor copying may keep.
    refuse_while_unfinished(store, "create the profile")?;
    let live = install.scan()?;
    let active = save_active(store, install, &live)?;
    let (members, folders) = match &source {
        ProfileSource::Current => match &active {
            Some(id) => {
                let active = store.get(id)?;
                (active.members, active.folders)
            }
            None => (
                snapshot(install.cfg, &[], &decided(install.cfg, &live.mods)),
                live.folders,
            ),
        },
        ProfileSource::Empty => (Vec::new(), Vec::new()),
        ProfileSource::Copy { profile_id } => {
            let copied = store.get(profile_id)?;
            (copied.members, copied.folders)
        }
    };
    let profile = Profile {
        id: Uuid::new_v4().to_string(),
        name,
        members,
        folders,
    };
    store.save(&profile)?;
    if matches!(source, ProfileSource::Current) && active.is_none() {
        store.set_active(Some(&profile.id))?;
    }
    Ok(ProfileSummary {
        id: profile.id,
        name: profile.name,
    })
}

pub(crate) fn rename(store: &ProfileStore, profile_id: &str, name: &str) -> Result<(), String> {
    let mut profile = store.get(profile_id)?;
    profile.name = checked_name(name)?;
    store.save(&profile)
}

/// Deletes a profile and the parked mods no other profile has. Deleting the active one leaves
/// its mods installed, with no profile active. The target of a stopped switch stays, since the
/// banner that finishes the switch names it.
pub(crate) fn delete(store: &ProfileStore, profile_id: &str) -> Result<(), String> {
    if store
        .pending()?
        .is_some_and(|journal| journal.profile_id == profile_id)
    {
        return Err(
            "A profile switch to this profile stopped part way. Finish it or switch to another profile, then delete it."
                .to_string(),
        );
    }
    if store.active()?.as_deref() == Some(profile_id) {
        store.set_active(None)?;
    }
    store.delete(profile_id)?;
    let kept: HashSet<String> = store
        .list()?
        .into_iter()
        .flat_map(|p| p.members)
        .map(|m| m.install_id)
        .collect();
    let (stays, orphans): (Vec<InstalledMod>, Vec<InstalledMod>) = store
        .parked()?
        .into_iter()
        .partition(|m| kept.contains(&m.install_id));
    for m in &orphans {
        let dir = store.parked_dir(m)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("could not remove the files of '{}': {e}", m.name)),
        }
    }
    if !orphans.is_empty() {
        store.save_parked(stays)?;
    }
    Ok(())
}

/// Takes an uninstalled mod out of every profile.
pub(crate) fn forget(store: &ProfileStore, install_id: &str) -> Result<(), String> {
    for mut profile in store.list()? {
        let before = profile.members.len();
        profile.members.retain(|m| m.install_id != install_id);
        if profile.members.len() != before {
            store.save(&profile)?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "profiles_tests.rs"]
mod tests;
