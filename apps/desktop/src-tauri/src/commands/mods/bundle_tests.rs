//! Bundle planning against real Cyberpunk 2077 download layouts (the Vortex extension's own
//! fixtures and the framework release zips), and the bundle lifecycle against a temp game
//! folder.

use super::bundle::{self, Layout, Plan, PlannedFile};
use super::engine::{backup_dir, engine_for_game, ModEngineConfig, ScanTarget};
use super::paths::{find_untracked_paks, get_state_path};
use super::state::read_state_for_game;
use super::types::InstalledMod;
use std::collections::HashSet;
use std::fs;
use tempfile::TempDir;

fn cfg() -> &'static ModEngineConfig {
    engine_for_game("cp2077").unwrap()
}

fn layout() -> Layout<'static> {
    Layout::of(cfg().primary()).expect("cp2077's primary is a bundle")
}

fn names(files: &[&str]) -> Vec<String> {
    files.iter().map(|f| f.to_string()).collect()
}

fn destinations(files: &[&str]) -> Vec<(String, String)> {
    match bundle::plan(&names(files), layout()) {
        Ok(Plan::Files(planned)) => {
            let mut out: Vec<(String, String)> = planned
                .into_iter()
                .map(
                    |PlannedFile {
                         source,
                         destination,
                     }| (source, destination),
                )
                .collect();
            out.sort();
            out
        }
        other => panic!("expected files for {files:?}, got {other:?}"),
    }
}

fn installs_as_laid_out(files: &[&str]) {
    let planned = destinations(files);
    assert_eq!(planned.len(), files.len());
    for (source, destination) in planned {
        assert_eq!(source, destination);
    }
}

fn refusal(files: &[&str]) -> String {
    match bundle::plan(&names(files), layout()) {
        Err(error) => error,
        other => panic!("expected a refusal for {files:?}, got {other:?}"),
    }
}

#[test]
fn every_framework_release_installs_exactly_as_laid_out() {
    // Listed from the release zips on GitHub: CET 1.38.1, RED4ext 1.31.0, redscript 0.5.32,
    // ArchiveXL 1.28.6 (trimmed) and TweakXL 1.12.0.
    installs_as_laid_out(&[
        "bin/x64/LICENSE",
        "bin/x64/global.ini",
        "bin/x64/plugins/cyber_engine_tweaks/fonts/NotoSans-Regular.ttf",
        "bin/x64/plugins/cyber_engine_tweaks/scripts/json/json.lua",
        "bin/x64/plugins/cyber_engine_tweaks/scripts/json/README.md",
        "bin/x64/plugins/cyber_engine_tweaks/tweakdb/usedhashes.kark",
        "bin/x64/plugins/cyber_engine_tweaks.asi",
        "bin/x64/version.dll",
    ]);
    installs_as_laid_out(&[
        "bin/x64/winmm.dll",
        "red4ext/LICENSE.txt",
        "red4ext/RED4ext.dll",
        "red4ext/THIRD_PARTY_LICENSES.txt",
    ]);
    installs_as_laid_out(&[
        "engine/config/base/scripts.ini",
        "engine/tools/scc.exe",
        "engine/tools/scc_lib.dll",
        "r6/config/cybercmd/scc.toml",
    ]);
    installs_as_laid_out(&[
        "r6/config/redsUserHints/ArchiveXL.toml",
        "red4ext/plugins/ArchiveXL/ArchiveXL.dll",
        "red4ext/plugins/ArchiveXL/LICENSE",
        "red4ext/plugins/ArchiveXL/Bundle/ArchiveXL.archive",
        "red4ext/plugins/ArchiveXL/Bundle/VisualTags.xl",
        "red4ext/plugins/ArchiveXL/Scripts/ArchiveXL.reds",
    ]);
    installs_as_laid_out(&[
        "red4ext/plugins/TweakXL/TweakXL.dll",
        "red4ext/plugins/TweakXL/Data/ExtraFlats.dat",
        "red4ext/plugins/TweakXL/Scripts/TweakXL.reds",
    ]);
}

