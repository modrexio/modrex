use super::engine::{mods_dir, ModEngineConfig};
use super::naming::log_name;
use crate::commands::launchers::steam_manifest::{read_native_files, NativeFilesSnapshot};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Protects native paths when an Unreal target shares its directory with mod files.
pub(super) struct NativeGuard {
    game_root: PathBuf,
    targets: Vec<NativeTarget>,
}

struct NativeTarget {
    root: PathBuf,
    disabled_suffix: &'static str,
    companions: &'static [&'static str],
    snapshot: NativeFilesSnapshot,
}

impl NativeGuard {
    pub fn load(game_path: &str, cfg: &ModEngineConfig) -> Result<Self, String> {
        if !cfg
            .targets
            .iter()
            .any(|target| target.shared_paks.is_some())
        {
            return Ok(Self {
                game_root: PathBuf::from(game_path),
                targets: Vec::new(),
            });
        }
        let steam_root = crate::commands::launchers::steam_install_path().ok_or(
            "Steam must be installed to verify native game files in the shared Paks directory",
        )?;
        Self::load_from_steam_root(game_path, cfg, Path::new(&steam_root))
    }

    fn load_from_steam_root(
        game_path: &str,
        cfg: &ModEngineConfig,
        steam_root: &Path,
    ) -> Result<Self, String> {
        let game_root = PathBuf::from(game_path);
        let mut targets = Vec::new();
        for target in cfg.targets {
            let Some(shared) = &target.shared_paks else {
                continue;
            };
            let snapshot = read_native_files(steam_root, &game_root, shared.steam_app)
                .map_err(|error| format!("Cannot verify the game's original files: {error}. Open Steam to finish or verify the installation, then return to Modrex."))?;
            log::debug!(
                "Verified native files for Steam app {} build {} from {} depots",
                snapshot.app_id,
                snapshot.build_id,
                snapshot.depots.len()
            );
            targets.push(NativeTarget {
                root: mods_dir(game_path, target),
                disabled_suffix: target.disabled_suffix(),
                companions: target.companions,
                snapshot,
            });
        }
        Ok(Self { game_root, targets })
    }

    pub fn shares_native_files(&self) -> bool {
        !self.targets.is_empty()
    }

    pub fn verify_unchanged(&self) -> Result<(), String> {
        for target in &self.targets {
            target.snapshot.verify_unchanged()?;
        }
        Ok(())
    }

