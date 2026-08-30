//! Every test here works inside its own TempDir standing in for the OS temp root, so a
//! regression can never reach the real one. Each fixture plants a sentinel sibling beside the
//! staged artifact; the sentinel surviving is what proves cleanup stayed inside its boundary.

use super::cleanup::*;
use super::engine::engine_for_game;
use super::staging_tokens::StagingRegistry;
use super::zip::resolve_archive_download;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

/// A synthetic temp root holding a sentinel file and a sentinel directory, both siblings of
/// whatever the test stages.
struct Fixture {
    root: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let root = TempDir::new().expect("temp root");
        fs::write(root.path().join("sentinel.txt"), b"keep me").expect("sentinel file");
        fs::create_dir_all(root.path().join("sentinel-dir")).expect("sentinel dir");
        fs::write(root.path().join("sentinel-dir").join("inner.txt"), b"keep").expect("inner");
        Self { root }
    }

    fn path(&self) -> &Path {
        self.root.path()
    }

    fn staged_dir(&self, name: &str) -> PathBuf {
        let d = self.root.path().join(name);
        fs::create_dir_all(d.join("nested")).expect("staged dir");
        fs::write(d.join("nested").join("payload.bin"), b"x").expect("payload");
        d
    }

    fn staged_file(&self, name: &str) -> PathBuf {
        let f = self.root.path().join(name);
        fs::write(&f, b"x").expect("staged file");
        f
    }

    fn sentinels_survive(&self) {
        assert!(
            self.root.path().join("sentinel.txt").exists(),
            "sentinel file was deleted"
        );
        assert!(
            self.root
                .path()
                .join("sentinel-dir")
                .join("inner.txt")
                .exists(),
            "sentinel directory was deleted"
        );
        assert!(
            self.root.path().exists(),
            "the temp root itself was deleted"
        );
    }
}

fn run_plan(root: &Path, plan: &CleanupPlan) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(run_in(root, plan));
}

// ── the artifact each staging shape owns ────────────────────────────────────

/// The .pdmod shape: a staging directory sitting directly in the temp root. Deriving the
/// recursive target from its parent is what selected the temp root itself.
#[test]
fn pdmod_staging_removes_only_its_own_directory() {
    let fx = Fixture::new();
    let staged = fx.staged_dir("modrex-pdmod-abc");
    run_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedDirectory(staged.clone()),
    );
    assert!(!staged.exists(), "staging directory should be gone");
    fx.sentinels_survive();
}

/// A downloaded or dropped loose file also sits directly in the temp root.
#[test]
fn loose_staged_file_removes_only_that_file() {
    for name in ["modrex-abc.lua", "modrex-drop-abc.lua"] {
        let fx = Fixture::new();
        let staged = fx.staged_file(name);
        run_plan(
            fx.path(),
            &CleanupPlan::RemoveOwnedFileWithSidecars(staged.clone()),
        );
        assert!(!staged.exists(), "{name} should be gone");
        fx.sentinels_survive();
    }
}

#[test]
fn file_cleanup_takes_known_sidecars_and_nothing_else() {
    let fx = Fixture::new();
    let staged = fx.staged_file("modrex-mod-abc.pak");
    let ucas = fx.staged_file("modrex-mod-abc.ucas");
    let utoc = fx.staged_file("modrex-mod-abc.utoc");
    let unrelated = fx.staged_file("modrex-mod-abc.txt");
    run_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedFileWithSidecars(staged.clone()),
    );
    assert!(!staged.exists() && !ucas.exists() && !utoc.exists());
    assert!(unrelated.exists(), "unknown extension must be left alone");
    fx.sentinels_survive();
}

#[test]
fn two_level_staging_removes_only_its_unique_directory() {
    let fx = Fixture::new();
    let parent = fx.staged_dir("modrex-mod-abc");
    let inner = parent.join("MyMod");
    fs::create_dir_all(&inner).expect("inner");
    run_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedDirectory(parent.clone()),
    );
    assert!(!parent.exists());
    fx.sentinels_survive();
}

// ── protected roots ─────────────────────────────────────────────────────────

/// The regression that fails against f304444: there, the .pdmod and loose-file shapes
/// resolved their recursive target to the temp root itself.
#[test]
fn the_temp_root_is_rejected() {
    let fx = Fixture::new();
    assert_eq!(
        owned_staging_dir(fx.path(), fx.path()),
        Err(Refusal::IsTempRoot)
    );
    run_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedDirectory(fx.path().to_path_buf()),
    );
    fx.sentinels_survive();
}

