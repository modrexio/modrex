//! The game-specific choices the install entry points make before touching the disk. They
//! live here so they can be exercised without an AppHandle; each one is the expression that
//! used to sit inline at its call site, moved unchanged.

use super::engine::{ModEngineConfig, ModUnit, ScanTarget};
use super::naming;
use super::staged::NameSource;
use super::types::InstalledMod;
use super::unit_filename;
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
///
/// A file unit whose target keeps archive filenames uses the staged name instead, but only
/// when staging actually carried one: a bare download has no archive to take a name from, and
/// its staged file is named after nothing but a uuid.
pub fn install_filename_from_mod_name(
    cfg: &ModEngineConfig,
    target: &ScanTarget,
    mod_name: &str,
    tmp: &Path,
    name_source: NameSource,
) -> String {
    match &target.unit {
        ModUnit::File { extension, .. } => staged_file_name(target, tmp, name_source)
            .unwrap_or_else(|| unit_filename(mod_name, extension)),
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
    name_source: NameSource,
) -> String {
    match &target.unit {
        ModUnit::File { extension, .. } => {
            if let Some(name) = staged_file_name(target, tmp, name_source) {
                return name;
            }
            if file_type == "main" {
                unit_filename(mod_name, extension)
            } else {
                unit_filename(&format!("{}_{}", mod_name, file_id), extension)
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

fn staged_file_name(target: &ScanTarget, tmp: &Path, name_source: NameSource) -> Option<String> {
    if !target.keeps_archive_filename() || name_source != NameSource::FromArchive {
        return None;
    }
    tmp.file_name().and_then(|s| s.to_str()).map(str::to_string)
}

/// Filename for a dropped archive, whose directory fallback is the stem recovered from the
/// drop rather than the staged directory's own name.
pub fn install_filename_for_dropped(
    cfg: &ModEngineConfig,
    target: &ScanTarget,
    display_stem: &str,
) -> String {
    match &target.unit {
        ModUnit::File { extension, .. } if target.keeps_archive_filename() => {
            if display_stem
                .to_ascii_lowercase()
                .ends_with(&format!(".{extension}"))
            {
                return display_stem.to_string();
            }
            format!("{display_stem}.{extension}")
        }
        ModUnit::File { extension, .. } => unit_filename(display_stem, extension),
        ModUnit::Directory { .. } if is_crimeboss(cfg) => naming::mod_folder_name(display_stem),
        ModUnit::Directory { .. } => display_stem.to_string(),
    }
}

pub fn dropped_uid(target: &ScanTarget, filename: &str) -> String {
    if target.native_steam_app.is_some() {
        return filename.to_string();
    }
    naming::strip_priority_prefix(filename).to_string()
}

pub fn archive_entry_identity(
    target: &ScanTarget,
    mod_id: i64,
    file_id: i64,
    entry_name: &str,
    entry_stem: &str,
    filename: &str,
) -> InstalledMod {
    if target.native_steam_app.is_some() && mod_id <= 0 {
        return InstalledMod {
            uid: format!("local:{file_id}:entry:{}", entry_name.replace('\\', "/")),
            id: naming::hash_filename(filename),
            source: "local".into(),
            update_status: super::types::UpdateStatus::Unknown,
            ..InstalledMod::default()
        };
    }
    InstalledMod {
        uid: format!("{file_id}_{entry_stem}"),
        file_id: Some(file_id),
        ..InstalledMod::from_catalog(
            "modworkshop",
            mod_id.to_string(),
            super::identity::IdentityEvidence::InstallProvenance,
        )
    }
}

pub fn loose_published_filename(target: &ScanTarget, name: &str) -> Result<String, String> {
    let ModUnit::File { extension, .. } = &target.unit else {
        return Err("A published package filename requires a file target".to_string());
    };
    if name.contains(['/', '\\'])
        || !name
            .to_ascii_lowercase()
            .ends_with(&format!(".{extension}"))
    {
        return Err(format!(
            "The published filename '{name}' is not a .{extension} package filename"
        ));
    }
    Ok(name.to_string())
}

pub fn shared_nexus_update<'a>(
    mods: &'a [InstalledMod],
    mod_id: u32,
    file_id: i64,
    filename: &str,
    member: Option<&str>,
    location: Option<&str>,
    filename_is_unique: bool,
) -> Result<Option<&'a InstalledMod>, String> {
    let remote_id = mod_id.to_string();
    let prior: Vec<_> = mods
        .iter()
        .filter(|record| {
            record.source == "nexus"
                && record.deployment.is_none()
                && record.remote_id.as_deref() == Some(&remote_id)
                && record.location.as_deref() == location
        })
        .collect();
    let member_suffix = member.map(|name| format!("entry:{}", name.replace('\\', "/")));
    let exact: Vec<_> = prior
        .iter()
        .copied()
        .filter(|record| {
            member_suffix
                .as_deref()
                .is_some_and(|suffix| record.uid.splitn(4, ':').nth(3) == Some(suffix))
        })
        .collect();
    if exact.len() > 1 {
        return Err("More than one installed Nexus package matches this archive member. Review the installed variants before updating.".into());
    }
    if let Some(record) = exact.first() {
        return Ok(Some(*record));
    }
    let has_previous_file = prior.iter().any(|record| record.file_id != Some(file_id));
    let by_filename: Vec<_> = prior
        .into_iter()
        .filter(|record| {
            record.filename == filename
                && (member.is_none()
                    || !record
                        .uid
                        .splitn(4, ':')
                        .nth(3)
                        .is_some_and(|suffix| suffix.starts_with("entry:")))
        })
        .collect();
    if by_filename.len() > 1 || (!by_filename.is_empty() && !filename_is_unique) {
        return Err("This filename matches more than one Nexus variant. Review the installed variants before updating.".into());
    }
    if by_filename.is_empty() && has_previous_file {
        return Err("This package does not match the installed Nexus variant. Review and remove the previous variant before installing a changed package. Nothing was replaced.".into());
    }
    Ok(by_filename.into_iter().next())
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
