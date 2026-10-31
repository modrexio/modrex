use super::*;
use flate2::write::ZlibEncoder;
use std::io::Write;
use tempfile::TempDir;

const GUID: &str = "0123456789ABCDEF0123456789ABCDEF";
const DLC_GUID: &str = "FEDCBA9876543210FEDCBA9876543210";

fn ascii(text: &str) -> Vec<u8> {
    let mut out = ((text.len() + 1) as i32).to_le_bytes().to_vec();
    out.extend_from_slice(text.as_bytes());
    out.push(0);
    out
}

fn utf16(text: &str) -> Vec<u8> {
    let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let mut out = (-(units.len() as i32)).to_le_bytes().to_vec();
    for unit in units {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

fn section(contents: &[u8]) -> Vec<u8> {
    let mut out = ((contents.len() + 5) as u32).to_le_bytes().to_vec();
    out.push(0);
    out.extend_from_slice(contents);
    out
}

fn body(names: &[Vec<u8>], links: &[Vec<u8>]) -> Vec<u8> {
    let mut file_list = (names.len() as u32).to_le_bytes().to_vec();
    names.iter().for_each(|name| file_list.extend(name));
    links.iter().for_each(|link| file_list.extend(link));
    file_list.extend(vec![0u8; names.len() * 21]);
    let mut out = section(&[7, 0, 0, 0, 1]);
    out.extend(section(&0u32.to_le_bytes()));
    out.extend(section(&file_list));
    out.extend(section(&0u32.to_le_bytes()));
    out
}

fn manifest_from_body(body: &[u8], compressed: bool) -> Vec<u8> {
    let stored = if compressed {
        let mut encoder = ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(body).unwrap();
        encoder.finish().unwrap()
    } else {
        body.to_vec()
    };
    let mut out = MANIFEST_MAGIC.to_le_bytes().to_vec();
    out.extend(41u32.to_le_bytes());
    out.extend((body.len() as u32).to_le_bytes());
    out.extend((stored.len() as u32).to_le_bytes());
    out.extend(Sha1::digest(body));
    out.push(if compressed { STORED_COMPRESSED } else { 0 });
    out.extend(18u32.to_le_bytes());
    out.extend(stored);
    out
}

fn manifest(names: &[&str]) -> Vec<u8> {
    let names: Vec<_> = names.iter().map(|name| ascii(name)).collect();
    let links = vec![0i32.to_le_bytes().to_vec(); names.len()];
    manifest_from_body(&body(&names, &links), true)
}

struct Install {
    manifests: TempDir,
    game: TempDir,
}

impl Install {
    fn new() -> Self {
        let install = Self {
            manifests: TempDir::new().unwrap(),
            game: TempDir::new().unwrap(),
        };
        fs::create_dir(install.game.path().join(".egstore")).unwrap();
        install
    }

    fn record(&self, file: &str, display_name: &str, guid: &str, files: &[&str]) {
        self.record_with(file, display_name, guid, false);
        fs::write(
            self.game
                .path()
                .join(".egstore")
                .join(format!("{guid}.manifest")),
            manifest(files),
        )
        .unwrap();
    }

    fn record_with(&self, file: &str, display_name: &str, guid: &str, incomplete: bool) {
        let record = serde_json::json!({
            "DisplayName": display_name,
            "InstallLocation": self.game.path().to_str().unwrap(),
            "InstallationGuid": guid,
            "AppName": "app",
            "bIsIncompleteInstall": incomplete,
            "bNeedsValidation": false,
        });
        fs::write(self.manifests.path().join(file), record.to_string()).unwrap();
    }

    fn read(&self) -> Result<EpicNativeFiles, String> {
        read_native_files(self.manifests.path(), "Game", self.game.path())
    }
}

#[test]
fn parses_the_file_list_of_a_compressed_manifest() {
    let files = parse_manifest(&manifest(&["Game/Content/Paks/pakchunk0-Windows.pak"])).unwrap();
    assert_eq!(files, ["Game/Content/Paks/pakchunk0-Windows.pak"]);
}

#[test]
fn parses_an_uncompressed_manifest_and_utf16_names() {
    let names = vec![ascii("a.pak"), utf16("Paks/日本.pak")];
    let links = vec![0i32.to_le_bytes().to_vec(); 2];
    let files = parse_manifest(&manifest_from_body(&body(&names, &links), false)).unwrap();
    assert_eq!(files, ["a.pak", "Paks/日本.pak"]);
}

#[test]
fn refuses_a_body_whose_sha1_does_not_match() {
    let mut bytes = manifest_from_body(&body(&[ascii("a.pak")], &[ascii("")]), false);
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    assert!(parse_manifest(&bytes).unwrap_err().contains("SHA-1"));
}

#[test]
fn refuses_json_encrypted_and_foreign_files() {
    assert!(parse_manifest(b"\xEF\xBB\xBF {\"ManifestFileVersion\":1}")
        .unwrap_err()
        .contains("JSON"));
    let mut encrypted = manifest(&["a.pak"]);
    encrypted[36] |= STORED_ENCRYPTED;
    assert!(parse_manifest(&encrypted)
        .unwrap_err()
        .contains("encrypted"));
    assert!(parse_manifest(b"PK\x03\x04 not a manifest")
        .unwrap_err()
        .contains("not a BuildPatch"));
}

#[test]
fn refuses_symbolic_link_entries() {
    let bytes = manifest_from_body(&body(&[ascii("a.pak")], &[ascii("b.pak")]), true);
    assert!(parse_manifest(&bytes)
        .unwrap_err()
        .contains("symbolic link"));
}

#[test]
fn refuses_truncated_and_resized_manifests() {
    let bytes = manifest(&["a.pak"]);
    assert!(parse_manifest(&bytes[..bytes.len() - 1]).is_err());
    let mut longer = bytes.clone();
    longer.push(0);
    assert!(parse_manifest(&longer).is_err());
    let mut short_section = body(&[ascii("a.pak")], &[ascii("")]);
    short_section[0] = 4;
    assert!(parse_manifest(&manifest_from_body(&short_section, false)).is_err());
}

#[test]
fn reads_the_installed_build_and_protects_its_paths() {
    let install = Install::new();
    install.record(
        "game.item",
        "Game",
        GUID,
        &["Game/Content/Paks/pakchunk0-Windows.pak", "Game.exe"],
    );

    let snapshot = install.read().unwrap();

    assert!(snapshot
        .protects(Path::new("Game/Content/Paks/pakchunk0-Windows.pak"))
        .unwrap());
    assert!(snapshot
        .protects(Path::new("game/content/paks/PAKCHUNK0-WINDOWS.PAK"))
        .unwrap());
    assert!(!snapshot
        .protects(Path::new("Game/Content/Paks/pakchunk99-Mod.pak"))
        .unwrap());
    assert!(snapshot.protects_tree(Path::new("Game/Content")).unwrap());
}

#[test]
fn dlc_records_in_the_same_folder_extend_the_file_list() {
    let install = Install::new();
    install.record("game.item", "Game", GUID, &["Game/Content/Paks/base.pak"]);
    install.record(
        "dlc.item",
        "Game DLC",
        DLC_GUID,
        &["Game/Content/Paks/dlc.pak"],
    );

    let snapshot = install.read().unwrap();

    assert!(snapshot
        .protects(Path::new("Game/Content/Paks/dlc.pak"))
        .unwrap());
    assert!(snapshot
        .protects(Path::new("Game/Content/Paks/base.pak"))
        .unwrap());
}

#[test]
fn junk_records_and_records_for_other_folders_are_ignored() {
    let install = Install::new();
    install.record("game.item", "Game", GUID, &["Game.exe"]);
    fs::write(install.manifests.path().join("zeros.item"), [0u8; 64]).unwrap();
    let elsewhere = TempDir::new().unwrap();
    let other = serde_json::json!({
        "DisplayName": "Game",
        "InstallLocation": elsewhere.path().to_str().unwrap(),
        "InstallationGuid": DLC_GUID,
    });
    fs::write(
        install.manifests.path().join("other.item"),
        other.to_string(),
    )
    .unwrap();

    assert!(install.read().is_ok());
}

#[test]
fn an_incomplete_installation_is_refused() {
    let install = Install::new();
    install.record("game.item", "Game", GUID, &["Game.exe"]);
    install.record_with("game.item", "Game", GUID, true);

    assert!(install.read().unwrap_err().contains("incomplete"));
}

#[test]
fn a_missing_manifest_is_refused() {
    let install = Install::new();
    install.record_with("game.item", "Game", GUID, false);

    assert!(install.read().is_err());
}

#[test]
fn a_folder_without_the_base_game_record_is_refused() {
    let install = Install::new();
    install.record("dlc.item", "Game DLC", DLC_GUID, &["dlc.pak"]);

    assert!(install
        .read()
        .unwrap_err()
        .contains("No Epic installation record"));
}

#[test]
fn unsafe_manifest_paths_are_refused() {
    let install = Install::new();
    install.record("game.item", "Game", GUID, &["Game/../outside.pak"]);

    assert!(install.read().unwrap_err().contains("Unsafe"));
}

#[test]
fn a_changed_manifest_is_detected_before_a_mutation() {
    let install = Install::new();
    install.record("game.item", "Game", GUID, &["Game.exe"]);
    let snapshot = install.read().unwrap();

    install.record("game.item", "Game", GUID, &["Game.exe", "Game/new.pak"]);

    assert!(snapshot.verify_unchanged().unwrap_err().contains("changed"));
}

/// Prints what Modrex reads from a real Epic installation, for contributors verifying a game.
/// Set MODREX_EPIC_GAME to the store display name and MODREX_EPIC_ROOT to the install folder.
#[test]
#[ignore]
fn inspect_installed_epic() {
    let name = std::env::var("MODREX_EPIC_GAME").expect("MODREX_EPIC_GAME");
    let root = std::env::var("MODREX_EPIC_ROOT").expect("MODREX_EPIC_ROOT");
    let snapshot = read_native_files(
        &super::super::epic::epic_manifest_dir(),
        &name,
        Path::new(&root),
    )
    .unwrap();
    println!("root {}", snapshot.game_root.display());
    for source in &snapshot.sources {
        println!("source {}", source.path.display());
    }
    println!("{} native paths", snapshot.native.paths.len());
    for path in snapshot
        .native
        .paths
        .iter()
        .filter(|path| path.contains("/paks/"))
    {
        println!("{path}");
    }
}

/// Writes an Epic installation record and its compressed manifest listing files.
pub(crate) fn write_test_install(
    manifest_dir: &Path,
    game_root: &Path,
    display_name: &str,
    files: &[&str],
) {
    fs::create_dir_all(manifest_dir).unwrap();
    fs::create_dir_all(game_root.join(".egstore")).unwrap();
    let record = serde_json::json!({
        "DisplayName": display_name,
        "InstallLocation": game_root.to_str().unwrap(),
        "InstallationGuid": GUID,
        "bIsIncompleteInstall": false,
        "bNeedsValidation": false,
    });
    fs::write(manifest_dir.join("game.item"), record.to_string()).unwrap();
    fs::write(
        game_root.join(".egstore").join(format!("{GUID}.manifest")),
        manifest(files),
    )
    .unwrap();
}
