use super::*;
use serde_json::json;

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
