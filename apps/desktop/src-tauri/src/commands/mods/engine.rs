pub use crate::game_package::{Activation, DecoderBinding, ModMetadata};
use std::path::PathBuf;

pub enum ModUnit {
    File {
        extension: &'static str,
        disabled_suffix: &'static str,
        priority_prefix: bool,
    },
    Directory {
        /// Markers used to recognise mod directories inside a ZIP during install classification.
        entry_markers: &'static [&'static str],
        /// Markers that unconditionally promote a directory to a mod during the ambient scan.
        scan_markers: &'static [&'static str],
        /// Like scan_markers, but the directory is only tracked if its SHA256 matches the
        /// index. Unidentified entries are dropped as loader framework internals, not user
        /// mods. Use when a marker (e.g. base.lua) is shared between framework modules and
        /// genuinely installable mods that only the mod index can tell apart.
        index_gated_markers: &'static [&'static str],
        /// Directory names the ambient scan must never treat as a user mod even though they
        /// match scan_markers or entry_markers, being known bundled framework internals
        /// shipped alongside installable content. Use when index_gated_markers cannot apply
        /// because the bundled files are never hashed into the mod index, as with UE4SS's
        /// own framework sub-mods under Mods/, which are .lua scripts rather than .pak files.
        excluded_names: &'static [&'static str],
        priority_prefix: bool,
    },
}

pub struct ScanTarget {
    pub tag: &'static str,
    pub label_key: &'static str,
    pub unit: ModUnit,
    /// Extensions carried alongside a mod's primary file wherever it is copied, renamed,
    /// removed or extracted, because they share its filename stem. Empty when one mod here is
    /// a single file or an author-supplied folder.
    pub companions: &'static [&'static str],
    /// The primary extension of the file family a directory unit wraps. Identification hashes
    /// that file rather than whichever one sorts first, so a sibling config folder cannot be
    /// hashed instead of the content.
    pub contained_extension: Option<&'static str>,
    pub enabled_state: Activation,
    pub mods_subpath: &'static [&'static str],
    pub disabled_subpath: &'static [&'static str],
    pub backup_subpath: &'static [&'static str],
}

impl ScanTarget {
    pub fn is_directory_unit(&self) -> bool {
        matches!(self.unit, ModUnit::Directory { .. })
    }

    pub fn disabled_suffix(&self) -> &'static str {
        match &self.unit {
            ModUnit::File {
                disabled_suffix, ..
            } => disabled_suffix,
            ModUnit::Directory { .. } => "",
        }
    }

    pub fn excluded_names(&self) -> &'static [&'static str] {
        match &self.unit {
            ModUnit::Directory { excluded_names, .. } => excluded_names,
            ModUnit::File { .. } => &[],
        }
    }

    /// The extension of the file a mod here is built around: the unit's own for a file
    /// target, and the wrapped family's for a directory target that declares one.
    pub fn content_extension(&self) -> Option<&'static str> {
        match &self.unit {
            ModUnit::File { extension, .. } => Some(extension),
            ModUnit::Directory { .. } => self.contained_extension,
        }
    }

    pub fn priority_prefix_enabled(&self) -> bool {
        match &self.unit {
            ModUnit::File {
                priority_prefix, ..
            }
            | ModUnit::Directory {
                priority_prefix, ..
            } => *priority_prefix,
        }
    }
}

pub struct ModEngineConfig {
    pub game_id: &'static str,
    pub decoders: &'static [DecoderBinding],
    pub index_game_name: &'static str,
    pub targets: &'static [ScanTarget],
    pub mod_metadata: ModMetadata,
}

impl ModEngineConfig {
    pub fn primary(&self) -> &ScanTarget {
        &self.targets[0]
    }

    pub fn target_for(&self, tag: Option<&str>) -> &ScanTarget {
        let Some(t) = tag else { return self.primary() };
        self.targets
            .iter()
            .find(|s| s.tag == t)
            .unwrap_or_else(|| self.primary())
    }
}

pub fn engine_for_game(game_id: &str) -> Result<&'static ModEngineConfig, String> {
    crate::commands::games::game_spec(game_id)
        .map(|s| s.engine)
        .ok_or_else(|| format!("unknown game id '{game_id}'"))
}

pub fn mods_dir(game_path: &str, target: &ScanTarget) -> PathBuf {
    target
        .mods_subpath
        .iter()
        .fold(PathBuf::from(game_path), |p, s| p.join(s))
}

pub fn disabled_dir(game_path: &str, target: &ScanTarget) -> PathBuf {
    target
        .disabled_subpath
        .iter()
        .fold(PathBuf::from(game_path), |p, s| p.join(s))
}

pub fn backup_dir(game_path: &str, target: &ScanTarget) -> PathBuf {
    target
        .backup_subpath
        .iter()
        .fold(PathBuf::from(game_path), |p, s| p.join(s))
}

pub fn state_path(game_path: &str, cfg: &ModEngineConfig) -> PathBuf {
    mods_dir(game_path, cfg.primary()).join(super::state::STATE_FILENAME)
}
