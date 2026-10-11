use super::*;

const DEPOT: InstalledDepot = InstalledDepot {
    depot_id: 12,
    manifest_id: 34,
};

fn varint(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    while value >= 128 {
        bytes.push(value as u8 | 128);
        value >>= 7;
    }
    bytes.push(value as u8);
    bytes
}

fn integer(field: u32, value: u64) -> Vec<u8> {
    [varint(u64::from(field) << 3), varint(value)].concat()
}

fn message(field: u32, bytes: &[u8]) -> Vec<u8> {
    [
        varint((u64::from(field) << 3) | 2),
        varint(bytes.len() as u64),
        bytes.to_vec(),
    ]
    .concat()
}

fn mapping(name: &[u8], size: u64, flags: u32) -> Vec<u8> {
    [
        message(1, name),
        integer(2, size),
        integer(3, u64::from(flags)),
    ]
    .concat()
}

fn metadata(payload: &[u8], depot: &InstalledDepot, size: u64, encrypted: bool) -> Vec<u8> {
    [
        integer(1, u64::from(depot.depot_id)),
        integer(2, depot.manifest_id),
        integer(4, u64::from(encrypted)),
        integer(5, size),
        integer(9, u64::from(payload_crc(payload))),
    ]
    .concat()
}

fn section(magic: u32, bytes: &[u8]) -> Vec<u8> {
    [
        magic.to_le_bytes().to_vec(),
        (bytes.len() as u32).to_le_bytes().to_vec(),
        bytes.to_vec(),
    ]
    .concat()
}

fn manifest_parts(payload: &[u8], metadata: &[u8], signature: &[u8]) -> Vec<u8> {
    [
        section(PAYLOAD_MAGIC, payload),
        section(METADATA_MAGIC, metadata),
        section(SIGNATURE_MAGIC, signature),
        END_MAGIC.to_le_bytes().to_vec(),
    ]
    .concat()
}

fn manifest(paths: &[&str], depot: &InstalledDepot) -> Vec<u8> {
    let payload: Vec<u8> = paths
        .iter()
        .flat_map(|path| message(1, &mapping(path.as_bytes(), 0, 0)))
        .collect();
    manifest_parts(&payload, &metadata(&payload, depot, 0, false), &[])
}

fn appstate(app_id: u32, install_dir: &str, depots: &[InstalledDepot]) -> String {
    let installed: String = depots
        .iter()
        .map(|depot| {
            format!(
                "\"{}\" {{ \"manifest\" \"{}\" \"size\" \"0\" }}",
                depot.depot_id, depot.manifest_id
            )
        })
        .collect();
    format!(
        "\"AppState\" {{ \"appid\" \"{app_id}\" \"StateFlags\" \"4\" \
        \"installdir\" \"{install_dir}\" \"buildid\" \"56\" \
        \"TargetBuildID\" \"56\" \"UpdateResult\" \"0\" \
        \"InstalledDepots\" {{ {installed} }} }}"
    )
}

pub(crate) fn write_test_catalog(
    steam_root: &Path,
    game_root: &Path,
    app_id: u32,
    native_relative_paths: &[&str],
) -> Result<(), String> {
    fs::create_dir_all(game_root).map_err(|e| e.to_string())?;
    fs::create_dir_all(steam_root.join("depotcache")).map_err(|e| e.to_string())?;
    let install_dir = game_root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid fixture game root")?;
    let steamapps = game_root
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid fixture library")?;
    fs::write(
        steamapps.join(format!("appmanifest_{app_id}.acf")),
        appstate(app_id, install_dir, std::slice::from_ref(&DEPOT)),
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        steam_root.join("depotcache/12_34.manifest"),
        manifest(native_relative_paths, &DEPOT),
    )
    .map_err(|e| e.to_string())
}

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let steam = temp.path().join("primary-steam");
    let game = temp
        .path()
        .join("other-library/steamapps/common/Synthetic Game");
    super::write_test_catalog(
        &steam,
        &game,
        78,
        &["Content/Paks/base.pak", "Content/Paks/base.sig", "Game.exe"],
    )
    .unwrap();
    (temp, steam, game)
}

