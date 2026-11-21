use super::super::engine::{engine_for_game, vanilla_dir, ModUnit, ScanTarget};
use super::super::folders::create_folder_op;
use super::super::install::{install_mod_from_path, uninstall_mod_op};
use super::super::native_files::NativeGuard;
use super::super::paths::get_state_path;
use super::super::paths::mods_base;
use super::*;
use tempfile::TempDir;

const EMPTY: ProfileSource = ProfileSource::Empty {
    keep_loaders: false,
};

struct Game {
    dir: TempDir,
    staging: TempDir,
    cfg: &'static ModEngineConfig,
    launcher: Option<&'static str>,
}

impl Game {
    fn new(game_id: &str) -> Self {
        Self {
            dir: TempDir::new().unwrap(),
            staging: TempDir::new().unwrap(),
            cfg: engine_for_game(game_id).unwrap(),
            launcher: None,
        }
    }

    /// A copy from one store, which decides where UE4SS sits.
    fn on(game_id: &str, launcher: &'static str) -> Self {
        Self {
            launcher: Some(launcher),
            ..Self::new(game_id)
        }
    }

    fn list(&self) -> ProfileList {
        self.with_install(|install| list(&self.store(), install))
            .unwrap()
    }

    /// Writes a file under the game folder.
    fn put(&self, rel: &str, body: &[u8]) -> PathBuf {
        let path = self.dir.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    fn parked_loader(&self, id: &str, rel: &str) -> PathBuf {
        self.dir.path().join(".modrex/loaders").join(id).join(rel)
    }

    fn path(&self) -> &str {
        self.dir.path().to_str().unwrap()
    }

    fn state_path(&self) -> PathBuf {
        get_state_path(self.path(), self.cfg)
    }

    fn store(&self) -> ProfileStore {
        ProfileStore::new(self.path())
    }

    fn with_install<T>(&self, run: impl FnOnce(&Install) -> T) -> T {
        let state_path = self.state_path();
        run(&Install {
            game_path: self.path(),
            state_path: &state_path,
            cfg: self.cfg,
            launcher: self.launcher,
        })
    }

    fn state(&self) -> ModsState {
        self.with_install(|install| install.read().unwrap())
    }

    fn record(&self, uid: &str) -> InstalledMod {
        self.state()
            .mods
            .into_iter()
            .find(|m| m.uid == uid)
            .unwrap()
    }

    /// Installs a file or folder mod from a staged copy holding body.
    fn install(&self, target: &ScanTarget, record: InstalledMod, folder: Option<String>) {
        let staged = self.staging.path().join(&record.uid);
        match &target.unit {
            ModUnit::File { .. } => {
                fs::write(&staged, record.uid.as_bytes()).unwrap();
            }
            ModUnit::Directory { .. } => {
                fs::create_dir_all(staged.join("Scripts")).unwrap();
                fs::write(staged.join("mod.txt"), b"{}").unwrap();
                fs::write(staged.join("Scripts/main.lua"), b"-- lua").unwrap();
            }
            ModUnit::Bundle { .. } => {
                let file = staged.join(format!("archive/pc/mod/{}.archive", record.uid));
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, record.uid.as_bytes()).unwrap();
            }
        }
        install_mod_from_path(
            self.path(),
            &self.state_path(),
            record,
            &staged,
            folder,
            self.cfg,
            target,
        )
        .unwrap();
    }

    fn create(&self, name: &str, source: ProfileSource) -> String {
        self.with_install(|install| create(&self.store(), install, name, source))
            .unwrap()
            .id
    }

    fn switch(&self, id: &str) {
        self.with_install(|install| switch(&self.store(), install, id))
            .unwrap();
    }

    fn set(&self, uid: &str, enable: bool) {
        let op = if enable {
            enable_mod_op
        } else {
            disable_mod_op
        };
        op(self.path(), &self.state_path(), uid, self.cfg, None).unwrap();
    }

    /// The mods the Installed page lists, which are the active profile's.
    fn live(&self) -> Vec<String> {
        sorted(self.state().mods.into_iter().map(|m| m.uid))
    }

    fn enabled(&self) -> Vec<String> {
        sorted(
            self.state()
                .mods
                .into_iter()
                .filter(|m| m.enabled)
                .map(|m| m.uid),
        )
    }

    fn parked(&self) -> Vec<String> {
        sorted(self.store().parked().unwrap().into_iter().map(|m| m.uid))
    }

    /// Where a parked mod's files are, in the folder of the profile that keeps it.
    fn stored_path(&self, m: &InstalledMod) -> PathBuf {
        self.store()
            .list()
            .unwrap()
            .into_iter()
            .find_map(|p| {
                p.parked
                    .iter()
                    .find(|x| x.record.install_id == m.install_id)
                    .map(|x| p.dir.join(&x.stored))
            })
            .unwrap()
    }

    /// Where a live file or folder mod sits on disk: true for its active path, false for
    /// disabled.
    fn on_disk_enabled(&self, uid: &str) -> bool {
        let state = self.state();
        let m = state.mods.iter().find(|m| m.uid == uid).unwrap();
        let target = self.cfg.mod_target(m);
        let rel = get_folder_path(&state.folders, m.folder_id.as_deref());
        let active = active_mod_path(self.path(), &m.filename, rel.as_deref(), target);
        let disabled = disabled_mod_path(self.path(), &m.filename, rel.as_deref(), target);
        assert!(
            active.exists() != disabled.exists(),
            "{uid} must be in exactly one place"
        );
        active.exists()
    }
}

fn sorted(uids: impl Iterator<Item = String>) -> Vec<String> {
    let mut uids: Vec<String> = uids.collect();
    uids.sort();
    uids
}

fn record(uid: &str) -> InstalledMod {
    InstalledMod {
        uid: uid.to_string(),
        name: uid.to_string(),
        filename: format!("{uid}_P.pak"),
        enabled: true,
        ..InstalledMod::default()
    }
}

fn dir_record(uid: &str) -> InstalledMod {
    InstalledMod {
        filename: uid.to_string(),
        ..record(uid)
    }
}

