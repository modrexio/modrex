use super::crimeboss_settings::content_path_for_mod;
use super::engine::{
    backup_dir as engine_backup_dir, disabled_dir, mods_dir, state_path as engine_state_path,
    ModEngineConfig, ModUnit, ScanTarget,
};
use super::host_mods::{host_target_by_id, parse_host_location, HOST_TARGETS};
use super::state::get_folder_path;
use super::types::{InstalledMod, ModFolder};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Resolves the on-disk directory of an installed host mod (e.g. Menu Backgrounds), looked
/// up by its modworkshop id in the current state: its active dir if present, else its
/// disabled dir, else the host's conventional folder name directly under the primary
/// target. None when the host mod is not installed.
pub fn resolve_host_mod_dir(
    game_path: &str,
    cfg: &ModEngineConfig,
    mods: &[InstalledMod],
    folders: &[ModFolder],
    host_id: i64,
) -> Option<PathBuf> {
    let host_id_str = host_id.to_string();
    if let Some(h) = mods
        .iter()
        .find(|h| h.remote_id.as_deref() == Some(host_id_str.as_str()) && h.location.is_none())
    {
        let rel = get_folder_path(folders, h.folder_id.as_deref());
        let active = active_mod_path(game_path, &h.filename, rel.as_deref(), cfg.primary());
        if active.exists() {
            return Some(active);
        }
        let disabled = disabled_mod_path(game_path, &h.filename, rel.as_deref(), cfg.primary());
        if disabled.exists() {
            return Some(disabled);
        }
    }
    let name = host_target_by_id(host_id)?.host_name;
    let cand = mods_dir(game_path, cfg.primary()).join(name);
    cand.exists().then_some(cand)
}

/// The on-disk directory where a host-pack mod (a host:<id>:<subpath> location) lives,
/// namely <host mod dir>/<subpath>/<filename>. None for non-host mods or an absent host.
pub fn host_pack_dir(
    game_path: &str,
    cfg: &ModEngineConfig,
    mods: &[InstalledMod],
    folders: &[ModFolder],
    m: &InstalledMod,
) -> Option<PathBuf> {
    let (host_id, subpath) = parse_host_location(m.location.as_deref()?)?;
    let mut p = resolve_host_mod_dir(game_path, cfg, mods, folders, host_id)?;
    for seg in subpath.split('/').filter(|s| !s.is_empty()) {
        p = p.join(seg);
    }
    Some(p.join(&m.filename))
}

/// Discovers host-pack set folders on disk that are not tracked in mods, the orphans left
/// after a state rebuild (host packs live inside another mod, so the normal scan cannot
/// find them). Returns (host_mod_id, subpath, set_name, enabled, dir) per untracked set,
/// scanning the host's active subfolder and the Modrex disabled area. Excludes the host's
/// bundled defaults, already-tracked sets, and hosts whose mod is not installed.
pub fn find_untracked_host_packs(
    game_path: &str,
    cfg: &ModEngineConfig,
    mods: &[InstalledMod],
    folders: &[ModFolder],
) -> Vec<(i64, String, String, bool, PathBuf)> {
    let mut out = Vec::new();
    for host in HOST_TARGETS {
        let Some(host_dir) = resolve_host_mod_dir(game_path, cfg, mods, folders, host.host_mod_id)
        else {
            continue;
        };
        let tracked: HashSet<String> = mods
            .iter()
            .filter(|m| {
                m.location
                    .as_deref()
                    .and_then(parse_host_location)
                    .is_some_and(|(id, _)| id == host.host_mod_id)
            })
            .map(|m| m.filename.clone())
            .collect();

        let active = host.subpath.iter().fold(host_dir, |p, s| p.join(s));
        let disabled =
            disabled_dir(game_path, cfg.primary()).join(format!("host-{}", host.host_mod_id));
        let subpath = host.subpath.join("/");

        for (base, enabled) in [(active, true), (disabled, false)] {
            let Ok(rd) = std::fs::read_dir(&base) else {
                continue;
            };
            for entry in rd.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if host.bundled.iter().any(|b| *b == name) || tracked.contains(&name) {
                    continue;
                }
                out.push((
                    host.host_mod_id,
                    subpath.clone(),
                    name,
                    enabled,
                    entry.path(),
                ));
            }
        }
    }
    out
}

