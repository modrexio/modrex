use super::resources::{
    blocking, current_context, declared_config_path, require_context, ConfigFileLocation,
    InstallContext,
};
use crate::commands::games::game_spec;
use crate::game_package::GraphicsConfig;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct PickedConfig {
    context: InstallContext,
    path: PathBuf,
}

#[derive(Default)]
pub struct GraphicsConfigLocations(Mutex<HashMap<String, PickedConfig>>);

impl GraphicsConfigLocations {
    fn for_context(&self, context: &InstallContext) -> Option<PathBuf> {
        let mut locations = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let picked = locations.get(&context.game_id)?;
        if picked.context != *context {
            locations.remove(&context.game_id);
            return None;
        }
        Some(picked.path.clone())
    }
}

fn graphics_config(game_id: &str) -> Result<&'static GraphicsConfig, String> {
    game_spec(game_id)
        .ok_or_else(|| format!("unknown game id '{game_id}'"))?
        .graphics_config
        .ok_or_else(|| format!("Graphics config access is not supported for '{game_id}'"))
}

struct GraphicsDestination {
    path: PathBuf,
    chosen: bool,
}

impl GraphicsDestination {
    fn validate(&self, filename: &str) -> Result<PathBuf, String> {
        let canonical = validate_file(&self.path, filename)?;
        if self.chosen && canonical != self.path {
            return Err("The config you chose now resolves somewhere else. Choose it again".into());
        }
        Ok(canonical)
    }
}

fn destination(
    app: &AppHandle,
    context: &InstallContext,
    config: &GraphicsConfig,
) -> Result<Option<GraphicsDestination>, String> {
    if let Some(path) = app.state::<GraphicsConfigLocations>().for_context(context) {
        return Ok(Some(GraphicsDestination { path, chosen: true }));
    }
    Ok(
        declared_config_path(&config.locations, context.launcher.as_deref())?.map(|path| {
            GraphicsDestination {
                path,
                chosen: false,
            }
        }),
    )
}

fn validate_file(path: &Path, filename: &str) -> Result<PathBuf, String> {
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(filename))
    {
        return Err(format!("Choose a file named {filename}"));
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not open {}: {error}", display_path(path)))?;
    if !metadata.file_type().is_file() {
        return Err(format!("{} is not a regular file", display_path(path)));
    }
    path.canonicalize()
        .map_err(|error| format!("Could not resolve {}: {error}", display_path(path)))
}

fn display_path(path: &Path) -> String {
    #[cfg(windows)]
    let path = super::resources::shell_config_path(path);
    path.to_string_lossy().into_owned()
}

fn inspect(destination: GraphicsDestination, filename: &str) -> Result<ConfigFileLocation, String> {
    match std::fs::symlink_metadata(&destination.path) {
        Ok(_) => Ok(ConfigFileLocation::Found {
            path: display_path(&destination.validate(filename)?),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(ConfigFileLocation::Missing {
                path: display_path(&destination.path),
            })
        }
        Err(error) => Err(format!("Could not check {filename}: {error}")),
    }
}

pub(super) async fn get_location(
    app: &AppHandle,
    game_id: &str,
) -> Result<ConfigFileLocation, String> {
    let app = app.clone();
    let game_id = game_id.to_string();
    blocking(move || {
        let config = graphics_config(&game_id)?;
        let context = current_context(&app, &game_id)?;
        let location = match destination(&app, &context, config)? {
            Some(destination) => inspect(destination, &config.filename)?,
            None => ConfigFileLocation::NeedsLocation,
        };
        require_context(&app, &context)?;
        Ok(location)
    })
    .await
}

pub(super) async fn pick(
    app: &AppHandle,
    game_id: &str,
    title: String,
    folder: bool,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let config = graphics_config(game_id)?;
    let context = current_context(app, game_id)?;
    let app = app.clone();
    blocking(move || {
        let dialog = app.dialog().file().set_title(title);
        let picked = if folder {
            dialog.blocking_pick_folder()
        } else {
            let extension = Path::new(&config.filename)
                .extension()
                .and_then(|extension| extension.to_str());
            let dialog = match extension {
                Some(extension) => dialog.add_filter(&config.filename, &[extension]),
                None => dialog,
            };
            dialog.blocking_pick_file()
        };
        let Some(picked) = picked else {
            return Ok(None);
        };
        let mut path = picked.into_path().map_err(|error| error.to_string())?;
        if folder {
            path.push(&config.filename);
        }
        let path = validate_file(&path, &config.filename)?;
        require_context(&app, &context)?;
        app.state::<GraphicsConfigLocations>()
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                context.game_id.clone(),
                PickedConfig {
                    context,
                    path: path.clone(),
                },
            );
        Ok(Some(display_path(&path)))
    })
    .await
}