    pub fn check_move_destinations(moves: &[(PathBuf, PathBuf)]) -> Result<(), String> {
        let identities = moves
            .iter()
            .map(|(from, to)| {
                Ok((
                    resolve_existing_ancestor(from)?,
                    resolve_existing_ancestor(to)?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        for (index, (from, to)) in identities.iter().enumerate() {
            for (prior_from, prior_to) in &identities[..index] {
                if paths_equal(from, prior_from)? {
                    return Err("The move contains two references to the same mod file".into());
                }
                if paths_equal(to, prior_to)? {
                    return Err("Two mod files would have the same destination name".into());
                }
            }
            if !moves[index]
                .1
                .try_exists()
                .map_err(|error| format!("Could not inspect the mod destination: {error}"))?
            {
                continue;
            }
            let mut source_matches = false;
            for (source, _) in &identities {
                if paths_equal(source, to)? {
                    source_matches = true;
                    break;
                }
            }
            if !source_matches {
                return Err(format!(
                    "{} is in the way. Move or delete it, then try again.",
                    log_name(&moves[index].1)
                ));
            }
        }
        Ok(())
    }

    pub fn check_state_path(&self, path: &Path) -> Result<(), String> {
        self.check_path(path)?;
        self.check_path(&super::state::temporary_state_path(path))?;
        self.verify_unchanged()
    }

    pub fn protects(&self, path: &Path) -> Result<bool, String> {
        if self.targets.is_empty() {
            return Ok(false);
        }
        let relative = path
            .strip_prefix(&self.game_root)
            .map_err(|_| "The mod path leaves the configured game directory".to_string())?;
        for target in &self.targets {
            if target.snapshot.protects(relative)? {
                return Ok(true);
            }
        }
        let resolved = resolve_existing_ancestor(path)?;
        for target in &self.targets {
            let relative = resolved
                .strip_prefix(&target.snapshot.game_root)
                .map_err(|_| "The mod path resolves outside the configured game directory")?;
            if target.snapshot.protects(relative)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn check_file(&self, path: &Path) -> Result<(), String> {
        let Some(target) = self
            .targets
            .iter()
            .find(|target| path.starts_with(&target.root))
        else {
            if !self.targets.is_empty() {
                return Err("The mod path leaves its shared Paks directory".into());
            }
            return Ok(());
        };
        self.check_path(path)?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("The mod filename is not valid UTF-8")?;
        let active_name = if name
            .to_ascii_lowercase()
            .ends_with(&target.disabled_suffix.to_ascii_lowercase())
        {
            &name[..name.len() - target.disabled_suffix.len()]
        } else {
            name
        };
        let extension = Path::new(active_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("");
        if !extension.eq_ignore_ascii_case("pak")
            && !target
                .companions
                .iter()
                .any(|ext| extension.eq_ignore_ascii_case(ext))
        {
            return Err(format!(
                "{} is not a supported Pak mod file",
                log_name(path)
            ));
        }
        if self.protects(path)? {
            return Err(format!(
                "{} belongs to the game and cannot be modified",
                log_name(path)
            ));
        }
        Ok(())
    }

    pub fn check_tree(&self, path: &Path) -> Result<(), String> {
        if self.targets.is_empty() {
            return Ok(());
        }
        self.check_path(path)?;
        let relative = path
            .strip_prefix(&self.game_root)
            .expect("check_path validated the root");
        for target in &self.targets {
            if target.snapshot.protects_tree(relative)? {
                return Err(format!(
                    "{} contains native game paths and cannot be moved",
                    log_name(path)
                ));
            }
            let resolved = resolve_existing_ancestor(path)?;
            let relative = resolved
                .strip_prefix(&target.snapshot.game_root)
                .map_err(|_| "The mod folder resolves outside the configured game directory")?;
            if target.snapshot.protects_tree(relative)? {
                return Err(format!(
                    "{} resolves to native game paths and cannot be moved",
                    log_name(path)
                ));
            }
        }
        if !path.exists() {
            return Ok(());
        }
        if !path.is_dir() {
            return self.check_file(path);
        }
        for entry in fs::read_dir(path)
            .map_err(|error| format!("Could not inspect {}: {error}", log_name(path)))?
        {
            let entry =
                entry.map_err(|error| format!("Could not inspect the mod folder: {error}"))?;
            self.check_tree(&entry.path())?;
        }
        Ok(())
    }

    pub fn check_path(&self, path: &Path) -> Result<(), String> {
        if self.targets.is_empty() {
            return Ok(());
        }
        check_contained_path(&self.game_root, path)?;
        for target in &self.targets {
            if let Ok(relative) = path.strip_prefix(&target.root) {
                if relative.components().next().is_some_and(|component| {
                    component
                        .as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("mod.io")
                }) {
                    return Err(
                        "The mod.io subscription folder is managed by the game's mod.io client"
                            .into(),
                    );
                }
            }
        }
        let resolved = resolve_existing_ancestor(path)?;
        for target in &self.targets {
            let root = resolve_existing_ancestor(&target.root)?;
            if let Ok(relative) = resolved.strip_prefix(root) {
                if relative.components().next().is_some_and(|component| {
                    component
                        .as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("mod.io")
                }) {
                    return Err(
                        "The mod.io subscription folder is managed by the game's mod.io client"
                            .into(),
                    );
                }
            }
        }
        if self.protects(path)? {
            return Err(format!(
                "{} belongs to the game and cannot be modified",
                log_name(path)
            ));
        }
        Ok(())
    }
}

pub(super) fn check_contained_path(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "The mod path leaves the configured game directory")?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("The mod path contains an unsafe component".into());
    }
    // Junctions and symbolic links can redirect an otherwise relative mod path.
    let mut ancestor = root.to_path_buf();
    reject_link(&ancestor)?;
    for component in relative.components() {
        ancestor.push(component);
        reject_link(&ancestor)?;
    }
    Ok(())
}

pub(super) fn paths_equal(left: &Path, right: &Path) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let left: Vec<u16> = left.as_os_str().encode_wide().collect();
        let right: Vec<u16> = right.as_os_str().encode_wide().collect();
        crate::commands::launchers::native_paths::windows_path_order(&left, &right)
            .map(|order| order == std::cmp::Ordering::Equal)
    }
    #[cfg(not(windows))]
    Ok(left == right)
}

// Resolving the existing prefix also expands Windows short names before a new leaf is written.
pub(super) fn resolve_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut ancestor = path;
    let mut missing = Vec::new();
    loop {
        match fs::canonicalize(ancestor) {
            Ok(mut resolved) => {
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or("The mod path has no existing ancestor")?
                        .to_os_string(),
                );
                ancestor = ancestor
                    .parent()
                    .ok_or("The mod path has no existing ancestor")?;
            }
            Err(error) => return Err(format!("Could not resolve {}: {error}", log_name(ancestor))),
        }
    }
}

pub(super) fn reject_link(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect {}: {error}", log_name(path))),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Mod paths through junctions or symbolic links are unsupported".into());
        }
    }
    if metadata.file_type().is_symlink() {
        return Err("Mod paths through symbolic links are unsupported".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "native_files_tests.rs"]
mod tests;
