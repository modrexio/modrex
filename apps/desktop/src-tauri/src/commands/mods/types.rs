use serde::{Deserialize, Serialize};

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
/// This used to live in the version STRING, with "unknown" and "outdated" standing in for
/// a real value. That worked only because neither is a plausible modworkshop version, and
/// it forced every reader to know both sentinels. Per-source version semantics do not fit
/// one overloaded string either: Nexus search returns no version at all, and Steam
/// Workshop has update timestamps rather than versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    /// version holds a real, comparable value.
    #[default]
    Known,
    /// No comparable version: an unidentified mod, or an embedded-id mod that declares
    /// none. Never surfaces an update, since it would nag forever with nothing to compare.
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
    // Source-native mod/file ids for non-modworkshop sources; modworkshop identity
    // stays in id/file_id. Strings because future sources (Steam Workshop) use ids
    // beyond the JS safe-integer range. A mod with neither is unidentified.
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
