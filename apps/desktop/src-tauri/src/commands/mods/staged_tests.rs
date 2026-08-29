//! The producer-to-consumer contract: every resolver-success shape describes what it staged,
//! and the artifact it names is the one it actually created.

use super::cleanup::CleanupPlan;
use super::engine::{engine_for_game, ModEngineConfig};
use super::staged::{NameSource, Staged};
use super::zip::resolve_archive_download;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::{NamedTempFile, TempDir};

fn make_zip(entries: &[(&str, &[u8])]) -> NamedTempFile {
    let f = NamedTempFile::new().unwrap();
    let mut zip = ::zip::ZipWriter::new(File::create(f.path()).unwrap());
    let opts = ::zip::write::SimpleFileOptions::default();
    for (name, data) in entries {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap();
    f
}

fn cfg(game: &str) -> &'static ModEngineConfig {
    engine_for_game(game).unwrap()
}

/// A loose file that no archive sniffer recognizes, staged the way download_file and
/// install_dropped_file stage theirs: directly in the temp root.
fn loose_file(dir: &TempDir, name: &str) -> PathBuf {
    let p = dir.path().join(name);
    std::fs::write(&p, b"not an archive").unwrap();
    p
}

fn named(plan: &CleanupPlan) -> &Path {
    match plan {
        CleanupPlan::RemoveOwnedDirectory(p)
        | CleanupPlan::RemoveOwnedFileWithSidecars(p)
        | CleanupPlan::RemoveOwnedFile(p) => p,
    }
}

// ── every shape produces a complete, self-consistent Staged ─────────────────

/// The artifact a plan names must be the one staging actually created, so it has to exist on
/// disk the moment the resolver returns.
fn assert_owns_a_real_artifact(staged: &Staged) {
    let target = named(&staged.cleanup);
    assert!(
        target.exists(),
        "plan names {target:?}, which staging did not create"
    );
    match &staged.cleanup {
        CleanupPlan::RemoveOwnedDirectory(p) => assert!(p.is_dir(), "{p:?} is not a directory"),
        CleanupPlan::RemoveOwnedFileWithSidecars(p) | CleanupPlan::RemoveOwnedFile(p) => {
            assert!(p.is_file(), "{p:?} is not a file")
        }
    }
}

/// No shape may name the temp root or anything above it.
fn assert_never_names_a_protected_root(staged: &Staged) {
    let target = named(&staged.cleanup).canonicalize().unwrap();
    let temp = std::env::temp_dir().canonicalize().unwrap();
    assert_ne!(target, temp, "plan named the OS temp root");
    assert!(
        target.starts_with(&temp),
        "plan named {target:?}, outside the staging boundary"
    );
    assert!(
        !temp.starts_with(&target),
        "plan named an ancestor of the OS temp root"
    );
}

#[test]
fn a_single_pak_archive_stages_a_file_for_a_file_unit_game() {
    let zip = make_zip(&[("CoolMod_P.pak", b"pak")]);
    let staged = resolve_archive_download(zip.path().to_path_buf(), cfg("pd3")).unwrap();

    assert_eq!(staged.name_source, NameSource::FromModDisplayName);
    assert_eq!(staged.target_tag, None);
    assert_eq!(staged.original_archive.as_deref(), Some(zip.path()));
    assert_eq!(
        staged.cleanup,
        CleanupPlan::RemoveOwnedFileWithSidecars(staged.root.clone())
    );
    assert_owns_a_real_artifact(&staged);
    assert_never_names_a_protected_root(&staged);
}

#[test]
fn a_mod_directory_archive_stages_its_own_two_level_parent() {
    let zip = make_zip(&[("Welrod/mod.txt", b"{}")]);
    let staged = resolve_archive_download(zip.path().to_path_buf(), cfg("pd2")).unwrap();

    // The root keeps the archive's own directory name, which is what makes it usable as the
    // mod's name; the plan owns the uuid parent that wraps it.
    assert_eq!(staged.root.file_name().unwrap(), "Welrod");
    assert_eq!(staged.name_source, NameSource::FromArchive);
    assert_eq!(
        staged.cleanup,
        CleanupPlan::RemoveOwnedDirectory(staged.root.parent().unwrap().to_path_buf())
    );
    assert_eq!(staged.original_archive.as_deref(), Some(zip.path()));
    assert_owns_a_real_artifact(&staged);
    assert_never_names_a_protected_root(&staged);
}

#[test]
fn a_standalone_ue4ss_submod_stages_under_its_own_parent_and_keeps_its_tag() {
    let zip = make_zip(&[("CoolMod/Scripts/main.lua", b"-- sub-mod")]);
    let staged = resolve_archive_download(zip.path().to_path_buf(), cfg("cb")).unwrap();

    assert_eq!(staged.target_tag.as_deref(), Some("ue4ss_mods"));
    assert_eq!(staged.root.file_name().unwrap(), "CoolMod");
    assert_eq!(staged.name_source, NameSource::FromArchive);
    assert_eq!(
        staged.cleanup,
        CleanupPlan::RemoveOwnedDirectory(staged.root.parent().unwrap().to_path_buf())
    );
    assert_owns_a_real_artifact(&staged);
}