#[test]
fn a_snapshot_lists_every_live_mod_and_keeps_members_it_cannot_see() {
    let live = |uid: &str, enabled: bool| InstalledMod {
        install_id: uid.to_string(),
        enabled,
        ..record(uid)
    };
    let member = |id: &str| ProfileMember {
        install_id: id.to_string(),
        enabled: true,
        folder_id: None,
        priority: None,
    };
    let previous = [member("off-member"), member("elsewhere")];
    let mods = [
        live("on", true),
        live("off-member", false),
        live("off-outsider", false),
    ];
    let ids = |members: Vec<ProfileMember>| -> Vec<(String, bool)> {
        members
            .into_iter()
            .map(|m| (m.install_id, m.enabled))
            .collect()
    };

    assert_eq!(
        ids(snapshot(&previous, &mods)),
        [
            ("on".to_string(), true),
            ("off-member".to_string(), false),
            ("off-outsider".to_string(), false),
            ("elsewhere".to_string(), true),
        ]
    );
}

#[test]
fn a_new_profile_starts_with_no_mods_and_the_old_ones_wait_in_the_modrex_folder() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    for uid in ["a", "b", "c"] {
        game.install(paks, record(uid), None);
    }
    game.set("c", false);
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    let records: Vec<InstalledMod> = game.state().mods;

    game.switch(&fresh);

    assert!(game.live().is_empty());
    assert_eq!(game.parked(), ["a", "b", "c"]);
    let main_dir = game.store().get(&main).unwrap().dir;
    let mut stored = Vec::new();
    for m in &records {
        let path = game.stored_path(m);
        assert!(path.is_file(), "{}", m.uid);
        assert_eq!(path.parent(), Some(main_dir.as_path()));
        assert!(!active_mod_path(game.path(), &m.filename, None, paks).exists());
        assert!(!disabled_mod_path(game.path(), &m.filename, None, paks).exists());
        stored.push(path);
    }

    game.switch(&main);
    assert_eq!(game.live(), ["a", "b", "c"]);
    assert_eq!(game.enabled(), ["a", "b"]);
    assert!(game.on_disk_enabled("a"));
    assert!(!game.on_disk_enabled("c"));
    assert!(game.parked().is_empty());
    for path in &stored {
        assert!(!path.exists(), "{}", path.display());
    }
    assert_eq!(
        game.store().active().unwrap().as_deref(),
        Some(main.as_str())
    );
}

#[test]
fn each_profile_keeps_the_mods_installed_in_it() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    game.switch(&fresh);
    game.install(paks, record("x"), None);
    game.set("x", false);

    game.switch(&main);
    assert_eq!(game.live(), ["a"]);
    assert_eq!(game.parked(), ["x"]);

    game.switch(&fresh);
    assert_eq!(game.live(), ["x"]);
    assert!(game.enabled().is_empty());
    assert_eq!(game.parked(), ["a"]);
}

// Installing in a new profile a mod another profile already has gives this profile its own
// copy, since the other one is parked and no install path looks there.
#[test]
fn a_mod_installed_again_in_another_profile_keeps_one_copy_per_profile() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    let main_copy = game.record("a").install_id;
    game.switch(&fresh);
    game.install(paks, record("a"), None);
    let fresh_copy = game.record("a").install_id;
    assert_ne!(main_copy, fresh_copy);

    game.switch(&main);
    assert_eq!(game.record("a").install_id, main_copy);
    game.switch(&fresh);
    assert_eq!(game.record("a").install_id, fresh_copy);
    assert!(game.on_disk_enabled("a"));
}

#[test]
fn a_profile_restores_its_own_folders_and_order() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    game.install(paks, record("b"), None);
    let one = game.create("One", ProfileSource::Current);
    let two = game.create(
        "Two",
        ProfileSource::Copy {
            profile_id: one.clone(),
        },
    );
    let order = |game: &Game| {
        let mut mods = game.state().mods;
        mods.sort_by_key(|m| std::cmp::Reverse(m.priority));
        mods.into_iter().map(|m| m.uid).collect::<Vec<_>>()
    };
    let one_order = order(&game);

    game.switch(&two);
    let reversed: Vec<String> = one_order.iter().rev().cloned().collect();
    reorder_mods_in_folder_op(game.path(), &game.state_path(), None, &reversed, game.cfg).unwrap();
    let folder = create_folder_op(game.path(), &game.state_path(), "HUD", None, game.cfg).unwrap();
    move_mod_to_folder_op(
        game.path(),
        &game.state_path(),
        "a",
        Some(folder.id.clone()),
        0,
        game.cfg,
    )
    .unwrap();

    game.switch(&one);
    assert_eq!(game.record("a").folder_id, None);
    assert_eq!(order(&game), one_order);
    assert!(game.on_disk_enabled("a"));

    game.switch(&two);
    assert_eq!(
        game.record("a").folder_id.as_deref(),
        Some(folder.id.as_str())
    );
    let in_folder = mods_base(game.path(), paks).join(&folder.disk_name);
    assert!(in_folder.join(&game.record("a").filename).is_file());
}

#[test]
fn a_parked_mod_comes_back_to_its_folder() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    let folder = create_folder_op(game.path(), &game.state_path(), "Maps", None, game.cfg).unwrap();
    move_mod_to_folder_op(
        game.path(),
        &game.state_path(),
        "a",
        Some(folder.id.clone()),
        0,
        game.cfg,
    )
    .unwrap();
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);

    game.switch(&fresh);
    game.switch(&main);

    let a = game.record("a");
    assert_eq!(a.folder_id.as_deref(), Some(folder.id.as_str()));
    let in_folder = mods_base(game.path(), paks).join(&folder.disk_name);
    assert!(in_folder.join(&a.filename).is_file());
}

