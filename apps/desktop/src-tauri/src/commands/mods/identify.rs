//! Mod identification for get_installed: maps untracked and unidentified on-disk mods back
//! to their modworkshop identity via SHA256 index lookup, embedded BeardLib ids, and name
//! matching. The command surface in mod.rs orchestrates these helpers.

use super::crimeboss_settings;
use super::engine;
use super::*;
use crate::commands::mod_index;
use chrono::Utc;
use std::collections::HashMap;
use tauri::AppHandle;
use uuid::Uuid;

/// The representative file of a mod that ships no marker: the one whose path relative to the
/// mod folder sorts first by UTF-8 bytes. The indexer chooses the same file from the archive by
/// the same rule, and the two are tested against one set of vectors
/// (apps/index/marker-contract.json). Any other ordering disagrees somewhere - a
/// directory-by-directory walk on the boundary between a file and a folder sharing its stem, a
/// locale-aware comparison on punctuation - and a mod whose two sides disagree can never be
/// identified by hash.
fn first_file_in_dir(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut relative = Vec::new();
    collect_relative_files(dir, "", &mut relative);
    relative.sort();
    relative.first().map(|path| dir.join(path))
}

fn collect_relative_files(dir: &std::path::Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        // A name the filesystem holds outside UTF-8 cannot equal an archive entry, which is
        // UTF-8 by definition, so a lossy name here can only ever fail to match.
        let name = entry.file_name().to_string_lossy().into_owned();
        // Explorer and Finder write these into a folder on their own, and they sort early
        // enough to win the pick, but the copy here is rewritten locally and stops matching the
        // archive the indexer read.
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "thumbs.db" | "desktop.ini" | ".ds_store"
        ) {
            continue;
        }
        let path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => collect_relative_files(&entry.path(), &path, out),
            Ok(kind) if kind.is_file() => out.push(path),
            _ => {}
        }
    }
}

/// Recursively finds a .pak file inside dir, preferring it over first_file_in_dir's
/// alphabetical-first pick. Crime Boss's Mods/<name>/ can have a sibling Config/ folder
/// (custom gameplay tags) that sorts before Content/, and without this, identification
/// would hash an .ini instead of the .pak the index records a SHA256 for.
fn first_pak_file_in_dir(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut entries: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in &entries {
        if entry.file_type().ok()?.is_file()
            && entry.file_name().to_string_lossy().ends_with(".pak")
        {
            return Some(entry.path());
        }
    }
    for entry in &entries {
        if entry.file_type().ok()?.is_dir() {
            if let Some(p) = first_pak_file_in_dir(&entry.path()) {
                return Some(p);
            }
        }
    }
    None
}

pub(crate) fn hashable_file_for_mod_dir(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    // Marker preference mirrors the indexer's chooseMarker so both sides hash the same
    // representative file: main.xml (BeardLib), then RAID's supermod.xml (RAID-SuperBLT) and
    // mod.xml (legacy RaidBLT). The marker-less fallback below is the other half of that
    // contract, tested against apps/index/marker-contract.json.
    for marker in ["main.xml", "supermod.xml", "mod.xml"] {
        let p = dir.join(marker);
        if p.exists() {
            return Some(p);
        }
    }
    first_pak_file_in_dir(dir).or_else(|| first_file_in_dir(dir))
}

/// Reads the value of an XML attribute (name="value" or name='value') from a single
/// element's text, matching the attribute name case-insensitively. A lightweight scanner
/// avoids pulling in a full XML parser for the one element that matters here.
fn xml_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{}=", name.to_ascii_lowercase());
    let mut from = 0;
    while let Some(rel) = lower[from..].find(&needle) {
        let at = from + rel;
        // Require a boundary before the name so id= does not match inside someid=.
        let boundary = at == 0 || !lower.as_bytes()[at - 1].is_ascii_alphanumeric();
        let eq = at + needle.len();
        let bytes = tag.as_bytes();
        if boundary && eq < bytes.len() && (bytes[eq] == b'"' || bytes[eq] == b'\'') {
            let quote = bytes[eq] as char;
            let start = eq + 1;
            if let Some(end) = tag[start..].find(quote) {
                return Some(&tag[start..start + end]);
            }
        }
        from = eq;
    }
    None
}