#[test]
fn the_crime_boss_skeleton_owns_its_synthesized_root() {
    let zip = make_zip(&[("SomeModCrimeBoss-WindowsNoEditor.pak", b"pak")]);
    let staged = resolve_archive_download(zip.path().to_path_buf(), cfg("cb")).unwrap();

    // The skeleton root has no readable name of its own, so naming falls to the archive entry.
    assert_eq!(staged.name_source, NameSource::FromModDisplayName);
    assert_eq!(staged.target_tag, None);
    assert_eq!(
        staged.cleanup,
        CleanupPlan::RemoveOwnedDirectory(staged.root.clone())
    );
    assert!(staged
        .root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("modrex-cb-mod-"));
    assert_owns_a_real_artifact(&staged);
    assert_never_names_a_protected_root(&staged);
}

/// The shape that used to resolve its cleanup to the OS temp root for every directory-primary
/// game. It now owns exactly the file the caller downloaded or copied.
#[test]
fn a_loose_non_archive_owns_exactly_the_downloaded_file() {
    for (game, expected_name) in [
        ("pd2", NameSource::FromArchive),
        ("pdth", NameSource::FromArchive),
        ("raid", NameSource::FromArchive),
        ("pd3", NameSource::FromModDisplayName),
        ("cb", NameSource::FromModDisplayName),
    ] {
        let dir = TempDir::new().unwrap();
        let downloaded = loose_file(&dir, "modrex-abc.lua");
        let staged = resolve_archive_download(downloaded.clone(), cfg(game)).unwrap();

        assert_eq!(staged.root, downloaded, "{game}");
        assert_eq!(
            staged.cleanup,
            CleanupPlan::RemoveOwnedFileWithSidecars(downloaded.clone()),
            "{game} must own exactly the downloaded file"
        );
        assert_eq!(staged.name_source, expected_name, "{game}");
        assert_eq!(staged.original_archive, None, "{game}");
        assert_owns_a_real_artifact(&staged);
    }
}

/// Crime Boss routes a bare pak to its legacy file target rather than the primary one.
#[test]
fn a_loose_file_on_crime_boss_keeps_the_legacy_paks_tag() {
    let dir = TempDir::new().unwrap();
    let downloaded = loose_file(&dir, "modrex-abc.pak");
    let staged = resolve_archive_download(downloaded, cfg("cb")).unwrap();
    assert_eq!(staged.target_tag.as_deref(), Some("paks"));
}

/// A dropped file is copied into Modrex-owned staging before it reaches the resolver, so the
/// plan can only ever name the copy.
#[test]
fn a_dropped_copy_is_owned_and_the_users_original_is_not() {
    let user_dir = TempDir::new().unwrap();
    let users_file = user_dir.path().join("MyMod.lua");
    std::fs::write(&users_file, b"mine").unwrap();

    let staging = TempDir::new().unwrap();
    let copy = staging.path().join("modrex-drop-abc.lua");
    std::fs::copy(&users_file, &copy).unwrap();

    let staged = resolve_archive_download(copy.clone(), cfg("pd2")).unwrap();
    assert_eq!(
        staged.cleanup,
        CleanupPlan::RemoveOwnedFileWithSidecars(copy)
    );
    assert_ne!(named(&staged.cleanup), users_file);
    assert!(users_file.exists());
}

// ── the consumer reads the staged fact rather than re-deriving it ───────────

/// Same expectations as the pre-Phase-4 tests, now driven by name_source instead of the
/// destination unit and a Crime Boss boolean.
#[test]
fn stem_recovery_follows_the_staged_name_source() {
    let zip = make_zip(&[("abkarino_RinoHud_P.pak", b"pak")]);

    // A synthesized root sends naming back to the archive's single pak entry.
    assert_eq!(
        super::recover_dropped_mod_stem(
            NameSource::FromModDisplayName,
            Path::new("irrelevant-for-this-branch"),
            Some(zip.path()),
            "download-manager name",
        ),
        "abkarino_RinoHud_P"
    );

    // A root that came out of the archive already carries the name.
    assert_eq!(
        super::recover_dropped_mod_stem(
            NameSource::FromArchive,
            Path::new("/tmp/modrex-mod-abc123/Welrod"),
            None,
            "fallback should not be used",
        ),
        "Welrod"
    );
}

#[test]
fn stem_recovery_falls_back_when_the_archive_cannot_name_the_mod() {
    let two = make_zip(&[("A.pak", b"a"), ("B.pak", b"b")]);
    for orig in [None, Some(two.path())] {
        assert_eq!(
            super::recover_dropped_mod_stem(
                NameSource::FromModDisplayName,
                Path::new("irrelevant-for-this-branch"),
                orig,
                "Foo",
            ),
            "Foo"
        );
    }
}