pub(super) async fn open(app: &AppHandle, game_id: &str) -> Result<(), String> {
    let app = app.clone();
    let game_id = game_id.to_string();
    blocking(move || {
        let config = graphics_config(&game_id)?;
        let context = current_context(&app, &game_id)?;
        let destination = destination(&app, &context, config)?
            .ok_or_else(|| format!("Choose {} or its folder before opening it", config.filename))?;
        let canonical = destination.validate(&config.filename)?;
        require_context(&app, &context)?;
        open_external(&canonical)
    })
    .await
}

#[cfg(not(windows))]
fn open_external(path: &Path) -> Result<(), String> {
    // xdg-open can remain alive for the entire editor session.
    crate::commands::launchers::outside_bundle(std::process::Command::new("xdg-open").arg(path))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the graphics config: {error}"))
}

#[cfg(windows)]
fn open_external(path: &Path) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    #[repr(C)]
    struct ShellExecuteInfo {
        size: u32,
        mask: u32,
        window: *mut c_void,
        verb: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
        instance: *mut c_void,
        id_list: *mut c_void,
        class: *const u16,
        class_key: *mut c_void,
        hot_key: u32,
        icon_or_monitor: *mut c_void,
        process: *mut c_void,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, model: u32) -> i32;
        fn CoUninitialize();
    }
    let file: Vec<_> = super::resources::shell_config_path(path)
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let edit: Vec<_> = "edit".encode_utf16().chain(Some(0)).collect();
    let choose: Vec<_> = "openas".encode_utf16().chain(Some(0)).collect();
    let initialized = unsafe { CoInitializeEx(std::ptr::null_mut(), 0x2 | 0x4) };
    if initialized < 0 {
        return Err(format!(
            "Could not initialize the Windows editor launcher: {initialized:#x}"
        ));
    }
    let mut info: ShellExecuteInfo = unsafe { std::mem::zeroed() };
    info.size = std::mem::size_of::<ShellExecuteInfo>() as u32;
    // The worker has no message loop, so the shell must finish handing off the file here.
    info.mask = 0x100 | 0x400;
    // XML's default open association can launch a browser rather than an editor.
    info.verb = edit.as_ptr();
    info.file = file.as_ptr();
    info.show = 1;
    let mut succeeded = unsafe { ShellExecuteExW(&mut info) } != 0;
    let mut error = std::io::Error::last_os_error();
    let code = error
        .raw_os_error()
        .expect("last_os_error returns an OS error code");
    if !succeeded && needs_app_choice(code, info.instance as isize) {
        info.verb = choose.as_ptr();
        succeeded = unsafe { ShellExecuteExW(&mut info) } != 0;
        error = std::io::Error::last_os_error();
    }
    unsafe { CoUninitialize() };
    if succeeded || error.raw_os_error() == Some(1223) {
        return Ok(());
    }
    Err(format!(
        "Could not open the graphics config in an external editor: {error}"
    ))
}

#[cfg(any(windows, test))]
fn needs_app_choice(error: i32, shell_error: isize) -> bool {
    match error {
        1155 => true,
        0 => matches!(shell_error, 27 | 31),
        _ => false,
    }
}

#[cfg(test)]
#[path = "graphics_config_tests.rs"]
mod tests;
