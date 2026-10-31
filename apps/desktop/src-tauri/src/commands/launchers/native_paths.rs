//! The game's own file list in a store-neutral form, built from whichever store record
//! describes the selected installation.

use crate::commands::path_display::display_path;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) const MAX_PATH_BYTES: usize = 4096;

/// Paths relative to the game root that belong to the installed build.
#[derive(Clone, Debug)]
pub(crate) struct NativePaths {
    pub paths: BTreeSet<String>,
    #[cfg(windows)]
    windows_paths: Vec<Vec<u16>>,
    #[cfg(windows)]
    has_windows_unicode_paths: bool,
}

impl NativePaths {
    /// Takes normalized paths mapped to their spelling in the store record.
    pub(super) fn new(files: BTreeMap<String, String>) -> Result<Self, String> {
        if files.is_empty() {
            return Err("The native-file catalog contains no files".into());
        }
        reject_file_ancestors(&files)?;
        #[cfg(windows)]
        validate_windows_paths(files.values().map(|path| (path.as_str(), false)))?;
        Ok(Self {
            #[cfg(windows)]
            windows_paths: files
                .values()
                .map(|path| path.encode_utf16().collect())
                .collect(),
            #[cfg(windows)]
            has_windows_unicode_paths: files.values().any(|path| !path.is_ascii()),
            paths: files.into_keys().collect(),
        })
    }

    pub(crate) fn protects(&self, relative: &Path) -> Result<bool, String> {
        let path = relative
            .to_str()
            .ok_or("Native-file query contains a non-UTF-8 path")?;
        let normalized = normalize_native_path(path)?;
        #[cfg(windows)]
        if !path.is_ascii() || self.has_windows_unicode_paths {
            return self.windows_native_query(path, false);
        }
        Ok(self.paths.contains(&normalized))
    }

    pub(crate) fn protects_tree(&self, relative: &Path) -> Result<bool, String> {
        let path = relative
            .to_str()
            .ok_or("Native-file query contains a non-UTF-8 path")?;
        let normalized = normalize_native_path(path)?;
        #[cfg(windows)]
        if !path.is_ascii() || self.has_windows_unicode_paths {
            return self.windows_native_query(path, true);
        }
        let prefix = format!("{normalized}/");
        Ok(self.paths.contains(&normalized)
            || self
                .paths
                .range(prefix.clone()..)
                .next()
                .is_some_and(|path| path.starts_with(&prefix)))
    }