/// The Modrex-managed disabled location for a host pack, outside the host mod so the host
/// stops loading it: <primary disabled dir>/host-<id>/<filename>. None for non-host mods.
pub fn host_pack_disabled_dir(
    game_path: &str,
    cfg: &ModEngineConfig,
    m: &InstalledMod,
) -> Option<PathBuf> {
    let (host_id, _) = parse_host_location(m.location.as_deref()?)?;
    Some(
        disabled_dir(game_path, cfg.primary())
            .join(format!("host-{host_id}"))
            .join(&m.filename),
    )
}

pub fn mods_base(game_path: &str, target: &ScanTarget) -> PathBuf {
    mods_dir(game_path, target)
}

pub fn disabled_base(game_path: &str, target: &ScanTarget) -> PathBuf {
    disabled_dir(game_path, target)
}

pub fn get_state_path(game_path: &str, cfg: &ModEngineConfig) -> PathBuf {
    engine_state_path(game_path, cfg)
}

pub fn active_mod_path(
    game_path: &str,
    filename: &str,
    folder_rel: Option<&str>,
    target: &ScanTarget,
) -> PathBuf {
    match folder_rel {
        Some(rel) => mods_dir(game_path, target).join(rel).join(filename),
        None => mods_dir(game_path, target).join(filename),
    }
}

pub fn disabled_mod_path(
    game_path: &str,
    filename: &str,
    folder_rel: Option<&str>,
    target: &ScanTarget,
) -> PathBuf {
    let base = match folder_rel {
        Some(rel) => disabled_dir(game_path, target).join(rel),
        None => disabled_dir(game_path, target),
    };
    match &target.unit {
        ModUnit::File {
            disabled_suffix, ..
        } => base.join(format!("{}{}", filename, disabled_suffix)),
        ModUnit::Directory { .. } => base.join(filename),
    }
}

pub(crate) fn resolve_pak_path(
    game_path: &str,
    cfg: &ModEngineConfig,
    folders: &[ModFolder],
    m: &InstalledMod,
) -> Option<PathBuf> {
    let location = m.location.as_deref();
    if location == Some("ue4ss_mods") || location.is_some_and(|value| value.starts_with("host:")) {
        return None;
    }

    let target = cfg.target_for(location);
    // The extension the target declares, so this never assumes a game packages as .pak.
    let extension = target.content_extension()?;
    let folder = get_folder_path(folders, m.folder_id.as_deref());
    let active = active_mod_path(game_path, &m.filename, folder.as_deref(), target);
    let installed = if active.exists() {
        active
    } else {
        let disabled = disabled_mod_path(game_path, &m.filename, folder.as_deref(), target);
        disabled.exists().then_some(disabled)?
    };
    content_path_for_mod(&installed, target.is_directory_unit(), extension)
}

pub async fn find_untracked_paks(
    game_path: &str,
    known: &HashSet<String>,
    cfg: &ModEngineConfig,
) -> Vec<(String, bool, Option<String>)> {
    let mut out = Vec::new();
    for (i, target) in cfg.targets.iter().enumerate() {
        if engine_backup_dir(game_path, target).exists() {
            continue;
        }
        let tag = if i == 0 { "" } else { target.tag };
        let tag_prefix = format!("{}:", tag);
        let target_known: HashSet<String> = known
            .iter()
            .filter_map(|k| k.strip_prefix(&tag_prefix).map(|s| s.to_string()))
            .collect();
        let location_tag: Option<String> = (i != 0).then(|| target.tag.to_string());
        // mods/base is the BLT loader's basemod, not a user mod. Tracking it would let
        // the user disable their mod loader from the installed list.
        let skip_base = i == 0 && matches!(target.unit, ModUnit::Directory { .. });
        let mut target_out: Vec<(String, bool)> = Vec::new();
        scan_active(
            &mods_dir(game_path, target),
            "",
            &target_known,
            target,
            skip_base,
            &mut target_out,
        )
        .await;
        scan_disabled(
            &disabled_dir(game_path, target),
            "",
            &target_known,
            target,
            &mut target_out,
        )
        .await;
        for (path, enabled) in target_out {
            out.push((path, enabled, location_tag.clone()));
        }
    }
    out
}