/// Scans xml for elements whose name starts with tag_name and returns the first one whose
/// provider is modworkshop (the default when omitted) and whose id_attr parses as a positive
/// id, along with the element's own version attribute if present.
fn embedded_id_from_tag(xml: &str, tag_name: &str, id_attr: &str) -> Option<(i64, Option<String>)> {
    let lower = xml.to_ascii_lowercase();
    let needle = format!("<{}", tag_name);
    let mut from = 0;
    while let Some(rel) = lower[from..].find(&needle) {
        let start = from + rel;
        let Some(close) = xml[start..].find('>') else {
            break;
        };
        let tag = &xml[start..start + close];
        from = start + close + 1;

        if let Some(provider) = xml_attr(tag, "provider") {
            if !provider.eq_ignore_ascii_case("modworkshop") {
                continue;
            }
        }
        let Some(id) = xml_attr(tag, id_attr).and_then(|v| v.trim().parse::<i64>().ok()) else {
            continue;
        };
        if id <= 0 {
            continue;
        }
        return Some((id, xml_attr(tag, "version").map(str::to_string)));
    }
    None
}

/// The version attribute of supermod.xml's root mod element. RAID-SuperBLT mods declare
/// their version there, not on the update element.
fn supermod_root_version(xml: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("<mod") {
        let start = from + rel;
        from = start + 4;
        if !xml[start + 4..].starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let close = xml[start..].find('>')?;
        return xml_attr(&xml[start..start + close], "version").map(str::to_string);
    }
    None
}

/// Returns the modworkshop mod id (and declared version, if present) a mod embeds in its
/// marker file. One format per BLT family, all verified against real downloads: BeardLib's
/// main.xml (AssetUpdates element, id + version attributes), RAID-SuperBLT's supermod.xml
/// (update element with an identifier attribute, version declared on the root mod element),
/// and legacy RaidBLT's mod.xml (auto_updates element, id + version attributes). The
/// provider defaults to modworkshop when omitted; any other provider is ignored. This
/// identity survives version drift, so it works even for very old installs.
pub(crate) fn embedded_modworkshop_id(dir: &std::path::Path) -> Option<(i64, Option<String>)> {
    if let Ok(xml) = std::fs::read_to_string(dir.join("main.xml")) {
        if let Some(hit) = embedded_id_from_tag(&xml, "assetupdates", "id") {
            return Some(hit);
        }
    }
    if let Ok(xml) = std::fs::read_to_string(dir.join("supermod.xml")) {
        if let Some((id, version)) = embedded_id_from_tag(&xml, "update", "identifier") {
            return Some((id, version.or_else(|| supermod_root_version(&xml))));
        }
    }
    if let Ok(xml) = std::fs::read_to_string(dir.join("mod.xml")) {
        if let Some(hit) = embedded_id_from_tag(&xml, "auto_updates", "id") {
            return Some(hit);
        }
    }
    None
}

// ── get_installed identification pipeline ──────────────────────────────────────

/// Upgrades unidentified entries whose SHA256 is now present in the index, e.g. a mod added
/// to the index after it was installed locally. Returns true if any entry was upgraded, and
/// the caller must persist that. This runs on every refresh, not just at first ambient
/// discovery: SHA256 is tried first because it pins the exact file, but once a mod's
/// modworkshop file is updated the installed bytes can never match again, leaving the name as
/// the only identity. Without the retry, a mod that missed both checks once, say against a
/// momentarily stale index, stays "Unknown" until the user wipes state by hand.
pub(crate) fn upgrade_negative_ids(
    app: &AppHandle,
    game_path: &str,
    cfg: &ModEngineConfig,
    folders: &[ModFolder],
    mods: &mut [InstalledMod],
) -> bool {
    let Some(conn) = mod_index::open_index(app, cfg.game_id) else {
        return false;
    };
    upgrade_negative_ids_with_conn(&conn, game_path, cfg, folders, mods)
}