#[test]
fn complete_catalog_protects_missing_native_files_and_directory_prefixes() {
    let (_temp, steam, game) = fixture();
    let snapshot = read_native_files(&steam, &game, 78).unwrap();
    assert_eq!(snapshot.app_id, 78);
    assert_eq!(snapshot.build_id, 56);
    assert_eq!(snapshot.depots, vec![DEPOT]);
    assert!(!game.join("Content/Paks/base.pak").exists());
    assert!(snapshot
        .protects(Path::new("CONTENT\\PAKS\\BASE.PAK"))
        .unwrap());
    assert!(snapshot.protects_tree(Path::new("Content/Paks")).unwrap());
    assert!(snapshot
        .protects_tree(Path::new("Content/Paks/base.sig"))
        .unwrap());
    assert!(!snapshot.protects_tree(Path::new("Content/Pak")).unwrap());
    assert!(!snapshot
        .protects(Path::new("Content/Paks/manual-mod.pak"))
        .unwrap());
    assert!(snapshot.protects(Path::new("../base.pak")).is_err());
    snapshot.verify_unchanged().unwrap();
}

#[test]
fn installation_recognition_needs_appstate_identity_but_not_cached_depots() {
    let (temp, steam, game) = fixture();
    assert!(matches_installation(&game, 78).unwrap());
    fs::remove_file(steam.join("depotcache/12_34.manifest")).unwrap();
    assert!(matches_installation(&game, 78).unwrap());
    assert!(!matches_installation(&game, 79).unwrap());
    assert!(!matches_installation(&temp.path().join("missing"), 78).unwrap());
    assert!(!matches_installation(temp.path(), 78).unwrap());
    assert!(matches_installation(&game, 0).is_err());
    let acf = game
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("appmanifest_78.acf");
    let updating = appstate(78, "Synthetic Game", &[DEPOT])
        .replace("\"StateFlags\" \"4\"", "\"StateFlags\" \"1024\"");
    fs::write(&acf, updating).unwrap();
    assert!(matches_installation(&game, 78).unwrap());
    assert!(read_native_files(&steam, &game, 78).is_err());
    fs::create_dir_all(game.parent().unwrap().join("Other Game")).unwrap();
    fs::write(&acf, appstate(78, "Other Game", &[DEPOT])).unwrap();
    assert!(!matches_installation(&game, 78).unwrap());
    for invalid in [
        appstate(79, "Synthetic Game", &[DEPOT]),
        appstate(78, "../Other", &[DEPOT]),
        "\"AppState\" {".to_string(),
    ] {
        fs::write(&acf, invalid).unwrap();
        assert!(matches_installation(&game, 78).is_err());
    }
}

#[cfg(windows)]
#[test]
fn windows_ordinal_aliases_protect_native_files_and_missing_native_subtrees() {
    let (_temp, steam, game) = fixture();
    write_test_catalog(
        &steam,
        &game,
        78,
        &["Content/ΟΣ/base.pak", "Content/ΟΣ.pak"],
    )
    .unwrap();
    let snapshot = read_native_files(&steam, &game, 78).unwrap();
    assert!(snapshot.protects(Path::new("Content/οσ.pak")).unwrap());
    assert!(snapshot.protects(Path::new("Content/οσ/base.pak")).unwrap());
    assert!(snapshot.protects_tree(Path::new("content/οσ")).unwrap());
    assert!(!snapshot.protects(Path::new("Content/ος.pak")).unwrap());
    assert!(!snapshot.protects(Path::new("Content/個人.pak")).unwrap());
    for paths in [
        vec!["Content/ΟΣ", "Content/οσ"],
        vec!["Content/ΟΣ", "Content/οσ/child.pak"],
    ] {
        let error = parse_depot_manifest(&manifest(&paths, &DEPOT), &DEPOT).unwrap_err();
        assert!(error.contains("Windows ordinal"));
    }
}

