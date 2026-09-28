use super::*;
use tempfile::TempDir;

const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn write_pak(path: &Path, entries: &[&str]) {
    let file = File::create(path).unwrap();
    let mut writer =
        repak::PakBuilder::new().writer(file, repak::Version::V11, "../../../".into(), None);
    for entry in entries {
        writer.write_file(entry, false, b"asset").unwrap();
    }
    writer.write_index().unwrap();
}

#[test]
fn a_stub_without_its_container_says_what_is_missing() {
    let tmp = TempDir::new().unwrap();
    let pak = tmp.path().join("048_Judge_P.pak");
    write_pak(&pak, &[]);

    let err = list_unreal_assets(&pak, "pak", KEY).unwrap_err();

    assert!(err.contains(".ucas and .utoc"), "{err}");
}

#[test]
fn a_pak_with_its_own_assets_lists_them() {
    let tmp = TempDir::new().unwrap();
    let pak = tmp.path().join("005_Sounds.pak");
    write_pak(&pak, &["PAYDAY3/Content/Sounds/Hit.uasset"]);

    let assets = list_unreal_assets(&pak, "pak", KEY).unwrap();

    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].path, "PAYDAY3/Content/Sounds/Hit.uasset");
}
