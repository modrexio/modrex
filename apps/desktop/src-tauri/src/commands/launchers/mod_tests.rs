use super::steam::steam_libraries;
use super::*;
use tempfile::TempDir;

fn pd3() -> &'static crate::commands::launchers::GameDef {
    crate::commands::games::game_spec("pd3").unwrap().def
}

fn pd2() -> &'static crate::commands::launchers::GameDef {
    crate::commands::games::game_spec("pd2").unwrap().def
}

fn pd3_engine() -> &'static crate::commands::mods::ModEngineConfig {
    crate::commands::mods::engine_for_game("pd3").unwrap()
}

// ── steam_libraries ───────────────────────────────────────────────────────

fn write_vdf(dir: &TempDir, content: &str) -> String {
    let steam_path = dir.path().to_str().unwrap().to_string();
    let steamapps = dir.path().join("steamapps");
    std::fs::create_dir_all(&steamapps).unwrap();
    std::fs::write(steamapps.join("libraryfolders.vdf"), content).unwrap();
    steam_path
}

#[test]
fn steam_libraries_empty_content() {
    let dir = TempDir::new().unwrap();
    let steam_path = write_vdf(&dir, "");
    let libs = steam_libraries(&steam_path);
    assert_eq!(libs, vec![steam_path]);
}

#[test]
fn steam_libraries_one_extra_path() {
    let dir = TempDir::new().unwrap();
    let steam_path = write_vdf(
        &dir,
        r#""libraryfolders"
{
    "0"
    {
        "path"    "D:\\SteamLibrary"
    }
}"#,
    );
    let libs = steam_libraries(&steam_path);
    assert_eq!(libs.len(), 2);
    assert!(libs.contains(&steam_path));
    assert!(libs.contains(&"D:\\SteamLibrary".to_string()));
}

#[test]
fn steam_libraries_multiple_paths() {
    let dir = TempDir::new().unwrap();
    let steam_path = write_vdf(
        &dir,
        r#""libraryfolders"
{
    "0"
    {
        "path"    "D:\\SteamLibrary"
    }
    "1"
    {
        "path"    "E:\\Games"
    }
}"#,
    );
    let libs = steam_libraries(&steam_path);
    assert_eq!(libs.len(), 3);
    assert!(libs.contains(&"D:\\SteamLibrary".to_string()));
    assert!(libs.contains(&"E:\\Games".to_string()));
}

#[test]
fn steam_libraries_escaped_backslashes_unescaped() {
    let dir = TempDir::new().unwrap();
    // Real Steam VDF uses \\ for a single backslash in the path
    let steam_path = write_vdf(
        &dir,
        r#""libraryfolders"
{
    "0"
    {
        "path"    "D:\\SteamLibrary"
    }
}"#,
    );
    let libs = steam_libraries(&steam_path);
    assert!(libs.contains(&"D:\\SteamLibrary".to_string()));
}

#[test]
fn steam_libraries_no_path_key() {
    let dir = TempDir::new().unwrap();
    let steam_path = write_vdf(&dir, r#""libraryfolders" { "label" "value" }"#);
    let libs = steam_libraries(&steam_path);
    assert_eq!(libs, vec![steam_path]);
}

// ── is_installation ───────────────────────────────────────────────────────

fn touch(path: std::path::PathBuf) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "").unwrap();
}

#[test]
fn is_installation_accepts_win64_layout() {
    let dir = TempDir::new().unwrap();
    touch(dir.path().join("PAYDAY3.exe"));
    assert!(pd3().is_installation(dir.path().to_str().unwrap()));
}

// A Microsoft Store copy stages only the WinGDK binary, so the launch executable is
// absent and validating against it alone rejected a real installation.
#[test]
fn is_installation_accepts_microsoft_store_layout() {
    let dir = TempDir::new().unwrap();
    touch(
        dir.path()
            .join("PAYDAY3")
            .join("Binaries")
            .join("WinGDK")
            .join("PAYDAY3-WinGDK-Shipping.exe"),
    );
    let path = dir.path().to_str().unwrap();
    assert!(pd3().resolve_executable(path).is_none());
    assert!(pd3().is_installation(path));
}

#[test]
fn is_installation_rejects_unrelated_folder() {
    let dir = TempDir::new().unwrap();
    touch(dir.path().join("readme.txt"));
    assert!(!pd3().is_installation(dir.path().to_str().unwrap()));
}