#[test]
fn installed_depots_union_uses_primary_cache_and_requires_every_depot() {
    let (_temp, steam, game) = fixture();
    let other = InstalledDepot {
        depot_id: 90,
        manifest_id: 91,
    };
    let acf = game
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("appmanifest_78.acf");
    fs::write(
        &acf,
        appstate(78, "Synthetic Game", &[DEPOT.clone(), other.clone()]),
    )
    .unwrap();
    assert!(read_native_files(&steam, &game, 78)
        .unwrap_err()
        .contains("90_91.manifest"));
    fs::write(
        steam.join("depotcache/90_91.manifest"),
        manifest(&["DLC/extra.pak", "Game.exe"], &other),
    )
    .unwrap();
    let snapshot = read_native_files(&steam, &game, 78).unwrap();
    assert_eq!(snapshot.depots.len(), 2);
    assert_eq!(snapshot.native_paths.len(), 4);
    assert!(snapshot.protects(Path::new("DLC/extra.pak")).unwrap());
    fs::write(
        steam.join("depotcache/90_91.manifest"),
        manifest(&["game.exe"], &other),
    )
    .unwrap();
    assert!(read_native_files(&steam, &game, 78)
        .unwrap_err()
        .contains("case collision"));
}

#[test]
fn appstate_and_depot_changes_invalidate_snapshot() {
    let (_temp, steam, game) = fixture();
    let snapshot = read_native_files(&steam, &game, 78).unwrap();
    let acf = game
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("appmanifest_78.acf");
    fs::write(
        &acf,
        appstate(78, "Synthetic Game", std::slice::from_ref(&DEPOT)) + "\n",
    )
    .unwrap();
    assert!(snapshot.verify_unchanged().unwrap_err().contains("changed"));
    let snapshot = read_native_files(&steam, &game, 78).unwrap();
    fs::write(
        steam.join("depotcache/12_34.manifest"),
        manifest(&["new-native.pak"], &DEPOT),
    )
    .unwrap();
    assert!(snapshot.verify_unchanged().unwrap_err().contains("changed"));
    fs::remove_file(steam.join("depotcache/12_34.manifest")).unwrap();
    assert!(snapshot.verify_unchanged().is_err());
}

#[test]
fn wrong_root_empty_catalog_and_appstate_identity_are_errors() {
    let (_temp, steam, game) = fixture();
    assert!(read_native_files(&steam, &game, 79).is_err());
    let acf = game
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("appmanifest_78.acf");
    fs::create_dir_all(game.parent().unwrap().join("Other Game")).unwrap();
    fs::write(
        &acf,
        appstate(78, "Other Game", std::slice::from_ref(&DEPOT)),
    )
    .unwrap();
    assert!(read_native_files(&steam, &game, 78)
        .unwrap_err()
        .contains("does not match"));
    write_test_catalog(&steam, &game, 78, &[]).unwrap();
    assert!(read_native_files(&steam, &game, 78)
        .unwrap_err()
        .contains("contains no files"));
}

#[test]
fn unsafe_paths_and_case_collisions_are_rejected() {
    for path in [
        "",
        "../base.pak",
        "a/../b",
        "a/./b",
        "/absolute",
        "C:\\base.pak",
        "\\\\host\\file",
        "a:stream",
        "a//b",
        "a\\\\b",
        "a/",
        "a/space ",
        "a/trailing.",
        "CON.pak",
        "NUL .txt",
        "a/LPT1",
        "COM¹.txt",
        "nul/file",
        "a\0b",
        "a?b",
        "a*b",
        "a|b",
        "a\nb",
    ] {
        assert!(
            parse_depot_manifest(&manifest(&[path], &DEPOT), &DEPOT).is_err(),
            "accepted {path:?}"
        );
    }
    assert!(
        parse_depot_manifest(&manifest(&["A/Base.pak", "a/base.pak"], &DEPOT), &DEPOT).is_err()
    );
    assert!(parse_depot_manifest(&manifest(&["same", "same"], &DEPOT), &DEPOT).is_err());
    assert!(parse_depot_manifest(&manifest(&["file", "file/child"], &DEPOT), &DEPOT).is_err());
    assert!(normalize_native_path(&"x".repeat(MAX_PATH_BYTES + 1)).is_err());
}

