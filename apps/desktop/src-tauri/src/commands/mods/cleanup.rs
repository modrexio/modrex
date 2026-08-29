//! Removal of the temporary artifacts an install creates.
//!
//! A plan names the exact artifact the staging step produced, so it is built by whatever code
//! created that artifact. It is never derived from the install target's shape: a directory
//! install target does not make the temporary source's parent Modrex's to delete, and deriving
//! a recursive target from tmp.parent() is how the OS temp root itself became a deletion
//! target for .pdmod and loose-file installs.

use std::path::{Path, PathBuf};

use super::naming::PAK_SIDECAR_EXTENSIONS;

// The shared Remove-Owned prefix is the point: a variant may only ever name an artifact this
// operation created, and spelling that out at each one keeps the invariant visible at the
// construction sites rather than only here.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanupPlan {
    /// A Modrex-created file, plus any pak sidecars sharing its stem.
    RemoveOwnedFileWithSidecars(PathBuf),
    /// A Modrex-created file that has no sidecars, such as a downloaded archive.
    RemoveOwnedFile(PathBuf),
    /// A Modrex-created directory tree.
    RemoveOwnedDirectory(PathBuf),
}

/// Why a target was rejected. Kept distinct so a refusal reads unambiguously in the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    IsTempRoot,
    OutsideTempRoot,
    Symlink,
    Unresolvable,
}

/// The boundary every temporary artifact must sit inside. Taken from the environment on each
/// call so a test can point it somewhere isolated.
fn temp_root() -> PathBuf {
    std::env::temp_dir()
}

/// Resolves target and proves it is a strict descendant of root.
///
/// Canonicalizing both sides is what makes the comparison meaningful: it removes any .. and
/// . components, resolves symlinks and junctions so a link cannot point the removal outside
/// the boundary, and normalizes Windows casing and verbatim prefixes so the comparison is not
/// a string prefix test. A target that cannot be resolved is refused rather than removed.
fn confine_to(root: &Path, target: &Path) -> Result<PathBuf, Refusal> {
    // A link is refused outright: removing it either deletes the link's target tree or, on
    // Windows, unlinks a junction Modrex did not create.
    match std::fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(Refusal::Symlink),
        Ok(_) => {}
        Err(_) => return Err(Refusal::Unresolvable),
    }
    let root = root.canonicalize().map_err(|_| Refusal::Unresolvable)?;
    let target = target.canonicalize().map_err(|_| Refusal::Unresolvable)?;
    if target == root {
        return Err(Refusal::IsTempRoot);
    }
    // Also rejects every ancestor of root, a drive root, and the home directory, none of
    // which are descendants of it.
    if !target.starts_with(&root) {
        return Err(Refusal::OutsideTempRoot);
    }
    Ok(target)
}

/// Whether a directory may be removed recursively, relative to the staging boundary.
pub fn owned_staging_dir(root: &Path, target: &Path) -> Result<PathBuf, Refusal> {
    confine_to(root, target)
}

/// Whether a file may be removed. Same boundary as a directory, so a user-supplied source
/// that reached a plan by mistake is refused rather than deleted.
pub fn owned_staging_file(root: &Path, target: &Path) -> Result<PathBuf, Refusal> {
    confine_to(root, target)
}

/// Carries out plan, logging what it removed or refused. A refusal leaves the artifact in
/// place: leaking a temporary file is preferable to deleting something Modrex does not own,
/// and the install itself has already succeeded by this point.
pub async fn run(plan: &CleanupPlan) {
    run_in(&temp_root(), plan).await
}

pub async fn run_in(root: &Path, plan: &CleanupPlan) {
    match plan {
        CleanupPlan::RemoveOwnedFile(path) => remove_owned_file(root, path).await,
        CleanupPlan::RemoveOwnedFileWithSidecars(path) => {
            remove_owned_file(root, path).await;
            for ext in PAK_SIDECAR_EXTENSIONS {
                let sidecar = path.with_extension(ext);
                if let Ok(safe) = owned_staging_file(root, &sidecar) {
                    let _ = tokio::fs::remove_file(&safe).await;
                }
            }
        }
        CleanupPlan::RemoveOwnedDirectory(dir) => match owned_staging_dir(root, dir) {
            Ok(safe) => {
                if let Err(e) = tokio::fs::remove_dir_all(&safe).await {
                    log::warn!("install cleanup: remove staging dir {safe:?}: {e}");
                }
            }
            Err(Refusal::Unresolvable) => {}
            Err(r) => log::warn!("install cleanup: refused to remove staging dir {dir:?}: {r:?}"),
        },
    }
}

async fn remove_owned_file(root: &Path, path: &Path) {
    match owned_staging_file(root, path) {
        Ok(safe) => {
            if let Err(e) = tokio::fs::remove_file(&safe).await {
                log::warn!("install cleanup: remove {safe:?}: {e}");
            }
        }
        // A staged file is normally gone only because it was moved into place, so a missing
        // one is not worth a warning; anything else is.
        Err(Refusal::Unresolvable) => {}
        Err(r) => log::warn!("install cleanup: refused to remove {path:?}: {r:?}"),
    }
}

/// Same guarantees as run, for the archive resolvers, which are not async.
pub fn run_sync(plan: &CleanupPlan) {
    run_sync_in(&temp_root(), plan)
}

pub fn run_sync_in(root: &Path, plan: &CleanupPlan) {
    let remove_file = |path: &Path| match owned_staging_file(root, path) {
        Ok(safe) => {
            if let Err(e) = std::fs::remove_file(&safe) {
                log::warn!("install cleanup: remove {safe:?}: {e}");
            }
        }
        Err(Refusal::Unresolvable) => {}
        Err(r) => log::warn!("install cleanup: refused to remove {path:?}: {r:?}"),
    };
    match plan {
        CleanupPlan::RemoveOwnedFile(path) => remove_file(path),
        CleanupPlan::RemoveOwnedFileWithSidecars(path) => {
            remove_file(path);
            for ext in PAK_SIDECAR_EXTENSIONS {
                let sidecar = path.with_extension(ext);
                if let Ok(safe) = owned_staging_file(root, &sidecar) {
                    let _ = std::fs::remove_file(&safe);
                }
            }
        }
        CleanupPlan::RemoveOwnedDirectory(dir) => match owned_staging_dir(root, dir) {
            Ok(safe) => {
                if let Err(e) = std::fs::remove_dir_all(&safe) {
                    log::warn!("install cleanup: remove staging dir {safe:?}: {e}");
                }
            }
            Err(Refusal::Unresolvable) => {}
            Err(r) => log::warn!("install cleanup: refused to remove staging dir {dir:?}: {r:?}"),
        },
    }
}
