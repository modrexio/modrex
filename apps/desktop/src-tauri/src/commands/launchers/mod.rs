mod epic;
mod games;
mod steam;
mod types;
mod xbox;

use epic::Epic;
pub(crate) use games::{CRIMEBOSS, PD2, PD3, PDTH, RAID};
use steam::Steam;
pub(crate) use types::GameDef;
use types::Launcher;
use xbox::Xbox;

use crate::commands::mods::{
    backup_dir, engine_for_game, get_state_path, mods_base, read_state, ModEngineConfig,
};
use crate::commands::settings::{game_settings, read_settings, update_settings, GameSettings};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

static STEAM: Steam = Steam;
static EPIC: Epic = Epic;
static XBOX: Xbox = Xbox;

const PD3_XBOX_CRASH_REPORTER_FILES: &[&str] = &["BsSndRpt64.exe", "BugSplatRc64.dll"];

fn all_launchers() -> [&'static dyn Launcher; 3] {
    [&STEAM, &EPIC, &XBOX]
}

fn game_def_for_id(game_id: &str) -> Result<&'static GameDef, String> {
    crate::commands::games::game_spec(game_id)
        .map(|s| s.def)
        .ok_or_else(|| format!("unknown game id '{game_id}'"))
}

// A stalled find_game leaves no trace in Modrex.log without the probe line before it.
fn probe_installs(game: &'static GameDef) -> Vec<DetectedInstall> {
    let mut found = Vec::new();
    for launcher in all_launchers() {
        if !launcher.is_installed() {
            continue;
        }
        log::info!("probing {} for {}", launcher.id(), game.name);
        if let Some(game_path) = launcher.find_game(game) {
            log::info!("found {} via {}: {game_path}", game.name, launcher.id());
            found.push(DetectedInstall {
                launcher: launcher.id().to_string(),
                game_path,
            });
        }
    }
    found
}

fn probe_one(game: &'static GameDef, launcher_id: &str) -> Option<String> {
    let launcher = all_launchers()
        .into_iter()
        .find(|l| l.id() == launcher_id)?;
    if !launcher.is_installed() {
        return None;
    }
    log::info!("probing {} for {}", launcher.id(), game.name);
    let path = launcher.find_game(game)?;
    log::info!("found {} via {}: {path}", game.name, launcher.id());
    Some(path)
}

/// How many mods a copy tracks. Counted rather than testing for the mod list file, because
/// save_state creates that file in whichever copy is pointed at, even briefly and even when
/// it finds nothing: a copy that was selected by mistake for one session comes out of that
/// looking exactly like the one being modded.
fn tracked_mod_count(game_path: &str, cfg: &ModEngineConfig) -> usize {
    let live = read_state(&get_state_path(game_path, cfg)).mods.len();
    if live > 0 {
        return live;
    }
    // Launching without mods renames the whole folder for pak games, so until the next
    // launch restores it the list lives inside the backup instead.
    read_state(&backup_dir(game_path, cfg.primary()).join(cfg.state_filename))
        .mods
        .len()
}

/// The copy to settle on when nothing has been settled yet. Copies from two stores share no
/// files, so choosing the wrong one makes an installed mod list read as empty, and the only
/// thing that says which one is in use is how much each one tracks. Ties, and the case where
/// nothing is modded anywhere, fall back to the launcher already recorded, then to
/// registration order.
fn pick_install(
    installs: &[DetectedInstall],
    cfg: &ModEngineConfig,
    recorded: Option<&str>,
) -> Option<DetectedInstall> {
    let counts: Vec<usize> = installs
        .iter()
        .map(|install| tracked_mod_count(&install.game_path, cfg))
        .collect();
    let most = counts.iter().copied().max().unwrap_or(0);
    let candidates: Vec<&DetectedInstall> = installs
        .iter()
        .zip(&counts)
        .filter(|(_, count)| most == 0 || **count == most)
        .map(|(install, _)| install)
        .collect();

    candidates
        .iter()
        .find(|install| Some(install.launcher.as_str()) == recorded)
        .or_else(|| candidates.first())
        .map(|install| (*install).clone())
}