// PAYDAY 2 has no Microsoft Store release, so nothing widens its check.
#[test]
fn is_installation_without_xbox_release_matches_executables_only() {
    let dir = TempDir::new().unwrap();
    touch(dir.path().join("payday2_win32_release.exe"));
    assert!(pd2().is_installation(dir.path().to_str().unwrap()));

    let other = TempDir::new().unwrap();
    touch(other.path().join("PAYDAY3.exe"));
    assert!(!pd2().is_installation(other.path().to_str().unwrap()));
}

// ── dir_as_named_on_disk ──────────────────────────────────────────────────

// A Microsoft Store folder spelled differently from the game name in the registry is
// still found, and the path handed back has to read as the folder the user sees.
#[test]
fn dir_as_named_on_disk_reports_the_spelling_on_disk() {
    let dir = TempDir::new().unwrap();
    std::fs::create_dir(dir.path().join("Payday 3")).unwrap();
    assert_eq!(
        super::xbox::dir_as_named_on_disk(dir.path(), "PAYDAY 3"),
        dir.path().join("Payday 3")
    );
}

#[test]
fn dir_as_named_on_disk_falls_back_to_the_searched_name() {
    let dir = TempDir::new().unwrap();
    assert_eq!(
        super::xbox::dir_as_named_on_disk(dir.path(), "PAYDAY 3"),
        dir.path().join("PAYDAY 3")
    );
}

// ── xbox discovery ────────────────────────────────────────────────────────

use super::xbox::{find_game_in, find_via_package_manager, PackageCache, XboxEnvironment};
use std::cell::Cell;
use std::path::PathBuf;
use std::time::Duration;

struct FakeXboxEnv {
    roots: Vec<PathBuf>,
    package: Option<PathBuf>,
    root_calls: Cell<usize>,
    package_calls: Cell<usize>,
}

impl FakeXboxEnv {
    fn new(roots: Vec<PathBuf>) -> Self {
        Self {
            roots,
            package: None,
            root_calls: Cell::new(0),
            package_calls: Cell::new(0),
        }
    }

    fn with_package(mut self, content: PathBuf) -> Self {
        self.package = Some(content);
        self
    }
}

impl XboxEnvironment for FakeXboxEnv {
    fn fixed_drive_roots(&self) -> Vec<PathBuf> {
        self.root_calls.set(self.root_calls.get() + 1);
        self.roots.clone()
    }

    fn package_content_path(&self, product_id: &str) -> Option<PathBuf> {
        self.package_calls.set(self.package_calls.get() + 1);
        if product_id != pd3().xbox.as_ref().unwrap().product_id {
            return None;
        }
        self.package.clone()
    }
}

fn xbox_exe() -> &'static str {
    pd3().xbox.as_ref().unwrap().executable
}

fn xbox_copy(root: &Path, top: &str, game_dir: &str) -> PathBuf {
    let content = root.join(top).join(game_dir).join("Content");
    touch(content.join(xbox_exe()));
    content
}

fn found(content: &Path) -> Option<String> {
    Some(content.to_string_lossy().into_owned())
}

#[test]
fn finds_install_in_the_standard_top_level_dir() {
    let dir = TempDir::new().unwrap();
    let content = xbox_copy(dir.path(), "XboxGames", pd3().name);
    let env = FakeXboxEnv::new(vec![dir.path().to_path_buf()]);
    assert_eq!(find_game_in(&env, pd3()), found(&content));
}

#[test]
fn finds_install_in_a_nonstandard_top_level_dir() {
    let dir = TempDir::new().unwrap();
    let content = xbox_copy(dir.path(), "Games", pd3().name);
    let env = FakeXboxEnv::new(vec![dir.path().to_path_buf()]);
    assert_eq!(find_game_in(&env, pd3()), found(&content));
}

#[test]
fn finds_install_on_a_later_root() {
    let first = TempDir::new().unwrap();
    let second = TempDir::new().unwrap();
    std::fs::create_dir(first.path().join("Windows")).unwrap();
    let content = xbox_copy(second.path(), "XboxGames", pd3().name);
    let env = FakeXboxEnv::new(vec![
        first.path().to_path_buf(),
        second.path().to_path_buf(),
    ]);
    assert_eq!(find_game_in(&env, pd3()), found(&content));
}

#[test]
fn unreadable_root_is_skipped_and_the_rest_are_searched() {
    let dir = TempDir::new().unwrap();
    let content = xbox_copy(dir.path(), "XboxGames", pd3().name);
    let env = FakeXboxEnv::new(vec![
        dir.path().join("no-such-root"),
        dir.path().to_path_buf(),
    ]);
    assert_eq!(find_game_in(&env, pd3()), found(&content));
}

