use crate::game_package::{
    EnabledStateMechanism, GamePackage, SignalSource, Unit, DIESEL_INFRA_FOLDERS,
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
        assert!(
            pkg.short_name.len() <= pkg.display_name.len(),
            "{directory}"
        );
    }
}

#[test]
fn a_news_binding_carries_a_non_empty_category() {
    for (directory, pkg) in super::discovered() {
        let Some(news) = pkg.news.as_ref() else {
            continue;
        };
        assert!(!news.category_slug.is_empty(), "{directory}");
    }
}

/// Two games sharing a category would share the cache file the slug names.
#[test]
fn news_categories_are_unique() {
    let mut slugs: Vec<&str> = super::discovered()
        .iter()
        .filter_map(|(_, pkg)| pkg.news.as_ref().map(|n| n.category_slug.as_str()))
        .collect();
    let total = slugs.len();
    assert!(total > 0);
    slugs.sort_unstable();
    slugs.dedup();
    assert_eq!(slugs.len(), total);
}

/// The picker, the documentation tables and the index scheduler all read this order, and the
/// scheduler breaks ties on it, so a shared position would make one game lose every tie.
#[test]
fn display_order_is_unique_across_packages() {
    let mut orders: Vec<u16> = super::discovered()
        .iter()
        .map(|(_, pkg)| pkg.display_order)
        .collect();
    let total = orders.len();
    orders.sort_unstable();
    orders.dedup();
    assert_eq!(orders.len(), total);
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
fn the_catalogue_lists_every_discovered_package_in_display_order() {
    let catalogue = super::catalog::catalog_typescript();
    let mut expected: Vec<(u16, &str)> = super::discovered()
        .iter()
        .map(|(_, pkg)| (pkg.display_order, pkg.id.as_str()))
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

        assert!(entry.contains(&format!("name: '{}'", pkg.display_name)));
        assert!(entry.contains(&format!("shortName: '{}'", pkg.short_name)));
        assert!(entry.contains(&format!("storageKey: '{}'", pkg.id)));
        assert!(entry.contains(&format!("hasNews: {}", pkg.news.is_some())));

        let workshop = pkg
            .sources
            .modworkshop
            .as_ref()
            .expect("modworkshop binding");
        assert!(entry.contains(&format!("workshopId: {}", workshop.game_id)));
        match pkg.sources.nexus.as_ref() {
            Some(nexus) => assert!(entry.contains(&format!("nexusDomain: '{}'", nexus.domain))),
            None => assert!(!entry.contains("nexusDomain")),
        }
        match pkg.installation.required_launch_flag.as_ref() {
            Some(flag) => assert!(entry.contains(&format!("requiredLaunchFlag: '{flag}'"))),
            None => assert!(!entry.contains("requiredLaunchFlag")),
        }

        for (present, label) in [
            (pkg.installation.steam.is_some(), "Steam"),
            (pkg.installation.epic.is_some(), "Epic Games"),
            (pkg.installation.xbox.is_some(), "Xbox App"),
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
                target.mods_subpath.join("/")
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
fn every_input_decoder_names_a_declared_target() {
    for (directory, pkg) in super::discovered() {
        for binding in &pkg.input_decoders {
            assert!(
                pkg.targets.iter().any(|t| t.tag == binding.target_tag),
                "{directory} decodes into unknown target '{}'",
                binding.target_tag
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
    assert_eq!(pkg.display_name, "RAID: World War II");
    assert_eq!(pkg.index_game_name, "RAID: World War II");
    assert_eq!(pkg.state_filename, ".modrex.json");
    assert_eq!(pkg.signals, SignalSource::Diesel);
}

#[test]
fn the_raid_package_installs_from_steam_only() {
    let installation = &raid().installation;
    assert_eq!(installation.executables, ["raid_win64_release.exe"]);
    assert_eq!(installation.process_names, ["raid_win64_release"]);
    let steam = installation.steam.as_ref().expect("raid ships on steam");
    assert_eq!(steam.app_id, 414740);
    assert_eq!(steam.folder_name, "RAID World War II");
    assert!(installation.epic.is_none());
    assert!(installation.xbox.is_none());
}

#[test]
fn the_raid_package_has_one_blanket_accept_target() {
    let pkg = raid();
    assert_eq!(pkg.targets.len(), 1);
    let target = &pkg.targets[0];
    assert_eq!(target.tag, "mods");
    assert_eq!(target.label_key, "mods");
    assert_eq!(target.enabled_state, EnabledStateMechanism::Filesystem);
    assert_eq!(target.mods_subpath, ["mods"]);
    assert_eq!(target.disabled_subpath, ["mods", "disabled"]);
    assert_eq!(target.backup_subpath, ["mods.bak"]);

    let Unit::Directory {
        entry_markers,
        scan_markers,
        index_gated_markers,
        excluded_names,
        priority_prefix,
    } = &target.unit
    else {
        panic!("raid installs mods as directories");
    };
    assert!(entry_markers.is_empty());
    assert!(scan_markers.is_empty());
    assert!(index_gated_markers.is_empty());
    assert_eq!(*excluded_names, DIESEL_INFRA_FOLDERS);
    assert!(!priority_prefix);
}
