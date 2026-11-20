use super::identity::{IdentityEvidence, ModIdentity};
use serde::{Deserialize, Serialize};

/// What the mod says about itself in its own files. A mod with no catalog entry has nothing
/// else describing it, and the renderer shows these values for exactly those mods
/// (installedUtils.ts's withDeclaredMetadata); a catalog-backed mod keeps catalog values,
/// which stay current when the author republishes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl DeclaredMetadata {
    pub fn is_empty(&self) -> bool {
        self == &DeclaredMetadata::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModFolder {
    pub id: String,
    pub disk_name: String,
    pub display_name: String,
    pub priority: i64,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum TopLevelItem {
    #[serde(rename = "folder")]
    Folder { id: String },
    #[serde(rename = "mod")]
    Mod { id: String },
}

fn default_source() -> String {
    "modworkshop".to_string()
}

/// Whether a mod's installed version can be compared against the remote one.
///
/// Kept out of the version string deliberately. Sentinel values like "unknown" and
/// "outdated" only work while no source publishes them as a real version, and they force
/// every reader to know the full sentinel set. Per-source semantics do not fit one
/// overloaded string either: Nexus search returns no version at all, and Steam Workshop
/// has update timestamps rather than versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    /// version holds a real, comparable value.
    #[default]
    Known,
    /// No comparable version: a mod with no catalog entry to compare against, or an
    /// embedded-id mod that declares none. Never surfaces an update, since it would nag
    /// forever with nothing to compare.
    Unknown,
    /// Confirmed stale: a name match succeeded AFTER a SHA256 check against the index's
    /// current file had already failed, so the installed bytes are known to differ.
    Outdated,
}

impl UpdateStatus {
    pub fn is_known(&self) -> bool {
        matches!(self, UpdateStatus::Known)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMod {
    #[serde(default)]
    pub uid: String,
    // One installation for its whole life. uid is derived from file ids and names and changes
    // when the mod is updated, so anything that must still find this install afterwards keys
    // off this instead. A replacement inherits it from the record it replaces, and a record
    // from a state file written before it existed gets one from read_state.
    #[serde(default)]
    pub install_id: String,
    pub id: i64,
    pub name: String,
    pub version: String,
    pub filename: String,
    pub enabled: bool,
    pub installed_at: String,
    #[serde(default = "default_source")]
    pub source: String,
    // Source-native mod and file ids for non-modworkshop sources, where modworkshop
    // identity stays in id/file_id. Strings because other sources (Steam Workshop) use
    // ids beyond the JS safe-integer range. A mod with neither is unidentified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_remote_id: Option<String>,
    // Only recorded for non-modworkshop sources; modworkshop authorship and
    // artwork come from the live API via the mod id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    // SHA-256 of the bytes Modrex itself placed for a shared Paks file, written only by that
    // install. In a copy with no store record of the game's files it is the only proof that
    // a file there is a mod Modrex may change (owned_files.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placed_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_broken: Option<bool>,
    // The pak lists nothing of its own and every companion it needs is gone, so the game
    // mounts it and loads nothing. Worked out again on every scan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_missing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "UpdateStatus::is_known")]
    pub update_status: UpdateStatus,
    // Nexus content-index lookup (nexus_content.rs) found nothing, or an ambiguous
    // result, for this mod. Persisted so a permanent miss (roughly a quarter of mods
    // are never indexed) is asked at most once rather than re-queried every attempt.
    // None means never attempted; Some(false) never occurs and is not written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nexus_content_missed: Option<bool>,
    // Which project this install is, independent of whether any catalog lists it. `id` stays
    // the installed record's own key (React keys, drag and drop, every command's target);
    // this answers "what mod is this", and source/remote_id answer "and where can we get it".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<ModIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared: Option<DeclaredMetadata>,
    // Set only on rows get_installed derives from the resource manifest. Those rows are never
    // written to .modrex.json, where an older client would treat them as ordinary files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment: Option<ResourceDeployment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_status: Option<ResourceStatus>,
    // Every file a bundle install placed, relative to the game folder (bundle.rs). Present
    // only on records of a bundle target, where it is the whole of what the record owns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<Vec<BundleFile>>,
    // The full path of the archive member this was installed from. Two members can share a
    // file name, and only this tells a reinstall of one from a reinstall of the other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_member: Option<String>,
}

/// One file a bundle placed, with the bytes it wrote, so uninstalling and updating can tell a
/// file they may remove from one that changed since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BundleFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// Which resource operation owns a row. Absent for every ordinary mod.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ResourceDeployment {
    Movie,
    Ini,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ResourceStatus {
    Applied,
    Disabled,
    Diverged,
    Blocked,
}

impl InstalledMod {
    /// Records a catalog association and the evidence that established it, as one operation.
    ///
    /// Every path that learns which catalog entry an install corresponds to goes through
    /// here, so the four fields it writes cannot disagree: the catalog, the id there, the
    /// opaque local key derived from both, and how the match was found. Nothing downstream
    /// may infer the last one, because only the establishing operation knows it.
    pub fn attach_catalog(&mut self, source: &str, remote_id: String, evidence: IdentityEvidence) {
        self.id = crate::commands::sources::source_native_local_id(source, &remote_id);
        self.identity = Some(ModIdentity::new(source, remote_id.clone(), evidence));
        self.remote_id = Some(remote_id);
        self.source = source.to_string();
    }

    /// Makes this record the same installation as the one it replaces. A record installed
    /// from a different member of an archive stays a separate installation, since two
    /// members with one file name can be replaced through the same uid.
    pub fn inherit_install_id(&mut self, predecessor: &InstalledMod) {
        let other_member = match (&self.archive_member, &predecessor.archive_member) {
            (Some(new), Some(old)) => new != old,
            _ => false,
        };
        if other_member {
            return;
        }
        self.install_id = predecessor.install_id.clone();
    }

    /// A default entry already carrying a catalog association, for the install and discovery
    /// paths that build their record with struct-update syntax.
    pub fn from_catalog(source: &str, remote_id: String, evidence: IdentityEvidence) -> Self {
        let mut m = Self::default();
        m.attach_catalog(source, remote_id, evidence);
        m
    }
}

// A record built from nothing is a new installation, so it gets a new install_id. Every path
// that replaces an existing record copies the old one over it.
impl Default for InstalledMod {
    fn default() -> Self {
        Self {
            uid: String::new(),
            install_id: uuid::Uuid::new_v4().to_string(),
            id: 0,
            name: String::new(),
            version: String::new(),
            filename: String::new(),
            enabled: false,
            installed_at: String::new(),
            source: default_source(),
            remote_id: None,
            file_remote_id: None,
            author: None,
            thumbnail_url: None,
            file_id: None,
            file_type: None,
            sha256: None,
            placed_sha256: None,
            priority: None,
            missing: None,
            folder_id: None,
            archive_broken: None,
            container_missing: None,
            location: None,
            update_status: UpdateStatus::Known,
            nexus_content_missed: None,
            identity: None,
            declared: None,
            deployment: None,
            resource_status: None,
            bundle: None,
            archive_member: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModsState {
    pub folders: Vec<ModFolder>,
    pub mods: Vec<InstalledMod>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstalledResponse {
    pub mods: Vec<InstalledMod>,
    pub folders: Vec<ModFolder>,
    pub mods_hidden: bool,
    /// The mod list on disk could not be loaded, so this response was rebuilt from a scan and
    /// nothing was written back. Everything shown is real, but Modrex's own record of folders,
    /// order and per-mod metadata is not in it, and no operation may replace that record until
    /// the file is readable again.
    pub state_unreadable: bool,
    /// The mod list was saved by a newer version of Modrex. state_unreadable is also set.
    pub state_newer: bool,
    /// Failures inspecting movie or Engine.ini records, including pending recovery.
    /// Ordinary mod rows remain available.
    pub resource_error: Option<String>,
    pub resource_recovery_pending: bool,
}
