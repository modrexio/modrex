use super::*;
use serde_json::json;

fn check(files: serde_json::Value, updates: serde_json::Value) -> NexusFileUpdate {
    parse_nexus_file_update(json!({ "files": files, "file_updates": updates }), 1).unwrap()
}

#[test]
fn installed_file_version_prefers_upload_mod_version() {
    assert_eq!(
        nexus_installed_file_version(&json!({"mod_version": "1.2", "version": "part-4"}), "2.0"),
        "1.2"
    );
    assert_eq!(
        nexus_installed_file_version(&json!({"mod_version": "", "version": "1.3"}), "2.0"),
        "1.3"
    );
    assert_eq!(
        nexus_installed_file_version(&json!({"mod_version": null, "version": ""}), "2.0"),
        "2.0"
    );
}

#[test]
fn linear_update_chain_reaches_newest_replacement() {
    assert_eq!(
        check(
            json!([
                {"file_id": 1, "category_id": 4},
                {"file_id": 2, "category_id": 4},
                {"file_id": 3, "category_id": 1, "mod_version": "3.0", "version": "part-3"}
            ]),
            json!([
                {"old_file_id": 1, "new_file_id": 2},
                {"old_file_id": 2, "new_file_id": 3}
            ])
        ),
        NexusFileUpdate::Replaced {
            file_id: 3,
            version: "3.0".into()
        }
    );
}

#[test]
fn archived_chain_tail_uses_last_available_replacement() {
    assert_eq!(
        check(
            json!([
                {"file_id": 2, "category_id": 4, "version": "2.0"},
                {"file_id": 3, "category_id": 7}
            ]),
            json!([
                {"old_file_id": 1, "new_file_id": 2},
                {"old_file_id": 2, "new_file_id": 3},
                {"old_file_id": 3, "new_file_id": 4}
            ])
        ),
        NexusFileUpdate::Replaced {
            file_id: 2,
            version: "2.0".into()
        }
    );
}

#[test]
fn sole_non_old_file_replaces_without_a_chain() {
    assert_eq!(
        check(
            json!([
                {"file_id": 1, "category_id": 4},
                {"file_id": 2, "category_id": 1, "version": "2.0"}
            ]),
            json!([])
        ),
        NexusFileUpdate::Replaced {
            file_id: 2,
            version: "2.0".into()
        }
    );
}

#[test]
fn multiple_main_files_leave_installed_file_current() {
    assert_eq!(
        check(
            json!([
                {"file_id": 1, "category_id": 1},
                {"file_id": 2, "category_id": 1}
            ]),
            json!([])
        ),
        NexusFileUpdate::Current
    );
}

#[test]
fn archived_or_missing_installed_file_has_unknown_replacement() {
    for files in [json!([{"file_id": 1, "category_id": 7}]), json!([])] {
        assert_eq!(check(files, json!([])), NexusFileUpdate::Unknown);
    }
}

#[test]
fn unavailable_chain_tail_falls_back_to_installed_file() {
    assert_eq!(
        check(
            json!([
                {"file_id": 1, "category_id": 1},
                {"file_id": 2, "category_id": 6}
            ]),
            json!([{"old_file_id": 1, "new_file_id": 2}])
        ),
        NexusFileUpdate::Current
    );
}

#[test]
fn cyclic_update_chain_is_a_failure() {
    assert!(parse_nexus_file_update(
        json!({
            "files": [],
            "file_updates": [
                {"old_file_id": 1, "new_file_id": 2},
                {"old_file_id": 2, "new_file_id": 1}
            ]
        }),
        1
    )
    .unwrap_err()
    .contains("cyclic"));
}

#[test]
fn replacement_serializes_with_camel_case_fields() {
    assert_eq!(
        serde_json::to_value(NexusFileUpdate::Replaced {
            file_id: 2,
            version: "2.0".into()
        })
        .unwrap(),
        json!({"status": "replaced", "fileId": 2, "version": "2.0"})
    );
}
