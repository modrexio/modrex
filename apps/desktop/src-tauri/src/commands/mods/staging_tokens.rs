//! One-time handles for the staged archives a prompt hands back to the renderer.
//!
//! Discarding a staged archive used to take the path to delete. A path is not authority: the
//! renderer could name any file, and the only thing standing in the way was that it happened
//! to send back one Modrex had given it. A token names an entry in this registry instead, so
//! the backend still decides which file it is willing to delete, and it can only be the one
//! it registered.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use uuid::Uuid;

/// Prompts outlive nothing but the window they are shown in, and each install shows at most
/// one, so the live set is tiny. The bound only stops a long session from accumulating
/// entries for prompts the user dismissed without answering.
const MAX_ENTRIES: usize = 64;

type Registry = Mutex<Vec<(String, PathBuf)>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

/// Records path as discardable and returns the handle that stands for it. The handle is a
/// v4 uuid, so it carries no information about the path and cannot be guessed from one.
pub(crate) fn register(path: &Path) -> String {
    let token = Uuid::new_v4().to_string();
    let mut entries = registry().lock().unwrap_or_else(|e| e.into_inner());
    if entries.len() >= MAX_ENTRIES {
        entries.remove(0);
    }
    entries.push((token.clone(), path.to_path_buf()));
    token
}

/// Takes the entry for token, if there is one. Removing under the lock is what makes a
/// second use of the same handle a miss rather than a second deletion.
pub(crate) fn consume(token: &str) -> Option<PathBuf> {
    let mut entries = registry().lock().unwrap_or_else(|e| e.into_inner());
    let index = entries.iter().position(|(t, _)| t == token)?;
    Some(entries.remove(index).1)
}

#[cfg(test)]
pub(crate) fn entry_count() -> usize {
    registry().lock().unwrap_or_else(|e| e.into_inner()).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registered_artifact_resolves_once_and_only_once() {
        let token = register(Path::new("/tmp/modrex-abc.zip"));
        assert_eq!(consume(&token), Some(PathBuf::from("/tmp/modrex-abc.zip")));
        // The second attempt finds nothing, so a replayed handle cannot delete again.
        assert_eq!(consume(&token), None);
    }

    #[test]
    fn an_unknown_or_guessed_handle_resolves_to_nothing() {
        for guess in ["", "not-a-token", "00000000-0000-0000-0000-000000000000"] {
            assert_eq!(consume(guess), None, "{guess}");
        }
    }

    /// Handles are opaque: one artifact's handle can never name another's path.
    #[test]
    fn one_handle_cannot_reach_another_artifact() {
        let a = register(Path::new("/tmp/modrex-a.zip"));
        let b = register(Path::new("/tmp/modrex-b.zip"));
        assert_ne!(a, b);
        assert_eq!(consume(&a), Some(PathBuf::from("/tmp/modrex-a.zip")));
        assert_eq!(consume(&b), Some(PathBuf::from("/tmp/modrex-b.zip")));
    }

    /// Registering a file says nothing about its neighbours: only the exact path comes back.
    #[test]
    fn registering_authorizes_only_the_exact_path() {
        let token = register(Path::new("/tmp/staging/modrex-abc.zip"));
        let resolved = consume(&token).unwrap();
        assert_eq!(resolved, PathBuf::from("/tmp/staging/modrex-abc.zip"));
        assert_ne!(resolved, PathBuf::from("/tmp/staging"));
        assert_ne!(resolved, PathBuf::from("/tmp/staging/modrex-abc.ucas"));
    }

    /// Two threads racing the same handle must not both receive a path, or cleanup would
    /// run twice on it.
    #[test]
    fn concurrent_consumers_cannot_both_win() {
        let token = register(Path::new("/tmp/modrex-race.zip"));
        let a = token.clone();
        let b = token.clone();
        let ha = std::thread::spawn(move || consume(&a));
        let hb = std::thread::spawn(move || consume(&b));
        let results = [ha.join().unwrap(), hb.join().unwrap()];
        assert_eq!(
            results.iter().filter(|r| r.is_some()).count(),
            1,
            "exactly one consumer may take the entry"
        );
    }

    #[test]
    fn the_registry_stays_bounded() {
        for i in 0..(MAX_ENTRIES + 8) {
            register(Path::new(&format!("/tmp/modrex-{i}.zip")));
        }
        assert!(entry_count() <= MAX_ENTRIES);
    }
}
