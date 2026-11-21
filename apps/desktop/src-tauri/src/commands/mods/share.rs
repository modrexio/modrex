use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::io::Write;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use flate2::{write::DeflateEncoder, Compression, Decompress, FlushDecompress, Status};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::engine::{engine_for_game, ModEngineConfig};
use super::host_mods::parse_host_location;
use super::naming::strip_priority_prefix;
use super::profiles::Profile;
use super::types::InstalledMod;
use crate::commands::loaders::{scoped_bindings, DetectStrategy};
use crate::commands::sources;

#[path = "share_import.rs"]
pub(super) mod import;

#[path = "share_preview.rs"]
pub(super) mod preview;

const FORMAT: &str = "modrex-profile";
const SCHEMA_VERSION: u32 = 1;
const CODE_PREFIX: &str = "MRX:";
const MAX_CODE_BYTES: usize = 12 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_MEMBERS: usize = 10_000;
const MAX_FOLDERS: usize = 2_000;
const MAX_DEPTH: usize = 32;
const MAX_TEXT_BYTES: usize = 1_024;
const MAX_SELECTOR_BYTES: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileShare {
    format: String,
    schema_version: u32,
    game_id: String,
    profile_name: String,
    root: Vec<ShareChild>,
    folders: Vec<ShareFolder>,
    members: Vec<ShareMember>,
    loaders: Option<Vec<String>>,
}

