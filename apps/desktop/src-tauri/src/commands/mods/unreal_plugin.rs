//! Unreal plugin mods, the format PAYDAY 3's PDML loader reads from PAYDAY3/Mods/.
//!
//! One mod is one folder holding Name.uplugin and its packaged containers:
//!
//!     Name/Name.uplugin
//!     Name/Content/Paks/Windows/Name_P.{pak,utoc,ucas}
//!     Name/Content/Paks/WinGDK/Name_P.{pak,utoc,ucas}    (byte copies for the Store build)
//!     Name/Resources/Icon128.png
//!
//! Unreal names a plugin after its descriptor, never its folder, and stops searching below a
//! folder that holds one. Everything here follows the same rules, so Modrex sees the plugins
//! the game loads.

use std::path::{Path, PathBuf};

const DESCRIPTOR_EXTENSION: &str = "uplugin";

/// The container the package viewer opens.
pub(crate) const CONTAINER_EXTENSION: &str = "pak";

const CONTAINER_EXTENSIONS: &[&str] = &["pak", "utoc", "ucas"];

/// What Steam and Epic mount. The Store build mounts WinGDK, a byte copy.
const DESKTOP_PLATFORM: &str = "Windows";

fn has_extension(name: &str, extension: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(extension))
}

/// Unreal matches the suffix case-sensitively, so Name.UPLUGIN is no plugin to the game.
fn is_descriptor(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e == DESCRIPTOR_EXTENSION)
}

/// The descriptor directly inside dir, the first by name when there are several.
pub(crate) fn descriptor_in(dir: &Path) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_descriptor)
        })
        .collect();
    found.sort();
    found.into_iter().next()
}

pub(crate) fn is_plugin_dir(dir: &Path) -> bool {
    descriptor_in(dir).is_some()
}

/// Whether the game loads a plugin of this name from dir or below it.
pub(crate) fn plugin_installed(dir: &Path, name: &str) -> bool {
    if let Some(descriptor) = descriptor_in(dir) {
        let stem = descriptor.file_stem().and_then(|s| s.to_str());
        return stem.is_some_and(|s| s.eq_ignore_ascii_case(name));
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .any(|entry| plugin_installed(&entry.path(), name))
}

/// The file identification hashes: the desktop .utoc, else the .pak. An IoStore plugin's pak
/// can stay byte-identical across releases, its utoc cannot.
pub(crate) fn identifying_container(plugin_dir: &Path) -> Option<PathBuf> {
    ["utoc", CONTAINER_EXTENSION]
        .iter()
        .find_map(|extension| container(plugin_dir, extension))
}

/// Copies files from a previous copy of a plugin that the copy at dest lacks. Packaged
/// containers and descriptors never carry over, because a container the new release dropped
/// would keep mounting beside it.
pub(crate) fn carry_user_files(previous: &Path, dest: &Path) -> std::io::Result<()> {
    carry_below(previous, dest, Path::new(""))
}

fn carry_below(previous: &Path, dest: &Path, rel: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(previous.join(rel))? {
        let entry = entry?;
        let rel = rel.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            if is_packaged_dir(&rel) {
                continue;
            }
            carry_below(previous, dest, &rel)?;
            continue;
        }
        let at_root = rel.parent().is_some_and(|p| p.as_os_str().is_empty());
        let name = entry.file_name();
        if at_root && name.to_str().is_some_and(is_descriptor) {
            continue;
        }
        let target = dest.join(&rel);
        if target.exists() {
            continue;
        }
        std::fs::create_dir_all(target.parent().expect("rel has a file name"))?;
        std::fs::copy(entry.path(), target)?;
    }
    Ok(())
}

/// Content/Paks relative to a plugin root, in any case.
fn is_packaged_dir(rel: &Path) -> bool {
    let parts: Vec<_> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    matches!(parts.as_slice(), [content, paks] if content.eq_ignore_ascii_case("Content") && paks.eq_ignore_ascii_case("Paks"))
}