#[test]
fn switching_folder_mods_moves_them_both_ways() {
    let game = Game::new("pd2");
    let mods = game.cfg.primary();
    game.install(mods, dir_record("Alpha"), None);
    game.install(mods, dir_record("Beta"), None);
    let both = game.create("Both", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    let beta = game.record("Beta");

    game.switch(&fresh);
    assert!(game.live().is_empty());
    assert!(game.stored_path(&beta).join("mod.txt").is_file());

    game.switch(&both);
    assert_eq!(game.enabled(), ["Alpha", "Beta"]);
    assert!(game.on_disk_enabled("Beta"));
}

#[test]
fn switching_ue4ss_mods_writes_mods_txt_and_parks_the_folder() {
    let game = Game::new("pd3");
    let ue4ss = game.cfg.target_for(Some("ue4ss_mods"));
    game.install(ue4ss, dir_record("CoolMod"), None);
    let on = game.create("On", ProfileSource::Current);
    let off = game.create("Off", EMPTY);
    let mods_txt = mods_base(game.path(), ue4ss).join("mods.txt");
    let folder = mods_base(game.path(), ue4ss).join("CoolMod");
    // The loader ships its own mods.txt, and Modrex only ever edits that one.
    fs::write(&mods_txt, "CoolMod : 1\n").unwrap();

    game.switch(&off);
    assert!(!folder.exists());
    assert!(fs::read_to_string(&mods_txt)
        .unwrap()
        .contains("CoolMod : 0"));

    game.switch(&on);
    assert!(folder.join("Scripts/main.lua").is_file());
    assert!(fs::read_to_string(&mods_txt)
        .unwrap()
        .contains("CoolMod : 1"));
}

#[test]
fn switching_crime_boss_mods_moves_them_both_ways() {
    let game = Game::new("cb");
    game.install(game.cfg.primary(), dir_record("Heist"), None);
    let on = game.create("On", ProfileSource::Current);
    let off = game.create("Off", EMPTY);

    game.switch(&off);
    assert!(game.live().is_empty());
    game.switch(&on);
    assert!(game.on_disk_enabled("Heist"));
}

#[test]
fn switching_bundle_mods_parks_their_files_and_brings_them_back() {
    let game = Game::new("cp2077");
    game.install(game.cfg.primary(), record("lights"), None);
    let placed = game.dir.path().join("archive/pc/mod/lights.archive");
    assert!(placed.is_file());
    let on = game.create("On", ProfileSource::Current);
    let off = game.create("Off", EMPTY);

    game.switch(&off);
    assert!(!placed.exists());
    assert!(game.live().is_empty());
    game.switch(&on);
    assert_eq!(fs::read(&placed).unwrap(), b"lights");
}

#[test]
fn a_mod_installed_while_a_profile_is_active_joins_it() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    let main = game.create("Main", ProfileSource::Current);
    let empty = game.create("Nothing", EMPTY);
    game.install(paks, record("new"), None);

    game.switch(&empty);
    game.switch(&main);
    assert_eq!(game.enabled(), ["a", "new"]);
}

#[test]
fn a_profile_survives_an_update_of_its_mod() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("11"), None);
    let main = game.create("Main", ProfileSource::Current);
    let empty = game.create("Nothing", EMPTY);
    game.switch(&empty);
    game.switch(&main);

    // install_mod's sequence for a newer file: the old record goes, the new one continues it.
    let old = game.record("11");
    uninstall_mod_op(game.path(), &game.state_path(), "11", game.cfg).unwrap();
    let mut update = record("12");
    update.inherit_install_id(&old);
    game.install(paks, update, None);

    game.switch(&empty);
    assert!(game.live().is_empty());
    game.switch(&main);
    assert_eq!(game.enabled(), ["12"]);
}

#[test]
fn an_uninstalled_mod_leaves_only_its_own_profile() {
    let game = Game::new("pd3");
    game.install(game.cfg.primary(), record("a"), None);
    let one = game.create("One", ProfileSource::Current);
    let two = game.create(
        "Two",
        ProfileSource::Copy {
            profile_id: one.clone(),
        },
    );
    let gone = game.record("a").install_id;

    forget(&game.store(), &gone).unwrap();

    assert!(game.store().get(&one).unwrap().members.is_empty());
    assert_eq!(game.store().get(&two).unwrap().members.len(), 1);
}

/// The points a switch can be killed at, each leaving what it would on disk.
#[derive(Debug, Clone, Copy)]
enum Killed {
    AfterJournal,
    HalfwayThroughTheToggles,
    ParkedRecordWritten,
    ParkedFilesMoved,
    BeforeMarkingActive,
    BeforeClosingTheJournal,
}

#[test]
fn a_switch_killed_at_any_step_finishes_when_switched_again() {
    for killed in [
        Killed::AfterJournal,
        Killed::HalfwayThroughTheToggles,
        Killed::ParkedRecordWritten,
        Killed::ParkedFilesMoved,
        Killed::BeforeMarkingActive,
        Killed::BeforeClosingTheJournal,
    ] {
        let game = Game::new("pd3");
        let paks = game.cfg.primary();
        game.install(paks, record("a"), None);
        game.install(paks, record("b"), None);
        let main = game.create("Main", ProfileSource::Current);
        let a_only = game.create(
            "A only",
            ProfileSource::Copy {
                profile_id: main.clone(),
            },
        );
        let store = game.store();
        // The copy has a b of its own, which this profile leaves out.
        let mut profile = store.get(&a_only).unwrap();
        let b_copy = profile
            .parked
            .iter()
            .find(|p| p.record.uid == "b")
            .unwrap()
            .clone();
        profile
            .members
            .retain(|m| m.install_id != b_copy.record.install_id);
        profile.parked.retain(|p| p.record.uid != "b");
        fs::remove_file(profile.dir.join(&b_copy.stored)).unwrap();
        store.save(&profile).unwrap();

        store
            .begin(&Journal {
                profile_id: a_only.clone(),
            })
            .unwrap();
        let park_b = |move_files: bool| {
            game.set("b", false);
            let b = game.record("b");
            game.with_install(|install| {
                let slot = install.off_slot(&game.state().folders, &b).unwrap();
                let mut owner = owner_of(&store, &b.install_id).unwrap();
                let stored = stored_name(install, &b, &slot, &owner);
                owner.parked.push(ParkedMod {
                    stored: stored.clone(),
                    record: b.clone(),
                });
                store.save(&owner).unwrap();
                if move_files {
                    install
                        .move_files(&b, slot, owner.dir.join(stored))
                        .unwrap();
                }
            });
        };
        match killed {
            Killed::AfterJournal => {}
            Killed::HalfwayThroughTheToggles => game.set("b", false),
            Killed::ParkedRecordWritten => park_b(false),
            Killed::ParkedFilesMoved => park_b(true),
            Killed::BeforeMarkingActive => game
                .with_install(|install| apply(&store, install, &profile))
                .unwrap(),
            Killed::BeforeClosingTheJournal => {
                game.with_install(|install| apply(&store, install, &profile))
                    .unwrap();
                store.set_active(Some(&a_only)).unwrap();
            }
        }

        let listed = game.list();
        assert_eq!(
            listed.unfinished_switch.as_deref(),
            Some(a_only.as_str()),
            "{killed:?}"
        );

        game.switch(&a_only);
        assert_eq!(game.live(), ["a"], "{killed:?}");
        assert!(game.on_disk_enabled("a"), "{killed:?}");
        assert_eq!(game.parked(), ["a", "b"], "{killed:?}");
        assert!(!store.journal_path().exists(), "{killed:?}");
        let listed = game.list();
        assert_eq!(
            listed.active.as_deref(),
            Some(a_only.as_str()),
            "{killed:?}"
        );
        assert_eq!(listed.unfinished_switch, None, "{killed:?}");
        // The profile the switch left was saved before the journal, so the stop cost it
        // nothing.
        assert_eq!(store.get(&main).unwrap().members.len(), 2, "{killed:?}");

        game.switch(&main);
        assert_eq!(game.enabled(), ["a", "b"], "{killed:?}");
    }
}

