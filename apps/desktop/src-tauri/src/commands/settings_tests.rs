use super::*;
use std::collections::HashMap;
use std::io::Write;
use tempfile::NamedTempFile;

fn write_to(path: &std::path::Path, settings: &Settings) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, serde_json::to_string_pretty(settings).unwrap()).unwrap();
}

fn read_from(path: &std::path::Path) -> Settings {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    serde_json::from_str(&content).unwrap_or_default()
}

#[test]
fn roundtrip_all_fields_set() {
    let f = NamedTempFile::new().unwrap();
    let mut games = HashMap::new();
    games.insert(
        "pd3".to_string(),
        GameSettings {
            game_path: Some("C:\\Games\\PAYDAY3".to_string()),
            launcher: Some("steam".to_string()),
            launch_options: "-fileopenlog".to_string(),
            suppress_crash_reporter: true,
            ..Default::default()
        },
    );
    games.insert(
        "cb".to_string(),
        GameSettings {
            crimeboss_install_mode: "ask".to_string(),
            ..Default::default()
        },
    );
    let original = Settings {
        games: Some(games),
        skip_file_open_log_warning: true,
        dismissed_deps_warnings: vec![1, 2, 3],
        ..Default::default()
    };
    write_to(f.path(), &original);
    let loaded = read_from(f.path());
    let pd3 = loaded.games.as_ref().unwrap().get("pd3").unwrap();
    assert_eq!(pd3.game_path.as_deref(), Some("C:\\Games\\PAYDAY3"));
    assert_eq!(pd3.launcher.as_deref(), Some("steam"));
    assert_eq!(pd3.launch_options, "-fileopenlog");
    assert!(pd3.suppress_crash_reporter);
    let cb = loaded.games.as_ref().unwrap().get("cb").unwrap();
    assert_eq!(cb.crimeboss_install_mode, "ask");
    assert!(loaded.skip_file_open_log_warning);
    assert_eq!(loaded.dismissed_deps_warnings, vec![1, 2, 3]);
}

#[test]
fn roundtrip_defaults_when_absent() {
    let f = NamedTempFile::new().unwrap();
    let original = Settings::default();
    write_to(f.path(), &original);
    let loaded = read_from(f.path());
    // Truly optional (no default value makes sense): stay None.
    assert_eq!(loaded.game_path, None);
    assert_eq!(loaded.launcher, None);
    assert_eq!(loaded.launch_options, None);
    assert_eq!(loaded.analytics_id, None);
    // Everything else has a real default and must never be null on disk.
    assert!(!loaded.skip_file_open_log_warning);
    assert!(loaded.dismissed_deps_warnings.is_empty());
    assert!(!loaded.analytics_consent_asked);
    assert!(!loaded.analytics_enabled);
    assert!(loaded.discord_rich_presence_enabled);
    assert!(!loaded.auto_launch_sisr);
}