/// The plugin's container with this extension, preferring the desktop platform folder. Unreal
/// mounts every container below Content/Paks/<platform>, at any depth.
pub(crate) fn container(plugin_dir: &Path, extension: &str) -> Option<PathBuf> {
    let paks = child_dir(&child_dir(plugin_dir, "Content")?, "Paks")?;
    let mut platforms = subdirs(&paks);
    platforms.sort_by_key(|dir| {
        let desktop = dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case(DESKTOP_PLATFORM));
        (!desktop, dir.clone())
    });
    platforms
        .iter()
        .find_map(|dir| first_file_below(dir, extension))
}

/// Matched ignoring case, which the archive's own spelling may not share on a case-sensitive
/// filesystem.
fn child_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    subdirs(dir).into_iter().find(|child| {
        child
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case(name))
    })
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .map(|entry| entry.path())
        .collect();
    dirs.sort();
    dirs
}

/// Files in dir before its subfolders, each level in name order.
fn first_file_below(dir: &Path, extension: &str) -> Option<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| has_extension(n, extension))
        })
        .collect();
    files.sort();
    files.into_iter().next().or_else(|| {
        subdirs(dir)
            .iter()
            .find_map(|sub| first_file_below(sub, extension))
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ArchivePlugin {
    /// Slash separated, empty for the archive root.
    pub root: String,
    /// The descriptor stem, also the installed folder name.
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArchivePlugins {
    None,
    Packaged(Vec<ArchivePlugin>),
    /// Descriptors without packaged containers, an author's source project the game cannot load.
    SourceOnly,
}

/// names are slash separated, with directories ending in a slash.
pub(crate) fn plugins_in_archive(names: &[String]) -> ArchivePlugins {
    let mut descriptors: Vec<ArchivePlugin> = names
        .iter()
        .filter(|name| !name.ends_with('/') && is_descriptor(name))
        .filter_map(|name| {
            let (root, file) = name.rsplit_once('/').unwrap_or(("", name.as_str()));
            let stem = Path::new(file).file_stem()?.to_str()?;
            is_plain_name(stem).then(|| ArchivePlugin {
                root: root.to_string(),
                name: stem.to_string(),
            })
        })
        .collect();
    if descriptors.is_empty() {
        return ArchivePlugins::None;
    }
    // Unreal stops descending at a folder holding a descriptor, so one nested inside another
    // plugin is never loaded on its own.
    let roots: Vec<String> = descriptors.iter().map(|d| d.root.clone()).collect();
    descriptors.retain(|d| !roots.iter().any(|outer| encloses(outer, &d.root)));
    descriptors.sort_by(|a, b| a.root.cmp(&b.root).then(a.name.cmp(&b.name)));
    descriptors.dedup_by(|a, b| a.root == b.root);

    let packaged: Vec<ArchivePlugin> = descriptors
        .into_iter()
        .filter(|plugin| {
            let paks = join(&plugin.root, "Content/Paks/").to_ascii_lowercase();
            names.iter().any(|name| {
                let lower = name.to_ascii_lowercase();
                // Unreal mounts containers from a platform folder, never from Paks itself.
                lower
                    .strip_prefix(&paks)
                    .is_some_and(|rest| rest.contains('/') && !rest.ends_with('/'))
                    && CONTAINER_EXTENSIONS.iter().any(|e| has_extension(name, e))
            })
        })
        .collect();
    if packaged.is_empty() {
        return ArchivePlugins::SourceOnly;
    }
    ArchivePlugins::Packaged(packaged)
}

/// The name becomes a folder under the staging and mods directories, so it must be one plain
/// component. A descriptor named ...uplugin has the stem .., which would escape both.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':') || c.is_control())
}

/// Whether an archive entry belongs to one of these plugins.
pub(crate) fn inside_any(plugins: &[ArchivePlugin], entry_name: &str) -> bool {
    plugins.iter().any(|plugin| {
        plugin.root.is_empty() || entry_name.starts_with(&format!("{}/", plugin.root))
    })
}

fn join(root: &str, rest: &str) -> String {
    if root.is_empty() {
        rest.to_string()
    } else {
        format!("{root}/{rest}")
    }
}

/// The archive root encloses every other folder.
fn encloses(outer: &str, inner: &str) -> bool {
    if outer == inner {
        return false;
    }
    outer.is_empty() || inner.starts_with(&format!("{outer}/"))
}

#[cfg(test)]
#[path = "unreal_plugin_tests.rs"]
mod tests;
