use crate::game_package::{
    Activation, Discovery, GamePackage, LoadOrder, ModMetadata, NamePreset, NewsBinding,
    SourceBinding, StoreBinding, Unit,
};

fn raid() -> &'static GamePackage {
    &super::discovered()
        .iter()
        .find(|(directory, _)| *directory == "raid")
        .expect("raid is discovered")
        .1
}

/// Repeated lookups hand back the same values, so a package is built once per process and
/// the runtime registry can borrow from it rather than copying it.
#[test]
fn discovery_hands_back_one_cached_set_of_packages() {
    assert!(std::ptr::eq(super::discovered(), super::discovered()));
}

/// A package module authors data, so building the set twice yields the same values. This
/// catches a constructor that varies its result, not one that merely reads something.
#[test]
fn constructing_the_built_in_packages_twice_yields_the_same_values() {
    assert_eq!(super::built_in_packages(), super::built_in_packages());
}

#[test]
fn every_discovered_package_round_trips_through_json() {
    for (directory, pkg) in super::discovered() {
        let json = serde_json::to_string(pkg).expect("package serializes");
        let restored: GamePackage = serde_json::from_str(&json).expect("package deserializes");
        assert_eq!(restored, *pkg, "{directory}");
    }
}

/// The frontend keys browser storage by game. Nothing stores that key because it is the
/// package id, so the id must stay usable as one.
#[test]
fn every_package_id_is_usable_as_a_storage_key() {
    for (directory, pkg) in super::discovered() {
        assert!(!pkg.id.is_empty(), "{directory}");
        assert!(
            pkg.id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "{directory} has an id that is not a plain storage key"
        );
    }
}

#[test]
fn every_package_declares_a_short_name_distinct_from_its_display_name() {
    for (directory, pkg) in super::discovered() {
        assert!(!pkg.short_name.is_empty(), "{directory}");
        assert!(pkg.short_name.len() <= pkg.name.len(), "{directory}");
    }
}

#[test]
fn a_news_binding_carries_a_non_empty_category() {
    for (directory, pkg) in super::discovered() {
        for feed in &pkg.news {
            let NewsBinding::PaydayTheGame { category } = feed;
            assert!(!category.is_empty(), "{directory}");
        }
    }
}

/// Two games sharing a category would share the cache file the slug names.
#[test]
fn news_categories_are_unique() {
    let mut slugs: Vec<&str> = super::discovered()
        .iter()
        .flat_map(|(_, pkg)| &pkg.news)
        .map(|feed| {
            let NewsBinding::PaydayTheGame { category } = feed;
            category.as_str()
        })
        .collect();
    let total = slugs.len();
    assert!(total > 0);
    slugs.sort_unstable();
    slugs.dedup();
    assert_eq!(slugs.len(), total);
}

#[test]
fn generating_the_catalogue_twice_is_byte_identical() {
    assert_eq!(
        super::catalog::catalog_typescript(),
        super::catalog::catalog_typescript()
    );
}

#[test]
fn the_catalogue_carries_nothing_machine_specific() {
    let catalogue = super::catalog::catalog_typescript();
    assert!(!catalogue.contains(env!("CARGO_MANIFEST_DIR")));
    for root in ["C:\\", "C:/", "/home/", "/Users/"] {
        assert!(!catalogue.contains(root), "catalogue names {root}");
    }
}

#[test]
fn the_catalogue_lists_every_discovered_package_by_display_name() {
    let catalogue = super::catalog::catalog_typescript();
    let mut expected: Vec<(&str, &str)> = super::discovered()
        .iter()
        .map(|(_, pkg)| (pkg.name.as_str(), pkg.id.as_str()))
        .collect();
    expected.sort_unstable();

    let listed: Vec<&str> = catalogue
        .lines()
        .filter_map(|line| {
            line.strip_prefix("    ")
                .and_then(|l| l.strip_suffix(": {"))
        })
        .collect();
    assert_eq!(
        listed,
        expected.iter().map(|(_, id)| *id).collect::<Vec<_>>()
    );
}

/// Every game fact in the catalogue comes from the package, so a game reaches the frontend
/// by declaring itself and nothing else.
#[test]
fn the_catalogue_derives_each_game_from_its_package() {
    let catalogue = super::catalog::catalog_typescript();
    for (directory, pkg) in super::discovered() {
        let entry = catalogue
            .split(&format!(
                "    {}: {{
",
                pkg.id
            ))
            .nth(1)
            .and_then(|rest| {
                rest.split(
                    "
    },",
                )
                .next()
            })
            .unwrap_or_else(|| panic!("{directory} is not in the catalogue"));

        assert!(entry.contains(&format!("name: '{}'", pkg.name)));
        assert!(entry.contains(&format!("shortName: '{}'", pkg.short_name)));
        assert!(entry.contains(&format!("storageKey: '{}'", pkg.id)));
        assert!(entry.contains(&format!("hasNews: {}", !pkg.news.is_empty())));

        let workshop = pkg.sources.iter().find_map(|binding| match binding {
            SourceBinding::ModWorkshop { game_id } => Some(game_id),
            SourceBinding::Nexus { .. } => None,
        });
        match workshop {
            Some(game_id) => assert!(entry.contains(&format!("workshopId: {game_id}"))),
            None => assert!(!entry.contains("workshopId")),
        }
        let nexus = pkg.sources.iter().find_map(|binding| match binding {
            SourceBinding::Nexus { domain, .. } => Some(domain),
            SourceBinding::ModWorkshop { .. } => None,
        });
        match nexus {
            Some(domain) => assert!(entry.contains(&format!("nexusDomain: '{domain}'"))),
            None => assert!(!entry.contains("nexusDomain")),
        }
        match pkg.install.launch_flag.as_ref() {
            Some(flag) => assert!(entry.contains(&format!("requiredLaunchFlag: '{flag}'"))),
            None => assert!(!entry.contains("requiredLaunchFlag")),
        }

        let has = |provider: &str| pkg.install.stores.iter().any(|s| s.provider() == provider);
        for (present, label) in [
            (has("steam"), "Steam"),
            (has("epic"), "Epic Games"),
            (has("xbox"), "Xbox App"),
        ] {
            assert_eq!(
                entry.contains(&format!("'{label}'")),
                present,
                "{directory} launcher {label}"
            );
        }

        for target in &pkg.targets {
            assert!(entry.contains(&format!(
                "{{ id: '{}', path: '{}' }}",
                target.tag,
                target.path.join("/")
            )));
        }
    }
}

