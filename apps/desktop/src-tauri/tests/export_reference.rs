//! Regenerates the contributor reference for package.toml from the contract. CI asserts the
//! result matches the committed file, the same way it does for the game catalogue.

const REFERENCE_PATH: &str = "../docs/game-package.md";

fn manifest(id: &str) -> String {
    let path = format!("src/games/{id}/package.toml");
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
}

#[test]
fn export_package_reference() {
    // The examples are the real manifests, so the reference cannot describe a shape no game
    // actually uses.
    let raid = manifest("raid");
    let pdth = manifest("pdth");
    let text = modrex_game_package::reference::markdown(&[
        ("the simplest game, RAID: World War II", raid.as_str()),
        (
            "a game with every section, PAYDAY: The Heist",
            pdth.as_str(),
        ),
    ]);
    std::fs::write(REFERENCE_PATH, text)
        .unwrap_or_else(|e| panic!("cannot write {REFERENCE_PATH}: {e}"));
}
