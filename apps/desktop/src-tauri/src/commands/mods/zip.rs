use super::cleanup::{self, CleanupPlan};
use super::engine::{DecoderBinding, ModEngineConfig, ModUnit};
use super::host_mods::detect_host_pack;
use super::paths::{active_mod_path, disabled_mod_path};
use super::staged::{NameSource, Staged};
use super::staging_tokens::{
    ArchiveEntryId, StagedArchiveKind, StagedEntry, StagedEntrySource, StagingRegistry,
};
use super::state::get_folder_path;
use super::types::{InstalledMod, ModFolder};
use md5::Md5;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    SevenZip,
    TarGz,
    TarXz,
    Rar,
}

pub fn detect_archive(path: &Path) -> Option<ArchiveFormat> {
    let mut buf = [0u8; 8];
    let n = File::open(path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    if n >= 4 && buf[..4] == [0x50, 0x4B, 0x03, 0x04] {
        Some(ArchiveFormat::Zip)
    } else if n >= 6 && buf[..6] == [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C] {
        Some(ArchiveFormat::SevenZip)
    } else if n >= 2 && buf[..2] == [0x1F, 0x8B] {
        Some(ArchiveFormat::TarGz)
    } else if n >= 6 && buf[..6] == [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00] {
        Some(ArchiveFormat::TarXz)
    } else if n >= 6 && buf[..6] == [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07] {
        Some(ArchiveFormat::Rar)
    } else {
        None
    }
}

#[cfg(test)]
pub fn is_zip(path: &Path) -> bool {
    detect_archive(path) == Some(ArchiveFormat::Zip)
}

/// One archive member: name is normalized to forward slashes; is_dir flags directory
/// entries. The pak/dir listing operations are pure functions over a Vec of these.
struct ArchiveEntry {
    name: String,
    is_dir: bool,
}

/// Enumerates every member of an archive, dispatching on the detected format. This is the
/// single per-format read path; listing helpers operate on its output.
fn list_entries(path: &Path) -> Result<Vec<ArchiveEntry>, String> {
    match detect_archive(path) {
        Some(ArchiveFormat::Zip) => list_entries_zip(path),
        Some(ArchiveFormat::SevenZip) => list_entries_7z(path),
        Some(ArchiveFormat::TarGz) => list_entries_tar(flate2::read::GzDecoder::new(
            File::open(path).map_err(|e| e.to_string())?,
        )),
        Some(ArchiveFormat::TarXz) => list_entries_tar(xz2::read::XzDecoder::new(
            File::open(path).map_err(|e| e.to_string())?,
        )),
        Some(ArchiveFormat::Rar) => list_entries_rar(path),
        None => Err("Not a supported archive format".to_string()),
    }
}

fn list_entries_zip(path: &Path) -> Result<Vec<ArchiveEntry>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        out.push(ArchiveEntry {
            name: entry.name().replace('\\', "/"),
            is_dir: entry.is_dir(),
        });
    }
    Ok(out)
}

fn list_entries_7z(path: &Path) -> Result<Vec<ArchiveEntry>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    sevenz_rust::decompress_with_extract_fn(file, Path::new("."), |entry, reader, _dest| {
        out.push(ArchiveEntry {
            name: entry.name().replace('\\', "/"),
            is_dir: entry.is_directory(),
        });
        // Drain so the stream stays aligned for the next entry in solid archives.
        let _ = std::io::copy(reader, &mut std::io::sink());
        Ok(true)
    })
    .map_err(|e| e.to_string())?;
    Ok(out)
}

fn list_entries_tar<R: Read>(reader: R) -> Result<Vec<ArchiveEntry>, String> {
    let mut archive = tar::Archive::new(reader);
    let mut out = Vec::new();
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.header().entry_type().is_dir();
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        out.push(ArchiveEntry { name, is_dir });
    }
    Ok(out)
}

fn list_entries_rar(path: &Path) -> Result<Vec<ArchiveEntry>, String> {
    let archive = unrar::Archive::new(path)
        .open_for_listing()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in archive {
        let entry = entry.map_err(|e| e.to_string())?;
        out.push(ArchiveEntry {
            name: entry.filename.to_string_lossy().replace('\\', "/"),
            is_dir: entry.is_directory(),
        });
    }
    Ok(out)
}

/// Installable entries of the given extension, paired with their position in the archive's
/// enumeration order.
fn list_unit_entries_indexed(path: &Path, extension: &str) -> Result<Vec<(u32, String)>, String> {
    let suffix = format!(".{extension}");
    Ok(list_entries(path)?
        .into_iter()
        .enumerate()
        .filter(|(_, e)| !e.is_dir && e.name.ends_with(&suffix))
        .map(|(i, e)| (i as u32, e.name))
        .collect())
}

pub fn list_unit_entries(path: &Path, extension: &str) -> Result<Vec<String>, String> {
    let suffix = format!(".{extension}");
    Ok(list_entries(path)?
        .into_iter()
        .filter(|e| !e.is_dir && e.name.ends_with(&suffix))
        .map(|e| e.name)
        .collect())
}

/// Smallest amount any extraction is always allowed to write, whatever the archive's own
/// size says. Keeps the ratio rule below from rejecting a tiny archive of highly
/// compressible content (XML, Lua, uncompressed textures all pack extremely well).
pub(crate) const MIN_EXTRACT_BUDGET: u64 = 2 * 1024 * 1024 * 1024;

/// How far past its own compressed size an archive may expand. Real mods land in the low
/// single digits; a decompression bomb is six orders of magnitude past this.
const MAX_EXPANSION_RATIO: u64 = 200;

/// Total bytes one extraction of archive_path may write. Bounded relative to the archive's
/// own size rather than by a flat ceiling: there is no size a legitimate mod is known to stay
/// under, so a fixed cap would eventually reject a real mod, whereas nothing legitimate is
/// both larger than MIN_EXTRACT_BUDGET and MAX_EXPANSION_RATIO times its own download.
pub(crate) fn extract_budget(archive_path: &Path) -> u64 {
    std::fs::metadata(archive_path)
        .map(|m| m.len().saturating_mul(MAX_EXPANSION_RATIO))
        .unwrap_or(0)
        .max(MIN_EXTRACT_BUDGET)
}

/// Copies one entry, charging its bytes against the extraction's remaining budget and
/// stopping at the limit instead of writing until the disk fills. Archive entries are
/// attacker-controlled and declare their own uncompressed size, so nothing upstream of this
/// bounds how much a mod archive expands to (decompression bomb).
pub(crate) fn copy_capped<R: Read + ?Sized, W: std::io::Write + ?Sized>(
    reader: &mut R,
    writer: &mut W,
    budget: &mut u64,
) -> Result<(), String> {
    // Reading one byte past the budget is what distinguishes "exactly fits" from "overruns".
    let written =
        std::io::copy(&mut reader.take(*budget + 1), writer).map_err(|e| e.to_string())?;
    if written > *budget {
        return Err(format!(
            "archive expands to more than {} GiB, or over {}x its own size; refusing to extract",
            MIN_EXTRACT_BUDGET / (1024 * 1024 * 1024),
            MAX_EXPANSION_RATIO
        ));
    }
    *budget -= written;
    Ok(())
}

#[cfg(test)]
pub(super) fn list_entries_for_test(archive_path: &Path) -> Vec<String> {
    list_entries(archive_path)
        .expect("archive lists")
        .into_iter()
        .map(|e| e.name)
        .collect()
}

#[cfg(test)]
pub(super) fn staged_entry_for_test(archive_path: &Path, name: &str) -> StagedEntry {
    let index = list_entries(archive_path)
        .expect("archive lists")
        .iter()
        .position(|e| e.name == name)
        .expect("entry is in the archive") as u32;
    StagedEntry {
        source: StagedEntrySource::File { index },
        display_name: name.to_string(),
    }
}

