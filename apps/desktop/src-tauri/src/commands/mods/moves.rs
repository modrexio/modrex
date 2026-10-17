use super::engine::{ModEngineConfig, ModUnit, ScanTarget};
use super::naming::{log_name, sidecar_path};
use super::native_files::{paths_equal, resolve_existing_ancestor, NativeGuard};
use super::paths::{disabled_base, mods_base};
use super::state::{save_error, save_state};
use super::types::{InstalledMod, ModFolder, ModsState};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Renames installed mods and app folders as one operation.
///
/// Every rename of a file unit has to take its companions along: Unreal mounts the container
/// only through a pak of the same name, so a pak renamed alone loads nothing. A plan either
/// completes or leaves every file where it started.
#[derive(Default)]
pub struct Moves {
    units: Vec<Unit>,
    parents: Vec<PathBuf>,
    native: Option<NativeGuard>,
}

#[derive(Default)]
struct Unit {
    files: Vec<(PathBuf, PathBuf)>,
    // Declared companions, moved when present. Most paks ship none.
    companions: Vec<(PathBuf, PathBuf)>,
}

impl Moves {
    pub(super) fn with_native_guard(native: NativeGuard) -> Self {
        Self {
            units: Vec::new(),
            parents: Vec::new(),
            native: Some(native),
        }
    }
    pub fn for_game(game_path: &str, cfg: &super::engine::ModEngineConfig) -> Result<Self, String> {
        Ok(Self::with_native_guard(NativeGuard::load(game_path, cfg)?))
    }
    pub fn unit(&mut self, target: &ScanTarget, from: PathBuf, to: PathBuf) {
        let mut unit = Unit::default();
        if let ModUnit::File { extension, .. } = &target.unit {
            for ext in target.companions {
                let (Some(a), Some(b)) = (
                    sidecar_path(&from, extension, ext),
                    sidecar_path(&to, extension, ext),
                ) else {
                    continue;
                };
                unit.companions.push((a, b));
            }
        }
        unit.files.push((from, to));
        self.units.push(unit);
    }

    pub fn path(&mut self, from: PathBuf, to: PathBuf) {
        self.units.push(Unit {
            files: vec![(from, to)],
            companions: Vec::new(),
        });
    }

    pub(super) fn folder(
        &mut self,
        game_path: &str,
        targets: &[&ScanTarget],
        from_rel: &str,
        to_rel: &str,
    ) -> Result<(), String> {
        if from_rel == to_rel {
            return Ok(());
        }
        for base in targets.iter().flat_map(|target| {
            [
                mods_base(game_path, target),
                disabled_base(game_path, target),
            ]
        }) {
            let from = base.join(from_rel);
            if !exists(&from)? {
                continue;
            }
            let to = base.join(to_rel);
            let parent = to.parent().expect("an app folder has a parent directory");
            if let Some(native) = &self.native {
                native.check_tree(&from)?;
                native.check_tree(&to)?;
                native.check_path(parent)?;
            }
            self.parents.push(parent.to_path_buf());
            self.path(from, to);
        }
        Ok(())
    }

    /// Checks every destination before touching anything, then renames through a staging
    /// name so a plan may swap two names. The staging name prefixes the whole filename, so
    /// a pak and its companions still share a stem if Modrex dies between the two passes.
    pub fn run(self) -> Result<Applied, String> {
        let mut units: Vec<Vec<(PathBuf, PathBuf)>> = Vec::new();
        for unit in self.units {
            let mut files = unit.files;
            for (a, b) in unit.companions {
                if exists(&a)? {
                    files.push((a, b));
                }
            }
            files.retain(|(a, b)| a != b);
            if !files.is_empty() {
                units.push(files);
            }
        }
        if let Some(native) = &self.native {
            native.verify_unchanged()?;
            for (index, files) in units.iter().enumerate() {
                for (from, to) in files {
                    native.check_tree(from)?;
                    native.check_tree(to)?;
                    native.check_tree(&staging_path(from, index))?;
                }
            }
        }
        let paths: Vec<_> = units.iter().flatten().cloned().collect();
        if self
            .native
            .as_ref()
            .is_some_and(NativeGuard::shares_native_files)
        {
            NativeGuard::check_move_destinations(&paths)?;
        } else {
            check_move_destinations(&paths)?;
        }

        for (index, files) in units.iter().enumerate() {
            for (from, _) in files {
                let staged = staging_path(from, index);
                if exists(&staged)? {
                    return Err(format!("{} is in the way", log_name(&staged)));
                }
            }
        }
        for parent in &self.parents {
            if let Some(native) = &self.native {
                native.check_path(parent)?;
            }
        }
        for parent in &self.parents {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not prepare the destination: {error}"))?;
        }

        let mut done = Vec::new();
        for (n, files) in units.iter().enumerate() {
            for (from, _) in files {
                let staged = staging_path(from, n);
                if exists(&staged).map_err(|e| undone(&done, e))? {
                    return Err(undone(
                        &done,
                        format!("{} is in the way", log_name(&staged)),
                    ));
                }
                rename(from, &staged, &mut done)?;
            }
        }
        for (n, files) in units.iter().enumerate() {
            for (from, to) in files {
                rename(&staging_path(from, n), to, &mut done)?;
            }
        }
        Ok(Applied {
            units,
            native: self.native,
        })
    }
}

pub struct Applied {
    units: Vec<Vec<(PathBuf, PathBuf)>>,
    native: Option<NativeGuard>,
}