#[test]
fn a_root_outside_the_reported_set_is_never_searched() {
    let listed = TempDir::new().unwrap();
    let unlisted = TempDir::new().unwrap();
    xbox_copy(unlisted.path(), "XboxGames", pd3().name);
    let env = FakeXboxEnv::new(vec![listed.path().to_path_buf()]);
    assert_eq!(find_game_in(&env, pd3()), None);
}

#[test]
fn a_top_level_file_is_not_treated_as_a_directory() {
    let dir = TempDir::new().unwrap();
    touch(dir.path().join("XboxGames"));
    let env = FakeXboxEnv::new(vec![dir.path().to_path_buf()]);
    assert_eq!(find_game_in(&env, pd3()), None);
}

#[test]
fn a_deep_install_is_found_via_the_package_manager() {
    let dir = TempDir::new().unwrap();
    let content = dir
        .path()
        .join("Deep")
        .join("Nested")
        .join(pd3().name)
        .join("Content");
    touch(content.join(xbox_exe()));
    let env = FakeXboxEnv::new(vec![dir.path().to_path_buf()]).with_package(content.clone());
    assert_eq!(find_game_in(&env, pd3()), found(&content));
}

#[test]
fn a_drive_hit_stops_before_the_package_manager() {
    let dir = TempDir::new().unwrap();
    let content = xbox_copy(dir.path(), "XboxGames", pd3().name);
    let elsewhere = xbox_copy(dir.path(), "Other", "Something Else");
    let env = FakeXboxEnv::new(vec![dir.path().to_path_buf()]).with_package(elsewhere);
    assert_eq!(find_game_in(&env, pd3()), found(&content));
    assert_eq!(env.package_calls.get(), 0);
}

#[test]
fn a_package_for_another_product_id_is_not_matched() {
    let dir = TempDir::new().unwrap();
    let content = dir.path().join("Deep").join(pd3().name).join("Content");
    touch(content.join(xbox_exe()));
    let env = FakeXboxEnv::new(vec![]).with_package(content);
    assert_eq!(find_via_package_manager(&env, "NOTPD3", xbox_exe()), None);
}

#[test]
fn a_package_without_the_executable_is_rejected() {
    let dir = TempDir::new().unwrap();
    let content = dir.path().join("Deep").join(pd3().name).join("Content");
    std::fs::create_dir_all(&content).unwrap();
    let env = FakeXboxEnv::new(vec![]).with_package(content);
    assert_eq!(find_game_in(&env, pd3()), None);
}

#[test]
fn a_package_pointing_at_a_gone_location_is_rejected() {
    let dir = TempDir::new().unwrap();
    let env = FakeXboxEnv::new(vec![]).with_package(dir.path().join("gone").join("Content"));
    assert_eq!(find_game_in(&env, pd3()), None);
}

#[test]
fn a_package_query_that_answers_nothing_yields_none() {
    let dir = TempDir::new().unwrap();
    let env = FakeXboxEnv::new(vec![dir.path().to_path_buf()]);
    assert_eq!(find_game_in(&env, pd3()), None);
}

#[test]
fn a_game_without_a_store_build_asks_the_machine_nothing() {
    let dir = TempDir::new().unwrap();
    let env = FakeXboxEnv::new(vec![dir.path().to_path_buf()]);
    assert_eq!(find_game_in(&env, pd2()), None);
    assert_eq!(env.root_calls.get(), 0);
    assert_eq!(env.package_calls.get(), 0);
}

#[test]
fn each_call_requeries_the_environment() {
    let dir = TempDir::new().unwrap();
    let env = FakeXboxEnv::new(vec![dir.path().to_path_buf()]);
    for _ in 0..3 {
        assert_eq!(find_game_in(&env, pd3()), None);
    }
    assert_eq!(env.root_calls.get(), 3);
    assert_eq!(env.package_calls.get(), 3);
}

// ── package cache ─────────────────────────────────────────────────────────

#[test]
fn probes_landing_together_query_the_package_manager_once() {
    let dir = TempDir::new().unwrap();
    // Two levels down, so the drive scan misses and the package manager is reached.
    let content = dir
        .path()
        .join("Deep")
        .join("Nested")
        .join(pd3().name)
        .join("Content");
    touch(content.join(xbox_exe()));
    let env = PackageCache::new(
        FakeXboxEnv::new(vec![dir.path().to_path_buf()]).with_package(content.clone()),
        Duration::MAX,
    );
    for _ in 0..3 {
        assert_eq!(find_game_in(&env, pd3()), found(&content));
    }
    assert_eq!(env.inner.package_calls.get(), 1);
}

