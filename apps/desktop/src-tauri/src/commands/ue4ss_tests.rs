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
fn pd3_xbox_detects_the_proxy_beside_the_wingdk_executable() {
    let tmp = TempDir::new().unwrap();
    let win64 = tmp.path().join("PAYDAY3").join("Binaries").join("Win64");
    fs::create_dir_all(&win64).unwrap();
    fs::write(win64.join("dwmapi.dll"), b"").unwrap();
    assert!(!is_installed("pd3", &path_str(&tmp), Some("xbox")));

    let gdk = tmp.path().join("PAYDAY3").join("Binaries").join("WinGDK");
    fs::create_dir_all(&gdk).unwrap();
    fs::write(gdk.join("dwmapi.dll"), b"").unwrap();
    assert!(is_installed("pd3", &path_str(&tmp), Some("xbox")));
}

#[test]
fn pd3_detects_the_ue5_dwmapi_proxy() {
    // The UE5 rebuild (modworkshop id 47771, v0.2.0) proxies dwmapi.dll on every storefront,
    // replacing the xinput1_3.dll its UE4 predecessor shipped.
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("PAYDAY3").join("Binaries").join("Win64");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("dwmapi.dll"), b"").unwrap();
    assert!(is_installed("pd3", &path_str(&tmp), Some("steam")));
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

// ── Identification and replacement ─────────────────────────────────────────────
//
// Fixtures model the two published packages by layout and by the proxy DLL's real bytes:
// 44048 v0.4.0 is flat at Binaries/Win64 behind dxgi.dll, and 47771 v0.2.0 wraps everything
// but its dwmapi.dll proxy in a UE4SS folder. The DLL payloads here are the recorded bytes
// only where identity depends on them; the rest stands in for size, not shape.

use std::io::Write as _;

/// Stands in for the shipped table so a fixture can install a few bytes instead of the real
/// DLLs. Same shape, same code path: identification still comes from hashing the file.
pub(super) const TEST_RELEASES: &[KnownRelease] = &[
    KnownRelease {
        modworkshop_id: 47771,
        version: "0.2.0",
        proxy: "dwmapi.dll",
        proxy_sha256: "63e34c9877c627e18f66b649eb21be4b6292584496a653f7e440e70a0a57ac21",
    },
    KnownRelease {
        modworkshop_id: 44048,
        version: "0.4.0",
        proxy: "dxgi.dll",
        proxy_sha256: "236519bdc87f1c986cd473affc1077d775a1cb673b3aa1f34416f8db21ca36a1",
    },
];

fn proxy_bytes(release_id: i64) -> Vec<u8> {
    format!("modrex-fixture-proxy-{release_id}").into_bytes()
}

/// The shipped table is what real installs are matched against, so its entries have to be
/// usable as hashes and name the pages the loader is actually published under.
#[test]
fn the_shipped_release_table_is_well_formed() {
    assert!(!KNOWN_RELEASES.is_empty());
    for release in KNOWN_RELEASES {
        assert_eq!(release.proxy_sha256.len(), 64, "{}", release.proxy);
        assert!(
            release.proxy_sha256.chars().all(|c| c.is_ascii_hexdigit()),
            "{}",
            release.proxy
        );
        assert!(release.proxy.ends_with(".dll"));
        assert!(!release.version.is_empty());
    }
    let ids: Vec<i64> = KNOWN_RELEASES.iter().map(|r| r.modworkshop_id).collect();
    assert!(ids.contains(&47771) && ids.contains(&44048), "{ids:?}");
}

fn ue4ss_dir(tmp: &TempDir) -> PathBuf {
    tmp.path().join("PAYDAY3").join("Binaries").join("Win64")
}

/// Lays out an installed release the way its package extracts.
fn install_fixture(tmp: &TempDir, release: Ue4ssFixture) {
    let dir = ue4ss_dir(tmp);
    match release {
        Ue4ssFixture::Ue4 => {
            fs::create_dir_all(dir.join("Mods")).unwrap();
            fs::write(dir.join("dxgi.dll"), proxy_bytes(44048)).unwrap();
            fs::write(dir.join("UE4SS.dll"), b"old engine").unwrap();
            fs::write(dir.join("UE4SS-settings.ini"), b"[General]").unwrap();
            fs::write(dir.join("VTableLayout.ini"), b"[vtable]").unwrap();
            fs::write(dir.join("Mods/mods.txt"), b"BPML_GenericFunctions : 1\n").unwrap();
            write_submod_at(&dir.join("Mods"), "Keybinds", b"-- bundled");
        }
        Ue4ssFixture::Unknown => {
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("dxgi.dll"), b"a build nobody recorded").unwrap();
            fs::write(dir.join("UE4SS.dll"), b"unknown engine").unwrap();
        }
    }
}

