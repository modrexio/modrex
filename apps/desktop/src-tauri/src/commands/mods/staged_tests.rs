//! The producer-to-consumer contract: every resolver-success shape describes what it staged,
//! and the artifact it names is the one it actually created.

use super::cleanup::CleanupPlan;
use super::engine::{engine_for_game, ModEngineConfig};
use super::staged::{NameSource, Staged};
use super::staging_tokens::StagingRegistry;
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
    let staged = resolve_archive_download(
        zip.path().to_path_buf(),
        cfg("pd3"),
        &StagingRegistry::new(),
    )
    .unwrap();

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
    let staged = resolve_archive_download(
        zip.path().to_path_buf(),
        cfg("pd2"),
        &StagingRegistry::new(),
    )
    .unwrap();

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
    let staged =
        resolve_archive_download(zip.path().to_path_buf(), cfg("cb"), &StagingRegistry::new())
            .unwrap();

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
    let staged =
        resolve_archive_download(zip.path().to_path_buf(), cfg("cb"), &StagingRegistry::new())
            .unwrap();

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
        let staged =
            resolve_archive_download(downloaded.clone(), cfg(game), &StagingRegistry::new())
                .unwrap();

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
    let staged = resolve_archive_download(downloaded, cfg("cb"), &StagingRegistry::new()).unwrap();
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

    let staged =
        resolve_archive_download(copy.clone(), cfg("pd2"), &StagingRegistry::new()).unwrap();
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

// ── archive entries are identified by position, not by name ─────────────────

use super::staging_tokens::{ArchiveEntryId, StagedArchiveKind, StagedEntry, StagedEntrySource};

/// Writes entries under their exact raw names, including names a normalizing reader would
/// fold together.
fn make_raw_zip(entries: &[(&str, &[u8])]) -> NamedTempFile {
    make_zip(entries)
}

fn file_entry(index: u32, name: &str) -> StagedEntry {
    StagedEntry {
        source: StagedEntrySource::File { index },
        display_name: name.to_string(),
    }
}

fn extract_at(zip: &Path, index: u32) -> Vec<u8> {
    let dest = TempDir::new().unwrap().path().join("out.bin");
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    super::zip::extract_entry_at(zip, index, &dest).unwrap();
    std::fs::read(&dest).unwrap()
}

/// The collision this identity model exists for: two raw names that a normalizing reader
/// reports identically still extract their own bytes.
#[test]
fn separator_colliding_entries_extract_their_own_bytes() {
    let zip = make_raw_zip(&[
        ("a/b.pak", b"forward slash bytes"),
        ("a\\b.pak", b"back slash bytes"),
    ]);
    let listed = super::zip::list_entries_for_test(zip.path());
    assert_eq!(listed.len(), 2, "both raw entries are listed");
    assert_eq!(
        listed[0], listed[1],
        "and they display under the same normalized name"
    );

    assert_eq!(extract_at(zip.path(), 0), b"forward slash bytes");
    assert_eq!(extract_at(zip.path(), 1), b"back slash bytes");
}

#[test]
fn case_only_collisions_extract_their_own_bytes() {
    let zip = make_raw_zip(&[("A.pak", b"upper"), ("a.pak", b"lower")]);
    assert_eq!(extract_at(zip.path(), 0), b"upper");
    assert_eq!(extract_at(zip.path(), 1), b"lower");
}

#[test]
fn trailing_space_and_dot_collisions_extract_their_own_bytes() {
    let zip = make_raw_zip(&[("Mod.pak", b"plain"), ("Mod.pak ", b"trailing space")]);
    assert_eq!(extract_at(zip.path(), 0), b"plain");
    assert_eq!(extract_at(zip.path(), 1), b"trailing space");
}

/// A directory entry and a file entry whose names normalize together stay distinguishable,
/// and asking for the wrong shape is refused rather than silently reinterpreted.
#[test]
fn a_directory_and_file_with_colliding_names_stay_distinct() {
    let zip = make_raw_zip(&[("mod/", b""), ("mod", b"file bytes")]);
    let dest = TempDir::new().unwrap();
    let out = dest.path().join("out.bin");
    assert!(
        super::zip::extract_entry_at(zip.path(), 0, &out).is_err(),
        "a directory entry is not extractable as a file"
    );
    assert_eq!(extract_at(zip.path(), 1), b"file bytes");
}

#[test]
fn an_out_of_range_identity_fails_without_extracting_anything() {
    let zip = make_raw_zip(&[("Mod.pak", b"only")]);
    let dest = TempDir::new().unwrap().path().join("out.bin");
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    for index in [1u32, 9, u32::MAX] {
        assert!(super::zip::extract_entry_at(zip.path(), index, &dest).is_err());
    }
    assert!(!dest.exists());
}

