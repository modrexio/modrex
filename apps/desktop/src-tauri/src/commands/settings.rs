use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Treats an explicit JSON null as the field's default.
///
/// serde(default) only covers an ABSENT field. Older settings.json files carry every field
/// below as an explicit null instead, which fails deserialization with "invalid type: null,
/// expected ..." and drops read_settings back to Settings::default(), silently wiping every
/// game path, launcher, and preference on the next launch. Same fix as domain.rs's
/// null_default for modworkshop responses.
fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

fn null_or_true<'de, D>(d: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<bool>::deserialize(d)?.unwrap_or(true))
}

fn null_or_crimeboss_mode<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(d)?.unwrap_or_else(default_crimeboss_mode))
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GameSettings {
    // Not-yet-detected is a real third state here (auto-detection has not resolved, or the
    // game is not installed), so these two stay Option.
    pub game_path: Option<String>,
    pub launcher: Option<String>,
    // Whether which copy of the game to use has been settled. A game owned on two stores
    // has two installs that share nothing, so re-detection must not move between them
    // behind the user's back once one is in use. False on every settings file written
    // before this existed, which is what lets those re-settle once against the mod list
    // on disk rather than staying on whichever store was found first.
    #[serde(default, deserialize_with = "null_default")]
    #[specta(type = bool)]
    pub install_pinned: bool,
    // deserialize_with only ever narrows null to the same wire type (see null_default).
    // #[specta(type)] tells specta that, since it cannot infer through a custom deserializer.
    #[serde(default, deserialize_with = "null_default")]
    #[specta(type = String)]
    pub launch_options: String,
    #[serde(default, deserialize_with = "null_default")]
    #[specta(type = bool)]
    pub suppress_crash_reporter: bool,
    // Crime Boss only: "auto" (default, every install lands in Mods/) or "ask" (the renderer
    // shows a Mods/ vs ~mods choice before each new install).
    #[serde(
        default = "default_crimeboss_mode",
        deserialize_with = "null_or_crimeboss_mode"
    )]
    #[specta(type = String)]
    pub crimeboss_install_mode: String,
}

fn default_crimeboss_mode() -> String {
    "auto".to_string()
}