#[derive(Clone, Copy)]
enum Ue4ssFixture {
    Ue4,
    Unknown,
}

fn write_submod_at(mods: &std::path::Path, name: &str, body: &[u8]) {
    let scripts = mods.join(name).join("Scripts");
    fs::create_dir_all(&scripts).unwrap();
    fs::write(scripts.join("main.lua"), body).unwrap();
}

/// A stand-in for the published UE5 package: wrapper directory, dwmapi proxy outside a UE4SS
/// folder that holds everything else.
fn ue5_package(extra: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
    let mut entries: Vec<(String, Vec<u8>)> = vec![
        ("PD3-UE5-UE4SS-exp/dwmapi.dll".into(), proxy_bytes(47771)),
        (
            "PD3-UE5-UE4SS-exp/UE4SS/UE4SS.dll".into(),
            b"new engine".to_vec(),
        ),
        (
            "PD3-UE5-UE4SS-exp/UE4SS/UE4SS-settings.ini".into(),
            b"[General]".to_vec(),
        ),
        (
            "PD3-UE5-UE4SS-exp/UE4SS/Mods/mods.txt".into(),
            b"BPML_GenericFunctions : 1\nAllowModsMod : 1\n".to_vec(),
        ),
        (
            "PD3-UE5-UE4SS-exp/UE4SS/Mods/Keybinds/Scripts/main.lua".into(),
            b"-- bundled".to_vec(),
        ),
    ];
    for (name, body) in extra {
        entries.push(((*name).into(), body.to_vec()));
    }
    let f = tempfile::NamedTempFile::new().unwrap();
    let mut zip = ::zip::ZipWriter::new(fs::File::create(f.path()).unwrap());
    let opts = ::zip::write::SimpleFileOptions::default();
    for (name, body) in &entries {
        zip.start_file(name.as_str(), opts).unwrap();
        zip.write_all(body).unwrap();
    }
    zip.finish().unwrap();
    f
}

#[test]
fn an_unknown_legacy_install_reads_as_present_with_no_version() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Unknown);
    let found = presence("pd3", &path_str(&tmp), Some("steam"));
    assert!(
        found.installed,
        "a proxy is there, so something is hooked in"
    );
    assert_eq!(found.modworkshop_id, None);
    assert_eq!(found.version, None);
    assert_eq!(found.unrecognized, vec!["dxgi.dll".to_string()]);
}

#[test]
fn an_unknown_build_is_removed_rather_than_left_hooked_into_the_game() {
    // A hand-installed build matches no release, so its proxy cannot be claimed on its bytes.
    // It still has to go: its engine is removed by name, and a proxy left behind loads an
    // engine that is no longer there, next to the new loader's own proxy.
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Unknown);
    let dir = ue4ss_dir(&tmp);
    let package = ue5_package(&[]);

    install_loader("pd3", &path_str(&tmp), Some("steam"), package.path()).unwrap();

    assert!(
        dir.join("dwmapi.dll").is_file(),
        "the new proxy is in place"
    );
    assert!(dir.join("UE4SS/UE4SS.dll").is_file());
    assert!(
        !dir.join("dxgi.dll").exists(),
        "the old proxy went with the engine it was loading"
    );
}

#[test]
fn a_proxy_beside_a_recognised_one_belongs_to_something_else_and_stays() {
    // UE4SS and ReShade in one folder. The bytes name which proxy is UE4SS's, so nothing has
    // to be inferred about the other, and inferring anything would delete ReShade.
    let tmp = TempDir::new().unwrap();
    let dir = ue4ss_dir(&tmp);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("dxgi.dll"), proxy_bytes(44048)).unwrap();
    fs::write(dir.join("dwmapi.dll"), b"ReShade, not UE4SS").unwrap();
    fs::write(dir.join("UE4SS.dll"), b"old engine").unwrap();
    let package = ue5_package(&[]);

    let err = install_loader("pd3", &path_str(&tmp), Some("steam"), package.path())
        .unwrap_err()
        .message();

    assert!(err.contains("dwmapi.dll"), "the file is named: {err}");
    assert_eq!(
        fs::read(dir.join("dwmapi.dll")).unwrap(),
        b"ReShade, not UE4SS",
        "and it is still theirs"
    );
}

