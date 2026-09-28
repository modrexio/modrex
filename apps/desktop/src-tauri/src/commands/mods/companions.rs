use super::engine::{backup_dir, ModEngineConfig, ModUnit, ScanTarget};
use super::identify::hash_file;
use super::moves::Moves;
use super::naming::{install_file_id, log_name, sidecar_path, strip_priority_prefix};
use super::paths::{disabled_base, installed_mod_path, mods_base};
use super::state::get_folder_path;
use super::types::{InstalledMod, ModFolder};
use crate::commands::mod_index;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Companion files sharing one stem in one directory.
pub(crate) struct CompanionSet {
    pub dir: PathBuf,
    pub stem: String,
    pub disabled: bool,
    pub files: Vec<(&'static str, PathBuf)>,
}

impl CompanionSet {
    fn key(&self) -> (PathBuf, String, bool) {
        (self.dir.clone(), self.stem.clone(), self.disabled)
    }
}

struct Scan {
    sets: Vec<CompanionSet>,
    paks: HashSet<(PathBuf, String, bool)>,
}

/// Every pak and companion set of a file target, active and disabled. Only the canonical
/// forms count: unsuffixed in the active tree, suffixed in the disabled one.
fn scan(game_path: &str, target: &ScanTarget) -> Scan {
    let mut scan = Scan {
        sets: Vec::new(),
        paks: HashSet::new(),
    };
    let ModUnit::File {
        extension,
        disabled_suffix,
        ..
    } = &target.unit
    else {
        return scan;
    };
    let mut by_key: HashMap<(PathBuf, String, bool), usize> = HashMap::new();
    let mut files = Vec::new();
    walk(&mods_base(game_path, target), true, &mut files);
    let mut disabled_files = Vec::new();
    walk(
        &disabled_base(game_path, target),
        false,
        &mut disabled_files,
    );

    for (path, disabled) in files
        .into_iter()
        .map(|p| (p, false))
        .chain(disabled_files.into_iter().map(|p| (p, true)))
    {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let name = match name.strip_suffix(disabled_suffix) {
            Some(stripped) if disabled => stripped,
            None if !disabled => name,
            Some(_) if !disabled && disabled_suffix.is_empty() => name,
            _ => continue,
        };
        let Some(dir) = path.parent().map(Path::to_path_buf) else {
            continue;
        };
        if let Some(stem) = name.strip_suffix(&format!(".{extension}")) {
            scan.paks.insert((dir, stem.to_string(), disabled));
            continue;
        }
        let Some((ext, stem)) = target
            .companions
            .iter()
            .find_map(|c| name.strip_suffix(&format!(".{c}")).map(|stem| (*c, stem)))
        else {
            continue;
        };
        let key = (dir.clone(), stem.to_string(), disabled);
        let index = *by_key.entry(key).or_insert_with(|| {
            scan.sets.push(CompanionSet {
                dir,
                stem: stem.to_string(),
                disabled,
                files: Vec::new(),
            });
            scan.sets.len() - 1
        });
        scan.sets[index].files.push((ext, path));
    }
    scan
}

/// Collects every file under dir. The top-level disabled folder is the disabled tree, walked
/// on its own, exactly as the untracked scan treats it.
fn walk(dir: &Path, skip_disabled: bool, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("companions: read {}: {e}", log_name(dir));
            return;
        }
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if skip_disabled && entry.file_name() == "disabled" {
                continue;
            }
            walk(&path, false, out);
        } else if file_type.is_file() {
            out.push(path);
        }
    }
}

fn orphans(scan: &Scan) -> Vec<&CompanionSet> {
    scan.sets
        .iter()
        .filter(|set| !scan.paks.contains(&set.key()))
        .collect()
}

