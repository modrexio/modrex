use super::*;
use std::fs;
use tempfile::TempDir;

fn path_str(tmp: &TempDir) -> String {
    tmp.path().to_string_lossy().into_owned()
}

#[test]
fn cb_steam_detects_proxy_dll() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("CrimeBoss").join("Binaries").join("Win64");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("dwmapi.dll"), b"").unwrap();
    assert!(is_installed("cb", &path_str(&tmp), Some("steam")));
}

#[test]
fn cb_missing_proxy_dll_is_not_installed() {
    let tmp = TempDir::new().unwrap();
    assert!(!is_installed("cb", &path_str(&tmp), Some("steam")));
}

#[test]
fn cb_unverified_launcher_never_guesses_a_path() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("CrimeBoss").join("Binaries").join("Win64");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("dwmapi.dll"), b"").unwrap();
    // Even with the file present, an unverified launcher must report not-installed.
    assert!(!is_installed("cb", &path_str(&tmp), Some("epic")));
    assert!(!is_installed("cb", &path_str(&tmp), None));
}

#[test]
fn pd3_steam_detects_proxy_dll() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("PAYDAY3").join("Binaries").join("Win64");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("xinput1_3.dll"), b"").unwrap();
    assert!(is_installed("pd3", &path_str(&tmp), Some("steam")));
}

#[test]
fn pd3_epic_detects_proxy_dll() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("PAYDAY3").join("Binaries").join("Win64");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("xinput1_3.dll"), b"").unwrap();
    assert!(is_installed("pd3", &path_str(&tmp), Some("epic")));
}

#[test]
fn pd3_detects_the_older_dxgi_proxy_variant() {
    // The older "PD3 UE4SS / Allow Pak Mods" release (modworkshop id 44048) uses dxgi.dll
    // instead of xinput1_3.dll. It is a separate, independently maintained mod page that
    // real mods such as DebugMenuMod depend on, so both must be recognized as installed.
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("PAYDAY3").join("Binaries").join("Win64");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("dxgi.dll"), b"").unwrap();
    assert!(is_installed("pd3", &path_str(&tmp), Some("steam")));
}

#[test]
fn pd3_xbox_unverified_never_guesses_a_path() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("PAYDAY3").join("Binaries").join("Win64");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("xinput1_3.dll"), b"").unwrap();
    assert!(!is_installed("pd3", &path_str(&tmp), Some("xbox")));
}

#[test]
fn unknown_game_id_is_not_installed() {
    let tmp = TempDir::new().unwrap();
    assert!(!is_installed("pdth", &path_str(&tmp), Some("steam")));
}

#[test]
fn directory_named_like_proxy_dll_does_not_count() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("CrimeBoss").join("Binaries").join("Win64");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir(dir.join("dwmapi.dll")).unwrap();
    assert!(!is_installed("cb", &path_str(&tmp), Some("steam")));
}

/// A game that declares no UE4SS binding must resolve nothing, rather than inheriting
/// another game's destination.
#[test]
fn a_game_without_a_ue4ss_binding_resolves_nothing() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().to_str().unwrap();
    for game_id in ["raid", "pd2", "pdth"] {
        assert!(!is_installed(game_id, path, Some("steam")), "{game_id}");
    }
}

#[test]
fn an_unrecognised_launcher_fails_closed() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().to_str().unwrap();
    assert!(!is_installed("pd3", path, Some("gog")));
    assert!(!is_installed("pd3", path, None));
}
