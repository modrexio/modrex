use super::engine::{ModEngineConfig, ModUnit};
use super::host_mods::detect_host_pack;
use super::paths::{active_mod_path, disabled_mod_path};
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

/// One archive member: `name` is normalized to forward slashes; `is_dir` flags directory
/// entries. The pak/dir listing operations are pure functions over a `Vec` of these.
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

pub fn list_pak_entries(path: &Path) -> Result<Vec<String>, String> {
    Ok(list_entries(path)?
        .into_iter()
        .filter(|e| !e.is_dir && e.name.ends_with(".pak"))
        .map(|e| e.name)
        .collect())
}

pub fn extract_entry(archive_path: &Path, entry_name: &str, dest: &Path) -> Result<(), String> {
    match detect_archive(archive_path) {
        Some(ArchiveFormat::Zip) => extract_zip_entry(archive_path, entry_name, dest),
        Some(ArchiveFormat::SevenZip) => extract_7z_entry(archive_path, entry_name, dest),
        Some(ArchiveFormat::TarGz) => extract_tar_entry(
            flate2::read::GzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            entry_name,
            dest,
        ),
        Some(ArchiveFormat::TarXz) => extract_tar_entry(
            xz2::read::XzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            entry_name,
            dest,
        ),
        Some(ArchiveFormat::Rar) => extract_rar_entry(archive_path, entry_name, dest),
        None => Err("Not a supported archive format".to_string()),
    }
}

pub fn extract_zip_entry(zip_path: &Path, entry_name: &str, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    // Some Windows ZIPs store paths with backslashes; try both separators.
    let index = archive
        .index_for_name(entry_name)
        .or_else(|| archive.index_for_name(&entry_name.replace('/', "\\")))
        .ok_or_else(|| format!("entry '{}' not found in archive", entry_name))?;
    let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
    let mut dest_file = File::create(dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut dest_file).map_err(|e| e.to_string())?;
    Ok(())
}