// ── OS helpers ────────────────────────────────────────────────────────────────

// reg and Get-AppxPackage hang forever when their backing service is wedged, so this
// polls with a deadline and kills instead of taking .output()'s unbounded wait. Callers'
// output is a single line, so reading stdout only after exit cannot fill the pipe.
#[cfg(target_os = "windows")]
pub(super) fn run_bounded(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
) -> Option<String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    let mut child = cmd
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut out);
                }
                return Some(out);
            }
            Ok(None) if std::time::Instant::now() >= deadline => {
                log::warn!("detection subprocess timed out after {timeout:?}: {cmd:?}");
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

/// Strips the loader overrides an AppImage run leaves in the environment. AppRun points
/// LD_LIBRARY_PATH at the libraries inside the mounted image, and users working around
/// graphics bugs add LD_PRELOAD on top. Anything spawned from here inherits both and loads
/// our copies instead of its own, which is how a browser or Steam launched from Modrex
/// fails to start at all.
pub(crate) fn outside_bundle(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some() {
        cmd.env_remove("LD_LIBRARY_PATH").env_remove("LD_PRELOAD");
    }
    cmd
}

pub(super) fn open_url(url: &str) {
    // Never route this through cmd /c start: cmd re-parses its command line,
    // so a & in a query string truncates the URL there and executes what
    // follows as a command, and %..% sequences risk variable expansion.
    // explorer.exe is no good either: it validates its argument and falls back
    // to opening the Documents folder for URLs it considers malformed, which
    // includes query strings. rundll32's FileProtocolHandler takes the URL as
    // one argument and hands it to the shell's URL handler unmodified.
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(not(target_os = "windows"))]
    let spawned = outside_bundle(std::process::Command::new("xdg-open").arg(url)).spawn();
    // A missing xdg-open otherwise looks exactly like a dead button in the UI.
    if let Err(e) = spawned {
        log::warn!("could not hand a url to the system opener: {e}");
    }
}

fn open_path_on_system(path: &str) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(not(target_os = "windows"))]
    let _ = outside_bundle(std::process::Command::new("xdg-open").arg(path)).spawn();
}

// ── Orchestration ─────────────────────────────────────────────────────────────

pub fn identify_launcher_for_path(game_path: &str) -> String {
    for launcher in all_launchers() {
        if launcher.identify_path(game_path) {
            return launcher.id().to_string();
        }
    }
    "manual".to_string()
}

fn launch_with(launcher_id: &str, game: &'static GameDef, game_path: &str, opts: Option<&str>) {
    if let Some(launcher) = all_launchers().iter().find(|l| l.id() == launcher_id) {
        launcher.launch(game, game_path, opts);
    } else {
        let exe_name = game
            .resolve_executable(game_path)
            .unwrap_or(game.executables[0]);
        let exe = Path::new(game_path).join(exe_name);
        let args: Vec<&str> = opts
            .map(|o| o.split_whitespace().collect())
            .unwrap_or_default();
        if let Err(e) = outside_bundle(std::process::Command::new(&exe).args(&args)).spawn() {
            log::warn!("launch_game: spawn {exe:?}: {e}");
        }
    }
}

fn pd3_xbox_crash_reporter_dir(game_path: &Path) -> std::path::PathBuf {
    game_path.join("PAYDAY3").join("Binaries").join("WinGDK")
}

fn remove_pd3_xbox_crash_reporter_files(game_path: &str) {
    let game_path = Path::new(game_path);
    let dir = pd3_xbox_crash_reporter_dir(game_path);

    for filename in PD3_XBOX_CRASH_REPORTER_FILES {
        let file = dir.join(filename);
        if !file.starts_with(game_path) || !file.exists() {
            continue;
        }
        match fs::remove_file(&file) {
            Ok(()) => log::info!("removed PAYDAY 3 Xbox crash reporter file {file:?}"),
            Err(e) => log::warn!("remove PAYDAY 3 Xbox crash reporter file {file:?}: {e}"),
        }
    }
}

