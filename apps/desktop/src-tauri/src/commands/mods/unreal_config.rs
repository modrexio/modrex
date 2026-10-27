use super::resources::{picked_directory, InstallContext};
use crate::commands::games::game_spec;
use crate::commands::settings::{
    game_settings, read_settings_fallible, update_settings_fallible, ConfigDirectory,
};
use crate::game_package::ConfigLocation;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub(super) fn declared_config_path(
    locations: &[ConfigLocation],
    launcher: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    #[cfg(windows)]
    {
        let Some(location) = locations.iter().find(|location| {
            let (ConfigLocation::WindowsLocalAppData { store, .. }
            | ConfigLocation::WindowsUserProfile { store, .. }) = location;
            launcher == Some(store.provider())
        }) else {
            return Ok(None);
        };
        let (root, path) = match location {
            ConfigLocation::WindowsLocalAppData { path, .. } => (local_app_data()?, path),
            ConfigLocation::WindowsUserProfile { path, .. } => {
                let root = std::env::var_os("USERPROFILE")
                    .filter(|value| !value.is_empty())
                    .ok_or("Windows user profile is unavailable")?;
                let root = PathBuf::from(root);
                if !root.is_absolute() {
                    return Err("Windows user profile is not an absolute path".into());
                }
                (root, path)
            }
        };
        Ok(Some(path.iter().fold(root, |directory, component| {
            directory.join(component)
        })))
    }
    #[cfg(not(windows))]
    {
        let _ = (locations, launcher);
        Ok(None)
    }
}

#[cfg(windows)]
fn local_app_data() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHGetKnownFolderPath(
            id: *const Guid,
            flags: u32,
            token: *mut std::ffi::c_void,
            path: *mut *mut u16,
        ) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoTaskMemFree(memory: *mut std::ffi::c_void);
    }
    let id = Guid {
        data1: 0xf1b32785,
        data2: 0x6fba,
        data3: 0x4fcf,
        data4: [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91],
    };
    let mut pointer = std::ptr::null_mut();
    let result = unsafe { SHGetKnownFolderPath(&id, 0, std::ptr::null_mut(), &mut pointer) };
    if result < 0 {
        unsafe {
            CoTaskMemFree(pointer.cast());
        }
        return Err(format!(
            "Windows could not resolve Local AppData: {result:#x}"
        ));
    }
    let mut length = 0;
    unsafe {
        while *pointer.add(length) != 0 {
            length += 1;
        }
        let path = std::ffi::OsString::from_wide(std::slice::from_raw_parts(pointer, length));
        CoTaskMemFree(pointer.cast());
        Ok(PathBuf::from(path))
    }
}

pub(super) fn declared_root(
    game_id: &str,
    launcher: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let spec = game_spec(game_id).ok_or_else(|| format!("unknown game id '{game_id}'"))?;
    let Some(config) = spec.unreal_config else {
        return Ok(None);
    };
    declared_config_path(&config.roots, launcher)
}

pub(super) fn automatic_directory(
    game_id: &str,
    launcher: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    declared_root(game_id, launcher)?
        .map(|root| discover(&root))
        .transpose()
        .map(Option::flatten)
}

pub(super) fn directory(
    app: &AppHandle,
    ctx: &InstallContext,
) -> Result<Option<(PathBuf, bool)>, String> {
    select_directory(
        picked_directory(app, ctx),
        || automatic_directory(&ctx.game_id, ctx.launcher.as_deref()),
        || {
            let settings = read_settings_fallible(app)?;
            Ok(game_settings(&settings, &ctx.game_id).and_then(|settings| {
                settings
                    .config_directories
                    .iter()
                    .find(|picked| {
                        picked.canonical_game_path == ctx.canonical_game_path
                            && picked.launcher == ctx.launcher
                    })
                    .map(|picked| PathBuf::from(&picked.directory))
            }))
        },
    )
}

