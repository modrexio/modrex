use std::path::{Path, PathBuf};

use crate::commands::mods::{extract_loader_package, hash_file};
use crate::game_package::{LoaderBinding, Storefront};
use uuid::Uuid;

fn storefront(launcher: Option<&str>) -> Option<Storefront> {
    match launcher? {
        "steam" => Some(Storefront::Steam),
        "epic" => Some(Storefront::Epic),
        "xbox" => Some(Storefront::Xbox),
        _ => None,
    }
}

/// A UE4SS release, identified by the bytes of the proxy DLL it installs.
///
/// The filename cannot identify it. dxgi and dwmapi are two of the commonest proxy names on
/// Windows, and ReShade, Special K and vendor overlays all ship one under exactly these
/// names, so a file standing in that slot says only that something claimed it. Hashing says
/// this release put it there, which is what makes it safe to replace and honest to report.
///
/// Recorded from the published packages: modworkshop 44048 file 69956 (PD3-UE4SSv040.zip,
/// 3,097,583 bytes) and 47771 file 102150 (PD3-UE5-UE4SS-exp.zip, 32,257,789 bytes).
pub(crate) struct KnownRelease {
    pub modworkshop_id: i64,
    pub version: &'static str,
    pub proxy: &'static str,
    pub proxy_sha256: &'static str,
}

/// The releases identification runs against.
///
/// Tests substitute their own so a fixture can install a few bytes rather than the 48 KB and
/// 267 KB of real DLL the shipped table hashes. The shipped table's own shape is asserted
/// separately.
#[cfg(not(test))]
fn releases() -> &'static [KnownRelease] {
    KNOWN_RELEASES
}

#[cfg(test)]
fn releases() -> &'static [KnownRelease] {
    tests::TEST_RELEASES
}

/// PAYDAY 3 runs Unreal Engine 5.5.4, which the UE5 release targets and the UE4 one predates.
/// Both are listed because both are on real installs and the point is to recognise what is
/// there, not only what should be.
pub(crate) const KNOWN_RELEASES: &[KnownRelease] = &[
    KnownRelease {
        modworkshop_id: 47771,
        version: "0.2.0",
        proxy: "dwmapi.dll",
        proxy_sha256: "f8f1f53e59129313e76ae6754a83e3f83981ae0086d6f58d855e7550b2748fba",
    },
    KnownRelease {
        modworkshop_id: 44048,
        version: "0.4.0",
        proxy: "dxgi.dll",
        proxy_sha256: "c777f8bfd44240bcd720b850f6ffc88fed5d955c9f0b17446bb69b01be3e9d4a",
    },
];

/// Sub-mod folders a release ships inside its own Mods directory. They look exactly like a
/// user's mod, so replacement has to know them by name to leave everything else alone.
/// Verified against both packages; the union, because a replacement clears whichever the
/// installed release left behind.
const BUNDLED_SUBMODS: &[&str] = &[
    "ActorDumperMod",
    "AllowModsMod",
    "BPML_GenericFunctions",
    "BPModLoaderMod",
    "CheatManagerEnablerMod",
    "ConsoleCommandsMod",
    "ConsoleEnablerMod",
    "HideHUDMod",
    "Keybinds",
    "LineTraceMod",
    "SplitScreenMod",
    "jsbLuaProfilerMod",
    "shared",
];

/// Files a release owns at the root of whichever directory its layout uses. Everything else
/// there belongs to the game or the user.
const LOADER_ROOT_FILES: &[&str] = &[
    "UE4SS.dll",
    "UE4SS.log",
    "UE4SS.pdb",
    "UE4SS-settings.ini",
    "MemberVariableLayout.ini",
    "VTableLayout.ini",
    "imgui.ini",
];

/// Directories a release owns beside those files.
const LOADER_ROOT_DIRS: &[&str] = &["UE4SS_Signatures", "watches"];

/// The build this game ships for one storefront: where it installs and what proves it is
/// already there.
struct Ue4ssBuild {
    proxy_dlls: &'static [String],
    binaries: &'static [String],
}

