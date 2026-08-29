//! The game-specific choices the install entry points make before touching the disk. They
//! live here so they can be exercised without an AppHandle; each one is the expression that
//! used to sit inline at its call site, moved unchanged.

use super::engine::{ModEngineConfig, ModUnit, ScanTarget};
use super::naming;
use super::pak_filename;
use std::path::Path;

/// How a chosen archive entry is laid out in the temp area before installation.
#[derive(Debug, PartialEq, Eq)]
pub enum EntryStaging {
    /// The entry and its sidecars are wrapped in a synthesized Crime Boss pak skeleton.
    CrimeBossSkeleton,
    /// A fresh parent directory holding a directory named after the entry.
    DirectoryUnderNewParent,
    SingleTempFile,
}

/// Which extraction a chosen archive entry still needs once staging has been decided.
#[derive(Debug, PartialEq, Eq)]
pub enum EntryExtraction {
    DirEntry,
    EntryWithSidecars,
    /// Staging already wrote the files, so no further extraction runs.
    AlreadyStaged,
}

fn is_crimeboss(cfg: &ModEngineConfig) -> bool {
    cfg.game_id == "cb"
}

/// Whether the game records enabled state somewhere Modrex does not own, so a scan has to
/// read it back before trusting its own flags.
pub fn resyncs_enabled_flags(cfg: &ModEngineConfig) -> bool {
    is_crimeboss(cfg)
}

/// Filename for an install identified by a mod name, where the directory fallback is the
/// name the staged directory already carries.
pub fn install_filename_from_mod_name(
    cfg: &ModEngineConfig,
    target: &ScanTarget,
    mod_name: &str,
    tmp: &Path,
) -> String {
    match &target.unit {
        ModUnit::File { .. } => pak_filename(mod_name),
        ModUnit::Directory { .. } if is_crimeboss(cfg) => naming::mod_folder_name(mod_name),
        ModUnit::Directory { .. } => tmp
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(mod_name)
            .to_string(),
    }
}

/// As install_filename_from_mod_name, except that a file unit distinguishes a mod's main
/// download from its extras, which are suffixed with the file id to keep them apart.
pub fn install_filename_for_source_file(
    cfg: &ModEngineConfig,
    target: &ScanTarget,
    mod_name: &str,
    file_id: i64,
    file_type: &str,
    tmp: &Path,
) -> String {
    match &target.unit {
        ModUnit::File { .. } => {
            if file_type == "main" {
                pak_filename(mod_name)
            } else {
                pak_filename(&format!("{}_{}", mod_name, file_id))
            }
        }
        ModUnit::Directory { .. } if is_crimeboss(cfg) => naming::mod_folder_name(mod_name),
        ModUnit::Directory { .. } => tmp
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(mod_name)
            .to_string(),
    }
}

/// Filename for a dropped archive, whose directory fallback is the stem recovered from the
/// drop rather than the staged directory's own name.
pub fn install_filename_for_dropped(
    cfg: &ModEngineConfig,
    target: &ScanTarget,
    display_stem: &str,
) -> String {
    match &target.unit {
        ModUnit::File { .. } => pak_filename(display_stem),
        ModUnit::Directory { .. } if is_crimeboss(cfg) => naming::mod_folder_name(display_stem),
        ModUnit::Directory { .. } => display_stem.to_string(),
    }
}

/// Filename for one entry picked out of a multi-entry archive. The unit kind does not enter
/// into it: every non-Crime-Boss game keeps the entry's own filename.
pub fn install_filename_for_zip_entry(
    cfg: &ModEngineConfig,
    mod_name: &str,
    entry_filename: &str,
) -> String {
    if is_crimeboss(cfg) {
        naming::mod_folder_name(mod_name)
    } else {
        entry_filename.to_string()
    }
}

/// A Crime Boss entry that classification marked as a directory, which is staged like every
/// other directory unit rather than wrapped in a pak skeleton.
pub fn is_cb_dir_entry(cfg: &ModEngineConfig, entry_kind: Option<&str>) -> bool {
    is_crimeboss(cfg) && entry_kind == Some("dir")
}

pub fn entry_staging(
    cfg: &ModEngineConfig,
    target: &ScanTarget,
    cb_dir_entry: bool,
) -> EntryStaging {
    if is_crimeboss(cfg) && !cb_dir_entry {
        return EntryStaging::CrimeBossSkeleton;
    }
    if cb_dir_entry {
        return EntryStaging::DirectoryUnderNewParent;
    }
    match &target.unit {
        ModUnit::File { .. } => EntryStaging::SingleTempFile,
        ModUnit::Directory { .. } => EntryStaging::DirectoryUnderNewParent,
    }
}

pub fn entry_extraction(
    cfg: &ModEngineConfig,
    target: &ScanTarget,
    cb_dir_entry: bool,
) -> EntryExtraction {
    if cb_dir_entry {
        return EntryExtraction::DirEntry;
    }
    if is_crimeboss(cfg) {
        return EntryExtraction::AlreadyStaged;
    }
    match &target.unit {
        ModUnit::File { .. } => EntryExtraction::EntryWithSidecars,
        ModUnit::Directory { .. } => EntryExtraction::DirEntry,
    }
}