    #[cfg(windows)]
    fn windows_native_query(&self, path: &str, descendants: bool) -> Result<bool, String> {
        let query: Vec<u16> = path.replace('\\', "/").encode_utf16().collect();
        for native in &self.windows_paths {
            if windows_path_order(native, &query)? == std::cmp::Ordering::Equal {
                return Ok(true);
            }
            if descendants
                && native.get(query.len()) == Some(&u16::from(b'/'))
                && windows_path_order(&native[..query.len()], &query)? == std::cmp::Ordering::Equal
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// A store record the file list was built from, rechecked before every change.
#[derive(Clone, Debug)]
pub(super) struct CatalogSource {
    pub path: PathBuf,
    digest: [u8; 32],
    limit: usize,
}

impl CatalogSource {
    pub(super) fn new(path: PathBuf, bytes: &[u8], limit: usize) -> Self {
        Self {
            path,
            digest: Sha256::digest(bytes).into(),
            limit,
        }
    }

    pub(super) fn verify_unchanged(&self) -> Result<(), String> {
        let bytes = read_bounded(&self.path, self.limit)?;
        if <[u8; 32]>::from(Sha256::digest(&bytes)) != self.digest {
            return Err(format!(
                "The game's native-file catalog changed during the operation: {}",
                display_path(&self.path)
            ));
        }
        Ok(())
    }
}

pub(super) fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| {
        format!(
            "Could not read native-file catalog source {}: {e}",
            display_path(path)
        )
    })?;
    if !file
        .metadata()
        .map_err(|e| {
            format!(
                "Could not inspect native-file catalog source {}: {e}",
                display_path(path)
            )
        })?
        .is_file()
    {
        return Err(format!(
            "Native-file catalog source is not a file: {}",
            display_path(path)
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| {
            format!(
                "Could not read native-file catalog source {}: {e}",
                display_path(path)
            )
        })?;
    if bytes.len() > limit {
        return Err(format!(
            "Native-file catalog source exceeds its byte limit: {}",
            display_path(path)
        ));
    }
    Ok(bytes)
}

pub(super) fn normalize_native_path(path: &str) -> Result<String, String> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err("Native path is empty or exceeds the path length limit".into());
    }
    let path = path.replace('\\', "/");
    for component in path.split('/') {
        if component.is_empty()
            || matches!(component, "." | "..")
            || component.len() > 255
            || component.ends_with(['.', ' '])
            || component
                .chars()
                .any(|c| c.is_control() || ":*?\"<>|".contains(c))
        {
            return Err(format!("Unsafe native path: {path}"));
        }
        let stem = component
            .split('.')
            .next()
            .expect("A component always has a stem")
            .trim_end_matches(' ');
        let upper = stem.to_ascii_uppercase();
        let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ["COM", "LPT"].iter().any(|prefix| {
                upper.strip_prefix(prefix).is_some_and(|suffix| {
                    matches!(
                        suffix,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
        if reserved {
            return Err(format!(
                "Native path contains a reserved device name: {path}"
            ));
        }
    }
    Ok(path.to_lowercase())
}

fn reject_file_ancestors(files: &BTreeMap<String, String>) -> Result<(), String> {
    for path in files.keys() {
        for (position, _) in path.match_indices('/') {
            if files.contains_key(&path[..position]) {
                return Err(format!("Native file is also a parent directory: {path}"));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn windows_path_order(
    left: &[u16],
    right: &[u16],
) -> Result<std::cmp::Ordering, String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CompareStringOrdinal(
            string1: *const u16,
            count1: i32,
            string2: *const u16,
            count2: i32,
            ignore_case: i32,
        ) -> i32;
    }
    // Windows ordinal comparison differs from Rust's contextual Unicode lowercase
    // mapping, so a lowercase string key alone can miss native filename aliases.
    let result = unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        )
    };
    match result {
        1 => Ok(std::cmp::Ordering::Less),
        2 => Ok(std::cmp::Ordering::Equal),
        3 => Ok(std::cmp::Ordering::Greater),
        _ => Err(format!(
            "Could not compare native Windows paths: {}",
            std::io::Error::last_os_error()
        )),
    }
}

#[cfg(windows)]
pub(crate) fn sort_windows_paths<T>(paths: &mut [(Vec<u16>, T)]) -> Result<(), String> {
    let mut failure = None;
    paths.sort_unstable_by(
        |(left, _), (right, _)| match windows_path_order(left, right) {
            Ok(order) => order,
            Err(error) => {
                failure = Some(error);
                left.cmp(right)
            }
        },
    );
    failure.map_or(Ok(()), Err)
}

#[cfg(windows)]
pub(super) fn validate_windows_paths<'a>(
    paths: impl Iterator<Item = (&'a str, bool)>,
) -> Result<(), String> {
    let paths: Vec<_> = paths.collect();
    if paths.iter().all(|(path, _)| path.is_ascii()) {
        return Ok(());
    }
    let mut paths: Vec<_> = paths
        .into_iter()
        .map(|(path, directory)| (path.encode_utf16().collect::<Vec<_>>(), directory))
        .collect();
    sort_windows_paths(&mut paths)?;
    for pair in paths.windows(2) {
        if windows_path_order(&pair[0].0, &pair[1].0)? == std::cmp::Ordering::Equal {
            return Err("Native paths contain a Windows ordinal case collision".into());
        }
    }
    for (path, _) in &paths {
        for (position, _) in path
            .iter()
            .enumerate()
            .filter(|(_, c)| **c == u16::from(b'/'))
        {
            let mut failure = None;
            let found = paths.binary_search_by(|(candidate, _)| {
                match windows_path_order(candidate, &path[..position]) {
                    Ok(order) => order,
                    Err(error) => {
                        failure = Some(error);
                        std::cmp::Ordering::Equal
                    }
                }
            });
            if let Some(error) = failure {
                return Err(error);
            }
            if found.is_ok_and(|index| !paths[index].1) {
                return Err("Native file is also a Windows ordinal parent directory".into());
            }
        }
    }
    Ok(())
}
