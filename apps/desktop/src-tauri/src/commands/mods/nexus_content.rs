// Selects which shape of Nexus content query a mod needs, branching on ModUnit rather
// than on game — the two engine families need genuinely different discriminators (see
// engine.rs's ModUnit and the Tier 3 algorithm in the Nexus identification plan), and
// collapsing them into one "generic" matcher would silently produce the wrong query for
// half of Modrex's games. The actual network call lives in commands::nexus; this module
// only decides what to ask.

use super::engine::ModUnit;
use super::naming::{derive_content_segment, recover_published_filename};
use crate::commands::nexus::NexusContentQuery;

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
        let query =
            nexus_content_query_for(&directory_unit(), "assets/mod_overrides/Welrod", None);
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
