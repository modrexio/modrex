use modrex_game_package::GamePackage;
use std::path::Path;

/// Every directory here is one built-in game package and must hold package.toml declaring it.
/// The manifests are read, checked and turned into Rust here so the application carries the
/// packages as typed data and no parser goes into the binary with them.
const GAME_PACKAGE_ROOT: &str = "src/games";

fn main() {
    // analytics.rs bakes these in at compile time via option_env!. Cargo does not
    // track env vars read that way, so without these lines a cached build (CI uses
    // rust-cache) could ship stale/empty credentials. Declaring them forces a
    // recompile whenever the values change.
    println!("cargo:rerun-if-env-changed=MODREX_GA_MEASUREMENT_ID");
    println!("cargo:rerun-if-env-changed=MODREX_GA_API_SECRET");
    println!("cargo:rerun-if-env-changed=MODREX_ANALYTICS_ENDPOINT");

    // The bindings-export test links rfd's TaskDialogIndirect, imported from comctl32
    // by ordinal and present only in common-controls v6. The app exe gets v6 through
    // tauri-build's embedded manifest, but test binaries have none and would die at load
    // with STATUS_ORDINAL_NOT_FOUND, so embed the same dependency into them here.
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' publicKeyToken='6595b64144ccf1df' language='*' processorArchitecture='*'"
        );
    }

    emit_game_package_registry();

    tauri_build::build()
}

fn emit_game_package_registry() {
    // Watches the root itself so adding or removing a package directory is noticed, and each
    // manifest so editing one is.
    println!("cargo:rerun-if-changed={GAME_PACKAGE_ROOT}");

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set");
    let root = GAME_PACKAGE_ROOT
        .split('/')
        .fold(Path::new(&manifest_dir).to_path_buf(), |path, part| {
            path.join(part)
        });
    let entries =
        std::fs::read_dir(&root).unwrap_or_else(|e| panic!("cannot read {}: {e}", root.display()));

    let mut packages: Vec<(String, GamePackage)> = Vec::new();
    for entry in entries {
        let entry =
            entry.unwrap_or_else(|e| panic!("cannot read an entry of {}: {e}", root.display()));
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let path = entry.path();
        let id = entry.file_name().to_string_lossy().into_owned();
        if !is_package_id(&id) {
            panic!(
                "game package directory name '{id}' is not a lowercase Rust identifier: {}",
                path.display()
            );
        }
        let manifest = path.join("package.toml");
        if !manifest.is_file() {
            panic!(
                "game package '{id}' has no package.toml: expected {}",
                manifest.display()
            );
        }
        println!("cargo:rerun-if-changed={}", manifest.display());
        let declared = std::fs::read_to_string(&manifest)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", manifest.display()));
        let package: GamePackage =
            toml::from_str(&declared).unwrap_or_else(|e| panic!("{}: {e}", manifest.display()));
        modrex_game_package::validate::check(&id, &package)
            .unwrap_or_else(|problem| panic!("{}: {problem}", manifest.display()));
        packages.push((id, package));
    }
    packages.sort_by(|left, right| left.0.cmp(&right.0));

    let mut source = String::from(
        "fn built_in_packages() -> Vec<(&'static str, crate::game_package::GamePackage)> {\n    vec![\n",
    );
    for (id, package) in &packages {
        source.push_str(&format!(
            "        (\"{id}\", {}),\n",
            package.rust_literal()
        ));
    }
    source.push_str("    ]\n}\n");

    let out =
        Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR is set")).join("game_packages.rs");
    std::fs::write(&out, source).unwrap_or_else(|e| panic!("cannot write {}: {e}", out.display()));
}

fn is_package_id(id: &str) -> bool {
    id.starts_with(|c: char| c.is_ascii_lowercase())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}
