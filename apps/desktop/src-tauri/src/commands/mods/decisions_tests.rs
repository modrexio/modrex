use super::decisions::*;
use super::engine::{engine_for_game, ModEngineConfig, ScanTarget, CRIMEBOSS_ENGINE, PDTH_ENGINE};
use std::path::PathBuf;

fn target<'a>(cfg: &'a ModEngineConfig, tag: &str) -> &'a ScanTarget {
    cfg.target_for(Some(tag))
}

fn staged_dir() -> PathBuf {
    PathBuf::from("/tmp/modrex-mod-abc/CoolMod")
}

fn raid_engine() -> &'static ModEngineConfig {
    engine_for_game("raid").unwrap()
}

fn pd3_engine() -> &'static ModEngineConfig {
    engine_for_game("pd3").unwrap()
}

fn pd2_engine() -> &'static ModEngineConfig {
    engine_for_game("pd2").unwrap()
}

#[test]
fn only_crime_boss_resyncs_enabled_flags() {
    assert!(resyncs_enabled_flags(&CRIMEBOSS_ENGINE));
    for cfg in [pd3_engine(), pd2_engine(), &PDTH_ENGINE, raid_engine()] {
        assert!(!resyncs_enabled_flags(cfg), "{} must not", cfg.game_id);
    }
}

#[test]
fn filename_from_mod_name_covers_every_game_and_unit() {
    let tmp = staged_dir();

    // File units name the mod after itself, whatever the game.
    assert_eq!(
        install_filename_from_mod_name(pd3_engine(), target(pd3_engine(), "paks"), "CoolMod", &tmp),
        "CoolMod.pak"
    );
    assert_eq!(
        install_filename_from_mod_name(
            &CRIMEBOSS_ENGINE,
            target(&CRIMEBOSS_ENGINE, "paks"),
            "CoolMod",
            &tmp
        ),
        "CoolMod.pak"
    );

    // Crime Boss directory units are named after the mod, not the staged directory.
    for tag in ["mods", "ue4ss_mods"] {
        assert_eq!(
            install_filename_from_mod_name(
                &CRIMEBOSS_ENGINE,
                target(&CRIMEBOSS_ENGINE, tag),
                "CoolMod",
                &tmp
            ),
            "CoolMod",
            "cb {tag}"
        );
    }

    // Every other directory game takes the staged directory's own name.
    for (cfg, tag) in [
        (pd2_engine(), "mods"),
        (pd2_engine(), "mod_overrides"),
        (&PDTH_ENGINE, "mods"),
        (&PDTH_ENGINE, "mod_overrides"),
        (raid_engine(), "mods"),
        (pd3_engine(), "ue4ss_mods"),
    ] {
        assert_eq!(
            install_filename_from_mod_name(cfg, target(cfg, tag), "CoolMod", &tmp),
            "CoolMod",
            "{} {tag}",
            cfg.game_id
        );
    }
}

/// The directory fallback reads the staged path, so a staged name that differs from the mod
/// name wins for every game except Crime Boss.
#[test]
fn directory_fallback_prefers_the_staged_directory_name() {
    let tmp = PathBuf::from("/tmp/modrex-mod-abc/OnDiskName");
    assert_eq!(
        install_filename_from_mod_name(
            raid_engine(),
            target(raid_engine(), "mods"),
            "CoolMod",
            &tmp
        ),
        "OnDiskName"
    );
    assert_eq!(
        install_filename_from_mod_name(
            &CRIMEBOSS_ENGINE,
            target(&CRIMEBOSS_ENGINE, "mods"),
            "CoolMod",
            &tmp
        ),
        "CoolMod"
    );
}

