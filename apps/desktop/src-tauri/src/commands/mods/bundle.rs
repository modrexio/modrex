//! Bundles: mods that are a set of files laid over the game folder, for games whose downloads
//! write into several of its folders at once (Cyberpunk 2077 places archives, scripts, tweaks,
//! plugins and framework binaries under archive, r6, red4ext, bin and engine from one zip).
//!
//! A bundle record lists every file it placed, relative to the game folder, so nothing on disk
//! marks where one mod ends. That list is the whole ownership model.
//!
//! Install computes the destination of every file before writing any, and refuses a file it
//! cannot place, a destination another bundle owns, and a destination that exists but no bundle
//! owns. Nothing is ever dropped or overwritten silently.
//!
//! Disabling moves the files into the record's own subfolder of the target's disabled folder,
//! outside every root, and enabling moves them back. Launching without mods moves every enabled
//! bundle's files into the target's backup folder, laid out as in the game folder, and restoring
//! moves back whatever is not in the way. Uninstalling deletes the files whose size still
//! matches what was placed, and keeps and reports any that changed since.

use super::engine::{backup_dir, disabled_dir, ModEngineConfig, ModUnit, Placement, ScanTarget};
use super::naming::log_name;
use super::types::{BundleFile, InstalledMod};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// The parts of a bundle unit the planner reads.
#[derive(Clone, Copy)]
pub(crate) struct Layout<'a> {
    pub roots: &'a [String],
    pub placements: &'a [Placement],
    pub flat: &'a [Vec<String>],
}

impl Layout<'static> {
    pub(crate) fn of(target: &ScanTarget) -> Option<Self> {
        match &target.unit {
            ModUnit::Bundle {
                roots,
                placements,
                flat,
            } => Some(Layout {
                roots,
                placements,
                flat,
            }),
            ModUnit::File { .. } | ModUnit::Directory { .. } => None,
        }
    }
}

/// One file of a download and where it goes, both as forward-slash paths. The source is
/// relative to the download, the destination to the game folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlannedFile {
    pub source: String,
    pub destination: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    Files(Vec<PlannedFile>),
    /// Top level folders that each place on their own: alternatives or optional parts the
    /// user picks between, named by their path inside the download.
    Variants(Vec<String>),
}

/// Files an author ships for people rather than the game. Skipped only at a level of the
/// download that is not itself placed, never inside a root or a placed folder.
fn is_documentation(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem_words = [
        "readme",
        "license",
        "licence",
        "changelog",
        "changes",
        "credits",
    ];
    if stem_words.iter().any(|word| lower.starts_with(word)) {
        return true;
    }
    let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    matches!(
        extension,
        "txt"
            | "md"
            | "pdf"
            | "url"
            | "htm"
            | "html"
            | "rtf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
    )
}

/// macOS archivers add this folder of resource forks, which is never content.
fn is_packaging_noise(dir: &str) -> bool {
    dir == "__MACOSX"
}

fn extension_of(name: &str) -> Option<&str> {
    name.rsplit_once('.').map(|(_, ext)| ext)
}

fn joined(parts: &[String]) -> String {
    parts.join("/")
}

/// Lists entries for an error message, without flooding it.
fn listed(names: &[String]) -> String {
    const SHOWN: usize = 5;
    let mut out = names
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > SHOWN {
        out.push_str(&format!(" and {} more", names.len() - SHOWN));
    }
    out
}

/// Decides where every file of a download goes. files are the download's file paths,
/// directories excluded. Archives name members with either separator.
pub(crate) fn plan(files: &[String], layout: Layout) -> Result<Plan, String> {
    let normalized: Vec<String> = files
        .iter()
        .map(|f| f.replace('\\', "/").trim_start_matches('/').to_string())
        .filter(|f| !f.is_empty() && !f.ends_with('/'))
        .collect();
    // Archive member names are the author's, and extraction refuses these anyway. Refusing
    // here keeps a planned destination from ever naming a place outside the game folder.
    if let Some(unsafe_name) = normalized.iter().find(|f| {
        f.split('/')
            .any(|part| part == ".." || part == "." || part.contains(':'))
    }) {
        return Err(format!(
            "{unsafe_name} points outside the mod, so this download cannot be installed."
        ));
    }
    let files: Vec<&str> = normalized.iter().map(String::as_str).collect();
    let plan = plan_level(&files, "", layout)?;
    if let Plan::Files(planned) = &plan {
        check_destinations(planned, layout)?;
    }
    Ok(plan)
}

enum Entry<'a> {
    Rooted,
    PlacedDir(&'a Placement),
    Unknown,
}