fn descriptor_for(game_id: &str, launcher: Option<&str>) -> Option<Ue4ssBuild> {
    let storefront = storefront(launcher)?;
    let (_, pkg) = crate::games::discovered()
        .iter()
        .find(|(id, _)| *id == game_id)?;
    pkg.loaders.iter().find_map(|binding| match binding {
        LoaderBinding::Ue4ss {
            storefronts,
            proxy_dlls,
            install_into,
            store_install_into,
            ..
        } if storefronts.contains(&storefront) => Some(Ue4ssBuild {
            proxy_dlls,
            binaries: store_install_into
                .iter()
                .find(|o| o.store == storefront)
                .map_or(install_into, |o| &o.install_into),
        }),
        _ => None,
    })
}

fn binaries_dir(game_path: &str, descriptor: &Ue4ssBuild) -> PathBuf {
    descriptor
        .binaries
        .iter()
        .fold(Path::new(game_path).to_path_buf(), |acc, part| {
            acc.join(part)
        })
}

/// What is actually installed, as far as the files can prove it.
#[derive(Debug, Default, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoaderPresence {
    /// A proxy DLL under one of the names a release uses is present.
    pub installed: bool,
    /// The release whose proxy bytes match, when one does.
    pub modworkshop_id: Option<i64>,
    pub version: Option<String>,
    /// Proxy-named files present whose bytes match no known release. Something else may own
    /// them, so they are named rather than assumed away.
    pub unrecognized: Vec<String>,
}

fn identify_release(dir: &Path, name: &str) -> Option<&'static KnownRelease> {
    let hash = hash_file(&dir.join(name)).ok().flatten()?;
    releases()
        .iter()
        .find(|r| r.proxy == name && r.proxy_sha256 == hash)
}

/// Reports the loader's presence and, where the bytes allow it, which release.
///
/// A proxy DLL that matches no known release still counts as installed: something is hooked
/// in under a name a release uses, and reporting it as absent would offer an install that
/// would collide with it. The caller must have resolved the launcher already.
pub(crate) fn presence(game_id: &str, game_path: &str, launcher: Option<&str>) -> LoaderPresence {
    let Some(descriptor) = descriptor_for(game_id, launcher) else {
        return LoaderPresence::default();
    };
    let dir = binaries_dir(game_path, &descriptor);
    let mut found = LoaderPresence::default();
    for name in descriptor.proxy_dlls {
        if !dir.join(name).is_file() {
            continue;
        }
        found.installed = true;
        match identify_release(&dir, name) {
            Some(release) => {
                found.modworkshop_id = Some(release.modworkshop_id);
                found.version = Some(release.version.to_string());
            }
            None => found.unrecognized.push(name.clone()),
        }
    }
    found
}

pub(crate) fn is_installed(game_id: &str, game_path: &str, launcher: Option<&str>) -> bool {
    presence(game_id, game_path, launcher).installed
}

/// Everything the installed release owns, as paths under the Binaries directory.
///
/// Only files a release is known to place are listed, so an overlay or injector sharing the
/// directory is never moved.
fn owned_paths(dir: &Path, proxy_dlls: &[String]) -> Vec<PathBuf> {
    // Both roots are checked because the two shipped layouts disagree on where everything but
    // the proxy DLL lives: the UE4 package puts the engine, its ini files and Mods at the
    // Binaries root, and the UE5 package puts all three inside a UE4SS folder of its own.
    let roots = [dir.to_path_buf(), dir.join("UE4SS")];
    let mut owned = claimed_proxies(dir, proxy_dlls, &roots);
    for root in &roots {
        for name in LOADER_ROOT_FILES {
            let path = root.join(name);
            if path.is_file() {
                owned.push(path);
            }
        }
        for name in LOADER_ROOT_DIRS {
            let path = root.join(name);
            if path.is_dir() {
                owned.push(path);
            }
        }
        let mods = root.join("Mods");
        let txt = mods.join("mods.txt");
        if txt.is_file() {
            owned.push(txt);
        }
        for name in BUNDLED_SUBMODS {
            let path = mods.join(name);
            if path.is_dir() {
                owned.push(path);
            }
        }
    }
    owned
}

