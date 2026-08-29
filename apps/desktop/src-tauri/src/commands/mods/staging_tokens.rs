//! Backend-owned handles for the staged archives a prompt hands back to the renderer.
//!
//! An archive prompt used to travel as a path, and every follow-up command took that path
//! back. A path is not authority: the renderer could name any local archive and the backend
//! would read it, install from it, and build a cleanup plan around it. A handle names an
//! entry here instead, so the backend keeps deciding which file it will open and which one
//! it will remove, and a handle issued for one workflow cannot drive another.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::cleanup::{self, CleanupPlan};

/// Which prompt a handle was issued for. A grant is only usable by the workflow that
/// created it, so a multi-entry handle cannot be replayed into the host-pack command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StagedArchiveKind {
    MultiEntry,
    CrimeBossFlat,
    HostPack,
}

struct Grant {
    token: String,
    path: PathBuf,
    cleanup: CleanupPlan,
    kind: StagedArchiveKind,
    /// How many authorized operations are reading the archive right now. Cleanup is refused
    /// while this is above zero, so a discard cannot pull the file out from under an install.
    borrows: usize,
    issued: Instant,
}

/// A prompt the user never answered still holds its archive. Sweeping on registration keeps
/// abandoned ones from accumulating without needing a background task.
const GRANT_TTL: Duration = Duration::from_secs(60 * 60);

/// Each install shows at most one prompt, so the live set is tiny. The bound only stops a
/// very long session from growing without limit.
const MAX_GRANTS: usize = 64;

type Registry = Mutex<Vec<Grant>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

/// Only ever a short prefix, so a log line can be correlated within a session without
/// writing down something that authorizes anything.
fn short(token: &str) -> &str {
    token.get(..8).unwrap_or("")
}

/// Registers a staged archive and returns the handle standing for it.
///
/// The handle is a v4 uuid, so it says nothing about the path and cannot be derived from
/// one. When there is no room the new artifact is removed through its own plan rather than
/// left behind, and the caller is told registration failed.
pub(crate) fn register(
    kind: StagedArchiveKind,
    path: &Path,
    cleanup_plan: CleanupPlan,
) -> Result<String, ()> {
    let mut expired = Vec::new();
    let issued = {
        let mut grants = registry().lock().unwrap_or_else(|e| e.into_inner());
        let mut i = 0;
        while i < grants.len() {
            // A borrowed grant is never swept: something is reading its archive.
            if grants[i].borrows == 0 && grants[i].issued.elapsed() > GRANT_TTL {
                expired.push(grants.remove(i).cleanup);
            } else {
                i += 1;
            }
        }
        if grants.len() >= MAX_GRANTS {
            None
        } else {
            let token = Uuid::new_v4().to_string();
            grants.push(Grant {
                token: token.clone(),
                path: path.to_path_buf(),
                cleanup: cleanup_plan.clone(),
                kind,
                borrows: 0,
                issued: Instant::now(),
            });
            Some(token)
        }
    };
    // Removal happens outside the lock: it touches the disk and nothing here needs the map.
    for plan in &expired {
        cleanup::run_sync(plan);
    }
    match issued {
        Some(token) => Ok(token),
        None => {
            log::warn!("staged archives: registry full, discarding the archive just staged");
            cleanup::run_sync(&cleanup_plan);
            Err(())
        }
    }
}

/// Authorizes one read of a grant's archive, returning the registered path. The borrow must
/// be released, which is what keeps a concurrent discard from removing the file mid-install.
pub(crate) fn borrow(token: &str, kind: StagedArchiveKind) -> Option<PathBuf> {
    let mut grants = registry().lock().unwrap_or_else(|e| e.into_inner());
    let grant = grants.iter_mut().find(|g| g.token == token)?;
    if grant.kind != kind {
        log::warn!(
            "staged archives: handle {} was not issued for this operation",
            short(token)
        );
        return None;
    }
    grant.borrows += 1;
    Some(grant.path.clone())
}

pub(crate) fn release(token: &str) {
    let mut grants = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(grant) = grants.iter_mut().find(|g| g.token == token) {
        grant.borrows = grant.borrows.saturating_sub(1);
    }
}

/// Takes the grant for token and returns the plan for the artifact it owns. Removing under
/// the lock is what makes a second discard a miss rather than a second deletion.
pub(crate) fn finalize(token: &str) -> Option<CleanupPlan> {
    let mut grants = registry().lock().unwrap_or_else(|e| e.into_inner());
    let index = grants.iter().position(|g| g.token == token)?;
    if grants[index].borrows > 0 {
        log::warn!(
            "staged archives: handle {} is still in use, leaving its archive in place",
            short(token)
        );
        return None;
    }
    Some(grants.remove(index).cleanup)
}

/// Takes every remaining grant, for shutdown.
pub(crate) fn drain() -> Vec<CleanupPlan> {
    let mut grants = registry().lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *grants)
        .into_iter()
        .map(|g| g.cleanup)
        .collect()
}

#[cfg(test)]
pub(crate) fn grant_count() -> usize {
    registry().lock().unwrap_or_else(|e| e.into_inner()).len()
}