/// Extracts the entry at this position in the archive's own enumeration order, the same order
/// list_entries reports. Selecting by position rather than by name is what keeps two entries
/// whose names normalize onto each other distinguishable.
pub(crate) fn extract_entry_at(archive_path: &Path, index: u32, dest: &Path) -> Result<(), String> {
    let budget = &mut extract_budget(archive_path);
    let index = index as usize;
    match detect_archive(archive_path) {
        Some(ArchiveFormat::Zip) => extract_zip_entry_at(archive_path, index, dest, budget),
        Some(ArchiveFormat::SevenZip) => extract_7z_entry_at(archive_path, index, dest, budget),
        Some(ArchiveFormat::TarGz) => extract_tar_entry_at(
            flate2::read::GzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            index,
            dest,
            budget,
        ),
        Some(ArchiveFormat::TarXz) => extract_tar_entry_at(
            xz2::read::XzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            index,
            dest,
            budget,
        ),
        Some(ArchiveFormat::Rar) => {
            check_rar_budget(archive_path, *budget)?;
            extract_rar_entry_at(archive_path, index, dest)
        }
        None => Err("Not a supported archive format".to_string()),
    }
}

fn out_of_range(index: usize) -> String {
    format!("archive entry {index} is no longer in this archive")
}

fn extract_zip_entry_at(
    zip_path: &Path,
    index: usize,
    dest: &Path,
    budget: &mut u64,
) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if index >= archive.len() {
        return Err(out_of_range(index));
    }
    let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
    if entry.is_dir() {
        return Err(out_of_range(index));
    }
    let mut dest_file = File::create(dest).map_err(|e| e.to_string())?;
    copy_capped(&mut entry, &mut dest_file, budget)
}

fn extract_7z_entry_at(
    archive_path: &Path,
    index: usize,
    dest: &Path,
    budget: &mut u64,
) -> Result<(), String> {
    use std::cell::RefCell;
    let write_result: RefCell<Option<Result<(), String>>> = RefCell::new(None);
    let seen = RefCell::new(0usize);
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let budget = RefCell::new(budget);
    sevenz_rust::decompress_with_extract_fn(file, Path::new("."), |entry, reader, _dest| {
        let position = *seen.borrow();
        *seen.borrow_mut() = position + 1;
        if position == index && !entry.is_directory() {
            let r = File::create(dest)
                .map_err(|e| e.to_string())
                .and_then(|mut f| copy_capped(reader, &mut f, &mut budget.borrow_mut()));
            *write_result.borrow_mut() = Some(r);
            return Ok(false);
        }
        // Drain so the stream stays at the right offset for the next entry in solid archives.
        let _ = std::io::copy(reader, &mut std::io::sink());
        Ok(true)
    })
    .map_err(|e| e.to_string())?;

    write_result
        .into_inner()
        .unwrap_or_else(|| Err(out_of_range(index)))
}

fn extract_tar_entry_at<R: Read>(
    reader: R,
    index: usize,
    dest: &Path,
    budget: &mut u64,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    for (position, entry) in archive.entries().map_err(|e| e.to_string())?.enumerate() {
        let mut entry = entry.map_err(|e| e.to_string())?;
        if position != index {
            continue;
        }
        if entry.header().entry_type().is_dir() {
            return Err(out_of_range(index));
        }
        let mut dest_file = File::create(dest).map_err(|e| e.to_string())?;
        return copy_capped(&mut entry, &mut dest_file, budget);
    }
    Err(out_of_range(index))
}