fn plan_level(files: &[&str], prefix: &str, layout: Layout) -> Result<Plan, String> {
    let mut loose: Vec<&str> = Vec::new();
    let mut dirs: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for file in files {
        match file.split_once('/') {
            Some((dir, rest)) => dirs.entry(dir).or_default().push(rest),
            None => loose.push(file),
        }
    }
    dirs.retain(|dir, _| !is_packaging_noise(dir));
    if dirs.keys().any(|dir| dir.eq_ignore_ascii_case("fomod")) {
        return Err("This download uses a FOMOD installer, which Modrex cannot run. Install it by hand, or pick another file from the mod page.".to_string());
    }

    let mut placed_files: Vec<(&str, &Placement)> = Vec::new();
    let mut unplaced: Vec<String> = Vec::new();
    for name in &loose {
        let placement = layout.placements.iter().find(|placement| match placement {
            Placement::File { extension, .. } => {
                extension_of(name).is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
            }
            Placement::Marker { .. } | Placement::Contains { .. } => false,
        });
        match placement {
            Some(placement) => placed_files.push((name, placement)),
            None if is_documentation(name) => {}
            None => unplaced.push(format!("{prefix}{name}")),
        }
    }

    let mut entries: Vec<(&str, Entry)> = Vec::new();
    for (dir, inner) in &dirs {
        if layout
            .roots
            .iter()
            .any(|root| root.eq_ignore_ascii_case(dir))
        {
            entries.push((dir, Entry::Rooted));
            continue;
        }
        let top: Vec<&str> = inner.iter().copied().filter(|f| !f.contains('/')).collect();
        let matching: Vec<&Placement> = layout
            .placements
            .iter()
            .filter(|placement| match placement {
                Placement::File { .. } => false,
                Placement::Marker { file, .. } => top.iter().any(|f| f.eq_ignore_ascii_case(file)),
                Placement::Contains { extension, .. } => top.iter().any(|f| {
                    extension_of(f).is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
                }),
            })
            .collect();
        match matching.as_slice() {
            [] => entries.push((dir, Entry::Unknown)),
            [one] => entries.push((dir, Entry::PlacedDir(one))),
            several => {
                let destinations: Vec<String> =
                    several.iter().map(|p| joined(p.destination())).collect();
                return Err(format!(
                    "The folder {prefix}{dir} could belong in more than one place ({}), so Modrex cannot tell where to install it.",
                    destinations.join(" or ")
                ));
            }
        }
    }

    if !unplaced.is_empty() {
        return Err(format!(
            "Modrex cannot tell where these files go: {}. Install this mod by hand, or pick another file from the mod page.",
            listed(&unplaced)
        ));
    }

    let unknown: Vec<&str> = entries
        .iter()
        .filter(|(_, entry)| matches!(entry, Entry::Unknown))
        .map(|(dir, _)| *dir)
        .collect();
    let placed_anything = !placed_files.is_empty() || unknown.len() < entries.len();

    if !unknown.is_empty() {
        if placed_anything {
            let names: Vec<String> = unknown.iter().map(|d| format!("{prefix}{d}/")).collect();
            return Err(format!(
                "Modrex cannot tell where these folders go: {}. Install this mod by hand, or pick another file from the mod page.",
                listed(&names)
            ));
        }
        if let [wrapper] = unknown.as_slice() {
            return plan_level(&dirs[wrapper], &format!("{prefix}{wrapper}/"), layout);
        }
        let mut variants = Vec::new();
        for dir in &unknown {
            let inner_prefix = format!("{prefix}{dir}/");
            match plan_level(&dirs[dir], &inner_prefix, layout)? {
                Plan::Files(_) => variants.push(inner_prefix.trim_end_matches('/').to_string()),
                Plan::Variants(_) => {
                    return Err(format!(
                        "The folder {inner_prefix} holds several choices of its own, which Modrex cannot offer. Install this mod by hand, or pick another file from the mod page."
                    ));
                }
            }
        }
        return Ok(Plan::Variants(variants));
    }

    let mut planned = Vec::new();
    for (name, placement) in placed_files {
        planned.push(PlannedFile {
            source: format!("{prefix}{name}"),
            destination: format!("{}/{name}", joined(placement.destination())),
        });
    }
    for (dir, entry) in &entries {
        let base = match entry {
            Entry::Rooted => dir.to_string(),
            Entry::PlacedDir(placement) => format!("{}/{dir}", joined(placement.destination())),
            Entry::Unknown => unreachable!("unknown folders returned above"),
        };
        for rest in &dirs[dir] {
            planned.push(PlannedFile {
                source: format!("{prefix}{dir}/{rest}"),
                destination: format!("{base}/{rest}"),
            });
        }
    }
    if planned.is_empty() {
        return Err("This download holds nothing to install.".to_string());
    }
    Ok(Plan::Files(planned))
}