#[test]
fn directory_records_are_validated_but_not_file_protection_entries() {
    let payload = [
        message(1, &mapping(b"Content", 0, DIRECTORY_FLAG)),
        message(1, &mapping(b"Content/base.pak", 7, 0)),
    ]
    .concat();
    let files = parse_depot_manifest(
        &manifest_parts(&payload, &metadata(&payload, &DEPOT, 7, false), &[]),
        &DEPOT,
    )
    .unwrap();
    assert_eq!(files.files.len(), 1);
    for (name, flags, size) in [
        (b"../dir".as_slice(), DIRECTORY_FLAG, 0),
        (b"dir".as_slice(), DIRECTORY_FLAG, 1),
        (b"linked".as_slice(), SYMLINK_FLAG, 0),
    ] {
        let payload = message(1, &mapping(name, size, flags));
        assert!(parse_depot_manifest(
            &manifest_parts(&payload, &metadata(&payload, &DEPOT, size, false), &[]),
            &DEPOT
        )
        .is_err());
    }
    let linked = [mapping(b"link", 0, 0), message(7, b"target")].concat();
    let payload = message(1, &linked);
    assert!(parse_depot_manifest(
        &manifest_parts(&payload, &metadata(&payload, &DEPOT, 0, false), &[]),
        &DEPOT
    )
    .is_err());
}

#[test]
fn appstate_requires_stable_build_complete_depots_and_unambiguous_keys() {
    let original = appstate(78, "Synthetic Game", &[DEPOT]);
    for text in [
        original.replace("\"StateFlags\" \"4\"", "\"StateFlags\" \"6\""),
        original.replace("\"StateFlags\" \"4\"", "\"StateFlags\" \"1024\""),
        original.replace("\"TargetBuildID\" \"56\"", "\"TargetBuildID\" \"57\""),
        original.replace("\"UpdateResult\" \"0\"", "\"UpdateResult\" \"1\""),
        original.replace("\"buildid\" \"56\"", "\"buildid\" \"0\""),
        original.replace("\"manifest\" \"34\"", "\"manifest\" \"0\""),
        original.replace(
            "\"manifest\" \"34\"",
            "\"manifest\" \"18446744073709551616\"",
        ),
        original.replace(
            "\"installdir\" \"Synthetic Game\"",
            "\"installdir\" \"../Other\"",
        ),
        original.replace("\"appid\" \"78\"", "\"appid\" \"78\" \"APPID\" \"78\""),
        original.clone() + "garbage",
        appstate(78, "Synthetic Game", &[]),
        "\"AppState\" { \"appid\" \"78\"".to_string(),
    ] {
        assert!(
            parse_appstate(text.as_bytes(), 78).is_err(),
            "accepted malformed AppState"
        );
    }
    assert!(parse_appstate(original.as_bytes(), 79).is_err());
    assert!(parse_appstate(&vec![b' '; MAX_APPSTATE_BYTES + 1], 78).is_err());
    let comments = "// comment\n".to_string() + &original + "\n// end";
    assert_eq!(
        parse_appstate(comments.as_bytes(), 78).unwrap().build_id,
        56
    );
}