impl Default for GameSettings {
    fn default() -> Self {
        Self {
            game_path: None,
            launcher: None,
            install_pinned: false,
            launch_options: String::new(),
            suppress_crash_reporter: false,
            crimeboss_install_mode: default_crimeboss_mode(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NexusOAuthTokens {
    // Present only when the OS credential store was unavailable at write time (see
    // commands::secrets). The normal path stores both tokens there instead and leaves
    // these None, with only expires_at kept here either way.
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    // Unix seconds, computed from the token response's expires_in at receipt.
    pub expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub games: Option<HashMap<String, GameSettings>>,
    #[serde(default, deserialize_with = "null_default")]
    pub skip_file_open_log_warning: bool,
    // modworkshop mod ids only; ids from other sources must not land here.
    #[serde(default, deserialize_with = "null_default")]
    pub dismissed_deps_warnings: Vec<i32>,
    // analytics_consent_asked distinguishes "never shown the first-run consent dialog"
    // from "shown it, and this is their answer". Its own bool keeps that state without
    // the dialog either nagging forever or the saved choice reading as "never asked".
    // analytics_id is a random per-install identifier, never transmitted unless enabled.
    #[serde(default)]
    pub analytics_consent_asked: bool,
    #[serde(default, deserialize_with = "null_default")]
    pub analytics_enabled: bool,
    pub analytics_id: Option<String>,
    #[serde(default = "default_true", deserialize_with = "null_or_true")]
    pub discord_rich_presence_enabled: bool,
    // OAuth credentials are persisted only in local settings and sent only to
    // Nexus's OAuth and API endpoints.
    pub nexus_oauth: Option<NexusOAuthTokens>,
    // One-time "star us on GitHub" prompt bookkeeping. Lives here (not localStorage)
    // so it shares the telemetry consent's lifecycle: survives uninstall/reinstall
    // (the NSIS uninstaller never touches app data) and only resets on a full
    // app-data wipe, where the guards below re-rate-limit it to once per 7+ days.
    #[serde(default, deserialize_with = "null_default")]
    pub successful_installs: u64,
    // 0 means not yet recorded. A real first-install timestamp is never near epoch.
    #[serde(default, deserialize_with = "null_default")]
    pub first_install_at: u64,
    #[serde(default, deserialize_with = "null_default")]
    pub support_prompt_shown: bool,
    // Legacy flat fields: deserialized from old files but never written back. Stay
    // Option since their whole purpose is detecting "field absent in an old file".
    #[serde(skip_serializing, default)]
    pub game_path: Option<String>,
    #[serde(skip_serializing, default)]
    pub launcher: Option<String>,
    #[serde(skip_serializing, default)]
    pub launch_options: Option<String>,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            games: None,
            skip_file_open_log_warning: false,
            dismissed_deps_warnings: Vec::new(),
            analytics_consent_asked: false,
            analytics_enabled: false,
            analytics_id: None,
            discord_rich_presence_enabled: true,
            nexus_oauth: None,
            successful_installs: 0,
            first_install_at: 0,
            support_prompt_shown: false,
            game_path: None,
            launcher: None,
            launch_options: None,
        }
    }
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("no app data dir")
        .join("settings.json")
}

pub fn migrate_settings(mut s: Settings) -> Settings {
    if s.games.is_none() {
        let mut games: HashMap<String, GameSettings> = HashMap::new();
        if s.game_path.is_some() || s.launcher.is_some() || s.launch_options.is_some() {
            games.insert(
                "pd3".to_string(),
                GameSettings {
                    game_path: s.game_path.clone(),
                    launcher: s.launcher.clone(),
                    launch_options: s.launch_options.clone().unwrap_or_default(),
                    ..GameSettings::default()
                },
            );
        }
        s.games = Some(games);
    }
    s
}

pub fn read_settings(app: &AppHandle) -> Settings {
    let path = settings_path(app);
    if !path.exists() {
        return Settings::default();
    }
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let mut s: Settings = match serde_json::from_str(&content) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("read_settings: parse {path:?}: {e}; falling back to defaults");
            Settings::default()
        }
    };
    recover_legacy_analytics_consent(&mut s, &content);
    migrate_settings(s)
}

/// analytics_consent_asked is absent (and so defaults to false) in every settings.json
/// written before it existed. Without this recovery, a user who already answered the
/// consent dialog (recorded there as an explicit true or false, not the null that meant
/// "never asked") would be shown it again on their first launch after updating.
pub(crate) fn recover_legacy_analytics_consent(s: &mut Settings, raw_content: &str) {
    if s.analytics_consent_asked {
        return;
    }
    if let Ok(raw) = serde_json::from_str::<serde_json::Value>(raw_content) {
        if raw.get("analyticsEnabled").is_some_and(|v| v.is_boolean()) {
            s.analytics_consent_asked = true;
        }
    }
}

pub(crate) fn write_settings(app: &AppHandle, settings: &Settings) {
    let path = settings_path(app);
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("write_settings: create_dir_all {parent:?}: {e}");
        }
    }
    // Write-then-rename so a reader can never see a half-written file: a torn
    // read parses as default settings, and the next save would persist that
    // empty default, wiping every configured game.
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(
        &tmp,
        serde_json::to_string_pretty(settings).unwrap_or_default(),
    ) {
        log::warn!("write_settings: write {tmp:?}: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        log::warn!("write_settings: rename {tmp:?} -> {path:?}: {e}");
    }
}

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// Serializes every read-modify-write of settings.json. The game picker resolves all
/// games' paths concurrently, and without the lock those writers overwrite each other's
/// just-saved paths, making games flap between installed and not installed.
pub fn update_settings<T>(app: &AppHandle, mutate: impl FnOnce(&mut Settings) -> T) -> T {
    let _guard = SETTINGS_LOCK.lock().unwrap();
    let mut s = read_settings(app);
    let result = mutate(&mut s);
    write_settings(app, &s);
    result
}

pub fn game_settings<'a>(s: &'a Settings, game_id: &str) -> Option<&'a GameSettings> {
    s.games.as_ref()?.get(game_id)
}

/// Factory-resets settings.json to defaults: clears every configured game path,
/// launcher choice, launch options, analytics consent + id, and all other
/// preferences. Does not touch installed mods, game files, or the on-disk caches.
#[tauri::command]
#[specta::specta]
pub fn reset_app_settings(app: AppHandle) {
    update_settings(&app, |s| *s = Settings::default());
}

