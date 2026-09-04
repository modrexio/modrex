//! Backend-owned handles for the staged archives a prompt hands back to the renderer.
//!
//! An archive prompt used to travel as a path, and every follow-up command took that path
//! back. A path is not authority: the renderer could name any local archive and the backend
//! would read it, install from it, and build a cleanup plan around it. A handle names a grant
//! in a registry instead, so the backend keeps deciding which file it will open and which one
//! it will remove, and a handle issued for one workflow cannot drive another.
//!
//! The registry is a value the application owns, not a process global. Every caller names the
//! registry it means, which is what lets a test hold one of its own instead of sharing
//! whatever the rest of the suite happened to leave behind.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
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

/// Identifies one entry of a staged archive. Issued while enumerating, so it survives
/// display names that normalize onto each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(transparent)]
pub(crate) struct ArchiveEntryId(pub(crate) u32);

/// How an issued entry is reached inside its archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StagedEntrySource {
    /// Position in the archive's own enumeration order.
    File { index: u32 },
    /// Every entry under this normalized directory path.
    Directory { prefix: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StagedEntry {
    pub(crate) source: StagedEntrySource,
    pub(crate) display_name: String,
}

struct Grant {
    token: String,
    entries: Vec<StagedEntry>,
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

pub(crate) struct StagingRegistry {
    grants: Mutex<Vec<Grant>>,
    capacity: usize,
    ttl: Duration,
}

impl Default for StagingRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Only ever a short prefix, so a log line can be correlated within a session without
/// writing down something that authorizes anything.
fn short(token: &str) -> &str {
    token.get(..8).unwrap_or("")
}

impl StagingRegistry {
    pub(crate) fn new() -> Self {
        Self::with_limits(MAX_GRANTS, GRANT_TTL)
    }

    pub(crate) fn with_limits(capacity: usize, ttl: Duration) -> Self {
        Self {
            grants: Mutex::new(Vec::new()),
            capacity,
            ttl,
        }
    }

    /// Registers a staged archive and returns the handle standing for it.
    ///
    /// The handle is a v4 uuid, so it says nothing about the path and cannot be derived from
    /// one. When there is no room the new artifact is removed through its own plan rather
    /// than left behind, and the caller is told registration failed.
    pub(crate) fn register(
        &self,
        kind: StagedArchiveKind,
        path: &Path,
        cleanup_plan: CleanupPlan,
        entries: Vec<StagedEntry>,
    ) -> Result<String, ()> {
        let mut expired = Vec::new();
        let issued = {
            let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
            let mut i = 0;
            while i < grants.len() {
                // A borrowed grant is never swept: something is reading its archive.
                if grants[i].borrows == 0 && grants[i].issued.elapsed() > self.ttl {
                    expired.push(grants.remove(i).cleanup);
                } else {
                    i += 1;
                }
            }
            if grants.len() >= self.capacity {
                None
            } else {
                let token = Uuid::new_v4().to_string();
                grants.push(Grant {
                    token: token.clone(),
                    entries,
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

    /// Authorizes one read of a grant's archive, returning the registered path. The borrow
    /// must be released, which is what keeps a concurrent discard from removing the file
    /// mid-install.
    pub(crate) fn borrow(&self, token: &str, kind: StagedArchiveKind) -> Option<PathBuf> {
        let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
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

    /// The entry this handle issued under id, if the handle belongs to kind and the id is
    /// one it actually issued.
    pub(crate) fn entry(
        &self,
        token: &str,
        kind: StagedArchiveKind,
        id: ArchiveEntryId,
    ) -> Option<StagedEntry> {
        let grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        let grant = grants.iter().find(|g| g.token == token)?;
        if grant.kind != kind {
            return None;
        }
        grant.entries.get(id.0 as usize).cloned()
    }

    /// Whether this handle offered an entry under name, for workflows whose renderer
    /// contract still names a directory rather than carrying an id.
    pub(crate) fn offers_entry_named(
        &self,
        token: &str,
        kind: StagedArchiveKind,
        name: &str,
    ) -> bool {
        let grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        grants
            .iter()
            .find(|g| g.token == token && g.kind == kind)
            .is_some_and(|g| g.entries.iter().any(|e| e.display_name == name))
    }

    pub(crate) fn release(&self, token: &str) {
        let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(grant) = grants.iter_mut().find(|g| g.token == token) {
            grant.borrows = grant.borrows.saturating_sub(1);
        }
    }

    /// Takes the grant for token and returns the plan for the artifact it owns. Removing
    /// under the lock is what makes a second discard a miss rather than a second deletion.
    pub(crate) fn finalize(&self, token: &str) -> Option<CleanupPlan> {
        let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
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
    pub(crate) fn drain(&self) -> Vec<CleanupPlan> {
        let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *grants)
            .into_iter()
            .map(|g| g.cleanup)
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn grant_count(&self) -> usize {
        self.grants.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// Releases a borrow when the operation holding it ends, including on an early return.
pub(crate) struct BorrowGuard<'a> {
    registry: &'a StagingRegistry,
    token: String,
}

impl<'a> BorrowGuard<'a> {
    pub(crate) fn new(registry: &'a StagingRegistry, token: &str) -> Self {
        Self {
            registry,
            token: token.to_string(),
        }
    }
}

impl Drop for BorrowGuard<'_> {
    fn drop(&mut self) {
        self.registry.release(&self.token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every test owns its registry, so nothing another test registers can be seen here and
    /// no ordering, serialization or global reset is involved.
    fn registry() -> StagingRegistry {
        StagingRegistry::new()
    }

    fn staged(dir: &tempfile::TempDir, name: &str) -> (PathBuf, CleanupPlan) {
        let p = dir.path().join(name);
        std::fs::write(&p, b"archive").unwrap();
        let plan = CleanupPlan::RemoveOwnedFile(p.clone());
        (p, plan)
    }

    #[test]
    fn a_handle_resolves_only_for_its_own_workflow() {
        let reg = registry();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-a.zip");
        let token = reg
            .register(StagedArchiveKind::MultiEntry, &path, plan, Vec::new())
            .unwrap();

        assert_eq!(reg.borrow(&token, StagedArchiveKind::HostPack), None);
        assert_eq!(reg.borrow(&token, StagedArchiveKind::CrimeBossFlat), None);
        assert_eq!(
            reg.borrow(&token, StagedArchiveKind::MultiEntry),
            Some(path)
        );
    }

    #[test]
    fn unknown_and_guessed_handles_resolve_to_nothing() {
        let reg = registry();
        for guess in ["", "nope", "00000000-0000-0000-0000-000000000000"] {
            assert_eq!(
                reg.borrow(guess, StagedArchiveKind::MultiEntry),
                None,
                "{guess}"
            );
            assert!(reg.finalize(guess).is_none(), "{guess}");
        }
    }

    /// A multi-entry prompt installs several entries from one archive, so a read must not
    /// consume the grant. Only finalizing does.
    #[test]
    fn a_multi_entry_handle_survives_repeated_reads_then_finalizes_once() {
        let reg = registry();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-multi.zip");
        let token = reg
            .register(StagedArchiveKind::MultiEntry, &path, plan, Vec::new())
            .unwrap();

        for _ in 0..3 {
            let guard = BorrowGuard::new(&reg, &token);
            assert_eq!(
                reg.borrow(&token, StagedArchiveKind::MultiEntry),
                Some(path.clone())
            );
            drop(guard);
        }
        assert!(
            reg.finalize(&token).is_some(),
            "first finalize owns the archive"
        );
        assert!(
            reg.finalize(&token).is_none(),
            "a repeat is a harmless rejection"
        );
        assert_eq!(reg.borrow(&token, StagedArchiveKind::MultiEntry), None);
    }

    /// An install that fails partway still gives the borrow back, so the grant can be
    /// finalized afterwards rather than being stuck forever.
    #[test]
    fn an_early_return_still_releases_its_borrow() {
        let reg = registry();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-fails.zip");
        let token = reg
            .register(StagedArchiveKind::CrimeBossFlat, &path, plan, Vec::new())
            .unwrap();

        let failed: Result<(), &str> = (|| {
            let _guard = BorrowGuard::new(&reg, &token);
            reg.borrow(&token, StagedArchiveKind::CrimeBossFlat)
                .ok_or("unavailable")?;
            Err("extraction failed")
        })();
        assert!(failed.is_err());
        assert!(
            reg.finalize(&token).is_some(),
            "a failed operation must not leave the grant borrowed"
        );
    }

    #[test]
    fn one_handle_never_reaches_another_grants_archive() {
        let reg = registry();
        let dir = tempfile::TempDir::new().unwrap();
        let (a_path, a_plan) = staged(&dir, "modrex-a.zip");
        let (b_path, b_plan) = staged(&dir, "modrex-b.zip");
        let a = reg
            .register(StagedArchiveKind::MultiEntry, &a_path, a_plan, Vec::new())
            .unwrap();
        let b = reg
            .register(StagedArchiveKind::HostPack, &b_path, b_plan, Vec::new())
            .unwrap();
        assert_ne!(a, b);
        assert_eq!(reg.borrow(&a, StagedArchiveKind::MultiEntry), Some(a_path));
        assert_eq!(reg.borrow(&b, StagedArchiveKind::HostPack), Some(b_path));
        // Neither handle crosses into the other's workflow.
        assert_eq!(reg.borrow(&a, StagedArchiveKind::HostPack), None);
        assert_eq!(reg.borrow(&b, StagedArchiveKind::MultiEntry), None);
    }

    /// Grants belong to the instance that issued them; another registry has never heard of
    /// them, which is what keeps one test from reaching into another's state.
    #[test]
    fn grants_are_invisible_to_another_registry() {
        let mine = registry();
        let theirs = registry();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-mine.zip");
        let token = mine
            .register(StagedArchiveKind::MultiEntry, &path, plan, Vec::new())
            .unwrap();

        assert_eq!(theirs.borrow(&token, StagedArchiveKind::MultiEntry), None);
        assert!(theirs.finalize(&token).is_none());
        assert_eq!(theirs.drain().len(), 0);
        assert_eq!(mine.grant_count(), 1, "the owning registry is untouched");
        assert!(path.exists());
    }

    /// Filling one registry says nothing about another's capacity.
    #[test]
    fn capacity_is_per_registry() {
        let small = StagingRegistry::with_limits(2, GRANT_TTL);
        let other = StagingRegistry::with_limits(2, GRANT_TTL);
        let dir = tempfile::TempDir::new().unwrap();
        for i in 0..2 {
            let (p, plan) = staged(&dir, &format!("modrex-small-{i}.zip"));
            small
                .register(StagedArchiveKind::MultiEntry, &p, plan, Vec::new())
                .unwrap();
        }
        let (overflow, overflow_plan) = staged(&dir, "modrex-overflow.zip");
        assert_eq!(
            small.register(
                StagedArchiveKind::MultiEntry,
                &overflow,
                overflow_plan,
                Vec::new()
            ),
            Err(())
        );
        let (fresh, fresh_plan) = staged(&dir, "modrex-other.zip");
        assert!(other
            .register(
                StagedArchiveKind::MultiEntry,
                &fresh,
                fresh_plan,
                Vec::new()
            )
            .is_ok());
    }

    /// A discard arriving mid-install must not pull the archive out from under it.
    #[test]
    fn a_borrowed_grant_cannot_be_finalized() {
        let reg = registry();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-busy.zip");
        let token = reg
            .register(StagedArchiveKind::MultiEntry, &path, plan, Vec::new())
            .unwrap();

        let guard = BorrowGuard::new(&reg, &token);
        reg.borrow(&token, StagedArchiveKind::MultiEntry).unwrap();
        assert!(
            reg.finalize(&token).is_none(),
            "in use, so nothing is removed"
        );
        assert!(path.exists());

        drop(guard);
        assert!(reg.finalize(&token).is_some());
    }

    #[test]
    fn concurrent_finalizers_cannot_both_win() {
        let reg = registry();
        let dir = tempfile::TempDir::new().unwrap();
        let (path, plan) = staged(&dir, "modrex-race.zip");
        let token = reg
            .register(StagedArchiveKind::MultiEntry, &path, plan, Vec::new())
            .unwrap();
        std::thread::scope(|scope| {
            let a = scope.spawn(|| reg.finalize(&token));
            let b = scope.spawn(|| reg.finalize(&token));
            let results = [a.join().unwrap(), b.join().unwrap()];
            assert_eq!(results.iter().filter(|r| r.is_some()).count(), 1);
        });
    }

    /// A full registry refuses the new archive and removes it, rather than evicting a live
    /// grant and orphaning the artifact that grant still owns. The instance starts empty, so
    /// the refusal point is exact.
    #[test]
    fn a_full_registry_refuses_at_its_exact_capacity() {
        const CAPACITY: usize = 4;
        let reg = StagingRegistry::with_limits(CAPACITY, GRANT_TTL);
        let dir = tempfile::TempDir::new().unwrap();

        let mut live = Vec::new();
        for i in 0..CAPACITY {
            let (p, plan) = staged(&dir, &format!("modrex-{i}.zip"));
            let token = reg
                .register(StagedArchiveKind::MultiEntry, &p, plan, Vec::new())
                .expect("within capacity");
            live.push((p, token));
        }
        assert_eq!(reg.grant_count(), CAPACITY);

        let (overflow, overflow_plan) = staged(&dir, "modrex-overflow.zip");
        assert_eq!(
            reg.register(
                StagedArchiveKind::MultiEntry,
                &overflow,
                overflow_plan,
                Vec::new()
            ),
            Err(()),
            "the grant after capacity is refused"
        );
        assert!(
            !overflow.exists(),
            "the refused artifact must not be left behind"
        );
        assert_eq!(reg.grant_count(), CAPACITY, "no live grant was evicted");
        for (path, token) in &live {
            assert!(path.exists(), "a live grant's archive must survive");
            assert!(reg.borrow(token, StagedArchiveKind::MultiEntry).is_some());
            reg.release(token);
        }
    }

    /// An expired idle grant is swept with its own plan, never by guessing at a path.
    #[test]
    fn an_expired_grant_is_swept_through_its_registered_plan() {
        let reg = StagingRegistry::with_limits(MAX_GRANTS, Duration::from_nanos(1));
        let dir = tempfile::TempDir::new().unwrap();
        let (stale, stale_plan) = staged(&dir, "modrex-stale.zip");
        reg.register(
            StagedArchiveKind::MultiEntry,
            &stale,
            stale_plan,
            Vec::new(),
        )
        .unwrap();

        let (fresh, fresh_plan) = staged(&dir, "modrex-fresh.zip");
        reg.register(
            StagedArchiveKind::MultiEntry,
            &fresh,
            fresh_plan,
            Vec::new(),
        )
        .unwrap();

        assert!(!stale.exists(), "the expired archive was removed");
        assert!(fresh.exists());
        assert_eq!(reg.grant_count(), 1);
    }

    /// A borrowed grant is never swept, however old it is.
    #[test]
    fn expiry_never_sweeps_a_borrowed_grant() {
        let reg = StagingRegistry::with_limits(MAX_GRANTS, Duration::from_nanos(1));
        let dir = tempfile::TempDir::new().unwrap();
        let (busy, busy_plan) = staged(&dir, "modrex-busy.zip");
        let token = reg
            .register(StagedArchiveKind::MultiEntry, &busy, busy_plan, Vec::new())
            .unwrap();
        let _guard = BorrowGuard::new(&reg, &token);
        reg.borrow(&token, StagedArchiveKind::MultiEntry).unwrap();

        let (fresh, fresh_plan) = staged(&dir, "modrex-fresh.zip");
        reg.register(
            StagedArchiveKind::MultiEntry,
            &fresh,
            fresh_plan,
            Vec::new(),
        )
        .unwrap();

        assert!(busy.exists(), "a borrowed archive must not be swept");
        assert_eq!(reg.grant_count(), 2);
    }

    #[test]
    fn draining_returns_every_remaining_plan_for_that_registry() {
        let reg = registry();
        let other = registry();
        let dir = tempfile::TempDir::new().unwrap();
        for i in 0..3 {
            let (p, plan) = staged(&dir, &format!("modrex-{i}.zip"));
            reg.register(StagedArchiveKind::MultiEntry, &p, plan, Vec::new())
                .unwrap();
        }
        let (kept, kept_plan) = staged(&dir, "modrex-other.zip");
        other
            .register(StagedArchiveKind::MultiEntry, &kept, kept_plan, Vec::new())
            .unwrap();

        assert_eq!(reg.drain().len(), 3);
        assert_eq!(reg.grant_count(), 0);
        assert_eq!(other.grant_count(), 1, "another registry is unaffected");
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
