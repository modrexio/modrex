//! Invariants every game in GAME_REGISTRY must satisfy, written once and run for every
//! spec. A family-conforming new game gets this coverage by existing in the registry;
//! anything it breaks here is a wiring mistake, not a novel behaviour. Game-specific
//! behaviour (crimeboss_settings, pdmod, RAID marker parsing) stays in its own tests, and
//! the loader registry's own invariants stay in loaders.rs.

use std::collections::HashSet;

use tempfile::TempDir;

use crate::commands::games::GAME_REGISTRY;
use crate::commands::mods::{
    backup_dir, disabled_dir, get_state_path, mods_dir, read_state, save_state, InstalledMod,
    ModsState,
};

#[test]
fn every_game_resolves_its_own_engine_and_def() {
    for spec in GAME_REGISTRY.iter() {
        assert_eq!(
            spec.id, spec.engine.game_id,
            "engine game_id for {}",
            spec.id
        );
        assert!(
            !spec.engine.index_game_name.is_empty(),
            "{} has no index_game_name, so no mod can ever be identified by hash",
            spec.id
        );
        assert!(
            !spec.engine.state_filename.is_empty(),
            "{} has no state_filename",
            spec.id
        );
        assert!(
            !spec.engine.targets.is_empty(),
            "{} has no targets",
            spec.id
        );
    }
}

#[test]
fn every_game_is_detectable_by_at_least_one_store() {
    for spec in GAME_REGISTRY.iter() {
        let def = spec.def;
        assert!(!def.name.is_empty(), "{} has no name", spec.id);
        assert!(
            !def.executables.is_empty(),
            "{} has no executable, so no launcher can confirm an install path",
            spec.id
        );
        assert!(
            !def.process_names.is_empty(),
            "{} has no process name, so is_game_running can never be true",
            spec.id
        );
        assert!(
            def.steam.is_some() || def.epic.is_some() || def.xbox.is_some(),
            "{} is on no store, so auto-detection can never find it",
            spec.id
        );
    }
}

#[test]
fn target_tags_are_unique_within_a_game() {
    for spec in GAME_REGISTRY.iter() {
        let mut tags: Vec<&str> = spec.engine.targets.iter().map(|t| t.tag).collect();
        tags.sort_unstable();
        tags.dedup();
        assert_eq!(
            tags.len(),
            spec.engine.targets.len(),
            "{} has duplicate target tags, so target_for would never reach the second",
            spec.id
        );
    }
}

#[test]
fn target_for_routes_every_tag_back_to_its_own_target() {
    for spec in GAME_REGISTRY.iter() {
        let cfg = spec.engine;
        assert_eq!(
            cfg.target_for(None).tag,
            cfg.primary().tag,
            "{} untagged mods must route to the primary target",
            spec.id
        );
        for target in cfg.targets {
            assert_eq!(
                cfg.target_for(Some(target.tag)).tag,
                target.tag,
                "{} target {} is unreachable by its own tag",
                spec.id,
                target.tag
            );
        }
        assert_eq!(
            cfg.target_for(Some("no-such-target")).tag,
            cfg.primary().tag,
            "{} must fall back to primary for an unknown tag",
            spec.id
        );
    }
}

#[test]
fn disabled_suffix_matches_the_unit_kind() {
    for spec in GAME_REGISTRY.iter() {
        for target in spec.engine.targets {
            let suffix = target.disabled_suffix();
            if target.is_directory_unit() {
                assert!(
                    suffix.is_empty(),
                    "{}:{} is a Directory unit but carries a disabled suffix; disabling moves \
                     the folder, it never renames it",
                    spec.id,
                    target.tag
                );
                continue;
            }
            assert!(
                suffix.starts_with('.'),
                "{}:{} is a File unit whose disabled suffix does not change the extension, \
                 so the game would keep loading a disabled mod",
                spec.id,
                target.tag
            );
        }
    }
}

#[test]
fn disabled_dir_lives_under_its_own_mods_dir() {
    let game_path = "C:/game";
    for spec in GAME_REGISTRY.iter() {
        for target in spec.engine.targets {
            let mods = mods_dir(game_path, target);
            let disabled = disabled_dir(game_path, target);
            assert!(
                disabled.starts_with(&mods) && disabled != mods,
                "{}:{} disabled dir {:?} is not a subdirectory of {:?}",
                spec.id,
                target.tag,
                disabled,
                mods
            );
        }
    }
}

#[test]
fn backup_dir_lives_outside_its_own_mods_dir() {
    let game_path = "C:/game";
    for spec in GAME_REGISTRY.iter() {
        for target in spec.engine.targets {
            let mods = mods_dir(game_path, target);
            let backup = backup_dir(game_path, target);
            assert!(
                !backup.starts_with(&mods),
                "{}:{} backup dir {:?} sits inside {:?}; launch_without_mods moves the mods \
                 dir into the backup, so nesting it makes the move recursive",
                spec.id,
                target.tag,
                backup,
                mods
            );
        }
    }
}

#[test]
fn targets_never_share_a_mods_or_backup_dir() {
    let game_path = "C:/game";
    for spec in GAME_REGISTRY.iter() {
        let mut mods = HashSet::new();
        let mut backups = HashSet::new();
        for target in spec.engine.targets {
            assert!(
                mods.insert(mods_dir(game_path, target)),
                "{}:{} shares its mods dir with another target",
                spec.id,
                target.tag
            );
            assert!(
                backups.insert(backup_dir(game_path, target)),
                "{}:{} shares its backup dir with another target, so restoring one target \
                 would clobber the other",
                spec.id,
                target.tag
            );
        }
    }
}

#[test]
fn state_round_trips_for_every_game_and_target() {
    for spec in GAME_REGISTRY.iter() {
        let cfg = spec.engine;
        let tmp = TempDir::new().unwrap();
        let game_path = tmp.path().to_str().unwrap();
        let state_path = get_state_path(game_path, cfg);
        std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();

        let mods: Vec<InstalledMod> = cfg
            .targets
            .iter()
            .enumerate()
            .map(|(i, target)| InstalledMod {
                uid: format!("uid-{}", target.tag),
                id: i as i64 + 1,
                name: format!("Mod in {}", target.tag),
                version: "1.0".into(),
                filename: format!("mod{i}.pak"),
                enabled: true,
                // The primary target is written as None, not as its own tag, so state
                // files predating multi-target support keep resolving to it.
                location: (i > 0).then(|| target.tag.to_string()),
                ..Default::default()
            })
            .collect();

        save_state(
            &state_path,
            &ModsState {
                folders: vec![],
                mods: mods.clone(),
            },
        );
        let read = read_state(&state_path);

        assert_eq!(read.mods.len(), mods.len(), "{} mod count", spec.id);
        for (got, want) in read.mods.iter().zip(&mods) {
            assert_eq!(got.uid, want.uid, "{} uid", spec.id);
            assert_eq!(got.location, want.location, "{} location", spec.id);
            assert_eq!(
                cfg.target_for(got.location.as_deref()).tag,
                cfg.target_for(want.location.as_deref()).tag,
                "{} target routing after round trip",
                spec.id
            );
        }
    }
}