fn check_destinations(planned: &[PlannedFile], layout: Layout) -> Result<(), String> {
    let mut seen: HashMap<String, &str> = HashMap::new();
    for file in planned {
        if let Some(other) = seen.insert(file.destination.to_ascii_lowercase(), &file.source) {
            return Err(format!(
                "{other} and {} would both install to {}.",
                file.source, file.destination
            ));
        }
        let parts: Vec<&str> = file.destination.split('/').collect();
        for flat in layout.flat {
            let inside = parts.len() > flat.len() + 1
                && flat
                    .iter()
                    .zip(&parts)
                    .all(|(want, have)| want.eq_ignore_ascii_case(have));
            if inside {
                return Err(format!(
                    "{} would install into a subfolder of {}, which the game never reads. Install this mod by hand, or pick another file from the mod page.",
                    file.source,
                    joined(flat)
                ));
            }
        }
    }
    Ok(())
}

/// Every file under dir as a forward-slash path relative to it. Nothing Modrex extracts is a
/// link, so finding one fails the install rather than following it.
pub(crate) fn staged_files(dir: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = fs::read_dir(&current)
            .map_err(|e| format!("could not read {}: {e}", log_name(&current)))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            let path = entry.path();
            if kind.is_symlink() {
                return Err(format!(
                    "{} is a link, which a mod cannot install",
                    log_name(&path)
                ));
            }
            if kind.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(dir)
                .map_err(|e| e.to_string())?
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push(rel);
        }
    }
    out.sort();
    Ok(out)
}

fn rel_path(base: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

/// The record's own folder inside the target's disabled folder. Named by a digest because a
/// uid can hold characters Windows refuses in a file name.
pub(crate) fn disabled_store(game_path: &str, target: &ScanTarget, uid: &str) -> PathBuf {
    let digest = hex::encode(Sha256::digest(uid.as_bytes()));
    disabled_dir(game_path, target).join(&digest[..16])
}

/// Where a record's file is now, by whether the record is enabled.
fn current_file(game_path: &str, target: &ScanTarget, m: &InstalledMod, rel: &str) -> PathBuf {
    if m.enabled {
        rel_path(Path::new(game_path), rel)
    } else {
        rel_path(&disabled_store(game_path, target, &m.uid), rel)
    }
}

fn files_of(m: &InstalledMod) -> &[BundleFile] {
    m.bundle.as_deref().unwrap_or_default()
}

fn is_inside_roots(rel: &str, layout: Layout) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty() && *part != "." && *part != ".." && !part.contains([':', '\\'])
        })
        && layout
            .roots
            .iter()
            .any(|root| root.eq_ignore_ascii_case(parts[0]))
}

/// A record's files, checked before anything acts on them. The state file is ordinary JSON on
/// disk, and a damaged one must never name a place outside the folders the game reads mods
/// from.
fn checked<'a>(m: &'a InstalledMod, layout: Layout) -> Result<&'a [BundleFile], String> {
    let files = files_of(m);
    if let Some(bad) = files
        .iter()
        .find(|file| !is_inside_roots(&file.path, layout))
    {
        return Err(format!(
            "{} lists {}, which is outside the game's mod folders, so Modrex left it alone",
            m.name, bad.path
        ));
    }
    Ok(files)
}

/// Removes empty folders from start upwards, stopping at stop, which is never removed.
fn prune_empty(start: Option<&Path>, stop: &Path) {
    let mut current = start.map(Path::to_path_buf);
    while let Some(dir) = current {
        if dir == stop || !dir.starts_with(stop) || fs::remove_dir(&dir).is_err() {
            return;
        }
        current = dir.parent().map(Path::to_path_buf);
    }
}

/// Removes empty folders a game-folder file sat in, keeping each root folder itself.
fn prune_game_folders(game_path: &str, layout: Layout, rel: &str) {
    let game = Path::new(game_path);
    let Some(root) = rel.split('/').next() else {
        return;
    };
    if !layout.roots.iter().any(|r| r.eq_ignore_ascii_case(root)) {
        return;
    }
    prune_empty(rel_path(game, rel).parent(), &game.join(root));
}

fn hash_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file =
        fs::File::open(path).map_err(|e| format!("could not read {}: {e}", log_name(path)))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("could not read {}: {e}", log_name(path)))?;
        if read == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}

/// Whether a file still holds the bytes the install wrote. The size is compared first so an
/// obviously changed file is not read in full.
fn unchanged(path: &Path, file: &BundleFile) -> bool {
    let same_size = fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == file.size);
    same_size && hash_file(path).is_ok_and(|sha256| sha256 == file.sha256)
}