fn extract_rar_entry_at(archive_path: &Path, index: usize, dest: &Path) -> Result<(), String> {
    let tmp_dir = std::env::temp_dir().join(format!("rar-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let mut archive = unrar::Archive::new(archive_path)
            .open_for_processing()
            .map_err(|e| e.to_string())?;
        let mut position = 0usize;
        loop {
            match archive.read_header().map_err(|e| e.to_string())? {
                None => return Err(out_of_range(index)),
                Some(header) => {
                    if position != index {
                        position += 1;
                        archive = header.skip().map_err(|e| e.to_string())?;
                        continue;
                    }
                    let name = header.entry().filename.to_string_lossy().replace('\\', "/");
                    // extract_with_base writes to tmp_dir joined with the internal name,
                    // reject traversal so it can't escape tmp_dir.
                    if safe_dest(&tmp_dir, &name).is_none() {
                        return Err("archive entry escapes extraction directory".to_string());
                    }
                    let entry_filename = header.entry().filename.clone();
                    header
                        .extract_with_base(&tmp_dir)
                        .map_err(|e| e.to_string())?;
                    let extracted = tmp_dir.join(&entry_filename);
                    return std::fs::copy(&extracted, dest)
                        .map(|_| ())
                        .map_err(|e| e.to_string());
                }
            }
        }
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

pub fn extract_entry(archive_path: &Path, entry_name: &str, dest: &Path) -> Result<(), String> {
    let budget = &mut extract_budget(archive_path);
    match detect_archive(archive_path) {
        Some(ArchiveFormat::Zip) => extract_zip_entry(archive_path, entry_name, dest, budget),
        Some(ArchiveFormat::SevenZip) => extract_7z_entry(archive_path, entry_name, dest, budget),
        Some(ArchiveFormat::TarGz) => extract_tar_entry(
            flate2::read::GzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            entry_name,
            dest,
            budget,
        ),
        Some(ArchiveFormat::TarXz) => extract_tar_entry(
            xz2::read::XzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            entry_name,
            dest,
            budget,
        ),
        Some(ArchiveFormat::Rar) => {
            check_rar_budget(archive_path, *budget)?;
            extract_rar_entry(archive_path, entry_name, dest)
        }
        None => Err("Not a supported archive format".to_string()),
    }
}

/// unrar can only extract to a directory and exposes no per-entry reader, so its output can't
/// be metered through copy_capped the way the other four formats are. The header's declared
/// unpacked size is the equivalent signal: unrar writes what the header says, so a bomb has to
/// declare itself here.
fn check_rar_budget(archive_path: &Path, budget: u64) -> Result<(), String> {
    let archive = unrar::Archive::new(archive_path)
        .open_for_listing()
        .map_err(|e| e.to_string())?;
    let mut total: u64 = 0;
    for entry in archive {
        let entry = entry.map_err(|e| e.to_string())?;
        total = total.saturating_add(entry.unpacked_size);
        if total > budget {
            return Err(format!(
                "archive expands to more than {} GiB, or over {}x its own size; refusing to extract",
                MIN_EXTRACT_BUDGET / (1024 * 1024 * 1024),
                MAX_EXPANSION_RATIO
            ));
        }
    }
    Ok(())
}

fn extract_zip_entry(
    zip_path: &Path,
    entry_name: &str,
    dest: &Path,
    budget: &mut u64,
) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    // Some Windows ZIPs store paths with backslashes; try both separators.
    let index = archive
        .index_for_name(entry_name)
        .or_else(|| archive.index_for_name(&entry_name.replace('/', "\\")))
        .ok_or_else(|| format!("entry '{}' not found in archive", entry_name))?;
    let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
    let mut dest_file = File::create(dest).map_err(|e| e.to_string())?;
    copy_capped(&mut entry, &mut dest_file, budget)
}

fn extract_7z_entry(
    archive_path: &Path,
    entry_name: &str,
    dest: &Path,
    budget: &mut u64,
) -> Result<(), String> {
    use std::cell::RefCell;
    // Write directly from the callback reader; avoids depending on sevenz-rust's
    // directory-creation behavior. Normalize separators for cross-platform archives.
    let normalized = entry_name.replace('\\', "/");
    let write_result: RefCell<Option<Result<(), String>>> = RefCell::new(None);

    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let budget = RefCell::new(budget);
    sevenz_rust::decompress_with_extract_fn(file, Path::new("."), |entry, reader, _dest| {
        if !entry.is_directory() && entry.name().replace('\\', "/") == normalized {
            let r = File::create(dest)
                .map_err(|e| e.to_string())
                .and_then(|mut f| copy_capped(reader, &mut f, &mut budget.borrow_mut()));
            *write_result.borrow_mut() = Some(r);
            Ok(false)
        } else {
            // Drain so the stream stays at the right offset for the next entry in solid archives.
            let _ = std::io::copy(reader, &mut std::io::sink());
            Ok(true)
        }
    })
    .map_err(|e| e.to_string())?;

    write_result
        .into_inner()
        .unwrap_or_else(|| Err(format!("entry '{}' not found in archive", entry_name)))
}

fn extract_tar_entry<R: Read>(
    reader: R,
    entry_name: &str,
    dest: &Path,
    budget: &mut u64,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let path = entry.path().map_err(|e| e.to_string())?;
        if path.to_string_lossy().replace('\\', "/") == entry_name {
            let mut dest_file = File::create(dest).map_err(|e| e.to_string())?;
            return copy_capped(&mut entry, &mut dest_file, budget);
        }
    }
    Err(format!("entry '{}' not found in archive", entry_name))
}

/// The archive-entry key used to match a .pak to its IoStore siblings: directory plus stem,
/// lowercased so Windows-authored archives with inconsistent casing still match.
fn entry_key(name: &str) -> String {
    let path = Path::new(name);
    let dir = path
        .parent()
        .map(|d| d.to_string_lossy())
        .unwrap_or_default();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    format!("{dir}/{stem}").to_ascii_lowercase()
}

/// Like extract_entry, but also extracts any .ucas/.utoc siblings of entry_name found in
/// the same archive (matched by directory + stem) to dest.with_extension(...). A missing
/// sidecar is not an error, since most mods ship no IoStore triplet at all.
pub async fn compute_sha256(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = File::open(&path).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Nexus's fileHash lookup keys on the MD5 of the whole published archive, not the
// extracted content SHA256 above - the two hashes serve different lookups and are
// never interchangeable.
pub async fn compute_md5(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = File::open(&path).map_err(|e| e.to_string())?;
        let mut hasher = Md5::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every directory path present in names (inferred from each entry's path components, so it
/// works whether or not the archive stores explicit directory entries). Names ending in /
/// are treated as directory entries.
fn collect_all_dirs(names: &[String]) -> std::collections::BTreeSet<String> {
    let mut set = std::collections::BTreeSet::new();
    for name in names {
        let last_is_file = !name.ends_with('/');
        let parts: Vec<&str> = name.split('/').collect();
        let upto = if last_is_file {
            parts.len().saturating_sub(1)
        } else {
            parts.len()
        };
        let mut acc = String::new();
        for part in parts.iter().take(upto) {
            if part.is_empty() {
                continue;
            }
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            set.insert(acc.clone());
        }
    }
    set
}

/// If name routes through a literal destination segment seg (e.g. assets/mod_overrides/),
/// returns (mod_dir, wrapper) where mod_dir is the directory immediately inside the segment
/// (the real override mod, even when the packager nested it in extra folders) and wrapper is
/// the path preceding the segment. Returns None when the segment is absent.
fn override_dir_from_segment(name: &str, seg: &str) -> Option<(String, String)> {
    let pos = if name.starts_with(seg) {
        0
    } else {
        name.find(&format!("/{}", seg))? + 1
    };
    let after = &name[pos + seg.len()..];
    let realname = &after[..after.find('/').unwrap_or(after.len())];
    if realname.is_empty() {
        return None;
    }
    let mod_dir = format!("{}{}{}", &name[..pos], seg, realname);
    let wrapper = name[..pos].trim_end_matches('/').to_string();
    Some((mod_dir, wrapper))
}

/// True when an archive carries no loader marker and no nested asset structure: a flat folder of
/// loose files (e.g. a menu-background set for an unknown host). A real asset-override mod nests
/// its files under category dirs (ModDir/category/file, so two or more slashes), and the lack of
/// such nesting means the pack belongs inside some other mod that Modrex can't infer.
/// extra_markers is the union of all entry_markers from the active engine config so that
/// game-specific markers (e.g. base.lua for DAHM sub-mods) are recognised alongside the
/// universal mod.txt / main.xml.
pub(crate) fn is_unplaceable_pack(names: &[String], extra_markers: &[&str]) -> bool {
    let has_marker = names.iter().any(|n| {
        n.ends_with("/mod.txt")
            || n.ends_with("/main.xml")
            || n == "mod.txt"
            || n == "main.xml"
            || extra_markers
                .iter()
                .any(|m| n.ends_with(&format!("/{}", m)) || n.as_str() == *m)
    });
    if has_marker {
        return false;
    }
    let has_nested = names
        .iter()
        .any(|n| !n.ends_with('/') && n.matches('/').count() >= 2);
    !has_nested
}

/// Classifies an archive's mod directories by which scan target they install into. Each result
/// is (dir_path, location_tag) where location_tag is None for the primary target and
/// Some(tag) for a secondary target (e.g. "mod_overrides").
///
/// - Marker-bearing targets (e.g. mods with mod.txt or main.xml) claim any dir containing one
///   of their markers, at any depth, so BeardLib and BLT mods route to mods/ regardless of
///   which folder the packager dropped them in.
/// - The marker-less override target claims marker-less directories sitting at the same depth
///   as the marker dirs (the asset-replacement mods packaged alongside the BLT mods). When the
///   archive has no markers at all it falls back to the top-level directories, preserving the
///   single asset-override mod case.
///
/// A dir is never double-claimed. The first, lowest-index target wins.
pub(crate) fn classify_archive_dirs(
    names: &[String],
    cfg: &ModEngineConfig,
) -> Vec<(String, Option<String>)> {
    use std::collections::BTreeMap;

    let tag_for = |idx: usize| -> Option<String> {
        if idx == 0 {
            None
        } else {
            Some(cfg.targets[idx].tag.to_string())
        }
    };

    let mut out: BTreeMap<String, Option<String>> = BTreeMap::new();

    // 1. Marker-bearing targets.
    let mut marker_dirs: Vec<String> = Vec::new();
    for (idx, target) in cfg.targets.iter().enumerate() {
        if let ModUnit::Directory { entry_markers, .. } = &target.unit {
            if entry_markers.is_empty() {
                continue;
            }
            for marker in *entry_markers {
                let suffix = format!("/{}", marker);
                for name in names {
                    if let Some(pos) = name.rfind(&suffix) {
                        if pos > 0 {
                            let dir = name[..pos].to_string();
                            if !marker_dirs.contains(&dir) {
                                marker_dirs.push(dir.clone());
                            }
                            out.entry(dir).or_insert_with(|| tag_for(idx));
                        }
                    }
                }
            }
        }
    }

    // 2. Marker-less (override) target(s).
    for (idx, target) in cfg.targets.iter().enumerate() {
        let ModUnit::Directory { entry_markers, .. } = &target.unit else {
            continue;
        };
        if !entry_markers.is_empty() {
            continue;
        }
        let tag = tag_for(idx);
        // The literal in-game destination, e.g. "assets/mod_overrides/".
        let seg = format!("{}/", target.mods_subpath.join("/"));
        let mut chosen: Vec<String> = Vec::new();

        // Pass A, explicit destination segment. Some packers nest the real mod inside its own
        // assets/mod_overrides/<name>/ (or wrap it in extra folders); the dir immediately inside
        // the segment is the authoritative override mod. Skip segments that live inside a marker
        // mod, since a BeardLib mod loads its own internal overrides rather than the game dir.
        for name in names {
            if let Some((mod_dir, wrapper)) = override_dir_from_segment(name, &seg) {
                let inside_marker = marker_dirs
                    .iter()
                    .any(|m| wrapper == *m || wrapper.starts_with(&format!("{}/", m)));
                if !inside_marker && !chosen.contains(&mod_dir) {
                    chosen.push(mod_dir);
                }
            }
        }

        if marker_dirs.is_empty() {
            // No markers and no explicit segment: every top-level directory is an override mod.
            if chosen.is_empty() {
                for name in names {
                    if let Some(slash) = name.find('/') {
                        if slash > 0 {
                            let d = name[..slash].to_string();
                            if !chosen.contains(&d) {
                                chosen.push(d);
                            }
                        }
                    }
                }
            }
        } else {
            // Marker-less dirs at the same depth as marker dirs are asset-override mods packaged
            // bare alongside the BLT/BeardLib mods. Exclude marker dirs, the internals of marker
            // mods, wrappers (ancestors of a marker), dirs already covered by a chosen override
            // (either direction), and dirs that themselves wrap a destination segment (pass A).
            // collect_all_dirs yields parents before children.
            let marker_depths: HashSet<usize> =
                marker_dirs.iter().map(|d| d.split('/').count()).collect();
            for d in collect_all_dirs(names) {
                if !marker_depths.contains(&d.split('/').count()) {
                    continue;
                }
                if marker_dirs.contains(&d) {
                    continue;
                }
                let d_prefix = format!("{}/", d);
                if marker_dirs.iter().any(|m| m.starts_with(&d_prefix)) {
                    continue; // d is an ancestor of a marker dir (a wrapper)
                }
                if marker_dirs
                    .iter()
                    .any(|m| d.starts_with(&format!("{}/", m)))
                {
                    continue; // d is internal content of a marker mod
                }
                if chosen.iter().any(|c| {
                    *c == d || c.starts_with(&d_prefix) || d.starts_with(&format!("{}/", c))
                }) {
                    continue; // already covered by an explicit-segment / chosen override
                }
                if names
                    .iter()
                    .any(|n| n.starts_with(&d_prefix) && n[d_prefix.len()..].contains(&seg))
                {
                    continue; // d wraps a destination segment, handled by pass A
                }
                chosen.push(d);
            }
        }

        for d in chosen {
            out.entry(d).or_insert_with(|| tag.clone());
        }
    }

    out.into_iter().collect()
}

/// Joins an archive-internal (/-separated) path onto dest, returning None if it would
/// escape dest via an absolute path, drive/UNC prefix, or .. component. Archive entries
/// are attacker-controlled, so directory extractors must route writes through this (Zip-Slip).
pub(crate) fn safe_dest(dest: &Path, relative: &str) -> Option<PathBuf> {
    use std::path::Component;
    for comp in Path::new(relative).components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(dest.join(relative))
}

/// Extracts all entries under dir_prefix/ from the archive into dest/.
pub fn extract_dir_entry(archive_path: &Path, dir_prefix: &str, dest: &Path) -> Result<(), String> {
    let budget = &mut extract_budget(archive_path);
    match detect_archive(archive_path) {
        Some(ArchiveFormat::Zip) => extract_dir_zip(archive_path, dir_prefix, dest, budget),
        Some(ArchiveFormat::SevenZip) => extract_dir_7z(archive_path, dir_prefix, dest, budget),
        Some(ArchiveFormat::TarGz) => extract_dir_tar(
            flate2::read::GzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            dir_prefix,
            dest,
            budget,
        ),
        Some(ArchiveFormat::TarXz) => extract_dir_tar(
            xz2::read::XzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            dir_prefix,
            dest,
            budget,
        ),
        Some(ArchiveFormat::Rar) => {
            check_rar_budget(archive_path, *budget)?;
            extract_dir_rar(archive_path, dir_prefix, dest)
        }
        None => Err("Not a supported archive format".to_string()),
    }
}

fn extract_dir_zip(
    zip_path: &Path,
    dir_prefix: &str,
    dest: &Path,
    budget: &mut u64,
) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let prefix = format!("{}/", dir_prefix);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let relative = match name.strip_prefix(&prefix) {
            Some(r) if !r.is_empty() => r.to_string(),
            _ => continue,
        };
        let Some(dest_path) = safe_dest(dest, &relative) else {
            continue;
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&dest_path).map_err(|e| e.to_string())?;
        copy_capped(&mut entry, &mut out, budget)?;
    }
    Ok(())
}

fn extract_dir_7z(
    archive_path: &Path,
    dir_prefix: &str,
    dest: &Path,
    budget: &mut u64,
) -> Result<(), String> {
    use std::cell::RefCell;
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let prefix = format!("{}/", dir_prefix);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let dest = dest.to_path_buf();
    let write_err: RefCell<Option<String>> = RefCell::new(None);
    let budget = RefCell::new(budget);
    sevenz_rust::decompress_with_extract_fn(file, Path::new("."), |entry, reader, _dst| {
        let name = entry.name().replace('\\', "/");
        let relative = match name.strip_prefix(&prefix) {
            Some(r) if !r.is_empty() => r.to_string(),
            _ => {
                let _ = std::io::copy(reader, &mut std::io::sink());
                return Ok(true);
            }
        };
        let Some(dest_path) = safe_dest(&dest, &relative) else {
            let _ = std::io::copy(reader, &mut std::io::sink());
            return Ok(true);
        };
        if entry.is_directory() {
            let _ = std::fs::create_dir_all(&dest_path);
            let _ = std::io::copy(reader, &mut std::io::sink());
            return Ok(true);
        }
        if let Some(parent) = dest_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                *write_err.borrow_mut() = Some(e.to_string());
                let _ = std::io::copy(reader, &mut std::io::sink());
                return Ok(true);
            }
        }
        let write = File::create(&dest_path)
            .map_err(|e| e.to_string())
            .and_then(|mut f| copy_capped(reader, &mut f, &mut budget.borrow_mut()));
        if let Err(e) = write {
            *write_err.borrow_mut() = Some(e);
        }
        Ok(true)
    })
    .map_err(|e| e.to_string())?;
    if let Some(e) = write_err.into_inner() {
        return Err(e);
    }
    Ok(())
}