#[test]
fn a_mixed_download_keeps_every_component() {
    installs_as_laid_out(&[
        "bin/x64/plugins/cyber_engine_tweaks/mods/exmod/Modules/morelua.lua",
        "bin/x64/plugins/cyber_engine_tweaks/mods/exmod/init.lua",
        "r6/config/redsUserHints/whatevs.toml",
        "r6/scripts/rexmod/script.reds",
        "r6/tweaks/rexmod/items.yaml",
        "red4ext/plugins/r4xmod/script.dll",
        "red4ext/plugins/r4xmod/sub/subscript.dll",
        "archive/pc/mod/magicgoeshere.archive",
        "archive/pc/mod/magicgoeshere.archive.xl",
    ]);
}

#[test]
fn a_redmod_with_archives_installs_whole() {
    installs_as_laid_out(&[
        "mods/myRedMod/info.json",
        "mods/myRedMod/archives/cool_stuff.archive",
        "mods/myRedMod/scripts/exec/thing.script",
    ]);
}

#[test]
fn wrapper_folders_are_looked_through() {
    assert_eq!(
        destinations(&[
            "My Mod-1.0/archive/pc/mod/first.archive",
            "My Mod-1.0/r6/scripts/rexmod/script.reds",
            "My Mod-1.0/readme.txt",
        ]),
        vec![
            (
                "My Mod-1.0/archive/pc/mod/first.archive".to_string(),
                "archive/pc/mod/first.archive".to_string()
            ),
            (
                "My Mod-1.0/r6/scripts/rexmod/script.reds".to_string(),
                "r6/scripts/rexmod/script.reds".to_string()
            ),
        ]
    );
}

#[test]
fn loose_files_go_where_their_extension_belongs() {
    assert_eq!(
        destinations(&["first.archive", "first.archive.xl", "Fix.reds", "README.md"]),
        vec![
            ("Fix.reds".to_string(), "r6/scripts/Fix.reds".to_string()),
            (
                "first.archive".to_string(),
                "archive/pc/mod/first.archive".to_string()
            ),
            (
                "first.archive.xl".to_string(),
                "archive/pc/mod/first.archive.xl".to_string()
            ),
        ]
    );
}

#[test]
fn bare_folders_are_placed_by_what_they_hold() {
    assert_eq!(
        destinations(&["MyCet/init.lua", "MyCet/Modules/ui.lua"]),
        vec![
            (
                "MyCet/Modules/ui.lua".to_string(),
                "bin/x64/plugins/cyber_engine_tweaks/mods/MyCet/Modules/ui.lua".to_string()
            ),
            (
                "MyCet/init.lua".to_string(),
                "bin/x64/plugins/cyber_engine_tweaks/mods/MyCet/init.lua".to_string()
            ),
        ]
    );
    assert_eq!(
        destinations(&["Wrapper v2/MyReds/a.reds"]),
        vec![(
            "Wrapper v2/MyReds/a.reds".to_string(),
            "r6/scripts/MyReds/a.reds".to_string()
        )]
    );
    assert_eq!(
        destinations(&["MyRedMod/info.json", "MyRedMod/archives/x.archive"]),
        vec![
            (
                "MyRedMod/archives/x.archive".to_string(),
                "mods/MyRedMod/archives/x.archive".to_string()
            ),
            (
                "MyRedMod/info.json".to_string(),
                "mods/MyRedMod/info.json".to_string()
            ),
        ]
    );
}

#[test]
fn side_by_side_layouts_are_offered_as_variants() {
    assert_eq!(
        bundle::plan(
            &names(&[
                "Option A/archive/pc/mod/look.archive",
                "Option B/archive/pc/mod/look.archive",
                "readme.txt",
            ]),
            layout()
        ),
        Ok(Plan::Variants(vec![
            "Option A".to_string(),
            "Option B".to_string()
        ]))
    );
}

#[test]
fn a_variant_installs_on_its_own() {
    assert_eq!(
        destinations(&["archive/pc/mod/look.archive"]),
        vec![(
            "archive/pc/mod/look.archive".to_string(),
            "archive/pc/mod/look.archive".to_string()
        )]
    );
}