/// Copies a file and hashes what it wrote in the same pass.
fn copy_hashed(from: &Path, to: &Path) -> Result<(u64, String), String> {
    use std::io::{Read, Write};
    let mut source =
        fs::File::open(from).map_err(|e| format!("could not read {}: {e}", log_name(from)))?;
    let mut target =
        fs::File::create(to).map_err(|e| format!("could not write {}: {e}", log_name(to)))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut size = 0u64;
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|e| format!("could not read {}: {e}", log_name(from)))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        target
            .write_all(&buffer[..read])
            .map_err(|e| format!("could not write {}: {e}", log_name(to)))?;
        size += read as u64;
    }
    target
        .sync_all()
        .map_err(|e| format!("could not write {}: {e}", log_name(to)))?;
    Ok((size, hex::encode(hasher.finalize())))
}

/// Bundle files other records own, keyed case-insensitively because the game folder is on a
/// case-insensitive filesystem.
fn owners<'a>(mods: &'a [InstalledMod], except: Option<&str>) -> HashMap<String, &'a InstalledMod> {
    let mut out = HashMap::new();
    for m in mods {
        if Some(m.uid.as_str()) == except {
            continue;
        }
        for file in files_of(m) {
            out.insert(file.path.to_ascii_lowercase(), m);
        }
    }
    out
}

/// Game-relative paths of mods the other targets track, lowercased. Disabling or uninstalling
/// one of those moves or deletes its whole folder, so a bundle file inside it would go too.
fn separately_tracked<'a>(
    cfg: &ModEngineConfig,
    mods: &'a [InstalledMod],
) -> Vec<(String, bool, &'a InstalledMod)> {
    let mut out = Vec::new();
    for m in mods
        .iter()
        .filter(|m| m.bundle.is_none() && m.deployment.is_none())
    {
        if m.location
            .as_deref()
            .is_some_and(|l| l.starts_with("host:"))
        {
            continue;
        }
        let target = cfg.mod_target(m);
        let is_dir = match &target.unit {
            ModUnit::Bundle { .. } => continue,
            ModUnit::Directory { .. } => true,
            ModUnit::File { .. } => false,
        };
        let (base, name) = if m.enabled {
            (target.mods_subpath, m.filename.clone())
        } else {
            (
                target.disabled_subpath,
                format!("{}{}", m.filename, target.disabled_suffix()),
            )
        };
        let rel = base
            .iter()
            .map(|part| part.to_string())
            .chain(std::iter::once(name))
            .collect::<Vec<_>>()
            .join("/")
            .to_ascii_lowercase();
        out.push((rel, is_dir, m));
    }
    out
}

/// The record an install replaces: the same uid, or a record of the same catalog mod that
/// owns a file this install places. A newer release of a mod arrives under a new file id and
/// so a new uid, while a mod's separate optional files never share a destination.
fn replaced_record<'a>(
    mods: &'a [InstalledMod],
    incoming: &InstalledMod,
    planned: &[PlannedFile],
) -> Result<Option<&'a InstalledMod>, String> {
    let destinations: HashSet<String> = planned
        .iter()
        .map(|file| file.destination.to_ascii_lowercase())
        .collect();
    let candidates: Vec<&InstalledMod> = mods
        .iter()
        .filter(|m| m.bundle.is_some())
        .filter(|m| {
            m.uid == incoming.uid
                || (incoming.remote_id.is_some()
                    && m.source == incoming.source
                    && m.remote_id == incoming.remote_id
                    && files_of(m)
                        .iter()
                        .any(|file| destinations.contains(&file.path.to_ascii_lowercase())))
        })
        .collect();
    match candidates.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(one)),
        _ => Err(format!(
            "This download overlaps more than one installed part of {}. Uninstall the parts it replaces first, nothing was changed.",
            incoming.name
        )),
    }
}

