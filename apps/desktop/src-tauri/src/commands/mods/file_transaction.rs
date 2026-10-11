use super::naming::{log_name, sidecar_path};
use super::native_files::NativeGuard;
use super::state::{save_error, save_state};
use super::types::ModsState;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Keeps replaced files until both their replacements and the installed list are saved.
pub(super) fn replace_family(
    source: Option<&Path>,
    destination: &Path,
    old: Option<&Path>,
    target: &super::engine::ScanTarget,
    native: &NativeGuard,
    state_path: &Path,
    state: &ModsState,
) -> Result<(), String> {
    let extension = target
        .content_extension()
        .expect("a file family has a primary extension");
    let companions = target.companions;
    let mut outputs = Vec::new();
    if let Some(source) = source {
        outputs.push((source.to_path_buf(), destination.to_path_buf()));
        for companion in companions {
            let from = sidecar_path(source, extension, companion)
                .expect("the source has its declared extension");
            let to = sidecar_path(destination, extension, companion)
                .expect("the destination has its declared extension");
            if from.try_exists().map_err(|error| error.to_string())? {
                outputs.push((from, to));
            }
        }
    }
    let mut originals: HashSet<PathBuf> = HashSet::new();
    for path in [Some(destination), old].into_iter().flatten() {
        native.check_file(path)?;
        originals.insert(path.to_path_buf());
        for companion in companions {
            let sibling = sidecar_path(path, extension, companion)
                .expect("the installed file has its declared extension");
            native.check_file(&sibling)?;
            originals.insert(sibling);
        }
    }
    let parent = destination
        .parent()
        .ok_or("The mod file has no parent folder")?;
    native.check_state_path(state_path)?;
    native.check_path(parent)?;
    native.verify_unchanged()?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not prepare the mod folder: {error}"))?;
    // The stash stays on the target volume so restoring bytes needs only renames.
    let stash = parent.join(format!(".modrex-install-{}", Uuid::new_v4()));
    native.check_tree(&stash)?;
    fs::create_dir(&stash)
        .map_err(|error| format!("Could not stage the mod replacement: {error}"))?;
    let mut saved = Vec::new();
    let mut written = Vec::new();
    let result = (|| {
        for (index, (from, _)) in outputs.iter().enumerate() {
            fs::copy(from, stash.join(format!("new-{index}")))
                .map_err(|error| format!("Could not stage {}: {error}", log_name(from)))?;
        }
        native.verify_unchanged()?;
        for (index, path) in originals.iter().enumerate() {
            if !path.try_exists().map_err(|error| error.to_string())? {
                continue;
            }
            let backup = stash.join(format!("old-{index}"));
            fs::rename(path, &backup)
                .map_err(|error| format!("Could not preserve {}: {error}", log_name(path)))?;
            saved.push((backup, path.clone()));
        }
        for (index, (_, to)) in outputs.iter().enumerate() {
            fs::rename(stash.join(format!("new-{index}")), to)
                .map_err(|error| format!("Could not install {}: {error}", log_name(to)))?;
            written.push(to.clone());
        }
        native.verify_unchanged()?;
        save_state(state_path, state).map_err(save_error)
    })();
    if let Err(failure) = result {
        let mut errors = Vec::new();
        for path in written.iter().rev() {
            if let Err(error) = fs::remove_file(path) {
                errors.push(format!("{}: {error}", log_name(path)));
            }
        }
        for (backup, path) in saved.iter().rev() {
            if let Err(error) = fs::rename(backup, path) {
                errors.push(format!("{}: {error}", log_name(path)));
            }
        }
        if !errors.is_empty() {
            return Err(format!("{failure}. Restoring the original files failed: {}. The replacement backup was kept at {}", errors.join(", "), stash.display()));
        }
        if let Err(error) = fs::remove_dir_all(&stash) {
            return Err(format!(
                "{failure}. Could not clean the replacement staging folder: {error}"
            ));
        }
        return Err(failure);
    }
    if let Err(error) = fs::remove_dir_all(&stash) {
        log::warn!(
            "Could not clean completed mod replacement {}: {error}",
            log_name(&stash)
        );
    }
    Ok(())
}