/// On first launch after the Electron-to-Tauri migration, copy settings.json
/// and mod-index.db from the old Electron userData path to the new Tauri path.
/// Safe to remove once no Electron installs remain in the wild.
pub fn migrate_from_old_identifier(app: &AppHandle) {
    let new_settings = settings_path(app);
    if new_settings.exists() {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        let Ok(appdata) = std::env::var("APPDATA") else {
            return;
        };
        let old_dir = PathBuf::from(appdata).join("io.github.shulhaoleh.pd3modmanager");
        let new_dir = new_settings.parent().unwrap();
        let _ = std::fs::create_dir_all(new_dir);
        if old_dir.join("settings.json").exists() {
            let _ = std::fs::copy(old_dir.join("settings.json"), &new_settings);
        }
        let old_index = old_dir.join("mod-index.db");
        let new_index = new_dir.join("mod-index.db");
        if old_index.exists() && !new_index.exists() {
            let _ = std::fs::copy(old_index, new_index);
        }
    }
    #[cfg(target_os = "linux")]
    {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        let old_dir = PathBuf::from(home)
            .join(".config")
            .join("io.github.shulhaoleh.pd3modmanager");
        let new_dir = new_settings.parent().unwrap();
        let _ = std::fs::create_dir_all(new_dir);
        if old_dir.join("settings.json").exists() {
            let _ = std::fs::copy(old_dir.join("settings.json"), &new_settings);
        }
        let old_index = old_dir.join("mod-index.db");
        let new_index = new_dir.join("mod-index.db");
        if old_index.exists() && !new_index.exists() {
            let _ = std::fs::copy(old_index, new_index);
        }
    }
}

pub fn migrate_from_electron(app: &AppHandle) {
    let new_settings = settings_path(app);
    if new_settings.exists() {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        let Ok(appdata) = std::env::var("APPDATA") else {
            return;
        };
        let old_dir = PathBuf::from(appdata).join("PD3 Mod Manager");
        let new_dir = new_settings.parent().unwrap();
        let _ = std::fs::create_dir_all(new_dir);
        if old_dir.join("settings.json").exists() {
            let _ = std::fs::copy(old_dir.join("settings.json"), &new_settings);
        }
        let old_index = old_dir.join("mod-index.db");
        let new_index = new_dir.join("mod-index.db");
        if old_index.exists() && !new_index.exists() {
            let _ = std::fs::copy(old_index, new_index);
        }
    }
    #[cfg(target_os = "linux")]
    {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        let old_dir = PathBuf::from(home).join(".config").join("pd3-mod-manager");
        let new_dir = new_settings.parent().unwrap();
        let _ = std::fs::create_dir_all(new_dir);
        if old_dir.join("settings.json").exists() {
            let _ = std::fs::copy(old_dir.join("settings.json"), &new_settings);
        }
        let old_index = old_dir.join("mod-index.db");
        let new_index = new_dir.join("mod-index.db");
        if old_index.exists() && !new_index.exists() {
            let _ = std::fs::copy(old_index, new_index);
        }
    }
}

/// Returns a backwards-compatible flat view of PD3 settings for the renderer. New callers
/// take get_game_settings instead, which is per-game rather than pinned to pd3.
#[tauri::command]
#[specta::specta]
pub fn get_settings(app: AppHandle) -> crate::commands::api::Json {
    let s = read_settings(&app);
    let gs = s.games.as_ref().and_then(|g| g.get("pd3"));
    crate::commands::api::Json(serde_json::json!({
        "gamePath": gs.and_then(|g| g.game_path.as_deref()),
        "launcher": gs.and_then(|g| g.launcher.as_deref()),
        "launchOptions": gs.map(|g| g.launch_options.as_str()),
        "skipFileOpenLogWarning": s.skip_file_open_log_warning,
        "dismissedDepsWarnings": s.dismissed_deps_warnings,
    }))
}

