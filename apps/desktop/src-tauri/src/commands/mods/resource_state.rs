//! Durable recovery store for movie and Engine.ini resources.
//!
//! Layout under app_data_dir()/resources, deliberately outside the mods folder and the cache
//! directory so neither ordinary mod deletion nor cache clearing can remove recovery data:
//!
//!   manifest.json        version 1, strict. Deployments, movie baselines, INI revisions.
//!   objects/<sha256>     independent byte copies, named by their own SHA-256 and verified
//!                        against it on every read. Never hard links.
//!   journal/<id>.json    one pending multi-file operation, written and flushed before the
//!                        first live file changes and removed after the manifest commits.
//!
//! A journal carries the manifest revision its operation commits. On recovery a journal whose
//! revision the manifest already reached only needs removing. Any other journal is rolled
//! back file by file, and a live file matching neither side of its step is preserved and
//! reported instead of overwritten.
//!
//! Application locks and revision checks coordinate Modrex's own operations. They cannot stop
//! an unrelated writer racing the final check, which is why every step re-reads the live file
//! immediately before replacing it and verifies the result afterwards.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

pub(crate) const MANIFEST_VERSION: u32 = 1;

/// What a file held at one moment. An empty file is Present with size 0, never Absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Content {
    Absent,
    Present { sha256: String, size: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    pub version: u32,
    pub revision: u64,
    pub deployments: Vec<Deployment>,
    pub movie_baselines: Vec<MovieBaseline>,
    pub ini_revisions: Vec<IniRevision>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: MANIFEST_VERSION,
            revision: 0,
            deployments: Vec::new(),
            movie_baselines: Vec::new(),
            ini_revisions: Vec::new(),
        }
    }
}

