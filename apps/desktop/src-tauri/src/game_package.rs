use serde::{Deserialize, Serialize};

/// Which marker vocabulary a game's mods describe themselves in. Identity resolution is
/// game-neutral, so the ecosystem-specific parsing sits behind this instead of leaking into
/// the shared model (see commands/mods/diesel_signals.rs).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalSource {
    /// BLT mod.txt and BeardLib main.xml: PAYDAY 2, PAYDAY: The Heist, RAID.
    Diesel,
    /// Pak-based games, whose mods carry no self-describing metadata to read.
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
/// (Classes/Frameworks.lua), verified against a real install. On a blanket-accept target this
/// is what keeps them out of the mod scan, and where markers already exclude them it is still
/// needed so launch_without_mods, which moves folders regardless of markers, does not back
/// them up and then fail to restore them once the loader recreates them. BeardLib itself is
/// deliberately omitted: it is a normal installable mod page (id 49760), tracked like any
/// other mod.
pub const DIESEL_INFRA_FOLDERS: &[&str] = &["base", "downloads", "logs", "saves"];

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnabledStateMechanism {
    Filesystem,
    /// UE4SS loads the folders under Mods/ that mods.txt beside them lists, and ignores where
    /// a folder itself sits (confirmed against the real format: see
    /// commands/mods/ue4ss_modstxt.rs), so enabling and disabling here edit that file and
    /// leave the installed files in place.
    Ue4ssModsTxt,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub enum Unit {
    File {
        extension: String,
        disabled_suffix: String,
        priority_prefix: bool,
    },
    Directory {
        entry_markers: Vec<String>,
        scan_markers: Vec<String>,
        index_gated_markers: Vec<String>,
        excluded_names: Vec<String>,
        priority_prefix: bool,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub tag: String,
    pub label_key: String,
    pub unit: Unit,
    pub enabled_state: EnabledStateMechanism,
    pub mods_subpath: Vec<String>,
    pub disabled_subpath: Vec<String>,
    pub backup_subpath: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SteamStore {
    pub app_id: u32,
    pub folder_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EpicStore {
    pub display_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct XboxStore {
    pub product_id: String,
    /// Relative to the install's Content folder, which is what a game path names for this
    /// store. A Microsoft Store build stages its binary under the project's WinGDK folder and
    /// ships no Win64 bootstrapper, so this is the only executable such an install has.
    pub executable: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Installation {
    pub executables: Vec<String>,
    /// Launch argument the game needs for mods to load. The user supplies their own launch
    /// options, so this is what the interface tells them to include.
    pub required_launch_flag: Option<String>,
    pub process_names: Vec<String>,
    pub steam: Option<SteamStore>,
    pub epic: Option<EpicStore>,
    pub xbox: Option<XboxStore>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum Storefront {
    Steam,
    Epic,
    Xbox,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Ue4ssConfig {
    /// Builds whose proxy DLL and destination were verified against a real install. UE4SS is
    /// forked per game, so a storefront missing here is unsupported rather than guessed.
    pub storefronts: Vec<Storefront>,
    pub proxy_dlls: Vec<String>,
    pub binaries_subpath: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum LoaderConfig {
    Ue4ss(Ue4ssConfig),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LoaderBinding {
    pub loader_id: String,
    /// The mod ids this loader is published under for this game. A dependency on one of
    /// them means install the loader, not install a mod. Empty when the loader is hosted
    /// offsite and has no mod page, which the renderer matches by a name heuristic
    /// instead.
    pub modworkshop_ids: Vec<i64>,
    pub config: Option<LoaderConfig>,
}

/// A container format whose contents must be decoded before the generic archive readers see
/// them. The decoder and the extension it claims are host-owned.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputDecoder {
    Pdmod,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct InputDecoderBinding {
    pub decoder: InputDecoder,
    pub target_tag: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NewsBinding {
    /// The category segment of the publisher's news URL, which is also the cache filename.
    pub category_slug: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModWorkshopBinding {
    /// The numeric id modworkshop names this game by in its API paths, kept as text because
    /// a source identifier is not arithmetic.
    pub game_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NexusBinding {
    /// The domain slug the REST API and nxm:// links name this game by.
    pub domain: String,
    /// The numeric id the GraphQL content API filters on. Nexus names one game both ways.
    pub numeric_id: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Sources {
    pub modworkshop: Option<ModWorkshopBinding>,
    pub nexus: Option<NexusBinding>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GamePackage {
    pub id: String,
    pub display_name: String,
    pub short_name: String,
    /// Where this game sits in the game picker and the documentation tables. The index
    /// scheduler also breaks ties on it, so two games sharing a position would make one of
    /// them lose every tie.
    pub display_order: u16,
    pub index_game_name: String,
    pub state_filename: String,
    pub signals: SignalSource,
    pub installation: Installation,
    pub sources: Sources,
    pub news: Option<NewsBinding>,
    pub input_decoders: Vec<InputDecoderBinding>,
    pub loaders: Vec<LoaderBinding>,
    pub targets: Vec<Target>,
}