fn extract_dir_tar<R: Read>(
    reader: R,
    dir_prefix: &str,
    dest: &Path,
    budget: &mut u64,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    let prefix = format!("{}/", dir_prefix);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let relative = match name.strip_prefix(&prefix) {
            Some(r) if !r.is_empty() => r.to_string(),
            _ => continue,
        };
        let Some(dest_path) = safe_dest(dest, &relative) else {
            continue;
        };
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&dest_path).map_err(|e| e.to_string())?;
        copy_capped(&mut entry, &mut out, budget)?;
    }
    Ok(())
}

/// UE4SS-settings.ini sits at the zip's top level only in the full loader package, verified
/// against the real UE4SS-CB and PD3-UE4SS releases, both of which also ship many
/// Scripts/main.lua paths for their own bundled framework sub-mods, so that marker alone can't
/// tell a full loader install apart from a single standalone Lua sub-mod.
pub(crate) fn has_ue4ss_loader_signature(path: &Path) -> bool {
    list_entries(path)
        .map(|entries| {
            entries
                .iter()
                .any(|e| !e.is_dir && e.name == "UE4SS-settings.ini")
        })
        .unwrap_or(false)
}

/// Extracts every entry in the archive directly into dest, preserving the archive's own
/// internal structure (used for the UE4SS loader package, which must land as a flat dump in
/// Binaries/<platform>/ rather than under any scan-target skeleton).
pub fn extract_archive_flat(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let budget = &mut extract_budget(archive_path);
    match detect_archive(archive_path) {
        Some(ArchiveFormat::Zip) => extract_flat_zip(archive_path, dest, budget),
        Some(ArchiveFormat::SevenZip) => extract_flat_7z(archive_path, dest, budget),
        Some(ArchiveFormat::TarGz) => extract_flat_tar(
            flate2::read::GzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            dest,
            budget,
        ),
        Some(ArchiveFormat::TarXz) => extract_flat_tar(
            xz2::read::XzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            dest,
            budget,
        ),
        Some(ArchiveFormat::Rar) => {
            check_rar_budget(archive_path, *budget)?;
            extract_flat_rar(archive_path, dest)
        }
        None => Err("Not a supported archive format".to_string()),
    }
}

