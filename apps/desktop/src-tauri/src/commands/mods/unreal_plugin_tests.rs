use super::*;
use std::fs;
use tempfile::TempDir;

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| n.to_string()).collect()
}

fn plugin(root: &str, name: &str) -> ArchivePlugin {
    ArchivePlugin {
        root: root.to_string(),
        name: name.to_string(),
    }
}

// The listings below are the shapes surveyed on modworkshop: CrimeFactory's own zip, an
// author's re-zip with a wrapper, a wrapper named unlike the plugin, and a source upload.

#[test]
fn a_forged_zip_holds_its_plugin_at_the_root() {
    let found = plugins_in_archive(&names(&[
        "MikuQueensRevenge.uplugin",
        "Resources/Icon128.png",
        "Content/Paks/Windows/MikuQueensRevenge_P.pak",
        "Content/Paks/Windows/MikuQueensRevenge_P.ucas",
        "Content/Paks/Windows/MikuQueensRevenge_P.utoc",
        "Content/Paks/WinGDK/MikuQueensRevenge_P.pak",
    ]));
    assert_eq!(
        found,
        ArchivePlugins::Packaged(vec![plugin("", "MikuQueensRevenge")])
    );
}

#[test]
fn a_wrapped_plugin_is_named_after_its_descriptor() {
    let found = plugins_in_archive(&names(&[
        "Miscellaneous Text fixes/",
        "Miscellaneous Text fixes/MiscellanousTextFixes.uplugin",
        "Miscellaneous Text fixes/Content/Paks/Windows/MiscellanousTextFixes_P.utoc",
        "readme.txt",
    ]));
    assert_eq!(
        found,
        ArchivePlugins::Packaged(vec![plugin(
            "Miscellaneous Text fixes",
            "MiscellanousTextFixes"
        )])
    );
}

#[test]
fn a_source_project_upload_is_not_installable() {
    let found = plugins_in_archive(&names(&[
        "Armor_Timer/Armor_Timer.uplugin",
        "Armor_Timer/Config/PluginSettings.ini",
        "Armor_Timer/Content/BP_Armor_Timer.uasset",
        "Armor_Timer/Saved/Cooked/Windows/PAYDAY3/Mods/Armor_Timer/Content/BP_Armor_Timer.uexp",
    ]));
    assert_eq!(found, ArchivePlugins::SourceOnly);
}

#[test]
fn a_descriptor_inside_another_plugin_is_not_a_plugin_of_its_own() {
    let found = plugins_in_archive(&names(&[
        "Outer/Outer.uplugin",
        "Outer/Content/Paks/Windows/Outer_P.pak",
        "Outer/Extras/Inner/Inner.uplugin",
        "Outer/Extras/Inner/Content/Paks/Windows/Inner_P.pak",
    ]));
    assert_eq!(
        found,
        ArchivePlugins::Packaged(vec![plugin("Outer", "Outer")])
    );
}

#[test]
fn an_archive_of_variants_lists_each_plugin() {
    let found = plugins_in_archive(&names(&[
        "Variant A/Foo/Foo.uplugin",
        "Variant A/Foo/Content/Paks/Windows/Foo_P.pak",
        "Variant B/Foo/Foo.uplugin",
        "Variant B/Foo/Content/Paks/Windows/Foo_P.pak",
    ]));
    assert_eq!(
        found,
        ArchivePlugins::Packaged(vec![
            plugin("Variant A/Foo", "Foo"),
            plugin("Variant B/Foo", "Foo")
        ])
    );
}

#[test]
fn loose_paks_hold_no_plugin() {
    let found = plugins_in_archive(&names(&["~mods/", "~mods/Thing_P.pak", "Thing_P.utoc"]));
    assert_eq!(found, ArchivePlugins::None);
}

#[test]
fn only_a_lowercase_descriptor_suffix_is_a_plugin() {
    let found = plugins_in_archive(&names(&[
        "Shout.uplugin",
        "content/paks/windows/Shout_P.PAK",
    ]));
    assert_eq!(found, ArchivePlugins::Packaged(vec![plugin("", "Shout")]));
    let ignored = plugins_in_archive(&names(&[
        "Shout.UPLUGIN",
        "Content/Paks/Windows/Shout_P.pak",
    ]));
    assert_eq!(ignored, ArchivePlugins::None);
}

fn write(path: &std::path::Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn a_plugin_is_found_where_unreal_finds_it() {
    let mods = TempDir::new().unwrap();
    assert!(!plugin_installed(mods.path(), "PDML"));
    write(&mods.path().join("Folder/PDML/PDML.uplugin"), b"{}");
    assert!(plugin_installed(mods.path(), "PDML"));
    assert!(plugin_installed(mods.path(), "pdml"));
}

#[test]
fn a_plugin_nested_inside_another_plugin_is_not_loaded() {
    let mods = TempDir::new().unwrap();
    write(&mods.path().join("Other/Other.uplugin"), b"{}");
    write(&mods.path().join("Other/Bundled/PDML/PDML.uplugin"), b"{}");
    assert!(!plugin_installed(mods.path(), "PDML"));
}

#[test]
fn identification_hashes_the_desktop_utoc_before_any_pak() {
    let dir = TempDir::new().unwrap();
    write(&dir.path().join("Content/Paks/WinGDK/Mod_P.utoc"), b"gdk");
    write(&dir.path().join("Content/Paks/Windows/Mod_P.pak"), b"pak");
    write(&dir.path().join("Content/Paks/Windows/Mod_P.utoc"), b"toc");
    assert_eq!(
        identifying_container(dir.path()),
        Some(dir.path().join("Content/Paks/Windows/Mod_P.utoc"))
    );
    fs::remove_file(dir.path().join("Content/Paks/Windows/Mod_P.utoc")).unwrap();
    fs::remove_file(dir.path().join("Content/Paks/WinGDK/Mod_P.utoc")).unwrap();
    assert_eq!(
        identifying_container(dir.path()),
        Some(dir.path().join("Content/Paks/Windows/Mod_P.pak"))
    );
}

#[test]
fn a_descriptor_whose_name_would_escape_its_folder_is_not_a_plugin() {
    let found = plugins_in_archive(&names(&["...uplugin", "Content/Paks/Windows/Test.pak"]));
    assert_eq!(found, ArchivePlugins::None);
}

/// Unreal mounts containers from Content/Paks/<platform>, so one loose in Paks itself is not a
/// packaged plugin.
#[test]
fn containers_must_sit_in_a_platform_folder() {
    let flat = plugins_in_archive(&names(&["Foo.uplugin", "Content/Paks/Foo_P.pak"]));
    assert_eq!(flat, ArchivePlugins::SourceOnly);
    let deep = plugins_in_archive(&names(&[
        "Foo.uplugin",
        "Content/Paks/Windows/Sub/Foo_P.pak",
    ]));
    assert_eq!(deep, ArchivePlugins::Packaged(vec![plugin("", "Foo")]));
}

#[test]
fn installed_containers_are_found_at_any_depth_and_any_case() {
    let dir = TempDir::new().unwrap();
    write(
        &dir.path().join("content/paks/windows/Sub/Mod_P.utoc"),
        b"toc",
    );
    assert_eq!(
        identifying_container(dir.path()),
        Some(dir.path().join("content/paks/windows/Sub/Mod_P.utoc"))
    );
}