#[test]
fn two_proxies_that_nothing_recognises_are_both_left_alone() {
    // An unrecognised build and an unrecognised overlay look identical from here. Removing
    // the wrong one takes out something Modrex never installed, so neither is claimed and the
    // package refuses instead.
    let tmp = TempDir::new().unwrap();
    let dir = ue4ss_dir(&tmp);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("dxgi.dll"), b"some build nobody recorded").unwrap();
    fs::write(dir.join("dwmapi.dll"), b"ReShade, not UE4SS").unwrap();
    fs::write(dir.join("UE4SS.dll"), b"old engine").unwrap();
    let package = ue5_package(&[]);

    let err = install_loader("pd3", &path_str(&tmp), Some("steam"), package.path())
        .unwrap_err()
        .message();

    assert!(err.contains("not Modrex's to replace"), "unexpected: {err}");
    assert_eq!(
        fs::read(dir.join("dxgi.dll")).unwrap(),
        b"some build nobody recorded"
    );
    assert_eq!(
        fs::read(dir.join("dwmapi.dll")).unwrap(),
        b"ReShade, not UE4SS"
    );
}

#[test]
fn replacing_a_known_release_clears_its_proxy_and_engine() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    let package = ue5_package(&[]);

    install_loader("pd3", &path_str(&tmp), Some("steam"), package.path()).unwrap();

    assert!(
        !dir.join("dxgi.dll").exists(),
        "the old proxy must go, or both loaders stay hooked in"
    );
    assert!(!dir.join("UE4SS.dll").exists(), "and so must its engine");
    assert!(!dir.join("UE4SS-settings.ini").exists());
    assert!(dir.join("dwmapi.dll").is_file());
    assert_eq!(
        fs::read(dir.join("UE4SS/UE4SS.dll")).unwrap(),
        b"new engine"
    );
}

#[test]
fn a_replacement_identifies_itself_afterwards() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let package = ue5_package(&[]);
    install_loader("pd3", &path_str(&tmp), Some("steam"), package.path()).unwrap();

    let found = presence("pd3", &path_str(&tmp), Some("steam"));
    assert!(found.installed);
    assert_eq!(found.modworkshop_id, Some(47771));
    assert_eq!(found.version.as_deref(), Some("0.2.0"));
    assert!(found.unrecognized.is_empty());
}

#[test]
fn a_users_lua_mods_survive_a_replacement_byte_for_byte() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    write_submod_at(&dir.join("Mods"), "CoolMod", b"-- the user's own");
    fs::write(dir.join("Mods/mods.txt"), b"Keybinds : 1\nCoolMod : 0\n").unwrap();
    let package = ue5_package(&[]);

    install_loader("pd3", &path_str(&tmp), Some("steam"), package.path()).unwrap();

    assert_eq!(
        fs::read(dir.join("UE4SS/Mods/CoolMod/Scripts/main.lua")).unwrap(),
        b"-- the user's own",
        "a mod the user added survives, in the folder the new release reads"
    );
    assert!(
        !dir.join("Mods/CoolMod").exists(),
        "and is not left behind in the old layout's folder, where nothing would load it"
    );
    let txt = fs::read_to_string(dir.join("UE4SS/Mods/mods.txt")).unwrap();
    assert!(
        txt.contains("CoolMod : 0"),
        "their own enable and disable choices carry over: {txt}"
    );
    assert!(
        txt.contains("AllowModsMod : 1"),
        "and the new release's own stay"
    );
}

#[test]
fn an_unrelated_dll_under_a_proxy_name_is_left_alone() {
    // ReShade, Special K and vendor overlays all ship a dxgi.dll. Matching the name is not
    // matching the file.
    let tmp = TempDir::new().unwrap();
    let dir = ue4ss_dir(&tmp);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("dxgi.dll"), b"ReShade, not UE4SS").unwrap();
    let package = ue5_package(&[]);

    install_loader("pd3", &path_str(&tmp), Some("steam"), package.path()).unwrap();

    assert_eq!(
        fs::read(dir.join("dxgi.dll")).unwrap(),
        b"ReShade, not UE4SS"
    );
}