#[test]
fn a_held_path_is_still_checked_on_disk() {
    let dir = TempDir::new().unwrap();
    let content = dir
        .path()
        .join("Deep")
        .join("Nested")
        .join(pd3().name)
        .join("Content");
    let exe = content.join(xbox_exe());
    touch(exe.clone());
    let env = PackageCache::new(
        FakeXboxEnv::new(vec![dir.path().to_path_buf()]).with_package(content.clone()),
        Duration::MAX,
    );
    assert_eq!(find_game_in(&env, pd3()), found(&content));

    std::fs::remove_file(&exe).unwrap();
    assert_eq!(find_game_in(&env, pd3()), None);
    assert_eq!(env.inner.package_calls.get(), 1);
}

#[test]
fn a_negative_answer_is_held_as_well() {
    let dir = TempDir::new().unwrap();
    let env = PackageCache::new(
        FakeXboxEnv::new(vec![dir.path().to_path_buf()]),
        Duration::MAX,
    );
    for _ in 0..3 {
        assert_eq!(find_game_in(&env, pd3()), None);
    }
    assert_eq!(env.inner.package_calls.get(), 1);
}

#[test]
fn an_expired_answer_is_asked_again() {
    let dir = TempDir::new().unwrap();
    let env = PackageCache::new(
        FakeXboxEnv::new(vec![dir.path().to_path_buf()]),
        Duration::ZERO,
    );
    for _ in 0..3 {
        assert_eq!(find_game_in(&env, pd3()), None);
    }
    assert_eq!(env.inner.package_calls.get(), 3);
}

#[test]
fn each_product_id_is_held_separately() {
    let env = PackageCache::new(FakeXboxEnv::new(vec![]), Duration::MAX);
    assert_eq!(find_via_package_manager(&env, "ONE", xbox_exe()), None);
    assert_eq!(find_via_package_manager(&env, "TWO", xbox_exe()), None);
    assert_eq!(env.inner.package_calls.get(), 2);
}

#[test]
fn drive_roots_are_asked_for_every_time() {
    let dir = TempDir::new().unwrap();
    let env = PackageCache::new(
        FakeXboxEnv::new(vec![dir.path().to_path_buf()]),
        Duration::MAX,
    );
    for _ in 0..3 {
        assert_eq!(find_game_in(&env, pd3()), None);
    }
    assert_eq!(env.inner.root_calls.get(), 3);
}

// The drive scan reaches dir_as_named_on_disk only on a case-insensitive filesystem.
#[cfg(target_os = "windows")]
#[test]
fn a_differently_cased_folder_is_returned_as_it_is_spelled() {
    let dir = TempDir::new().unwrap();
    let content = xbox_copy(dir.path(), "XboxGames", "Payday 3");
    let env = FakeXboxEnv::new(vec![dir.path().to_path_buf()]);
    assert_eq!(find_game_in(&env, pd3()), found(&content));
}

// The package query is left out because it spawns PowerShell for up to 15 seconds.
#[cfg(target_os = "windows")]
#[test]
fn the_real_environment_reports_the_system_drive() {
    let roots = super::xbox::WindowsEnvironment.fixed_drive_roots();
    assert!(roots.contains(&PathBuf::from("C:\\")), "got {roots:?}");
}

#[cfg(not(target_os = "windows"))]
#[test]
fn the_launcher_finds_nothing_off_windows() {
    use super::types::Launcher;
    assert_eq!(super::xbox::Xbox.find_game(pd3()), None);
    assert!(!super::xbox::Xbox.is_installed());
}

// ── resolve_install ───────────────────────────────────────────────────────

// A copy of PAYDAY 3 laid out the way one store installs it, tracking the given number of
// mods. Zero still writes a mod list: that is what a copy the app was pointed at once, and
// found nothing in, actually looks like on disk.
fn make_pd3_copy(root: &Path, mod_count: usize) -> String {
    use crate::commands::mods::{save_state, InstalledMod, ModsState};
    touch(root.join("PAYDAY3.exe"));
    let game_path = root.to_string_lossy().into_owned();
    let mods = (0..mod_count)
        .map(|i| InstalledMod {
            uid: i.to_string(),
            filename: format!("{i}.pak"),
            ..InstalledMod::default()
        })
        .collect();
    save_state(
        &get_state_path(&game_path, pd3_engine()),
        &ModsState {
            mods,
            folders: vec![],
        },
    );
    game_path
}

// A copy with no mod list at all, which is what an untouched second install looks like.
fn make_bare_pd3_copy(root: &Path) -> String {
    touch(root.join("PAYDAY3.exe"));
    root.to_string_lossy().into_owned()
}

fn install(launcher: &str, game_path: &str) -> DetectedInstall {
    DetectedInstall {
        launcher: launcher.to_string(),
        game_path: game_path.to_string(),
    }
}

