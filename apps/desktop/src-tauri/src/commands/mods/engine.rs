pub use crate::game_package::{EnabledStateMechanism, SignalSource};
use crate::game_package::{DIESEL_INFRA_FOLDERS, UE4SS_BUNDLED_SUBMODS};
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
    pub enabled_state: EnabledStateMechanism,
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
    pub index_game_name: &'static str,
    pub state_filename: &'static str,
    pub targets: &'static [ScanTarget],
    pub signals: SignalSource,
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

// Primary target is CrimeBoss/Mods/<name>/ (Directory unit), the official ModKit's install
// location. Unlike PD2 and PDTH's Directory targets the install-time content is not an
// author-supplied folder copied as-is. Modrex synthesizes the Content/Paks/WindowsNoEditor/
// skeleton itself around the extracted .pak and its .ucas/.utoc siblings, however the source
// archive is packaged (see zip.rs's CB-specific resolution path). The official UGC mod-loader
// merges multiple mods' Data Table Extensions additively when mods live here, whereas the
// legacy paks target is generic Unreal pak-mount with no merge semantics and resolves
// overlapping data as last-loaded-wins. It is kept for loose-triplet-only mods but never
// selected for new installs: resolve_archive_download dispatches on cfg.primary().unit, so
// paks is reachable only via target_for(Some("paks")) during an ambient scan.
pub static CRIMEBOSS_ENGINE: ModEngineConfig = ModEngineConfig {
    game_id: "cb",
    index_game_name: "Crime Boss: Rockay City",
    state_filename: ".modrex.json",
    signals: SignalSource::None,
    targets: &[
        ScanTarget {
            tag: "mods",
            unit: ModUnit::Directory {
                entry_markers: &[],
                scan_markers: &[],
                index_gated_markers: &[],
                excluded_names: &[],
                priority_prefix: false,
            },
            enabled_state: EnabledStateMechanism::Filesystem,
            label_key: "modkitMods",
            mods_subpath: &["CrimeBoss", "Mods"],
            disabled_subpath: &["CrimeBoss", "Mods", "disabled"],
            backup_subpath: &["CrimeBoss", "Mods.bak"],
        },
        ScanTarget {
            tag: "paks",
            unit: ModUnit::File {
                extension: "pak",
                disabled_suffix: ".disabled",
                priority_prefix: true,
            },
            enabled_state: EnabledStateMechanism::Filesystem,
            label_key: "legacyPaks",
            mods_subpath: &["CrimeBoss", "Content", "Paks", "~mods"],
            disabled_subpath: &["CrimeBoss", "Content", "Paks", "~mods", "disabled"],
            backup_subpath: &["CrimeBoss", "Content", "~mods.bak"],
        },
        ScanTarget {
            tag: "ue4ss_mods",
            unit: ModUnit::Directory {
                entry_markers: &["Scripts/main.lua"],
                scan_markers: &["Scripts/main.lua"],
                index_gated_markers: &[],
                excluded_names: UE4SS_BUNDLED_SUBMODS,
                priority_prefix: false,
            },
            enabled_state: EnabledStateMechanism::Ue4ssModsTxt,
            label_key: "ue4ssMods",
            mods_subpath: &["CrimeBoss", "Binaries", "Win64", "Mods"],
            disabled_subpath: &["CrimeBoss", "Binaries", "Win64", "Mods", "disabled"],
            backup_subpath: &["CrimeBoss", "Binaries", "Win64", "Mods.bak"],
        },
    ],
};

pub static PDTH_ENGINE: ModEngineConfig = ModEngineConfig {
    game_id: "pdth",
    index_game_name: "PAYDAY: The Heist",
    state_filename: ".modrex.json",
    signals: SignalSource::Diesel,
    targets: &[
        ScanTarget {
            tag: "mods",
            unit: ModUnit::Directory {
                // base.lua is the DAHM mod-framework entry point. It is in entry_markers so
                // DAHM sub-mod ZIPs classify correctly during install, and in
                // index_gated_markers so base.lua-only directories ARE discovered by the scan
                // but tracked only when their SHA256 matches the mod index. That match is the
                // reliable way to tell user-installed sub-mods from DAHM's own framework.
                entry_markers: &["mod.txt", "base.lua"],
                scan_markers: &["mod.txt"],
                index_gated_markers: &["base.lua"],
                excluded_names: DIESEL_INFRA_FOLDERS,
                priority_prefix: false,
            },
            enabled_state: EnabledStateMechanism::Filesystem,
            label_key: "mods",
            mods_subpath: &["mods"],
            disabled_subpath: &["mods", "disabled"],
            backup_subpath: &["mods.bak"],
        },
        ScanTarget {
            tag: "mod_overrides",
            unit: ModUnit::Directory {
                entry_markers: &[],
                scan_markers: &[],
                index_gated_markers: &[],
                excluded_names: &[],
                priority_prefix: false,
            },
            enabled_state: EnabledStateMechanism::Filesystem,
            label_key: "overrides",
            mods_subpath: &["assets", "mod_overrides"],
            disabled_subpath: &["assets", "mod_overrides", "disabled"],
            backup_subpath: &["assets", "mod_overrides.bak"],
        },
    ],
};

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
    mods_dir(game_path, cfg.primary()).join(cfg.state_filename)
}