/// One managed movie pack or Engine.ini preset, bound to the install it was made for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Deployment {
    pub id: String,
    pub game_id: String,
    pub game_path: String,
    pub canonical_game_path: String,
    pub launcher: Option<String>,
    pub name: String,
    pub version: String,
    pub source: Option<String>,
    pub remote_id: Option<String>,
    pub file_id: Option<i64>,
    pub installed_at: String,
    pub enabled: bool,
    pub body: DeploymentBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum DeploymentBody {
    Movie { slots: Vec<MovieSlot> },
    Ini { preset: IniPreset },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MovieSlot {
    /// The destination's real filename, as listed in the Movies folder.
    pub slot: String,
    /// Canonical path of the destination file.
    pub destination: String,
    /// The archive entry or dropped file the payload came from. A source identity only.
    pub entry_name: String,
    pub payload_sha256: String,
    pub payload_size: u64,
}

/// The previous setup of one movie destination, captured before Modrex first replaced it.
/// Kept while any deployment references the destination, so switching packs never rebases it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MovieBaseline {
    pub destination: String,
    pub game_id: String,
    pub prior: Content,
    pub captured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IniPreset {
    pub config_path: String,
    pub source_entry: String,
    pub source_sha256: String,
    pub source_size: u64,
    pub created_file: bool,
    /// Settings this preset changed and still owns. Empty while disabled, and empty when every
    /// assignment already matched, since an equal pre-existing value is never owned.
    pub changes: Vec<KeyChange>,
    pub created_sections: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KeyChange {
    pub section: String,
    pub key: String,
    /// The value before the preset applied, or None when the key was absent. Key= is Some("").
    pub before: Option<String>,
    pub applied: String,
}

/// A prior revision of an Engine.ini, kept whenever Modrex replaced it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IniRevision {
    pub config_path: String,
    pub game_id: String,
    pub prior: Content,
    pub saved_at: String,
}

/// One live file change: the destination must hold before and will hold after.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Step {
    pub destination: PathBuf,
    pub before: Content,
    pub after: Content,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    id: String,
    game_id: String,
    revision_after: u64,
    steps: Vec<Step>,
    #[serde(default)]
    decision: RecoveryDecision,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum RecoveryDecision {
    #[default]
    Rollback,
    KeepCurrent {
        paths: Vec<PathBuf>,
    },
}

pub(crate) fn release_paths(manifest: &mut Manifest, paths: &[PathBuf]) {
    let paths = overlapping_paths(manifest, paths);
    manifest.deployments.retain(|deployment| {
        !deployment_paths(deployment)
            .iter()
            .any(|path| paths.contains(path))
    });
    manifest
        .movie_baselines
        .retain(|baseline| !paths.contains(&PathBuf::from(&baseline.destination)));
}

pub(crate) fn deployment_paths(deployment: &Deployment) -> Vec<PathBuf> {
    match &deployment.body {
        DeploymentBody::Movie { slots } => slots
            .iter()
            .map(|slot| PathBuf::from(&slot.destination))
            .collect(),
        DeploymentBody::Ini { preset } => vec![PathBuf::from(&preset.config_path)],
    }
}

pub(crate) fn overlapping_paths(manifest: &Manifest, paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut affected = paths.to_vec();
    loop {
        let previous = affected.len();
        for deployment in &manifest.deployments {
            let paths = deployment_paths(deployment);
            if !paths.iter().any(|path| affected.contains(path)) {
                continue;
            }
            for path in paths {
                if !affected.contains(&path) {
                    affected.push(path);
                }
            }
        }
        if affected.len() == previous {
            break;
        }
    }
    affected.sort();
    affected
}

#[derive(Debug, Clone)]
pub(crate) struct ResourceStore {
    root: PathBuf,
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn validate_digest(digest: &str) -> Result<(), String> {
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The resource state contains an invalid content digest.".into());
    }
    Ok(())
}

fn validate_content(content: &Content) -> Result<(), String> {
    if let Content::Present { sha256, .. } = content {
        validate_digest(sha256)?;
    }
    Ok(())
}

fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    let mut owned_movies = std::collections::HashSet::new();
    for deployment in &manifest.deployments {
        if !ids.insert(&deployment.id) || deployment.id.is_empty() {
            return Err("The resource manifest contains duplicate or empty deployment IDs.".into());
        }
        if !Path::new(&deployment.canonical_game_path).is_absolute() {
            return Err("A resource deployment contains an invalid installation root".into());
        }
        match &deployment.body {
            DeploymentBody::Movie { slots } => {
                let mut paths = std::collections::HashSet::new();
                if slots.is_empty() {
                    return Err("A movie deployment has no slots.".into());
                }
                for slot in slots {
                    validate_digest(&slot.payload_sha256)?;
                    if !Path::new(&slot.destination).is_absolute()
                        || !paths.insert(&slot.destination)
                    {
                        return Err("A movie deployment contains an invalid destination.".into());
                    }
                    if deployment.enabled
                        && !owned_movies.insert(destination_key(Path::new(&slot.destination)))
                    {
                        return Err("Multiple active movie packs own the same destination".into());
                    }
                }
            }
            DeploymentBody::Ini { preset } => {
                validate_digest(&preset.source_sha256)?;
                if !Path::new(&preset.config_path).is_absolute() {
                    return Err("An INI deployment contains an invalid destination.".into());
                }
            }
        }
    }
    let mut baselines = std::collections::HashSet::new();
    for baseline in &manifest.movie_baselines {
        if !Path::new(&baseline.destination).is_absolute()
            || !baselines.insert(destination_key(Path::new(&baseline.destination)))
        {
            return Err("A movie baseline has an invalid or duplicate destination".into());
        }
        validate_content(&baseline.prior)?;
    }
    for revision in &manifest.ini_revisions {
        if !Path::new(&revision.config_path).is_absolute() {
            return Err("An INI revision has an invalid destination".into());
        }
        validate_content(&revision.prior)?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn restore_failed_replacement(
    destination: &Path,
    backup: &Path,
    before: &Content,
) -> Result<(), String> {
    if live_content(destination)? != Content::Absent || live_content(backup)? != *before {
        return Err(format!(
            "The replacement backup at {} was preserved for review",
            backup.display()
        ));
    }
    fs::rename(backup, destination)
        .map_err(|error| format!("Could not return the replacement backup: {error}"))
}

fn replace_live(source: &Path, destination: &Path, before: &Content) -> std::io::Result<()> {
    #[cfg(windows)]
    if matches!(before, Content::Present { .. }) {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn ReplaceFileW(
                replaced: *const u16,
                replacement: *const u16,
                backup: *const u16,
                flags: u32,
                exclude: *mut std::ffi::c_void,
                reserved: *mut std::ffi::c_void,
            ) -> i32;
        }
        let backup = source.with_extension("bak");
        let backup_wide: Vec<u16> = backup.as_os_str().encode_wide().chain([0]).collect();
        let destination_wide: Vec<u16> = destination.as_os_str().encode_wide().chain([0]).collect();
        let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain([0]).collect();
        // ReplaceFileW can move the original before failing. Its backup preserves that file.
        let success = unsafe {
            ReplaceFileW(
                destination_wide.as_ptr(),
                source_wide.as_ptr(),
                backup_wide.as_ptr(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if success != 0 {
            remove_temporary(&backup);
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(1177) {
            restore_failed_replacement(destination, &backup, before)
                .map_err(std::io::Error::other)?;
        }
        return Err(error);
    }
    let _ = before;
    fs::rename(source, destination)
}

/// Streams a file through SHA-256. Absent is reported as Absent, every other failure is an error.
pub(crate) fn live_content(path: &Path) -> Result<Content, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(format!("{} is not a regular resource file", path.display()))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Content::Absent),
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    }
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Content::Absent),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok(Content::Present {
        sha256: hex::encode(hasher.finalize()),
        size,
    })
}

fn sync_dir(dir: &Path) -> Result<(), String> {
    // Directory handles cannot be opened for flushing on Windows, where rename durability is
    // the filesystem's own. On Unix the rename is only durable once its directory is synced.
    #[cfg(unix)]
    File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| format!("could not flush {}: {e}", dir.display()))?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn remove_temporary(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!(
            "Resource temporary file could not be removed at {}: {error}",
            path.display()
        ),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".modrex-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut f = File::create(&tmp).map_err(|e| format!("could not stage a write: {e}"))?;
        f.write_all(bytes)
            .and_then(|()| f.sync_all())
            .map_err(|e| format!("could not stage a write: {e}"))?;
        fs::rename(&tmp, path).map_err(|e| format!("could not replace {}: {e}", path.display()))
    })();
    if result.is_err() {
        remove_temporary(&tmp);
    }
    result?;
    sync_dir(dir)
}