// The whole point of the preference: a Steam copy installed later must not take the game
// away from the Microsoft Store copy that holds the mods, however the probe orders them.
#[test]
fn pick_prefers_the_copy_tracking_the_most_mods() {
    let steam = TempDir::new().unwrap();
    let xbox = TempDir::new().unwrap();
    let steam_path = make_bare_pd3_copy(steam.path());
    let xbox_path = make_pd3_copy(xbox.path(), 142);
    let installs = vec![install("steam", &steam_path), install("xbox", &xbox_path)];

    let picked = pick_install(&installs, pd3_engine(), None).unwrap();
    assert_eq!(picked.launcher, "xbox");
    assert_eq!(picked.game_path, xbox_path);
}

// The shape this actually takes in the wild: the game was handed to the Steam copy for a
// few days, so that copy has a mod list of its own. Its existence must not outweigh the
// 142 mods still sitting in the copy the user was modding.
#[test]
fn pick_ignores_a_mod_list_left_behind_by_a_copy_that_was_only_pointed_at() {
    let steam = TempDir::new().unwrap();
    let xbox = TempDir::new().unwrap();
    let installs = vec![
        install("steam", &make_pd3_copy(steam.path(), 0)),
        install("xbox", &make_pd3_copy(xbox.path(), 142)),
    ];

    let picked = pick_install(&installs, pd3_engine(), None).unwrap();
    assert_eq!(picked.launcher, "xbox");
}

// Mods hidden by "launch without mods" are in the backup, not the mods folder, and that
// copy is still the one being modded.
#[test]
fn pick_counts_mods_hidden_in_a_backup() {
    use crate::commands::mods::{save_state, InstalledMod, ModsState};
    let steam = TempDir::new().unwrap();
    let xbox = TempDir::new().unwrap();
    let steam_path = make_pd3_copy(steam.path(), 0);
    let xbox_path = make_bare_pd3_copy(xbox.path());
    let backup =
        backup_dir(&xbox_path, pd3_engine().primary()).join(crate::commands::mods::STATE_FILENAME);
    std::fs::create_dir_all(backup.parent().unwrap()).unwrap();
    save_state(
        &backup,
        &ModsState {
            mods: vec![InstalledMod::default()],
            folders: vec![],
        },
    );

    let installs = vec![install("steam", &steam_path), install("xbox", &xbox_path)];
    let picked = pick_install(&installs, pd3_engine(), None).unwrap();
    assert_eq!(picked.launcher, "xbox");
}

#[test]
fn pick_falls_back_to_the_recorded_launcher_when_no_copy_has_mods() {
    let steam = TempDir::new().unwrap();
    let xbox = TempDir::new().unwrap();
    let installs = vec![
        install("steam", &make_bare_pd3_copy(steam.path())),
        install("xbox", &make_bare_pd3_copy(xbox.path())),
    ];

    let picked = pick_install(&installs, pd3_engine(), Some("xbox")).unwrap();
    assert_eq!(picked.launcher, "xbox");
}

// Equally modded copies are a real tie, so the one already recorded keeps the game.
#[test]
fn pick_keeps_the_recorded_launcher_when_both_copies_are_equally_modded() {
    let steam = TempDir::new().unwrap();
    let xbox = TempDir::new().unwrap();
    let installs = vec![
        install("steam", &make_pd3_copy(steam.path(), 3)),
        install("xbox", &make_pd3_copy(xbox.path(), 3)),
    ];

    let picked = pick_install(&installs, pd3_engine(), Some("xbox")).unwrap();
    assert_eq!(picked.launcher, "xbox");
}

#[test]
fn pick_falls_back_to_the_first_copy_when_nothing_else_decides() {
    let steam = TempDir::new().unwrap();
    let xbox = TempDir::new().unwrap();
    let installs = vec![
        install("steam", &make_bare_pd3_copy(steam.path())),
        install("xbox", &make_bare_pd3_copy(xbox.path())),
    ];

    let picked = pick_install(&installs, pd3_engine(), None).unwrap();
    assert_eq!(picked.launcher, "steam");
    assert!(pick_install(&[], pd3_engine(), None).is_none());
}

fn settled_on(path: &str, launcher: &str) -> GameSettings {
    GameSettings {
        game_path: Some(path.to_string()),
        launcher: Some(launcher.to_string()),
        install_pinned: true,
        ..Default::default()
    }
}

