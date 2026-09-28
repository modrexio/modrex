use super::engine::{ModUnit, ScanTarget};
use super::naming::{log_name, sidecar_path};
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
pub struct Moves(Vec<Unit>);

#[derive(Default)]
struct Unit {
    files: Vec<(PathBuf, PathBuf)>,
    // Declared companions, moved when present. Most paks ship none.
    companions: Vec<(PathBuf, PathBuf)>,
}

impl Moves {
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
        self.0.push(unit);
    }

    pub fn path(&mut self, from: PathBuf, to: PathBuf) {
        self.0.push(Unit {
            files: vec![(from, to)],
            companions: Vec::new(),
        });
    }

    /// Checks every destination before touching anything, then renames through a staging
    /// name so a plan may swap two names. The staging name prefixes the whole filename, so
    /// a pak and its companions still share a stem if Modrex dies between the two passes.
    pub fn run(self) -> Result<Applied, String> {
        let mut units: Vec<Vec<(PathBuf, PathBuf)>> = Vec::new();
        for unit in self.0 {
            let mut files = unit.files;
            for (a, b) in unit.companions {
                if occupied(&a)? {
                    files.push((a, b));
                }
            }
            files.retain(|(a, b)| a != b);
            if !files.is_empty() {
                units.push(files);
            }
        }
        let sources: HashSet<&Path> = units.iter().flatten().map(|(a, _)| a.as_path()).collect();
        let mut destinations = HashSet::new();
        for (_, to) in units.iter().flatten() {
            if !destinations.insert(to.as_path()) {
                return Err(format!("two files would both be named {}", log_name(to)));
            }
            if !sources.contains(to.as_path()) && occupied(to)? {
                return Err(format!(
                    "{} is in the way. Move or delete it, then try again.",
                    log_name(to)
                ));
            }
        }

        let mut done = Vec::new();
        for (n, files) in units.iter().enumerate() {
            for (from, _) in files {
                let staged = staging_path(from, n);
                if occupied(&staged).map_err(|e| undone(&done, e))? {
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
        Ok(Applied(units))
    }
}

pub struct Applied(Vec<Vec<(PathBuf, PathBuf)>>);

impl Applied {
    /// Saves the state that describes the moved files, or puts the files back when it cannot
    /// be saved, since the old record would then point at names that no longer exist.
    pub fn save(self, state_path: &Path, state: &ModsState) -> Result<(), String> {
        let Err(e) = save_state(state_path, state) else {
            return Ok(());
        };
        let failure = save_error(e);
        let inverse = Moves(
            self.0
                .into_iter()
                .map(|files| Unit {
                    files: files.into_iter().map(|(a, b)| (b, a)).collect(),
                    companions: Vec::new(),
                })
                .collect(),
        );
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

fn occupied(path: &Path) -> Result<bool, String> {
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