fn extract_7z_entry(archive_path: &Path, entry_name: &str, dest: &Path) -> Result<(), String> {
    use std::cell::RefCell;
    // Write directly from the callback reader; avoids depending on sevenz-rust's
    // directory-creation behavior. Normalize separators for cross-platform archives.
    let normalized = entry_name.replace('\\', "/");
    let write_result: RefCell<Option<Result<(), String>>> = RefCell::new(None);

    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    sevenz_rust::decompress_with_extract_fn(file, Path::new("."), |entry, reader, _dest| {
        if !entry.is_directory() && entry.name().replace('\\', "/") == normalized {
            let r = File::create(dest)
                .and_then(|mut f| std::io::copy(reader, &mut f).map(|_| ()))
                .map_err(|e| e.to_string());
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

fn extract_tar_entry<R: Read>(reader: R, entry_name: &str, dest: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let path = entry.path().map_err(|e| e.to_string())?;
        if path.to_string_lossy().replace('\\', "/") == entry_name {
            let mut dest_file = File::create(dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut dest_file).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err(format!("entry '{}' not found in archive", entry_name))
}

/// The archive-entry key used to match a `.pak` to its IoStore siblings: directory plus stem,
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

/// Like `extract_entry`, but also extracts any `.ucas`/`.utoc` siblings of `entry_name` found in
/// the same archive (matched by directory + stem) to `dest.with_extension(...)`. A missing
/// sidecar is not an error — most mods don't ship IoStore triplets, only some games' do.
pub fn extract_entry_with_sidecars(
    archive_path: &Path,
    entry_name: &str,
    dest: &Path,
) -> Result<(), String> {
    extract_entry(archive_path, entry_name, dest)?;
    let Ok(entries) = list_entries(archive_path) else {
        return Ok(());
    };
    let key = entry_key(entry_name);
    for ext in super::naming::PAK_SIDECAR_EXTENSIONS {
        let sidecar = entries.iter().find(|e| {
            !e.is_dir
                && entry_key(&e.name) == key
                && e.name.to_ascii_lowercase().ends_with(&format!(".{ext}"))
        });
        if let Some(sidecar) = sidecar {
            let _ = extract_entry(archive_path, &sidecar.name, &dest.with_extension(ext));
        }
    }
    Ok(())
}

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

/// Every directory path present in `names` (inferred from each entry's path components, so it
/// works whether or not the archive stores explicit directory entries). Names ending in `/`
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

/// If `name` routes through a literal destination segment `seg` (e.g. `assets/mod_overrides/`),
/// returns `(mod_dir, wrapper)` where `mod_dir` is the directory immediately inside the segment
/// (the real override mod, even when the packager nested it in extra folders) and `wrapper` is
/// the path preceding the segment. Returns `None` when the segment is absent.
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

/// True when an archive carries no loader marker and no nested asset structure — a flat folder of
/// loose files (e.g. a menu-background set for an unknown host). A real asset-override mod nests
/// its files under category dirs (`ModDir/category/file` → 2+ slashes), so the absence of any
/// such nesting means the pack belongs inside some other mod that Modrex can't infer.
/// `extra_markers` is the union of all `entry_markers` from the active engine config so that
/// game-specific markers (e.g. `base.lua` for DAHM sub-mods) are recognised alongside the
/// universal `mod.txt` / `main.xml`.
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
/// is `(dir_path, location_tag)` where `location_tag` is `None` for the primary target and
/// `Some(tag)` for a secondary target (e.g. `"mod_overrides"`).
///
/// - **Marker-bearing targets** (e.g. `mods` with `mod.txt`/`main.xml`) claim any dir that
///   contains one of their markers, at any depth — so BeardLib/BLT mods route to `mods/`
///   regardless of which folder the packager dropped them in.
/// - The **marker-less (override) target** claims marker-less directories that sit at the same
///   depth as the marker dirs (the asset-replacement mods packaged alongside the BLT mods).
///   When the archive has no markers at all, it falls back to the top-level directories —
///   preserving the single asset-override mod case.
///
/// A dir is never double-claimed; the first (lowest-index) target wins.
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

        // Pass A — explicit destination segment. Some packers nest the real mod inside its own
        // `assets/mod_overrides/<name>/` (or wrap it in extra folders); the dir immediately inside
        // the segment is the authoritative override mod. Skip segments that live inside a marker
        // mod (a BeardLib mod loads its own internal overrides — they don't go in the game dir).
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
            // `collect_all_dirs` yields parents before children.
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
                    continue; // d wraps a destination segment — handled by pass A
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

/// Joins an archive-internal (`/`-separated) path onto `dest`, returning `None` if it would
/// escape `dest` via an absolute path, drive/UNC prefix, or `..` component. Archive entries
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

/// Extracts all entries under `dir_prefix/` from the archive into `dest/`.
pub fn extract_dir_entry(archive_path: &Path, dir_prefix: &str, dest: &Path) -> Result<(), String> {
    match detect_archive(archive_path) {
        Some(ArchiveFormat::Zip) => extract_dir_zip(archive_path, dir_prefix, dest),
        Some(ArchiveFormat::SevenZip) => extract_dir_7z(archive_path, dir_prefix, dest),
        Some(ArchiveFormat::TarGz) => extract_dir_tar(
            flate2::read::GzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            dir_prefix,
            dest,
        ),
        Some(ArchiveFormat::TarXz) => extract_dir_tar(
            xz2::read::XzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            dir_prefix,
            dest,
        ),
        Some(ArchiveFormat::Rar) => extract_dir_rar(archive_path, dir_prefix, dest),
        None => Err("Not a supported archive format".to_string()),
    }
}

fn extract_dir_zip(zip_path: &Path, dir_prefix: &str, dest: &Path) -> Result<(), String> {
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
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_dir_7z(archive_path: &Path, dir_prefix: &str, dest: &Path) -> Result<(), String> {
    use std::cell::RefCell;
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let prefix = format!("{}/", dir_prefix);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let dest = dest.to_path_buf();
    let write_err: RefCell<Option<String>> = RefCell::new(None);
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
        if let Err(e) =
            File::create(&dest_path).and_then(|mut f| std::io::copy(reader, &mut f).map(|_| ()))
        {
            *write_err.borrow_mut() = Some(e.to_string());
        }
        Ok(true)
    })
    .map_err(|e| e.to_string())?;
    if let Some(e) = write_err.into_inner() {
        return Err(e);
    }
    Ok(())
}

fn extract_dir_tar<R: Read>(reader: R, dir_prefix: &str, dest: &Path) -> Result<(), String> {
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
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `UE4SS-settings.ini` sits at the zip's top level only in the full loader package — verified
/// against the real UE4SS-CB and PD3-UE4SS releases, both of which also ship many
/// `Scripts/main.lua` paths for their own bundled framework sub-mods, so that marker alone can't
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

/// Extracts every entry in the archive directly into `dest`, preserving the archive's own
/// internal structure (used for the UE4SS loader package, which must land as a flat dump in
/// `Binaries/<platform>/` rather than under any scan-target skeleton).
pub fn extract_archive_flat(archive_path: &Path, dest: &Path) -> Result<(), String> {
    match detect_archive(archive_path) {
        Some(ArchiveFormat::Zip) => extract_flat_zip(archive_path, dest),
        Some(ArchiveFormat::SevenZip) => extract_flat_7z(archive_path, dest),
        Some(ArchiveFormat::TarGz) => extract_flat_tar(
            flate2::read::GzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            dest,
        ),
        Some(ArchiveFormat::TarXz) => extract_flat_tar(
            xz2::read::XzDecoder::new(File::open(archive_path).map_err(|e| e.to_string())?),
            dest,
        ),
        Some(ArchiveFormat::Rar) => extract_flat_rar(archive_path, dest),
        None => Err("Not a supported archive format".to_string()),
    }
}

fn extract_flat_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
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
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_flat_7z(archive_path: &Path, dest: &Path) -> Result<(), String> {
    use std::cell::RefCell;
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let dest = dest.to_path_buf();
    let write_err: RefCell<Option<String>> = RefCell::new(None);
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
        if let Err(e) =
            File::create(&dest_path).and_then(|mut f| std::io::copy(reader, &mut f).map(|_| ()))
        {
            *write_err.borrow_mut() = Some(e.to_string());
        }
        Ok(true)
    })
    .map_err(|e| e.to_string())?;
    if let Some(e) = write_err.into_inner() {
        return Err(e);
    }
    Ok(())
}

fn extract_flat_tar<R: Read>(reader: R, dest: &Path) -> Result<(), String> {
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
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
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
                    // any entry whose path would escape tmp_dir (Zip-Slip via `..`).
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
    pub zip_path: String,
    pub entries: Vec<String>,
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
    pub zip_path: String,
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
    pub zip_path: String,
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
    zip_path: String,
    entries: Vec<String>,
    target_tag: Option<String>,
    entry_tags: Option<Vec<Option<String>>>,
    entry_kind: Option<String>,
) -> ZipMultiPakPayload {
    ZipMultiPakPayload {
        zip_path,
        entries,
        target_tag,
        entry_tags,
        entry_kind,
        mod_id: None,
        mod_name: None,
        file_id: None,
        file_type: None,
        mod_version: None,
    }
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

/// Same shape `resolve_archive_download` resolves to: the extracted path, the original archive
/// (for cleanup once installed), and the target's location tag (`None` for primary).
type ResolvedArchive = Result<(PathBuf, Option<PathBuf>, Option<String>), ResolveError>;

/// Checks whether a zero-`.pak` archive instead contains directory-shaped content matching one
/// of `cfg`'s Directory-unit targets — currently only `ue4ss_mods` ever matches here (a
/// standalone UE4SS Lua sub-mod, e.g. `Mods/<name>/Scripts/main.lua`), since it's the only
/// Directory target a File-unit-primary game (PD3) or CB's pak-specific resolver wouldn't
/// otherwise consult. Reuses `classify_archive_dirs` as-is — it already iterates every target in
/// `cfg.targets` regardless of which one is primary. Returns `None` when nothing matches, so the
/// caller falls through to its own "no .pak files" error.
fn try_classify_as_directory_target(
    downloaded: &Path,
    cfg: &ModEngineConfig,
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
        // Two-level temp: {uuid_dir}/{dir_name} so tmp.file_name() == dir_name — matches the
        // generic Directory-unit single-dir branch below.
        let tmp_parent = std::env::temp_dir().join(format!("modrex-mod-{}", Uuid::new_v4()));
        let tmp = tmp_parent.join(&dir_name);
        return Some(
            extract_dir_entry(downloaded, dir, &tmp)
                .map(|_| (tmp, Some(downloaded.to_path_buf()), location_tag.clone()))
                .map_err(ResolveError::from),
        );
    }
    let zip_path = downloaded.to_string_lossy().to_string();
    let entry_names: Vec<String> = dirs.iter().map(|(d, _)| d.clone()).collect();
    let distinct_tags: HashSet<&Option<String>> = dirs.iter().map(|(_, t)| t).collect();
    // These entries are directory paths (from classify_archive_dirs), not .pak files — load-bearing
    // for Crime Boss, whose install_from_zip_entry otherwise assumes every entry is a single pak
    // file to wrap in its synthesized skeleton.
    let payload = multi_pak_payload(
        zip_path,
        entry_names,
        if distinct_tags.len() == 1 {
            dirs[0].1.clone()
        } else {
            None
        },
        (distinct_tags.len() > 1).then(|| dirs.iter().map(|(_, t)| t.clone()).collect()),
        Some("dir".to_string()),
    );
    Some(Err(prompt_err(InstallPrompt::ZipMultiPak(payload))))
}

/// Resolves a downloaded archive into an installable path plus the detected scan-target tag.
/// Returns `(extracted_path, original_archive, location_tag)` where `location_tag` is `None`
/// for the primary target and `Some(tag)` for any secondary target (e.g. `"mod_overrides"`).
pub fn resolve_archive_download(downloaded: PathBuf, cfg: &ModEngineConfig) -> ResolvedArchive {
    // Must run before detect_archive: .pdmod is a ZIP by magic bytes and would fall through to
    // the Directory-unit path without this early check.
    if cfg.game_id == "pdth"
        && downloaded
            .extension()
            .map(|e| e.eq_ignore_ascii_case("pdmod"))
            .unwrap_or(false)
    {
        let temp_dir = std::env::temp_dir().join(format!("modrex-pdmod-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
        return match super::pdmod::extract_pdmod(&downloaded, &temp_dir) {
            Ok(()) => Ok((
                temp_dir,
                Some(downloaded),
                Some("mod_overrides".to_string()),
            )),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&temp_dir);
                Err(e.into())
            }
        };
    }
    if cfg.game_id == "cb" {
        return resolve_crimeboss_archive(downloaded, cfg);
    }
    if detect_archive(&downloaded).is_none() {
        return Ok((downloaded, None, None));
    }
    match &cfg.primary().unit {
        ModUnit::File { .. } => {
            let entries = list_pak_entries(&downloaded)?;
            match entries.len() {
                0 => {
                    if has_ue4ss_loader_signature(&downloaded) {
                        return Err(ResolveError::Ue4ssLoader(downloaded));
                    }
                    if let Some(result) = try_classify_as_directory_target(&downloaded, cfg) {
                        return result;
                    }
                    let _ = std::fs::remove_file(&downloaded);
                    Err(ResolveError::Failure(
                        "This mod is packaged as an archive with no .pak files inside.".to_string(),
                    ))
                }
                1 => {
                    let tmp =
                        std::env::temp_dir().join(format!("modrex-mod-{}.pak", Uuid::new_v4()));
                    extract_entry_with_sidecars(&downloaded, &entries[0], &tmp)?;
                    Ok((tmp, Some(downloaded), None))
                }
                _ => {
                    let zip_path = downloaded.to_string_lossy().to_string();
                    Err(prompt_err(InstallPrompt::ZipMultiPak(multi_pak_payload(
                        zip_path, entries, None, None, None,
                    ))))
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
                    return Err(prompt_err(InstallPrompt::HostModPack(HostPackPayload {
                        zip_path,
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
            // override mod and isn't a known host pack — it installs inside some other mod we can't
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
                let _ = std::fs::remove_file(&downloaded);
                return Err(prompt_err(InstallPrompt::UnrecognizedArchive));
            }
            let dirs = classify_archive_dirs(&names, cfg);
            if dirs.is_empty() {
                let _ = std::fs::remove_file(&downloaded);
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
                return Ok((tmp, Some(downloaded), location_tag.clone()));
            }
            let zip_path = downloaded.to_string_lossy().to_string();
            let entry_names: Vec<String> = dirs.iter().map(|(d, _)| d.clone()).collect();
            let distinct_tags: HashSet<&Option<String>> = dirs.iter().map(|(_, t)| t).collect();
            // Single target keeps one targetTag for all entries; mixed targets (e.g. a
            // modpack spanning mods/ and assets/mod_overrides/) tag each entry
            // individually so the picker routes it to the right place.
            let payload = multi_pak_payload(
                zip_path,
                entry_names,
                if distinct_tags.len() == 1 {
                    dirs[0].1.clone()
                } else {
                    None
                },
                (distinct_tags.len() > 1).then(|| dirs.iter().map(|(_, t)| t.clone()).collect()),
                None,
            );
            Err(prompt_err(InstallPrompt::ZipMultiPak(payload)))
        }
    }
}

/// Crime Boss's two real archive shapes — a loose `.pak`/`.ucas`/`.utoc` triplet at any depth,
/// or the official ModKit's "Package Mod" folder output — both reduce to "find the .pak,
/// wherever it is, plus its siblings." Unlike PD2/PDTH's Directory targets, the result isn't an
/// author-supplied folder copied as-is: Modrex always synthesizes the canonical
/// `Content/Paks/WindowsNoEditor/` skeleton the game's UGC mod-loader expects under
/// `CrimeBoss/Mods/<name>/`, regardless of how the source archive nested things.
fn resolve_crimeboss_archive(downloaded: PathBuf, cfg: &ModEngineConfig) -> ResolvedArchive {
    if detect_archive(&downloaded).is_none() {
        // No known real mod ships a bare .pak with no archive (sidecars require a zip to carry
        // them), but if one shows up, fall back to the legacy flat `paks` target rather than
        // guessing at a skeleton with no .ucas/.utoc to find.
        let legacy_tag = cfg.targets.iter().find(|t| t.tag == "paks").map(|t| t.tag);
        return Ok((downloaded, None, legacy_tag.map(str::to_string)));
    }
    let entries = list_pak_entries(&downloaded)?;
    match entries.len() {
        0 => {
            if has_ue4ss_loader_signature(&downloaded) {
                return Err(ResolveError::Ue4ssLoader(downloaded));
            }
            if let Some(result) = try_classify_as_directory_target(&downloaded, cfg) {
                return result;
            }
            // Nothing classified: classify_archive_dirs found no enclosing folder at all (a
            // genuinely flat archive — every entry sits at the zip root), so there's no folder
            // name to adopt automatically. Surface a confirm dialog rather than deleting the
            // download — the renderer can still install the whole archive as one mods/<name>
            // folder if the user confirms it's the right content.
            let zip_path = downloaded.to_string_lossy().to_string();
            Err(prompt_err(InstallPrompt::CbFlatArchive(CbFlatPayload {
                zip_path,
                mod_id: None,
                mod_name: None,
                file_id: None,
                file_type: None,
                mod_version: None,
            })))
        }
        1 => {
            let tmp = extract_entry_into_crimeboss_skeleton(&downloaded, &entries[0])?;
            Ok((tmp, Some(downloaded), None))
        }
        _ => {
            let zip_path = downloaded.to_string_lossy().to_string();
            let payload = multi_pak_payload(zip_path, entries, None, None, None);
            Err(prompt_err(InstallPrompt::ZipMultiPak(payload)))
        }
    }
}

/// Extracts `entry_name` (a `.pak` archive entry) plus its `.ucas`/`.utoc` siblings into a fresh
/// temp directory shaped `Content/Paks/WindowsNoEditor/<filename>`, ready to be copied wholesale
/// into `CrimeBoss/Mods/<name>/` as a Directory-unit install.
pub fn extract_entry_into_crimeboss_skeleton(
    archive_path: &Path,
    entry_name: &str,
) -> Result<PathBuf, String> {
    let tmp_root = std::env::temp_dir().join(format!("modrex-cb-mod-{}", Uuid::new_v4()));
    let skeleton_dir = tmp_root
        .join("Content")
        .join("Paks")
        .join("WindowsNoEditor");
    std::fs::create_dir_all(&skeleton_dir).map_err(|e| e.to_string())?;
    let filename = Path::new(entry_name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("invalid archive entry name: {entry_name}"))?;
    extract_entry_with_sidecars(archive_path, entry_name, &skeleton_dir.join(filename))?;
    Ok(tmp_root)
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
                        // extract_with_base writes to tmp_dir joined with the internal name —
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
                    // any entry whose path would escape tmp_dir (Zip-Slip via `..`).
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

/// Returns the updated mod list and whether any `archive_broken` value was newly determined.
/// Skips mods where `archive_broken` is already `Some` — the result was cached in the state file.
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
