use crate::game_package::GamePackage;
use std::path::Path;

pub fn package_json(pkg: &GamePackage) -> String {
    let mut json = serde_json::to_string_pretty(pkg).expect("a package serializes");
    json.push('\n');
    json
}

/// Writes each discovered package beside the module that declares it. The path is relative to
/// the crate root, which is the directory cargo runs a test binary from.
pub fn export_package_artifacts() {
    for (directory, pkg) in super::discovered() {
        let path = Path::new("src/games").join(directory).join("package.json");
        std::fs::write(&path, package_json(pkg))
            .unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
    }
}