#[test]
fn an_ancestor_of_the_temp_root_is_rejected() {
    let fx = Fixture::new();
    let ancestor = fx.path().parent().expect("temp root has a parent");
    assert_eq!(
        owned_staging_dir(fx.path(), ancestor),
        Err(Refusal::OutsideTempRoot)
    );
    run_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedDirectory(ancestor.to_path_buf()),
    );
    assert!(ancestor.exists());
    fx.sentinels_survive();
}

#[test]
fn a_filesystem_root_is_rejected() {
    let fx = Fixture::new();
    let mut root = fx.path().to_path_buf();
    while let Some(p) = root.parent() {
        root = p.to_path_buf();
    }
    assert_eq!(
        owned_staging_dir(fx.path(), &root),
        Err(Refusal::OutsideTempRoot)
    );
}

#[test]
fn the_user_home_directory_is_rejected() {
    let fx = Fixture::new();
    let home = dirs_home();
    assert_eq!(
        owned_staging_dir(fx.path(), &home),
        Err(Refusal::OutsideTempRoot)
    );
}

fn dirs_home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .expect("home directory")
}

/// A user-selected file lives outside the staging boundary, so neither it nor its directory
/// can be selected even if one reached a plan by mistake.
#[test]
fn a_user_selected_file_and_its_parent_are_rejected() {
    let fx = Fixture::new();
    let elsewhere = TempDir::new().expect("user dir");
    let users_file = elsewhere.path().join("MyMod.pak");
    fs::write(&users_file, b"mine").expect("user file");

    assert_eq!(
        owned_staging_file(fx.path(), &users_file),
        Err(Refusal::OutsideTempRoot)
    );
    assert_eq!(
        owned_staging_dir(fx.path(), elsewhere.path()),
        Err(Refusal::OutsideTempRoot)
    );

    run_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedFileWithSidecars(users_file.clone()),
    );
    run_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedDirectory(elsewhere.path().to_path_buf()),
    );
    assert!(users_file.exists(), "user file must survive");
    assert!(elsewhere.path().exists(), "user directory must survive");
}

#[test]
fn traversal_cannot_escape_the_staging_boundary() {
    let fx = Fixture::new();
    let escape = fx.path().join("modrex-mod-abc").join("..").join("..");
    fs::create_dir_all(fx.path().join("modrex-mod-abc")).expect("staged");
    assert_eq!(
        owned_staging_dir(fx.path(), &escape),
        Err(Refusal::OutsideTempRoot)
    );
    // Traversal that stays inside resolves to the real directory rather than being refused.
    let inside = fx.path().join("modrex-mod-abc").join("nested").join("..");
    fs::create_dir_all(fx.path().join("modrex-mod-abc").join("nested")).expect("nested");
    assert_eq!(
        owned_staging_dir(fx.path(), &inside),
        Ok(fx
            .path()
            .canonicalize()
            .expect("root")
            .join("modrex-mod-abc"))
    );
}

#[test]
fn a_missing_target_fails_closed() {
    let fx = Fixture::new();
    let missing = fx.path().join("modrex-mod-does-not-exist");
    assert_eq!(
        owned_staging_dir(fx.path(), &missing),
        Err(Refusal::Unresolvable)
    );
    run_plan(fx.path(), &CleanupPlan::RemoveOwnedDirectory(missing));
    fx.sentinels_survive();
}

/// A link is refused rather than followed, so cleanup cannot delete a tree the link points at
/// or unlink a junction Modrex did not create.
#[cfg(unix)]
#[test]
fn a_symlink_is_rejected() {
    let fx = Fixture::new();
    let outside = TempDir::new().expect("outside");
    fs::write(outside.path().join("precious.txt"), b"keep").expect("precious");
    let link = fx.path().join("modrex-mod-link");
    std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");

    assert_eq!(owned_staging_dir(fx.path(), &link), Err(Refusal::Symlink));
    run_plan(fx.path(), &CleanupPlan::RemoveOwnedDirectory(link));
    assert!(outside.path().join("precious.txt").exists());
    fx.sentinels_survive();
}

#[cfg(windows)]
#[test]
fn a_directory_junction_is_rejected() {
    let fx = Fixture::new();
    let outside = TempDir::new().expect("outside");
    fs::write(outside.path().join("precious.txt"), b"keep").expect("precious");
    let link = fx.path().join("modrex-mod-link");
    // Junctions need no privilege, unlike a directory symlink on Windows.
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
    assert_eq!(owned_staging_dir(fx.path(), &link), Err(Refusal::Symlink));
    run_plan(fx.path(), &CleanupPlan::RemoveOwnedDirectory(link));
    assert!(outside.path().join("precious.txt").exists());
    fx.sentinels_survive();
}