/// The points bringing a parked mod back can be killed at.
#[derive(Debug, Clone, Copy)]
enum Unparking {
    RecordRestored,
    FilesMovedBack,
}

#[test]
fn a_parked_mod_brought_back_halfway_is_finished_when_switched_again() {
    for stop in [Unparking::RecordRestored, Unparking::FilesMovedBack] {
        let game = Game::new("pd3");
        let paks = game.cfg.primary();
        game.install(paks, record("a"), None);
        let main = game.create("Main", ProfileSource::Current);
        let fresh = game.create("Fresh", EMPTY);
        game.switch(&fresh);
        let store = game.store();
        store
            .begin(&Journal {
                profile_id: main.clone(),
            })
            .unwrap();
        let a = store.parked().unwrap().remove(0);
        let stored = game.stored_path(&a);
        let mut state = game.state();
        state.mods.push(a.clone());
        save_state(&game.state_path(), &state).unwrap();
        if matches!(stop, Unparking::FilesMovedBack) {
            game.with_install(|install| {
                let slot = install.off_slot(&state.folders, &a).unwrap();
                install.move_files(&a, stored.clone(), slot)
            })
            .unwrap();
        }

        game.switch(&main);

        assert_eq!(game.enabled(), ["a"], "{stop:?}");
        assert!(game.on_disk_enabled("a"), "{stop:?}");
        assert!(game.parked().is_empty(), "{stop:?}");
        assert!(!stored.exists(), "{stop:?}");
    }
}

#[test]
fn the_first_profile_from_the_current_setup_becomes_active_and_keeps_disabled_mods() {
    let game = Game::new("pd3");
    game.install(game.cfg.primary(), record("a"), None);
    game.install(game.cfg.primary(), record("b"), None);
    game.set("b", false);

    let main = game.create("Main", ProfileSource::Current);

    assert_eq!(
        game.store().active().unwrap().as_deref(),
        Some(main.as_str())
    );
    assert_eq!(game.store().get(&main).unwrap().members.len(), 2);
    let dir = game.store().get(&main).unwrap().dir;
    assert_eq!(dir, game.dir.path().join(".modrex/profiles/Main"));
    assert!(dir.join("profile.json").is_file());
    let second = game.create("Second", ProfileSource::Current);
    assert_eq!(
        game.store().active().unwrap().as_deref(),
        Some(main.as_str())
    );
    assert_ne!(second, main);
}

#[test]
fn switching_without_an_active_profile_is_refused_while_mods_would_be_lost() {
    let game = Game::new("pd3");
    game.install(game.cfg.primary(), record("a"), None);
    let empty = game.create("Nothing", EMPTY);

    let switched = game.with_install(|install| switch(&game.store(), install, &empty));

    assert!(switched.unwrap_err().contains("Save the current setup"));
    assert_eq!(game.live(), ["a"]);
}

#[test]
fn deleting_the_active_profile_leaves_the_mods_and_no_profile_active() {
    let game = Game::new("pd3");
    game.install(game.cfg.primary(), record("a"), None);
    let main = game.create("Main", ProfileSource::Current);

    delete(&game.store(), &main).unwrap();

    assert_eq!(game.store().active().unwrap(), None);
    assert!(game.store().list().unwrap().is_empty());
    assert_eq!(game.enabled(), ["a"]);
}

#[test]
fn deleting_a_profile_removes_its_folder_with_its_own_copy_of_the_mods() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    let main = game.create("Main", ProfileSource::Current);
    let twin = game.create(
        "Twin",
        ProfileSource::Copy {
            profile_id: main.clone(),
        },
    );
    let fresh = game.create("Fresh", EMPTY);
    game.switch(&fresh);
    assert_eq!(game.parked(), ["a", "a"]);
    let twin_dir = game.store().get(&twin).unwrap().dir;

    delete(&game.store(), &twin).unwrap();

    assert!(!twin_dir.exists());
    assert_eq!(game.parked(), ["a"]);
    game.switch(&main);
    assert_eq!(game.enabled(), ["a"]);
}

#[test]
fn duplicating_gives_each_profile_its_own_files() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    game.install(paks, record("b"), None);
    game.set("b", false);
    let main = game.create("Main", ProfileSource::Current);
    let original = game.record("a");
    let twin = game.create(
        "Twin",
        ProfileSource::Copy {
            profile_id: main.clone(),
        },
    );

    game.switch(&twin);
    assert_eq!(game.enabled(), ["a"]);
    assert_eq!(game.live(), ["a", "b"]);
    let copy = game.record("a");
    assert_ne!(copy.install_id, original.install_id);
    // A change to the copy stays in its profile.
    let live = active_mod_path(game.path(), &copy.filename, None, paks);
    fs::write(&live, b"changed in the twin").unwrap();

    game.switch(&main);
    let back = active_mod_path(game.path(), &game.record("a").filename, None, paks);
    assert_eq!(fs::read(back).unwrap(), b"a");
    assert_eq!(game.record("a").install_id, original.install_id);
}