fn maybe_suppress_crash_reporter(game_id: &str, settings: &GameSettings) {
    if game_id != "pd3"
        || settings.launcher.as_deref() != Some("xbox")
        || !settings.suppress_crash_reporter
    {
        return;
    }

    if let Some(game_path) = settings.game_path.as_deref() {
        remove_pd3_xbox_crash_reporter_files(game_path);
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// One store's copy of a game. A game owned on two stores has two of these, installed
/// side by side and modded independently, so a launcher is only ever meaningful paired
/// with the path it was found at.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedInstall {
    pub launcher: String,
    pub game_path: String,
}

// Every copy, not just the first one found: this is what the launcher picker in Settings
// switches between, and it can only switch the game path along with the launcher if it
// knows where each store's copy lives.
//
// Detection stats paths on every drive and Steam library, which blocks for the
// SMB timeout on a dead network drive, sync commands run on the main thread,
// so all detection work goes through spawn_blocking.
#[tauri::command]
#[specta::specta]
pub async fn detected_installs(game_id: String) -> Result<Vec<DetectedInstall>, String> {
    let game = game_def_for_id(game_id.as_str())?;
    tauri::async_runtime::spawn_blocking(move || probe_installs(game))
        .await
        .map_err(|e| e.to_string())
}

/// Which games have a copy on this machine. Read-only, unlike configure_game_path:
/// greying out a card must not settle which copy a game uses.
#[tauri::command]
#[specta::specta]
pub async fn detect_installed_games(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = read_settings(&app);
        crate::commands::games::GAME_REGISTRY
            .iter()
            .filter(|spec| {
                let existing = game_settings(&settings, spec.id)
                    .cloned()
                    .unwrap_or_default();
                resolve_install(spec.def, spec.engine, &existing)
                    .0
                    .is_some()
            })
            .map(|spec| spec.id.to_string())
            .collect()
    })
    .await
    .map_err(|e| format!("installed-game detection failed to run: {e}"))
}

/// What re-detection has to do for a game, decided before any store is probed so that the
/// decision itself can be reasoned about without a machine's installs in the way.
#[derive(Debug, PartialEq)]
enum Resolution {
    /// The settled copy is where it was recorded. Nothing is probed, which is the steady
    /// state for every refresh once a game has been used once.
    Keep,
    /// The settled copy is not there. Look for it under its own launcher and nowhere else:
    /// a relocated Steam library is still found, while a copy that is only mid-update
    /// reports missing and is picked up again later instead of the game being handed to
    /// another store.
    Refind(String),
    /// Settled on a copy that no store can be asked about, and it is gone. Reporting it
    /// missing keeps the launcher, so nothing else can claim the game in the meantime.
    Missing,
    /// Not settled yet, including every game saved before copies were tracked at all.
    /// Probe every store and choose once.
    Settle,
}

fn is_store_launcher(id: &str) -> bool {
    all_launchers().iter().any(|launcher| launcher.id() == id)
}

fn saved_path_valid(game_def: &GameDef, existing: &GameSettings) -> bool {
    existing
        .game_path
        .as_deref()
        .is_some_and(|path| game_def.is_installation(path))
}

fn plan_resolution(game_def: &GameDef, existing: &GameSettings) -> Resolution {
    if !existing.install_pinned {
        return Resolution::Settle;
    }
    if saved_path_valid(game_def, existing) {
        return Resolution::Keep;
    }
    match existing.launcher.as_deref() {
        Some(id) if is_store_launcher(id) => Resolution::Refind(id.to_string()),
        _ => Resolution::Missing,
    }
}

