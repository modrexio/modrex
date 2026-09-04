//! Every way a manifest can be wrong, and the diagnostic it produces.
//!
//! The build script runs the same two steps in the same order: parse with serde, then run
//! validate::check. Exercising them here means CI proves the rejections without needing a
//! failing build.

use modrex_game_package::{validate, GamePackage};

/// Kept minimal on purpose: anything a case does not care about should be able to disappear
/// without the case changing meaning.
const BASE: &str = r#"
id = "fixture"
name = "Fixture"
short_name = "FIX"
mod_metadata = "none"
sources = [
    { provider = "modworkshop", game_id = "1" },
]

[install]
executables = ["Fixture.exe"]
processes = ["Fixture"]
stores = [
    { provider = "steam", app_id = 1, folder = "Fixture" },
]

[[targets]]
tag = "mods"
label = "mods"
primary = true
path = ["mods"]
backup = ["mods.bak"]
activation = "filesystem"
load_order = "none"

[targets.unit]
kind = "directory"

[targets.unit.discovery]
policy = "markers"
markers = [
    { file = "mod.txt", modes = ["archive", "scan"] },
]
"#;

/// Returns the whole diagnostic a contributor would see, from whichever of the two steps
/// rejects the manifest.
fn rejection(text: &str) -> String {
    let parsed: GamePackage = match toml::from_str(text) {
        Ok(package) => package,
        Err(error) => return error.to_string(),
    };
    match validate::check("fixture", &parsed) {
        Ok(()) => panic!("accepted a manifest that should have been rejected:\n{text}"),
        Err(problem) => problem,
    }
}

fn assert_rejected(text: &str, needle: &str) {
    let message = rejection(text);
    assert!(
        message.contains(needle),
        "expected a diagnostic mentioning {needle:?}, got:\n{message}"
    );
}

#[test]
fn the_base_manifest_is_accepted() {
    let parsed: GamePackage = toml::from_str(BASE).expect("base parses");
    validate::check("fixture", &parsed).expect("base passes the checks");
}

#[test]
fn an_unknown_key_is_rejected_with_a_line_and_column() {
    let message = rejection(&format!("{BASE}\nmystery = 1\n"));
    assert!(message.contains("mystery"), "{message}");
    assert!(message.contains("line"), "{message}");
    assert!(message.contains("column"), "{message}");
}