fn remove_journal(path: &Path) -> Result<(), String> {
    fs::remove_file(path)
        .map_err(|error| format!("Could not finish resource recovery: {error}"))?;
    sync_dir(
        path.parent()
            .expect("journals are stored in the journal directory"),
    )
}

impl ResourceStore {
    fn initialize(&self) -> Result<(), String> {
        let manifest = self.load_manifest()?;
        if !self
            .manifest_path()
            .try_exists()
            .map_err(|e| e.to_string())?
        {
            self.save_manifest(&manifest)?;
        }
        Ok(())
    }
    pub(crate) fn at(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager;
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("could not resolve the app data folder: {e}"))?;
        Ok(Self::at(dir.join("resources")))
    }

    fn manifest_path(&self) -> PathBuf {
        self.root.join("manifest.json")
    }

    fn journal_dir(&self) -> PathBuf {
        self.root.join("journal")
    }

    pub(crate) fn object_path(&self, sha256: &str) -> PathBuf {
        self.root.join("objects").join(sha256)
    }

    /// Reads the manifest. A missing file is the empty store. An unknown version, malformed
    /// JSON or invalid entry is an error that blocks every resource write.
    pub(crate) fn load_manifest(&self) -> Result<Manifest, String> {
        let raw = match fs::read(self.manifest_path()) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if self
                    .root
                    .join("objects")
                    .try_exists()
                    .map_err(|e| e.to_string())?
                    || self.journal_dir().try_exists().map_err(|e| e.to_string())?
                {
                    return Err("The resource manifest is missing while recovery data remains. Restore the manifest before changing resources.".into());
                }
                return Ok(Manifest::default());
            }
            Err(e) => return Err(format!("the resource manifest could not be read: {e}")),
        };
        let value: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|e| format!("the resource manifest is corrupt: {e}"))?;
        let version = value.get("version").and_then(|v| v.as_u64());
        if version != Some(u64::from(MANIFEST_VERSION)) {
            return Err(format!(
                "the resource manifest has version {}, which this version of Modrex does not understand; movie and Engine.ini changes are blocked so nothing is lost",
                version.map_or("none".to_string(), |v| v.to_string())
            ));
        }
        let manifest: Manifest = serde_json::from_value(value)
            .map_err(|e| format!("the resource manifest has an invalid entry: {e}"))?;
        validate_manifest(&manifest)?;
        Ok(manifest)
    }

    pub(crate) fn save_manifest(&self, manifest: &Manifest) -> Result<(), String> {
        validate_manifest(manifest)?;
        let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
        write_atomic(&self.manifest_path(), &bytes)
    }

    /// Copies a file into the object store and returns what it held. The copy is hashed while
    /// it is written and checked again from disk, so a short read cannot become a recovery copy.
    pub(crate) fn capture(&self, path: &Path) -> Result<Content, String> {
        self.initialize()?;
        let mut src = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Content::Absent),
            Err(e) => return Err(format!("could not read {}: {e}", path.display())),
        };
        let objects = self.root.join("objects");
        fs::create_dir_all(&objects)
            .map_err(|e| format!("could not create recovery storage: {e}"))?;
        let tmp = objects.join(format!(".capture-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut out =
                File::create(&tmp).map_err(|e| format!("could not write recovery copy: {e}"))?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 64 * 1024];
            let mut size = 0u64;
            loop {
                let n = src
                    .read(&mut buf)
                    .map_err(|e| format!("could not read {}: {e}", path.display()))?;
                if n == 0 {
                    break;
                }
                size += n as u64;
                hasher.update(&buf[..n]);
                out.write_all(&buf[..n])
                    .map_err(|e| format!("could not write recovery copy: {e}"))?;
            }
            out.sync_all()
                .map_err(|e| format!("could not flush recovery copy: {e}"))?;
            let sha256 = hex::encode(hasher.finalize());
            self.commit_object(&tmp, &sha256, size)
        })();
        if result.is_err() {
            remove_temporary(&tmp);
        }
        result
    }

    pub(crate) fn put_bytes(&self, bytes: &[u8]) -> Result<Content, String> {
        self.initialize()?;
        let objects = self.root.join("objects");
        fs::create_dir_all(&objects)
            .map_err(|e| format!("could not create recovery storage: {e}"))?;
        let tmp = objects.join(format!(".put-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut f =
                File::create(&tmp).map_err(|e| format!("could not write recovery copy: {e}"))?;
            f.write_all(bytes)
                .and_then(|()| f.sync_all())
                .map_err(|e| format!("could not write recovery copy: {e}"))?;
            self.commit_object(&tmp, &sha256_hex(bytes), bytes.len() as u64)
        })();
        if result.is_err() {
            remove_temporary(&tmp);
        }
        result
    }

    fn commit_object(&self, tmp: &Path, sha256: &str, size: u64) -> Result<Content, String> {
        let dest = self.object_path(sha256);
        let content = Content::Present {
            sha256: sha256.to_string(),
            size,
        };
        // An intact copy of these bytes is already stored. A damaged one is replaced by the
        // verified copy just written, so it can never stand in for the real bytes.
        if live_content(&dest)? == content {
            fs::remove_file(tmp).map_err(|e| e.to_string())?;
            return Ok(content);
        }
        fs::rename(tmp, &dest).map_err(|e| format!("could not store recovery copy: {e}"))?;
        sync_dir(dest.parent().expect("object path has a parent"))?;
        if live_content(&dest)? != content {
            return Err("a recovery copy did not verify after writing".to_string());
        }
        Ok(content)
    }

    /// Full checksum verification of one stored object.
    pub(crate) fn verify_object(&self, sha256: &str, size: u64) -> Result<(), String> {
        let found = live_content(&self.object_path(sha256))?;
        let expected = Content::Present {
            sha256: sha256.to_string(),
            size,
        };
        if found != expected {
            return Err(format!(
                "recovery copy {} is missing or damaged",
                &sha256[..sha256.len().min(12)]
            ));
        }
        Ok(())
    }

    /// Cheap presence check used by launch preflight: the object exists with the recorded size.
    /// Full checksums are verified on every read that restores bytes.
    fn object_present(&self, content: &Content) -> Result<(), String> {
        let Content::Present { sha256, size } = content else {
            return Ok(());
        };
        let meta = fs::metadata(self.object_path(sha256)).map_err(|_| {
            format!(
                "recovery copy {} is missing",
                &sha256[..sha256.len().min(12)]
            )
        })?;
        if meta.len() != *size {
            return Err(format!(
                "recovery copy {} has the wrong size",
                &sha256[..sha256.len().min(12)]
            ));
        }
        Ok(())
    }

    pub(crate) fn read_object(&self, sha256: &str, size: u64) -> Result<Vec<u8>, String> {
        let bytes = fs::read(self.object_path(sha256)).map_err(|_| {
            format!(
                "recovery copy {} is missing",
                &sha256[..sha256.len().min(12)]
            )
        })?;
        if bytes.len() as u64 != size || sha256_hex(&bytes) != sha256 {
            return Err(format!(
                "recovery copy {} is damaged",
                &sha256[..sha256.len().min(12)]
            ));
        }
        Ok(bytes)
    }

    fn pending_journals(&self) -> Result<Vec<(PathBuf, Journal)>, String> {
        let dir = self.journal_dir();
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("could not read pending resource operations: {e}")),
        };
        let mut out = Vec::new();
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read(&path)
                .map_err(|e| format!("could not read a pending resource operation: {e}"))?;
            let journal: Journal = serde_json::from_slice(&raw).map_err(|e| {
                format!("a pending resource operation record is unreadable, so nothing will be restored automatically: {e}")
            })?;
            if journal.version != MANIFEST_VERSION {
                return Err(
                    "a pending resource operation was written by another version of Modrex"
                        .to_string(),
                );
            }
            for step in &journal.steps {
                if !step.destination.is_absolute() {
                    return Err("A resource journal contains a relative destination.".into());
                }
                validate_content(&step.before)?;
                validate_content(&step.after)?;
            }
            if let RecoveryDecision::KeepCurrent { paths } = &journal.decision {
                if paths.is_empty() || paths.iter().any(|path| !path.is_absolute()) {
                    return Err("A recovery decision contains invalid destinations".into());
                }
            }
            out.push((path, journal));
        }
        Ok(out)
    }

    /// Whether any interrupted operation still touches this game.
    pub(crate) fn has_pending(&self, game_id: &str) -> Result<bool, String> {
        Ok(self
            .pending_journals()?
            .iter()
            .any(|(_, j)| j.game_id == game_id))
    }

    pub(crate) fn recovery_paths(&self, game_id: &str) -> Result<(String, Vec<PathBuf>), String> {
        let journals = self.pending_journals()?;
        let (_, journal) = journals
            .iter()
            .find(|(_, journal)| journal.game_id == game_id)
            .ok_or("There is no interrupted resource operation for this game")?;
        if journals.len() != 1 {
            return Err("Multiple resource journals require manual review".into());
        }
        let paths = match &journal.decision {
            RecoveryDecision::Rollback => journal
                .steps
                .iter()
                .map(|step| step.destination.clone())
                .collect(),
            RecoveryDecision::KeepCurrent { paths } => paths.clone(),
        };
        Ok((journal.id.clone(), paths))
    }

    pub(crate) fn keep_current(
        &self,
        game_id: &str,
        paths: Vec<PathBuf>,
        journal_id: Option<&str>,
        revision: u64,
    ) -> Result<(), String> {
        let mut manifest = self.load_manifest()?;
        if manifest.revision != revision {
            return Err("Resource ownership changed. Review it again".into());
        }
        let next = revision
            .checked_add(1)
            .ok_or("Resource revision overflow")?;
        let journals = self.pending_journals()?;
        if let Some(id) = journal_id {
            if journals.len() != 1 {
                return Err("Multiple resource journals require manual review".into());
            }
            let (path, mut journal) = journals
                .into_iter()
                .find(|(_, journal)| journal.game_id == game_id && journal.id == id)
                .ok_or("This interrupted operation has ended. Review it again")?;
            journal.decision = RecoveryDecision::KeepCurrent {
                paths: paths.clone(),
            };
            journal.revision_after = next;
            write_atomic(
                &path,
                &serde_json::to_vec_pretty(&journal).map_err(|error| error.to_string())?,
            )?;
            return self.recover(game_id);
        }
        if !journals.is_empty() {
            return Err("Review the interrupted resource operation first".into());
        }
        if paths.is_empty() || paths.iter().any(|path| !path.is_absolute()) {
            return Err("The recovery review has invalid destinations".into());
        }
        release_paths(&mut manifest, &paths);
        manifest.revision = next;
        self.save_manifest(&manifest)
    }

    /// Finishes or rolls back every interrupted operation for game_id. Bytes that match
    /// neither side of a step are left in place and reported; the journal then stays so the
    /// next attempt sees the same evidence.
    pub(crate) fn recover(&self, game_id: &str) -> Result<(), String> {
        let journals = self.pending_journals()?;
        if journals.iter().all(|(_, j)| j.game_id != game_id) {
            return Ok(());
        }
        let mut manifest = self.load_manifest()?;
        let mut problems = Vec::new();
        for (path, journal) in journals.into_iter().filter(|(_, j)| j.game_id == game_id) {
            if let RecoveryDecision::KeepCurrent { paths } = &journal.decision {
                if manifest.revision != journal.revision_after {
                    if manifest.revision.checked_add(1) != Some(journal.revision_after) {
                        return Err("The recovery decision has an invalid revision".into());
                    }
                    release_paths(&mut manifest, paths);
                    manifest.revision = journal.revision_after;
                    self.save_manifest(&manifest)?;
                }
                remove_journal(&path)?;
                continue;
            }
            if manifest.revision == journal.revision_after {
                remove_journal(&path)?;
                continue;
            }
            if manifest.revision.checked_add(1) != Some(journal.revision_after) {
                return Err("The resource journal does not follow the saved manifest revision. Recovery is blocked.".into());
            }
            match self.roll_back(&journal.steps) {
                Ok(()) => remove_journal(&path)?,
                Err(e) => problems.push(e),
            }
        }
        if !problems.is_empty() {
            return Err(format!(
                "an interrupted movie or Engine.ini change could not be undone safely: {}",
                problems.join("; ")
            ));
        }
        Ok(())
    }

    /// Resolves interrupted writes and checks recovery data used by current deployments.
    pub(crate) fn preflight(&self, game_id: &str) -> Result<(), String> {
        self.recover(game_id)?;
        if !self.pending_journals()?.is_empty() {
            return Err("Another game has pending resource recovery. Resolve it before launching or changing resources.".into());
        }
        let manifest = self.load_manifest()?;
        for d in manifest.deployments.iter().filter(|d| d.game_id == game_id) {
            match &d.body {
                DeploymentBody::Movie { slots } => {
                    for s in slots {
                        self.object_present(&Content::Present {
                            sha256: s.payload_sha256.clone(),
                            size: s.payload_size,
                        })?;
                    }
                }
                DeploymentBody::Ini { preset } => self.object_present(&Content::Present {
                    sha256: preset.source_sha256.clone(),
                    size: preset.source_size,
                })?,
            }
        }
        for b in manifest
            .movie_baselines
            .iter()
            .filter(|b| b.game_id == game_id)
        {
            self.object_present(&b.prior)?;
        }
        Ok(())
    }

    /// Applies verified objects and ownership changes through a durable journal.
    /// External edits block replacement and rollback, leaving the journal available for recovery.
    pub(crate) fn apply(
        &self,
        game_id: &str,
        steps: Vec<Step>,
        commit: impl FnOnce(&mut Manifest),
    ) -> Result<(), String> {
        self.initialize()?;
        if !self.pending_journals()?.is_empty() {
            return Err(
                "an interrupted movie or Engine.ini change is still pending; resolve it first"
                    .to_string(),
            );
        }
        let mut manifest = self.load_manifest()?;
        let steps: Vec<Step> = steps.into_iter().filter(|s| s.before != s.after).collect();
        for step in &steps {
            if live_content(&step.destination)? != step.before {
                return Err(format!(
                    "{} changed since Modrex last read it; nothing was written",
                    step.destination.display()
                ));
            }
            refuse_read_only(&step.destination)?;
            if let Content::Present { sha256, size } = &step.after {
                self.verify_object(sha256, *size)?;
            }
            if let Content::Present { sha256, size } = &step.before {
                self.verify_object(sha256, *size)?;
            }
        }
        let revision_after = manifest
            .revision
            .checked_add(1)
            .ok_or("Resource revision overflow.")?;
        let journal = Journal {
            version: MANIFEST_VERSION,
            id: Uuid::new_v4().to_string(),
            game_id: game_id.to_string(),
            revision_after,
            steps: steps.clone(),
            decision: RecoveryDecision::Rollback,
        };
        let journal_path = self.journal_dir().join(format!("{}.json", journal.id));
        write_atomic(
            &journal_path,
            &serde_json::to_vec_pretty(&journal).map_err(|e| e.to_string())?,
        )?;

        let mut attempted = 0;
        let mut failure = None;
        for step in &steps {
            attempted += 1;
            if let Err(e) = self.commit_step(step) {
                failure = Some(e);
                break;
            }
        }
        if failure.is_none() {
            commit(&mut manifest);
            manifest.revision = revision_after;
            if let Err(e) = self.save_manifest(&manifest) {
                failure = Some(e);
            }
        }
        let Some(failure) = failure else {
            remove_journal(&journal_path)?;
            return Ok(());
        };
        let saved = self.load_manifest().map_err(|error| format!("{failure}; the operation remains pending because its manifest could not be checked: {error}"))?;
        if saved.revision == revision_after {
            return Err(format!(
                "{failure}; the change was recorded and remains pending for recovery verification"
            ));
        }
        match self.roll_back(&steps[..attempted]) {
            Ok(()) => {
                remove_journal(&journal_path)?;
                Err(format!("{failure}; every file was put back"))
            }
            Err(undo) => Err(format!(
                "{failure}; undoing the change also failed ({undo}), and it stays pending for recovery"
            )),
        }
    }

    fn commit_step(&self, step: &Step) -> Result<(), String> {
        let dest = &step.destination;
        refuse_read_only(dest)?;
        let dir = dest
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", dest.display()))?;
        if fs::canonicalize(dir)
            .map_err(|error| format!("Could not resolve resource directory: {error}"))?
            != dir
        {
            return Err("The resource directory now resolves to a different destination".into());
        }
        let Content::Present { sha256, size } = &step.after else {
            if live_content(dest)? != step.before {
                return Err(format!(
                    "{} changed while it was being replaced",
                    dest.display()
                ));
            }
            fs::remove_file(dest)
                .map_err(|e| format!("could not remove {}: {e}", dest.display()))?;
            return sync_dir(dir);
        };
        let tmp = dir.join(format!(".modrex-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut source = File::open(self.object_path(sha256)).map_err(|e| e.to_string())?;
            let mut f = File::create(&tmp)
                .map_err(|e| format!("could not stage a file in {}: {e}", dir.display()))?;
            let copied = std::io::copy(&mut source, &mut f).map_err(|e| e.to_string())?;
            if copied != *size {
                return Err("The recovery object changed while staging a replacement.".into());
            }
            match fs::metadata(dest) {
                Ok(meta) => f
                    .set_permissions(meta.permissions())
                    .map_err(|e| e.to_string())?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("Cannot inspect replacement permissions: {error}"))
                }
            }
            f.sync_all()
                .map_err(|e| format!("Could not flush replacement: {e}"))?;
            drop(f);
            if live_content(&tmp)? != step.after {
                return Err("The staged replacement did not verify.".into());
            }
            if live_content(dest)? != step.before {
                return Err(format!(
                    "{} changed while it was being replaced",
                    dest.display()
                ));
            }
            replace_live(&tmp, dest, &step.before)
                .map_err(|e| format!("could not replace {}: {e}", dest.display()))
        })();
        if result.is_err() {
            remove_temporary(&tmp);
        }
        result?;
        sync_dir(dir)?;
        if live_content(dest)? != step.after {
            return Err(format!("{} did not verify after writing", dest.display()));
        }
        Ok(())
    }

    /// Undoes steps in reverse. A file already back at before is left alone. One holding
    /// neither side is preserved and reported.
    fn roll_back(&self, steps: &[Step]) -> Result<(), String> {
        let mut problems = Vec::new();
        for step in steps.iter().rev() {
            let live = match live_content(&step.destination) {
                Ok(content) => content,
                Err(error) => {
                    problems.push(error);
                    continue;
                }
            };
            if live == step.before {
                continue;
            }
            if live != step.after {
                problems.push(format!(
                    "{} holds unexpected bytes and was preserved",
                    step.destination.display()
                ));
                continue;
            }
            let undo = Step {
                destination: step.destination.clone(),
                before: step.after.clone(),
                after: step.before.clone(),
            };
            if let Err(e) = self.commit_step(&undo) {
                problems.push(e);
            }
        }
        if problems.is_empty() {
            return Ok(());
        }
        Err(problems.join("; "))
    }
}

/// Modrex never clears a read-only attribute: the user set it, and a preset's author may
/// have asked for it.
pub(crate) fn refuse_read_only(path: &Path) -> Result<(), String> {
    match fs::metadata(path) {
        Ok(meta) if meta.permissions().readonly() => Err(format!(
            "{} is read-only; change that in your file manager if you want Modrex to write it",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Cannot inspect {} before writing: {error}",
            path.display()
        )),
    }
}

/// Serializes resource writes and recovery against the shared manifest.
#[derive(Default)]
pub struct ResourceLocks(Arc<tokio::sync::Mutex<()>>);

pub(crate) type ResourceGuard = tokio::sync::OwnedMutexGuard<()>;

/// Canonical destination identity. Windows paths compare case-insensitively.
fn destination_key(path: &Path) -> String {
    let s = path.to_string_lossy().to_string();
    if cfg!(windows) {
        return s.to_lowercase();
    }
    s
}

impl ResourceLocks {
    pub(crate) async fn acquire(&self) -> ResourceGuard {
        self.0.clone().lock_owned().await
    }
}

#[cfg(test)]
#[path = "resource_state_tests.rs"]
mod tests;