/// Installs a staged download as a bundle record and saves it. The record it replaces, if
/// any, gives way to it, and a replaced record that was disabled leaves the new one disabled.
/// Until the state is saved the previous files are only set aside, so a failed save puts
/// everything back.
pub(crate) fn install(
    game_path: &str,
    state_path: &Path,
    mod_data: InstalledMod,
    staged: &Path,
    cfg: &ModEngineConfig,
    target: &ScanTarget,
) -> Result<(), String> {
    refuse_while_hidden(game_path, target, "install again")?;
    let state =
        super::state::read_state_for_game(game_path, state_path, cfg).map_err(|e| e.to_string())?;
    let placed = place(game_path, cfg, target, staged, &state.mods, &mod_data)?;
    let mut record = InstalledMod {
        bundle: Some(placed.files.clone()),
        enabled: true,
        location: None,
        folder_id: None,
        priority: None,
        installed_at: chrono::Utc::now().to_rfc3339(),
        ..mod_data
    };
    let stays_disabled = placed.replaced.as_ref().is_some_and(|old| !old.enabled);
    if stays_disabled {
        if let Err(error) = set_enabled(game_path, target, &record, false) {
            return Err(undo_message(error, placed.undo(game_path)));
        }
        record.enabled = false;
    }
    log::info!(
        "install: {} ({}) -> {} [{} files]",
        record.name,
        record.uid,
        target.tag,
        placed.files.len()
    );
    let replaced_uid = placed.replaced.as_ref().map(|old| old.uid.clone());
    let mut mods: Vec<InstalledMod> = state
        .mods
        .into_iter()
        .filter(|m| m.uid != record.uid && Some(&m.uid) != replaced_uid.as_ref())
        .collect();
    mods.push(record.clone());
    let saved = super::state::save_state(
        state_path,
        &super::types::ModsState {
            folders: state.folders,
            mods,
        },
    );
    let Err(error) = saved else {
        placed.finish(game_path, target, &record.uid);
        return Ok(());
    };
    let error = super::state::save_error(error);
    if stays_disabled {
        if let Err(back) = set_enabled(game_path, target, &record, true) {
            return Err(format!(
                "{error}, and the new files could not be taken back out of the disabled folder ({back}), so they stay in {}",
                disabled_store(game_path, target, &record.uid).display()
            ));
        }
    }
    Err(undo_message(error, placed.undo(game_path)))
}

fn undo_message(error: String, undo: Result<(), String>) -> String {
    match undo {
        Ok(()) => format!("{error}. Nothing was changed."),
        Err(problem) => format!("{error}. Putting the previous files back also failed: {problem}"),
    }
}

/// Files an install has laid down but not yet made final: the ones it wrote, and the previous
/// release's files it set aside. finish keeps the install and undo reverses it.
struct Placed {
    files: Vec<BundleFile>,
    replaced: Option<InstalledMod>,
    written: Vec<PathBuf>,
    set_aside: Vec<(PathBuf, PathBuf)>,
    aside: PathBuf,
    layout: Layout<'static>,
    planned: Vec<String>,
}

impl Placed {
    fn finish(self, game_path: &str, target: &ScanTarget, new_uid: &str) {
        for (_, aside_path) in &self.set_aside {
            if let Err(e) = fs::remove_file(aside_path) {
                log::warn!(
                    "bundle: could not remove replaced {}: {e}",
                    log_name(aside_path)
                );
            }
        }
        if let Some(old) = &self.replaced {
            let kept: HashSet<String> = self
                .files
                .iter()
                .map(|f| f.path.to_ascii_lowercase())
                .collect();
            for file in files_of(old)
                .iter()
                .filter(|file| !kept.contains(&file.path.to_ascii_lowercase()))
            {
                prune_game_folders(game_path, self.layout, &file.path);
            }
            // A reinstall under the same uid shares the disabled folder, which may now hold the
            // new release, so only folders emptied by setting the old files aside go.
            if old.uid != new_uid {
                let store = disabled_store(game_path, target, &old.uid);
                for file in files_of(old) {
                    prune_empty(rel_path(&store, &file.path).parent(), &store);
                }
                remove_if_empty(&store);
            }
        }
        remove_leftover_tree(&self.aside);
    }

    fn undo(self, game_path: &str) -> Result<(), String> {
        for path in self.written.iter().rev().filter(|path| path.exists()) {
            if let Err(e) = fs::remove_file(path) {
                log::warn!("bundle: rollback could not remove {}: {e}", log_name(path));
            }
        }
        for rel in &self.planned {
            prune_game_folders(game_path, self.layout, rel);
        }
        let mut failed = Vec::new();
        for (original, aside_path) in self.set_aside.iter().rev() {
            if let Err(e) = move_file(aside_path, original) {
                failed.push(format!("{} ({e})", log_name(original)));
            }
        }
        if failed.is_empty() {
            remove_leftover_tree(&self.aside);
            return Ok(());
        }
        Err(format!(
            "{}, which stay in {}",
            failed.join(", "),
            self.aside.display()
        ))
    }
}

