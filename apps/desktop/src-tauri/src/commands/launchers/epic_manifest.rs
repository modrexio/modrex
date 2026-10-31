//! The game's own files in an Epic installation, read from the launcher's installation
//! records and the BuildPatch manifest each record names under .egstore. Only the file list
//! is used, so chunk data and per-file hashes are not interpreted.
//!
//! Binary BuildPatch manifest, little-endian, as Epic's BuildPatchServices writes it:
//!   header: u32 magic 0x44BEC00C, u32 header size, u32 body size, u32 stored size,
//!           20 byte SHA-1 of the body, u8 storage flags (1 zlib, 2 encrypted),
//!           u32 feature level, then 32 bytes of encryption fields when header size is 73
//!   body:   sections in order meta, chunk list, file list, custom fields. Each starts with
//!           a u32 size that counts itself and a u8 version.
//!   file list: u32 count, count filenames, count symlink targets, then per-file arrays
//!           this reader does not need.
//!   strings: i32 length counting a trailing NUL, positive for 8-bit text, negative for
//!           UTF-16LE code units, zero for empty.
//! Encrypted and JSON manifests are refused rather than read partially.

use super::native_paths::{
    normalize_native_path, read_bounded, CatalogSource, NativePaths, MAX_PATH_BYTES,
};
use crate::commands::path_display::display_path;
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_ITEM_BYTES: usize = 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 64 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 256 * 1024 * 1024;
const MAX_FILES: usize = 1_000_000;
const MANIFEST_MAGIC: u32 = 0x44bec00c;
const STORED_COMPRESSED: u8 = 1;
const STORED_ENCRYPTED: u8 = 2;

#[derive(Clone, Debug)]
pub(crate) struct EpicNativeFiles {
    pub game_root: PathBuf,
    pub native: NativePaths,
    selected_game_root: PathBuf,
    sources: Vec<CatalogSource>,
}

impl EpicNativeFiles {
    pub(crate) fn protects(&self, relative: &Path) -> Result<bool, String> {
        self.native.protects(relative)
    }

    pub(crate) fn protects_tree(&self, relative: &Path) -> Result<bool, String> {
        self.native.protects_tree(relative)
    }

    /// Rechecks the installation records and manifests before committing a filesystem mutation.
    pub(crate) fn verify_unchanged(&self) -> Result<(), String> {
        let root = fs::canonicalize(&self.selected_game_root)
            .map_err(|e| format!("Could not recheck Epic installation root: {e}"))?;
        if root != self.game_root {
            return Err("Epic installation root changed during the operation".into());
        }
        self.sources
            .iter()
            .try_for_each(CatalogSource::verify_unchanged)
    }
}

/// Builds the file list of every Epic installation record that names game_root, so a DLC
/// installed into the same folder is covered alongside the base game named display_name.
pub(crate) fn read_native_files(
    manifest_dir: &Path,
    display_name: &str,
    game_root: &Path,
) -> Result<EpicNativeFiles, String> {
    let selected_game_root = std::path::absolute(game_root)
        .map_err(|e| format!("Could not resolve selected Epic path: {e}"))?;
    let game_root = fs::canonicalize(&selected_game_root)
        .map_err(|e| format!("Could not resolve Epic installation root: {e}"))?;
    let entries = fs::read_dir(manifest_dir).map_err(|e| {
        format!(
            "Could not read Epic installation records in {}: {e}",
            display_path(manifest_dir)
        )
    })?;
    let mut sources = Vec::new();
    let mut native_paths = BTreeMap::<String, String>::new();
    let mut found_base_game = false;
    for entry in entries {
        let path = entry
            .map_err(|e| format!("Could not read Epic installation records: {e}"))?
            .path();
        if path.extension().and_then(|e| e.to_str()) != Some("item") {
            continue;
        }
        let item_bytes = read_bounded(&path, MAX_ITEM_BYTES)?;
        // The launcher leaves empty or zero-filled records behind. One that is not JSON
        // describes no installation, so it cannot hold part of this one.
        let Ok(record) = serde_json::from_slice::<serde_json::Value>(&item_bytes) else {
            continue;
        };
        let Some(location) = record["InstallLocation"].as_str() else {
            continue;
        };
        if fs::canonicalize(location).ok().as_ref() != Some(&game_root) {
            continue;
        }
        if record["bIsIncompleteInstall"].as_bool() != Some(false)
            || record["bNeedsValidation"].as_bool() != Some(false)
        {
            return Err(format!(
                "Epic reports the installation in {} as incomplete or needing verification",
                display_path(&path)
            ));
        }
        let guid = record["InstallationGuid"].as_str().unwrap_or("");
        if guid.len() != 32 || !guid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!(
                "Epic installation record {} has no valid installation id",
                display_path(&path)
            ));
        }
        found_base_game |= record["DisplayName"].as_str() == Some(display_name);
        let manifest = game_root.join(".egstore").join(format!("{guid}.manifest"));
        let manifest_bytes = read_bounded(&manifest, MAX_MANIFEST_BYTES)?;
        let files = parse_manifest(&manifest_bytes).map_err(|e| {
            format!(
                "Invalid Epic BuildPatch manifest {}: {e}",
                display_path(&manifest)
            )
        })?;
        for spelling in files {
            let normalized = normalize_native_path(&spelling)?;
            let spelling = spelling.replace('\\', "/");
            if let Some(existing) = native_paths.get(&normalized) {
                if existing != &spelling {
                    return Err(format!(
                        "Epic manifests contain a path case collision: {spelling}"
                    ));
                }
                continue;
            }
            if native_paths.len() >= MAX_FILES {
                return Err("Epic native-file catalog exceeds the path count limit".into());
            }
            native_paths.insert(normalized, spelling);
        }
        sources.push(CatalogSource::new(path, &item_bytes, MAX_ITEM_BYTES));
        sources.push(CatalogSource::new(
            manifest,
            &manifest_bytes,
            MAX_MANIFEST_BYTES,
        ));
    }
    if !found_base_game {
        return Err("No Epic installation record for this game names the selected folder".into());
    }
    let snapshot = EpicNativeFiles {
        game_root,
        native: NativePaths::new(native_paths)?,
        selected_game_root,
        sources,
    };
    snapshot.verify_unchanged()?;
    Ok(snapshot)
}

