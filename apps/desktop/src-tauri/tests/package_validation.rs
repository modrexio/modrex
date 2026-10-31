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
label = "pak_mods"
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
        "expected one of `all_directories`, `markers`, `unreal_plugin`",
    );
    assert_rejected(
        &BASE.replace(
            r#"modes = ["archive", "scan"]"#,
            r#"modes = ["archive", "look"]"#,
        ),
        "expected one of `archive`, `scan`, `index_gated`",
    );
    assert_rejected(
        &BASE.replace(r#"label = "pak_mods""#, r#"label = "Mods""#),
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
fn a_built_in_loader_without_mod_pages_is_rejected() {
    assert_rejected(
        &format!("{BASE}\n[[loaders]]\nkind = \"built_in\"\n"),
        "built_in loader needs at least one modworkshop id",
    );
}

#[test]
fn target_labels_have_exact_manifest_values_and_interface_keys() {
    for (value, key) in [
        ("mods", "mods"),
        ("pak_mods", "pakMods"),
        ("loader_mods", "loaderMods"),
        ("overrides", "overrides"),
        ("modkit_mods", "modkitMods"),
        ("legacy_paks", "legacyPaks"),
    ] {
        let text = with_root_declaration("loaders = [{ kind = \"dahm\" }]").replace(
            "label = \"pak_mods\"",
            &format!("label = \"{value}\"\nloader = \"dahm\""),
        );
        let package: GamePackage = toml::from_str(&text).unwrap();
        validate::check("fixture", &package).unwrap();
        assert_eq!(package.targets[0].label.key(), key);
        assert_eq!(
            serde_json::to_value(package.targets[0].label).unwrap(),
            value
        );
        assert_eq!(package.targets[0].loader.as_deref(), Some("dahm"));
    }
    assert_rejected(
        &BASE.replace("label = \"pak_mods\"", "label = \"ue4ss_mods\""),
        "unknown variant `ue4ss_mods`",
    );
}

#[test]
fn a_declared_loader_can_have_no_target_and_a_target_can_have_no_loader() {
    let text = with_root_declaration("loaders = [{ kind = \"dahm\" }]");
    let package: GamePackage = toml::from_str(&text).unwrap();
    validate::check("fixture", &package).unwrap();
    assert!(package.targets[0].loader.is_none());
}

#[test]
fn a_target_loader_must_be_declared_by_the_package() {
    for loader in ["dahm", "unknown", ""] {
        assert_rejected(
            &BASE.replace(
                "label = \"pak_mods\"",
                &format!("label = \"pak_mods\"\nloader = \"{loader}\""),
            ),
            "which the package does not declare",
        );
    }
}

#[test]
fn loader_mods_requires_an_explicit_loader() {
    let text = with_root_declaration("loaders = [{ kind = \"dahm\" }]")
        .replace("label = \"pak_mods\"", "label = \"loader_mods\"");
    assert_rejected(&text, "label loader_mods requires a loader");
}

#[test]
fn a_loader_cannot_serve_two_targets_even_with_different_labels() {
    let base = with_root_declaration("loaders = [{ kind = \"dahm\" }]").replace(
        "label = \"pak_mods\"",
        "label = \"loader_mods\"\nloader = \"dahm\"",
    );
    let extra = second_target("extra", false).replace(
        "label = \"overrides\"",
        "label = \"overrides\"\nloader = \"dahm\"",
    );
    assert_rejected(
        &format!("{base}\n{extra}"),
        "loader 'dahm' to more than one target",
    );
}

#[test]
fn non_loader_labels_are_unique_regardless_of_loader() {
    for label in ["pak_mods", "overrides", "modkit_mods", "legacy_paks"] {
        for loaders in [false, true] {
            let mut base =
                with_root_declaration("loaders = [{ kind = \"dahm\" }, { kind = \"superblt\" }]")
                    .replace("label = \"pak_mods\"", &format!("label = \"{label}\""));
            let mut extra = second_target("extra", false)
                .replace("label = \"overrides\"", &format!("label = \"{label}\""));
            if loaders {
                base = base.replace("primary = true", "loader = \"dahm\"\nprimary = true");
                extra = extra.replace("primary = false", "loader = \"superblt\"\nprimary = false");
            }
            assert_rejected(&format!("{base}\n{extra}"), "repeats resolved label");
        }
    }
}

#[test]
fn loader_mods_labels_are_distinct_only_for_different_loaders() {
    let base = with_root_declaration("loaders = [{ kind = \"dahm\" }, { kind = \"superblt\" }]")
        .replace(
            "label = \"pak_mods\"",
            "label = \"loader_mods\"\nloader = \"dahm\"",
        );
    let extra = second_target("extra", false).replace(
        "label = \"overrides\"",
        "label = \"loader_mods\"\nloader = \"superblt\"",
    );
    let text = format!("{base}\n{extra}");
    let package: GamePackage = toml::from_str(&text).unwrap();
    validate::check("fixture", &package).unwrap();
    assert_rejected(
        &text.replace("loader = \"superblt\"", "loader = \"dahm\""),
        "loader 'dahm' to more than one target",
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

#[test]
fn the_generic_mods_label_is_only_valid_on_a_sole_target() {
    let base = BASE.replacen("label = \"pak_mods\"", "label = \"mods\"", 1);
    let package: GamePackage = toml::from_str(&base).unwrap();
    validate::check("fixture", &package).unwrap();
    assert_rejected(
        &format!(
            "{base}
{}",
            second_target("extra", false)
        ),
        "only a game's sole target",
    );
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
        label = "pak_mods",
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

const KEY: &str = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

/// Root declarations precede the first table because BASE ends inside a nested table.
/// before the first section header rather than being appended.
fn with_root_declaration(declaration: &str) -> String {
    BASE.replacen(
        "
[install]",
        &format!(
            "
{declaration}
[install]"
        ),
        1,
    )
}

const MOVIES: &str = r#"movie_replacement = { formats = ["bink"], directory = ["Content", "Movies"], storefronts = ["steam"] }"#;
const MP4_MOVIES: &str = r#"movie_replacement = { formats = ["mp4"], directory = ["Content", "Movies"], storefronts = ["steam"] }"#;
const CONFIGS: &str = r#"config_presets = { format = "unreal_engine_ini" }"#;
const CONFIG_LOCATION: &str = r#"config_presets = { format = "unreal_engine_ini" }
unreal_config = { roots = [{ root = "windows_local_app_data", store = "steam", path = ["Fixture", "Saved", "Config"] }] }"#;
const GRAPHICS: &str = r#"graphics_config = { filename = "renderer_settings.xml" }"#;
const GRAPHICS_LOCATION: &str = r#"graphics_config = { filename = "renderer_settings.xml", locations = [{ root = "windows_local_app_data", store = "steam", path = ["Fixture", "renderer_settings.xml"] }] }"#;

#[test]
fn resource_capabilities_are_optional_and_independent() {
    for (declaration, movies, configs) in [
        (String::new(), false, false),
        (MOVIES.into(), true, false),
        (MP4_MOVIES.into(), true, false),
        (CONFIGS.into(), false, true),
        (format!("{MOVIES}\n{CONFIG_LOCATION}"), true, true),
    ] {
        let package: GamePackage = toml::from_str(&with_root_declaration(&declaration)).unwrap();
        validate::check("fixture", &package).unwrap();
        assert_eq!(package.movie_replacement.is_some(), movies);
        assert_eq!(package.config_presets.is_some(), configs);
    }
}

#[test]
fn resource_contract_rejects_unimplemented_formats_and_unknown_fields() {
    for (declaration, expected) in [
        (MOVIES.replace("bink", "webm"), "unknown variant"),
        (
            MOVIES.replace("formats =", "callback = \"run\", formats ="),
            "unknown field",
        ),
        (
            CONFIGS.replace("unreal_engine_ini", "json"),
            "unknown variant",
        ),
        (
            CONFIG_LOCATION.replace("windows_local_app_data", "home"),
            "unknown variant",
        ),
        (
            CONFIG_LOCATION.replace("root =", "platform = \"windows\", root ="),
            "unknown field",
        ),
    ] {
        assert_rejected(&with_root_declaration(&declaration), expected);
    }
}

#[test]
fn movie_formats_keep_distinct_extensions() {
    let both = MOVIES.replace(r#"["bink"]"#, r#"["bink", "mp4"]"#);
    for (declaration, extensions) in [
        (MOVIES.to_string(), &["bk2"][..]),
        (MP4_MOVIES.to_string(), &["mp4"][..]),
        (both, &["bk2", "mp4"][..]),
    ] {
        let package: GamePackage = toml::from_str(&with_root_declaration(&declaration)).unwrap();
        validate::check("fixture", &package).unwrap();
        let movies = package.movie_replacement.unwrap();
        let declared: Vec<_> = movies.formats.iter().map(|f| f.extension()).collect();
        assert_eq!(declared, extensions);
        assert_eq!(movies.directory, ["Content", "Movies"]);
        assert_eq!(movies.storefronts.len(), 1);
        assert_eq!(
            movies.format_of("Heists/Intro.BK2").is_some(),
            extensions.contains(&"bk2")
        );
    }
}

#[test]
fn movie_declarations_reject_unsafe_destinations_and_unlisted_stores() {
    for (declaration, expected) in [
        (
            MOVIES.replace(r#"["Content", "Movies"]"#, "[]"),
            "empty path",
        ),
        (
            MOVIES.replace(r#"["Content", "Movies"]"#, r#"["..", "Movies"]"#),
            "plain relative",
        ),
        (
            MOVIES.replace(r#"["Content", "Movies"]"#, r#"["C:/Movies"]"#),
            "plain relative",
        ),
        (
            MOVIES.replace(r#"["steam"]"#, r#"["steam", "steam"]"#),
            "store twice",
        ),
        (
            MOVIES.replace(r#"["steam"]"#, r#"["epic"]"#),
            "install does not list",
        ),
        (MOVIES.replace(r#"["bink"]"#, "[]"), "no formats"),
        (
            MOVIES.replace(r#"["bink"]"#, r#"["bink", "bink"]"#),
            "format twice",
        ),
    ] {
        assert_rejected(&with_root_declaration(&declaration), expected);
    }
}

#[test]
fn config_locations_are_verified_relative_paths_for_a_declared_store() {
    for (declaration, expected) in [
        (CONFIG_LOCATION.replace(r#"store = "steam""#, r#"store = "epic""#), "install does not list"),
        (CONFIG_LOCATION.replace(r#"["Fixture", "Saved", "Config"]"#, "[]"), "empty path"),
        (CONFIG_LOCATION.replace("Fixture", ".."), "plain relative"),
        ("unreal_config = { roots = [] }".into(), "no roots"),
        (format!("{CONFIG_LOCATION}\n{GRAPHICS_LOCATION}"), "cannot coexist"),
        (r#"config_presets = { format = "unreal_engine_ini", locations = [] }"#.into(), "unknown field"),
        (CONFIG_LOCATION.replace(r#"roots = [{"#, r#"roots = [{ root = "windows_user_profile", store = "steam", path = ["Config"] }, {"#), "twice"),
    ] {
        assert_rejected(&with_root_declaration(&declaration), expected);
    }
}

#[test]
fn graphics_config_access_is_independent_of_installable_resources() {
    for (resources, movies, presets) in [
        (String::new(), false, false),
        (MOVIES.into(), true, false),
        (CONFIGS.into(), false, true),
        (format!("{MOVIES}\n{CONFIG_LOCATION}"), true, true),
    ] {
        let declaration = format!("{resources}\n{GRAPHICS}");
        let package: GamePackage = toml::from_str(&with_root_declaration(&declaration)).unwrap();
        validate::check("fixture", &package).unwrap();
        let config = package.graphics_config.as_ref().unwrap();
        assert_eq!(config.filename, "renderer_settings.xml");
        assert!(config.locations.is_empty());
        assert_eq!(package.movie_replacement.is_some(), movies);
        assert_eq!(package.config_presets.is_some(), presets);
    }
}

#[test]
fn graphics_config_filenames_cannot_grant_paths_outside_the_chosen_folder() {
    for filename in [
        "",
        ".",
        "..",
        "../renderer.xml",
        r"..\renderer.xml",
        "C:renderer.xml",
        "renderer\t.xml",
    ] {
        let declaration = GRAPHICS.replace(
            "\"renderer_settings.xml\"",
            &serde_json::to_string(filename).unwrap(),
        );
        assert_rejected(&with_root_declaration(&declaration), "plain relative");
    }
}

#[test]
fn graphics_config_locations_require_verified_stores_and_matching_filenames() {
    let package: GamePackage = toml::from_str(&with_root_declaration(GRAPHICS_LOCATION)).unwrap();
    validate::check("fixture", &package).unwrap();
    for (declaration, expected) in [
        (GRAPHICS_LOCATION.replace(r#"store = "steam""#, r#"store = "epic""#), "install does not list"),
        (GRAPHICS_LOCATION.replace(r#"["Fixture", "renderer_settings.xml"]"#, "[]"), "empty path"),
        (GRAPHICS_LOCATION.replace("Fixture", ".."), "plain relative"),
        (GRAPHICS_LOCATION.replace(r#"["Fixture", "renderer_settings.xml"]"#, r#"["Fixture", "other.xml"]"#), "must end in renderer_settings.xml"),
        (GRAPHICS_LOCATION.replace(r#"locations = [{"#, r#"locations = [{ root = "windows_local_app_data", store = "steam", path = ["renderer_settings.xml"] }, {"#), "twice"),
        (GRAPHICS_LOCATION.replace("windows_local_app_data", "home"), "unknown variant"),
        (GRAPHICS.replace("filename =", "parser = \"xml\", filename ="), "unknown field"),
    ] {
        assert_rejected(&with_root_declaration(&declaration), expected);
    }
}

#[test]
fn a_package_reader_declaration_is_accepted_and_reaches_the_package() {
    let text = with_root_declaration(&format!(
        "package_reader = {{ format = \"unreal\", aes_key = \"{KEY}\" }}"
    ));
    let package: GamePackage = toml::from_str(&text).expect("a declared reader parses");
    validate::check("fixture", &package).expect("a declared reader validates");
    let Some(modrex_game_package::PackageReaderBinding::Unreal { aes_key }) =
        package.package_reader.as_ref()
    else {
        panic!("the reader did not survive parsing");
    };
    assert_eq!(aes_key, KEY);
}

#[test]
fn a_package_without_a_reader_declares_none_rather_than_a_default() {
    let package: GamePackage = toml::from_str(BASE).expect("the base fixture parses");
    assert!(package.package_reader.is_none());
}

#[test]
fn a_key_of_the_wrong_length_is_rejected() {
    assert_rejected(
        &with_root_declaration(
            "package_reader = { format = \"unreal\", aes_key = \"0123456789\" }",
        ),
        "64 hexadecimal characters",
    );
}

#[test]
fn a_key_that_is_not_hexadecimal_is_rejected() {
    let key = format!("Z{}", &KEY[1..]);
    assert_rejected(
        &with_root_declaration(&format!(
            "package_reader = {{ format = \"unreal\", aes_key = \"{key}\" }}"
        )),
        "64 hexadecimal characters",
    );
}

#[test]
fn an_unknown_package_reader_format_is_rejected() {
    assert_rejected(
        &with_root_declaration("package_reader = { format = \"zip\", aes_key = \"00\" }"),
        "unreal",
    );
}

#[test]
fn an_unknown_field_on_a_package_reader_is_rejected() {
    assert_rejected(
        &with_root_declaration(&format!(
            "package_reader = {{ format = \"unreal\", aes_key = \"{KEY}\", nonce = \"1\" }}"
        )),
        "nonce",
    );
}

const XBOX_STORE: &str =
    "{ provider = \"xbox\", product_id = \"X\", executable = \"Game/Binaries/WinGDK/Game.exe\" },";

fn with_store_paths(stores: &str, primary: bool, store_paths: &str) -> String {
    let base = BASE.replace(
        "    { provider = \"steam\", app_id = 1, folder = \"Fixture\" },\n",
        &format!("    {{ provider = \"steam\", app_id = 1, folder = \"Fixture\" }},\n{stores}\n"),
    );
    let target = second_target("ue4ss_mods", primary).replace(
        "backup = [\"other.bak\"]\n",
        &format!("backup = [\"other.bak\"]\nstore_paths = [{store_paths}]\n"),
    );
    format!("{base}\n{target}")
}

const XBOX_PATH: &str = "{ store = \"xbox\", path = [\"gdk\"], backup = [\"gdk.bak\"] }";

#[test]
fn a_store_path_for_a_store_with_its_own_executable_is_accepted() {
    let text = with_store_paths(XBOX_STORE, false, XBOX_PATH);
    let parsed: GamePackage = toml::from_str(&text).expect("parses");
    validate::check("fixture", &parsed).expect("passes the checks");
    let target = parsed
        .targets
        .iter()
        .find(|t| t.tag == "ue4ss_mods")
        .unwrap();
    assert_eq!(target.store_paths[0].path, ["gdk"]);
}

#[test]
fn a_store_path_for_a_store_without_its_own_executable_is_rejected() {
    assert_rejected(
        &with_store_paths(
            XBOX_STORE,
            false,
            "{ store = \"steam\", path = [\"a\"], backup = [\"b\"] }",
        ),
        "names no executable of its own",
    );
}

#[test]
fn a_store_path_for_a_store_the_game_is_not_sold_on_is_rejected() {
    assert_rejected(
        &with_store_paths("", false, XBOX_PATH),
        "which install does not list",
    );
}

#[test]
fn a_store_path_on_the_primary_target_is_rejected() {
    let text = with_store_paths(XBOX_STORE, false, XBOX_PATH)
        .replace("primary = true", "primary = false")
        .replace(
            "primary = false\npath = [\"other\"]",
            "primary = true\npath = [\"other\"]",
        );
    assert_rejected(&text, "is primary and declares store_paths");
}

#[test]
fn two_store_paths_for_one_store_are_rejected() {
    assert_rejected(
        &with_store_paths(XBOX_STORE, false, &format!("{XBOX_PATH}, {XBOX_PATH}")),
        "two store_paths for the 'xbox' store",
    );
}

#[test]
fn a_ue4ss_install_folder_for_an_unlisted_storefront_is_rejected() {
    assert_rejected(
        &format!(
            "{BASE}\n[[loaders]]\nkind = \"ue4ss\"\nstorefronts = [\"steam\"]\nproxy_dlls = [\"x.dll\"]\ninstall_into = [\"Bin\"]\nstore_install_into = [{{ store = \"xbox\", install_into = [\"Gdk\"] }}]\n"
        ),
        "which its storefronts do not list",
    );
}

#[test]
fn a_ue4ss_target_path_that_does_not_end_in_mods_is_rejected() {
    let text = second_target("ue4ss_mods", false).replace(
        "activation = \"filesystem\"",
        "activation = \"ue4ss_mods_txt\"",
    );
    assert_rejected(
        &format!(
            "{BASE}
{text}"
        ),
        "must end in Mods",
    );
}

fn with_plugin_target(fields: &str) -> String {
    format!(
        "{BASE}
[[targets]]
tag = \"plugins\"
label = \"loader_mods\"
loader = \"pdml\"
path = [\"Game\", \"Mods\"]
activation = \"filesystem\"
load_order = \"none\"
{fields}

[targets.unit]
kind = \"directory\"

[targets.unit.discovery]
policy = \"unreal_plugin\"

[[loaders]]
kind = \"pdml\"
modworkshop_ids = [59255]
"
    )
}

#[test]
fn a_plugin_target_disabling_outside_its_path_is_accepted() {
    let text = with_plugin_target(
        "disabled = [\"Game\", \"Mods.disabled\"]\nbackup = [\"Game\", \"Mods.bak\"]",
    );
    let parsed: GamePackage = toml::from_str(&text).expect("parses");
    validate::check("fixture", &parsed).expect("passes the checks");
}

#[test]
fn a_plugin_target_must_declare_where_disabled_plugins_go() {
    assert_rejected(
        &with_plugin_target("backup = [\"Game\", \"Mods.bak\"]"),
        "without a disabled path",
    );
}

#[test]
fn a_plugin_target_cannot_disable_inside_the_folder_unreal_searches() {
    assert_rejected(
        &with_plugin_target(
            "disabled = [\"Game\", \"Mods\", \"disabled\"]\nbackup = [\"Game\", \"Mods.bak\"]",
        ),
        "disabled path inside path",
    );
}

#[test]
fn a_plugin_target_cannot_back_up_inside_the_folder_unreal_searches() {
    assert_rejected(
        &with_plugin_target(
            "disabled = [\"Game\", \"Mods.disabled\"]\nbackup = [\"Game\", \"mods\", \"bak\"]",
        )
        .replace("path = [\"Game\", \"Mods\"]", "path = [\"Game\", \"mods\"]")
        .replace(
            "disabled = [\"Game\", \"Mods.disabled\"]",
            "disabled = [\"Game\", \"mods.disabled\"]",
        ),
        "backup inside path",
    );
}

#[test]
fn a_disabled_path_equal_to_the_target_path_is_rejected() {
    assert_rejected(
        &BASE.replace(
            "backup = [\"mods.bak\"]",
            "disabled = [\"MODS\"]\nbackup = [\"mods.bak\"]",
        ),
        "equal to its path",
    );
}

#[test]
fn the_pdml_loader_needs_a_plugin_target_naming_it() {
    assert_rejected(
        &format!("{BASE}\n[[loaders]]\nkind = \"pdml\"\nmodworkshop_ids = [59255]\n"),
        "pdml loader without a target",
    );
}

const SHARED_PAKS: &str = r#"
id = "fixture"
name = "Fixture"
short_name = "FIX"
mod_metadata = "none"

[install]
executables = ["Fixture.exe"]
processes = ["Fixture"]
stores = [
    { provider = "steam", app_id = 1, folder = "Fixture" },
    { provider = "epic", name = "Fixture" },
]

[[targets]]
tag = "paks"
label = "pak_mods"
primary = true
scope = "unreal_paks"
path = ["Fixture", "Content", "Paks"]
backup = ["Fixture", "Content", "Paks.mods.bak"]
activation = "filesystem"
load_order = "none"

[targets.unit]
kind = "file"
disabled_suffix = ".disabled"
filename = "archive"
family = { extension = "pak", companions = [] }
"#;

#[test]
fn shared_paks_accept_the_stores_that_list_installed_files() {
    let parsed: GamePackage = toml::from_str(SHARED_PAKS).expect("shared Paks parse");
    validate::check("fixture", &parsed).expect("Steam and Epic list the installed files");
}

#[test]
fn shared_paks_with_an_xbox_binding_accept_single_file_mods() {
    let text = SHARED_PAKS.replace(
        r#"{ provider = "epic", name = "Fixture" },"#,
        r#"{ provider = "epic", name = "Fixture" },
    { provider = "xbox", product_id = "9N", executable = "Fixture.exe" },"#,
    );
    let parsed: GamePackage = toml::from_str(&text).expect("shared Paks parse");
    validate::check("fixture", &parsed).expect("an Xbox copy manages the files Modrex placed");
}

#[test]
fn shared_paks_with_an_xbox_binding_refuse_companions() {
    assert_rejected(
        &SHARED_PAKS
            .replace(
                r#"{ provider = "epic", name = "Fixture" },"#,
                r#"{ provider = "xbox", product_id = "9N", executable = "Fixture.exe" },"#,
            )
            .replace("companions = []", r#"companions = ["ucas", "utoc"]"#),
        "cannot declare companions",
    );
}