// ── every resolver-success shape names an artifact it owns ──────────────────

/// Covers the shapes reachable without an archive on disk: the resolver hands back the
/// caller's own downloaded file, which is exactly what cleanup must remove. Before the fix
/// these produced a recursive removal of the file's parent for every directory-primary game.
#[test]
fn non_archive_resolution_owns_the_downloaded_file_for_every_game() {
    for cfg in [
        engine_for_game("pd2").unwrap(),
        engine_for_game("pdth").unwrap(),
        engine_for_game("raid").unwrap(),
        engine_for_game("pd3").unwrap(),
        engine_for_game("cb").unwrap(),
    ] {
        let fx = Fixture::new();
        let downloaded = fx.staged_file("modrex-abc.lua");
        let plan = resolve_archive_download(downloaded.clone(), cfg, &StagingRegistry::new())
            .expect("non-archive resolves")
            .cleanup;
        assert_eq!(
            plan,
            CleanupPlan::RemoveOwnedFileWithSidecars(downloaded.clone()),
            "{} must own exactly the downloaded file",
            cfg.game_id
        );
        run_plan(fx.path(), &plan);
        assert!(!downloaded.exists());
        fx.sentinels_survive();
    }
}

/// No plan any resolver can produce may name the boundary itself.
#[test]
fn no_resolver_shape_selects_the_staging_root() {
    for cfg in [
        engine_for_game("pd2").unwrap(),
        engine_for_game("pdth").unwrap(),
        engine_for_game("raid").unwrap(),
        engine_for_game("pd3").unwrap(),
        engine_for_game("cb").unwrap(),
    ] {
        let fx = Fixture::new();
        let downloaded = fx.staged_file("modrex-abc.lua");
        let plan = resolve_archive_download(downloaded, cfg, &StagingRegistry::new())
            .expect("resolves")
            .cleanup;
        let named = match &plan {
            CleanupPlan::RemoveOwnedDirectory(p)
            | CleanupPlan::RemoveOwnedFileWithSidecars(p)
            | CleanupPlan::RemoveOwnedFile(p) => p.clone(),
        };
        assert_ne!(
            named.canonicalize().ok(),
            fx.path().canonicalize().ok(),
            "{} named the staging root",
            cfg.game_id
        );
    }
}

/// Pins the defect this module exists to prevent. Before the fix the recursive target was
/// derived as staged.parent(), which for a shape staged directly in the temp root is the
/// root itself. The guard now refuses exactly that value.
#[test]
fn parent_derivation_resolves_to_the_staging_root_and_is_refused() {
    let fx = Fixture::new();
    for name in ["modrex-pdmod-abc", "modrex-mod-abc"] {
        let staged = fx.staged_dir(name);
        assert_eq!(
            staged.parent(),
            Some(fx.path()),
            "{name} stages directly in the root, so parent derivation selects the root"
        );
        assert_eq!(
            owned_staging_dir(fx.path(), staged.parent().expect("parent")),
            Err(Refusal::IsTempRoot)
        );
    }
    fx.sentinels_survive();
}

// ── run_staged ─────────────────────────────────────────────────────────────

fn run_staged_plan(root: &Path, plan: &CleanupPlan, archive: Option<PathBuf>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(run_staged_in(root, plan, archive));
}

#[test]
fn staged_release_removes_the_staged_artifact_and_its_archive() {
    let fx = Fixture::new();
    let staged = fx.staged_dir("modrex-mod-abc");
    let archive = fx.staged_file("modrex-abc.zip");

    run_staged_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedDirectory(staged.clone()),
        Some(archive.clone()),
    );
    assert!(!staged.exists());
    assert!(!archive.exists());
    fx.sentinels_survive();
}

#[test]
fn staged_release_without_an_archive_touches_only_the_staged_artifact() {
    let fx = Fixture::new();
    let staged = fx.staged_file("modrex-abc.lua");
    let bystander = fx.staged_file("modrex-other.lua");

    run_staged_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedFileWithSidecars(staged.clone()),
        None,
    );
    assert!(!staged.exists());
    assert!(bystander.exists());
    fx.sentinels_survive();
}

/// The two removals are independent: a refused plan does not strand the archive, and a
/// refusal never widens to anything else.
#[test]
fn a_refused_plan_still_releases_the_archive() {
    let fx = Fixture::new();
    let archive = fx.staged_file("modrex-abc.zip");

    run_staged_plan(
        fx.path(),
        &CleanupPlan::RemoveOwnedDirectory(fx.path().to_path_buf()),
        Some(archive.clone()),
    );
    assert!(!archive.exists());
    fx.sentinels_survive();
}