#[test]
fn source_file_filename_separates_extras_from_the_main_download() {
    let tmp = staged_dir();
    let paks = target(pd3_engine(), "paks");
    assert_eq!(
        install_filename_for_source_file(pd3_engine(), paks, "CoolMod", 42, "main", &tmp),
        "CoolMod.pak"
    );
    assert_eq!(
        install_filename_for_source_file(pd3_engine(), paks, "CoolMod", 42, "optional", &tmp),
        "CoolMod_42.pak"
    );

    // The file id only reaches file units; directory units ignore it entirely.
    assert_eq!(
        install_filename_for_source_file(
            raid_engine(),
            target(raid_engine(), "mods"),
            "CoolMod",
            42,
            "optional",
            &tmp
        ),
        "CoolMod"
    );
    assert_eq!(
        install_filename_for_source_file(
            &CRIMEBOSS_ENGINE,
            target(&CRIMEBOSS_ENGINE, "mods"),
            "CoolMod",
            42,
            "optional",
            &tmp
        ),
        "CoolMod"
    );
}

/// The only difference from install_filename_from_mod_name: the directory fallback is the
/// recovered stem rather than the staged directory's name.
#[test]
fn dropped_filename_uses_the_recovered_stem_for_directories() {
    assert_eq!(
        install_filename_for_dropped(pd3_engine(), target(pd3_engine(), "paks"), "CoolMod"),
        "CoolMod.pak"
    );
    assert_eq!(
        install_filename_for_dropped(raid_engine(), target(raid_engine(), "mods"), "CoolMod"),
        "CoolMod"
    );
    assert_eq!(
        install_filename_for_dropped(
            &CRIMEBOSS_ENGINE,
            target(&CRIMEBOSS_ENGINE, "mods"),
            "CoolMod"
        ),
        "CoolMod"
    );
    assert_eq!(
        install_filename_for_dropped(
            &CRIMEBOSS_ENGINE,
            target(&CRIMEBOSS_ENGINE, "paks"),
            "CoolMod"
        ),
        "CoolMod.pak"
    );
}

#[test]
fn zip_entry_filename_keeps_the_entry_name_off_crime_boss() {
    for cfg in [pd3_engine(), pd2_engine(), &PDTH_ENGINE, raid_engine()] {
        assert_eq!(
            install_filename_for_zip_entry(cfg, "CoolMod", "Inner Entry.pak"),
            "Inner Entry.pak",
            "{}",
            cfg.game_id
        );
    }
    assert_eq!(
        install_filename_for_zip_entry(&CRIMEBOSS_ENGINE, "CoolMod", "Inner Entry.pak"),
        "CoolMod"
    );
}

#[test]
fn cb_dir_entry_needs_both_crime_boss_and_a_dir_entry_kind() {
    assert!(is_cb_dir_entry(&CRIMEBOSS_ENGINE, Some("dir")));
    assert!(!is_cb_dir_entry(&CRIMEBOSS_ENGINE, Some("pak")));
    assert!(!is_cb_dir_entry(&CRIMEBOSS_ENGINE, None));
    assert!(!is_cb_dir_entry(pd3_engine(), Some("dir")));
    assert!(!is_cb_dir_entry(raid_engine(), Some("dir")));
}

#[test]
fn entry_staging_wraps_only_crime_boss_pak_entries() {
    assert_eq!(
        entry_staging(&CRIMEBOSS_ENGINE, target(&CRIMEBOSS_ENGINE, "paks"), false),
        EntryStaging::CrimeBossSkeleton
    );

    // A Crime Boss entry classified as a directory is staged like every other directory.
    assert_eq!(
        entry_staging(&CRIMEBOSS_ENGINE, target(&CRIMEBOSS_ENGINE, "paks"), true),
        EntryStaging::DirectoryUnderNewParent
    );
    assert_eq!(
        entry_staging(
            &CRIMEBOSS_ENGINE,
            target(&CRIMEBOSS_ENGINE, "ue4ss_mods"),
            true
        ),
        EntryStaging::DirectoryUnderNewParent
    );

    assert_eq!(
        entry_staging(pd3_engine(), target(pd3_engine(), "paks"), false),
        EntryStaging::SingleTempFile
    );
    for (cfg, tag) in [
        (pd3_engine(), "ue4ss_mods"),
        (pd2_engine(), "mods"),
        (&PDTH_ENGINE, "mods"),
        (raid_engine(), "mods"),
    ] {
        assert_eq!(
            entry_staging(cfg, target(cfg, tag), false),
            EntryStaging::DirectoryUnderNewParent,
            "{} {tag}",
            cfg.game_id
        );
    }
}

