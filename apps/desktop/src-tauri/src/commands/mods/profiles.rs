//! Per-game mod profiles, kept in the game's .modrex folder.
//!
//! Each profile has its own mods and its own app folders, and no two profiles share a mod, so
//! Duplicate copies the files. Every profile has a folder, .modrex/profiles/<name>, holding its
//! profile.json. The mods of the active profile are installed as usual. The mods of every other
//! profile are parked in that profile's folder under plain names, outside every folder the game
//! loads, with their records in its profile.json, so the Installed page and every scan see only
//! the active profile. A profile's app folders live in its file and are put in place, empty
//! directories and all, when it becomes active.
//!
//! A profile lists installations by install_id, with the enabled flag, folder and order each
//! had. The live profile is never read back from its file. The file is a snapshot taken when
//! the user switches away, and every live mod is a member, so a new install joins the active
//! profile without any install path knowing about profiles. A live record whose files are
//! missing belongs to no profile and keeps what each profile already said about it. A loader
//! tracked as a mod (PDML) is a member like any other. A loader Modrex installs as loose files
//! (UE4SS, SuperBLT, DAHM, RAID-SuperBLT) is listed by id and shared, and leaving it out moves
//! only the files that hook it into the game, which loaders.rs names, to .modrex/loaders. A new
//! profile starts without loaders unless the user keeps the installed ones.
//! Ready or Not's mods share Paks with the game's own files, so its mods leave Paks for a
//! profile's folder only through the native-file guard, which accepts that folder and nothing
//! else outside Paks.
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
use super::engine::{modrex_dir, set_aside_dir, Activation, ModEngineConfig, ModUnit};
use super::install::{copy_dir_all, disable_mod_op, enable_mod_op, is_host_pack};
use super::moves::Moves;
use super::naming::{sidecar_path, strip_priority_prefix};
use super::paths::{
    active_mod_path, disabled_base, disabled_mod_path, host_pack_dir, host_pack_disabled_dir,
    mods_base,
};
use super::reorder::{move_mod_to_folder_op, reorder_mods_in_folder_op};
use super::resource_state::write_atomic;
use super::state::{get_folder_path, read_state_for_game, reconcile_state, save_state};
use super::types::{InstalledMod, ModFolder, ModsState};
use super::zip::safe_dest;
use crate::commands::loaders::{hook_files, loader_spec, scoped_bindings, LoaderSpec};

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    // The profile's folder, set when it is read or placed, never written into its own file.
    #[serde(skip)]
    pub(super) dir: PathBuf,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) pending: Vec<super::share::import::PendingReference>,
    pub id: String,
    pub name: String,
    pub members: Vec<ProfileMember>,
    #[serde(default)]
    pub folders: Vec<ModFolder>,
    /// The loose-file loaders this profile has, by loader id. None in a profile saved before
    /// profiles held loaders, and switching to it then leaves loaders as they are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loaders: Option<Vec<String>>,
    /// The mods this profile keeps in its folder while another profile is active.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) parked: Vec<ParkedMod>,
}

/// A mod of a profile that is not active: its record, and the name its files are kept under in
/// the profile's folder. The name is recorded rather than derived, since a clash with another
/// mod of the same name adds a number to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ParkedMod {
    pub(super) stored: String,
    pub(super) record: InstalledMod,
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
struct LeftOut {
    loaders: Vec<ParkedLoader>,
}

/// A loader left out of the active profile: the files moved away, relative to the game folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParkedLoader {
    id: String,
    files: Vec<String>,
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
    /// The installed loaders a new profile can keep, by name.
    pub loaders: Vec<String>,
    /// The shared mods the active profile is still waiting for.
    pub pending: Vec<super::share::import::PendingShareMember>,
}

/// What a new profile starts as.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProfileSource {
    /// The mods as they are installed right now.
    Current,
    /// No mods, so switching to it parks every mod, and the installed loaders too unless kept.
    #[serde(rename_all = "camelCase")]
    Empty { keep_loaders: bool },
    /// A copy of another profile's mods, files and all.
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

/// A profile id is only ever compared, but one read from a file is checked like any input.
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

/// A name the file system accepts as one folder or file, for a profile or a stored mod. Windows
/// refuses these characters, a trailing dot or space, and the old device names.
fn plain_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.ends_with(|c: char| c.is_ascii_digit()));
    if cleaned.is_empty() || reserved {
        return format!("{fallback} {cleaned}").trim().to_string();
    }
    cleaned
}