/// Which copy of the game to use, and whether that choice is now settled.
fn resolve_install(
    game_def: &'static GameDef,
    cfg: &ModEngineConfig,
    existing: &GameSettings,
) -> (Option<String>, Option<String>, bool) {
    match plan_resolution(game_def, existing) {
        Resolution::Keep => {
            // Re-running identify_launcher_for_path on every focus clobbers games without marker files.
            let launcher = existing.launcher.clone().or_else(|| {
                existing
                    .game_path
                    .as_deref()
                    .map(identify_launcher_for_path)
            });
            (existing.game_path.clone(), launcher, true)
        }
        Resolution::Refind(id) => (probe_one(game_def, &id), Some(id), true),
        Resolution::Missing => (None, existing.launcher.clone(), true),
        Resolution::Settle => {
            let installs = probe_installs(game_def);
            match pick_install(&installs, cfg, existing.launcher.as_deref()) {
                Some(best) => (Some(best.game_path), Some(best.launcher), true),
                // No store has it, but a folder picked by hand is still a usable copy.
                None if saved_path_valid(game_def, existing) => {
                    (existing.game_path.clone(), existing.launcher.clone(), true)
                }
                None => (None, None, false),
            }
        }
    }
}

fn resolve_and_save_game_path(
    app: &AppHandle,
    game_id: String,
    game_path: Option<String>,
) -> Result<(), String> {
    let game_def = game_def_for_id(&game_id)?;
    let cfg = engine_for_game(&game_id)?;
    // Path validation and detection can stall for seconds (SMB timeouts, wedged services),
    // so resolve first and take the settings lock only to apply the result. Sync commands
    // on the main thread must never wait behind a probe.
    let (resolved_path, resolved_launcher, pinned) = if let Some(path) = game_path {
        // A hand-picked folder is checked here rather than accepted outright: the
        // auto-detect branch below re-validates every saved path on each refresh, so an
        // unvalidated wrong pick is dropped a moment later with nothing telling the user
        // why. Rejecting up front is what surfaces the error.
        if !game_def.is_installation(&path) {
            return Err(format!(
                "'{path}' is not a {} installation (no {} in it)",
                game_def.name,
                game_def.executables.join(" or ")
            ));
        }
        // Choosing the folder is choosing the copy, so it settles the game the same way
        // picking a launcher does.
        let launcher = identify_launcher_for_path(&path);
        (Some(path), Some(launcher), true)
    } else {
        let existing = game_settings(&read_settings(app), &game_id)
            .cloned()
            .unwrap_or_default();
        resolve_install(game_def, cfg, &existing)
    };
    update_settings(app, |s| {
        let entry = s
            .games
            .get_or_insert_with(HashMap::new)
            .entry(game_id)
            .or_default();
        entry.game_path = resolved_path;
        entry.launcher = resolved_launcher;
        entry.install_pinned = pinned;
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn configure_game_path(
    app: AppHandle,
    game_id: String,
    game_path: Option<String>,
) -> Result<(), String> {
    let index_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        resolve_and_save_game_path(&app, game_id, game_path)
    })
    .await
    .map_err(|e| format!("game path resolution failed to run: {e}"))??;
    tauri::async_runtime::spawn(async move {
        crate::commands::mod_index::ensure_index(index_app).await;
    });
    Ok(())
}

/// Points a game at one specific store's copy, moving the game path and the launcher
/// together. The launcher is recorded as chosen rather than re-derived from the folder's
/// marker files: a Steam PAYDAY 3 folder carries no steam_appid.txt, so deriving it would
/// downgrade a deliberate choice to manual and launch the wrong copy.
///
/// The path comes from a detected_installs probe the renderer already ran, so switching
/// costs no new probing. It is re-checked here because that probe is cached for the
/// session and the folder can be gone by now.
#[tauri::command]
#[specta::specta]
pub async fn select_game_install(
    app: AppHandle,
    game_id: String,
    launcher: String,
    game_path: String,
) -> Result<(), String> {
    let game_def = game_def_for_id(&game_id)?;
    if !all_launchers().iter().any(|l| l.id() == launcher) {
        return Err(format!("unknown launcher '{launcher}'"));
    }
    let index_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !game_def.is_installation(&game_path) {
            return Err(format!(
                "'{game_path}' is no longer a {} installation",
                game_def.name
            ));
        }
        update_settings(&app, |s| {
            let entry = s
                .games
                .get_or_insert_with(HashMap::new)
                .entry(game_id)
                .or_default();
            entry.game_path = Some(game_path);
            entry.launcher = Some(launcher);
            entry.install_pinned = true;
        });
        Ok(())
    })
    .await
    .map_err(|e| format!("install switch failed to run: {e}"))??;
    // The other copy may be for a game whose index was skipped at startup, when the
    // then-saved path was stale.
    tauri::async_runtime::spawn(async move {
        crate::commands::mod_index::ensure_index(index_app).await;
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
// title comes from the renderer already localized and already naming the active game.
// Building it here would hardcode English and name one fixed game rather than whichever
// of the five is being configured.
pub async fn pick_folder(
    app: AppHandle,
    title: String,
    default_path: Option<String>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file().set_title(title);
        if let Some(ref path) = default_path {
            builder = builder.set_directory(path);
        }
        builder.blocking_pick_folder().map(|p| p.to_string())
    })
    .await
    .ok()?
}