// Split from upgrade_negative_ids so the identification logic is testable against an
// in-memory index, the same way mod_index.rs's own query helpers are.
pub(crate) fn upgrade_negative_ids_with_conn(
    conn: &rusqlite::Connection,
    game_path: &str,
    cfg: &ModEngineConfig,
    folders: &[ModFolder],
    mods: &mut [InstalledMod],
) -> bool {
    let game_name = cfg.index_game_name;
    let mut any = false;
    for m in mods {
        // remote_id is the one signal for "already identified", regardless of source or of
        // id's sign: id is an opaque, source-scoped key (see sources::source_native_local_id)
        // and never means "modworkshop" by being positive. An entry already carrying a
        // remote_id has one from its own source, so neither the exact SHA256 match below nor
        // the name fallback may reassign it to a modworkshop id. A byte-identical cross-posted
        // file is real, but merging its identity into modworkshop's desyncs it from the source
        // field that a Nexus card's badge and useModData's per-source refresh key off.
        if m.remote_id.is_some() {
            continue;
        }
        if let Some(hit) = m
            .sha256
            .as_deref()
            .and_then(|sha| mod_index::query_sha256(conn, sha, game_name))
        {
            m.attach_catalog(
                "modworkshop",
                hit.mod_remote_id.to_string(),
                IdentityEvidence::CatalogHash,
            );
            m.name = hit.mod_name;
            m.version = hit.version;
            m.file_id = Some(hit.file_remote_id);
            // The pass that failed to identify this entry left it Unknown, which makes
            // useModData skip it for updates forever. The hash match hands over the index's
            // own version, so the status has to move with it.
            m.update_status = UpdateStatus::Known;
            any = true;
            continue;
        }
        // m.name is the folder the mod sits in, which the author never chose for a mod
        // downloaded as a GitHub source archive. Falling back to the name mod.txt declares
        // costs one small read per still-unidentified mod and is what matches those installs.
        let by_stored_name = mod_index::query_by_name(conn, &m.name, game_name);
        let remote_id = by_stored_name.or_else(|| {
            let target = cfg.target_for(m.location.as_deref());
            if !target.is_directory_unit() {
                return None;
            }
            let rel = get_folder_path(folders, m.folder_id.as_deref());
            let dir = active_mod_path(game_path, &m.filename, rel.as_deref(), target);
            let dir = if dir.exists() {
                dir
            } else {
                disabled_mod_path(game_path, &m.filename, rel.as_deref(), target)
            };
            let declared = identity::local_signals(cfg, &dir).declared_name?;
            mod_index::query_by_name(conn, &declared, game_name)
        });
        if let Some(remote_id) = remote_id {
            m.attach_catalog(
                "modworkshop",
                remote_id.to_string(),
                IdentityEvidence::CatalogName,
            );
            // The SHA256 check above just failed against the index's current file, so unlike
            // the embedded-id "no declared version" fallback (zero signal, deliberately reads
            // as up-to-date to avoid an endless false nag), the installed bytes are known
            // stale here. "outdated" is never a real modworkshop version, so it reads as
            // different from the current one and surfaces the update instead of hiding it
            // behind useModData's "unknown version" suppression.
            m.version = String::new();
            m.update_status = UpdateStatus::Outdated;
            any = true;
        }
    }
    any
}

/// Re-groups negative-id entries whose name ends in " <number>" (a file-id suffix left by
/// fallback identification): when the base name matches a positively-identified tracked mod,
/// adopt that mod's id so all pak files from one mod group together in the UI.
pub(crate) fn regroup_negative_ids_by_name_suffix(mods: &mut [InstalledMod]) {
    let name_to_id: HashMap<String, i64> = mods
        .iter()
        .filter(|m| m.remote_id.is_some())
        .map(|m| (m.name.to_lowercase(), m.id))
        .collect();
    for m in mods.iter_mut() {
        if m.remote_id.is_some() {
            continue;
        }
        if let Some(pos) = m.name.rfind(' ') {
            let suffix = &m.name[pos + 1..];
            if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
                let base = m.name[..pos].to_lowercase();
                if let Some(&matched_id) = name_to_id.get(&base) {
                    m.id = matched_id;
                }
            }
        }
    }
}