fn select_directory(
    session: Option<PathBuf>,
    automatic: impl FnOnce() -> Result<Option<PathBuf>, String>,
    remembered: impl FnOnce() -> Result<Option<PathBuf>, String>,
) -> Result<Option<(PathBuf, bool)>, String> {
    if let Some(path) = session {
        return Ok(Some((validate_directory(&path)?, true)));
    }
    if let Some(path) = automatic()? {
        return Ok(Some((path, false)));
    }
    remembered()?
        .map(|path| validate_directory(&path).map(|path| (path, true)))
        .transpose()
}

pub(super) fn persist_pick(
    app: &AppHandle,
    ctx: &InstallContext,
    directory: &Path,
) -> Result<(), String> {
    update_settings_fallible(app, |settings| {
        let game = game_settings(settings, &ctx.game_id)
            .ok_or("The game install is no longer configured")?;
        let canonical = Path::new(
            game.game_path
                .as_ref()
                .ok_or("The game folder is no longer configured")?,
        )
        .canonicalize()
        .map_err(|error| format!("Could not resolve the game folder: {error}"))?;
        if canonical != Path::new(&ctx.canonical_game_path)
            || game.launcher != ctx.launcher
            || game.game_path.as_deref() != Some(&ctx.game_path)
        {
            return Err(
                "The selected game install or store changed. Choose the configuration again".into(),
            );
        }
        // A pick outlives the session only where discovery has no answer, so a saved pick
        // can never hold an install on a platform folder the engine has since abandoned.
        if automatic_directory(&ctx.game_id, ctx.launcher.as_deref())?.is_some() {
            return Ok(());
        }
        let game = settings
            .games
            .as_mut()
            .expect("configured game map")
            .get_mut(&ctx.game_id)
            .expect("configured game");
        save_pick(&mut game.config_directories, ctx, directory);
        Ok(())
    })
}

fn save_pick(picks: &mut Vec<ConfigDirectory>, ctx: &InstallContext, directory: &Path) {
    picks.retain(|picked| {
        picked.canonical_game_path != ctx.canonical_game_path || picked.launcher != ctx.launcher
    });
    picks.push(ConfigDirectory {
        canonical_game_path: ctx.canonical_game_path.clone(),
        launcher: ctx.launcher.clone(),
        directory: directory.to_string_lossy().into_owned(),
    });
}

fn validate_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("The configuration folder must be an absolute path".into());
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    refuse_link(path, &metadata)?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a configuration folder", path.display()));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve {}: {error}", path.display()))?;
    if canonical != path {
        return Err(format!(
            "{} now resolves somewhere else. Choose it again",
            path.display()
        ));
    }
    Ok(canonical)
}

fn refuse_link(path: &Path, metadata: &std::fs::Metadata) -> Result<(), String> {
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let linked = metadata.file_type().is_symlink();
    if linked {
        return Err(format!("{} is a linked configuration path", path.display()));
    }
    Ok(())
}

// Only the game-written marker identifies a platform folder. Folder names are not stable.
pub(super) fn discover(root: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match std::fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not inspect {}: {error}", root.display())),
    };
    refuse_link(root, &metadata)?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve {}: {error}", root.display()))?;
    let entries = std::fs::read_dir(&root)
        .map_err(|error| format!("Could not scan {}: {error}", root.display()))?;
    let mut newest = None;
    let mut selected = None;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not scan {}: {error}", root.display()))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        refuse_link(&path, &metadata)?;
        if !metadata.is_dir() {
            continue;
        }
        let marker = path.join("GameUserSettings.ini");
        let metadata = match std::fs::symlink_metadata(&marker) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not inspect {}: {error}", marker.display())),
        };
        refuse_link(&marker, &metadata)?;
        if !metadata.is_file() {
            return Err(format!("{} is not a regular marker file", marker.display()));
        }
        let modified = metadata.modified().map_err(|error| {
            format!(
                "Could not read modification time for {}: {error}",
                marker.display()
            )
        })?;
        match newest {
            None => {
                newest = Some(modified);
                selected = Some(path);
            }
            Some(time) if modified > time => {
                newest = Some(modified);
                selected = Some(path);
            }
            Some(time) if modified == time => selected = None,
            Some(_) => {}
        }
    }
    selected.map(|path| validate_directory(&path)).transpose()
}

#[cfg(test)]
#[path = "unreal_config_tests.rs"]
mod tests;
