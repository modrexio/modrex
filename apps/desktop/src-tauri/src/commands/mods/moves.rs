use super::engine::{ModUnit, ScanTarget};
use super::naming::{log_name, sidecar_path};
use super::native_files::NativeGuard;
use super::state::{save_error, save_state};
use super::types::ModsState;
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
        if let Some(native) = self
            .native
            .as_ref()
            .filter(|native| native.shares_native_files())
        {
            native.check_move_destinations(&units.iter().flatten().cloned().collect::<Vec<_>>())?;
        } else {
            let sources: HashSet<&Path> =
                units.iter().flatten().map(|(a, _)| a.as_path()).collect();
            let mut destinations = HashSet::new();
            for (_, to) in units.iter().flatten() {
                if !destinations.insert(to.as_path()) {
                    return Err(format!("two files would both be named {}", log_name(to)));
                }
                if !sources.contains(to.as_path()) && exists(to)? {
                    return Err(format!(
                        "{} is in the way. Move or delete it, then try again.",
                        log_name(to)
                    ));
                }
            }
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
