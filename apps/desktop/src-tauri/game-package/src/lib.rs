//! The declaration a built-in game package makes about itself. Authored as TOML, parsed and
//! checked by the desktop build script, and consumed by the application as data.

#[cfg(feature = "codegen")]
mod codegen;
#[cfg(feature = "codegen")]
pub mod reference;
#[cfg(feature = "codegen")]
pub mod validate;

use serde::{Deserialize, Serialize};

/// Which metadata a game's mods carry to describe themselves. Identity resolution is
/// game-neutral, so the ecosystem-specific parsing sits behind this instead of leaking into
/// the shared model (see commands/mods/diesel_signals.rs).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModMetadata {
    /// BLT mod.txt and BeardLib main.xml.
    Diesel,
    /// Nothing readable: the mod files carry no self-describing metadata.
    None,
}

/// UE4SS ships these framework-internal sub-mods bundled inside every install's Mods/ folder
/// (verified against the real UE4SS-CB and PD3-UE4SS releases). They carry the exact same
/// Scripts/main.lua shape as a genuine user sub-mod, so the ambient scan must exclude them
/// by name rather than by marker. shared holds Lua libraries the bundled modules import.
pub const UE4SS_BUNDLED_SUBMODS: &[&str] = &[
    "ActorDumperMod",
    "BPML_GenericFunctions",
    "BPModLoaderMod",
    "CheatManagerEnablerMod",
    "ConsoleCommandsMod",
    "ConsoleEnablerMod",
    "jsbLuaProfilerMod",
    "Keybinds",
    "LineTraceMod",
    "SplitScreenMod",
    "shared",
];

/// Infrastructure dirs the BLT and Diesel loaders create under mods/ that are never user
/// mods: base (the SuperBLT basemod) plus the downloads, logs and saves runtime dirs BLT and
/// BeardLib recreate on every launch. Mirrors RAIDWW2-BeardLib's own _ignore_folders list
/// (Classes/Frameworks.lua), verified against a real install. On an all_directories target
/// this is what keeps them out of the mod scan, and where markers already exclude them it is
/// still needed so launch_without_mods, which moves folders regardless of markers, does not
/// back them up and then fail to restore them once the loader recreates them. BeardLib itself
/// is deliberately omitted: it is a normal installable mod page (id 49760), tracked like any
/// other mod.
pub const DIESEL_INFRA_FOLDERS: &[&str] = &["base", "downloads", "logs", "saves"];

/// A folder-name list the host owns, so games sharing a loader family reference it rather
/// than repeating it.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NamePreset {
    DieselInfra,
    Ue4ssBundledSubmods,
}

impl NamePreset {
    pub fn names(self) -> &'static [&'static str] {
        match self {
            NamePreset::DieselInfra => DIESEL_INFRA_FOLDERS,
            NamePreset::Ue4ssBundledSubmods => UE4SS_BUNDLED_SUBMODS,
        }
    }

    pub const ALL: &'static [NamePreset] =
        &[NamePreset::DieselInfra, NamePreset::Ue4ssBundledSubmods];
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Storefront {
    Steam,
    Epic,
    Xbox,
}

/// What a mod source calls this game. Each provider names games its own way, so the fields
/// differ per provider rather than being one shared shape.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceBinding {
    #[serde(rename = "modworkshop")]
    ModWorkshop {
        /// Kept as text because a source identifier is not arithmetic.
        game_id: String,
    },
    Nexus {
        /// The slug the REST API and nxm:// links use.
        domain: String,
        /// The id the GraphQL content API filters on. Nexus names one game both ways.
        numeric_id: u32,
    },
}

impl SourceBinding {
    pub fn provider(&self) -> &'static str {
        match self {
            SourceBinding::ModWorkshop { .. } => "modworkshop",
            SourceBinding::Nexus { .. } => "nexus",
        }
    }
}

/// A publisher's news feed. The site is part of the provider, not something a package spells
/// out, because the host implements one reader per site.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
pub enum NewsBinding {
    #[serde(rename = "paydaythegame")]
    PaydayTheGame {
        /// The category segment of the site's news URL, which is also the cache filename.
        category: String,
    },
}