/// The proxy DLLs in this directory that UE4SS put there.
///
/// Bytes settle it whenever they can. When they cannot, one unrecognised proxy standing in a
/// directory that also holds a UE4SS engine is UE4SS's: a proxy is the only reason UE4SS puts
/// a DLL under one of these names, and leaving it behind is what leaves the old build hooked
/// into the game after its engine is gone. Two unrecognised proxies is a different situation,
/// because ReShade and Special K use these names too, and nothing here can say which is which,
/// so neither is claimed and presence reports both as unrecognised instead.
fn claimed_proxies(dir: &Path, proxy_dlls: &[String], roots: &[PathBuf]) -> Vec<PathBuf> {
    let present: Vec<&String> = proxy_dlls
        .iter()
        .filter(|name| dir.join(name).is_file())
        .collect();
    let identified: Vec<&&String> = present
        .iter()
        .filter(|name| identify_release(dir, name).is_some())
        .collect();
    if !identified.is_empty() {
        return identified.iter().map(|name| dir.join(**name)).collect();
    }
    let engine_here = roots.iter().any(|root| root.join("UE4SS.dll").is_file());
    match present.as_slice() {
        [only] if engine_here => vec![dir.join(only)],
        _ => Vec::new(),
    }
}

/// Every file under root, as paths relative to it.
fn files_under(root: &Path, prefix: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root.join(prefix)) else {
        return;
    };
    for entry in entries.flatten() {
        let rel = prefix.join(entry.file_name());
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => files_under(root, &rel, out),
            Ok(kind) if kind.is_file() => out.push(rel),
            _ => {}
        }
    }
}

/// Whether a destination path is one the installed release owns, either directly or by
/// sitting inside a directory it owns.
fn is_owned(path: &Path, owned: &[PathBuf]) -> bool {
    owned.iter().any(|o| path == o || path.starts_with(o))
}

/// Mod folders under either layout that no release ships, so they are the user's.
fn user_mod_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for mods in [dir.join("Mods"), dir.join("UE4SS").join("Mods")] {
        let Ok(entries) = std::fs::read_dir(&mods) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_dir() && !BUNDLED_SUBMODS.contains(&name.as_str()) {
                found.push(entry.path());
            }
        }
    }
    found
}