/// An identity is only meaningful against the handle that issued it.
#[test]
fn an_identity_is_scoped_to_the_archive_that_issued_it() {
    let reg = StagingRegistry::new();
    let dir = TempDir::new().unwrap();
    let a = dir.path().join("modrex-a.zip");
    let b = dir.path().join("modrex-b.zip");
    std::fs::write(&a, b"a").unwrap();
    std::fs::write(&b, b"b").unwrap();

    let handle_a = reg
        .register(
            StagedArchiveKind::MultiEntry,
            &a,
            CleanupPlan::RemoveOwnedFile(a.clone()),
            vec![file_entry(0, "OnlyInA.pak")],
        )
        .unwrap();
    let handle_b = reg
        .register(
            StagedArchiveKind::MultiEntry,
            &b,
            CleanupPlan::RemoveOwnedFile(b.clone()),
            Vec::new(),
        )
        .unwrap();

    assert!(reg
        .entry(&handle_a, StagedArchiveKind::MultiEntry, ArchiveEntryId(0))
        .is_some());
    assert!(
        reg.entry(&handle_b, StagedArchiveKind::MultiEntry, ArchiveEntryId(0))
            .is_none(),
        "an id valid for one archive means nothing for another"
    );
}

/// Only the entries the listing issued are reachable, so an index that was filtered out of
/// the listing cannot be reached by guessing it.
#[test]
fn an_identity_the_listing_never_issued_is_rejected() {
    let reg = StagingRegistry::new();
    let dir = TempDir::new().unwrap();
    let archive = dir.path().join("modrex-filtered.zip");
    std::fs::write(&archive, b"zip").unwrap();

    // The archive holds a readme at position 1, but only the pak was offered.
    let handle = reg
        .register(
            StagedArchiveKind::MultiEntry,
            &archive,
            CleanupPlan::RemoveOwnedFile(archive.clone()),
            vec![file_entry(0, "Mod.pak")],
        )
        .unwrap();

    assert!(reg
        .entry(&handle, StagedArchiveKind::MultiEntry, ArchiveEntryId(0))
        .is_some());
    for guess in [1u32, 2, 99] {
        assert!(
            reg.entry(
                &handle,
                StagedArchiveKind::MultiEntry,
                ArchiveEntryId(guess)
            )
            .is_none(),
            "id {guess} was never issued"
        );
    }
}

#[test]
fn an_identity_is_rejected_by_a_workflow_it_was_not_issued_for() {
    let reg = StagingRegistry::new();
    let dir = TempDir::new().unwrap();
    let archive = dir.path().join("modrex-kinded.zip");
    std::fs::write(&archive, b"zip").unwrap();
    let handle = reg
        .register(
            StagedArchiveKind::MultiEntry,
            &archive,
            CleanupPlan::RemoveOwnedFile(archive.clone()),
            vec![file_entry(0, "Mod.pak")],
        )
        .unwrap();

    assert!(reg
        .entry(&handle, StagedArchiveKind::HostPack, ArchiveEntryId(0))
        .is_none());
    assert!(reg
        .entry(&handle, StagedArchiveKind::CrimeBossFlat, ArchiveEntryId(0))
        .is_none());
}

/// An archive replaced after listing fails closed rather than extracting whatever now sits
/// at that position.
#[test]
fn a_truncated_archive_fails_closed() {
    let dir = TempDir::new().unwrap();
    let archive = dir.path().join("modrex-changed.zip");
    let built = make_raw_zip(&[("One.pak", b"one"), ("Two.pak", b"two")]);
    std::fs::copy(built.path(), &archive).unwrap();
    assert_eq!(extract_at(&archive, 1), b"two");

    std::fs::write(&archive, b"not an archive any more").unwrap();
    let dest = dir.path().join("out.bin");
    assert!(super::zip::extract_entry_at(&archive, 1, &dest).is_err());
    assert!(!dest.exists());
}

/// Sidecars are found beside the entry the identity names, not beside a same-named entry
/// somewhere else in the archive.
#[test]
fn sidecars_follow_the_identified_entry() {
    let zip = make_raw_zip(&[
        ("Right/Mod.pak", b"right pak"),
        ("Right/Mod.ucas", b"right ucas"),
        ("Wrong/Mod.pak", b"wrong pak"),
        ("Wrong/Mod.ucas", b"wrong ucas"),
    ]);
    let dest = TempDir::new().unwrap().path().join("out.pak");
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    super::zip::extract_staged_entry_with_sidecars(
        zip.path(),
        &file_entry(0, "Right/Mod.pak"),
        &dest,
    )
    .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"right pak");
    assert_eq!(
        std::fs::read(dest.with_extension("ucas")).unwrap(),
        b"right ucas"
    );
}