#[test]
fn a_package_without_the_engine_changes_nothing() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    let before = fs::read(dir.join("UE4SS.dll")).unwrap();
    let package = ue5_package(&[]);
    // A download that is an archive but not this loader.
    let junk = tempfile::NamedTempFile::new().unwrap();
    {
        let mut zip = ::zip::ZipWriter::new(fs::File::create(junk.path()).unwrap());
        zip.start_file("readme.txt", ::zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"not a loader").unwrap();
        zip.finish().unwrap();
    }

    let err = install_loader("pd3", &path_str(&tmp), Some("steam"), junk.path())
        .unwrap_err()
        .message();

    assert!(err.contains("does not contain UE4SS"), "unexpected: {err}");
    assert_eq!(
        fs::read(dir.join("UE4SS.dll")).unwrap(),
        before,
        "a refused package leaves the working loader exactly where it was"
    );
    assert!(dir.join("dxgi.dll").is_file());
    drop(package);
}

#[test]
fn an_unreadable_package_changes_nothing() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    let corrupt = tempfile::NamedTempFile::new().unwrap();
    fs::write(corrupt.path(), b"\x00\x01 not an archive").unwrap();

    let err = install_loader("pd3", &path_str(&tmp), Some("steam"), corrupt.path())
        .unwrap_err()
        .message();

    assert!(err.contains("could not be read"), "unexpected: {err}");
    assert!(dir.join("dxgi.dll").is_file());
    assert!(dir.join("UE4SS.dll").is_file());
}

#[test]
fn an_unverified_storefront_refuses_rather_than_guessing_a_path() {
    let tmp = TempDir::new().unwrap();
    let package = ue5_package(&[]);
    for launcher in [Some("manual"), Some("gog"), None] {
        let err = install_loader("pd3", &path_str(&tmp), launcher, package.path())
            .unwrap_err()
            .message();
        assert!(err.contains("isn't supported yet"), "unexpected: {err}");
    }
    assert!(
        !tmp.path().join("PAYDAY3").exists(),
        "nothing is written for a storefront whose path was never verified"
    );
}

#[test]
fn the_backup_is_gone_once_a_replacement_succeeds() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let package = ue5_package(&[]);
    install_loader("pd3", &path_str(&tmp), Some("steam"), package.path()).unwrap();
    let leftovers: Vec<_> = fs::read_dir(tmp.path().join("PAYDAY3").join("Binaries"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("backup"))
        .collect();
    assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
}

// ── Replacement safety ─────────────────────────────────────────────────────────

/// Every file under a directory with its bytes, so a failed replacement can be held against
/// the installation as it stood rather than against a handful of chosen paths.
fn snapshot(root: &std::path::Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    fn walk(
        root: &std::path::Path,
        prefix: &std::path::Path,
        out: &mut std::collections::BTreeMap<PathBuf, Vec<u8>>,
    ) {
        let Ok(entries) = fs::read_dir(root.join(prefix)) else {
            return;
        };
        for entry in entries.flatten() {
            let rel = prefix.join(entry.file_name());
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => walk(root, &rel, out),
                Ok(kind) if kind.is_file() => {
                    out.insert(rel, fs::read(entry.path()).unwrap_or_default());
                }
                _ => {}
            }
        }
    }
    let mut out = std::collections::BTreeMap::new();
    walk(root, std::path::Path::new(""), &mut out);
    out
}

#[test]
fn an_unknown_file_at_the_incoming_proxy_path_refuses_the_whole_replacement() {
    // The package writes dwmapi.dll. Something already holds that name and nothing can
    // attribute it, so it is not Modrex's to write over, and refusing has to happen before
    // any file moves rather than after the extraction has already clobbered it.
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    fs::write(dir.join("dwmapi.dll"), b"somebody else's dwmapi").unwrap();
    let before = snapshot(&dir);
    let package = ue5_package(&[]);

    let err = install_loader("pd3", &path_str(&tmp), Some("steam"), package.path())
        .unwrap_err()
        .message();

    assert!(err.contains("dwmapi.dll"), "the file is named: {err}");
    assert!(err.contains("not Modrex's to replace"), "unexpected: {err}");
    assert_eq!(
        fs::read(dir.join("dwmapi.dll")).unwrap(),
        b"somebody else's dwmapi",
        "its bytes are untouched"
    );
    assert_eq!(snapshot(&dir), before, "and so is everything else");
}