/// Crime Boss pak entries are already on disk once staging built the skeleton, so the
/// extraction step is skipped for them and only for them.
#[test]
fn entry_extraction_skips_only_the_already_staged_crime_boss_entry() {
    assert_eq!(
        entry_extraction(&CRIMEBOSS_ENGINE, target(&CRIMEBOSS_ENGINE, "paks"), false),
        EntryExtraction::AlreadyStaged
    );
    assert_eq!(
        entry_extraction(&CRIMEBOSS_ENGINE, target(&CRIMEBOSS_ENGINE, "mods"), false),
        EntryExtraction::AlreadyStaged
    );
    assert_eq!(
        entry_extraction(&CRIMEBOSS_ENGINE, target(&CRIMEBOSS_ENGINE, "paks"), true),
        EntryExtraction::DirEntry
    );

    assert_eq!(
        entry_extraction(pd3_engine(), target(pd3_engine(), "paks"), false),
        EntryExtraction::EntryWithSidecars
    );
    for (cfg, tag) in [
        (pd3_engine(), "ue4ss_mods"),
        (pd2_engine(), "mods"),
        (&PDTH_ENGINE, "mod_overrides"),
        (raid_engine(), "mods"),
    ] {
        assert_eq!(
            entry_extraction(cfg, target(cfg, tag), false),
            EntryExtraction::DirEntry,
            "{} {tag}",
            cfg.game_id
        );
    }
}

/// Every decision that reads the game id, gathered so the Crime Boss difference is visible
/// in one place. A file unit behaves identically on both, which is why only the directory
/// rows differ.
#[test]
fn crime_boss_differs_from_other_games_only_where_production_differs() {
    // The staged directory is deliberately not named after the mod: the two branches produce
    // the same string when it is, so only a differing name exposes the divergence.
    let tmp = PathBuf::from("/tmp/modrex-mod-abc/OnDiskName");
    let cb_dir = target(&CRIMEBOSS_ENGINE, "mods");
    let raid_dir = target(raid_engine(), "mods");
    let cb_file = target(&CRIMEBOSS_ENGINE, "paks");
    let pd3_file = target(pd3_engine(), "paks");

    assert_ne!(
        install_filename_from_mod_name(&CRIMEBOSS_ENGINE, cb_dir, "CoolMod", &tmp),
        install_filename_from_mod_name(raid_engine(), raid_dir, "CoolMod", &tmp)
    );
    assert_ne!(
        entry_staging(&CRIMEBOSS_ENGINE, cb_file, false),
        entry_staging(pd3_engine(), pd3_file, false)
    );
    assert_ne!(
        entry_extraction(&CRIMEBOSS_ENGINE, cb_file, false),
        entry_extraction(pd3_engine(), pd3_file, false)
    );

    // File units agree across games for naming.
    assert_eq!(
        install_filename_from_mod_name(&CRIMEBOSS_ENGINE, cb_file, "CoolMod", &tmp),
        install_filename_from_mod_name(pd3_engine(), pd3_file, "CoolMod", &tmp)
    );
}

/// Names reach the filename decisions already sanitized by naming, which the extraction
/// left in place.
#[test]
fn filename_decisions_sanitize_through_naming() {
    let tmp = staged_dir();
    assert_eq!(
        install_filename_from_mod_name(
            pd3_engine(),
            target(pd3_engine(), "paks"),
            "Cool Mod",
            &tmp
        ),
        "Cool_Mod.pak"
    );
    assert_eq!(
        install_filename_for_dropped(
            &CRIMEBOSS_ENGINE,
            target(&CRIMEBOSS_ENGINE, "mods"),
            "Cool Mod"
        ),
        "Cool_Mod"
    );
}