fn relative_names(paths: &[PathBuf], base: &Path) -> Vec<String> {
    let mut names: Vec<String> = paths
        .iter()
        .map(|p| {
            p.strip_prefix(base)
                .unwrap_or(p)
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    names.sort();
    names
}

/// What installing a UE4SS release over the current one would change.
///
/// Conflicts are not here: whether a package would write over something unattributable can
/// only be known once that package is in hand, and the replacement refuses by naming them.
/// This is what can be shown before the user commits to the download.
#[derive(Debug, Default, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementPlan {
    /// Loader files the replacement removes.
    pub replaced: Vec<String>,
    /// Mod folders the user added, by name. They are kept, and moved into the incoming
    /// release's Mods folder when its layout puts that somewhere else.
    pub preserved: Vec<String>,
}

/// Where the loader lives for this game and storefront, and the names its proxy can appear
/// under. Ownership needs both, so they are resolved together rather than re-derived.
fn resolve_build(
    game_id: &str,
    game_path: &str,
    launcher: Option<&str>,
) -> Result<(PathBuf, &'static [String]), String> {
    let Some(descriptor) = descriptor_for(game_id, launcher) else {
        return Err(
            "UE4SS isn't supported yet for this game and launcher combination.".to_string(),
        );
    };
    Ok((binaries_dir(game_path, &descriptor), descriptor.proxy_dlls))
}

/// Reports what a replacement would change, without changing anything. Reads the same
/// ownership rules the replacement applies, so what the user is shown is what will happen.
pub(crate) fn plan_replacement(
    game_id: &str,
    game_path: &str,
    launcher: Option<&str>,
) -> Result<ReplacementPlan, String> {
    let (dest, proxies) = resolve_build(game_id, game_path, launcher)?;
    let mut preserved: Vec<String> = user_mod_dirs(&dest)
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    preserved.sort();
    Ok(ReplacementPlan {
        replaced: relative_names(&owned_paths(&dest, proxies), &dest),
        preserved,
    })
}

/// The package unpacked somewhere harmless, so what it holds and what it would write over are
/// both known before the installation is touched. A package is never extracted over a working
/// loader.
struct Staging {
    root: PathBuf,
    files: Vec<PathBuf>,
}

impl Staging {
    fn extract(zip_path: &Path) -> Result<Self, String> {
        let root = std::env::temp_dir().join(format!("modrex-ue4ss-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let mut staged = Self {
            root,
            files: Vec::new(),
        };
        extract_loader_package(zip_path, &staged.root)
            .map_err(|e| format!("this UE4SS download could not be read: {e}"))?;
        files_under(&staged.root, Path::new(""), &mut staged.files);
        if !staged
            .files
            .iter()
            .any(|f| f.file_name().and_then(|n| n.to_str()) == Some("UE4SS.dll"))
        {
            return Err("this download does not contain UE4SS.".to_string());
        }
        Ok(staged)
    }

    /// Destination paths this package would write that the installed release does not own.
    fn conflicts(&self, dest: &Path, owned: &[PathBuf]) -> Vec<PathBuf> {
        self.files
            .iter()
            .map(|rel| dest.join(rel))
            .filter(|path| path.exists() && !is_owned(path, owned))
            .collect()
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Where this package puts sub-mods, under the destination.
///
/// The two shipped layouts disagree: the UE4 package's Mods folder sits at the Binaries root
/// and the UE5 package's sits inside its own UE4SS folder. A replacement that crosses layouts
/// has to move the user's mods into the incoming one, or the new loader reads an empty folder
/// while their mods sit in the old release's.
fn staged_mods_root(staging: &Staging, dest: &Path) -> Option<PathBuf> {
    let mut shallowest: Option<&Path> = None;
    for rel in &staging.files {
        let mut dir = rel.parent();
        while let Some(current) = dir {
            if current.file_name().and_then(|n| n.to_str()) == Some("Mods")
                && shallowest
                    .is_none_or(|best| current.components().count() < best.components().count())
            {
                shallowest = Some(current);
            }
            dir = current.parent();
        }
    }
    shallowest.map(|rel| dest.join(rel))
}

/// The installed release moved aside so a failed replacement can put it back.
///
/// Its directory is named per attempt rather than reused: an attempt that could not restore
/// everything left the only copy of those files in its own, and clearing a fixed name would
/// destroy exactly the recovery data someone still needs.
struct Backup {
    root: PathBuf,
    moved: Vec<(PathBuf, PathBuf)>,
}

impl Backup {
    fn stage(dir: &Path, owned: &[PathBuf]) -> Result<Self, String> {
        let root = dir.with_file_name(format!(
            "{}.modrex-loader-backup-{}",
            dir.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Binaries"),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).map_err(|e| {
            format!("the previous loader could not be set aside for a safe replacement: {e}")
        })?;
        let mut backup = Self {
            root,
            moved: Vec::new(),
        };
        for (index, path) in owned.iter().enumerate() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("item");
            let to = backup.root.join(format!("{index}_{name}"));
            let Err(e) = std::fs::rename(path, &to) else {
                backup.moved.push((path.clone(), to));
                continue;
            };
            // Half the installation is set aside and half is not, so what already moved goes
            // back before this reports, or the caller is left holding neither.
            let stranded = backup.restore();
            let failure = format!("'{name}' could not be set aside for a safe replacement: {e}");
            return Err(if stranded.is_empty() {
                failure
            } else {
                format!(
                    "{failure}; and putting the rest back failed, so these are still set aside: {}",
                    stranded.join(", ")
                )
            });
        }
        Ok(backup)
    }

    /// Puts everything back, naming whatever it could not, so a caller reports where the files
    /// actually are rather than claiming a restore it did not achieve.
    ///
    /// The directory itself goes only once it holds nothing: anything left in it is the sole
    /// copy of a file that could not be put back, which is exactly what someone recovering by
    /// hand needs to still be there.
    fn restore(&self) -> Vec<String> {
        let mut stranded = Vec::new();
        for (original, stored) in &self.moved {
            if let Some(parent) = original.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::rename(stored, original) {
                stranded.push(format!("{} ({e})", stored.display()));
            }
        }
        if stranded.is_empty() {
            let _ = std::fs::remove_dir_all(&self.root);
        }
        stranded
    }

    fn discard(self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Why a replacement did not finish, and whether the installation moved.
#[derive(Debug)]
pub(crate) enum LoaderError {
    /// Nothing changed, or everything that changed was put back.
    Unchanged(String),
    /// The loader is installed; something after it failed.
    Installed(String),
}

impl LoaderError {
    pub(crate) fn message(self) -> String {
        match self {
            Self::Unchanged(m) | Self::Installed(m) => m,
        }
    }
}

/// Copies the staged package into place, remembering every path it creates so a failure can
/// take all of them back out.
fn place(staging: &Staging, dest: &Path) -> Result<(), (String, Vec<PathBuf>)> {
    let mut created = Vec::new();
    for rel in &staging.files {
        let to = dest.join(rel);
        if let Some(parent) = to.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return Err((e.to_string(), created));
            }
        }
        if let Err(e) = std::fs::copy(staging.root.join(rel), &to) {
            return Err((e.to_string(), created));
        }
        created.push(to);
    }
    Ok(())
}

/// Entries in an existing mods.txt that name something the user added.
///
/// A release ships its own mods.txt listing only its bundled sub-mods, so writing it over the
/// installed one would drop every enable and disable the user set for their own mods. A file
/// that is not there carries nothing; one that cannot be read is a failure, not an absence.
///
/// A path whose parent is a file rather than a directory is absence too, and the platforms
/// disagree on how they say so: Windows reports it as NotFound, Unix as NotADirectory. Both
/// mean this file cannot be there, so both carry nothing rather than failing the replacement.
fn user_mods_txt_entries(path: &Path) -> Result<Vec<String>, String> {
    use std::io::ErrorKind;
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            return Ok(Vec::new())
        }
        Err(e) => return Err(format!("{} could not be read: {e}", path.display())),
    };
    Ok(content
        .lines()
        .filter(|line| {
            super::mods::ue4ss_entry_name(line).is_some_and(|n| !BUNDLED_SUBMODS.contains(&n))
        })
        .map(str::to_string)
        .collect())
}

fn append_missing_entries(path: &Path, entries: &[String]) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let existing = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let known: Vec<&str> = existing
        .lines()
        .filter_map(super::mods::ue4ss_entry_name)
        .collect();
    let eol = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut out = existing.clone();
    if !out.ends_with('\n') {
        out.push_str(eol);
    }
    for entry in entries {
        let Some(name) = super::mods::ue4ss_entry_name(entry) else {
            continue;
        };
        if known.contains(&name) {
            continue;
        }
        out.push_str(entry.trim_end());
        out.push_str(eol);
    }
    std::fs::write(path, out).map_err(|e| e.to_string())
}