#[test]
fn duplicating_a_profile_that_is_not_active_copies_its_stored_files() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    game.switch(&fresh);

    let twin = game.create(
        "Twin",
        ProfileSource::Copy {
            profile_id: main.clone(),
        },
    );

    let stored: Vec<PathBuf> = game
        .store()
        .get(&twin)
        .unwrap()
        .parked
        .iter()
        .map(|p| game.store().get(&twin).unwrap().dir.join(&p.stored))
        .collect();
    assert_eq!(stored.len(), 1);
    assert_eq!(fs::read(&stored[0]).unwrap(), b"a");
    game.switch(&twin);
    assert_eq!(game.enabled(), ["a"]);
}

#[test]
fn profile_folders_follow_profile_names() {
    let game = Game::new("pd3");
    let store = game.store();
    let first = game.create("Main", EMPTY);
    let second = game.create("Main", EMPTY);
    let odd = game.create("CON", EMPTY);
    let dir = |id: &str| store.get(id).unwrap().dir;
    let root = game.dir.path().join(".modrex/profiles");
    assert_eq!(dir(&first), root.join("Main"));
    assert_eq!(dir(&second), root.join("Main (2)"));
    assert_eq!(dir(&odd), root.join("Profile CON"));

    rename(&store, &second, "Stealth: night").unwrap();

    assert_eq!(dir(&second), root.join("Stealth_ night"));
    assert!(!root.join("Main (2)").exists());
    assert_eq!(store.get(&second).unwrap().name, "Stealth: night");

    // A folder that already carries the name stays where it is.
    rename(&store, &first, "main").unwrap();
    assert_eq!(dir(&first), root.join("Main"));
    let third = game.create("Main", EMPTY);
    assert_eq!(dir(&third), root.join("Main (2)"));
    rename(&store, &third, "MAIN").unwrap();
    assert_eq!(dir(&third), root.join("Main (2)"));
}

#[test]
fn duplicating_leaves_out_a_mod_whose_files_are_missing() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    game.install(paks, record("gone"), None);
    let main = game.create("Main", ProfileSource::Current);
    let gone = game.record("gone");
    fs::remove_file(active_mod_path(game.path(), &gone.filename, None, paks)).unwrap();

    let twin = game.create(
        "Twin",
        ProfileSource::Copy {
            profile_id: main.clone(),
        },
    );

    let copied: Vec<String> = game
        .store()
        .get(&twin)
        .unwrap()
        .parked
        .into_iter()
        .map(|p| p.record.uid)
        .collect();
    assert_eq!(copied, ["a"]);
}

#[test]
fn switching_is_refused_while_mods_are_set_aside_for_a_vanilla_launch() {
    let game = Game::new("pd3");
    game.install(game.cfg.primary(), record("a"), None);
    let main = game.create("Main", ProfileSource::Current);
    fs::create_dir_all(vanilla_dir(game.path(), game.cfg.primary())).unwrap();

    let switched = game.with_install(|install| switch(&game.store(), install, &main));
    let created = game
        .with_install(|install| create(&game.store(), install, "Other", ProfileSource::Current));

    assert!(switched.unwrap_err().contains("set aside"));
    assert!(created.unwrap_err().contains("set aside"));
}

#[test]
fn profile_ids_and_names_are_checked_before_use() {
    let game = Game::new("pd3");
    let store = game.store();
    assert!(store.get("../../settings").is_err());
    assert!(rename(&store, "..\\x", "Name").is_err());
    let created = game.with_install(|install| create(&store, install, "   ", EMPTY));
    assert!(created.is_err());
    let long = "x".repeat(NAME_LIMIT + 1);
    let created = game.with_install(|install| create(&store, install, &long, EMPTY));
    assert!(created.is_err());

    let id = game.create("  Spaced  ", EMPTY);
    assert_eq!(store.get(&id).unwrap().name, "Spaced");
    rename(&store, &id, "Renamed").unwrap();
    assert_eq!(store.get(&id).unwrap().name, "Renamed");
}

#[test]
fn stored_mods_get_plain_names_and_a_clash_is_numbered() {
    let game = Game::new("pd3");
    let id = game.create("Main", EMPTY);
    let mut profile = game.store().get(&id).unwrap();
    let hud = InstalledMod {
        filename: "005_HUD.pak.disabled".into(),
        ..record("hud")
    };
    let name = |profile: &Profile| {
        game.with_install(|install| {
            stored_name(install, &hud, Path::new("005_HUD.pak.disabled"), profile)
        })
    };
    assert_eq!(name(&profile), "HUD.pak");
    profile.parked.push(ParkedMod {
        stored: "HUD.pak".into(),
        record: hud.clone(),
    });
    assert_eq!(name(&profile), "HUD (2).pak");
    let settings = InstalledMod {
        filename: "profile.json".into(),
        ..record("settings")
    };
    let clash = game.with_install(|install| {
        stored_name(install, &settings, Path::new("profile.json"), &profile)
    });
    assert_eq!(clash, "profile (2).json");
}

#[test]
fn a_profile_from_a_newer_modrex_is_refused_rather_than_rewritten() {
    let game = Game::new("pd3");
    let id = Uuid::new_v4().to_string();
    let path = game.dir.path().join(".modrex/profiles/Future/profile.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        format!(r#"{{"schemaVersion":99,"id":"{id}","name":"Future","members":[]}}"#),
    )
    .unwrap();

    let err = game.store().get(&id).unwrap_err();
    assert!(err.contains("newer version"), "{err}");
}

