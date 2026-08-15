//! The desktop half of the representative-file contract. The vectors live in
//! apps/index/marker-contract.json and the indexer runs the same ones against its own picker,
//! so a change to either implementation that breaks the agreement fails a test on both sides
//! instead of silently making a class of mods unidentifiable.

use super::identify::hashable_file_for_mod_dir;
use serde::Deserialize;
use tempfile::TempDir;

#[derive(Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    files: Vec<String>,
    expected: Option<String>,
}

#[test]
fn the_representative_file_matches_the_shared_contract() {
    let raw = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../index/marker-contract.json"
    ));
    let contract: Contract = serde_json::from_str(raw).expect("marker-contract.json parses");
    assert!(!contract.cases.is_empty());

    for case in &contract.cases {
        let dir = TempDir::new().unwrap();
        for file in &case.files {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, file.as_bytes()).unwrap();
        }

        let relative = hashable_file_for_mod_dir(dir.path()).map(|chosen| {
            chosen
                .strip_prefix(dir.path())
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        });
        assert_eq!(relative, case.expected, "{}", case.name);
    }
}