#[test]
fn section_bounds_missing_sections_duplicates_and_eof_are_rejected() {
    let valid = manifest(&["base.pak"], &DEPOT);
    for cut in 0..valid.len() {
        assert!(
            parse_depot_manifest(&valid[..cut], &DEPOT).is_err(),
            "accepted truncation at {cut}"
        );
    }
    let mut trailing = valid.clone();
    trailing.push(0);
    assert!(parse_depot_manifest(&trailing, &DEPOT).is_err());
    let mut oversized = valid.clone();
    oversized[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(parse_depot_manifest(&oversized, &DEPOT).is_err());
    let mut bad_magic = valid.clone();
    bad_magic[..4].copy_from_slice(&0u32.to_le_bytes());
    assert!(parse_depot_manifest(&bad_magic, &DEPOT).is_err());
    let duplicate = [section(PAYLOAD_MAGIC, &[]), valid].concat();
    assert!(parse_depot_manifest(&duplicate, &DEPOT).is_err());
    let missing = [
        section(PAYLOAD_MAGIC, &[]),
        section(METADATA_MAGIC, &[]),
        END_MAGIC.to_le_bytes().to_vec(),
    ]
    .concat();
    assert!(parse_depot_manifest(&missing, &DEPOT).is_err());
}

#[test]
fn crc_identity_encryption_size_and_scalar_wire_types_are_checked() {
    let payload = message(1, &mapping(b"base.pak", 7, 0));
    let valid_meta = metadata(&payload, &DEPOT, 7, false);
    let mut corrupt = payload.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    assert!(
        parse_depot_manifest(&manifest_parts(&corrupt, &valid_meta, &[]), &DEPOT)
            .unwrap_err()
            .contains("CRC")
    );
    let wrong = InstalledDepot {
        depot_id: 13,
        manifest_id: 35,
    };
    assert!(parse_depot_manifest(&manifest_parts(&payload, &valid_meta, &[]), &wrong).is_err());
    for meta in [
        metadata(&payload, &DEPOT, 7, true),
        metadata(&payload, &DEPOT, 8, false),
        [valid_meta.clone(), integer(1, 12)].concat(),
        [integer(1, 12), integer(2, 34), integer(5, 7)].concat(),
        [valid_meta.clone(), integer(3, u64::MAX)].concat(),
        [message(1, b"12"), integer(2, 34)].concat(),
    ] {
        assert!(parse_depot_manifest(&manifest_parts(&payload, &meta, &[]), &DEPOT).is_err());
    }
}

#[test]
fn malformed_protobuf_and_wrong_mapping_wire_types_are_rejected() {
    for payload in [
        vec![0],
        vec![8, 0],
        vec![10, 255],
        vec![15],
        vec![10, 1, 0],
        vec![10, 1, 8],
        [vec![10], vec![255; 9], vec![2]].concat(),
        message(1, &mapping(&[255], 0, 0)),
        message(
            1,
            &[mapping(b"base", 0, 0), message(1, b"duplicate")].concat(),
        ),
        message(
            1,
            &[mapping(b"base", 0, 0), message(4, b"short hash")].concat(),
        ),
        message(1, &integer(1, 7)),
    ] {
        let bytes = manifest_parts(&payload, &metadata(&payload, &DEPOT, 0, false), &[]);
        assert!(
            parse_depot_manifest(&bytes, &DEPOT).is_err(),
            "accepted malformed protobuf {payload:?}"
        );
    }
    let fixed64_crc = [varint((2 << 3) | 1), vec![0; 8]].concat();
    assert!(validate_chunk(&fixed64_crc).is_err());
    assert!(validate_chunk(&[message(1, &[0; 20]), message(1, &[0; 20])].concat()).is_err());
    let signature = [message(1, b"sig"), message(1, b"sig")].concat();
    assert!(validate_signature(&signature).is_err());
}

#[test]
fn crc32_matches_independent_standard_vector() {
    let payload = b"abc";
    // Python zlib.crc32 over the four-byte little-endian length and abc.
    assert_eq!(payload_crc(payload), 0x66e15d33);
}

#[test]
#[ignore = "Reads an explicitly supplied local Steam install without changing it"]
fn inspect_installed_catalog_read_only() {
    let steam = std::env::var_os("MODREX_TEST_STEAM_ROOT").expect("Set MODREX_TEST_STEAM_ROOT");
    let game = std::env::var_os("MODREX_TEST_GAME_ROOT").expect("Set MODREX_TEST_GAME_ROOT");
    let app = std::env::var("MODREX_TEST_STEAM_APP_ID")
        .expect("Set MODREX_TEST_STEAM_APP_ID")
        .parse()
        .unwrap();
    let snapshot = read_native_files(Path::new(&steam), Path::new(&game), app).unwrap();
    assert!(!snapshot.native_paths.is_empty());
    snapshot.verify_unchanged().unwrap();
    println!(
        "Validated app {} build {}, {} depots and {} protected native files",
        snapshot.app_id,
        snapshot.build_id,
        snapshot.depots.len(),
        snapshot.native_paths.len()
    );
}