#[test]
fn plan_keeps_a_settled_copy_that_is_still_there() {
    let dir = TempDir::new().unwrap();
    let path = make_pd3_copy(dir.path(), 3);
    assert_eq!(
        plan_resolution(pd3(), &settled_on(&path, "xbox")),
        Resolution::Keep
    );
}

// The copy is not where it was: mid-update, or on a drive that is not awake yet. Looking
// under its own launcher is what stops the other store's copy taking the game over.
#[test]
fn plan_refinds_a_settled_copy_under_its_own_launcher_only() {
    let dir = TempDir::new().unwrap();
    let gone = dir.path().join("gone").to_string_lossy().into_owned();
    assert_eq!(
        plan_resolution(pd3(), &settled_on(&gone, "xbox")),
        Resolution::Refind("xbox".to_string())
    );
}

// A hand-picked folder belongs to no store, so there is nothing to re-probe.
#[test]
fn plan_reports_a_missing_hand_picked_folder_rather_than_probing() {
    let dir = TempDir::new().unwrap();
    let gone = dir.path().join("gone").to_string_lossy().into_owned();
    assert_eq!(
        plan_resolution(pd3(), &settled_on(&gone, "manual")),
        Resolution::Missing
    );
}

// Every settings file written before copies were tracked arrives unpinned, which is what
// makes an existing install re-choose once against the mod list on disk.
#[test]
fn plan_settles_a_game_that_was_never_pinned_even_with_a_valid_path() {
    let dir = TempDir::new().unwrap();
    let path = make_bare_pd3_copy(dir.path());
    let existing = GameSettings {
        game_path: Some(path),
        launcher: Some("steam".to_string()),
        ..Default::default()
    };
    assert_eq!(plan_resolution(pd3(), &existing), Resolution::Settle);
}

// ── identify_launcher_for_path ────────────────────────────────────────────

#[test]
fn identify_launcher_steam() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("steam_appid.txt"), "1272080").unwrap();
    assert_eq!(
        identify_launcher_for_path(dir.path().to_str().unwrap()),
        "steam"
    );
}

#[test]
fn identify_launcher_epic() {
    let dir = TempDir::new().unwrap();
    std::fs::create_dir(dir.path().join(".egstore")).unwrap();
    assert_eq!(
        identify_launcher_for_path(dir.path().to_str().unwrap()),
        "epic"
    );
}

#[test]
fn identify_launcher_xbox() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("MicrosoftGame.config"), "").unwrap();
    assert_eq!(
        identify_launcher_for_path(dir.path().to_str().unwrap()),
        "xbox"
    );
}

#[test]
fn identify_launcher_manual_when_no_marker() {
    let dir = TempDir::new().unwrap();
    assert_eq!(
        identify_launcher_for_path(dir.path().to_str().unwrap()),
        "manual"
    );
}

#[test]
fn identify_launcher_steam_takes_precedence() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("steam_appid.txt"), "1272080").unwrap();
    std::fs::create_dir(dir.path().join(".egstore")).unwrap();
    assert_eq!(
        identify_launcher_for_path(dir.path().to_str().unwrap()),
        "steam"
    );
}

#[test]
fn pd3_xbox_crash_reporter_dir_uses_wingdk_subdir() {
    let dir = TempDir::new().unwrap();
    assert_eq!(
        pd3_xbox_crash_reporter_dir(dir.path()),
        dir.path().join("PAYDAY3").join("Binaries").join("WinGDK")
    );
}

#[test]
fn suppress_crash_reporter_removes_only_known_files() {
    let dir = TempDir::new().unwrap();
    let crash_dir = pd3_xbox_crash_reporter_dir(dir.path());
    std::fs::create_dir_all(&crash_dir).unwrap();
    for name in PD3_XBOX_CRASH_REPORTER_FILES {
        std::fs::write(crash_dir.join(name), "placeholder").unwrap();
    }
    std::fs::write(crash_dir.join("PAYDAY3-WinGDK-Shipping.exe"), "game").unwrap();

    maybe_suppress_crash_reporter(
        "pd3",
        &GameSettings {
            game_path: Some(dir.path().to_string_lossy().into_owned()),
            launcher: Some("xbox".to_string()),
            suppress_crash_reporter: true,
            ..Default::default()
        },
    );

    for name in PD3_XBOX_CRASH_REPORTER_FILES {
        assert!(!crash_dir.join(name).exists());
    }
    assert!(crash_dir.join("PAYDAY3-WinGDK-Shipping.exe").exists());
}