// Loader-created runtime dirs safe to drop from a stranded backup on restore: pure caches/logs the
// loader regenerates. Deliberately narrower than a target's full excluded_names: saves/ (mod
// user data) and base/ are on that list too but must never be auto-deleted.
const DISPOSABLE_BACKUP_DIRS: &[&str] = &["logs", "downloads"];

fn do_restore(game_path: &str, cfg: &crate::commands::mods::ModEngineConfig) -> Result<(), String> {
    for target in cfg.targets {
        let mods_dir = mods_base(game_path, target);
        let mods_bak = backup_dir(game_path, target);

        if !mods_bak.exists() {
            continue;
        }

        if target.is_directory_unit() {
            let _ = fs::create_dir_all(&mods_dir);
            if let Ok(entries) = fs::read_dir(&mods_bak) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let dest = mods_dir.join(&name);
                    // A disposable runtime dir (BLT's logs/downloads) backed up and then
                    // recreated in mods/ while the game ran cannot rename back over the
                    // fresh copy, stranding mods.bak and pinning the "mods hidden" banner.
                    // These are regenerated caches, so dropping the stale backup clears it.
                    // saves/ and base/ are excluded: user data is never auto-deleted.
                    let name_str = name.to_string_lossy();
                    if dest.exists()
                        && target.excluded_names().contains(&name_str.as_ref())
                        && DISPOSABLE_BACKUP_DIRS.contains(&name_str.as_ref())
                    {
                        fs::remove_dir_all(mods_bak.join(&name)).ok();
                        continue;
                    }
                    let _ = fs::rename(mods_bak.join(&name), dest);
                }
            }
            // remove_dir no-ops when non-empty, so any entry that failed to rename is never deleted.
            fs::remove_dir(&mods_bak).ok();
        } else if !mods_dir.exists() {
            fs::rename(&mods_bak, &mods_dir).map_err(|e| {
                format!(
                    "Could not restore mods folder. You may need to manually rename the backup folder. ({})",
                    e.kind()
                )
            })?;
        } else {
            fs::remove_dir_all(&mods_bak).ok();
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn launch_game(app: AppHandle, game_id: String) -> Result<(), String> {
    let game_id = game_id.as_str();
    let s = read_settings(&app);
    let Some(gs) = game_settings(&s, game_id) else {
        return Ok(());
    };
    let Some(ref game_path) = gs.game_path else {
        return Ok(());
    };
    let cfg = engine_for_game(game_id)?;
    let _ = do_restore(game_path, cfg);
    maybe_suppress_crash_reporter(game_id, gs);
    crate::commands::analytics::track(
        &app,
        "game_launched",
        serde_json::json!({ "game": game_id, "launcher": gs.launcher.as_deref().unwrap_or("steam") }),
    );
    launch_with(
        gs.launcher.as_deref().unwrap_or("steam"),
        game_def_for_id(game_id)?,
        game_path,
        Some(gs.launch_options.as_str()),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn launch_without_mods(app: AppHandle, game_id: String) -> Result<(), String> {
    let game_id = game_id.as_str();
    let s = read_settings(&app);
    let Some(gs) = game_settings(&s, game_id) else {
        return Ok(());
    };
    let Some(ref game_path) = gs.game_path else {
        return Ok(());
    };

    let cfg = engine_for_game(game_id)?;
    for (i, target) in cfg.targets.iter().enumerate() {
        let mods_dir = mods_base(game_path, target);
        let mods_bak = backup_dir(game_path, target);

        if mods_bak.exists() {
            continue;
        }

        if target.is_directory_unit() {
            if mods_dir.exists() {
                fs::create_dir(&mods_bak).map_err(|e| {
                    format!(
                        "Could not create backup folder — try running as administrator. ({})",
                        e.kind()
                    )
                })?;
                if let Ok(entries) = fs::read_dir(&mods_dir) {
                    for entry in entries.flatten() {
                        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            continue;
                        }
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        if i == 0 && name == "base" {
                            continue; // BLT recreates base/ if missing, showing a "base mod missing" dialog
                        }
                        // Never back up runtime/infra folders (RAID's downloads/logs/saves): the
                        // game recreates them in mods/ while running, so a restore would then fail
                        // to rename the backed-up copy over the fresh one, stranding mods.bak and
                        // pinning the "mods hidden" banner on forever.
                        if target.excluded_names().contains(&name.as_ref()) {
                            continue;
                        }
                        let _ = fs::rename(
                            mods_dir.join(entry.file_name()),
                            mods_bak.join(entry.file_name()),
                        );
                    }
                }
            }
        } else if mods_dir.exists() {
            fs::rename(&mods_dir, &mods_bak).map_err(|e| {
                format!(
                    "Could not hide mods folder — the game may still have files open. Close the game first and try again. ({})",
                    e.kind()
                )
            })?;
        }
    }

    crate::commands::analytics::track(
        &app,
        "launch_without_mods",
        serde_json::json!({ "game": game_id, "launcher": gs.launcher.as_deref().unwrap_or("steam") }),
    );
    maybe_suppress_crash_reporter(game_id, gs);
    launch_with(
        gs.launcher.as_deref().unwrap_or("steam"),
        game_def_for_id(game_id)?,
        game_path,
        Some(gs.launch_options.as_str()),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn restore_mods(app: AppHandle, game_id: String) -> Result<(), String> {
    let game_id = game_id.as_str();
    let s = read_settings(&app);
    let Some(gs) = game_settings(&s, game_id) else {
        return Ok(());
    };
    let Some(ref game_path) = gs.game_path else {
        return Ok(());
    };
    let cfg = engine_for_game(game_id)?;
    do_restore(game_path, cfg)
}

// Native process enumeration (NtQuerySystemInformation on Windows, /proc elsewhere). It
// never spawns tasklist or pgrep, so a wedged WMI service or missing procps cannot hang
// the UI.
fn refresh_process_list() -> sysinfo::System {
    let mut sys = sysinfo::System::new();
    let kind = sysinfo::ProcessRefreshKind::nothing();
    // cmdlines are only needed to see through Proton and wine wrapper process names.
    // On Windows the process name is always the exe name.
    #[cfg(not(windows))]
    let kind = kind.with_cmd(sysinfo::UpdateKind::Always);
    sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, kind);
    sys
}

// The on-disk name may carry .exe (Windows, Proton) and Linux /proc truncates names to 15
// chars, so the name is prefix-matched. The command-line fallback covers games launched
// through Proton or Wine wrappers, where the wrapper owns the process name.
fn matches_process(name: &str, cmd: &[String], process_name: &str) -> bool {
    name.starts_with(process_name) || cmd.iter().any(|c| c.contains(process_name))
}

fn process_matches(p: &sysinfo::Process, process_name: &str) -> bool {
    let cmd: Vec<String> = p
        .cmd()
        .iter()
        .map(|c| c.to_string_lossy().into_owned())
        .collect();
    matches_process(&p.name().to_string_lossy(), &cmd, process_name)
}

#[tauri::command]
#[specta::specta]
pub async fn is_game_running(game_id: String) -> Result<bool, String> {
    let process_names = game_def_for_id(game_id.as_str())?.process_names;
    tauri::async_runtime::spawn_blocking(move || {
        let sys = refresh_process_list();
        sys.processes()
            .values()
            .any(|p| process_names.iter().any(|n| process_matches(p, n)))
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn stop_game(game_id: String) -> Result<(), String> {
    let process_names = game_def_for_id(game_id.as_str())?.process_names;
    let sys = refresh_process_list();
    for p in sys
        .processes()
        .values()
        .filter(|p| process_names.iter().any(|n| process_matches(p, n)))
    {
        p.kill();
    }
    Ok(())
}

/// Returns the URL only if it is safe to hand to the OS shell: an http, https, or mailto
/// URL containing no characters that could break out of the Windows cmd /c start
/// invocation. Links come from untrusted mod authors, so this gates every external open.
fn sanitize_external_url(url: &str) -> Option<&str> {
    if url.contains(['"', '\n', '\r']) {
        return None;
    }
    let scheme = reqwest::Url::parse(url).ok()?.scheme().to_string();
    matches!(scheme.as_str(), "http" | "https" | "mailto").then_some(url)
}

#[tauri::command]
#[specta::specta]
pub fn shell_open_external(url: String) {
    if let Some(safe) = sanitize_external_url(&url) {
        open_url(safe);
    }
}

#[tauri::command]
#[specta::specta]
pub fn shell_open_path(path: String) {
    open_path_on_system(&path);
}

#[tauri::command]
#[specta::specta]
pub fn open_log_file(app: AppHandle) {
    use tauri::Manager;
    let Ok(log_dir) = app.path().app_log_dir() else {
        return;
    };
    let log_file = log_dir.join(format!("{}.log", app.package_info().name));
    // The log itself when it is a real file we own, otherwise the directory holding it.
    // Nothing is written on this path: copying the log to a predictable name in the shared
    // temp directory let anything that could pre-create that name have the copy written
    // through its link instead.
    match resolve_under(&log_dir, &log_file, OpenKind::File) {
        Some(file) => open_path_on_system(&file.to_string_lossy()),
        None => match resolve_under(&log_dir, &log_dir, OpenKind::Directory) {
            Some(dir) => open_path_on_system(&dir.to_string_lossy()),
            None => log::warn!("open_log_file: no usable log directory at {log_dir:?}"),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenKind {
    File,
    Directory,
}

/// Resolves target and proves it is root or something inside it, of the expected kind.
///
/// Canonicalizing both sides is what makes the comparison meaningful: it resolves .. and
/// symlinks and normalizes Windows casing and verbatim prefixes, so this is not a string
/// prefix test. A link is refused before that, because opening one hands the shell a
/// destination Modrex never validated. Anything unresolvable is refused rather than opened.
pub(crate) fn resolve_under(root: &Path, target: &Path, kind: OpenKind) -> Option<PathBuf> {
    let meta = std::fs::symlink_metadata(target).ok()?;
    if meta.file_type().is_symlink() {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let target = target.canonicalize().ok()?;
    if !target.starts_with(&root) {
        return None;
    }
    match kind {
        OpenKind::File => target.is_file().then_some(target),
        OpenKind::Directory => target.is_dir().then_some(target),
    }
}

#[tauri::command]
#[specta::specta]
pub fn open_data_folder(app: AppHandle) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    open_path_on_system(&dir.to_string_lossy());
}

#[tauri::command]
#[specta::specta]
pub fn open_app_folder() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    open_path_on_system(&dir.to_string_lossy());
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