#[test]
fn a_failure_part_way_through_leaves_the_installation_as_it_was() {
    // UE4SS is a file here, so the package's first attempt to create the directory it needs
    // fails after earlier files have already been written. Nothing here is attributable, so
    // the preflight passes and the failure lands mid-write, which is the case rollback exists
    // for. The whole tree is compared, not the few paths the operation happens to know about.
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    write_submod_at(&dir.join("Mods"), "CoolMod", b"-- the user's own");
    fs::write(dir.join("UE4SS"), b"not a directory").unwrap();
    let before = snapshot(&dir);
    let package = ue5_package(&[]);

    let err = install_loader("pd3", &path_str(&tmp), Some("steam"), package.path())
        .unwrap_err()
        .message();

    assert!(err.contains("could not be installed"), "unexpected: {err}");
    assert_eq!(
        snapshot(&dir),
        before,
        "a failed replacement leaves every file exactly as it found it"
    );
}

#[test]
fn a_failed_replacement_leaves_no_recovery_data_behind_in_the_game_folder() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    fs::write(dir.join("UE4SS"), b"not a directory").unwrap();
    let package = ue5_package(&[]);

    let _ = install_loader("pd3", &path_str(&tmp), Some("steam"), package.path());

    let leftovers: Vec<String> = fs::read_dir(dir.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("backup"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "a rollback that succeeded keeps nothing aside: {leftovers:?}"
    );
}

#[test]
fn a_mods_list_under_something_that_is_not_a_directory_carries_nothing() {
    // The UE5 layout's mods.txt sits inside a UE4SS folder. When that name is taken by a file,
    // the list cannot be there, and the platforms say so differently: Windows reports NotFound
    // and Unix NotADirectory. Refusing the replacement over it is wrong on either.
    let tmp = TempDir::new().unwrap();
    let dir = ue4ss_dir(&tmp);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("UE4SS"), b"not a directory").unwrap();

    let carried = user_mods_txt_entries(&dir.join("UE4SS").join("Mods").join("mods.txt")).unwrap();

    assert!(carried.is_empty(), "{carried:?}");
}

#[test]
fn an_unreadable_mods_list_is_a_failure_rather_than_an_empty_one() {
    // Reading it as empty would silently drop every enable and disable the user set.
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    fs::remove_file(dir.join("Mods/mods.txt")).unwrap();
    fs::create_dir(dir.join("Mods/mods.txt")).unwrap();
    let before = snapshot(&dir);
    let package = ue5_package(&[]);

    let err = install_loader("pd3", &path_str(&tmp), Some("steam"), package.path())
        .unwrap_err()
        .message();

    assert!(err.contains("could not be read"), "unexpected: {err}");
    assert_eq!(
        snapshot(&dir),
        before,
        "and nothing was changed to find out"
    );
}

#[test]
fn a_package_is_never_unpacked_over_the_installation_it_replaces() {
    // The staging copy is what proves the package is usable, so a download that turns out to
    // be unusable has already been rejected before the installed loader is touched.
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    let before = snapshot(&dir);
    let junk = tempfile::NamedTempFile::new().unwrap();
    {
        let mut zip = ::zip::ZipWriter::new(fs::File::create(junk.path()).unwrap());
        zip.start_file(
            "Mods/CoolMod/Scripts/main.lua",
            ::zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"-- a sub-mod, not the loader").unwrap();
        zip.finish().unwrap();
    }

    let err = install_loader("pd3", &path_str(&tmp), Some("steam"), junk.path())
        .unwrap_err()
        .message();

    assert!(err.contains("does not contain UE4SS"), "unexpected: {err}");
    assert_eq!(
        snapshot(&dir),
        before,
        "nothing from the rejected package reached the installation"
    );
}

#[test]
fn a_bundled_submod_the_new_release_drops_does_not_survive_as_a_user_mod() {
    // The UE4 release ships eleven of these and the UE5 one three. They are the loader's, so
    // the ones it no longer ships go with it rather than lingering as folders the user never
    // installed.
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    write_submod_at(
        &dir.join("Mods"),
        "ConsoleCommandsMod",
        b"-- bundled, UE4 only",
    );
    write_submod_at(&dir.join("Mods"), "CoolMod", b"-- the user's own");
    let package = ue5_package(&[]);

    install_loader("pd3", &path_str(&tmp), Some("steam"), package.path()).unwrap();

    assert!(
        !dir.join("Mods/ConsoleCommandsMod").exists(),
        "a sub-mod the loader shipped goes with the loader"
    );
    assert_eq!(
        fs::read(dir.join("UE4SS/Mods/CoolMod/Scripts/main.lua")).unwrap(),
        b"-- the user's own",
        "a mod the user added is not the loader's to remove"
    );
}

