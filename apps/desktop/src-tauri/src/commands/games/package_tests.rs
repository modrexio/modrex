use super::package::*;
use serde_json::Value;

fn both() -> Vec<GamePackage> {
    vec![raid_package(), crime_boss_package()]
}

#[test]
fn both_games_round_trip_through_json() {
    for pkg in both() {
        let json = serde_json::to_string(&pkg).expect("serialize");
        let back: GamePackage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(pkg, back, "round trip changed package '{}'", pkg.id);
    }
}

#[test]
fn an_unknown_field_is_rejected() {
    let mut json = serde_json::to_value(raid_package()).expect("serialize");
    json.as_object_mut()
        .expect("object")
        .insert("bonusBehaviour".to_string(), Value::from("hook"));
    let err =
        serde_json::from_value::<GamePackage>(json).expect_err("an unknown field must not load");
    assert!(
        err.to_string().contains("bonusBehaviour"),
        "diagnostic should name the offending field, got: {err}"
    );
}

/// A field that exists on the struct but never reaches the JSON is how behaviour hides from
/// a serialized package. The destructuring stops compiling when a field is added, which
/// forces GAME_PACKAGE_KEYS to be updated alongside it.
#[test]
fn every_field_reaches_the_json() {
    for pkg in both() {
        let GamePackage {
            id: _,
            signals: _,
            targets: _,
        } = &pkg;

        let json = serde_json::to_value(&pkg).expect("serialize");
        let object = json.as_object().expect("object");
        for key in GAME_PACKAGE_KEYS {
            assert!(
                object.contains_key(*key),
                "package '{}' does not serialize field '{}'",
                pkg.id,
                key
            );
        }
        assert_eq!(
            object.len(),
            GAME_PACKAGE_KEYS.len(),
            "package '{}' serializes keys not listed in GAME_PACKAGE_KEYS",
            pkg.id
        );
    }
}

#[test]
fn every_capability_id_resolves() {
    for pkg in both() {
        resolve_capabilities(&pkg).expect("all capability ids should resolve");
    }
}

/// Resolution reports the unresolved reference without consulting the game id, so the same
/// check works for a game the checking code was not written against.
#[test]
fn an_unknown_capability_id_names_package_field_and_id() {
    let mut pkg = crime_boss_package();
    pkg.targets[0].enable[0] = CapabilityRef::bare("teleport_the_mod");
    let err = resolve_capabilities(&pkg).expect_err("unknown capability must fail");
    assert!(
        err.contains("cb"),
        "diagnostic must name the package: {err}"
    );
    assert!(
        err.contains("targets[mods].enable[0]"),
        "diagnostic must name the field: {err}"
    );
    assert!(
        err.contains("teleport_the_mod"),
        "diagnostic must name the id: {err}"
    );
}

/// Representation only. Crime Boss records a mod's enabled state in the game's own settings
/// file as well as on disk, so one capability reference per target cannot describe it. The
/// order, failure handling and disable counterpart of these references are undecided, and
/// nothing here asserts them.
#[test]
fn a_target_can_reference_more_than_one_enable_capability() {
    let cb = crime_boss_package();
    let referenced = |tag: &str| -> Vec<String> {
        cb.targets
            .iter()
            .find(|t| t.tag == tag)
            .expect("target")
            .enable
            .iter()
            .map(|c| c.id.clone())
            .collect()
    };
    for tag in ["mods", "paks"] {
        let ids = referenced(tag);
        assert_eq!(ids.len(), 2, "{tag} should reference two capabilities");
        assert!(ids.contains(&"external_json".to_string()));
    }
    assert_eq!(referenced("ue4ss_mods").len(), 1);
}

/// Scanning, path building, identity, state and reorder all read these two facts. Keeping
/// them as target fields is what stops those callers having to find a capability by id and
/// read its parameter map.
#[test]
fn disabled_suffix_and_priority_prefix_are_target_fields() {
    let cb = crime_boss_package();
    let paks = cb.targets.iter().find(|t| t.tag == "paks").expect("target");
    assert_eq!(paks.disabled_suffix.as_deref(), Some(".disabled"));
    assert!(paks.priority_prefix);

    let mods = cb.targets.iter().find(|t| t.tag == "mods").expect("target");
    assert_eq!(mods.disabled_suffix, None);
    assert!(!mods.priority_prefix);

    for pkg in both() {
        for target in &pkg.targets {
            for cap in &target.enable {
                assert!(
                    !cap.params.contains_key("suffix") && !cap.params.contains_key("prefix"),
                    "package '{}' target '{}' hides a naming fact in capability '{}'",
                    pkg.id,
                    target.tag,
                    cap.id
                );
            }
        }
    }
}