fn exists(path: &Path) -> Result<bool, String> {
    path.try_exists()
        .map_err(|e| format!("could not check {}: {e}", path.display()))
}

const PROFILE_FILE: &str = "profile.json";
const PROFILES_DIR: &str = "profiles";

/// The folder holding every profile's folder, which the native-file guard lets a stored mod
/// move into and out of.
pub(super) fn store_dir(game_path: &str) -> PathBuf {
    modrex_dir(game_path).join(PROFILES_DIR)
}

/// The profiles, their stored mods, the left-out loaders and the switch journal of one copy of
/// a game, in its .modrex folder.
pub(crate) struct ProfileStore {
    root: PathBuf,
}

impl ProfileStore {
    pub(crate) fn new(game_path: &str) -> Self {
        Self {
            root: modrex_dir(game_path),
        }
    }

    fn profiles_dir(&self) -> PathBuf {
        self.root.join(PROFILES_DIR)
    }

    /// Every profile, each with its folder. A folder without a profile file is not a profile.
    pub(crate) fn list(&self) -> Result<Vec<Profile>, String> {
        let entries = match fs::read_dir(self.profiles_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("could not read the profiles: {e}")),
        };
        let mut profiles = Vec::new();
        for entry in entries {
            let dir = entry
                .map_err(|e| format!("could not read the profiles: {e}"))?
                .path();
            let file = dir.join(PROFILE_FILE);
            if !dir.is_dir() || !exists(&file)? {
                continue;
            }
            let mut profile: Profile = read_versioned(&file)?;
            checked_id(&profile.id)?;
            profile.dir = dir;
            profiles.push(profile);
        }
        // A profile folder copied by hand holds the same profile twice. Saving through either
        // would change what the other means, so neither is used until one is removed.
        let mut seen: HashMap<&str, &Path> = HashMap::new();
        for p in &profiles {
            if let Some(other) = seen.insert(&p.id, &p.dir) {
                return Err(format!(
                    "{} and {} hold the same profile. Remove one of them.",
                    other.display(),
                    p.dir.display()
                ));
            }
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

    pub(super) fn find(&self, id: &str) -> Result<Option<Profile>, String> {
        checked_id(id)?;
        Ok(self.list()?.into_iter().find(|p| p.id == id))
    }

    pub(crate) fn save(&self, profile: &Profile) -> Result<(), String> {
        assert!(
            profile.dir.starts_with(self.profiles_dir()),
            "a profile is placed before it is saved"
        );
        fs::create_dir_all(&profile.dir)
            .map_err(|e| format!("could not create {}: {e}", profile.dir.display()))?;
        write_versioned(&profile.dir.join(PROFILE_FILE), profile)
    }

    /// A free folder for a profile named this. Two profiles may share a name, so the second
    /// folder gets a number.
    fn free_dir(&self, name: &str) -> Result<PathBuf, String> {
        let base = plain_name(name, "Profile");
        for n in 1.. {
            let candidate = match n {
                1 => base.clone(),
                n => format!("{base} ({n})"),
            };
            let dir = self.profiles_dir().join(candidate);
            if !exists(&dir)? {
                return Ok(dir);
            }
        }
        unreachable!("some numbered folder name is free")
    }

    pub(super) fn place(&self, profile: &mut Profile) -> Result<(), String> {
        profile.dir = self.free_dir(&profile.name)?;
        self.save(profile)
    }

    /// Renames a profile and its folder. The folder moves first, so a stop leaves the old name
    /// on a folder Modrex still finds by the file inside it.
    fn rename(&self, profile: &mut Profile, name: String) -> Result<(), String> {
        let base = plain_name(&name, "Profile").to_lowercase();
        let current = profile
            .dir
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase());
        // A folder already carrying the name, numbered or in another case, keeps it. Windows
        // compares names without case, so moving it would only number it again.
        let keeps = current.is_some_and(|c| {
            c == base
                || c.strip_prefix(&format!("{base} ("))
                    .and_then(|n| n.strip_suffix(')'))
                    .is_some_and(|n| n.parse::<u32>().is_ok())
        });
        if !keeps {
            let dir = self.free_dir(&name)?;
            fs::rename(&profile.dir, &dir)
                .map_err(|e| format!("could not rename the profile folder: {e}"))?;
            profile.dir = dir;
        }
        profile.name = name;
        self.save(profile)
    }