#[test]
fn what_cannot_be_placed_refuses_the_install() {
    assert!(refusal(&["fomod/ModuleConfig.xml", "archive/pc/mod/a.archive"]).contains("FOMOD"));
    assert!(refusal(&["tweak.yaml"]).contains("tweak.yaml"));
    assert!(refusal(&["Cyberpunk2077.exe"]).contains("Cyberpunk2077.exe"));
    assert!(refusal(&["archive/pc/mod/a.archive", "Extras/b.bin"]).contains("Extras/"));
    assert!(refusal(&["Both/init.lua", "Both/info.json"]).contains("more than one place"));
    assert!(refusal(&["archive/pc/mod/fold1/first.archive"]).contains("never reads"));
    assert!(refusal(&["a.archive", "archive/pc/mod/A.ARCHIVE"]).contains("both install"));
    assert!(refusal(&["readme.txt"]).contains("nothing to install"));
    assert!(refusal(&["r6/../../evil.dll"]).contains("outside the mod"));
    assert!(refusal(&["C:/evil.dll"]).contains("outside the mod"));
}

#[test]
fn backslash_member_names_are_read_as_paths() {
    installs_as_laid_out(&["archive/pc/mod/a.archive"]);
    assert_eq!(
        destinations(&["archive\\pc\\mod\\a.archive"]),
        vec![(
            "archive/pc/mod/a.archive".to_string(),
            "archive/pc/mod/a.archive".to_string()
        )]
    );
}

#[test]
fn macos_resource_forks_are_not_content() {
    installs_as_laid_out(&["archive/pc/mod/a.archive"]);
    assert_eq!(
        destinations(&["__MACOSX/archive/._a.archive", "archive/pc/mod/a.archive"]).len(),
        1
    );
}

// ── lifecycle ────────────────────────────────────────────────────────────────

struct Game {
    dir: TempDir,
}

impl Game {
    fn new() -> Self {
        Game {
            dir: TempDir::new().unwrap(),
        }
    }

    fn path(&self) -> &str {
        self.dir.path().to_str().unwrap()
    }

    fn file(&self, rel: &str) -> std::path::PathBuf {
        self.dir.path().join(rel)
    }

    fn state_path(&self) -> std::path::PathBuf {
        get_state_path(self.path(), cfg())
    }

    fn mods(&self) -> Vec<InstalledMod> {
        read_state_for_game(self.path(), &self.state_path(), cfg())
            .unwrap()
            .mods
    }

    fn install(&self, record: InstalledMod, files: &[(&str, &str)]) -> Result<(), String> {
        let staging = TempDir::new().unwrap();
        for (rel, body) in files {
            let path = staging.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
        bundle::install(
            self.path(),
            &self.state_path(),
            record,
            staging.path(),
            cfg(),
            target(),
        )
    }
}

fn target() -> &'static ScanTarget {
    cfg().primary()
}

fn record(uid: &str, remote: Option<&str>) -> InstalledMod {
    InstalledMod {
        uid: uid.to_string(),
        name: uid.to_string(),
        filename: uid.to_string(),
        source: "nexus".to_string(),
        remote_id: remote.map(str::to_string),
        ..InstalledMod::default()
    }
}

fn find<'a>(mods: &'a [InstalledMod], uid: &str) -> &'a InstalledMod {
    mods.iter().find(|m| m.uid == uid).unwrap()
}

#[test]
fn install_places_every_file_and_lists_it() {
    let game = Game::new();
    game.install(
        record("mixed", None),
        &[
            ("archive/pc/mod/a.archive", "A"),
            ("r6/scripts/mixed/s.reds", "S"),
        ],
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(game.file("archive/pc/mod/a.archive")).unwrap(),
        "A"
    );
    assert_eq!(
        fs::read_to_string(game.file("r6/scripts/mixed/s.reds")).unwrap(),
        "S"
    );
    let mods = game.mods();
    let installed = find(&mods, "mixed");
    assert!(installed.enabled);
    let mut paths: Vec<&str> = installed
        .bundle
        .as_deref()
        .unwrap()
        .iter()
        .map(|f| f.path.as_str())
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        ["archive/pc/mod/a.archive", "r6/scripts/mixed/s.reds"]
    );
}