#[test]
fn a_switch_that_cannot_finish_does_not_hold_back_a_switch_elsewhere_or_leak_into_a_profile() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    game.install(paks, record("b"), None);
    game.set("b", false);
    let main = game.create("Main", ProfileSource::Current);
    let other = game.create(
        "Other",
        ProfileSource::Copy {
            profile_id: main.clone(),
        },
    );
    game.switch(&other);
    game.set("a", false);
    game.set("b", true);
    game.switch(&main);
    let main_members = game.store().get(&main).unwrap().members;

    // A second copy of b at its active path makes enabling it fail, as a file the game or an
    // antivirus holds open would, after a has already been turned off.
    let b = game.record("b");
    let stray = active_mod_path(game.path(), &b.filename, None, paks);
    fs::write(&stray, b"copy").unwrap();
    let failed = game.with_install(|install| switch(&game.store(), install, &other));
    assert!(failed.is_err());
    assert!(game.enabled().is_empty());
    let listed = game.list();
    assert_eq!(listed.unfinished_switch.as_deref(), Some(other.as_str()));

    let created = game
        .with_install(|install| create(&game.store(), install, "Mixed", ProfileSource::Current));
    assert!(created.unwrap_err().contains("stopped part way"));
    assert!(delete(&game.store(), &other)
        .unwrap_err()
        .contains("stopped part way"));

    game.switch(&main);
    assert_eq!(game.enabled(), ["a"]);
    assert!(!game.store().journal_path().exists());
    assert_eq!(game.store().get(&main).unwrap().members, main_members);
    assert_eq!(game.list().unfinished_switch, None);

    fs::remove_file(&stray).unwrap();
    game.switch(&other);
    assert_eq!(game.enabled(), ["b"]);
}

/// Every file below the game folder with its contents, to show a switch touched nothing.
fn disk(game: &Game) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, root, out);
                continue;
            }
            out.push((
                path.strip_prefix(root).unwrap().to_path_buf(),
                fs::read(&path).unwrap(),
            ));
        }
    }
    let mut out = Vec::new();
    walk(game.dir.path(), game.dir.path(), &mut out);
    out.sort();
    out
}

#[test]
fn switching_to_the_profile_already_applied_changes_nothing_on_disk() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    for uid in ["a", "b", "c"] {
        game.install(paks, record(uid), None);
    }
    let folder = create_folder_op(game.path(), &game.state_path(), "HUD", None, game.cfg).unwrap();
    move_mod_to_folder_op(
        game.path(),
        &game.state_path(),
        "b",
        Some(folder.id),
        0,
        game.cfg,
    )
    .unwrap();
    game.set("c", false);
    let main = game.create("Main", ProfileSource::Current);
    let empty = game.create("Nothing", EMPTY);
    game.switch(&empty);
    game.switch(&main);
    let before = disk(&game);

    game.switch(&main);

    assert_eq!(disk(&game), before);
}

#[test]
fn a_disabled_member_returns_to_its_own_folder() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    game.install(paks, record("c"), None);
    let folder = create_folder_op(game.path(), &game.state_path(), "Maps", None, game.cfg).unwrap();
    move_mod_to_folder_op(
        game.path(),
        &game.state_path(),
        "c",
        Some(folder.id.clone()),
        0,
        game.cfg,
    )
    .unwrap();
    game.set("c", false);
    let kept_off = game.create("Kept off", ProfileSource::Current);
    let at_root = game.create(
        "At root",
        ProfileSource::Copy {
            profile_id: kept_off.clone(),
        },
    );
    game.switch(&at_root);
    move_mod_to_folder_op(game.path(), &game.state_path(), "c", None, 0, game.cfg).unwrap();
    game.set("c", true);

    game.switch(&kept_off);

    let c = game.record("c");
    assert_eq!(c.folder_id.as_deref(), Some(folder.id.as_str()));
    assert!(!game.on_disk_enabled("c"));
    let in_folder = disabled_mod_path(game.path(), &c.filename, Some(&folder.disk_name), paks);
    assert!(in_folder.is_file(), "{}", in_folder.display());

    game.switch(&at_root);
    assert_eq!(game.record("c").folder_id, None);
    assert!(game.on_disk_enabled("c"));
}

#[test]
fn a_mod_whose_files_are_gone_does_not_stop_a_switch() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    game.install(paks, record("b"), None);
    let main = game.create("Main", ProfileSource::Current);
    let empty = game.create("Nothing", EMPTY);
    let b = game.record("b");
    fs::remove_file(active_mod_path(game.path(), &b.filename, None, paks)).unwrap();

    game.switch(&empty);
    assert_eq!(game.live(), ["b"]);
    assert_eq!(game.record("b").missing, Some(true));
    game.switch(&main);
    assert_eq!(game.enabled(), ["a", "b"]);
}

#[test]
fn a_missing_mod_does_not_change_what_any_profile_wants() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    game.install(paks, record("b"), None);
    let main = game.create("Main", ProfileSource::Current);
    let empty = game.create("Nothing", EMPTY);
    let b = game.record("b");
    let b_path = active_mod_path(game.path(), &b.filename, None, paks);
    let bytes = fs::read(&b_path).unwrap();
    fs::remove_file(&b_path).unwrap();

    game.switch(&empty);
    game.switch(&main);
    assert!(game.store().get(&empty).unwrap().members.is_empty());

    fs::write(&b_path, bytes).unwrap();
    game.switch(&empty);
    assert!(game.live().is_empty());
    assert_eq!(game.parked(), ["a", "b"]);
}

#[test]
fn a_folder_the_profile_does_not_list_leaves_the_mod_at_the_top_level() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    let root = game.create("Root", ProfileSource::Current);
    let foldered = game.create(
        "Foldered",
        ProfileSource::Copy {
            profile_id: root.clone(),
        },
    );
    game.switch(&foldered);
    let folder = create_folder_op(game.path(), &game.state_path(), "Gone", None, game.cfg).unwrap();
    move_mod_to_folder_op(
        game.path(),
        &game.state_path(),
        "a",
        Some(folder.id.clone()),
        0,
        game.cfg,
    )
    .unwrap();
    game.switch(&root);
    // A profile saved before profiles kept folders names the folder without listing it.
    let store = game.store();
    let mut profile = store.get(&foldered).unwrap();
    profile.folders.clear();
    store.save(&profile).unwrap();

    game.switch(&foldered);

    assert_eq!(game.record("a").folder_id, None);
    assert!(game.state().folders.is_empty());
    assert!(game.on_disk_enabled("a"));
}