async fn scan_active(
    dir: &Path,
    prefix: &str,
    known: &HashSet<String>,
    target: &ScanTarget,
    skip_base: bool,
    out: &mut Vec<(String, bool)>,
) {
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut subdirs = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if prefix.is_empty() && (name == "disabled" || (skip_base && name == "base")) {
            continue;
        }
        let ft = match entry.file_type().await {
            Ok(t) => t,
            Err(_) => continue,
        };
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", prefix, name)
        };
        match &target.unit {
            ModUnit::File { extension, .. } => {
                if ft.is_dir() {
                    subdirs.push((entry.path(), rel));
                } else if name.ends_with(&format!(".{extension}")) && !known.contains(&rel) {
                    out.push((rel, true));
                }
            }
            ModUnit::Directory {
                scan_markers,
                index_gated_markers,
                excluded_names,
                ..
            } => {
                if ft.is_dir() {
                    if excluded_names.contains(&name.as_str()) {
                        continue;
                    }
                    let is_mod = (scan_markers.is_empty() && index_gated_markers.is_empty())
                        || scan_markers.iter().any(|m| entry.path().join(m).exists())
                        || index_gated_markers
                            .iter()
                            .any(|m| entry.path().join(m).exists());
                    if !is_mod {
                        subdirs.push((entry.path(), rel));
                    } else if !known.contains(&rel) {
                        out.push((rel, true));
                    }
                }
            }
        }
    }
    for (path, sub) in subdirs {
        Box::pin(scan_active(&path, &sub, known, target, skip_base, out)).await;
    }
}

async fn scan_disabled(
    dir: &Path,
    prefix: &str,
    known: &HashSet<String>,
    target: &ScanTarget,
    out: &mut Vec<(String, bool)>,
) {
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut subdirs = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type().await {
            Ok(t) => t,
            Err(_) => continue,
        };
        let sub = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", prefix, name)
        };
        match &target.unit {
            ModUnit::File {
                extension,
                disabled_suffix,
                ..
            } => {
                if ft.is_dir() {
                    subdirs.push((entry.path(), sub));
                } else if name.ends_with(&format!(".{extension}{disabled_suffix}")) {
                    let active = name
                        .strip_suffix(disabled_suffix)
                        .expect("the suffix matched above")
                        .to_string();
                    let rel = if prefix.is_empty() {
                        active.clone()
                    } else {
                        format!("{}/{}", prefix, active)
                    };
                    if !known.contains(&rel) {
                        out.push((rel, false));
                    }
                }
            }
            ModUnit::Directory {
                scan_markers,
                index_gated_markers,
                excluded_names,
                ..
            } => {
                if ft.is_dir() {
                    if excluded_names.contains(&name.as_str()) {
                        continue;
                    }
                    let is_mod = (scan_markers.is_empty() && index_gated_markers.is_empty())
                        || scan_markers.iter().any(|m| entry.path().join(m).exists())
                        || index_gated_markers
                            .iter()
                            .any(|m| entry.path().join(m).exists());
                    if !is_mod {
                        subdirs.push((entry.path(), sub));
                    } else if !known.contains(&sub) {
                        out.push((sub, false));
                    }
                }
            }
        }
    }
    for (path, sub) in subdirs {
        Box::pin(scan_disabled(&path, &sub, known, target, out)).await;
    }
}
