//! What a staging step produced, described by the code that produced it.
//!
//! Before this existed each install path re-derived these facts from the destination target's
//! unit kind, the game id and tmp.parent(), which is how cleanup came to select the OS temp
//! root. A producer knows what it created; a consumer does not.

use super::cleanup::CleanupPlan;
use std::path::PathBuf;

/// Whether the staged root's own name is the mod's name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameSource {
    /// The root is the mod's own directory, extracted under a two-level temp so that its
    /// file name is the name the archive gave it.
    FromArchive,
    /// The root is synthesized and carries no readable name: a random-uuid pak for a file
    /// unit, or Crime Boss's skeleton directory. The name has to come from the original
    /// archive's single pak entry, or from the mod's display name.
    FromModDisplayName,
}

/// The result of staging an archive, ready to install from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    /// The path the install reads the mod from.
    pub root: PathBuf,
    /// The one artifact this staging owns. Producer-declared, never inferred downstream.
    pub cleanup: CleanupPlan,
    pub name_source: NameSource,
    /// The scan target this content belongs to, or None for the game's primary target.
    pub target_tag: Option<String>,
    /// The archive the content came out of, kept until the install has finished with it.
    pub original_archive: Option<PathBuf>,
}
