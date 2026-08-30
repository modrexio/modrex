use std::path::Path;

/// Every directory here is one built-in game package and must hold package.rs exposing a
/// package function returning its GamePackage.
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
    // package file so editing one is.
    println!("cargo:rerun-if-changed={GAME_PACKAGE_ROOT}");

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set");
    let root = GAME_PACKAGE_ROOT
        .split('/')
        .fold(Path::new(&manifest_dir).to_path_buf(), |path, part| {
            path.join(part)
        });
    let entries =
        std::fs::read_dir(&root).unwrap_or_else(|e| panic!("cannot read {}: {e}", root.display()));

    let mut ids: Vec<String> = Vec::new();
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
        let package_file = path.join("package.rs");
        if !package_file.is_file() {
            panic!(
                "game package '{id}' has no package.rs: expected {}",
                package_file.display()
            );
        }
        println!("cargo:rerun-if-changed={}", package_file.display());
        ids.push(id);
    }
    ids.sort();

    let mut source = String::new();
    for id in &ids {
        let package_file = root.join(id).join("package.rs");
        source.push_str(&format!(
            "#[path = \"{}\"]\nmod {id};\n",
            package_file.display().to_string().replace('\\', "/")
        ));
    }
    source.push_str(
        "pub fn discovered() -> Vec<(&'static str, crate::games::package::GamePackage)> {\n    vec![\n",
    );
    for id in &ids {
        source.push_str(&format!("        (\"{id}\", {id}::package()),\n"));
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