impl NewsBinding {
    pub fn provider(&self) -> &'static str {
        match self {
            NewsBinding::PaydayTheGame { .. } => "paydaythegame",
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
pub enum StoreBinding {
    Steam {
        app_id: u32,
        folder: String,
    },
    Epic {
        name: String,
    },
    Xbox {
        product_id: String,
        /// Relative to the install's Content folder, which is what a game path names for this
        /// store. A Microsoft Store build stages its binary under the project's WinGDK folder
        /// and ships no Win64 bootstrapper, so this is the only executable such an install has.
        executable: String,
    },
}

impl StoreBinding {
    pub fn provider(&self) -> &'static str {
        match self {
            StoreBinding::Steam { .. } => "steam",
            StoreBinding::Epic { .. } => "epic",
            StoreBinding::Xbox { .. } => "xbox",
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Install {
    pub executables: Vec<String>,
    pub processes: Vec<String>,
    /// Launch argument the game needs for mods to load. The user supplies their own launch
    /// options, so this is what the interface tells them to include.
    #[serde(default)]
    pub launch_flag: Option<String>,
    pub stores: Vec<StoreBinding>,
}

/// A mod loader this game can install, and the identity the host resolves it by. One variant
/// per loader the host implements, so a package cannot name a loader that does not exist or
/// attach a configuration the loader does not read.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LoaderBinding {
    Ue4ss {
        #[serde(default)]
        modworkshop_ids: Vec<i64>,
        /// Builds whose proxy DLL and destination were verified against a real install. UE4SS
        /// is forked per game, so a storefront missing here is unsupported rather than guessed.
        storefronts: Vec<Storefront>,
        proxy_dlls: Vec<String>,
        install_into: Vec<String>,
    },
    Superblt {
        #[serde(default)]
        modworkshop_ids: Vec<i64>,
    },
    RaidSuperblt {
        #[serde(default)]
        modworkshop_ids: Vec<i64>,
    },
    PdthOverrides {
        #[serde(default)]
        modworkshop_ids: Vec<i64>,
    },
    Dahm {
        #[serde(default)]
        modworkshop_ids: Vec<i64>,
    },
}

impl LoaderBinding {
    /// The id the host loader registry knows this loader by.
    pub fn id(&self) -> &'static str {
        match self {
            LoaderBinding::Ue4ss { .. } => "ue4ss",
            LoaderBinding::Superblt { .. } => "superblt",
            LoaderBinding::RaidSuperblt { .. } => "raid_superblt",
            LoaderBinding::PdthOverrides { .. } => "pdth_overrides",
            LoaderBinding::Dahm { .. } => "dahm",
        }
    }

    /// The modworkshop mod ids this loader is published under for this game. A dependency on
    /// one of them means install the loader, not install a mod. Empty when the loader is hosted
    /// offsite and has no mod page, which the renderer matches by a name heuristic instead.
    pub fn modworkshop_ids(&self) -> &[i64] {
        match self {
            LoaderBinding::Ue4ss {
                modworkshop_ids, ..
            }
            | LoaderBinding::Superblt { modworkshop_ids }
            | LoaderBinding::RaidSuperblt { modworkshop_ids }
            | LoaderBinding::PdthOverrides { modworkshop_ids }
            | LoaderBinding::Dahm { modworkshop_ids } => modworkshop_ids,
        }
    }
}

/// A container format whose contents must be decoded before the generic archive readers see
/// them. The decoder and the extension it claims are host-owned.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "format", rename_all = "snake_case", deny_unknown_fields)]
pub enum DecoderBinding {
    Pdmod {
        /// The tag of the target decoded contents install into.
        target: String,
    },
}

impl DecoderBinding {
    pub fn target(&self) -> &str {
        match self {
            DecoderBinding::Pdmod { target } => target,
        }
    }
}

/// A primary mod file plus the files that travel with it because they share its stem.
///
/// Unreal splits one mod across a pak holding loose files, a utoc indexing a container and a
/// ucas holding that container's data; mounting the pak mounts the container beside it. Modrex
/// reads none of these formats. It moves whatever shares the primary file's stem, so a mod
/// shipping only the pak is normal and an absent companion is never an error. Containers split
/// into numbered partitions (Foo_s1.ucas) are not recognised.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FileFamily {
    pub extension: String,
    pub companions: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MarkerMode {
    /// Recognises a mod folder inside a downloaded archive, and selects the file hashed to
    /// identify it.
    Archive,
    /// Recognises an installed mod folder.
    Scan,
    /// Recognises an installed mod folder, which is then kept only if the mod index knows its
    /// hash. Use when a marker is shared between loader framework modules and genuinely
    /// installable mods that only the index can tell apart.
    IndexGated,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MarkerRule {
    pub file: String,
    pub modes: Vec<MarkerMode>,
}

/// How the scan decides that a directory is one mod.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "policy", rename_all = "snake_case", deny_unknown_fields)]
pub enum Discovery {
    /// Every directory is a mod unless ignore excludes it by name. For games whose mods carry
    /// no recognisable marker file.
    AllDirectories,
    Markers {
        markers: Vec<MarkerRule>,
    },
}

/// What one mod looks like inside a target.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Unit {
    File {
        family: FileFamily,
        disabled_suffix: String,
    },
    Directory {
        discovery: Discovery,
        #[serde(default)]
        ignore_preset: Option<NamePreset>,
        /// Set when the installed folder is a wrapper Modrex synthesizes around a file family
        /// rather than an author-supplied folder copied as-is.
        #[serde(default)]
        contains: Option<FileFamily>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Activation {
    Filesystem,
    /// UE4SS loads the folders under Mods/ that mods.txt beside them lists, and ignores where
    /// a folder itself sits (confirmed against the real format: see
    /// commands/mods/ue4ss_modstxt.rs), so enabling and disabling here edit that file and
    /// leave the installed files in place.
    Ue4ssModsTxt,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LoadOrder {
    /// Mods are renamed with a numeric prefix so the game mounts them in a chosen order.
    FilenamePrefix,
    None,
}

/// The interface name for a target's folder. Closed because every value needs a matching
/// settings.folders entry in en.json.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TargetLabel {
    Mods,
    ModkitMods,
    LegacyPaks,
    Overrides,
    Ue4ssMods,
}

impl TargetLabel {
    /// The key the renderer looks up under settings.folders.
    pub fn key(self) -> &'static str {
        match self {
            TargetLabel::Mods => "mods",
            TargetLabel::ModkitMods => "modkitMods",
            TargetLabel::LegacyPaks => "legacyPaks",
            TargetLabel::Overrides => "overrides",
            TargetLabel::Ue4ssMods => "ue4ssMods",
        }
    }
}

/// One place mods are installed, and everything about how they behave there.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Target {
    /// Stable id, persisted in each installed mod's record. Renaming one is a data migration.
    pub tag: String,
    pub label: TargetLabel,
    #[serde(default)]
    pub primary: bool,
    pub path: Vec<String>,
    /// Where launching without mods moves this target's contents. Not derived from path
    /// because PAYDAY 3 and Crime Boss must place it outside Paks/, which Unreal mounts
    /// recursively.
    pub backup: Vec<String>,
    pub activation: Activation,
    pub load_order: LoadOrder,
    pub unit: Unit,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GamePackage {
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub mod_metadata: ModMetadata,
    #[serde(default)]
    pub sources: Vec<SourceBinding>,
    #[serde(default)]
    pub news: Vec<NewsBinding>,
    pub install: Install,
    #[serde(default)]
    pub loaders: Vec<LoaderBinding>,
    #[serde(default)]
    pub decoders: Vec<DecoderBinding>,
    pub targets: Vec<Target>,
}

impl GamePackage {
    pub fn primary_target(&self) -> &Target {
        self.targets
            .iter()
            .find(|target| target.primary)
            .expect("build.rs rejects a package without exactly one primary target")
    }
}