impl Applied {
    /// Saves the state that describes the moved files, or puts the files back when it cannot
    /// be saved, since the record on disk would then name files that are not there.
    pub fn save(self, state_path: &Path, state: &ModsState) -> Result<(), String> {
        let result = self
            .native
            .as_ref()
            .map_or(Ok(()), |native| native.check_state_path(state_path))
            .and_then(|()| save_state(state_path, state).map_err(save_error));
        let Err(failure) = result else {
            return Ok(());
        };
        let inverse = Moves {
            units: self
                .units
                .into_iter()
                .map(|files| Unit {
                    files: files.into_iter().map(|(a, b)| (b, a)).collect(),
                    companions: Vec::new(),
                })
                .collect(),
            parents: Vec::new(),
            native: None,
        };
        match inverse.run() {
            Ok(_) => Err(failure),
            Err(undo) => Err(format!(
                "{failure}; the files were moved and could not be put back either: {undo}"
            )),
        }
    }
}

// Folder target ownership is covered by tracked_directory_collision tests.
pub(super) fn folder_targets<'a>(
    cfg: &'a ModEngineConfig,
    folders: &[ModFolder],
    mods: &[InstalledMod],
    folder_id: &str,
) -> Result<Vec<&'a ScanTarget>, String> {
    let folder = folders
        .iter()
        .find(|folder| folder.id == folder_id)
        .expect("the operation found the folder before selecting its targets");
    let mut targets = Vec::new();
    'targets: for target in cfg.targets {
        for m in mods.iter().filter(|m| {
            cfg.mod_target(m).tag == target.tag
                && m.folder_id == folder.parent_id
                && !m
                    .location
                    .as_deref()
                    .is_some_and(|tag| tag.starts_with("host:"))
        }) {
            if paths_equal(Path::new(&m.filename), Path::new(&folder.disk_name))? {
                continue 'targets;
            }
        }
        if target.tag == cfg.primary().tag
            || mods.iter().any(|m| {
                if cfg.mod_target(m).tag != target.tag {
                    return false;
                }
                let mut current = m.folder_id.as_deref();
                while let Some(id) = current {
                    if id == folder_id {
                        return true;
                    }
                    current = folders
                        .iter()
                        .find(|folder| folder.id == id)
                        .and_then(|folder| folder.parent_id.as_deref());
                }
                false
            })
        {
            targets.push(target);
        }
    }
    Ok(targets)
}

fn check_move_destinations(moves: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    // Windows ordinal Unicode equality is preserved by the identity checker.
    #[cfg(windows)]
    if moves.iter().any(|(from, to)| {
        !from.as_os_str().as_encoded_bytes().is_ascii()
            || !to.as_os_str().as_encoded_bytes().is_ascii()
    }) {
        return NativeGuard::check_move_destinations(moves);
    }
    let key = |path: &Path| {
        #[cfg(windows)]
        {
            PathBuf::from(path.as_os_str().to_ascii_lowercase())
        }
        #[cfg(not(windows))]
        {
            path.to_path_buf()
        }
    };
    let mut sources = HashSet::new();
    let mut destinations = HashSet::new();
    for (from, to) in moves {
        if !sources.insert(key(from)) {
            return Err("The move contains two references to the same mod file".into());
        }
        if !destinations.insert(key(to)) {
            return Err("Two mod files would have the same destination name".into());
        }
    }
    let mut source_identities = None;
    for (_, to) in moves {
        if sources.contains(&key(to)) || !exists(to)? {
            continue;
        }
        let identity = resolve_existing_ancestor(to)?;
        let identities = match &source_identities {
            Some(identities) => identities,
            None => source_identities.insert(
                moves
                    .iter()
                    .map(|(from, _)| resolve_existing_ancestor(from).map(|path| key(&path)))
                    .collect::<Result<HashSet<_>, String>>()?,
            ),
        };
        #[cfg(windows)]
        if !identity.as_os_str().as_encoded_bytes().is_ascii()
            || identities
                .iter()
                .any(|path| !path.as_os_str().as_encoded_bytes().is_ascii())
        {
            return NativeGuard::check_move_destinations(moves);
        }
        if !identities.contains(&key(&identity)) {
            return Err(format!(
                "{} is in the way. Move or delete it, then try again.",
                log_name(to)
            ));
        }
    }
    Ok(())
}

fn staging_path(path: &Path, n: usize) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!("__modrex_move_{n}__{name}"))
}

pub(super) fn exists(path: &Path) -> Result<bool, String> {
    path.try_exists()
        .map_err(|e| format!("could not check {}: {e}", log_name(path)))
}

fn rename(from: &Path, to: &Path, done: &mut Vec<(PathBuf, PathBuf)>) -> Result<(), String> {
    if let Err(e) = fs::rename(from, to) {
        return Err(undone(
            done,
            format!("could not move {}: {e}", log_name(from)),
        ));
    }
    done.push((to.to_path_buf(), from.to_path_buf()));
    Ok(())
}

fn undone(done: &[(PathBuf, PathBuf)], failure: String) -> String {
    match put_back(done) {
        Ok(()) => failure,
        Err(undo) => format!("{failure}; and putting the files back failed: {undo}"),
    }
}

/// Reverses renames already made, most recent first so each name is free again before the
/// one before it is restored. Each pair is (where the file is now, where it was).
pub(super) fn put_back(moved: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let problems: Vec<String> = moved
        .iter()
        .rev()
        .filter_map(|(now, was)| match fs::rename(now, was) {
            Ok(()) => None,
            Err(e) => Some(format!("{}: {e}", log_name(was))),
        })
        .collect();
    if problems.is_empty() {
        return Ok(());
    }
    Err(problems.join("; "))
}

#[cfg(test)]
#[path = "moves_tests.rs"]
mod tests;