/// Each key is the one-based position in the share's folders or members array.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
enum ShareChild {
    Folder(usize),
    Mod(usize),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareFolder {
    name: String,
    children: Vec<ShareChild>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareMember {
    file: ShareFile,
    enabled: bool,
    folder: Option<usize>,
    priority: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    archive_member: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host_pack_set: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    installed_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "source",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ShareFile {
    ModWorkshop {
        mod_id: u32,
        // None when the mod was matched to its page but not to one of its files.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    Nexus {
        mod_id: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<u32>,
    },
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportedProfileShare {
    file_text: String,
    paste_code: String,
    left_out: usize,
}

fn catalog_file(game_id: &str, record: &InstalledMod) -> Option<ShareFile> {
    sources::native_id(&record.source, game_id)?;
    let mod_id = record
        .remote_id
        .as_deref()?
        .parse::<u32>()
        .ok()
        .filter(|id| *id > 0)?;
    match record.source.as_str() {
        "modworkshop" => {
            // A link-only mod has a negative file id and no file to name.
            let file_id = record
                .file_id
                .and_then(|id| u32::try_from(id).ok())
                .filter(|id| *id > 0);
            Some(ShareFile::ModWorkshop {
                mod_id,
                file_id,
                file_name: record.workshop_file_name.clone(),
                label: record.workshop_file_label.clone(),
                version: (!record.version.is_empty()).then(|| record.version.clone()),
            })
        }
        "nexus" => {
            let file_id = match record.file_remote_id.as_deref() {
                Some(id) => Some(id.parse::<u32>().ok().filter(|id| *id > 0)?),
                None => None,
            };
            Some(ShareFile::Nexus { mod_id, file_id })
        }
        _ => None,
    }
}

/// A record's file or folder name without the load-order prefix or the disabled suffix, which
/// is what an archive entry or a reinstalled copy is matched against.
pub(super) fn installed_name(cfg: &ModEngineConfig, record: &InstalledMod) -> String {
    let target = cfg.mod_target(record);
    let name = record
        .filename
        .strip_suffix(target.disabled_suffix())
        .unwrap_or(&record.filename);
    if target.priority_prefix_enabled() {
        return strip_priority_prefix(name).to_string();
    }
    name.to_string()
}

pub(super) fn export(
    cfg: &ModEngineConfig,
    profile: &Profile,
    records: &[InstalledMod],
) -> Result<ExportedProfileShare, String> {
    let records: HashMap<_, _> = records.iter().map(|r| (r.install_id.as_str(), r)).collect();
    let keys: HashMap<_, _> = profile
        .folders
        .iter()
        .enumerate()
        .map(|(i, f)| (f.id.as_str(), i + 1))
        .collect();
    if keys.len() != profile.folders.len() {
        return Err("The profile has duplicate folder IDs".into());
    }
    let folder_key = |id: Option<&str>| {
        id.map(|id| {
            keys.get(id)
                .copied()
                .ok_or("The profile references a missing folder")
        })
        .transpose()
    };
    // Slot zero holds the root. The other slots use the same keys as folder children.
    let mut children = vec![Vec::new(); keys.len() + 1];
    let mut members = Vec::new();
    let mut left_out = 0;
    for m in &profile.members {
        let Some((record, file)) = records
            .get(m.install_id.as_str())
            .and_then(|r| catalog_file(cfg.game_id, r).map(|file| (*r, file)))
        else {
            left_out += 1;
            continue;
        };
        let target = cfg.mod_target(record);
        let host_pack_set = record
            .location
            .as_deref()
            .and_then(parse_host_location)
            .map(|_| record.filename.clone());
        let folder = folder_key(m.folder_id.as_deref())?;
        members.push(ShareMember {
            file,
            enabled: m.enabled,
            folder,
            priority: m.priority,
            archive_member: record.archive_member.clone(),
            host_pack_set,
            target: (cfg.targets.len() > 1).then(|| target.tag.to_string()),
            installed_name: installed_name(cfg, record),
        });
        children[folder.unwrap_or(0)]
            .push((m.priority.unwrap_or(0), ShareChild::Mod(members.len())));
    }
    for (i, folder) in profile.folders.iter().enumerate() {
        let parent = folder_key(folder.parent_id.as_deref())?.unwrap_or(0);
        children[parent].push((folder.priority, ShareChild::Folder(i + 1)));
    }
    let mut ordered = children.into_iter().map(|mut entries| {
        entries.sort_by_key(|(priority, _)| Reverse(*priority));
        entries.into_iter().map(|(_, child)| child).collect()
    });
    let root = ordered.next().expect("slot zero holds the root");
    let folders = profile
        .folders
        .iter()
        .zip(ordered)
        .map(|(f, children)| ShareFolder {
            name: f.display_name.clone(),
            children,
        })
        .collect();
    let share = ProfileShare {
        format: FORMAT.into(),
        schema_version: SCHEMA_VERSION,
        game_id: cfg.game_id.into(),
        profile_name: profile.name.clone(),
        root,
        folders,
        members,
        loaders: profile.loaders.clone(),
    };
    share.validate()?;
    let file_text = serde_json::to_string(&share).map_err(|e| e.to_string())?;
    if file_text.len() > MAX_JSON_BYTES {
        return Err("Profile JSON exceeds the byte limit".into());
    }
    let paste_code = encode(file_text.as_bytes())?;
    Ok(ExportedProfileShare {
        file_text,
        paste_code,
        left_out,
    })
}

fn text(value: &str, limit: usize) -> Result<(), String> {
    if value.len() > limit || value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err("Invalid or oversized profile text".into());
    }
    Ok(())
}

fn basename(value: &str) -> Result<(), String> {
    text(value, MAX_TEXT_BYTES)?;
    if value.contains(['/', '\\', ':']) || matches!(value, "." | "..") {
        return Err("A file or set name must be a single name".into());
    }
    Ok(())
}

fn archive_selector(value: &str) -> Result<String, String> {
    text(value, MAX_SELECTOR_BYTES)?;
    if value.starts_with(['/', '\\']) || value.contains(':') {
        return Err("Invalid relative archive member".into());
    }
    let parts: Vec<_> = value
        .split(['/', '\\'])
        .filter(|p| !matches!(*p, "" | "."))
        .collect();
    if parts.is_empty() || parts.iter().any(|p| p.trim_end_matches(' ') == "..") {
        return Err("Invalid relative archive member".into());
    }
    // Repeated entries compare by their relative components. The share retains the
    // original spelling so a picker can match the exact name in the downloaded archive.
    Ok(parts.join("/"))
}

impl ProfileShare {
    fn validate(&self) -> Result<(), String> {
        if self.format != FORMAT || self.schema_version != SCHEMA_VERSION {
            return Err("Unsupported profile share format or schema version".into());
        }
        if self.members.len() > MAX_MEMBERS || self.folders.len() > MAX_FOLDERS {
            return Err("Too many profile members or folders".into());
        }
        text(&self.game_id, MAX_TEXT_BYTES)?;
        let cfg = engine_for_game(&self.game_id)?;
        text(&self.profile_name, MAX_TEXT_BYTES)?;
        let mut loose: HashSet<_> = scoped_bindings()
            .into_iter()
            .filter(|(game, spec, _)| {
                *game == cfg.game_id
                    && matches!(
                        spec.detect,
                        DetectStrategy::RootFiles(_) | DetectStrategy::Ue4ssProxy
                    )
            })
            .map(|(_, spec, _)| spec.id)
            .collect();
        if self
            .loaders
            .iter()
            .flatten()
            .any(|id| !loose.remove(id.as_str()))
        {
            return Err("Unknown or duplicate loose loader for this game".into());
        }
        let mut seen = HashSet::new();
        for m in &self.members {
            let file = m.file.validate(cfg.game_id)?;
            let target = m.target.as_deref().unwrap_or(cfg.primary().tag);
            if !cfg.targets.iter().any(|t| t.tag == target) {
                return Err("Unknown install target for this game".into());
            }
            basename(&m.installed_name)?;
            if let Some(set) = &m.host_pack_set {
                basename(set)?;
            }
            let selector = match &m.archive_member {
                Some(path) => archive_selector(path)?,
                None => m
                    .host_pack_set
                    .as_ref()
                    .unwrap_or(&m.installed_name)
                    .clone(),
            };
            if !seen.insert((file, target, selector, m.host_pack_set.as_deref())) {
                return Err("Duplicate profile member".into());
            }
        }
        self.validate_tree()
    }

    fn validate_tree(&self) -> Result<(), String> {
        let mut folders = HashSet::new();
        let mut members = HashSet::new();
        let mut pending = vec![(None, 0, &self.root)];
        while let Some((parent, depth, children)) = pending.pop() {
            for child in children {
                match *child {
                    ShareChild::Folder(key) => {
                        let folder = key
                            .checked_sub(1)
                            .and_then(|i| self.folders.get(i))
                            .ok_or("Unknown folder key")?;
                        if !folders.insert(key) {
                            return Err("Repeated folder or folder cycle".into());
                        }
                        if depth == MAX_DEPTH {
                            return Err("Folder tree exceeds the depth limit".into());
                        }
                        text(&folder.name, MAX_TEXT_BYTES)?;
                        pending.push((Some(key), depth + 1, &folder.children));
                    }
                    ShareChild::Mod(key) => {
                        let member = key
                            .checked_sub(1)
                            .and_then(|i| self.members.get(i))
                            .ok_or("Unknown member key")?;
                        if !members.insert(key) || member.folder != parent {
                            return Err("Repeated or misplaced profile member".into());
                        }
                    }
                }
            }
        }
        if folders.len() != self.folders.len() || members.len() != self.members.len() {
            return Err("The profile tree contains unreachable folders or members".into());
        }
        Ok(())
    }
}

impl ShareFile {
    fn validate(&self, game_id: &str) -> Result<(&'static str, u32, Option<u32>), String> {
        let (source, mod_id, file_id) = match self {
            Self::ModWorkshop {
                mod_id,
                file_id,
                file_name,
                label,
                version,
            } => {
                if let Some(name) = file_name {
                    basename(name)?;
                }
                for hint in [label, version].into_iter().flatten() {
                    text(hint, MAX_TEXT_BYTES)?;
                }
                ("modworkshop", *mod_id, *file_id)
            }
            Self::Nexus { mod_id, file_id } => ("nexus", *mod_id, *file_id),
        };
        if mod_id == 0 || file_id == Some(0) || sources::native_id(source, game_id).is_none() {
            return Err("Invalid catalog reference for this game".into());
        }
        Ok((source, mod_id, file_id))
    }
}

fn encode(json: &[u8]) -> Result<String, String> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(json).map_err(|e| e.to_string())?;
    let bytes = encoder.finish().map_err(|e| e.to_string())?;
    Ok(format!("{CODE_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn inflate(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = Decompress::new(false);
    let mut json = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let start = decoder.total_in() as usize;
        let limit = buffer.len().min(MAX_JSON_BYTES + 1 - json.len());
        let status = decoder
            .decompress(&input[start..], &mut buffer[..limit], FlushDecompress::None)
            .map_err(|e| format!("Invalid compressed profile: {e}"))?;
        let total = decoder.total_out() as usize;
        if total > MAX_JSON_BYTES {
            return Err("Inflated profile exceeds the byte limit".into());
        }
        let written = total - json.len();
        json.extend_from_slice(&buffer[..written]);
        if status == Status::StreamEnd && decoder.total_in() as usize == input.len() {
            return Ok(json);
        }
        if status == Status::StreamEnd || (written == 0 && start == decoder.total_in() as usize) {
            return Err("Incomplete compressed profile or trailing data".into());
        }
    }
}

impl ExportedProfileShare {
    pub(super) fn into_file(self) -> (String, usize) {
        (self.file_text, self.left_out)
    }
}

/// Reads a share file the user picked, refusing one too large to be a share before reading it.
pub(super) fn read_file(path: &std::path::Path) -> Result<String, String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("Could not read the profile file: {e}"))?
        .len();
    if size > MAX_JSON_BYTES as u64 {
        return Err("Profile JSON exceeds the byte limit".into());
    }
    std::fs::read_to_string(path).map_err(|e| format!("Could not read the profile file: {e}"))
}

pub(super) fn parse(input: &str) -> Result<ProfileShare, String> {
    let inflated;
    let json = if let Some(code) = input.strip_prefix(CODE_PREFIX) {
        if input.len() > MAX_CODE_BYTES {
            return Err("Profile code exceeds the byte limit".into());
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(code)
            .map_err(|e| format!("Invalid profile code: {e}"))?;
        inflated = inflate(&bytes)?;
        inflated.as_slice()
    } else {
        if input.len() > MAX_JSON_BYTES {
            return Err("Profile JSON exceeds the byte limit".into());
        }
        input.as_bytes()
    };
    let share: ProfileShare =
        serde_json::from_slice(json).map_err(|e| format!("Invalid profile JSON: {e}"))?;
    share.validate()?;
    Ok(share)
}

#[cfg(test)]
#[path = "share_tests.rs"]
mod tests;