/// Puts back together a tracked pak and the .ucas and .utoc an earlier reorder left under its
/// old priority prefix, where the game never mounts them. Only a pair that cannot be anything
/// else is rejoined: one record of that published name missing all its companions, and every
/// leftover copy of that name byte-identical. Other copies stay where they are as leftovers.
pub(crate) fn rejoin_split_companions(
    game_path: &str,
    cfg: &ModEngineConfig,
    folders: &[ModFolder],
    mods: &[InstalledMod],
    index: Option<&rusqlite::Connection>,
) -> usize {
    let mut rejoined = 0;
    for target in cfg.targets {
        let ModUnit::File { extension, .. } = &target.unit else {
            continue;
        };
        if target.companions.is_empty() || backup_dir(game_path, target).exists() {
            continue;
        }
        let scan = scan(game_path, target);
        let orphans = orphans(&scan);
        if orphans.is_empty() {
            continue;
        }

        let mut needy: HashMap<&str, Vec<(&InstalledMod, PathBuf)>> = HashMap::new();
        for m in mods {
            if !std::ptr::eq(cfg.target_for(m.location.as_deref()), target)
                || m.location
                    .as_deref()
                    .is_some_and(|l| l.starts_with("host:"))
            {
                continue;
            }
            let Some(stem) = m.filename.strip_suffix(&format!(".{extension}")) else {
                continue;
            };
            let rel = get_folder_path(folders, m.folder_id.as_deref());
            let pak = installed_mod_path(game_path, &m.filename, rel.as_deref(), target, m.enabled);
            if !pak.is_file() {
                continue;
            }
            let has_companion = target
                .companions
                .iter()
                .any(|c| sidecar_path(&pak, extension, c).is_some_and(|p| p.exists()));
            if !has_companion {
                needy
                    .entry(strip_priority_prefix(stem))
                    .or_default()
                    .push((m, pak));
            }
        }

        for (base, records) in needy {
            let candidates: Vec<&CompanionSet> = orphans
                .iter()
                .copied()
                .filter(|set| strip_priority_prefix(&set.stem) == base)
                .collect();
            if candidates.is_empty() {
                continue;
            }
            let [(m, pak)] = records.as_slice() else {
                log::debug!(
                    "companions: {base} is missing companions in more than one mod, left alone"
                );
                continue;
            };
            if !all_identical(&candidates) {
                log::debug!("companions: the leftover copies of {base} differ, left alone");
                continue;
            }
            let chosen = pick(candidates, pak, !m.enabled);
            if index_disagrees(index, cfg, m, chosen, target.companions) {
                log::debug!(
                    "companions: the index says {} belongs to another file than {}, left alone",
                    chosen.stem,
                    m.filename
                );
                continue;
            }
            let mut moves = Moves::default();
            for (ext, from) in &chosen.files {
                let Some(to) = sidecar_path(pak, extension, ext) else {
                    continue;
                };
                moves.path(from.clone(), to);
            }
            match moves.run() {
                Ok(_) => {
                    log::info!(
                        "companions: rejoined {} with {}",
                        chosen.stem,
                        log_name(pak)
                    );
                    rejoined += 1;
                }
                Err(e) => log::warn!("companions: rejoining {}: {e}", log_name(pak)),
            }
        }
    }
    rejoined
}

fn all_identical(sets: &[&CompanionSet]) -> bool {
    let Some((first, rest)) = sets.split_first() else {
        return true;
    };
    if rest.is_empty() {
        return true;
    }
    let extensions = |set: &CompanionSet| -> Vec<&'static str> {
        let mut exts: Vec<_> = set.files.iter().map(|(ext, _)| *ext).collect();
        exts.sort();
        exts
    };
    let first_exts = extensions(first);
    if rest.iter().any(|set| extensions(set) != first_exts) {
        return false;
    }
    first_exts.iter().all(|ext| {
        let paths: Vec<&PathBuf> = sets
            .iter()
            .filter_map(|set| set.files.iter().find(|(e, _)| e == ext).map(|(_, p)| p))
            .collect();
        same_bytes(&paths)
    })
}

fn same_bytes(paths: &[&PathBuf]) -> bool {
    let sizes: HashSet<Option<u64>> = paths
        .iter()
        .map(|p| fs::metadata(p).ok().map(|m| m.len()))
        .collect();
    if sizes.len() != 1 || sizes.contains(&None) {
        return false;
    }
    let mut hashes = HashSet::new();
    for path in paths {
        match hash_file(path) {
            Ok(Some(hash)) => {
                hashes.insert(hash);
            }
            Ok(None) => return false,
            Err(e) => {
                log::warn!("companions: reading {}: {e}", log_name(path));
                return false;
            }
        }
    }
    hashes.len() == 1
}

fn pick<'a>(mut candidates: Vec<&'a CompanionSet>, pak: &Path, disabled: bool) -> &'a CompanionSet {
    let pak_dir = pak.parent();
    candidates.sort_by_key(|set| {
        (
            Some(set.dir.as_path()) != pak_dir,
            set.disabled != disabled,
            set.dir.clone(),
            set.stem.clone(),
        )
    });
    candidates[0]
}

/// A published name is not proof of ownership: two mods can ship containers of one name. When
/// the index knows the companions of the file this record was installed from, a set that
/// matches none of them belongs to some other mod. Only ModWorkshop file ids are in the index.
fn index_disagrees(
    index: Option<&rusqlite::Connection>,
    cfg: &ModEngineConfig,
    m: &InstalledMod,
    set: &CompanionSet,
    companions: &[&str],
) -> bool {
    let Some(conn) = index else {
        return false;
    };
    if m.source != "modworkshop" {
        return false;
    }
    let file_ids: Vec<i64> = [m.file_id, install_file_id(&m.uid)]
        .into_iter()
        .flatten()
        .collect();
    let known = match mod_index::companion_hashes_for_files(
        conn,
        &file_ids,
        cfg.index_game_name,
        companions,
    ) {
        Ok(known) => known,
        Err(e) => {
            log::warn!("companions: index lookup for {}: {e}", m.filename);
            return false;
        }
    };
    if known.is_empty() {
        return false;
    }
    let mut files: Vec<&PathBuf> = set.files.iter().map(|(_, p)| p).collect();
    files.sort_by_key(|p| fs::metadata(p).map(|m| m.len()).unwrap_or(u64::MAX));
    !files
        .into_iter()
        .any(|p| matches!(hash_file(p), Ok(Some(hash)) if known.contains(&hash)))
}

#[cfg(test)]
#[path = "companions_tests.rs"]
mod tests;