/// Replaces the installed UE4SS with the one in this package, keeping the user's own Lua mods
/// and their entries in mods.txt.
///
/// A loader is never recorded in state.json, so this is the only operation that knows what the
/// previous install consisted of. It has to remove that install rather than extract over it:
/// the two shipped layouts put the engine in different places, so extraction alone would leave
/// the old proxy DLL loading the old engine beside the new one.
///
/// Nothing is removed that is not identified as belonging to a release, and a file the package
/// would write over that nothing can attribute is refused rather than overwritten.
///
/// A release's own configuration files are replaced, not merged: each ships the ini files its
/// build reads, and carrying an older one forward is how a loader stops working. What is
/// preserved is the user's: their mod folders, and their entries in mods.txt.
pub(crate) fn install_loader(
    game_id: &str,
    game_path: &str,
    launcher: Option<&str>,
    zip_path: &Path,
) -> Result<(), LoaderError> {
    let (dest, proxies) =
        resolve_build(game_id, game_path, launcher).map_err(LoaderError::Unchanged)?;
    let staging = Staging::extract(zip_path).map_err(LoaderError::Unchanged)?;

    let owned = owned_paths(&dest, proxies);
    let conflicts = staging.conflicts(&dest, &owned);
    if !conflicts.is_empty() {
        return Err(LoaderError::Unchanged(format!(
            "these files are already there and did not come from a UE4SS release, so they are not Modrex's to replace: {}",
            relative_names(&conflicts, &dest).join(", ")
        )));
    }

    let carried = [dest.join("Mods"), dest.join("UE4SS").join("Mods")]
        .iter()
        .map(|mods| user_mods_txt_entries(&mods.join("mods.txt")))
        .collect::<Result<Vec<_>, _>>()
        .map_err(LoaderError::Unchanged)?
        .concat();

    let backup = Backup::stage(&dest, &owned).map_err(LoaderError::Unchanged)?;
    if let Err((failure, created)) = place(&staging, &dest) {
        // Everything this attempt wrote comes back out before the previous install goes back
        // in, or the two end up layered on each other.
        let mut stranded: Vec<String> = created
            .iter()
            .filter(|path| path.exists())
            .filter_map(|path| {
                std::fs::remove_file(path)
                    .err()
                    .map(|e| format!("{} ({e})", path.display()))
            })
            .collect();
        stranded.extend(backup.restore());
        return Err(LoaderError::Unchanged(if stranded.is_empty() {
            format!("UE4SS could not be installed ({failure}); the previous one was put back")
        } else {
            format!(
                "UE4SS could not be installed ({failure}), and undoing that failed, so these need attention: {}",
                stranded.join(", ")
            )
        }));
    }

    backup.discard();

    // From here the new loader is in place, so nothing that follows can be undone. Each step
    // carries something of the user's across and reports what it could not, rather than
    // reporting a clean install over a setup that half survived.
    let mods_root = staged_mods_root(&staging, &dest);
    let mut unfinished = match &mods_root {
        Some(root) => adopt_user_mods(&dest, root),
        None => Vec::new(),
    };
    let merged = mods_root
        .map(|root| root.join("mods.txt"))
        .filter(|txt| txt.is_file())
        .map(|txt| append_missing_entries(&txt, &carried));
    if let Some(Err(e)) = merged {
        unfinished.push(format!("their entries in the loader's mod list ({e})"));
    }
    if unfinished.is_empty() {
        return Ok(());
    }
    Err(LoaderError::Installed(format!(
        "UE4SS was installed, but some of what was yours did not come across, so check it: {}",
        unfinished.join("; ")
    )))
}