struct Reader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self
            .cursor
            .checked_add(len)
            .filter(|&end| end <= self.bytes.len())
            .ok_or("BuildPatch data ends early")?;
        let slice = &self.bytes[self.cursor..end];
        self.cursor = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("take returned four bytes"),
        ))
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(
            self.take(4)?.try_into().expect("take returned four bytes"),
        ))
    }

    /// The section's contents after its size and version, leaving the cursor past its end.
    fn section(&mut self) -> Result<Reader<'a>, String> {
        let start = self.cursor;
        let size = self.u32()? as usize;
        if size < 5 {
            return Err("BuildPatch section is shorter than its own header".into());
        }
        self.cursor = start;
        let section = self.take(size)?;
        Ok(Reader {
            bytes: &section[5..],
            cursor: 0,
        })
    }

    fn string(&mut self) -> Result<String, String> {
        let len = self.i32()?;
        if len == 0 {
            return Ok(String::new());
        }
        let units = len.unsigned_abs() as usize;
        if units > MAX_PATH_BYTES + 1 {
            return Err("BuildPatch string exceeds the length limit".into());
        }
        let text = if len > 0 {
            let bytes = self.take(units)?;
            let (text, nul) = bytes.split_at(units - 1);
            if nul != [0] {
                return Err("BuildPatch string is not NUL terminated".into());
            }
            text.iter().map(|&b| char::from(b)).collect::<String>()
        } else {
            let bytes = self.take(units * 2)?;
            let code_units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair))
                .collect();
            let (text, nul) = code_units.split_at(units - 1);
            if nul != [0] {
                return Err("BuildPatch string is not NUL terminated".into());
            }
            String::from_utf16(text).map_err(|_| "BuildPatch string is not valid UTF-16")?
        };
        if text.contains('\0') {
            return Err("BuildPatch string contains an embedded NUL".into());
        }
        Ok(text)
    }
}

fn parse_manifest(bytes: &[u8]) -> Result<Vec<String>, String> {
    let text_start = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if text_start.trim_ascii_start().first() == Some(&b'{') {
        return Err("JSON BuildPatch manifests are not supported".into());
    }
    let mut header = Reader { bytes, cursor: 0 };
    if header.u32()? != MANIFEST_MAGIC {
        return Err("not a BuildPatch manifest".into());
    }
    let header_size = header.u32()? as usize;
    let body_size = header.u32()? as usize;
    let stored_size = header.u32()? as usize;
    let digest: [u8; 20] = header
        .take(20)?
        .try_into()
        .expect("take returned twenty bytes");
    let stored_as = header.u8()?;
    header.u32()?;
    if header_size != 41 && header_size != 73 {
        return Err(format!("unsupported header size {header_size}"));
    }
    if stored_as & !(STORED_COMPRESSED | STORED_ENCRYPTED) != 0 {
        return Err(format!("unsupported storage flags {stored_as}"));
    }
    if stored_as & STORED_ENCRYPTED != 0 {
        return Err("encrypted manifests are not supported".into());
    }
    if body_size > MAX_BODY_BYTES {
        return Err("manifest body exceeds the byte limit".into());
    }
    let stored = bytes
        .get(header_size..)
        .filter(|stored| stored.len() == stored_size)
        .ok_or("stored body size does not match the header")?;
    let body = if stored_as & STORED_COMPRESSED != 0 {
        let mut body = Vec::new();
        flate2::read::ZlibDecoder::new(stored)
            .take(body_size as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|e| format!("could not decompress the body: {e}"))?;
        body
    } else {
        stored.to_vec()
    };
    if body.len() != body_size {
        return Err("body size does not match the header".into());
    }
    if <[u8; 20]>::from(Sha1::digest(&body)) != digest {
        return Err("body SHA-1 does not match the header".into());
    }
    let mut sections = Reader {
        bytes: &body,
        cursor: 0,
    };
    sections.section()?;
    sections.section()?;
    let mut file_list = sections.section()?;
    let count = file_list.u32()? as usize;
    if count > MAX_FILES {
        return Err("file list exceeds the path count limit".into());
    }
    let mut files = Vec::with_capacity(count);
    for _ in 0..count {
        files.push(file_list.string()?);
    }
    for _ in 0..count {
        if !file_list.string()?.is_empty() {
            return Err("symbolic link entries are not supported".into());
        }
    }
    Ok(files)
}

#[cfg(test)]
#[path = "epic_manifest_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) use tests::write_test_install;