#[tokio::test]
async fn files_a_bundle_owns_are_not_listed_as_installed_by_hand() {
    let game = Game::new();
    game.install(
        record("mixed", None),
        &[
            ("archive/pc/mod/a.archive", "A"),
            ("r6/scripts/mixed/s.reds", "S"),
            ("bin/x64/plugins/cyber_engine_tweaks/mods/m/init.lua", "L"),
        ],
    )
    .unwrap();
    fs::create_dir_all(game.file("r6/scripts/handmade")).unwrap();
    fs::write(game.file("r6/scripts/handmade/h.reds"), "H").unwrap();

    let known: HashSet<String> = bundle::owned_scan_keys(cfg(), &game.mods());
    let found = find_untracked_paks(game.path(), &known, cfg()).await;
    assert_eq!(
        found,
        vec![(
            "handmade".to_string(),
            true,
            Some("redscript_mods".to_string())
        )]
    );
}

#[test]
fn disabling_moves_the_files_out_of_the_game_and_back() {
    let game = Game::new();
    game.install(
        record("mixed", None),
        &[
            ("archive/pc/mod/a.archive", "A"),
            ("r6/scripts/mixed/s.reds", "S"),
        ],
    )
    .unwrap();
    let installed = find(&game.mods(), "mixed").clone();

    bundle::set_enabled(game.path(), target(), &installed, false).unwrap();
    assert!(!game.file("archive/pc/mod/a.archive").exists());
    assert!(!game.file("r6/scripts/mixed").exists());
    assert!(game.file("r6").exists(), "a root folder is never pruned");
    let store = bundle::disabled_store(game.path(), target(), "mixed");
    assert!(store.join("archive/pc/mod/a.archive").is_file());

    let disabled = InstalledMod {
        enabled: false,
        ..installed
    };
    assert!(bundle::is_complete(game.path(), target(), &disabled));
    bundle::set_enabled(game.path(), target(), &disabled, true).unwrap();
    assert!(game.file("archive/pc/mod/a.archive").is_file());
    assert!(game.file("r6/scripts/mixed/s.reds").is_file());
    assert!(!store.exists());
}

#[test]
fn enabling_refuses_when_something_took_the_place_of_a_file() {
    let game = Game::new();
    game.install(record("m", None), &[("archive/pc/mod/a.archive", "A")])
        .unwrap();
    let installed = find(&game.mods(), "m").clone();
    bundle::set_enabled(game.path(), target(), &installed, false).unwrap();
    fs::create_dir_all(game.file("archive/pc/mod")).unwrap();
    fs::write(game.file("archive/pc/mod/a.archive"), "someone else").unwrap();

    let disabled = InstalledMod {
        enabled: false,
        ..installed
    };
    assert!(bundle::set_enabled(game.path(), target(), &disabled, true).is_err());
    assert_eq!(
        fs::read_to_string(game.file("archive/pc/mod/a.archive")).unwrap(),
        "someone else"
    );
}

#[test]
fn uninstall_removes_the_files_and_the_folders_it_emptied() {
    let game = Game::new();
    game.install(
        record("m", None),
        &[
            ("archive/pc/mod/a.archive", "A"),
            ("r6/scripts/m/s.reds", "S"),
        ],
    )
    .unwrap();
    fs::write(game.file("r6/keep.txt"), "game file").unwrap();
    let installed = find(&game.mods(), "m").clone();

    assert!(bundle::remove(game.path(), target(), &installed)
        .unwrap()
        .is_empty());
    assert!(!game.file("archive/pc").exists());
    assert!(
        game.file("archive").exists(),
        "a root folder is never pruned"
    );
    assert!(!game.file("r6/scripts").exists());
    assert!(game.file("r6/keep.txt").exists());
}

