use super::naming::strip_priority_prefix;
use std::fs;
use std::path::{Path, PathBuf};

/// Suffix every Crime Boss ModKit-cooked pak carries, as in
/// <PackageName>CrimeBoss-WindowsNoEditor.pak. The part before it is the mod's internal UGC
/// package name, which lowercased is also the filename the game uses for its
/// Saved/ModSettings/<id>.json record. Reverse-engineered by comparing installed mods' pak
/// filenames against their actual ModSettings filenames.
const PAK_SUFFIX: &str = "CrimeBoss-WindowsNoEditor";

/// Derives the ModSettings JSON id from a Crime Boss mod's pak filename. None means the pak
/// does not follow the ModKit's standard cook-output naming (mods authored outside the
/// official ModKit, such as loose paks), which have no UGC object and so no in-game Enabled
/// toggle to sync. The legacy ~mods load-order prefix (NNN_) is stripped first, since the
/// in-game id comes from the ModKit's package name and knows nothing of Modrex's ordering.
pub(crate) fn settings_id_from_pak_filename(pak_filename: &str) -> Option<String> {
    let pak_filename = strip_priority_prefix(pak_filename);
    let stem = pak_filename.strip_suffix(".pak")?;
    let id = stem.strip_suffix(PAK_SUFFIX)?;
    if id.is_empty() {
        return None;
    }
    Some(id.to_ascii_lowercase())
}

/// Finds the single content file directly inside dir, a mod's Content/Paks/WindowsNoEditor
/// folder. Crime Boss Directory-unit installs always have exactly one, but this tolerates zero
/// without panicking.
pub(crate) fn find_content_file_in_dir(dir: &Path, extension: &str) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        (path.extension().and_then(|e| e.to_str()) == Some(extension)).then_some(path)
    })
}

/// Maps a Modrex launcher id to the platform subfolder the game uses under
/// Saved Games/CrimeBoss/<platform>/Saved/. Only Steam is verified against a real install,
/// and anything else returns None so callers no-op rather than guess at an unverified path.
fn platform_folder(launcher: &str) -> Option<&'static str> {
    match launcher {
        "steam" => Some("Steam"),
        _ => None,
    }
}

/// %USERPROFILE%\Saved Games\CrimeBoss\<platform>\Saved\ModSettings, outside the game install
/// dir entirely because the game redirects its UE Saved/ folder there. Resolved via the
/// USERPROFILE env var rather than the Windows known-folder API, matching how epic.rs reads
/// PROGRAMDATA, rather than adding a dependency for users who relocated "Saved Games".
fn mod_settings_dir(launcher: &str) -> Option<PathBuf> {
    let platform = platform_folder(launcher)?;
    let profile = std::env::var("USERPROFILE").ok()?;
    Some(
        PathBuf::from(profile)
            .join("Saved Games")
            .join("CrimeBoss")
            .join(platform)
            .join("Saved")
            .join("ModSettings"),
    )
}

/// Locates the content file belonging to a mod installed at mod_path. For a Directory-unit
/// install (Mods/<name>/) it is nested under the Content/Paks/WindowsNoEditor skeleton the
/// ModKit synthesizes. For the legacy File-unit install (~mods/<name>.pak) mod_path already is
/// the file.
pub(crate) fn content_path_for_mod(
    mod_path: &Path,
    is_directory_unit: bool,
    extension: &str,
) -> Option<PathBuf> {
    if is_directory_unit {
        find_content_file_in_dir(
            &mod_path
                .join("Content")
                .join("Paks")
                .join("WindowsNoEditor"),
            extension,
        )
    } else {
        Some(mod_path.to_path_buf())
    }
}

/// Sets the enabled entry's value in an existing ModSettings JSON file, leaving every other
/// entry in the array untouched (mods with custom settings have more entries the game owns and
/// populates itself). No-ops when the file does not exist yet: the game creates it lazily on
/// the first launch with the mod present, and synthesizing a guessed schema risks the game
/// never filling in entries it would have added on that first real scan.
pub(crate) fn set_enabled_in_file(path: &Path, enabled: bool) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut entries: Vec<serde_json::Value> =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let value = if enabled { "true" } else { "false" };
    let found = entries
        .iter_mut()
        .find(|entry| entry.get("name").and_then(|n| n.as_str()) == Some("enabled"));
    match found {
        Some(entry) => entry["value"] = serde_json::Value::String(value.to_string()),
        None => entries.push(serde_json::json!({ "name": "enabled", "value": value })),
    }
    let serialized = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    fs::write(path, serialized).map_err(|e| e.to_string())
}

/// Resolves the Saved/ModSettings/<id>.json path for the mod installed at mod_path. None if
/// any step is unresolvable: unverified launcher platform, pak not found, or a filename that
/// does not follow the ModKit's standard naming.
fn settings_path_for_mod(
    mod_path: &Path,
    is_directory_unit: bool,
    launcher: &str,
) -> Option<PathBuf> {
    let dir = mod_settings_dir(launcher)?;
    let pak = content_path_for_mod(mod_path, is_directory_unit, "pak")?;
    let filename = pak.file_name().and_then(|s| s.to_str())?;
    let id = settings_id_from_pak_filename(filename)?;
    Some(dir.join(format!("{id}.json")))
}

/// Syncs the in-game Enabled mod setting to match a Modrex enable or disable action. The
/// game's own UGC mod-loader reads and writes this file directly through its Options > Mods
/// screen, and moving mod files inside Mods/ or ~mods has no effect on it. Confirmed against a
/// real install: a mod moved into a disabled subfolder kept its settings file reading
/// "enabled": "true". So this is the only thing that changes whether the game treats a Crime
/// Boss mod as active. Silently no-ops on any unresolvable step rather than guessing, since
/// the file move in enable_mod_op and disable_mod_op is what users observe either way.
pub fn sync_enabled(
    mod_path: &Path,
    is_directory_unit: bool,
    launcher: Option<&str>,
    enabled: bool,
) {
    let Some(launcher) = launcher else { return };
    let Some(path) = settings_path_for_mod(mod_path, is_directory_unit, launcher) else {
        return;
    };
    let _ = set_enabled_in_file(&path, enabled);
}

/// Reads the enabled entry's value out of an existing ModSettings JSON file. None covers both
/// a missing file and a malformed or missing entry, and callers must treat either as unknown,
/// leaving Modrex's own tracked value alone rather than reading it as disabled.
pub(crate) fn read_enabled_from_file(path: &Path) -> Option<bool> {
    let content = fs::read_to_string(path).ok()?;
    let entries: Vec<serde_json::Value> = serde_json::from_str(&content).ok()?;
    entries
        .iter()
        .find(|entry| entry.get("name").and_then(|n| n.as_str()) == Some("enabled"))
        .and_then(|entry| entry.get("value"))
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<bool>().ok())
}

/// Reads the real Enabled value back from the mod's settings file. The player can toggle mods
/// from the game's own Options > Mods screen, and Modrex's tracked enabled flag, driven by
/// which folder the files sit in, has no way to learn about that. None if anything is
/// unresolvable, for the reason given on read_enabled_from_file.
pub fn read_enabled(
    mod_path: &Path,
    is_directory_unit: bool,
    launcher: Option<&str>,
) -> Option<bool> {
    let path = settings_path_for_mod(mod_path, is_directory_unit, launcher?)?;
    read_enabled_from_file(&path)
}