#[test]
fn each_profile_has_its_own_folders_and_a_new_one_has_none() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    let hud = create_folder_op(game.path(), &game.state_path(), "HUD", None, game.cfg).unwrap();
    move_mod_to_folder_op(
        game.path(),
        &game.state_path(),
        "a",
        Some(hud.id.clone()),
        0,
        game.cfg,
    )
    .unwrap();
    let spare = create_folder_op(game.path(), &game.state_path(), "Spare", None, game.cfg).unwrap();
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    let in_paks = |disk_name: &str| mods_base(game.path(), paks).join(disk_name);

    game.switch(&fresh);
    assert!(game.state().folders.is_empty());
    assert!(!in_paks(&hud.disk_name).exists());
    assert!(!in_paks(&spare.disk_name).exists());
    let maps = create_folder_op(game.path(), &game.state_path(), "Maps", None, game.cfg).unwrap();

    game.switch(&main);
    let names = |game: &Game| sorted(game.state().folders.into_iter().map(|f| f.display_name));
    assert_eq!(names(&game), ["HUD", "Spare"]);
    assert_eq!(game.record("a").folder_id.as_deref(), Some(hud.id.as_str()));
    // An empty folder keeps its directory, or the next scan would drop it.
    assert!(in_paks(&spare.disk_name).is_dir());
    game.with_install(|install| install.scan()).unwrap();
    assert_eq!(names(&game), ["HUD", "Spare"]);

    game.switch(&fresh);
    assert_eq!(names(&game), ["Maps"]);
    assert!(in_paks(&maps.disk_name).is_dir());
}

// A new profile starts over, loaders included. Its mods need PDML installed in it again.
#[test]
fn a_loader_tracked_as_a_mod_is_left_out_of_a_new_profile() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(
        paks,
        InstalledMod {
            source: "modworkshop".to_string(),
            remote_id: Some("59255".to_string()),
            ..record("pdml")
        },
        None,
    );
    game.install(paks, record("a"), None);
    let main = game.create("Main", ProfileSource::Current);
    let empty = game.create("Nothing", EMPTY);

    game.switch(&empty);
    assert!(game.live().is_empty());
    assert_eq!(game.parked(), ["a", "pdml"]);

    game.switch(&main);
    assert_eq!(game.enabled(), ["a", "pdml"]);
}

#[test]
fn a_profile_folder_copied_by_hand_is_refused_rather_than_saved_over() {
    let game = Game::new("pd3");
    let store = game.store();
    let a = game.create("A", EMPTY);
    let a_dir = store.get(&a).unwrap().dir;
    let copy = a_dir.with_file_name("A - Copy");
    fs::create_dir_all(&copy).unwrap();
    let bytes = fs::read(a_dir.join("profile.json")).unwrap();
    fs::write(copy.join("profile.json"), &bytes).unwrap();

    assert!(rename(&store, &a, "Renamed")
        .unwrap_err()
        .contains("hold the same profile"));
    assert_eq!(fs::read(a_dir.join("profile.json")).unwrap(), bytes);
}

#[test]
fn a_disabled_folder_mod_found_on_disk_keeps_its_record_across_scans() {
    let game = Game::new("pd2");
    game.install(game.cfg.primary(), dir_record("Hand placed"), None);
    let id = game.record("Hand placed").install_id;
    game.set("Hand placed", false);

    for _ in 0..2 {
        game.with_install(|install| install.scan()).unwrap();
    }

    let kept = game.record("Hand placed");
    assert_eq!(kept.install_id, id);
    assert!(!kept.enabled);
}

const KEEP_LOADERS: ProfileSource = ProfileSource::Empty { keep_loaders: true };

#[test]
fn a_new_profile_leaves_superblt_out_unless_it_keeps_the_loaders() {
    let game = Game::new("pd2");
    let hook = game.put("WSOCK32.dll", b"superblt");
    game.install(game.cfg.primary(), dir_record("Alpha"), None);
    let main = game.create("Main", ProfileSource::Current);
    assert_eq!(game.list().loaders, ["SuperBLT"]);
    let fresh = game.create("Fresh", EMPTY);
    let kept = game.create("With loaders", KEEP_LOADERS);

    game.switch(&fresh);
    assert!(!hook.exists());
    assert_eq!(
        fs::read(game.parked_loader("superblt", "WSOCK32.dll")).unwrap(),
        b"superblt"
    );
    assert!(game.list().loaders.is_empty());

    game.switch(&kept);
    assert_eq!(fs::read(&hook).unwrap(), b"superblt");
    assert!(game.live().is_empty());
    assert!(!game.parked_loader("superblt", "WSOCK32.dll").exists());

    game.switch(&fresh);
    game.switch(&main);
    assert!(hook.is_file());
    assert_eq!(game.enabled(), ["Alpha"]);
}

// Only the proxy DLL hooks UE4SS in. Its engine and Mods folder, which holds mods that are
// profile members of their own, stay where they are.
#[test]
fn a_new_profile_parks_only_the_ue4ss_proxy() {
    let game = Game::on("pd3", "steam");
    let proxy = game.put("PAYDAY3/Binaries/Win64/dwmapi.dll", b"proxy");
    let engine = game.put("PAYDAY3/Binaries/Win64/UE4SS/UE4SS.dll", b"engine");
    let installed =
        |game: &Game| crate::commands::ue4ss::is_installed("pd3", game.path(), game.launcher);
    assert!(installed(&game));
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);

    game.switch(&fresh);
    assert!(!proxy.exists());
    assert!(engine.is_file());
    assert!(!installed(&game));

    game.switch(&main);
    assert_eq!(fs::read(&proxy).unwrap(), b"proxy");
    assert!(installed(&game));
}

// DAHM's payload is loaded by a dinput8.dll proxy other loaders ship too, so without a record
// of what DAHM installed nothing tells which files would turn it off.
#[test]
fn dahm_installed_without_a_record_stays_for_every_profile() {
    let game = Game::new("pdth");
    let payload = game.put("pdthhook.dll", b"dahm");
    game.install(game.cfg.primary(), dir_record("Alpha"), None);
    game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    assert!(game.list().loaders.is_empty());

    game.switch(&fresh);

    assert!(payload.is_file());
}