#[test]
fn uninstall_keeps_a_file_that_changed_since_install() {
    let game = Game::new();
    game.install(record("m", None), &[("r6/scripts/m/s.reds", "S")])
        .unwrap();
    // The same length, so only the bytes tell the edit apart.
    fs::write(game.file("r6/scripts/m/s.reds"), "E").unwrap();
    let installed = find(&game.mods(), "m").clone();

    let kept = bundle::remove(game.path(), target(), &installed).unwrap();
    assert_eq!(kept.len(), 1);
    assert!(game.file("r6/scripts/m/s.reds").exists());
}

#[test]
fn install_never_overwrites_a_file_it_does_not_own() {
    let game = Game::new();
    fs::create_dir_all(game.file("archive/pc/mod")).unwrap();
    fs::write(game.file("archive/pc/mod/a.archive"), "by hand").unwrap();

    let error = game
        .install(
            record("m", None),
            &[
                ("archive/pc/mod/a.archive", "A"),
                ("r6/scripts/m/s.reds", "S"),
            ],
        )
        .unwrap_err();
    assert!(error.contains("not installed by Modrex"), "{error}");
    assert_eq!(
        fs::read_to_string(game.file("archive/pc/mod/a.archive")).unwrap(),
        "by hand"
    );
    assert!(!game.file("r6/scripts").exists());
    assert!(game.mods().is_empty());
}

#[test]
fn install_refuses_a_file_another_mod_owns() {
    let game = Game::new();
    game.install(
        record("first", Some("1")),
        &[("archive/pc/mod/a.archive", "A")],
    )
    .unwrap();
    let error = game
        .install(
            record("second", Some("2")),
            &[("archive/pc/mod/a.archive", "B")],
        )
        .unwrap_err();
    assert!(error.contains("already installed by first"), "{error}");
    assert_eq!(
        fs::read_to_string(game.file("archive/pc/mod/a.archive")).unwrap(),
        "A"
    );
}

#[test]
fn a_newer_release_replaces_the_files_of_the_one_it_overlaps() {
    let game = Game::new();
    game.install(
        record("nexus:7:100", Some("7")),
        &[
            ("archive/pc/mod/a.archive", "old"),
            ("r6/scripts/m/gone.reds", "G"),
        ],
    )
    .unwrap();
    game.install(
        record("nexus:7:200", Some("7")),
        &[("archive/pc/mod/a.archive", "new")],
    )
    .unwrap();

    let mods = game.mods();
    assert_eq!(mods.len(), 1);
    assert_eq!(mods[0].uid, "nexus:7:200");
    assert_eq!(
        fs::read_to_string(game.file("archive/pc/mod/a.archive")).unwrap(),
        "new"
    );
    assert!(!game.file("r6/scripts").exists());
}

#[test]
fn a_separate_optional_file_of_the_same_mod_installs_beside_the_main_one() {
    let game = Game::new();
    game.install(
        record("nexus:7:100", Some("7")),
        &[("archive/pc/mod/main.archive", "M")],
    )
    .unwrap();
    game.install(
        record("nexus:7:101", Some("7")),
        &[("archive/pc/mod/opt.archive", "O")],
    )
    .unwrap();
    assert_eq!(game.mods().len(), 2);
}

#[test]
fn a_failed_install_puts_the_previous_release_back() {
    let game = Game::new();
    game.install(
        record("nexus:7:100", Some("7")),
        &[("archive/pc/mod/a.archive", "old")],
    )
    .unwrap();
    // A file standing where the new release needs a folder makes the second write fail.
    fs::write(game.file("r6"), "not a folder").unwrap();
    let error = game
        .install(
            record("nexus:7:200", Some("7")),
            &[
                ("archive/pc/mod/a.archive", "new"),
                ("r6/scripts/m/s.reds", "S"),
            ],
        )
        .unwrap_err();
    assert!(error.contains("Nothing was changed"), "{error}");
    assert_eq!(
        fs::read_to_string(game.file("archive/pc/mod/a.archive")).unwrap(),
        "old"
    );
    assert_eq!(game.mods()[0].uid, "nexus:7:100");
}