fn extract_flat_zip(zip_path: &Path, dest: &Path, budget: &mut u64) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let Some(dest_path) = safe_dest(dest, &name) else {
            continue;
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&dest_path).map_err(|e| e.to_string())?;
        copy_capped(&mut entry, &mut out, budget)?;
    }
    Ok(())
}

fn extract_flat_7z(archive_path: &Path, dest: &Path, budget: &mut u64) -> Result<(), String> {
    use std::cell::RefCell;
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let dest = dest.to_path_buf();
    let write_err: RefCell<Option<String>> = RefCell::new(None);
    let budget = RefCell::new(budget);
    sevenz_rust::decompress_with_extract_fn(file, Path::new("."), |entry, reader, _dst| {
        let name = entry.name().replace('\\', "/");
        let Some(dest_path) = safe_dest(&dest, &name) else {
            let _ = std::io::copy(reader, &mut std::io::sink());
            return Ok(true);
        };
        if entry.is_directory() {
            let _ = std::fs::create_dir_all(&dest_path);
            let _ = std::io::copy(reader, &mut std::io::sink());
            return Ok(true);
        }
        if let Some(parent) = dest_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                *write_err.borrow_mut() = Some(e.to_string());
                let _ = std::io::copy(reader, &mut std::io::sink());
                return Ok(true);
            }
        }
        let write = File::create(&dest_path)
            .map_err(|e| e.to_string())
            .and_then(|mut f| copy_capped(reader, &mut f, &mut budget.borrow_mut()));
        if let Err(e) = write {
            *write_err.borrow_mut() = Some(e);
        }
        Ok(true)
    })
    .map_err(|e| e.to_string())?;
    if let Some(e) = write_err.into_inner() {
        return Err(e);
    }
    Ok(())
}

fn extract_flat_tar<R: Read>(reader: R, dest: &Path, budget: &mut u64) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let Some(dest_path) = safe_dest(dest, &name) else {
            continue;
        };
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&dest_path).map_err(|e| e.to_string())?;
        copy_capped(&mut entry, &mut out, budget)?;
    }
    Ok(())
}