#[test]
fn dahm_installed_by_modrex_parks_every_file_its_install_created() {
    let game = Game::new("pdth");
    let payload = game.put("pdthhook.dll", b"dahm");
    let proxy = game.put("dinput8.dll", b"proxy");
    let module = game.put("mods/DAHM Core/base.lua", b"-- core");
    let record = game.dir.path().join(".modrex/loaders/dahm.json");
    fs::create_dir_all(record.parent().unwrap()).unwrap();
    fs::write(
        &record,
        r#"{"files":["pdthhook.dll","dinput8.dll","mods/DAHM Core/base.lua"]}"#,
    )
    .unwrap();
    game.install(game.cfg.primary(), dir_record("Alpha"), None);
    let main = game.create("Main", ProfileSource::Current);
    assert_eq!(game.list().loaders, ["DAHM"]);
    let fresh = game.create("Fresh", EMPTY);

    game.switch(&fresh);
    assert!(!payload.exists() && !proxy.exists() && !module.exists());
    assert!(!game.dir.path().join("mods/DAHM Core").exists());

    game.switch(&main);
    assert_eq!(fs::read(&payload).unwrap(), b"dahm");
    assert_eq!(fs::read(&proxy).unwrap(), b"proxy");
    assert_eq!(fs::read(&module).unwrap(), b"-- core");
}

#[test]
fn keeping_the_loaders_keeps_a_loader_tracked_as_a_mod() {
    let game = Game::new("pd3");
    let paks = game.cfg.primary();
    game.install(
        paks,
        InstalledMod {
            source: "modworkshop".to_string(),
            remote_id: Some("59255".to_string()),
            ..record("pdml")
        },
        None,
    );
    game.install(paks, record("a"), None);
    game.create("Main", ProfileSource::Current);
    assert_eq!(game.list().loaders, ["PDML"]);
    let main_pdml = game.record("pdml").install_id;
    let kept = game.create("With loaders", KEEP_LOADERS);

    game.switch(&kept);

    // The new profile has its own copy, and Main keeps its own.
    assert_eq!(game.enabled(), ["pdml"]);
    assert_ne!(game.record("pdml").install_id, main_pdml);
    assert_eq!(game.parked(), ["a", "pdml"]);
}

#[test]
fn a_profile_saved_before_profiles_held_loaders_leaves_them_as_they_are() {
    let game = Game::new("pd2");
    let hook = game.put("WSOCK32.dll", b"superblt");
    game.create("Main", ProfileSource::Current);
    let old = game.create("Old", ProfileSource::Current);
    let store = game.store();
    let mut profile = store.get(&old).unwrap();
    profile.loaders = None;
    store.save(&profile).unwrap();

    game.switch(&old);

    assert!(hook.is_file());
}

#[test]
fn switching_without_an_active_profile_is_refused_while_a_loader_would_be_lost() {
    let game = Game::new("pd2");
    let hook = game.put("WSOCK32.dll", b"superblt");
    let fresh = game.create("Fresh", EMPTY);

    let switched = game.with_install(|install| switch(&game.store(), install, &fresh));

    assert!(switched.unwrap_err().contains("Save the current setup"));
    assert!(hook.is_file());
}

#[test]
fn deleting_the_only_profile_with_a_parked_loader_removes_its_files() {
    let game = Game::new("pd2");
    game.put("WSOCK32.dll", b"superblt");
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    game.switch(&fresh);
    assert!(game.parked_loader("superblt", "WSOCK32.dll").is_file());

    delete(&game.store(), &main).unwrap();

    assert!(!game.parked_loader("superblt", "").exists());
}

// A loader installed again while it was parked is the copy in use, so bringing the parked one
// back must not overwrite it.
#[test]
fn a_loader_installed_again_while_parked_keeps_the_new_copy() {
    let game = Game::new("pd2");
    let hook = game.put("WSOCK32.dll", b"old");
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    game.switch(&fresh);
    fs::write(&hook, b"new").unwrap();

    game.switch(&main);

    assert_eq!(fs::read(&hook).unwrap(), b"new");
    assert!(!game.parked_loader("superblt", "").exists());
}

/// A Microsoft Store copy of Ready or Not, whose guard trusts only the files Modrex recorded.
fn ready_or_not() -> Game {
    let game = Game::new("ron");
    game.put("MicrosoftGame.config", b"<Game/>");
    game
}

#[test]
fn ready_or_not_mods_leave_paks_for_their_profile_and_come_back() {
    let game = ready_or_not();
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    game.install(paks, record("b"), None);
    game.set("b", false);
    let main = game.create("Main", ProfileSource::Current);
    let fresh = game.create("Fresh", EMPTY);
    let records = game.state().mods;

    game.switch(&fresh);

    assert!(game.live().is_empty());
    for m in &records {
        assert!(game.stored_path(m).is_file(), "{}", m.uid);
        assert!(!active_mod_path(game.path(), &m.filename, None, paks).exists());
        assert!(!disabled_mod_path(game.path(), &m.filename, None, paks).exists());
    }

    game.switch(&main);
    assert_eq!(game.live(), ["a", "b"]);
    assert_eq!(game.enabled(), ["a"]);
    assert!(game.on_disk_enabled("a"));
    assert!(!game.on_disk_enabled("b"));
}

#[test]
fn ready_or_not_duplicates_get_their_own_files() {
    let game = ready_or_not();
    let paks = game.cfg.primary();
    game.install(paks, record("a"), None);
    let main = game.create("Main", ProfileSource::Current);
    let original = game.record("a").install_id;
    let twin = game.create(
        "Twin",
        ProfileSource::Copy {
            profile_id: main.clone(),
        },
    );

    game.switch(&twin);

    assert_eq!(game.enabled(), ["a"]);
    assert_ne!(game.record("a").install_id, original);
    game.switch(&main);
    assert_eq!(game.record("a").install_id, original);
}

#[test]
fn the_guard_lets_a_shared_paks_mod_leave_only_for_the_profile_store() {
    let game = ready_or_not();
    game.install(game.cfg.primary(), record("a"), None);
    let guard = NativeGuard::load(game.path(), game.cfg).unwrap();
    let modrex = game.dir.path().join(".modrex");
    assert!(guard
        .check_file(&modrex.join("profiles/Main/a.pak"))
        .is_ok());
    assert!(guard
        .check_file(&modrex.join("profiles/Main/notes.txt"))
        .is_err());
    for outside in ["elsewhere/a.pak", "loaders/a.pak"] {
        let err = guard.check_file(&modrex.join(outside)).unwrap_err();
        assert!(err.contains("leaves its shared Paks"), "{outside}: {err}");
    }
}