/// Crime Boss mods can be toggled from the game's own Options > Mods screen, which writes
/// straight to Saved/ModSettings/<id>.json, and Modrex's tracked enabled flag, driven by which
/// folder the files sit in, has no way to learn about that. Re-reads the real value for every
/// tracked mod and corrects the flag where it disagrees. Returns true if anything changed, for
/// callers to fold into their existing save_state decision.
pub(crate) fn resync_crimeboss_enabled_flags(
    game_path: &str,
    cfg: &ModEngineConfig,
    folders: &[ModFolder],
    mods: &mut [InstalledMod],
    launcher: Option<&str>,
) -> bool {
    let mut changed = false;
    for m in mods.iter_mut() {
        if is_host_pack_location(m.location.as_deref()) {
            continue;
        }
        let target = cfg.target_for(m.location.as_deref());
        let rel = get_folder_path(folders, m.folder_id.as_deref());
        // Do not trust m.enabled to pick which location holds the file: it is exactly the
        // flag this function corrects, so on a second in-game toggle in a row it is already
        // stale relative to where the file sits. The in-game manager never moves files, only
        // this resync and Modrex's own enable and disable do. Check both.
        let active = active_mod_path(game_path, &m.filename, rel.as_deref(), target);
        let disabled = disabled_mod_path(game_path, &m.filename, rel.as_deref(), target);
        let path = if active.exists() {
            Some(active)
        } else if disabled.exists() {
            Some(disabled)
        } else {
            None
        };
        let Some(path) = path else { continue };
        if let Some(real_enabled) =
            crimeboss_settings::read_enabled(&path, target.is_directory_unit(), launcher)
        {
            if real_enabled != m.enabled {
                m.enabled = real_enabled;
                changed = true;
            }
        }
    }
    changed
}

fn is_host_pack_location(location: Option<&str>) -> bool {
    location.is_some_and(|l| l.starts_with("host:"))
}

/// Creates app folders for every directory segment in the untracked paths that does not yet
/// exist, pushing them onto state.folders. Returns the folder-path-to-id map used to place
/// reconciled and newly identified mods.
pub(crate) fn ensure_untracked_folders(
    state: &mut ModsState,
    untracked: &[(String, bool, Option<String>)],
) -> HashMap<String, String> {
    let mut folder_path_to_id: HashMap<String, String> = state
        .folders
        .iter()
        .filter_map(|f| get_folder_path(&state.folders, Some(&f.id)).map(|p| (p, f.id.clone())))
        .collect();

    let mut max_p = state
        .folders
        .iter()
        .map(|f| f.priority)
        .max()
        .unwrap_or(0)
        .max(
            state
                .mods
                .iter()
                .filter(|m| m.folder_id.is_none())
                .filter_map(|m| m.priority)
                .max()
                .unwrap_or(0),
        );

    for (rel_path, _, _) in untracked {
        let parts: Vec<&str> = rel_path.split('/').collect();
        if parts.len() <= 1 {
            continue;
        }
        let segs = &parts[..parts.len() - 1];
        let mut prefix = String::new();
        for (i, &seg) in segs.iter().enumerate() {
            prefix = if i == 0 {
                seg.to_string()
            } else {
                format!("{}/{}", prefix, seg)
            };
            if folder_path_to_id.contains_key(&prefix) {
                continue;
            }
            let parent_path = if i == 0 {
                None
            } else {
                Some(segs[..i].join("/"))
            };
            let parent_id = parent_path
                .as_deref()
                .and_then(|p| folder_path_to_id.get(p))
                .cloned();
            max_p += 1;
            let new_folder = ModFolder {
                id: Uuid::new_v4().to_string(),
                display_name: strip_priority_prefix(seg)
                    .replace('_', " ")
                    .trim()
                    .to_string(),
                disk_name: seg.to_string(),
                priority: max_p,
                parent_id,
            };
            folder_path_to_id.insert(prefix.clone(), new_folder.id.clone());
            state.folders.push(new_folder);
        }
    }
    folder_path_to_id
}