#[test]
fn catalogue_strings_are_escaped() {
    assert_eq!(super::catalog::quote_for_test("plain"), "'plain'");
    assert_eq!(super::catalog::quote_for_test("it's"), r"'it\'s'");
    assert_eq!(
        super::catalog::quote_for_test(r"back\slash"),
        r"'back\\slash'"
    );
}

/// Decoded content installs into the named target, so a tag no target declares would stage
/// into a location the scan never reads.
#[test]
fn every_decoder_names_a_declared_target() {
    for (directory, pkg) in super::discovered() {
        for binding in &pkg.decoders {
            assert!(
                pkg.targets.iter().any(|t| t.tag == binding.target()),
                "{directory} decodes into unknown target '{}'",
                binding.target()
            );
        }
    }
}

#[test]
fn an_unknown_package_field_is_rejected() {
    let mut value = serde_json::to_value(raid()).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .insert("mystery".to_string(), serde_json::Value::Bool(true));
    let err = serde_json::from_value::<GamePackage>(value)
        .expect_err("unknown fields are rejected")
        .to_string();
    assert!(err.contains("mystery"), "{err}");
}

#[test]
fn an_unknown_target_field_is_rejected() {
    let mut value = serde_json::to_value(raid()).unwrap();
    value["targets"][0]
        .as_object_mut()
        .unwrap()
        .insert("mystery".to_string(), serde_json::Value::Bool(true));
    let err = serde_json::from_value::<GamePackage>(value)
        .expect_err("unknown fields are rejected")
        .to_string();
    assert!(err.contains("mystery"), "{err}");
}

#[test]
fn the_raid_package_declares_its_identity() {
    let pkg = raid();
    assert_eq!(pkg.id, "raid");
    assert_eq!(pkg.name, "RAID: World War II");
    assert_eq!(pkg.mod_metadata, ModMetadata::Diesel);
}

#[test]
fn the_raid_package_installs_from_steam_only() {
    let install = &raid().install;
    assert_eq!(install.executables, ["raid_win64_release.exe"]);
    assert_eq!(install.processes, ["raid_win64_release"]);
    assert_eq!(
        install.stores,
        [StoreBinding::Steam {
            app_id: 414740,
            folder: "RAID World War II".to_string(),
        }]
    );
}

#[test]
fn the_raid_package_has_one_blanket_accept_target() {
    let pkg = raid();
    assert_eq!(pkg.targets.len(), 1);
    let target = &pkg.targets[0];
    assert_eq!(target.tag, "mods");
    assert!(target.primary);
    assert_eq!(target.activation, Activation::Filesystem);
    assert_eq!(target.load_order, LoadOrder::None);
    assert_eq!(target.path, ["mods"]);
    assert_eq!(target.backup, ["mods.bak"]);

    let Unit::Directory {
        discovery,
        ignore_preset,
        contains,
    } = &target.unit
    else {
        panic!("raid installs mods as directories");
    };
    assert_eq!(*discovery, Discovery::AllDirectories);
    assert_eq!(*ignore_preset, Some(NamePreset::DieselInfra));
    assert!(contains.is_none());
}

#[test]
fn the_catalogue_reports_viewer_support_without_the_key_it_would_use() {
    let catalogue = super::catalog::catalog_typescript();
    for (_, pkg) in super::discovered() {
        let entry = catalogue
            .split(&format!("    {}: {{\n", pkg.id))
            .nth(1)
            .and_then(|rest| rest.split("\n    },").next())
            .unwrap_or_else(|| panic!("{} is missing from the catalogue", pkg.id));
        assert!(
            entry.contains(&format!(
                "supportsPackageViewer: {},",
                pkg.package_reader.is_some()
            )),
            "{} reports the wrong viewer support",
            pkg.id
        );
    }

    // The key decrypts the game's own packages and the renderer never needs it, so the
    // projection stops at the capability.
    for (_, pkg) in super::discovered() {
        let Some(reader) = pkg.package_reader.as_ref() else {
            continue;
        };
        assert!(
            !catalogue.contains(reader.aes_key()),
            "{} leaked its package key into the catalogue",
            pkg.id
        );
    }
    assert!(
        !catalogue.contains("aes"),
        "the catalogue names a key field"
    );
}