fn extract_flat_rar(archive_path: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let tmp_dir = std::env::temp_dir().join(format!("modrex-rar-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let mut archive = unrar::Archive::new(archive_path)
            .open_for_processing()
            .map_err(|e| e.to_string())?;
        loop {
            match archive.read_header().map_err(|e| e.to_string())? {
                None => break,
                Some(header) => {
                    let name = header.entry().filename.to_string_lossy().replace('\\', "/");
                    // extract_with_base writes to tmp_dir joined with the internal name; skip
                    // any entry whose path would escape tmp_dir (Zip-Slip via ..).
                    if safe_dest(&tmp_dir, &name).is_some() {
                        archive = header
                            .extract_with_base(&tmp_dir)
                            .map_err(|e| e.to_string())?;
                    } else {
                        archive = header.skip().map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        rar_copy_dir(&tmp_dir, dest)
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Archive shapes that need a user decision before installing. Each variant carries the
/// payload its renderer modal renders from; the mod-context fields (mod_id, mod_name, ...)
/// are None here and filled by the install command via with_mod_context, since only the
/// command knows which mod the archive belongs to.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ZipMultiPakPayload {
    /// Backend-issued handle for this staged archive. The renderer never learns
    /// the path, so it cannot name a different archive for the install to open.
    pub archive_handle: String,
    pub entries: Vec<String>,
    /// Identity of each listed entry, parallel to entries. Display names can normalize onto
    /// each other; these cannot.
    pub entry_ids: Vec<ArchiveEntryId>,
    pub target_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_tags: Option<Vec<Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_version: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostPackPayload {
    /// Backend-issued handle for this staged archive. The renderer never learns
    /// the path, so it cannot name a different archive for the install to open.
    pub archive_handle: String,
    pub entries: Vec<String>,
    pub host_mod_id: i64,
    pub host_name: String,
    pub host_subpath: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_version: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CbFlatPayload {
    /// Backend-issued handle for this staged archive. The renderer never learns
    /// the path, so it cannot name a different archive for the install to open.
    pub archive_handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mod_version: Option<String>,
}

#[derive(Debug, Clone)]
pub enum InstallPrompt {
    ZipMultiPak(ZipMultiPakPayload),
    HostModPack(HostPackPayload),
    CbFlatArchive(CbFlatPayload),
    UnrecognizedArchive,
}

pub struct ModContext {
    pub mod_id: i64,
    pub mod_name: String,
    pub file_id: i64,
    pub file_type: String,
    pub mod_version: String,
}

impl InstallPrompt {
    pub fn with_mod_context(mut self, ctx: ModContext) -> Self {
        macro_rules! fill {
            ($p:expr) => {{
                $p.mod_id = Some(ctx.mod_id);
                $p.mod_name = Some(ctx.mod_name);
                $p.file_id = Some(ctx.file_id);
                $p.file_type = Some(ctx.file_type);
                $p.mod_version = Some(ctx.mod_version);
            }};
        }
        match &mut self {
            InstallPrompt::ZipMultiPak(p) => fill!(p),
            InstallPrompt::HostModPack(p) => fill!(p),
            InstallPrompt::CbFlatArchive(p) => fill!(p),
            InstallPrompt::UnrecognizedArchive => {}
        }
        self
    }
}

fn multi_pak_payload(
    registry: &StagingRegistry,
    zip_path: String,
    staged: Vec<StagedEntry>,
    target_tag: Option<String>,
    entry_tags: Option<Vec<Option<String>>>,
    entry_kind: Option<String>,
) -> Result<ZipMultiPakPayload, ResolveError> {
    let entries = staged.iter().map(|e| e.display_name.clone()).collect();
    let entry_ids = (0..staged.len() as u32).map(ArchiveEntryId).collect();
    let archive_handle = stage_archive(registry, StagedArchiveKind::MultiEntry, &zip_path, staged)?;
    Ok(ZipMultiPakPayload {
        archive_handle,
        entries,
        entry_ids,
        target_tag,
        entry_tags,
        entry_kind,
        mod_id: None,
        mod_name: None,
        file_id: None,
        file_type: None,
        mod_version: None,
    })
}

/// Hands an archive to the registry and returns its handle. A refusal is surfaced as an
/// ordinary install failure: the archive has already been removed by then, so there is
/// nothing for the caller to clean up.
fn stage_archive(
    registry: &StagingRegistry,
    kind: StagedArchiveKind,
    zip_path: &str,
    entries: Vec<StagedEntry>,
) -> Result<String, ResolveError> {
    let path = Path::new(zip_path);
    registry
        .register(
            kind,
            path,
            CleanupPlan::RemoveOwnedFile(path.to_path_buf()),
            entries,
        )
        .map_err(
        |()| {
            ResolveError::Failure(
                "Too many archives are waiting for a choice. Finish or close the open install prompts and try again."
                    .to_string(),
            )
        },
    )
}

/// Non-success outcomes of archive resolution: a user decision is needed, the archive is
/// the UE4SS loader package (installed via a dedicated path), or a real failure.
#[derive(Debug)]
pub enum ResolveError {
    Prompt(Box<InstallPrompt>),
    Ue4ssLoader(PathBuf),
    Failure(String),
}

fn prompt_err(p: InstallPrompt) -> ResolveError {
    ResolveError::Prompt(Box::new(p))
}

impl From<String> for ResolveError {
    fn from(e: String) -> Self {
        ResolveError::Failure(e)
    }
}

/// Staging is described by whichever branch performed it: only the code that created an
/// artifact knows which one it owns and whether the root it produced carries a usable name.
type ResolvedArchive = Result<Staged, ResolveError>;

/// Checks whether a zero-.pak archive instead contains directory-shaped content matching one
/// of cfg's Directory-unit targets. Currently only ue4ss_mods ever matches here (a
/// standalone UE4SS Lua sub-mod, e.g. Mods/<name>/Scripts/main.lua), since it's the only
/// Directory target a File-unit-primary game (PD3) or CB's pak-specific resolver wouldn't
/// otherwise consult. Reuses classify_archive_dirs as-is, since it iterates every target in
/// cfg.targets regardless of which one is primary. Returns None when nothing matches, so the
/// caller falls through to its own "no .pak files" error.
fn try_classify_as_directory_target(
    downloaded: &Path,
    cfg: &ModEngineConfig,
    registry: &StagingRegistry,
) -> Option<ResolvedArchive> {
    let names: Vec<String> = list_entries(downloaded)
        .ok()?
        .into_iter()
        .map(|e| {
            if e.is_dir && !e.name.ends_with('/') {
                format!("{}/", e.name)
            } else {
                e.name
            }
        })
        .collect();
    let dirs = classify_archive_dirs(&names, cfg);
    if dirs.is_empty() {
        return None;
    }
    if dirs.len() == 1 {
        let (dir, location_tag) = &dirs[0];
        let dir_name = Path::new(dir)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("mod")
            .to_string();
        // Two-level temp: {uuid_dir}/{dir_name} so tmp.file_name() == dir_name, matching the
        // generic Directory-unit single-dir branch below.
        let tmp_parent = std::env::temp_dir().join(format!("modrex-mod-{}", Uuid::new_v4()));
        let tmp = tmp_parent.join(&dir_name);
        let cleanup = CleanupPlan::RemoveOwnedDirectory(tmp_parent);
        return Some(
            extract_dir_entry(downloaded, dir, &tmp)
                .map(|_| Staged {
                    root: tmp,
                    cleanup,
                    name_source: NameSource::FromArchive,
                    target_tag: location_tag.clone(),
                    original_archive: Some(downloaded.to_path_buf()),
                })
                .map_err(ResolveError::from),
        );
    }
    let zip_path = downloaded.to_string_lossy().to_string();
    let staged: Vec<StagedEntry> = dirs
        .iter()
        .map(|(d, _)| StagedEntry {
            source: StagedEntrySource::Directory { prefix: d.clone() },
            display_name: d.clone(),
        })
        .collect();
    let distinct_tags: HashSet<&Option<String>> = dirs.iter().map(|(_, t)| t).collect();
    // These entries are directory paths (from classify_archive_dirs), not .pak files, which is
    // for Crime Boss, whose install_from_zip_entry otherwise assumes every entry is a single pak
    // file to wrap in its synthesized skeleton.
    let payload = multi_pak_payload(
        registry,
        zip_path,
        staged,
        if distinct_tags.len() == 1 {
            dirs[0].1.clone()
        } else {
            None
        },
        (distinct_tags.len() > 1).then(|| dirs.iter().map(|(_, t)| t.clone()).collect()),
        Some("dir".to_string()),
    );
    let payload = match payload {
        Ok(p) => p,
        Err(e) => return Some(Err(e)),
    };
    Some(Err(prompt_err(InstallPrompt::ZipMultiPak(payload))))
}

fn decoder_for(cfg: &ModEngineConfig, downloaded: &Path) -> Option<&'static DecoderBinding> {
    let extension = downloaded.extension()?.to_str()?;
    cfg.decoders.iter().find(|binding| {
        let claimed = match binding {
            DecoderBinding::Pdmod { .. } => super::pdmod::EXTENSION,
        };
        extension.eq_ignore_ascii_case(claimed)
    })
}

/// Resolves a downloaded archive into an installable path plus the detected scan-target tag.
/// Returns (extracted_path, original_archive, location_tag) where location_tag is None
/// for the primary target and Some(tag) for any secondary target (e.g. "mod_overrides").
pub fn resolve_archive_download(
    downloaded: PathBuf,
    cfg: &ModEngineConfig,
    registry: &StagingRegistry,
) -> ResolvedArchive {
    // Must run before detect_archive: a decoded container is a ZIP by magic bytes and would
    // fall through to the Directory-unit path without this early check.
    if let Some(binding) = decoder_for(cfg, &downloaded) {
        let temp_dir = std::env::temp_dir().join(format!("modrex-pdmod-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
        let cleanup = CleanupPlan::RemoveOwnedDirectory(temp_dir.clone());
        return match super::pdmod::extract_pdmod(&downloaded, &temp_dir) {
            // FromArchive preserves the existing naming, where a dropped .pdmod takes its
            // stem from this directory's own uuid name. Changing that is a naming fix, not
            // a staging one.
            Ok(()) => Ok(Staged {
                root: temp_dir,
                cleanup,
                name_source: NameSource::FromArchive,
                target_tag: Some(binding.target().to_string()),
                original_archive: Some(downloaded),
            }),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&temp_dir);
                Err(e.into())
            }
        };
    }
    if cfg.game_id == "cb" {
        return resolve_crimeboss_archive(downloaded, cfg, registry);
    }
    if detect_archive(&downloaded).is_none() {
        // Nothing was extracted, so the caller's own downloaded file is the only artifact.
        let cleanup = CleanupPlan::RemoveOwnedFileWithSidecars {
            path: downloaded.clone(),
            companions: cfg.primary().companions,
        };
        let name_source = match &cfg.primary().unit {
            ModUnit::Directory { .. } => NameSource::FromArchive,
            ModUnit::File { .. } => NameSource::FromModDisplayName,
        };
        return Ok(Staged {
            root: downloaded,
            cleanup,
            name_source,
            target_tag: None,
            original_archive: None,
        });
    }
    match &cfg.primary().unit {
        ModUnit::File { extension, .. } => {
            let entries = list_unit_entries_indexed(&downloaded, extension)?;
            match entries.len() {
                0 => {
                    if has_ue4ss_loader_signature(&downloaded) {
                        return Err(ResolveError::Ue4ssLoader(downloaded));
                    }
                    if let Some(result) =
                        try_classify_as_directory_target(&downloaded, cfg, registry)
                    {
                        return result;
                    }
                    cleanup::run_sync(&CleanupPlan::RemoveOwnedFile(downloaded.clone()));
                    Err(ResolveError::Failure(format!(
                        "This mod is packaged as an archive with no .{extension} files inside."
                    )))
                }
                1 => {
                    let tmp = std::env::temp_dir()
                        .join(format!("modrex-mod-{}.{extension}", Uuid::new_v4()));
                    let (index, name) = entries[0].clone();
                    let entry = StagedEntry {
                        source: StagedEntrySource::File { index },
                        display_name: name,
                    };
                    extract_staged_entry_with_sidecars(
                        &downloaded,
                        &entry,
                        &tmp,
                        cfg.primary().companions,
                    )?;
                    let cleanup = CleanupPlan::RemoveOwnedFileWithSidecars {
                        path: tmp.clone(),
                        companions: cfg.primary().companions,
                    };
                    Ok(Staged {
                        root: tmp,
                        cleanup,
                        name_source: NameSource::FromModDisplayName,
                        target_tag: None,
                        original_archive: Some(downloaded),
                    })
                }
                _ => {
                    let zip_path = downloaded.to_string_lossy().to_string();
                    let staged = entries
                        .into_iter()
                        .map(|(index, name)| StagedEntry {
                            source: StagedEntrySource::File { index },
                            display_name: name,
                        })
                        .collect();
                    let payload = multi_pak_payload(registry, zip_path, staged, None, None, None)?;
                    Err(prompt_err(InstallPrompt::ZipMultiPak(payload)))
                }
            }
        }
        ModUnit::Directory { .. } => {
            let names: Vec<String> = list_entries(&downloaded)?
                .into_iter()
                .map(|e| {
                    if e.is_dir && !e.name.ends_with('/') {
                        format!("{}/", e.name)
                    } else {
                        e.name
                    }
                })
                .collect();
            // Content packs that install inside another mod (e.g. Menu Backgrounds sets) carry no
            // marker and no asset-DB structure, so the target classification can't place them.
            // Recognize them up front and hand off to the host-pack install path.
            if cfg.game_id == "pd2" {
                if let Some(m) = detect_host_pack(&names) {
                    let zip_path = downloaded.to_string_lossy().to_string();
                    let staged: Vec<StagedEntry> = m
                        .dirs
                        .iter()
                        .map(|d| StagedEntry {
                            source: StagedEntrySource::Directory { prefix: d.clone() },
                            display_name: d.clone(),
                        })
                        .collect();
                    let archive_handle =
                        stage_archive(registry, StagedArchiveKind::HostPack, &zip_path, staged)?;
                    return Err(prompt_err(InstallPrompt::HostModPack(HostPackPayload {
                        archive_handle,
                        entries: m.dirs,
                        host_mod_id: m.host.host_mod_id,
                        host_name: m.host.host_name.to_string(),
                        host_subpath: m.host.subpath.join("/"),
                        mod_id: None,
                        mod_name: None,
                        file_id: None,
                        file_type: None,
                        mod_version: None,
                    })));
                }
            }
            // A flat folder of loose files (no marker, no nested asset structure) can't be a real
            // override mod and is not a known host pack: it installs inside some other mod no
            // infer. Surface the mod's instructions rather than silently dropping it in mod_overrides.
            let engine_markers: Vec<&str> = cfg
                .targets
                .iter()
                .flat_map(|t| match &t.unit {
                    ModUnit::Directory { entry_markers, .. } => entry_markers.iter().copied(),
                    ModUnit::File { .. } => [].iter().copied(),
                })
                .collect();
            if is_unplaceable_pack(&names, &engine_markers) {
                cleanup::run_sync(&CleanupPlan::RemoveOwnedFile(downloaded.clone()));
                return Err(prompt_err(InstallPrompt::UnrecognizedArchive));
            }
            let dirs = classify_archive_dirs(&names, cfg);
            if dirs.is_empty() {
                cleanup::run_sync(&CleanupPlan::RemoveOwnedFile(downloaded.clone()));
                return Err(ResolveError::Failure(
                    if let ModUnit::Directory { entry_markers, .. } = &cfg.primary().unit {
                        if entry_markers.is_empty() {
                            "This mod is packaged as an archive with no mod directory found inside."
                                .to_string()
                        } else {
                            format!(
                                "This mod is packaged as an archive with no {} found inside.",
                                entry_markers.join(" or ")
                            )
                        }
                    } else {
                        "No valid mod directory found in archive.".to_string()
                    },
                ));
            }
            if dirs.len() == 1 {
                let (dir, location_tag) = &dirs[0];
                let dir_name = Path::new(dir)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("mod")
                    .to_string();
                // Two-level temp: {uuid_dir}/{dir_name} so tmp.file_name() == dir_name.
                let tmp_parent =
                    std::env::temp_dir().join(format!("modrex-mod-{}", Uuid::new_v4()));
                let tmp = tmp_parent.join(&dir_name);
                extract_dir_entry(&downloaded, dir, &tmp)?;
                let cleanup = CleanupPlan::RemoveOwnedDirectory(tmp_parent);
                return Ok(Staged {
                    root: tmp,
                    cleanup,
                    name_source: NameSource::FromArchive,
                    target_tag: location_tag.clone(),
                    original_archive: Some(downloaded),
                });
            }
            let zip_path = downloaded.to_string_lossy().to_string();
            let staged: Vec<StagedEntry> = dirs
                .iter()
                .map(|(d, _)| StagedEntry {
                    source: StagedEntrySource::Directory { prefix: d.clone() },
                    display_name: d.clone(),
                })
                .collect();
            let distinct_tags: HashSet<&Option<String>> = dirs.iter().map(|(_, t)| t).collect();
            // Single target keeps one targetTag for all entries; mixed targets (e.g. a
            // modpack spanning mods/ and assets/mod_overrides/) tag each entry
            // individually so the picker routes it to the right place.
            let payload = multi_pak_payload(
                registry,
                zip_path,
                staged,
                if distinct_tags.len() == 1 {
                    dirs[0].1.clone()
                } else {
                    None
                },
                (distinct_tags.len() > 1).then(|| dirs.iter().map(|(_, t)| t.clone()).collect()),
                None,
            )?;
            Err(prompt_err(InstallPrompt::ZipMultiPak(payload)))
        }
    }
}

/// Crime Boss's two real archive shapes, a loose .pak/.ucas/.utoc triplet at any depth and
/// the official ModKit's "Package Mod" folder output, both reduce to "find the .pak,
/// wherever it is, plus its siblings." Unlike PD2/PDTH's Directory targets, the result isn't an
/// author-supplied folder copied as-is: Modrex always synthesizes the canonical
/// Content/Paks/WindowsNoEditor/ skeleton the game's UGC mod-loader expects under
/// CrimeBoss/Mods/<name>/, regardless of how the source archive nested things.
fn resolve_crimeboss_archive(
    downloaded: PathBuf,
    cfg: &ModEngineConfig,
    registry: &StagingRegistry,
) -> ResolvedArchive {
    if detect_archive(&downloaded).is_none() {
        // No known real mod ships a bare .pak with no archive (sidecars require a zip to carry
        // them), but if one shows up, fall back to the legacy flat paks target rather than
        // guessing at a skeleton with no .ucas/.utoc to find.
        let legacy = cfg.targets.iter().find(|t| t.tag == "paks");
        let cleanup = CleanupPlan::RemoveOwnedFileWithSidecars {
            path: downloaded.clone(),
            companions: legacy.map(|t| t.companions).unwrap_or(&[]),
        };
        return Ok(Staged {
            root: downloaded,
            cleanup,
            name_source: NameSource::FromModDisplayName,
            target_tag: legacy.map(|t| t.tag.to_string()),
            original_archive: None,
        });
    }
    // The skeleton wraps whatever family the primary target declares it contains, so that is
    // the extension worth finding in the archive.
    let contained = cfg
        .primary()
        .contained_extension
        .ok_or_else(|| "this game's primary target declares no file family".to_string())?;
    let entries = list_unit_entries_indexed(&downloaded, contained)?;
    match entries.len() {
        0 => {
            if has_ue4ss_loader_signature(&downloaded) {
                return Err(ResolveError::Ue4ssLoader(downloaded));
            }
            if let Some(result) = try_classify_as_directory_target(&downloaded, cfg, registry) {
                return result;
            }
            // Nothing classified: classify_archive_dirs found no enclosing folder at all (a
            // genuinely flat archive, every entry sitting at the zip root), so there is no
            // name to adopt automatically. Surface a confirm dialog rather than deleting the
            // download. The renderer can still install the whole archive as one mods/<name>
            // folder if the user confirms it's the right content.
            let zip_path = downloaded.to_string_lossy().to_string();
            let archive_handle = stage_archive(
                registry,
                StagedArchiveKind::CrimeBossFlat,
                &zip_path,
                Vec::new(),
            )?;
            Err(prompt_err(InstallPrompt::CbFlatArchive(CbFlatPayload {
                archive_handle,
                mod_id: None,
                mod_name: None,
                file_id: None,
                file_type: None,
                mod_version: None,
            })))
        }
        1 => {
            let (index, name) = entries[0].clone();
            let entry = StagedEntry {
                source: StagedEntrySource::File { index },
                display_name: name,
            };
            let tmp = extract_entry_into_crimeboss_skeleton_at(
                &downloaded,
                &entry,
                cfg.primary().companions,
            )?;
            let cleanup = CleanupPlan::RemoveOwnedDirectory(tmp.clone());
            Ok(Staged {
                root: tmp,
                cleanup,
                // The skeleton root is a uuid directory, so the real name has to come back
                // out of the archive's single pak entry.
                name_source: NameSource::FromModDisplayName,
                target_tag: None,
                original_archive: Some(downloaded),
            })
        }
        _ => {
            let zip_path = downloaded.to_string_lossy().to_string();
            let staged = entries
                .into_iter()
                .map(|(index, name)| StagedEntry {
                    source: StagedEntrySource::File { index },
                    display_name: name,
                })
                .collect();
            let payload = multi_pak_payload(registry, zip_path, staged, None, None, None)?;
            Err(prompt_err(InstallPrompt::ZipMultiPak(payload)))
        }
    }
}

/// Extracts a staged entry that names one entry of this archive, plus its .ucas/.utoc
/// siblings, into a fresh temp directory shaped Content/Paks/WindowsNoEditor/<filename>,
/// ready to be copied wholesale into CrimeBoss/Mods/<name>/ as a Directory-unit install.
pub(crate) fn extract_entry_into_crimeboss_skeleton_at(
    archive_path: &Path,
    entry: &StagedEntry,
    companions: &[&str],
) -> Result<PathBuf, String> {
    let tmp_root = std::env::temp_dir().join(format!("modrex-cb-mod-{}", Uuid::new_v4()));
    let skeleton_dir = tmp_root
        .join("Content")
        .join("Paks")
        .join("WindowsNoEditor");
    std::fs::create_dir_all(&skeleton_dir).map_err(|e| e.to_string())?;
    let filename = Path::new(&entry.display_name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("invalid archive entry name: {}", entry.display_name))?;
    extract_staged_entry_with_sidecars(
        archive_path,
        entry,
        &skeleton_dir.join(filename),
        companions,
    )?;
    Ok(tmp_root)
}

/// Extracts the entry this staged identity names, plus the companion entries sharing its stem.
pub(crate) fn extract_staged_entry_with_sidecars(
    archive_path: &Path,
    entry: &StagedEntry,
    dest: &Path,
    companions: &[&str],
) -> Result<(), String> {
    let StagedEntrySource::File { index } = entry.source else {
        return Err("that archive entry is not a file".to_string());
    };
    extract_entry_at(archive_path, index, dest)?;
    let Ok(entries) = list_entries(archive_path) else {
        return Ok(());
    };
    let key = entry_key(&entry.display_name);
    for ext in companions {
        let sidecar = entries.iter().enumerate().find(|(_, e)| {
            !e.is_dir
                && entry_key(&e.name) == key
                && e.name.to_ascii_lowercase().ends_with(&format!(".{ext}"))
        });
        if let Some((sidecar_index, _)) = sidecar {
            let _ = extract_entry_at(
                archive_path,
                sidecar_index as u32,
                &dest.with_extension(ext),
            );
        }
    }
    Ok(())
}

/// Extracts everything under the directory this staged identity names.
pub(crate) fn extract_staged_dir(
    archive_path: &Path,
    entry: &StagedEntry,
    dest: &Path,
) -> Result<(), String> {
    match &entry.source {
        StagedEntrySource::Directory { prefix } => extract_dir_entry(archive_path, prefix, dest),
        StagedEntrySource::File { .. } => Err("that archive entry is not a directory".to_string()),
    }
}

fn extract_rar_entry(archive_path: &Path, entry_name: &str, dest: &Path) -> Result<(), String> {
    let normalized = entry_name.replace('\\', "/");
    let tmp_dir = std::env::temp_dir().join(format!("rar-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let mut archive = unrar::Archive::new(archive_path)
            .open_for_processing()
            .map_err(|e| e.to_string())?;
        loop {
            match archive.read_header().map_err(|e| e.to_string())? {
                None => return Err(format!("entry '{}' not found in archive", entry_name)),
                Some(header) => {
                    let name = header.entry().filename.to_string_lossy().replace('\\', "/");
                    if name == normalized {
                        // extract_with_base writes to tmp_dir joined with the internal name,
                        // reject traversal so it can't escape tmp_dir.
                        if safe_dest(&tmp_dir, &name).is_none() {
                            return Err("archive entry escapes extraction directory".to_string());
                        }
                        let entry_filename = header.entry().filename.clone();
                        header
                            .extract_with_base(&tmp_dir)
                            .map_err(|e| e.to_string())?;
                        let extracted = tmp_dir.join(&entry_filename);
                        return std::fs::copy(&extracted, dest)
                            .map(|_| ())
                            .map_err(|e| e.to_string());
                    }
                    archive = header.skip().map_err(|e| e.to_string())?;
                }
            }
        }
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

fn rar_copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            std::fs::create_dir_all(&dst_path).map_err(|e| e.to_string())?;
            rar_copy_dir(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn extract_dir_rar(archive_path: &Path, dir_prefix: &str, dest: &Path) -> Result<(), String> {
    let prefix = format!("{}/", dir_prefix);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let tmp_dir = std::env::temp_dir().join(format!("rar-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let mut archive = unrar::Archive::new(archive_path)
            .open_for_processing()
            .map_err(|e| e.to_string())?;
        loop {
            match archive.read_header().map_err(|e| e.to_string())? {
                None => break,
                Some(header) => {
                    let name = header.entry().filename.to_string_lossy().replace('\\', "/");
                    // extract_with_base writes to tmp_dir joined with the internal name; skip
                    // any entry whose path would escape tmp_dir (Zip-Slip via ..).
                    if !header.entry().is_directory()
                        && name.starts_with(&prefix)
                        && safe_dest(&tmp_dir, &name).is_some()
                    {
                        archive = header
                            .extract_with_base(&tmp_dir)
                            .map_err(|e| e.to_string())?;
                    } else {
                        archive = header.skip().map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        let src = tmp_dir.join(dir_prefix.replace('/', std::path::MAIN_SEPARATOR_STR));
        rar_copy_dir(&src, dest)
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Returns the updated mod list and whether any archive_broken value was newly determined.
/// Skips mods where archive_broken is already Some, the result being cached in the state file.
pub fn mark_archive_files(
    game_path: &str,
    folders: &[ModFolder],
    mut mods: Vec<InstalledMod>,
    cfg: &ModEngineConfig,
) -> (Vec<InstalledMod>, bool) {
    let mut any_checked = false;
    for m in &mut mods {
        if m.missing == Some(true) || m.archive_broken.is_some() {
            continue;
        }
        let rel = get_folder_path(folders, m.folder_id.as_deref());
        let target = cfg.target_for(m.location.as_deref());
        let path = if m.enabled {
            active_mod_path(game_path, &m.filename, rel.as_deref(), target)
        } else {
            disabled_mod_path(game_path, &m.filename, rel.as_deref(), target)
        };
        m.archive_broken = Some(detect_archive(&path).is_some());
        any_checked = true;
    }
    (mods, any_checked)
}