/// Lays a staged download over the game folder. On a failure part way, every file this call
/// wrote is removed again and the replaced record's files are put back before it returns.
fn place(
    game_path: &str,
    cfg: &ModEngineConfig,
    target: &ScanTarget,
    staged: &Path,
    mods: &[InstalledMod],
    incoming: &InstalledMod,
) -> Result<Placed, String> {
    let layout = Layout::of(target).expect("place is only called for bundle targets");
    let loose = staged
        .is_file()
        .then(|| loose_file_name(staged, &incoming.filename));
    let sources = match &loose {
        Some(name) => vec![name.clone()],
        None => staged_files(staged)?,
    };
    let planned = match plan(&sources, layout)? {
        Plan::Files(planned) => planned,
        Plan::Variants(_) => {
            return Err(
                "This download holds several choices. Install it again and pick one.".to_string(),
            );
        }
    };
    let replaced = replaced_record(mods, incoming, &planned)?;
    if let Some(old) = replaced {
        checked(old, layout)?;
    }

    let game = Path::new(game_path);
    let game_canonical =
        fs::canonicalize(game).map_err(|e| format!("could not resolve the game folder: {e}"))?;
    let others = owners(mods, replaced.map(|m| m.uid.as_str()));
    let tracked = separately_tracked(cfg, mods);
    let previous: HashSet<String> = replaced
        .map(|m| {
            files_of(m)
                .iter()
                .map(|f| f.path.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default();
    let replaced_enabled = replaced.is_some_and(|m| m.enabled);
    for file in &planned {
        let key = file.destination.to_ascii_lowercase();
        if let Some(owner) = others.get(&key) {
            return Err(format!(
                "{} is already installed by {}. Uninstall that mod first, nothing was changed.",
                file.destination, owner.name
            ));
        }
        if let Some((_, _, owner)) = tracked.iter().find(|(rel, is_dir, _)| {
            key == *rel || (*is_dir && key.starts_with(&format!("{rel}/")))
        }) {
            return Err(format!(
                "{} would go inside {}, which is installed separately. Uninstall that mod first, nothing was changed.",
                file.destination, owner.name
            ));
        }
        let dest = rel_path(game, &file.destination);
        let ours = replaced_enabled && previous.contains(&key);
        if !ours && fs::symlink_metadata(&dest).is_ok() {
            return Err(format!(
                "{} already exists and was not installed by Modrex, so it was left alone and nothing was changed. Remove it by hand if it belongs to an old copy of this mod.",
                file.destination
            ));
        }
    }

    let planned_keys: HashSet<String> = planned
        .iter()
        .map(|file| file.destination.to_ascii_lowercase())
        .collect();
    let mut placed = Placed {
        files: Vec::new(),
        replaced: replaced.cloned(),
        written: Vec::new(),
        set_aside: Vec::new(),
        aside: disabled_dir(game_path, target).join(format!("replacing-{}", uuid::Uuid::new_v4())),
        layout,
        planned: planned
            .iter()
            .map(|file| file.destination.clone())
            .collect(),
    };
    let result = (|| -> Result<(), String> {
        // The replaced release's files are set aside first, so a failure part way can put the
        // old install back exactly. One the user changed since, which this release no longer
        // ships, stays where it is rather than being deleted with the old release.
        if let Some(old) = replaced {
            for file in files_of(old) {
                let from = current_file(game_path, target, old, &file.path);
                if !from.exists() {
                    continue;
                }
                let replaced_here = planned_keys.contains(&file.path.to_ascii_lowercase());
                if !replaced_here && !unchanged(&from, file) {
                    log::warn!(
                        "bundle: kept {} from the previous release because it changed since install",
                        file.path
                    );
                    continue;
                }
                let to = rel_path(&placed.aside, &file.path);
                move_file(&from, &to)?;
                placed.set_aside.push((from, to));
            }
        }
        for file in &planned {
            let from = match &loose {
                Some(_) => staged.to_path_buf(),
                None => rel_path(staged, &file.source),
            };
            let to = rel_path(game, &file.destination);
            let parent = to.parent().expect("a planned destination has a folder");
            fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", log_name(parent)))?;
            // A folder link inside the game folder would carry the write somewhere else.
            let resolved = fs::canonicalize(parent)
                .map_err(|e| format!("could not resolve {}: {e}", log_name(parent)))?;
            if !resolved.starts_with(&game_canonical) {
                return Err(format!(
                    "{} leads outside the game folder",
                    log_name(parent)
                ));
            }
            // Recorded before the copy, which can fail part way and leave a partial file.
            placed.written.push(to.clone());
            let (size, sha256) = copy_hashed(&from, &to)
                .map_err(|e| format!("could not install {}: {e}", file.destination))?;
            placed.files.push(BundleFile {
                path: file.destination.clone(),
                size,
                sha256,
            });
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(placed),
        Err(error) => Err(undo_message(error, placed.undo(game_path))),
    }
}

/// The name a loose downloaded file installs under: the record's name with the file's own
/// extension, since a download's temp file is named after nothing.
fn loose_file_name(staged: &Path, filename: &str) -> String {
    let extension = staged
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    let has_extension =
        extension_of(filename).is_some_and(|ext| ext.eq_ignore_ascii_case(extension));
    if has_extension || extension.is_empty() {
        return filename.to_string();
    }
    format!("{filename}.{extension}")
}

/// Removes a folder only when nothing is left in it. A folder still holding something stays,
/// which is the point, so the refusal is not an error.
fn remove_if_empty(dir: &Path) {
    let _ = fs::remove_dir(dir);
}

/// Removes a working folder whose files were all moved or deleted already, so what remains is
/// empty folders at most.
fn remove_leftover_tree(dir: &Path) {
    if !dir.exists() {
        return;
    }
    if let Err(e) = fs::remove_dir_all(dir) {
        log::warn!("bundle: could not remove {}: {e}", log_name(dir));
    }
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", log_name(parent)))?;
    }
    fs::rename(from, to).map_err(|e| format!("could not move {}: {e}", log_name(from)))
}

/// Moves files from one tree to another, all or nothing.
fn move_all(moves: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    for (_, to) in moves {
        if fs::symlink_metadata(to).is_ok() {
            return Err(format!(
                "{} is in the way, so nothing was moved",
                to.display()
            ));
        }
    }
    let mut done: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (from, to) in moves {
        if let Err(error) = move_file(from, to) {
            for (from, to) in done.iter().rev() {
                if let Err(e) = move_file(to, from) {
                    log::warn!("bundle: could not move {} back: {e}", log_name(to));
                }
            }
            return Err(error);
        }
        done.push((from.clone(), to.clone()));
    }
    Ok(())
}

/// While a launch without mods has an enabled bundle's files in the backup folder, the record
/// no longer says where they are, so nothing may change them until they are restored.
pub(crate) fn refuse_while_hidden(
    game_path: &str,
    target: &ScanTarget,
    retry: &str,
) -> Result<(), String> {
    if backup_dir(game_path, target).exists() {
        return Err(format!(
            "Mods are set aside for a launch without mods. Start the game normally once to restore them, then {retry}."
        ));
    }
    Ok(())
}

pub(crate) fn set_enabled(
    game_path: &str,
    target: &ScanTarget,
    m: &InstalledMod,
    enable: bool,
) -> Result<(), String> {
    refuse_while_hidden(game_path, target, "try again")?;
    let layout = Layout::of(target).expect("set_enabled is only called for bundle targets");
    let files = checked(m, layout)?;
    let game = Path::new(game_path);
    let store = disabled_store(game_path, target, &m.uid);
    let moves: Vec<(PathBuf, PathBuf)> = files
        .iter()
        .map(|file| {
            let active = rel_path(game, &file.path);
            let disabled = rel_path(&store, &file.path);
            if enable {
                (disabled, active)
            } else {
                (active, disabled)
            }
        })
        .filter(|(from, _)| from.exists())
        .collect();
    move_all(&moves)?;
    for file in files {
        if enable {
            prune_empty(rel_path(&store, &file.path).parent(), &store);
        } else {
            prune_game_folders(game_path, layout, &file.path);
        }
    }
    if enable {
        remove_if_empty(&store);
    }
    Ok(())
}

/// Deletes a record's files. Returns the files left in place because their bytes changed since
/// they were installed, which the caller keeps on the record.
pub(crate) fn remove(
    game_path: &str,
    target: &ScanTarget,
    m: &InstalledMod,
) -> Result<Vec<BundleFile>, String> {
    let layout = Layout::of(target).expect("remove is only called for bundle targets");
    let files = checked(m, layout)?;
    let store = disabled_store(game_path, target, &m.uid);
    let mut kept = Vec::new();
    for file in files {
        let path = current_file(game_path, target, m, &file.path);
        if !path.exists() {
            continue;
        }
        if !unchanged(&path, file) {
            log::warn!(
                "bundle: kept {} because it changed since install",
                file.path
            );
            kept.push(file.clone());
            continue;
        }
        if let Err(e) = fs::remove_file(&path) {
            log::warn!("bundle: could not remove {}: {e}", log_name(&path));
            kept.push(file.clone());
            continue;
        }
        if m.enabled {
            prune_game_folders(game_path, layout, &file.path);
        } else {
            prune_empty(path.parent(), &store);
        }
    }
    remove_if_empty(&store);
    Ok(kept)
}

/// Whether every file of a record is where its state says. A record naming a place outside the
/// game's mod folders counts as incomplete, which flags it for the user.
pub(crate) fn is_complete(game_path: &str, target: &ScanTarget, m: &InstalledMod) -> bool {
    let layout = Layout::of(target).expect("is_complete is only called for bundle targets");
    let Ok(files) = checked(m, layout) else {
        return false;
    };
    files
        .iter()
        .all(|file| current_file(game_path, target, m, &file.path).is_file())
}

/// Moves every enabled bundle's files into the backup folder, laid out as in the game folder.
pub(crate) fn hide(
    game_path: &str,
    target: &ScanTarget,
    mods: &[InstalledMod],
) -> Result<(), String> {
    let backup = backup_dir(game_path, target);
    let layout = Layout::of(target).expect("hide is only called for bundle targets");
    let game = Path::new(game_path);
    let mut moves = Vec::new();
    for m in mods.iter().filter(|m| m.enabled && m.bundle.is_some()) {
        for file in checked(m, layout)? {
            let from = rel_path(game, &file.path);
            if from.exists() {
                moves.push((from, rel_path(&backup, &file.path)));
            }
        }
    }
    fs::create_dir_all(&backup)
        .map_err(|e| format!("Could not create the mods backup folder: {e}"))?;
    if let Err(error) = move_all(&moves) {
        remove_if_empty(&backup);
        return Err(format!("Could not hide the mod files: {error}"));
    }
    for m in mods.iter().filter(|m| m.enabled) {
        for file in files_of(m) {
            prune_game_folders(game_path, layout, &file.path);
        }
    }
    Ok(())
}

/// Moves hidden files back into the game folder. A file whose place is taken stays in the
/// backup, which then remains for manual recovery.
pub(crate) fn restore(game_path: &str, target: &ScanTarget) -> Result<(), String> {
    let backup = backup_dir(game_path, target);
    if !backup.exists() {
        return Ok(());
    }
    let mut blocked = Vec::new();
    for rel in staged_files(&backup)? {
        let from = rel_path(&backup, &rel);
        let to = rel_path(Path::new(game_path), &rel);
        if fs::symlink_metadata(&to).is_ok() {
            blocked.push(rel);
            continue;
        }
        if let Err(e) = move_file(&from, &to) {
            log::warn!("bundle: restore {rel}: {e}");
            blocked.push(rel);
            continue;
        }
        prune_empty(from.parent(), &backup);
    }
    if blocked.is_empty() {
        remove_if_empty(&backup);
        return Ok(());
    }
    Err(format!(
        "Some mod files could not be put back because something now sits in their place: {}. They are kept in {}",
        listed(&blocked),
        backup.display()
    ))
}

/// Scan keys of the units other targets would list for files a bundle placed, so a mod
/// installed as a bundle is not listed a second time as one installed by hand. A key is
/// "tag:rel", where rel is the unit's path inside that target, lowercased because the scan
/// compares it against whatever case the folder on disk has.
pub(crate) fn owned_scan_keys(cfg: &ModEngineConfig, mods: &[InstalledMod]) -> HashSet<String> {
    let mut keys = HashSet::new();
    let placed: Vec<&BundleFile> = mods
        .iter()
        .filter(|m| m.enabled)
        .flat_map(files_of)
        .collect();
    if placed.is_empty() {
        return keys;
    }
    for target in cfg.targets.iter().skip(1) {
        let base = target.mods_subpath;
        for file in &placed {
            let parts: Vec<&str> = file.path.split('/').collect();
            let under = parts.len() > base.len()
                && base
                    .iter()
                    .zip(&parts)
                    .all(|(want, have)| want.eq_ignore_ascii_case(have));
            if !under {
                continue;
            }
            let rest = &parts[base.len()..];
            let key = match &target.unit {
                ModUnit::File { .. } => rest.join("/"),
                ModUnit::Directory { .. } => rest[0].to_string(),
                ModUnit::Bundle { .. } => continue,
            };
            keys.insert(format!("{}:{}", target.tag, key.to_ascii_lowercase()));
        }
    }
    keys
}

/// Hides every enabled bundle of a game before a launch without mods. Runs before the other
/// targets hide, so a folder they move away holds only what was installed by hand.
pub(crate) fn hide_for_launch(game_path: &str, cfg: &ModEngineConfig) -> Result<(), String> {
    let target = cfg.primary();
    if !target.is_bundle() || backup_dir(game_path, target).exists() {
        return Ok(());
    }
    let state_path = super::paths::get_state_path(game_path, cfg);
    let state = super::state::read_state_for_game(game_path, &state_path, cfg)
        .map_err(|e| format!("Could not read the installed mods: {e}"))?;
    hide(game_path, target, &state.mods)
}

/// Puts hidden bundles back after a launch without mods. Runs after the other targets
/// restore, so a folder they rename back is in place before files return into it.
pub(crate) fn restore_after_launch(game_path: &str, cfg: &ModEngineConfig) -> Result<(), String> {
    let target = cfg.primary();
    if !target.is_bundle() {
        return Ok(());
    }
    restore(game_path, target)
}