    fn delete(&self, profile: &Profile) -> Result<(), String> {
        match fs::remove_dir_all(&profile.dir) {
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

    /// The records of every parked mod, of every profile.
    pub(super) fn parked(&self) -> Result<Vec<InstalledMod>, String> {
        Ok(self
            .list()?
            .into_iter()
            .flat_map(|p| p.parked.into_iter().map(|parked| parked.record))
            .collect())
    }

    fn loaders_dir(&self) -> PathBuf {
        self.root.join("loaders")
    }

    fn parked_loaders(&self) -> Result<Vec<ParkedLoader>, String> {
        let path = self.loaders_dir().join("left-out.json");
        if !exists(&path)? {
            return Ok(Vec::new());
        }
        Ok(read_versioned::<LeftOut>(&path)?.loaders)
    }

    pub(super) fn has_parked_loader(&self, id: &str) -> Result<bool, String> {
        let Some(loader) = self.parked_loaders()?.into_iter().find(|p| p.id == id) else {
            return Ok(false);
        };
        let dir = self.parked_loader_dir(id)?;
        for rel in &loader.files {
            let path = safe_dest(&dir, rel)
                .ok_or_else(|| format!("the parked {id} names a path outside the game"))?;
            if !exists(&path)? {
                return Ok(false);
            }
        }
        Ok(!loader.files.is_empty())
    }

    fn save_parked_loaders(&self, loaders: Vec<ParkedLoader>) -> Result<(), String> {
        write_versioned(
            &self.loaders_dir().join("left-out.json"),
            &LeftOut { loaders },
        )
    }

    /// Where a left-out loader's files sit, beside the record of what its install created.
    /// The id names a folder, so it has to be a known loader.
    fn parked_loader_dir(&self, id: &str) -> Result<PathBuf, String> {
        loader_spec(id).ok_or_else(|| format!("'{id}' is not a loader Modrex knows"))?;
        Ok(self.loaders_dir().join(id))
    }
}

/// What a switch needs from the caller beyond the target: which copy and how to toggle there.
pub(crate) struct Install<'a> {
    pub game_path: &'a str,
    pub state_path: &'a Path,
    pub cfg: &'static ModEngineConfig,
    pub launcher: Option<&'a str>,
}

impl Install<'_> {
    pub(super) fn read(&self) -> Result<ModsState, String> {
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

/// The live records profiles decide, see the module comment.
fn decided(mods: &[InstalledMod]) -> Vec<InstalledMod> {
    mods.iter()
        .filter(|m| m.missing != Some(true))
        .cloned()
        .collect()
}

/// The members a profile has once the decided live records are written back into it: every
/// one of them. Members with no live record stay as they were, since the record may be missing
/// or parked.
fn snapshot(previous: &[ProfileMember], live: &[InstalledMod]) -> Vec<ProfileMember> {
    let present: HashSet<&str> = live.iter().map(|m| m.install_id.as_str()).collect();
    live.iter()
        .map(ProfileMember::of)
        .chain(
            previous
                .iter()
                .filter(|p| !present.contains(p.install_id.as_str()))
                .cloned(),
        )
        .collect()
}

/// The loose-file loaders installed in this copy that a profile can leave out, each with the
/// files that hook it into the game.
fn live_loaders(install: &Install) -> Result<Vec<(&'static LoaderSpec, Vec<PathBuf>)>, String> {
    let mut live: Vec<(&'static LoaderSpec, Vec<PathBuf>)> = Vec::new();
    for (game_id, spec, _) in scoped_bindings() {
        if game_id != install.cfg.game_id || live.iter().any(|(seen, _)| seen.id == spec.id) {
            continue;
        }
        if let Some(files) = hook_files(spec, game_id, install.game_path, install.launcher)? {
            live.push((spec, files));
        }
    }
    Ok(live)
}

fn live_loader_ids(install: &Install) -> Result<Vec<String>, String> {
    Ok(live_loaders(install)?
        .into_iter()
        .map(|(spec, _)| spec.id.to_string())
        .collect())
}

/// The name of the loader a record was installed from, when it is one (PDML).
fn loader_record_name(cfg: &ModEngineConfig, m: &InstalledMod) -> Option<&'static str> {
    if m.source != "modworkshop" {
        return None;
    }
    let remote_id: i64 = m.remote_id.as_deref()?.parse().ok()?;
    scoped_bindings()
        .into_iter()
        .find(|(game_id, _, ids)| *game_id == cfg.game_id && ids.contains(&remote_id))
        .map(|(_, spec, _)| spec.name)
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
    capture_live(&mut profile, install, live)?;
    store.save(&profile)?;
    Ok(Some(id))
}

fn capture_live(profile: &mut Profile, install: &Install, live: &ModsState) -> Result<(), String> {
    profile.members = snapshot(&profile.members, &decided(&live.mods));
    profile.folders = live.folders.clone();
    profile.loaders = Some(live_loader_ids(install)?);
    Ok(())
}

pub(super) fn share_snapshot(
    install: &Install,
    profile_id: &str,
) -> Result<(Profile, Vec<InstalledMod>), String> {
    let store = ProfileStore::new(install.game_path);
    let mut profile = store.get(profile_id)?;
    let primary = install.cfg.primary();
    let hidden = set_aside_dir(install.game_path, primary)
        .filter(|_| primary.shared_paks.is_none())
        .map(|dir| super::state::hidden_state_path(&dir, install.state_path, install.cfg));
    // Reconciliation can rename files. Export only needs the current installation records.
    let live = read_state_for_game(
        install.game_path,
        hidden.as_deref().unwrap_or(install.state_path),
        install.cfg,
    )
    .map_err(|e| e.to_string())?;
    let mut records = if store.active()?.as_deref() == Some(profile_id) {
        refuse_while_unfinished(&store, "share the active profile")?;
        capture_live(&mut profile, install, &live)?;
        live.mods
    } else {
        let mut records: Vec<InstalledMod> =
            profile.parked.iter().map(|p| p.record.clone()).collect();
        // A stopped switch can leave both records. The live record wins the join.
        records.extend(live.mods);
        records
    };
    for record in &mut records {
        super::state::restore_legacy_catalog_ids(record);
    }
    Ok((profile, records))
}

/// The profile a live mod belongs to. No two profiles share a mod, so it is the one that lists
/// it. A mod installed while a stopped switch had saved nothing belongs to the profile that
/// was active.
fn owner_of(store: &ProfileStore, install_id: &str) -> Result<Profile, String> {
    let profiles = store.list()?;
    let listed = |p: &Profile| {
        p.members.iter().any(|m| m.install_id == install_id)
            || p.parked.iter().any(|m| m.record.install_id == install_id)
    };
    if let Some(owner) = profiles.iter().find(|p| listed(p)) {
        return Ok(owner.clone());
    }
    let active = store.active()?;
    profiles
        .into_iter()
        .find(|p| Some(&p.id) == active.as_ref())
        .ok_or_else(|| "this mod belongs to no profile".to_string())
}

/// The plain name a mod's files are kept under in its profile's folder: the file or folder
/// name without the load-order prefix or the disabled suffix, or the mod's name for a bundle,
/// whose files are a tree of their own. A clash with another stored mod, or with the profile
/// file, numbers it, before the extension for a file so its companions follow.
fn stored_name(install: &Install, m: &InstalledMod, from: &Path, profile: &Profile) -> String {
    let target = install.cfg.mod_target(m);
    let base = if target.is_bundle() {
        plain_name(&m.name, "Mod")
    } else {
        let name = from
            .file_name()
            .expect("a mod path names a file")
            .to_string_lossy()
            .into_owned();
        let name = name.strip_suffix(target.disabled_suffix()).unwrap_or(&name);
        if target.priority_prefix_enabled() {
            strip_priority_prefix(name).to_string()
        } else {
            name.to_string()
        }
    };
    let taken = |candidate: &str| {
        candidate.eq_ignore_ascii_case(PROFILE_FILE)
            || profile
                .parked
                .iter()
                .any(|p| p.stored.eq_ignore_ascii_case(candidate))
            || profile.dir.join(candidate).exists()
    };
    let (stem, ext) = match (&target.unit, base.rsplit_once('.')) {
        (ModUnit::File { .. }, Some((stem, ext))) => (stem.to_string(), format!(".{ext}")),
        _ => (base.clone(), String::new()),
    };
    (1..)
        .map(|n| match n {
            1 => base.clone(),
            n => format!("{stem} ({n}){ext}"),
        })
        .find(|candidate| !taken(candidate))
        .expect("some numbered name is free")
}

/// Takes a mod that is off out of the game into its profile's folder: the record goes to the
/// profile first, then the files move, and the state drops the record last, so a stop at any
/// point leaves the mod in both lists, which the next switch settles.
fn park(store: &ProfileStore, install: &Install, uid: &str) -> Result<(), String> {
    let state = install.read()?;
    let Some(m) = state.mods.iter().find(|m| m.uid == uid).cloned() else {
        return Ok(());
    };
    let mut owner = owner_of(store, &m.install_id)?;
    let slot = install.off_slot(&state.folders, &m)?;
    let stored = match owner
        .parked
        .iter()
        .find(|p| p.record.install_id == m.install_id)
    {
        Some(parked) => parked.stored.clone(),
        None => {
            let stored = stored_name(install, &m, &slot, &owner);
            owner.parked.push(ParkedMod {
                stored: stored.clone(),
                record: m.clone(),
            });
            store.save(&owner)?;
            stored
        }
    };
    let dest = owner.dir.join(stored);
    if exists(&slot)? && !exists(&dest)? {
        install.move_files(&m, slot, dest)?;
    }
    let rest = ModsState {
        folders: state.folders,
        mods: state.mods.into_iter().filter(|r| r.uid != uid).collect(),
    };
    save_state(install.state_path, &rest).map_err(|e| e.to_string())
}

/// Brings a parked mod of a profile back, off: the state gains the record first, then the files
/// move, and the profile drops it last. A record found in both lists is finished the same way.
fn unpark(
    store: &ProfileStore,
    install: &Install,
    profile_id: &str,
    parked: &ParkedMod,
) -> Result<(), String> {
    let record = &parked.record;
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
    let mut profile = store.get(profile_id)?;
    let slot = install.off_slot(&state.folders, &m)?;
    let source = profile.dir.join(&parked.stored);
    if exists(&source)? && !exists(&slot)? {
        install.move_files(&m, source, slot)?;
    }
    profile
        .parked
        .retain(|p| p.record.install_id != m.install_id);
    store.save(&profile)
}

/// Copies one mod's files, as they are now, to a stored name in another profile's folder: a
/// file with its companions, a folder, or a bundle's tree. A bundle that is on has its files
/// spread over the game folder, which its record lists.
fn copy_files(install: &Install, m: &InstalledMod, from: &Path, to: &Path) -> Result<(), String> {
    let target = install.cfg.mod_target(m);
    let failed = |e: String| format!("could not copy the files of '{}': {e}", m.name);
    if target.is_bundle() && m.enabled && !from.starts_with(modrex_dir(install.game_path)) {
        let root = Path::new(install.game_path);
        for file in m.bundle.as_deref().unwrap_or_default() {
            let outside = || failed(format!("{} is outside the game", file.path));
            let src = safe_dest(root, &file.path).ok_or_else(outside)?;
            let dst = safe_dest(to, &file.path).ok_or_else(outside)?;
            let parent = dst.parent().expect("a bundle file has a folder");
            fs::create_dir_all(parent).map_err(|e| failed(e.to_string()))?;
            fs::copy(&src, &dst).map_err(|e| failed(e.to_string()))?;
        }
        return Ok(());
    }
    if from.is_dir() {
        return copy_dir_all(from, to).map_err(failed);
    }
    let mut pairs = vec![(from.to_path_buf(), to.to_path_buf())];
    if let ModUnit::File { extension, .. } = &target.unit {
        for ext in target.companions {
            if let (Some(a), Some(b)) = (
                sidecar_path(from, extension, ext),
                sidecar_path(to, extension, ext),
            ) {
                pairs.push((a, b));
            }
        }
    }
    for (src, dst) in pairs {
        if src == from || exists(&src)? {
            fs::copy(&src, &dst).map_err(|e| failed(e.to_string()))?;
        }
    }
    Ok(())
}

/// Where the mods a new profile copies are now: installed, for the active profile and for
/// kept loaders, or stored in an inactive profile's folder.
enum Origin<'a> {
    Live,
    Stored(&'a Profile),
}

/// Gives a new profile its own copy of each of these members, under new install ids.
fn copy_members(
    install: &Install,
    origin: Origin,
    members: &[ProfileMember],
    live: &ModsState,
    copy: &mut Profile,
) -> Result<(), String> {
    for member in members {
        // A mod whose files are missing has nothing to copy, so the copy leaves it out.
        let live_record = live
            .mods
            .iter()
            .find(|m| m.install_id == member.install_id && m.missing != Some(true));
        let found = match origin {
            Origin::Live => live_record.map(|record| {
                let from = if record.enabled {
                    live_path(install, live, record)
                } else {
                    install.off_slot(&live.folders, record)
                };
                (record, from)
            }),
            Origin::Stored(source) => source
                .parked
                .iter()
                .find(|p| p.record.install_id == member.install_id)
                .map(|p| (&p.record, Ok(source.dir.join(&p.stored)))),
        };
        // A member with no record has no files to copy, which is how a missing mod reads.
        let Some((record, from)) = found else {
            continue;
        };
        let from = from?;
        if !exists(&from)? {
            return Err(format!(
                "'{}' is missing its files, so the profile cannot be copied",
                record.name
            ));
        }
        let stored = stored_name(install, record, &from, copy);
        fs::create_dir_all(&copy.dir)
            .map_err(|e| format!("could not create {}: {e}", copy.dir.display()))?;
        copy_files(install, record, &from, &copy.dir.join(&stored))?;
        let install_id = Uuid::new_v4().to_string();
        copy.parked.push(ParkedMod {
            stored,
            record: InstalledMod {
                install_id: install_id.clone(),
                enabled: false,
                ..record.clone()
            },
        });
        copy.members.push(ProfileMember {
            install_id,
            ..member.clone()
        });
    }
    Ok(())
}

/// Where a mod that is on keeps its files: a bundle's are spread over the game folder, which
/// copy_files reads from its record.
fn live_path(install: &Install, live: &ModsState, m: &InstalledMod) -> Result<PathBuf, String> {
    let target = install.cfg.mod_target(m);
    if target.is_bundle() {
        return Ok(PathBuf::from(install.game_path));
    }
    if is_host_pack(m) {
        return host_pack_dir(install.game_path, install.cfg, &live.mods, &live.folders, m)
            .ok_or_else(|| format!("'{}' names no host mod", m.name));
    }
    let rel = get_folder_path(&live.folders, m.folder_id.as_deref());
    Ok(active_mod_path(
        install.game_path,
        &m.filename,
        rel.as_deref(),
        target,
    ))
}

/// Moves a loader's hook files out of the game: the record goes to left-out.json first, then
/// each file moves, so a stop leaves the loader recorded with some files still in place, which the
/// next switch moves on.
fn park_loader(
    store: &ProfileStore,
    install: &Install,
    id: &str,
    files: &[PathBuf],
) -> Result<(), String> {
    let root = Path::new(install.game_path);
    let rel: Vec<String> = files
        .iter()
        .map(|file| {
            file.strip_prefix(root)
                .expect("hook files sit inside the game folder")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    let mut parked = store.parked_loaders()?;
    if !parked.iter().any(|p| p.id == id) {
        parked.push(ParkedLoader {
            id: id.to_string(),
            files: rel.clone(),
        });
        store.save_parked_loaders(parked)?;
    }
    let dir = store.parked_loader_dir(id)?;
    for rel in &rel {
        let from = root.join(rel);
        let to = dir.join(rel);
        if !exists(&from)? || exists(&to)? {
            continue;
        }
        let parent = to.parent().expect("a parked file has a folder");
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not prepare {}: {e}", parent.display()))?;
        fs::rename(&from, &to).map_err(|e| format!("could not park {rel}: {e}"))?;
        remove_empty_folders(from.parent(), root);
    }
    Ok(())
}

/// Puts a parked loader's files back. A file the loader has again in the game, installed
/// while it was parked, wins over the parked copy, which is then dropped.
fn unpark_loader(
    store: &ProfileStore,
    install: &Install,
    parked: &ParkedLoader,
) -> Result<(), String> {
    let root = Path::new(install.game_path);
    let dir = store.parked_loader_dir(&parked.id)?;
    for rel in &parked.files {
        let outside = || format!("the parked {} names a path outside the game", parked.id);
        let to = safe_dest(root, rel).ok_or_else(outside)?;
        let from = safe_dest(&dir, rel).ok_or_else(outside)?;
        if !exists(&from)? {
            continue;
        }
        if exists(&to)? {
            fs::remove_file(&from).map_err(|e| format!("could not drop the parked {rel}: {e}"))?;
            continue;
        }
        let parent = to.parent().expect("a loader file has a folder");
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not prepare {}: {e}", parent.display()))?;
        fs::rename(&from, &to).map_err(|e| format!("could not bring back {rel}: {e}"))?;
    }
    match fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("could not tidy {}: {e}", dir.display())),
    }
    let rest = store
        .parked_loaders()?
        .into_iter()
        .filter(|p| p.id != parked.id)
        .collect();
    store.save_parked_loaders(rest)
}

/// Removes the folders a moved file leaves empty, up to the game folder. remove_dir refuses a
/// folder that still holds something, which ends the walk there.
fn remove_empty_folders(mut dir: Option<&Path>, root: &Path) {
    while let Some(current) = dir.filter(|d| *d != root && d.starts_with(root)) {
        if fs::remove_dir(current).is_err() {
            return;
        }
        dir = current.parent();
    }
}

/// Leaves out the loaders a profile does not have and brings back the ones it has. A profile
/// with no loader list leaves loaders as they are.
fn settle_loaders(
    store: &ProfileStore,
    install: &Install,
    wanted: Option<&[String]>,
) -> Result<(), String> {
    let Some(wanted) = wanted else {
        return Ok(());
    };
    for (spec, files) in live_loaders(install)? {
        if !wanted.iter().any(|id| id == spec.id) {
            park_loader(store, install, spec.id, &files)?;
        }
    }
    for parked in store.parked_loaders()? {
        if wanted.contains(&parked.id) {
            unpark_loader(store, install, &parked)?;
        }
    }
    Ok(())
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
    let leaving = decided(&scanned);
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
        if !wanted.contains_key(m.install_id.as_str()) {
            park(store, install, &m.uid)?;
        }
    }
    settle_loaders(store, install, target.loaders.as_deref())?;
    settle_folders(install, &target.folders)?;
    for parked in store.get(&target.id)?.parked {
        if wanted.contains_key(parked.record.install_id.as_str()) {
            unpark(store, install, &target.id, &parked)?;
        }
    }

    let switchable: HashSet<String> = decided(&install.scan()?.mods)
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

const SAVE_CURRENT_SETUP: &str =
    "No profile is active. Save the current setup as a profile first, so its mods are not lost.";

fn require_saved_setup(install: &Install, live: &ModsState) -> Result<(), String> {
    if !decided(&live.mods).is_empty() || !live_loaders(install)?.is_empty() {
        return Err(SAVE_CURRENT_SETUP.into());
    }
    Ok(())
}

pub(super) fn require_importable(store: &ProfileStore, install: &Install) -> Result<(), String> {
    refuse_while_set_aside(install)?;
    refuse_while_unfinished(store, "create the profile")?;
    let active = store
        .active()?
        .map(|id| store.find(&id))
        .transpose()?
        .flatten();
    if active.is_none() {
        let live = install.scan()?;
        if !decided(&live.mods).is_empty() {
            return Err(SAVE_CURRENT_SETUP.into());
        }
        require_saved_setup(install, &live)?;
    }
    Ok(())
}

pub(super) fn require_import_target(
    store: &ProfileStore,
    install: &Install,
    id: &str,
) -> Result<(), String> {
    refuse_while_set_aside(install)?;
    refuse_while_unfinished(store, "finish importing")?;
    if store.active()?.as_deref() != Some(id) {
        return Err("The imported profile is no longer active".into());
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
        if save_active(store, install, &live)?.is_none() {
            require_saved_setup(install, &live)?;
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

pub(crate) fn list(store: &ProfileStore, install: &Install) -> Result<ProfileList, String> {
    let profiles = store.list()?;
    let live = install.read()?;
    let mut loaders: Vec<String> = decided(&live.mods)
        .iter()
        .filter_map(|m| loader_record_name(install.cfg, m))
        .chain(
            live_loaders(install)?
                .into_iter()
                .map(|(spec, _)| spec.name),
        )
        .map(str::to_string)
        .collect();
    loaders.dedup();
    let active = store
        .active()?
        .filter(|id| profiles.iter().any(|p| &p.id == id));
    let pending = profiles
        .iter()
        .find(|p| Some(&p.id) == active.as_ref())
        .map(super::share::import::pending_members)
        .unwrap_or_default();
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
        loaders,
        pending,
    })
}

/// Creates a profile. One made from the current setup while no profile is active becomes the
/// active one, since it describes exactly what is installed. With a profile active, the current
/// setup is that profile, which the new one copies like Duplicate does.
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
    let copy_of = match &source {
        ProfileSource::Copy { profile_id } => Some(store.get(profile_id)?),
        ProfileSource::Current => active.as_deref().map(|id| store.get(id)).transpose()?,
        ProfileSource::Empty { .. } => None,
    };
    let mut profile = Profile {
        id: Uuid::new_v4().to_string(),
        name,
        ..Profile::default()
    };
    store.place(&mut profile)?;
    // A copy that stops part way leaves a folder no profile file describes, so it goes.
    if let Err(e) = fill(
        install,
        &source,
        copy_of,
        active.as_deref(),
        &live,
        &mut profile,
    ) {
        store.delete(&profile)?;
        return Err(e);
    }
    store.save(&profile)?;
    if matches!(source, ProfileSource::Current) && active.is_none() {
        store.set_active(Some(&profile.id))?;
    }
    Ok(ProfileSummary {
        id: profile.id,
        name: profile.name,
    })
}

fn fill(
    install: &Install,
    source: &ProfileSource,
    copy_of: Option<Profile>,
    active: Option<&str>,
    live: &ModsState,
    profile: &mut Profile,
) -> Result<(), String> {
    if let Some(source) = copy_of {
        let origin = if active == Some(source.id.as_str()) {
            Origin::Live
        } else {
            Origin::Stored(&source)
        };
        copy_members(install, origin, &source.members, live, profile)?;
        profile.folders = source.folders.clone();
        profile.loaders = source.loaders.clone();
        profile.pending = source.pending.iter().map(|p| p.reissued()).collect();
        return Ok(());
    }
    match source {
        ProfileSource::Empty { keep_loaders: true } => {
            // Kept loaders join as they are installed now: loose files by id, loader mods as
            // copies of their own.
            let kept: Vec<ProfileMember> = decided(&live.mods)
                .iter()
                .filter(|m| loader_record_name(install.cfg, m).is_some())
                .map(|m| ProfileMember {
                    folder_id: None,
                    ..ProfileMember::of(m)
                })
                .collect();
            copy_members(install, Origin::Live, &kept, live, profile)?;
            profile.loaders = Some(live_loader_ids(install)?);
        }
        ProfileSource::Empty {
            keep_loaders: false,
        } => profile.loaders = Some(Vec::new()),
        ProfileSource::Current | ProfileSource::Copy { .. } => {
            profile.members = snapshot(&[], &decided(&live.mods));
            profile.folders = live.folders.clone();
            profile.loaders = Some(live_loader_ids(install)?);
        }
    }
    Ok(())
}

pub(crate) fn rename(store: &ProfileStore, profile_id: &str, name: &str) -> Result<(), String> {
    let mut profile = store.get(profile_id)?;
    store.rename(&mut profile, checked_name(name)?)
}

/// Deletes a profile with its folder, which holds the mods only it has. Deleting the active one
/// leaves its mods installed, with no profile active. The target of a stopped switch stays,
/// since the banner that finishes the switch names it.
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
    let profile = store.get(profile_id)?;
    if store.active()?.as_deref() == Some(profile_id) {
        store.set_active(None)?;
    }
    store.delete(&profile)?;

    let wanted_loaders: HashSet<String> = store
        .list()?
        .into_iter()
        .flat_map(|p| p.loaders.unwrap_or_default())
        .collect();
    let (kept_loaders, orphan_loaders): (Vec<ParkedLoader>, Vec<ParkedLoader>) = store
        .parked_loaders()?
        .into_iter()
        .partition(|l| wanted_loaders.contains(&l.id));
    for loader in &orphan_loaders {
        match fs::remove_dir_all(store.parked_loader_dir(&loader.id)?) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("could not remove the files of {}: {e}", loader.id)),
        }
    }
    if !orphan_loaders.is_empty() {
        store.save_parked_loaders(kept_loaders)?;
    }
    Ok(())
}

/// Takes an uninstalled mod out of the profile that has it.
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