#[test]
fn suppress_crash_reporter_requires_pd3_xbox_opt_in() {
    let dir = TempDir::new().unwrap();
    let crash_dir = pd3_xbox_crash_reporter_dir(dir.path());
    std::fs::create_dir_all(&crash_dir).unwrap();
    std::fs::write(
        crash_dir.join(PD3_XBOX_CRASH_REPORTER_FILES[0]),
        "placeholder",
    )
    .unwrap();

    maybe_suppress_crash_reporter(
        "pd3",
        &GameSettings {
            game_path: Some(dir.path().to_string_lossy().into_owned()),
            launcher: Some("steam".to_string()),
            suppress_crash_reporter: true,
            ..Default::default()
        },
    );
    assert!(crash_dir.join(PD3_XBOX_CRASH_REPORTER_FILES[0]).exists());

    maybe_suppress_crash_reporter(
        "pd3",
        &GameSettings {
            game_path: Some(dir.path().to_string_lossy().into_owned()),
            launcher: Some("xbox".to_string()),
            suppress_crash_reporter: false,
            ..Default::default()
        },
    );
    assert!(crash_dir.join(PD3_XBOX_CRASH_REPORTER_FILES[0]).exists());
}

// ── sanitize_external_url ─────────────────────────────────────────────────

#[test]
fn sanitize_url_allows_web_and_mailto() {
    assert!(sanitize_external_url("http://example.com/a?b=1&c=2").is_some());
    assert!(sanitize_external_url("https://modworkshop.net/mod/123").is_some());
    assert!(sanitize_external_url("mailto:author@example.com").is_some());
}

#[test]
fn sanitize_url_rejects_file_and_unc() {
    assert!(sanitize_external_url("file:///C:/Windows/System32/calc.exe").is_none());
    assert!(sanitize_external_url(r"\\attacker\share\evil.exe").is_none());
}

#[test]
fn sanitize_url_rejects_dangerous_schemes() {
    assert!(sanitize_external_url("vbscript:msgbox(1)").is_none());
    assert!(sanitize_external_url("javascript:alert(1)").is_none());
}

#[test]
fn sanitize_url_rejects_cmd_breakout_chars() {
    assert!(sanitize_external_url("http://x/\" & calc.exe & \"").is_none());
}

#[test]
fn matches_process_windows_exe_name() {
    assert!(matches_process("PAYDAY3Client.exe", &[], "PAYDAY3Client"));
}

#[test]
fn matches_process_linux_truncated_comm() {
    // /proc comm is truncated to 15 chars for Proton-run Windows binaries
    assert!(matches_process("PAYDAY3Client.e", &[], "PAYDAY3Client"));
}

#[test]
fn matches_process_native_linux_name() {
    assert!(matches_process("payday2_release", &[], "payday2_release"));
}

#[test]
fn matches_process_proton_wrapper_cmdline() {
    let cmd = vec![
        String::from(r"Z:\games\PAYDAY3\PAYDAY3Client.exe"),
        String::from("-fileopenlog"),
    ];
    assert!(matches_process("wine64-preloader", &cmd, "PAYDAY3Client"));
}

#[test]
fn matches_process_rejects_unrelated() {
    let cmd = vec![String::from("/usr/bin/steam")];
    assert!(!matches_process("steam", &cmd, "PAYDAY3Client"));
}

// ── outside_bundle ────────────────────────────────────────────────────────

// One test rather than several: it moves process-wide environment variables, and
// parallel tests would see each other's writes.
#[cfg(target_os = "linux")]
#[test]
fn outside_bundle_drops_loader_overrides_only_inside_a_bundle() {
    fn removals(cmd: &std::process::Command) -> Vec<String> {
        let mut keys: Vec<String> = cmd
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        keys.sort();
        keys
    }

    std::env::remove_var("APPIMAGE");
    std::env::remove_var("APPDIR");
    let mut installed = std::process::Command::new("true");
    outside_bundle(&mut installed);
    assert!(removals(&installed).is_empty());

    std::env::set_var("APPIMAGE", "/tmp/modrex_x86_64.AppImage");
    let mut from_appimage = std::process::Command::new("true");
    outside_bundle(&mut from_appimage);
    std::env::remove_var("APPIMAGE");
    assert_eq!(removals(&from_appimage), ["LD_LIBRARY_PATH", "LD_PRELOAD"]);

    std::env::set_var("APPDIR", "/tmp/.mount_modrex");
    let mut from_appdir = std::process::Command::new("true");
    outside_bundle(&mut from_appdir);
    std::env::remove_var("APPDIR");
    assert_eq!(removals(&from_appdir), ["LD_LIBRARY_PATH", "LD_PRELOAD"]);
}

// ── resolve_under: the guard behind log and folder opening ──────────────────