/// Hashes each untracked entry, either the pak file or a mod directory's representative
/// marker file, so it can be matched against the index. The result is aligned with untracked.
pub(crate) async fn hash_untracked(
    game_path: &str,
    untracked: &[(String, bool, Option<String>)],
    cfg: &ModEngineConfig,
) -> Vec<Option<String>> {
    let sha_futures: Vec<_> = untracked
        .iter()
        .map(|(rel_path, enabled, location_tag)| {
            let game_path = game_path.to_string();
            let rel_path = rel_path.clone();
            let enabled = *enabled;
            let entry_target = cfg.target_for(location_tag.as_deref());
            async move {
                let path = match &entry_target.unit {
                    engine::ModUnit::File { .. } => {
                        if enabled {
                            mods_base(&game_path, entry_target).join(&rel_path)
                        } else {
                            disabled_base(&game_path, entry_target).join(format!(
                                "{}{}",
                                rel_path,
                                entry_target.disabled_suffix()
                            ))
                        }
                    }
                    engine::ModUnit::Directory { entry_markers, .. } => {
                        let mod_dir = if enabled {
                            mods_base(&game_path, entry_target).join(&rel_path)
                        } else {
                            disabled_base(&game_path, entry_target).join(&rel_path)
                        };
                        if entry_markers.is_empty() {
                            let p = hashable_file_for_mod_dir(&mod_dir)?;
                            return compute_sha256(&p).await.ok();
                        }
                        entry_markers
                            .iter()
                            .map(|m| mod_dir.join(m))
                            .find(|p| p.exists())
                            .unwrap_or_else(|| mod_dir.join(entry_markers[0]))
                    }
                };
                compute_sha256(&path).await.ok()
            }
        })
        .collect();
    futures::future::join_all(sha_futures).await
}