#[test]
fn what_the_plan_promises_is_what_the_replacement_does() {
    // The plan is shown before the user commits, and it is read off the installation rather
    // than off the package, so the two can only be trusted together if they are checked
    // together.
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    write_submod_at(&dir.join("Mods"), "CoolMod", b"-- the user's own");
    let plan = plan_replacement("pd3", &path_str(&tmp), Some("steam")).unwrap();
    assert!(plan.replaced.contains(&"dxgi.dll".to_string()), "{plan:?}");
    assert!(plan.replaced.contains(&"UE4SS.dll".to_string()), "{plan:?}");
    assert_eq!(plan.preserved, vec!["CoolMod".to_string()]);
    let package = ue5_package(&[]);

    install_loader("pd3", &path_str(&tmp), Some("steam"), package.path()).unwrap();

    for name in &plan.replaced {
        assert!(
            !dir.join(name).exists(),
            "the plan said {name} would go, and it is still there"
        );
    }
    for name in &plan.preserved {
        assert_eq!(
            fs::read(dir.join("UE4SS/Mods").join(name).join("Scripts/main.lua")).unwrap(),
            b"-- the user's own",
            "the plan said {name} would be kept"
        );
    }
}

#[test]
fn a_mod_already_in_the_incoming_layout_is_not_moved_onto_itself() {
    // Replacing a UE5 release with another one: the user's mods are already where the new
    // release reads them, so nothing moves and nothing is reported as unfinished.
    let tmp = TempDir::new().unwrap();
    let dir = ue4ss_dir(&tmp);
    fs::create_dir_all(dir.join("UE4SS/Mods")).unwrap();
    fs::write(dir.join("dwmapi.dll"), proxy_bytes(47771)).unwrap();
    fs::write(dir.join("UE4SS/UE4SS.dll"), b"old engine").unwrap();
    fs::write(
        dir.join("UE4SS/Mods/mods.txt"),
        b"CoolMod : 1
",
    )
    .unwrap();
    write_submod_at(&dir.join("UE4SS/Mods"), "CoolMod", b"-- the user's own");
    let package = ue5_package(&[]);

    install_loader("pd3", &path_str(&tmp), Some("steam"), package.path()).unwrap();

    assert_eq!(
        fs::read(dir.join("UE4SS/Mods/CoolMod/Scripts/main.lua")).unwrap(),
        b"-- the user's own"
    );
    assert!(
        !dir.join("Mods/CoolMod").exists(),
        "nothing was moved out to the other layout"
    );
}

// ── Removal ────────────────────────────────────────────────────────────────────

#[test]
fn removing_the_loader_keeps_the_mods_the_user_added() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);
    let dir = ue4ss_dir(&tmp);
    write_submod_at(&dir.join("Mods"), "CoolMod", b"-- the user's own");

    uninstall("pd3", &path_str(&tmp), Some("steam")).unwrap();

    assert!(!dir.join("dxgi.dll").exists(), "the proxy is gone");
    assert!(!dir.join("UE4SS.dll").exists(), "and so is the engine");
    assert!(
        !dir.join("Mods/Keybinds").exists(),
        "a sub-mod the release shipped goes with it"
    );
    assert_eq!(
        fs::read(dir.join("Mods/CoolMod/Scripts/main.lua")).unwrap(),
        b"-- the user's own",
        "a mod the user added is not the loader's to delete"
    );
}

#[test]
fn removing_a_loader_nothing_can_attribute_refuses_rather_than_guessing() {
    // Only a proxy-named DLL is here, with no engine beside it to say it is UE4SS's. Deleting
    // it on the name alone would delete ReShade.
    let tmp = TempDir::new().unwrap();
    let dir = ue4ss_dir(&tmp);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("dxgi.dll"), b"ReShade, not UE4SS").unwrap();

    let err = uninstall("pd3", &path_str(&tmp), Some("steam")).unwrap_err();

    assert!(err.contains("will not delete"), "unexpected: {err}");
    assert_eq!(
        fs::read(dir.join("dxgi.dll")).unwrap(),
        b"ReShade, not UE4SS"
    );
}

#[test]
fn removing_an_unverified_storefront_refuses_rather_than_guessing_a_path() {
    let tmp = TempDir::new().unwrap();
    install_fixture(&tmp, Ue4ssFixture::Ue4);

    let err = uninstall("pd3", &path_str(&tmp), Some("manual")).unwrap_err();

    assert!(err.contains("isn't supported yet"), "unexpected: {err}");
    assert!(
        ue4ss_dir(&tmp).join("dxgi.dll").is_file(),
        "nothing was removed on a guessed path"
    );
}