#[test]
fn auto_launch_sisr_roundtrips_and_treats_null_as_disabled() {
    let f = NamedTempFile::new().unwrap();
    let original = Settings {
        auto_launch_sisr: true,
        ..Default::default()
    };
    write_to(f.path(), &original);
    assert!(read_from(f.path()).auto_launch_sisr);

    let settings: Settings = serde_json::from_str(r#"{"autoLaunchSisr":null}"#).unwrap();
    assert!(!settings.auto_launch_sisr);
}

#[test]
fn roundtrip_analytics_fields() {
    let f = NamedTempFile::new().unwrap();
    let original = Settings {
        analytics_consent_asked: true,
        analytics_enabled: true,
        analytics_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
        ..Default::default()
    };
    write_to(f.path(), &original);
    let loaded = read_from(f.path());
    assert!(loaded.analytics_consent_asked);
    assert!(loaded.analytics_enabled);
    assert_eq!(
        loaded.analytics_id.as_deref(),
        Some("11111111-2222-3333-4444-555555555555")
    );
}

#[test]
fn analytics_consent_defaults_to_not_asked() {
    // An old settings file with no analytics keys must read back as "not yet asked",
    // not as an implicit opt-in or opt-out. asked and enabled are two plain bools
    // specifically so this state needs no nullable field to represent it.
    let mut f = NamedTempFile::new().unwrap();
    write!(f, r#"{{"gamePath":"C:\\Games"}}"#).unwrap();
    let loaded = read_from(f.path());
    assert!(!loaded.analytics_consent_asked);
    assert!(!loaded.analytics_enabled);
    assert_eq!(loaded.analytics_id, None);
}

#[test]
fn missing_file_returns_default() {
    let loaded = read_from(std::path::Path::new("/nonexistent/settings.json"));
    assert_eq!(loaded.game_path, None);
    assert_eq!(loaded.launcher, None);
}

#[test]
fn corrupt_json_returns_default() {
    let mut f = NamedTempFile::new().unwrap();
    write!(f, "{{not valid json}}").unwrap();
    let loaded = read_from(f.path());
    assert_eq!(loaded.game_path, None);
}

#[test]
fn unknown_fields_ignored() {
    let mut f = NamedTempFile::new().unwrap();
    write!(f, r#"{{"gamePath":"C:\\Games","unknownField":true}}"#).unwrap();
    let loaded = read_from(f.path());
    // Legacy flat field is still deserializable from old JSON
    assert_eq!(loaded.game_path, Some("C:\\Games".to_string()));
}

#[test]
fn legacy_nexus_api_key_is_not_serialized() {
    let settings: Settings = serde_json::from_str(r#"{"nexusApiKey":"secret"}"#).unwrap();
    let serialized = serde_json::to_string(&settings).unwrap();
    assert!(!serialized.contains("nexusApiKey"));
    assert!(!serialized.contains("secret"));
}

#[test]
fn migration_from_legacy_flat_fields() {
    let mut f = NamedTempFile::new().unwrap();
    write!(
        f,
        r#"{{"gamePath":"C:\\Games\\PAYDAY3","launcher":"steam","skipFileOpenLogWarning":true}}"#
    )
    .unwrap();
    let content = std::fs::read_to_string(f.path()).unwrap();
    let raw: Settings = serde_json::from_str(&content).unwrap();
    let migrated = migrate_settings(raw);
    let pd3 = migrated.games.as_ref().unwrap().get("pd3").unwrap();
    assert_eq!(pd3.game_path.as_deref(), Some("C:\\Games\\PAYDAY3"));
    assert_eq!(pd3.launcher.as_deref(), Some("steam"));
    assert!(migrated.skip_file_open_log_warning);
}

#[test]
fn migration_skipped_when_games_already_present() {
    let mut games = HashMap::new();
    games.insert(
        "pd3".to_string(),
        GameSettings {
            game_path: Some("new_path".to_string()),
            ..Default::default()
        },
    );
    let s = Settings {
        games: Some(games),
        game_path: Some("old_path".to_string()),
        ..Default::default()
    };
    let migrated = migrate_settings(s);
    // Existing games map must not be overwritten by legacy flat field
    assert_eq!(
        migrated
            .games
            .as_ref()
            .unwrap()
            .get("pd3")
            .unwrap()
            .game_path
            .as_deref(),
        Some("new_path")
    );
}

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[test]
fn support_prompt_eligible_requires_both_installs_and_age() {
    let first = 1_000_000;
    // Enough installs but too young
    assert!(!support_prompt_eligible(10, first, first + 6 * DAY_MS));
    // Old enough but too few installs
    assert!(!support_prompt_eligible(9, first, first + 8 * DAY_MS));
    // Both thresholds met
    assert!(support_prompt_eligible(10, first, first + 7 * DAY_MS));
    assert!(support_prompt_eligible(25, first, first + 300 * DAY_MS));
}

#[test]
fn support_prompt_eligible_tolerates_clock_moved_backwards() {
    // now < first_install_at (clock skew / manual clock change) must not panic
    // or become eligible via underflow.
    assert!(!support_prompt_eligible(10, 5_000_000, 1_000_000));
}

// A real pre-upgrade settings.json, where every field that is non-Option today is
// present with an explicit null rather than absent. serde(default) alone does not cover
// that, firing only for an absent key, so without null_default (settings.rs) this file
// fails to parse and read_settings falls back to Settings::default(), silently wiping
// every game path, launcher, and preference on the user's next launch.
const PRE_UPGRADE_SETTINGS_JSON: &str = r#"{
  "games": {
    "pd3": {
      "gamePath": "G:/SteamLibrary/steamapps/common/PAYDAY3",
      "launcher": "steam",
      "launchOptions": null,
      "suppressCrashReporter": null,
      "crimebossInstallMode": null
    }
  },
  "skipFileOpenLogWarning": null,
  "dismissedDepsWarnings": null,
  "analyticsEnabled": true,
  "analyticsId": "4ccecb9b-11a9-4784-a0a7-bb1e7bcc91f6",
  "discordRichPresenceEnabled": null,
  "nexusOauth": null,
  "successfulInstalls": null,
  "firstInstallAt": null,
  "supportPromptShown": null
}"#;

#[test]
fn pre_upgrade_settings_with_explicit_nulls_still_parses() {
    let s: Settings =
        serde_json::from_str(PRE_UPGRADE_SETTINGS_JSON).expect("must parse despite explicit nulls");
    let pd3 = s.games.as_ref().unwrap().get("pd3").unwrap();
    assert_eq!(
        pd3.game_path.as_deref(),
        Some("G:/SteamLibrary/steamapps/common/PAYDAY3")
    );
    assert_eq!(pd3.launch_options, "");
    assert!(!pd3.suppress_crash_reporter);
    assert_eq!(pd3.crimeboss_install_mode, "auto");
    assert!(!s.skip_file_open_log_warning);
    assert!(s.dismissed_deps_warnings.is_empty());
    assert!(s.discord_rich_presence_enabled);
    assert_eq!(s.successful_installs, 0);
    assert_eq!(s.first_install_at, 0);
    assert!(!s.support_prompt_shown);
    assert!(s.analytics_enabled);
}

// Every settings file written before copies were tracked lacks this field, and reading it
// back as false is the whole of the repair: it is what makes an existing install re-choose
// its copy once, against the mod list on disk, instead of staying wherever it was pointed.
#[test]
fn settings_written_before_copies_were_tracked_arrive_unpinned() {
    let s: Settings = serde_json::from_str(PRE_UPGRADE_SETTINGS_JSON).unwrap();
    assert!(!s.games.as_ref().unwrap().get("pd3").unwrap().install_pinned);

    // An explicit null must read the same way, since that is what the older writer emitted
    // for absent per-game values.
    let nulled: GameSettings =
        serde_json::from_str(r#"{"gamePath":null,"launcher":null,"installPinned":null}"#)
            .expect("must parse despite an explicit null");
    assert!(!nulled.install_pinned);
}

#[test]
fn recover_legacy_analytics_consent_from_explicit_bool() {
    let mut s: Settings = serde_json::from_str(PRE_UPGRADE_SETTINGS_JSON).unwrap();
    assert!(!s.analytics_consent_asked); // absent in the old file, defaults false
    recover_legacy_analytics_consent(&mut s, PRE_UPGRADE_SETTINGS_JSON);
    // The old file's analyticsEnabled: true proves the user was already asked, so the
    // first-run consent dialog must not be shown to them again.
    assert!(s.analytics_consent_asked);
}

#[test]
fn recover_legacy_analytics_consent_ignores_never_asked_null() {
    let json = r#"{"analyticsEnabled": null}"#;
    let mut s: Settings = serde_json::from_str(json).unwrap();
    recover_legacy_analytics_consent(&mut s, json);
    assert!(!s.analytics_consent_asked);
}

#[test]
fn recover_legacy_analytics_consent_noop_when_key_absent() {
    let json = r#"{}"#;
    let mut s: Settings = serde_json::from_str(json).unwrap();
    recover_legacy_analytics_consent(&mut s, json);
    assert!(!s.analytics_consent_asked);
}
