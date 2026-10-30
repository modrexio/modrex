use super::resources::{declared_config_path, picked_directory, InstallContext};
use crate::commands::games::game_spec;
use crate::commands::settings::{game_settings, read_settings, update_settings, ConfigDirectory};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub(super) fn automatic_directory(
    game_id: &str,
    launcher: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let spec = game_spec(game_id).ok_or_else(|| format!("unknown game id '{game_id}'"))?;
    let Some(config) = spec.unreal_config else {
        return Ok(None);
    };
    let Some(root) = declared_config_path(&config.roots, launcher)? else {
        return Ok(None);
    };
    discover(&root)
}

pub(super) fn directory(
    app: &AppHandle,
    ctx: &InstallContext,
) -> Result<Option<(PathBuf, bool)>, String> {
    select_directory(
        picked_directory(app, ctx),
        || automatic_directory(&ctx.game_id, ctx.launcher.as_deref()),
        || {
            let settings = read_settings(app);
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
        return Ok(Some((path, true)));
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
    let Some(pick) = persistent_pick(
        ctx,
        directory,
        automatic_directory(&ctx.game_id, ctx.launcher.as_deref())?,
    ) else {
        return Ok(());
    };
    update_settings(app, |settings| {
        let game = game_settings(settings, &ctx.game_id)
            .ok_or("The game install is no longer configured")?;
        if game.launcher != ctx.launcher || game.game_path.as_deref() != Some(&ctx.game_path) {
            return Err(
                "The selected game install or store changed. Choose the configuration again".into(),
            );
        }
        let game = settings
            .games
            .as_mut()
            .expect("configured game map")
            .get_mut(&ctx.game_id)
            .expect("configured game");
        game.config_directories.retain(|saved| {
            saved.canonical_game_path != pick.canonical_game_path || saved.launcher != pick.launcher
        });
        game.config_directories.push(pick);
        Ok(())
    })
}

fn persistent_pick(
    ctx: &InstallContext,
    directory: &Path,
    automatic: Option<PathBuf>,
) -> Option<ConfigDirectory> {
    if automatic.is_some() {
        return None;
    }
    Some(ConfigDirectory {
        canonical_game_path: ctx.canonical_game_path.clone(),
        launcher: ctx.launcher.clone(),
        directory: directory.to_string_lossy().into_owned(),
    })
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
    Ok(path.to_path_buf())
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

// Discovery tests enforce game-written markers instead of platform folder names.
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
    Ok(selected)
}

#[cfg(test)]
#[path = "unreal_config_tests.rs"]
mod tests;