#[tauri::command]
#[specta::specta]
pub fn get_game_settings(app: AppHandle, game_id: String) -> GameSettings {
    let s = read_settings(&app);
    s.games
        .as_ref()
        .and_then(|g| g.get(&game_id))
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
#[specta::specta]
pub fn set_launch_options(app: AppHandle, game_id: String, launch_options: String) {
    update_settings(&app, |s| {
        s.games
            .get_or_insert_with(HashMap::new)
            .entry(game_id)
            .or_default()
            .launch_options = launch_options;
    });
}

#[tauri::command]
#[specta::specta]
pub fn set_crimeboss_install_mode(app: AppHandle, mode: String) {
    update_settings(&app, |s| {
        s.games
            .get_or_insert_with(HashMap::new)
            .entry("cb".to_string())
            .or_default()
            .crimeboss_install_mode = mode;
    });
}

#[tauri::command]
#[specta::specta]
pub fn set_suppress_crash_reporter(app: AppHandle, game_id: String, suppress: bool) {
    update_settings(&app, |s| {
        s.games
            .get_or_insert_with(HashMap::new)
            .entry(game_id)
            .or_default()
            .suppress_crash_reporter = suppress;
    });
}

#[tauri::command]
#[specta::specta]
pub fn set_skip_fileopenlog_warning(app: AppHandle, skip: bool) {
    update_settings(&app, |s| s.skip_file_open_log_warning = skip);
}

/// Current analytics consent: None = not yet asked, Some(true/false) = chosen.
/// The Option only exists at this IPC boundary. settings.json itself tracks
/// "asked" and "enabled" as two separate plain bools (see Settings).
#[tauri::command]
#[specta::specta]
pub fn get_analytics_consent(app: AppHandle) -> Option<bool> {
    let s = read_settings(&app);
    s.analytics_consent_asked.then_some(s.analytics_enabled)
}

/// Records the user's explicit analytics choice. Generates the anonymous install
/// ID lazily on first opt-in, so a user who never enables analytics never gets one.
#[tauri::command]
#[specta::specta]
pub fn set_analytics_consent(app: AppHandle, enabled: bool) {
    update_settings(&app, |s| {
        s.analytics_consent_asked = true;
        s.analytics_enabled = enabled;
        if enabled && s.analytics_id.is_none() {
            s.analytics_id = Some(uuid::Uuid::new_v4().to_string());
        }
    });
}

/// Returns the persisted anonymous analytics ID, generating and persisting one if absent.
/// Used by the analytics sender. The ID never leaves the device unless the user has
/// enabled analytics.
pub(crate) fn ensure_analytics_id(app: &AppHandle) -> String {
    if let Some(id) = read_settings(app).analytics_id {
        return id;
    }
    update_settings(app, |s| {
        s.analytics_id
            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone()
    })
}

const SUPPORT_PROMPT_MIN_INSTALLS: u64 = 10;
const SUPPORT_PROMPT_MIN_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

pub(crate) fn support_prompt_eligible(installs: u64, first_install_at: u64, now_ms: u64) -> bool {
    installs >= SUPPORT_PROMPT_MIN_INSTALLS
        && now_ms.saturating_sub(first_install_at) >= SUPPORT_PROMPT_MIN_AGE_MS
}

/// Counts a successful mod install toward the one-time "star us on GitHub" prompt. When
/// the milestone is reached in a clean session, the shown flag is persisted before the
/// renderer displays anything (write-on-show), so the prompt can never fire twice while
/// settings.json survives.
#[tauri::command]
#[specta::specta]
pub fn record_successful_install(app: AppHandle, clean_session: bool) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let show_prompt = update_settings(&app, |s| {
        if s.support_prompt_shown {
            return false;
        }
        if s.first_install_at == 0 {
            s.first_install_at = now;
        }
        let first = s.first_install_at;
        s.successful_installs += 1;
        let count = s.successful_installs;
        if clean_session && support_prompt_eligible(count, first, now) {
            s.support_prompt_shown = true;
            return true;
        }
        false
    });
    if show_prompt {
        let _ = app.emit("support-prompt:eligible", ());
    }
}

#[tauri::command]
#[specta::specta]
pub fn dismiss_deps_warning(app: AppHandle, mod_id: i32) {
    update_settings(&app, |s| {
        if !s.dismissed_deps_warnings.contains(&mod_id) {
            s.dismissed_deps_warnings.push(mod_id);
        }
    });
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
