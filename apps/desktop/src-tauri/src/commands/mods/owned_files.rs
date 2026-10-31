//! Protection for a shared Paks directory in a copy whose store keeps no readable record of
//! the game's files, which is the Microsoft Store build. Only a file Modrex recorded placing
//! may change, and only while its bytes still match what Modrex placed. Anything else that
//! exists there, including a mod the player added by hand, is treated as the game's.

use super::engine::{ModEngineConfig, ScanTarget};
use super::paths::{active_mod_path, disabled_base, disabled_mod_path, get_state_path, mods_base};
use super::state::{get_folder_path, read_state, temporary_state_path};
use crate::commands::launchers::native_paths::normalize_native_path;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

// A scan checks every recorded file, so hashing them all on every refresh would reread
// gigabytes. A scan trusts a file whose size and modification time are unchanged. A change
// to the file always hashes it again, because an installer can preserve timestamps.
static PLACED_HASHES: LazyLock<Mutex<HashMap<PathBuf, HashedFile>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct HashedFile {
    len: u64,
    modified: SystemTime,
    sha256: String,
}

/// Whether a check may reuse a hash taken while size and modification time stayed the same.
#[derive(Clone, Copy)]
pub(super) enum PlacedHashes {
    Cached,
    Fresh,
}

pub(super) struct OwnedFiles {
    pub game_root: PathBuf,
    selected_game_root: PathBuf,
    hashes: PlacedHashes,
    /// ASCII lowercase, for comparing with a lowercased filename.
    disabled_suffix: String,
    /// The target's active and disabled folders. Paths outside them belong to other targets,
    /// which this policy does not govern.
    roots: [String; 2],
    /// Placed files by normalized path relative to the game root, under both the active and
    /// the disabled name, mapped to the SHA-256 Modrex recorded.
    files: HashMap<String, String>,
    /// Modrex's own folders and state files.
    own_paths: HashSet<String>,
}

impl OwnedFiles {
    pub(super) fn load(
        game_path: &str,
        cfg: &ModEngineConfig,
        target: &ScanTarget,
        hashes: PlacedHashes,
    ) -> Result<Self, String> {
        let selected_game_root = PathBuf::from(game_path);
        let game_root = fs::canonicalize(&selected_game_root)
            .map_err(|e| format!("Could not resolve the game folder: {e}"))?;
        let state_path = get_state_path(game_path, cfg);
        let state = read_state(&state_path)
            .map_err(|e| format!("Cannot verify which Pak files Modrex installed: {e}"))?;
        let relative = |path: &Path| -> Result<String, String> {
            let relative = path
                .strip_prefix(&selected_game_root)
                .map_err(|_| "A recorded mod path leaves the game folder")?;
            normalize_native_path(
                relative
                    .to_str()
                    .ok_or("A recorded mod path is not valid UTF-8")?,
            )
        };
        let roots = [
            relative(&mods_base(game_path, target))?,
            relative(&disabled_base(game_path, target))?,
        ];
        let mut own_paths: HashSet<String> = roots.iter().cloned().collect();
        for path in [temporary_state_path(&state_path), state_path] {
            own_paths.insert(relative(&path)?);
        }
        for folder in &state.folders {
            let Some(folder) = get_folder_path(&state.folders, Some(&folder.id)) else {
                continue;
            };
            own_paths.insert(relative(&mods_base(game_path, target).join(&folder))?);
            own_paths.insert(relative(&disabled_base(game_path, target).join(&folder))?);
        }
        let mut files = HashMap::new();
        for entry in &state.mods {
            let Some(sha256) = &entry.placed_sha256 else {
                continue;
            };
            if !std::ptr::eq(cfg.mod_target(entry), target) {
                continue;
            }
            let folder = get_folder_path(&state.folders, entry.folder_id.as_deref());
            for path in [
                active_mod_path(game_path, &entry.filename, folder.as_deref(), target),
                disabled_mod_path(game_path, &entry.filename, folder.as_deref(), target),
            ] {
                files.insert(relative(&path)?, sha256.clone());
            }
        }
        Ok(Self {
            game_root,
            selected_game_root,
            hashes,
            disabled_suffix: target.disabled_suffix().to_ascii_lowercase(),
            roots,
            files,
            own_paths,
        })
    }

    /// True for anything Modrex must not change: a signed Pak or its signature, a recorded
    /// file whose bytes changed, and any other path that already exists.
    pub(super) fn protects(&self, relative: &Path) -> Result<bool, String> {
        let key = normalize_native_path(
            relative
                .to_str()
                .ok_or("Native-file query contains a non-UTF-8 path")?,
        )?;
        if !self
            .roots
            .iter()
            .any(|root| key == *root || key.starts_with(&format!("{root}/")))
        {
            return Ok(false);
        }
        let path = self.game_root.join(relative);
        if self.signed(&path)? {
            return Ok(true);
        }
        if let Some(sha256) = self.files.get(&key) {
            return Ok(!placed_bytes_match(&path, sha256, self.hashes)?);
        }
        if self.own_paths.contains(&key) {
            return Ok(false);
        }
        match path.symlink_metadata() {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
        }
    }

    pub(super) fn verify_unchanged(&self) -> Result<(), String> {
        let root = fs::canonicalize(&self.selected_game_root)
            .map_err(|e| format!("Could not recheck the game folder: {e}"))?;
        if root != self.game_root {
            return Err("The game folder changed during the operation".into());
        }
        Ok(())
    }

    // Unreal signs only the game's own Paks, so a signature marks a file as the game's
    // even if a recorded mod's name now points at it.
    // The sibling is named from the file's own spelling, since a case-sensitive filesystem
    // would not find a signature under the lowercased key.
    fn signed(&self, path: &Path) -> Result<bool, String> {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return Ok(false);
        };
        let lower = name.to_ascii_lowercase();
        let active = lower.strip_suffix(&self.disabled_suffix).unwrap_or(&lower);
        if active.ends_with(".sig") {
            return Ok(true);
        }
        if !active.ends_with(".pak") {
            return Ok(false);
        }
        let signature = format!("{}.sig", &name[..active.len() - ".pak".len()]);
        path.with_file_name(signature)
            .try_exists()
            .map_err(|e| format!("Could not inspect {}: {e}", path.display()))
    }
}

/// A recorded file that is absent has nothing left to damage.
fn placed_bytes_match(path: &Path, expected: &str, hashes: PlacedHashes) -> Result<bool, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    };
    let modified = metadata
        .modified()
        .map_err(|e| format!("Could not inspect {}: {e}", path.display()))?;
    let mut cache = PLACED_HASHES.lock().unwrap_or_else(|e| e.into_inner());
    if let (PlacedHashes::Cached, Some(hashed)) = (hashes, cache.get(path)) {
        if hashed.len == metadata.len() && hashed.modified == modified {
            return Ok(hashed.sha256 == expected);
        }
    }
    let sha256 = super::identify::hash_file(path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?
        .ok_or_else(|| format!("{} disappeared while it was checked", path.display()))?;
    let matches = sha256 == expected;
    cache.insert(
        path.to_path_buf(),
        HashedFile {
            len: metadata.len(),
            modified,
            sha256,
        },
    );
    Ok(matches)
}

#[cfg(test)]
#[path = "owned_files_tests.rs"]
mod tests;