#[test]
fn launching_without_mods_hides_enabled_bundles_and_restores_them() {
    let game = Game::new();
    game.install(record("on", None), &[("archive/pc/mod/on.archive", "A")])
        .unwrap();
    game.install(record("off", None), &[("r6/scripts/off/s.reds", "S")])
        .unwrap();
    let off = find(&game.mods(), "off").clone();
    bundle::set_enabled(game.path(), target(), &off, false).unwrap();

    bundle::hide(game.path(), target(), &game.mods()).unwrap();
    assert!(!game.file("archive/pc/mod/on.archive").exists());
    assert!(backup_dir(game.path(), target())
        .join("archive/pc/mod/on.archive")
        .is_file());

    bundle::restore(game.path(), target()).unwrap();
    assert!(game.file("archive/pc/mod/on.archive").is_file());
    assert!(!backup_dir(game.path(), target()).exists());
    assert!(
        !game.file("r6/scripts/off").exists(),
        "a disabled bundle stays disabled"
    );
}

#[test]
fn a_hidden_bundle_cannot_be_disabled_until_it_is_restored() {
    let game = Game::new();
    game.install(record("on", None), &[("archive/pc/mod/on.archive", "A")])
        .unwrap();
    bundle::hide(game.path(), target(), &game.mods()).unwrap();
    let on = find(&game.mods(), "on").clone();
    let error = bundle::set_enabled(game.path(), target(), &on, false).unwrap_err();
    assert!(error.contains("launch without mods"), "{error}");
    bundle::restore(game.path(), target()).unwrap();
    bundle::set_enabled(game.path(), target(), &on, false).unwrap();
}

#[test]
fn restoring_keeps_a_hidden_file_whose_place_was_taken() {
    let game = Game::new();
    game.install(record("on", None), &[("archive/pc/mod/on.archive", "A")])
        .unwrap();
    bundle::hide(game.path(), target(), &game.mods()).unwrap();
    fs::create_dir_all(game.file("archive/pc/mod")).unwrap();
    fs::write(game.file("archive/pc/mod/on.archive"), "newer").unwrap();

    assert!(bundle::restore(game.path(), target()).is_err());
    let hidden = backup_dir(game.path(), target()).join("archive/pc/mod/on.archive");
    assert_eq!(fs::read_to_string(hidden).unwrap(), "A");
    assert_eq!(
        fs::read_to_string(game.file("archive/pc/mod/on.archive")).unwrap(),
        "newer"
    );
}

#[test]
fn a_loose_download_is_named_after_the_mod() {
    let game = Game::new();
    let staging = TempDir::new().unwrap();
    let loose = staging.path().join("modrex-1234.archive");
    fs::write(&loose, "A").unwrap();
    bundle::install(
        game.path(),
        &game.state_path(),
        InstalledMod {
            filename: "Cool_Mod".to_string(),
            ..record("loose", None)
        },
        &loose,
        cfg(),
        target(),
    )
    .unwrap();
    assert!(game.file("archive/pc/mod/Cool_Mod.archive").is_file());
}

#[test]
fn installing_while_mods_are_hidden_is_refused() {
    let game = Game::new();
    fs::create_dir_all(backup_dir(game.path(), target())).unwrap();
    let error = game
        .install(record("m", None), &[("archive/pc/mod/a.archive", "A")])
        .unwrap_err();
    assert!(error.contains("launch without mods"), "{error}");
}

// ── resolution of real archives ─────────────────────────────────────────────