#[test]
fn an_unknown_value_lists_the_ones_that_exist() {
    assert_rejected(
        &BASE.replace(r#"provider = "modworkshop""#, r#"provider = "gog""#),
        "expected `modworkshop` or `nexus`",
    );
    assert_rejected(
        &BASE.replace(r#"mod_metadata = "none""#, r#"mod_metadata = "blt""#),
        "expected `diesel` or `none`",
    );
    assert_rejected(
        &BASE.replace(r#"policy = "markers""#, r#"policy = "every_folder""#),
        "expected `all_directories` or `markers`",
    );
    assert_rejected(
        &BASE.replace(
            r#"modes = ["archive", "scan"]"#,
            r#"modes = ["archive", "look"]"#,
        ),
        "expected one of `archive`, `scan`, `index_gated`",
    );
    assert_rejected(
        &BASE.replace(r#"label = "mods""#, r#"label = "Mods""#),
        "unknown variant `Mods`",
    );
}

#[test]
fn a_field_belonging_to_another_variant_is_rejected() {
    assert_rejected(
        &BASE.replace(
            r#"{ provider = "steam", app_id = 1, folder = "Fixture" }"#,
            r#"{ provider = "epic", name = "Fixture", app_id = 1 }"#,
        ),
        "app_id",
    );
    assert_rejected(
        &BASE.replace(
            "kind = \"directory\"\n",
            "kind = \"directory\"\ndisabled_suffix = \".off\"\n",
        ),
        "disabled_suffix",
    );
}

#[test]
fn a_missing_required_key_is_rejected() {
    assert_rejected(&BASE.replace("short_name = \"FIX\"\n", ""), "short_name");
    assert_rejected(&BASE.replace("load_order = \"none\"\n", ""), "load_order");
    let no_marker_list = BASE
        .split("markers = [")
        .next()
        .expect("base lists markers")
        .to_string();
    assert_rejected(&no_marker_list, "markers");
}

#[test]
fn a_directory_unit_cannot_omit_its_discovery_policy() {
    let without = BASE
        .split("[targets.unit.discovery]")
        .next()
        .expect("base has a discovery section")
        .to_string();
    assert_rejected(&without, "discovery");
}

#[test]
fn an_id_that_disagrees_with_its_directory_is_rejected() {
    assert_rejected(
        &BASE.replace(r#"id = "fixture""#, r#"id = "other""#),
        "directory",
    );
}

#[test]
fn duplicate_providers_are_rejected() {
    assert_rejected(
        &BASE.replace(
            r#"    { provider = "modworkshop", game_id = "1" },"#,
            "    { provider = \"modworkshop\", game_id = \"1\" },\n    { provider = \"modworkshop\", game_id = \"2\" },",
        ),
        "two 'modworkshop' sources",
    );
    assert_rejected(
        &BASE.replace(
            r#"    { provider = "steam", app_id = 1, folder = "Fixture" },"#,
            "    { provider = \"steam\", app_id = 1, folder = \"Fixture\" },\n    { provider = \"steam\", app_id = 2, folder = \"Other\" },",
        ),
        "two 'steam' stores",
    );
}

#[test]
fn a_loader_declared_twice_is_rejected() {
    assert_rejected(
        &format!("{BASE}\n[[loaders]]\nkind = \"dahm\"\n\n[[loaders]]\nkind = \"dahm\"\n"),
        "'dahm' loader twice",
    );
}

#[test]
fn a_ue4ss_loader_without_a_verified_build_is_rejected() {
    assert_rejected(
        &format!(
            "{BASE}\n[[loaders]]\nkind = \"ue4ss\"\nstorefronts = []\nproxy_dlls = [\"x.dll\"]\ninstall_into = [\"Bin\"]\n"
        ),
        "at least one storefront",
    );
}

#[test]
fn duplicate_target_tags_are_rejected() {
    assert_rejected(
        &format!("{BASE}\n{}", second_target("mods", false)),
        "two targets tagged 'mods'",
    );
}

#[test]
fn a_package_must_name_exactly_one_primary_target() {
    assert_rejected(
        &BASE.replace("primary = true\n", ""),
        "marks 0 targets primary",
    );
    assert_rejected(
        &format!("{BASE}\n{}", second_target("extra", true)),
        "marks 2 targets primary",
    );
}

#[test]
fn a_decoder_pointing_at_an_undeclared_target_is_rejected() {
    assert_rejected(
        &BASE.replace(
            "[install]",
            "decoders = [\n    { format = \"pdmod\", target = \"nowhere\" },\n]\n\n[install]",
        ),
        "target 'nowhere', which it does not declare",
    );
}

#[test]
fn a_markers_policy_with_no_rules_is_rejected() {
    assert_rejected(
        &BASE.replace(
            "markers = [\n    { file = \"mod.txt\", modes = [\"archive\", \"scan\"] },\n]",
            "markers = []",
        ),
        "write all_directories",
    );
}

#[test]
fn a_marker_listed_twice_is_rejected() {
    assert_rejected(
        &BASE.replace(
            r#"    { file = "mod.txt", modes = ["archive", "scan"] },"#,
            "    { file = \"mod.txt\", modes = [\"archive\", \"scan\"] },\n    { file = \"mod.txt\", modes = [\"archive\"] },",
        ),
        "marker 'mod.txt' twice",
    );
}

#[test]
fn a_marker_with_no_modes_is_rejected() {
    assert_rejected(
        &BASE.replace(r#"modes = ["archive", "scan"]"#, "modes = []"),
        "no modes",
    );
}

/// Accepting a folder outright and accepting it only on an index match cannot both apply.
#[test]
fn a_marker_claiming_both_scan_and_index_gated_is_rejected() {
    assert_rejected(
        &BASE.replace(
            r#"modes = ["archive", "scan"]"#,
            r#"modes = ["scan", "index_gated"]"#,
        ),
        "both scan and index_gated",
    );
}

#[test]
fn a_repeated_mode_is_rejected() {
    assert_rejected(
        &BASE.replace(
            r#"modes = ["archive", "scan"]"#,
            r#"modes = ["scan", "scan"]"#,
        ),
        "'scan' twice",
    );
}

#[test]
fn a_malformed_companion_extension_is_rejected() {
    for bad in [".ucas", "ucas/evil", r"..\\evil", "", "u cas", "ucas."] {
        assert_rejected(&file_unit(&format!("[\"{bad}\"]")), "write it bare");
    }
}

#[test]
fn a_companion_repeating_the_primary_extension_is_rejected() {
    assert_rejected(&file_unit(r#"["pak"]"#), "repeats the primary extension");
}

#[test]
fn a_companion_listed_twice_is_rejected() {
    assert_rejected(&file_unit(r#"["ucas", "ucas"]"#), "'ucas' twice");
}

#[test]
fn a_malformed_primary_extension_is_rejected() {
    let text = file_unit(r#"["ucas"]"#).replace(r#"extension = "pak""#, r#"extension = ".pak""#);
    assert_rejected(&text, "write it bare");
}

fn second_target(tag: &str, primary: bool) -> String {
    format!(
        "[[targets]]\ntag = \"{tag}\"\nlabel = \"overrides\"\nprimary = {primary}\npath = [\"other\"]\nbackup = [\"other.bak\"]\nactivation = \"filesystem\"\nload_order = \"none\"\n\n[targets.unit]\nkind = \"directory\"\n\n[targets.unit.discovery]\npolicy = \"all_directories\"\n"
    )
}

/// The base manifest with its directory unit swapped for a file unit carrying `companions`.
fn file_unit(companions: &str) -> String {
    let head = BASE
        .split("[targets.unit]")
        .next()
        .expect("base has a unit section")
        .to_string();
    format!(
        "{head}[targets.unit]\nkind = \"file\"\nfamily = {{ extension = \"pak\", companions = {companions} }}\ndisabled_suffix = \".disabled\"\n"
    )
}

/// The authoring model is multiline inline objects, and every shipped manifest uses it. A
/// formatter or a contributor converting these back to arrays of tables would still parse, so
/// only a shape assertion catches it.
#[test]
fn the_shipped_manifests_use_multiline_objects_and_no_table_headers() {
    for id in ["raid", "pd2", "pdth", "pd3", "cb"] {
        let path = format!("src/games/{id}/package.toml");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        for (line, body) in text.lines().enumerate() {
            assert!(
                !body.trim_start().starts_with('['),
                "{path}:{}: table header '{}'; components are values, not headers",
                line + 1,
                body.trim()
            );
        }
        assert!(
            text.contains("\n    {\n"),
            "{path}: no multiline object found"
        );
        toml::from_str::<GamePackage>(&text).unwrap_or_else(|e| panic!("{path}: {e}"));
    }
}

/// The exact style the manifests are authored in, kept as a fixture so a parser or contract
/// change that silently stopped accepting it fails here rather than in five files at once.
#[test]
fn the_authoring_style_parses() {
    let text = r#"
id = "fixture"
name = "Fixture"
short_name = "FIX"
mod_metadata = "none"

sources = [
    {
        provider = "modworkshop",
        game_id = "1",
    },
    {
        provider = "nexus",
        domain = "fixture",
        numeric_id = 2,
    },
]

install = {
    executables = ["Fixture.exe"],
    processes = ["Fixture"],
    stores = [
        {
            provider = "steam",
            app_id = 1,
            folder = "Fixture",
        },
    ],
}

targets = [
    {
        tag = "paks",
        label = "mods",
        primary = true,
        path = ["Paks"],
        backup = ["Paks.bak"],
        activation = "filesystem",
        load_order = "filename_prefix",

        unit = {
            kind = "file",
            disabled_suffix = ".disabled",

            # a comment between object fields
            family = {
                extension = "pak",
                companions = ["ucas", "utoc"],
            },
        },
    },
    {
        tag = "mods",
        label = "modkit_mods",
        path = ["Mods"],
        backup = ["Mods.bak"],
        activation = "filesystem",
        load_order = "none",

        unit = {
            kind = "directory",
            ignore_preset = "diesel_infra",

            discovery = {
                policy = "markers",
                markers = [
                    {
                        file = "mod.txt",
                        modes = ["archive", "scan"],
                    },
                ],
            },
        },
    },
]
"#;
    let pkg: GamePackage = toml::from_str(text).expect("the authoring style parses");
    validate::check("fixture", &pkg).expect("the authoring style validates");
    assert_eq!(pkg.targets.len(), 2);
    assert_eq!(pkg.primary_target().tag, "paks");
}

/// The starter manifest contributors copy. Read through CARGO_MANIFEST_DIR rather than a
/// relative path, so the test does not depend on the working directory a runner chooses.
#[test]
fn the_documented_starter_manifest_is_valid() {
    const PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/reference/package.example.toml"
    );
    let text = std::fs::read_to_string(PATH).unwrap_or_else(|e| panic!("cannot read {PATH}: {e}"));
    let package: GamePackage = toml::from_str(&text).expect("the starter manifest parses");
    validate::check("example", &package).expect("the starter manifest validates");
}