/// Reconciles untracked entries that hash-match an existing tracked mod (Phase 1, mutating
/// state.mods in place), then identifies the rest via the index with name, number and hash
/// fallbacks (Phase 2). Returns the full mod list: tracked entries plus newly identified ones.
pub(crate) fn identify_untracked(
    state: &mut ModsState,
    untracked: &[(String, bool, Option<String>)],
    sha256s: &[Option<String>],
    folder_path_to_id: &HashMap<String, String>,
    cfg: &ModEngineConfig,
    game_path: &str,
    index: Option<&rusqlite::Connection>,
) -> Vec<InstalledMod> {
    let sha256_to_uid: HashMap<String, String> = state
        .mods
        .iter()
        .filter_map(|m| m.sha256.as_ref().map(|h| (h.clone(), m.uid.clone())))
        .collect();

    let mut reconcile_ops: Vec<(String, String, bool, Option<String>)> = Vec::new();
    for ((rel_path, enabled, _), sha256) in untracked.iter().zip(sha256s.iter()) {
        let Some(sha) = sha256 else { continue };
        let Some(uid) = sha256_to_uid.get(sha.as_str()) else {
            continue;
        };
        let parts: Vec<&str> = rel_path.split('/').collect();
        let filename = parts.last().unwrap_or(&"").to_string();
        let folder_path = if parts.len() > 1 {
            Some(parts[..parts.len() - 1].join("/"))
        } else {
            None
        };
        let folder_id = folder_path
            .as_deref()
            .and_then(|fp| folder_path_to_id.get(fp).cloned());
        reconcile_ops.push((uid.clone(), filename, *enabled, folder_id));
    }
    for (uid, filename, enabled, folder_id) in reconcile_ops {
        if let Some(m) = state.mods.iter_mut().find(|m| m.uid == uid) {
            m.filename = filename;
            m.enabled = enabled;
            m.folder_id = folder_id;
            m.missing = None;
        }
    }

    let now = Utc::now().to_rfc3339();
    let mut by_uid: HashMap<String, InstalledMod> = state
        .mods
        .iter()
        .map(|m| (m.uid.clone(), m.clone()))
        .collect();

    for ((rel_path, enabled, location_tag), sha256) in untracked.iter().zip(sha256s.iter()) {
        if sha256
            .as_deref()
            .is_some_and(|s| sha256_to_uid.contains_key(s))
        {
            continue;
        }

        let parts: Vec<&str> = rel_path.split('/').collect();
        let filename = parts.last().unwrap_or(&"").to_string();
        let folder_path = if parts.len() > 1 {
            Some(parts[..parts.len() - 1].join("/"))
        } else {
            None
        };
        let folder_id = folder_path
            .as_deref()
            .and_then(|fp| folder_path_to_id.get(fp).cloned());

        let entry_target = cfg.target_for(location_tag.as_deref());
        let stem = match &entry_target.unit {
            engine::ModUnit::File { .. } => filename
                .strip_suffix(".pak")
                .or_else(|| filename.strip_suffix(".pak.disabled"))
                .unwrap_or(&filename),
            engine::ModUnit::Directory { .. } => &filename[..],
        };
        let stripped = strip_priority_prefix(stem);

        let stripped_name = stripped.replace('_', " ");
        let stripped_base = stripped
            .rfind('_')
            .filter(|&p| stripped[p + 1..].chars().all(|c| c.is_ascii_digit()))
            .map(|p| stripped[..p].replace('_', " "));

        let gname = cfg.index_game_name;

        // BeardLib mods declare their modworkshop id in main.xml, and that identity survives
        // version drift, so prefer it over the fuzzy name fallback but below an exact hash
        // match, which also pins the precise file. Installed version comes from the mod's own
        // declaration, and the real display name is enriched from the index when present.
        let mod_dir = entry_target.is_directory_unit().then(|| {
            if *enabled {
                mods_base(game_path, entry_target).join(rel_path)
            } else {
                disabled_base(game_path, entry_target).join(rel_path)
            }
        });
        let embedded = mod_dir.as_deref().and_then(embedded_modworkshop_id);
        let resolve_embedded = |(mod_id, declared): (i64, Option<String>)| {
            let hit = index.and_then(|c| mod_index::query_mod_by_id(c, mod_id, gname));
            // Authors copy each other's marker files, and some ship another project's id. When the index can adjudicate and the two names have nothing in
            // common, the id is not this mod's, so fall through to the name match rather than
            // hand the install a stranger's identity.
            if let Some(hit) = hit.as_ref() {
                let declared_name = mod_dir
                    .as_deref()
                    .and_then(|dir| identity::local_signals(cfg, dir).declared_name);
                if let Some(declared_name) = declared_name {
                    if !identity::names_are_compatible(&declared_name, &hit.mod_name) {
                        return None;
                    }
                }
            }
            let name = hit
                .as_ref()
                .map(|h| h.mod_name.clone())
                .unwrap_or_else(|| stripped_name.trim().to_string());
            // Installed version = the mod's own declaration, so a drifted-old install still
            // reads as outdated against the current version. When it declares none, fall back
            // to the index's current version so it reads up-to-date instead of nagging an
            // endless false update (rather than the never-matching "unknown").
            let (version, status) = match declared.or_else(|| hit.map(|h| h.version)) {
                Some(v) => (v, UpdateStatus::Known),
                None => (String::new(), UpdateStatus::Unknown),
            };
            Some((
                mod_id,
                name,
                None,
                version,
                status,
                Some(IdentityEvidence::EmbeddedCatalogId),
            ))
        };

        let by_name = || {
            index
                .and_then(|c| mod_index::query_by_name(c, &stripped_name, gname))
                .or_else(|| {
                    stripped_base
                        .as_deref()
                        .and_then(|b| index.and_then(|c| mod_index::query_by_name(c, b, gname)))
                })
                .or_else(|| {
                    // The folder tells us nothing when the archive was a GitHub source zip,
                    // whose name is the repository and branch. The mod's own declaration is
                    // the title its page carries.
                    let declared = mod_dir
                        .as_deref()
                        .and_then(|dir| identity::local_signals(cfg, dir).declared_name)?;
                    index.and_then(|c| mod_index::query_by_name(c, &declared, gname))
                })
                .map(|remote_id| {
                    // A confirmed name hit after the SHA256 check above already missed means
                    // the installed bytes are known stale, unlike the numeric and
                    // hash_filename fallbacks below, which have no such confirmation. So
                    // "outdated" surfaces the update instead of hitting the unknown-version
                    // guard.
                    (
                        remote_id,
                        stripped_name.trim().to_string(),
                        None,
                        String::new(),
                        UpdateStatus::Outdated,
                        Some(IdentityEvidence::CatalogName),
                    )
                })
                .or_else(|| {
                    // A folder or pak named after nothing but a mod id, which older Modrex
                    // versions and hand-made installs both produce.
                    stripped
                        .parse::<i64>()
                        .ok()
                        .filter(|&num_id| num_id > 0)
                        .map(|num_id| {
                            (
                                num_id,
                                stripped.to_string(),
                                None,
                                String::new(),
                                UpdateStatus::Unknown,
                                Some(IdentityEvidence::CatalogName),
                            )
                        })
                })
                .unwrap_or_else(|| {
                    (
                        hash_filename(&filename),
                        stripped_name.trim().to_string(),
                        None,
                        String::new(),
                        UpdateStatus::Unknown,
                        None,
                    )
                })
        };

        let (id, name, file_id, version, update_status, evidence) = match sha256
            .as_deref()
            .and_then(|sha| index.and_then(|c| mod_index::query_sha256(c, sha, gname)))
        {
            Some(hit) => (
                hit.mod_remote_id,
                hit.mod_name,
                Some(hit.file_remote_id),
                hit.version,
                UpdateStatus::Known,
                Some(IdentityEvidence::CatalogHash),
            ),
            None => match embedded.and_then(resolve_embedded) {
                Some(resolved) => resolved,
                None => by_name(),
            },
        };

        // Dirs discovered via index_gated_markers (e.g. base.lua) that did not match the
        // index are loader framework modules, not user mods, so they are dropped. Only filter
        // when the index actually has entries for this game: without them there is no way to
        // tell framework modules from real mods, so show everything, some of it "Unknown",
        // rather than hide everything. The filter starts applying once the game is indexed.
        if id < 0 {
            if let engine::ModUnit::Directory {
                scan_markers,
                index_gated_markers,
                ..
            } = &entry_target.unit
            {
                if !index_gated_markers.is_empty()
                    && index.is_some_and(|c| mod_index::has_game(c, gname))
                {
                    let mod_dir = if *enabled {
                        mods_base(game_path, entry_target).join(rel_path)
                    } else {
                        disabled_base(game_path, entry_target).join(rel_path)
                    };
                    if !scan_markers.iter().any(|m| mod_dir.join(m).exists()) {
                        continue;
                    }
                }
            }
        }

        // Fall back to the filename uid when file_id already exists, since multi-pak ZIPs
        // share one file_id.
        let uid = match file_id {
            Some(fid) => {
                let candidate = fid.to_string();
                if by_uid.contains_key(&candidate) {
                    strip_priority_prefix(&filename).to_string()
                } else {
                    candidate
                }
            }
            None => strip_priority_prefix(&filename).to_string(),
        };

        // Evidence is present exactly when this match produced a real modworkshop id; the
        // fallbacks that did not carry hash_filename's placeholder id instead, which stays in
        // InstalledMod.id as the opaque source-scoped key it always is.
        let base = match evidence {
            Some(evidence) => InstalledMod::from_catalog("modworkshop", id.to_string(), evidence),
            None => InstalledMod {
                id,
                ..InstalledMod::default()
            },
        };

        by_uid.entry(uid.clone()).or_insert(InstalledMod {
            uid,
            name,
            version,
            filename: filename.clone(),
            enabled: *enabled,
            installed_at: now.clone(),
            file_id,
            sha256: sha256.clone(),
            folder_id,
            location: location_tag.clone(),
            update_status,
            ..base
        });
    }

    by_uid.into_values().collect()
}

// ── Tauri commands ────────────────────────────────────────────────────────────