fn make_zip(dir: &TempDir, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
    use std::io::Write;
    let path = dir.path().join("download.zip");
    let mut zip = ::zip::ZipWriter::new(fs::File::create(&path).unwrap());
    let opts = ::zip::write::SimpleFileOptions::default();
    for (name, data) in entries {
        zip.start_file(*name, opts).unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap();
    path
}

fn resolve(path: std::path::PathBuf) -> Result<super::staged::Staged, super::zip::ResolveError> {
    super::zip::resolve_archive_download(path, cfg(), &super::StagingRegistry::new())
}

#[test]
fn a_mixed_download_stages_everything_it_holds() {
    let dir = TempDir::new().unwrap();
    let zip = make_zip(
        &dir,
        &[
            ("Mod 1.2/archive/pc/mod/a.archive", b"A"),
            ("Mod 1.2/r6/scripts/m/s.reds", b"S"),
            ("Mod 1.2/r6/tweaks/m/t.yaml", b"T"),
        ],
    );
    let staged = resolve(zip).unwrap();
    assert_eq!(staged.target_tag, None);
    let files = bundle::staged_files(&staged.root).unwrap();
    assert_eq!(
        files,
        [
            "Mod 1.2/archive/pc/mod/a.archive",
            "Mod 1.2/r6/scripts/m/s.reds",
            "Mod 1.2/r6/tweaks/m/t.yaml"
        ]
    );
}

#[test]
fn side_by_side_variants_ask_which_to_install_without_making_folders() {
    let dir = TempDir::new().unwrap();
    let zip = make_zip(
        &dir,
        &[
            ("Option A/archive/pc/mod/look.archive", b"A"),
            ("Option B/archive/pc/mod/look.archive", b"B"),
        ],
    );
    let Err(super::zip::ResolveError::Prompt(prompt)) = resolve(zip) else {
        panic!("variants prompt for a choice");
    };
    let super::zip::InstallPrompt::ZipMultiPak(payload) = *prompt else {
        panic!("variants use the archive picker");
    };
    assert_eq!(payload.entries, ["Option A", "Option B"]);
    assert_eq!(payload.target_tag.as_deref(), Some("mods"));
    assert_eq!(payload.entry_kind.as_deref(), Some("dir"));
}

#[test]
fn an_unplaceable_download_is_refused_and_removed() {
    let dir = TempDir::new().unwrap();
    let zip = make_zip(
        &dir,
        &[("archive/pc/mod/a.archive", b"A"), ("tool.exe", b"X")],
    );
    let Err(super::zip::ResolveError::Failure(error)) = resolve(zip.clone()) else {
        panic!("an unplaceable file refuses the install");
    };
    assert!(error.contains("tool.exe"), "{error}");
    assert!(!zip.exists());
}

#[test]
fn a_failed_save_takes_the_new_release_back_and_restores_the_old_one() {
    let game = Game::new();
    game.install(
        record("nexus:7:100", Some("7")),
        &[("archive/pc/mod/a.archive", "old")],
    )
    .unwrap();
    let tmp = super::state::temporary_state_path(&game.state_path());
    fs::create_dir_all(&tmp).unwrap();

    let error = game
        .install(
            record("nexus:7:200", Some("7")),
            &[
                ("archive/pc/mod/a.archive", "new"),
                ("r6/scripts/m/s.reds", "S"),
            ],
        )
        .unwrap_err();
    assert!(error.contains("Nothing was changed"), "{error}");
    assert_eq!(
        fs::read_to_string(game.file("archive/pc/mod/a.archive")).unwrap(),
        "old"
    );
    assert!(!game.file("r6/scripts").exists());
    assert_eq!(game.mods()[0].uid, "nexus:7:100");
}

#[test]
fn updating_a_disabled_mod_keeps_it_disabled() {
    let game = Game::new();
    game.install(
        record("nexus:7:100", Some("7")),
        &[("archive/pc/mod/a.archive", "old")],
    )
    .unwrap();
    let old = find(&game.mods(), "nexus:7:100").clone();
    bundle::set_enabled(game.path(), target(), &old, false).unwrap();
    let mut state = read_state_for_game(game.path(), &game.state_path(), cfg()).unwrap();
    state.mods[0].enabled = false;
    super::state::save_state(&game.state_path(), &state).unwrap();

    game.install(
        record("nexus:7:200", Some("7")),
        &[("archive/pc/mod/a.archive", "new")],
    )
    .unwrap();
    let mods = game.mods();
    let new = find(&mods, "nexus:7:200");
    assert!(!new.enabled);
    assert!(!game.file("archive/pc/mod/a.archive").exists());
    let stored = bundle::disabled_store(game.path(), target(), "nexus:7:200")
        .join("archive/pc/mod/a.archive");
    assert_eq!(fs::read_to_string(stored).unwrap(), "new");
}

#[test]
fn an_update_keeps_a_dropped_file_the_user_changed() {
    let game = Game::new();
    game.install(
        record("nexus:7:100", Some("7")),
        &[
            ("archive/pc/mod/a.archive", "old"),
            ("r6/scripts/m/config.reds", "default"),
        ],
    )
    .unwrap();
    fs::write(game.file("r6/scripts/m/config.reds"), "mine!!!").unwrap();
    game.install(
        record("nexus:7:200", Some("7")),
        &[("archive/pc/mod/a.archive", "new")],
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(game.file("r6/scripts/m/config.reds")).unwrap(),
        "mine!!!"
    );
}

#[test]
fn a_bundle_never_writes_inside_a_mod_installed_separately() {
    let game = Game::new();
    let mut state = read_state_for_game(game.path(), &game.state_path(), cfg()).unwrap();
    state.mods.push(InstalledMod {
        uid: "cet:Foo".to_string(),
        name: "Foo".to_string(),
        filename: "Foo".to_string(),
        enabled: true,
        location: Some("cet_mods".to_string()),
        ..InstalledMod::default()
    });
    super::state::save_state(&game.state_path(), &state).unwrap();
    let foo = game.file("bin/x64/plugins/cyber_engine_tweaks/mods/Foo");
    fs::create_dir_all(&foo).unwrap();
    fs::write(foo.join("init.lua"), "L").unwrap();

    let error = game
        .install(
            record("extra", None),
            &[(
                "bin/x64/plugins/cyber_engine_tweaks/mods/foo/extra.lua",
                "X",
            )],
        )
        .unwrap_err();
    assert!(error.contains("installed separately"), "{error}");
    assert!(!foo.join("extra.lua").exists());
}

#[test]
fn a_record_naming_a_place_outside_the_mod_folders_is_left_alone() {
    let game = Game::new();
    fs::write(game.file("outside.dat"), "1").unwrap();
    let forged = InstalledMod {
        bundle: Some(vec![super::types::BundleFile {
            path: "r6/../outside.dat".to_string(),
            size: 1,
            sha256: String::new(),
        }]),
        enabled: true,
        ..record("forged", None)
    };
    assert!(bundle::remove(game.path(), target(), &forged).is_err());
    assert!(bundle::set_enabled(game.path(), target(), &forged, false).is_err());
    assert!(!bundle::is_complete(game.path(), target(), &forged));
    assert!(game.file("outside.dat").exists());
}

#[tokio::test]
async fn a_bundle_hides_its_folder_from_the_scan_whatever_its_case_on_disk() {
    let game = Game::new();
    let mods_dir = game.file("bin/x64/plugins/cyber_engine_tweaks/mods");
    // An empty folder is in nobody's way. On Windows the install writes into it under the
    // spelling the folder already has, while the record keeps the download's spelling.
    fs::create_dir_all(mods_dir.join("foo")).unwrap();
    game.install(
        record("cased", None),
        &[("bin/x64/plugins/cyber_engine_tweaks/mods/Foo/init.lua", "L")],
    )
    .unwrap();
    let known = bundle::owned_scan_keys(cfg(), &game.mods());
    assert!(known.contains("cet_mods:foo"));
    let found = find_untracked_paks(game.path(), &known, cfg()).await;
    assert!(found.is_empty(), "{found:?}");
}

#[test]
fn separate_files_of_one_mod_are_never_taken_for_superseded_releases() {
    let game = Game::new();
    game.install(
        InstalledMod {
            file_id: Some(100),
            ..record("nexus:7:100", Some("7"))
        },
        &[("archive/pc/mod/main.archive", "M")],
    )
    .unwrap();
    game.install(
        InstalledMod {
            file_id: Some(101),
            ..record("nexus:7:101", Some("7"))
        },
        &[("archive/pc/mod/optional.archive", "O")],
    )
    .unwrap();
    let mut mods = game.mods();
    for m in &mut mods {
        m.filename = "Same_Mod_Name".to_string();
    }
    assert!(super::state::superseded_records(&mods).is_empty());
}