/// Removes the installed release, keeping the user's own mods and their entries in mods.txt.
///
/// Only what a release is known to own goes, so a mod folder the user added stays where it is
/// and an overlay sharing the directory is never touched. Nothing is set aside first: there is
/// no new install to roll back to, and a partial removal reports which files are still there
/// rather than claiming the loader is gone.
pub(crate) fn uninstall(
    game_id: &str,
    game_path: &str,
    launcher: Option<&str>,
) -> Result<(), String> {
    let (dest, proxies) = resolve_build(game_id, game_path, launcher)?;
    let owned = owned_paths(&dest, proxies);
    if owned.is_empty() {
        return Err(format!(
            "Modrex could not tell which files here are UE4SS's, so it will not delete any of them. Remove it by hand from {}.",
            dest.display()
        ));
    }
    let failed: Vec<String> = owned
        .iter()
        .filter_map(|path| {
            let removed = if path.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
            removed.err().map(|e| format!("{} ({e})", path.display()))
        })
        .collect();
    if failed.is_empty() {
        return Ok(());
    }
    Err(format!(
        "UE4SS was partly removed. These are still there, so check them before installing another: {}",
        failed.join(", ")
    ))
}

/// Moves the user's own mod folders into the incoming release's Mods folder, naming the ones
/// that could not be moved.
///
/// A folder already sitting there is left where it is. One whose name is taken there is not
/// overwritten: two folders under one name are two different mods, and the replacement is not
/// the place to decide which the user meant.
fn adopt_user_mods(dest: &Path, mods_root: &Path) -> Vec<String> {
    let mut failed = Vec::new();
    for dir in user_mod_dirs(dest) {
        if dir.parent() == Some(mods_root) {
            continue;
        }
        let name = dir
            .file_name()
            .expect("a directory listed from the filesystem has a name");
        let to = mods_root.join(name);
        if to.exists() {
            failed.push(format!(
                "{} (a mod under that name is already in the new loader's Mods folder)",
                dir.display()
            ));
            continue;
        }
        if let Err(e) = std::fs::rename(&dir, &to) {
            failed.push(format!("{} ({e})", dir.display()));
        }
    }
    failed
}

#[cfg(test)]
#[path = "ue4ss_tests.rs"]
mod tests;