/// A symlink at the expected log path is refused rather than opened or written through.
/// The pre-fix code copied the log to a fixed name in the shared temp directory, so a link
/// planted there had the copy written into whatever it pointed at.
#[cfg(unix)]
#[test]
fn resolve_under_refuses_a_symlinked_log_and_leaves_its_target_untouched() {
    let root = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    let victim = outside.path().join("precious.txt");
    std::fs::write(&victim, b"original contents").unwrap();

    let link = root.path().join("modrex.log");
    std::os::unix::fs::symlink(&victim, &link).unwrap();

    assert_eq!(
        super::resolve_under(root.path(), &link, super::OpenKind::File),
        None
    );
    assert_eq!(std::fs::read(&victim).unwrap(), b"original contents");
}

#[cfg(windows)]
#[test]
fn resolve_under_refuses_a_junction_in_the_log_directory() {
    let root = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    std::fs::write(outside.path().join("precious.txt"), b"keep").unwrap();
    let link = root.path().join("linked");
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !made {
        return;
    }
    assert_eq!(
        super::resolve_under(root.path(), &link, super::OpenKind::Directory),
        None
    );
    assert!(outside.path().join("precious.txt").exists());
}

#[test]
fn resolve_under_accepts_a_real_log_file_and_its_directory() {
    let root = tempfile::TempDir::new().unwrap();
    let log = root.path().join("modrex.log");
    std::fs::write(&log, b"a line").unwrap();

    assert_eq!(
        super::resolve_under(root.path(), &log, super::OpenKind::File),
        Some(log.canonicalize().unwrap())
    );
    assert_eq!(
        super::resolve_under(root.path(), root.path(), super::OpenKind::Directory),
        Some(root.path().canonicalize().unwrap())
    );
}

/// A missing log resolves to nothing, so the caller falls back to the directory rather than
/// creating or truncating anything.
#[test]
fn resolve_under_refuses_a_missing_target() {
    let root = tempfile::TempDir::new().unwrap();
    let missing = root.path().join("modrex.log");
    assert_eq!(
        super::resolve_under(root.path(), &missing, super::OpenKind::File),
        None
    );
    assert!(!missing.exists(), "resolving must not create the target");
}

#[test]
fn resolve_under_refuses_a_path_outside_the_root() {
    let root = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    let other = outside.path().join("other.log");
    std::fs::write(&other, b"x").unwrap();

    assert_eq!(
        super::resolve_under(root.path(), &other, super::OpenKind::File),
        None
    );
    assert_eq!(
        super::resolve_under(root.path(), outside.path(), super::OpenKind::Directory),
        None
    );
    // Traversal that climbs out is refused after canonicalization, not before.
    let climb = root.path().join("..");
    assert_eq!(
        super::resolve_under(root.path(), &climb, super::OpenKind::Directory),
        None
    );
}

#[test]
fn resolve_under_will_not_substitute_a_file_for_a_directory() {
    let root = tempfile::TempDir::new().unwrap();
    let log = root.path().join("modrex.log");
    std::fs::write(&log, b"x").unwrap();

    assert_eq!(
        super::resolve_under(root.path(), &log, super::OpenKind::Directory),
        None
    );
    assert_eq!(
        super::resolve_under(root.path(), root.path(), super::OpenKind::File),
        None
    );
}

// ── open_game_folder authorization ──────────────────────────────────────────

/// The command names a game, not a path, so the only folder it can reach is one already
/// recorded in settings. An unknown id is refused before any lookup happens.
#[test]
fn open_game_folder_rejects_an_unknown_game_id() {
    for id in ["", "nope", "../../etc", "C:/Windows"] {
        assert!(
            crate::commands::games::game_spec(id).is_none(),
            "'{id}' must not resolve to a game"
        );
    }
    for spec in crate::commands::games::GAME_REGISTRY.iter() {
        assert!(crate::commands::games::game_spec(spec.id).is_some());
    }
}

/// Only a real directory is opened; a file recorded where a game folder should be, or a
/// path that no longer exists, resolves to nothing rather than being handed to the shell.
#[test]
fn open_game_folder_only_resolves_real_directories() {
    let root = tempfile::TempDir::new().unwrap();
    let file = root.path().join("CrimeBoss.exe");
    std::fs::write(&file, b"x").unwrap();

    assert_eq!(
        super::resolve_under(&file, &file, super::OpenKind::Directory),
        None
    );
    let missing = root.path().join("gone");
    assert_eq!(
        super::resolve_under(&missing, &missing, super::OpenKind::Directory),
        None
    );
    assert_eq!(
        super::resolve_under(root.path(), root.path(), super::OpenKind::Directory),
        Some(root.path().canonicalize().unwrap())
    );
}