#[cfg(test)]
pub(crate) fn clear_for_test() {
    registry().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// Releases a borrow when the operation holding it ends, including on an early return.
pub(crate) struct BorrowGuard(String);

impl BorrowGuard {
    pub(crate) fn new(token: &str) -> Self {
        Self(token.to_string())
    }
}

impl Drop for BorrowGuard {
    fn drop(&mut self) {
        release(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// The registry is process-wide, so these tests take turns with it.
    fn exclusive() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
        let guard = LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        clear_for_test();
        guard
    }

    fn staged(dir: &tempfile::TempDir, name: &str) -> (PathBuf, CleanupPlan) {
        let p = dir.path().join(name);
        std::fs::write(&p, b"archive").unwrap();
        let plan = CleanupPlan::RemoveOwnedFile(p.clone());
        (p, plan)
    }

    #[test]
    fn a_handle_resolves_only_for_its_own_workflow() {
        let _g = exclusive();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-a.zip");
        let token = register(StagedArchiveKind::MultiEntry, &path, plan).unwrap();

        assert_eq!(borrow(&token, StagedArchiveKind::HostPack), None);
        assert_eq!(borrow(&token, StagedArchiveKind::CrimeBossFlat), None);
        assert_eq!(borrow(&token, StagedArchiveKind::MultiEntry), Some(path));
    }

    #[test]
    fn unknown_and_guessed_handles_resolve_to_nothing() {
        let _g = exclusive();
        for guess in ["", "nope", "00000000-0000-0000-0000-000000000000"] {
            assert_eq!(
                borrow(guess, StagedArchiveKind::MultiEntry),
                None,
                "{guess}"
            );
            assert!(finalize(guess).is_none(), "{guess}");
        }
    }

    /// A multi-entry prompt installs several entries from one archive, so a read must not
    /// consume the grant. Only finalizing does.
    #[test]
    fn a_multi_entry_handle_survives_repeated_reads_then_finalizes_once() {
        let _g = exclusive();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-multi.zip");
        let token = register(StagedArchiveKind::MultiEntry, &path, plan).unwrap();

        for _ in 0..3 {
            assert_eq!(
                borrow(&token, StagedArchiveKind::MultiEntry),
                Some(path.clone())
            );
            release(&token);
        }
        assert!(
            finalize(&token).is_some(),
            "first finalize owns the archive"
        );
        assert!(
            finalize(&token).is_none(),
            "a repeat is a harmless rejection"
        );
        assert_eq!(borrow(&token, StagedArchiveKind::MultiEntry), None);
    }

    #[test]
    fn one_handle_never_reaches_another_grants_archive() {
        let _g = exclusive();
        let dir = tempfile::TempDir::new().unwrap();
        let (a_path, a_plan) = staged(&dir, "modrex-a.zip");
        let (b_path, b_plan) = staged(&dir, "modrex-b.zip");
        let a = register(StagedArchiveKind::MultiEntry, &a_path, a_plan).unwrap();
        let b = register(StagedArchiveKind::MultiEntry, &b_path, b_plan).unwrap();
        assert_ne!(a, b);
        assert_eq!(borrow(&a, StagedArchiveKind::MultiEntry), Some(a_path));
        assert_eq!(borrow(&b, StagedArchiveKind::MultiEntry), Some(b_path));
    }

    /// A discard arriving mid-install must not pull the archive out from under it.
    #[test]
    fn a_borrowed_grant_cannot_be_finalized() {
        let _g = exclusive();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-busy.zip");
        let token = register(StagedArchiveKind::MultiEntry, &path, plan).unwrap();

        let guard = BorrowGuard::new(&token);
        borrow(&token, StagedArchiveKind::MultiEntry).unwrap();
        assert!(finalize(&token).is_none(), "in use, so nothing is removed");
        assert!(path.exists());

        drop(guard);
        assert!(finalize(&token).is_some());
    }

    #[test]
    fn concurrent_finalizers_cannot_both_win() {
        let _g = exclusive();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-race.zip");
        let token = register(StagedArchiveKind::MultiEntry, &path, plan).unwrap();
        let (a, b) = (token.clone(), token.clone());
        let ha = std::thread::spawn(move || finalize(&a));
        let hb = std::thread::spawn(move || finalize(&b));
        let results = [ha.join().unwrap(), hb.join().unwrap()];
        assert_eq!(results.iter().filter(|r| r.is_some()).count(), 1);
    }

    /// A full registry refuses the new archive and removes it, rather than evicting a live
    /// grant and orphaning the artifact that grant still owns. Filling until refusal keeps
    /// this deterministic even though other tests share the process-wide registry.
    #[test]
    fn a_full_registry_refuses_and_cleans_the_new_artifact() {
        let _g = exclusive();
        let dir = tempfile::TempDir::new().unwrap();
        let mut live = Vec::new();
        let refused = loop {
            let (p, plan) = staged(&dir, &format!("modrex-{}.zip", live.len()));
            match register(StagedArchiveKind::MultiEntry, &p, plan) {
                Ok(token) => live.push((p, token)),
                Err(()) => break p,
            }
            assert!(live.len() <= MAX_GRANTS, "registration never refused");
        };
        assert!(
            !refused.exists(),
            "the refused artifact must not be left behind"
        );
        for (path, token) in &live {
            assert!(path.exists(), "a live grant's archive must survive");
            assert!(
                borrow(token, StagedArchiveKind::MultiEntry).is_some(),
                "a live grant must not have been evicted"
            );
            release(token);
        }
    }

    #[test]
    fn draining_returns_every_remaining_plan() {
        let _g = exclusive();
        let dir = tempfile::TempDir::new().unwrap();
        for i in 0..3 {
            let (p, plan) = staged(&dir, &format!("modrex-{i}.zip"));
            register(StagedArchiveKind::MultiEntry, &p, plan).unwrap();
        }
        assert_eq!(drain().len(), 3);
        assert_eq!(grant_count(), 0);
    }

    /// Handles are never written out in full, so a log cannot hand one to a reader.
    #[test]
    fn only_a_prefix_of_a_handle_is_loggable() {
        let token = Uuid::new_v4().to_string();
        let logged = short(&token);
        assert_eq!(logged.len(), 8);
        assert!(token.starts_with(logged));
        assert!(logged.len() < token.len() / 2);
    }
}
