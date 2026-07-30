// Selects which shape of Nexus content query a mod needs, branching on ModUnit rather
// than on game — the two engine families need genuinely different discriminators (see
// engine.rs's ModUnit and the Tier 3 algorithm in the Nexus identification plan), and
// collapsing them into one "generic" matcher would silently produce the wrong query for
// half of Modrex's games. The actual network call lives in commands::nexus; this module
// only decides what to ask.

use super::engine::{ModUnit, ScanTarget};
use super::naming::{derive_content_segment, recover_published_filename};
use super::paths::{active_mod_path, disabled_mod_path};
use super::state::get_folder_path;
use super::types::{InstalledMod, ModFolder};
use crate::commands::nexus::{self, NexusContentQuery};
use tauri::AppHandle;

/// Builds the Nexus content query for an installed mod, or None when nothing usable
/// can be derived (a Directory-unit mod with no folder segment, or a File-unit mod
/// whose on-disk byte size is not yet known).
pub(crate) fn nexus_content_query_for(
    unit: &ModUnit,
    on_disk_filename: &str,
    file_size: Option<i64>,
) -> Option<NexusContentQuery> {
    match unit {
        ModUnit::File {
            disabled_suffix, ..
        } => {
            let file_name = recover_published_filename(on_disk_filename, disabled_suffix);
            Some(NexusContentQuery::FileNameAndSize {
                file_name,
                file_size: file_size?,
            })
        }
        ModUnit::Directory { .. } => {
            let segment = derive_content_segment(on_disk_filename)?.to_string();
            Some(NexusContentQuery::FolderSegment { segment })
        }
    }
}

/// What attempting Nexus content identification for one installed mod produced.
#[derive(Debug, Clone, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NexusContentIdentifyOutcome {
    /// Already identified, already carrying a permanent miss, or nothing queryable
    /// could be derived (no folder segment, or the file could not be found on disk) —
    /// nothing was attempted, so nothing was recorded.
    Skipped,
    NotFound,
    Ambiguous,
    Identified,
}

/// Attempts to identify one already-installed, unidentified mod against Nexus's
/// content index (the Tier 3 match). Callers must gate this behind an explicit user
/// action — never call it from the get_installed hot path — and must persist m
/// afterward regardless of outcome, since a miss is recorded on m itself via
/// nexus_content_missed so it is asked at most once.
pub(crate) async fn identify_via_nexus_content_op(
    app: &AppHandle,
    game_id: &str,
    game_path: &str,
    folders: &[ModFolder],
    target: &ScanTarget,
    m: &mut InstalledMod,
) -> Result<NexusContentIdentifyOutcome, String> {
    if m.remote_id.is_some() || m.nexus_content_missed == Some(true) {
        return Ok(NexusContentIdentifyOutcome::Skipped);
    }

    let rel = get_folder_path(folders, m.folder_id.as_deref());
    let active = active_mod_path(game_path, &m.filename, rel.as_deref(), target);
    let disabled = disabled_mod_path(game_path, &m.filename, rel.as_deref(), target);
    let path = if active.exists() {
        active
    } else if disabled.exists() {
        disabled
    } else {
        return Ok(NexusContentIdentifyOutcome::Skipped);
    };

    let file_size = match &target.unit {
        ModUnit::File { .. } => Some(
            tokio::fs::metadata(&path)
                .await
                .map_err(|e| e.to_string())?
                .len() as i64,
        ),
        ModUnit::Directory { .. } => None,
    };

    let Some(query) = nexus_content_query_for(&target.unit, &m.filename, file_size) else {
        return Ok(NexusContentIdentifyOutcome::Skipped);
    };

    let ids = nexus::nexus_lookup_content_mod_ids(app.clone(), game_id.to_string(), query).await?;

    match ids.as_slice() {
        [] => {
            m.nexus_content_missed = Some(true);
            Ok(NexusContentIdentifyOutcome::NotFound)
        }
        [mod_id] => {
            let mod_id = *mod_id;
            let detail_value =
                nexus::nexus_get_mod(app.clone(), game_id.to_string(), mod_id).await?;
            let detail = crate::commands::domain::parse_nexus_detail(detail_value)?;
            m.source = "nexus".to_string();
            m.remote_id = Some(mod_id.to_string());
            m.id = crate::commands::sources::source_native_local_id("nexus", &mod_id.to_string());
            m.name = detail.name;
            m.version = detail.version;
            m.author = Some(detail.user.name);
            m.thumbnail_url = detail.thumbnail.map(|t| t.file);
            m.nexus_content_missed = None;
            Ok(NexusContentIdentifyOutcome::Identified)
        }
        _ => {
            m.nexus_content_missed = Some(true);
            Ok(NexusContentIdentifyOutcome::Ambiguous)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_unit() -> ModUnit {
        ModUnit::File {
            extension: "pak",
            disabled_suffix: ".disabled",
            priority_prefix: true,
        }
    }

    fn directory_unit() -> ModUnit {
        ModUnit::Directory {
            entry_markers: &["mod.txt", "main.xml"],
            scan_markers: &["mod.txt", "main.xml"],
            index_gated_markers: &[],
            excluded_names: &[],
            priority_prefix: false,
        }
    }

    #[test]
    fn file_unit_recovers_the_published_name_and_carries_size() {
        let query = nexus_content_query_for(&file_unit(), "003_Foo.pak.disabled", Some(468));
        assert_eq!(
            query,
            Some(NexusContentQuery::FileNameAndSize {
                file_name: "Foo.pak".to_string(),
                file_size: 468,
            })
        );
    }

    #[test]
    fn file_unit_with_no_known_size_is_not_queryable() {
        assert_eq!(nexus_content_query_for(&file_unit(), "Foo.pak", None), None);
    }

    #[test]
    fn directory_unit_uses_the_folder_name_as_a_segment() {
        let query = nexus_content_query_for(&directory_unit(), "Welrod", None);
        assert_eq!(
            query,
            Some(NexusContentQuery::FolderSegment {
                segment: "Welrod".to_string(),
            })
        );
    }

    #[test]
    fn directory_unit_strips_the_mod_overrides_wrapper() {
        let query = nexus_content_query_for(&directory_unit(), "assets/mod_overrides/Welrod", None);
        assert_eq!(
            query,
            Some(NexusContentQuery::FolderSegment {
                segment: "Welrod".to_string(),
            })
        );
    }

    #[test]
    fn directory_unit_with_no_usable_segment_is_not_queryable() {
        assert_eq!(nexus_content_query_for(&directory_unit(), "", None), None);
    }
}
