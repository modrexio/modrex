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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_broken: Option<bool>,
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

    /// A default entry already carrying a catalog association, for the install and discovery
    /// paths that build their record with struct-update syntax.
    pub fn from_catalog(source: &str, remote_id: String, evidence: IdentityEvidence) -> Self {
        let mut m = Self::default();
        m.attach_catalog(source, remote_id, evidence);
        m
    }
}

impl Default for InstalledMod {
    fn default() -> Self {
        Self {
            uid: String::new(),
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
            priority: None,
            missing: None,
            folder_id: None,
            archive_broken: None,
            location: None,
            update_status: UpdateStatus::Known,
            nexus_content_missed: None,
            identity: None,
            declared: None,
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
}
