use crate::commands::settings::{read_settings, update_settings};
use serde::Serialize;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const START_TIMEOUT: Duration = Duration::from_secs(5);
const START_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SisrStatus {
    pub supported: bool,
    pub installed: bool,
    pub running: bool,
    pub setup_complete: bool,
    pub auto_launch: bool,
}

#[derive(Clone, Copy, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SisrLaunchIssue {
    Unsupported,
    NotInstalled,
    SetupRequired,
    StartFailed,
    StartUnconfirmed,
}

fn matches_sisr_process_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("SISR") || name.eq_ignore_ascii_case("SISR.exe")
}

fn sisr_is_running() -> bool {
    let mut system = sysinfo::System::new();
    let kind = sysinfo::ProcessRefreshKind::nothing();
    system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, kind);
    system
        .processes()
        .values()
        .any(|process| matches_sisr_process_name(&process.name().to_string_lossy()))
}

#[cfg(any(windows, test))]
fn sisr_executable_in(local_app_data: &Path) -> Option<PathBuf> {
    let executable = local_app_data.join("SISR").join("SISR.exe");
    executable.is_file().then_some(executable)
}

fn sisr_setup_complete(executable: &Path) -> bool {
    executable
        .parent()
        .is_some_and(|directory| directory.join(".initial_setup_done").is_file())
}

#[cfg(windows)]
fn sisr_executable() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .and_then(|path| sisr_executable_in(&path))
}

#[cfg(not(windows))]
fn sisr_executable() -> Option<PathBuf> {
    None
}

#[tauri::command]
#[specta::specta]
pub async fn get_sisr_status(app: AppHandle) -> Result<SisrStatus, String> {
    let auto_launch = read_settings(&app).auto_launch_sisr;
    if !cfg!(windows) {
        return Ok(SisrStatus {
            supported: false,
            installed: false,
            running: false,
            setup_complete: false,
            auto_launch,
        });
    }

    tauri::async_runtime::spawn_blocking(move || {
        let executable = sisr_executable();
        SisrStatus {
            supported: true,
            installed: executable.is_some(),
            running: sisr_is_running(),
            setup_complete: executable.as_deref().is_some_and(sisr_setup_complete),
            auto_launch,
        }
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_auto_launch_sisr(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled && !cfg!(windows) {
        return Err("SISR auto-launch is available only on Windows".to_string());
    }
    if enabled {
        let executable = sisr_executable()
            .ok_or_else(|| "SISR was not found in its default installation location".to_string())?;
        if !sisr_setup_complete(&executable) {
            return Err("SISR first-run setup is not complete".to_string());
        }
    }
    update_settings(&app, |settings| settings.auto_launch_sisr = enabled);
    if read_settings(&app).auto_launch_sisr == enabled {
        return Ok(());
    }
    Err("SISR auto-launch setting could not be saved".to_string())
}

pub(crate) async fn prepare_for_game_launch(enabled: bool) -> Option<SisrLaunchIssue> {
    if !enabled {
        return None;
    }
    if !cfg!(windows) {
        return Some(SisrLaunchIssue::Unsupported);
    }

    tauri::async_runtime::spawn_blocking(prepare_for_game_launch_blocking)
        .await
        .unwrap_or_else(|error| {
            log::warn!("failed to join SISR startup task: {error}");
            Some(SisrLaunchIssue::StartFailed)
        })
}

fn prepare_for_game_launch_blocking() -> Option<SisrLaunchIssue> {
    if sisr_is_running() {
        return sisr_executable()
            .as_deref()
            .filter(|executable| !sisr_setup_complete(executable))
            .map(|_| SisrLaunchIssue::SetupRequired);
    }
    let Some(executable) = sisr_executable() else {
        log::warn!("SISR auto-launch is enabled but SISR.exe was not found");
        return Some(SisrLaunchIssue::NotInstalled);
    };
    let working_directory = executable
        .parent()
        .expect("the official SISR executable path includes its install directory");
    let setup_complete = sisr_setup_complete(&executable);
    let api_address = match reserve_api_address() {
        Ok(address) => address,
        Err(error) => {
            log::warn!("failed to reserve a localhost port for SISR: {error}");
            return Some(SisrLaunchIssue::StartFailed);
        }
    };

    let mut child = match std::process::Command::new(&executable)
        .current_dir(working_directory)
        .arg("--api.listen-address")
        .arg(api_address.to_string())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log::warn!("failed to start SISR from {executable:?}: {error}");
            return Some(SisrLaunchIssue::StartFailed);
        }
    };

    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&api_address, START_POLL_INTERVAL).is_ok() {
            log::info!("started SISR");
            return (!setup_complete).then_some(SisrLaunchIssue::SetupRequired);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                log::warn!("SISR exited before startup completed with status {status}");
                return Some(SisrLaunchIssue::StartFailed);
            }
            Err(error) => {
                log::warn!("failed to inspect the SISR process: {error}");
                return Some(SisrLaunchIssue::StartUnconfirmed);
            }
            Ok(None) => std::thread::sleep(START_POLL_INTERVAL),
        }
    }

    log::warn!("could not confirm SISR startup within {START_TIMEOUT:?}");
    Some(SisrLaunchIssue::StartUnconfirmed)
}

fn reserve_api_address() -> std::io::Result<SocketAddr> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.local_addr()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn process_name_match_is_exact_and_case_insensitive() {
        assert!(matches_sisr_process_name("SISR.exe"));
        assert!(matches_sisr_process_name("sisr"));
        assert!(!matches_sisr_process_name("SISR-helper.exe"));
        assert!(!matches_sisr_process_name("mySISR.exe"));
        assert!(!matches_sisr_process_name("SISR.exe.old"));
    }

    #[test]
    fn executable_uses_the_official_install_location() {
        let local_app_data = TempDir::new().unwrap();
        let install_dir = local_app_data.path().join("SISR");
        std::fs::create_dir(&install_dir).unwrap();
        let executable = install_dir.join("SISR.exe");
        std::fs::write(&executable, []).unwrap();

        assert_eq!(
            sisr_executable_in(local_app_data.path()).as_deref(),
            Some(executable.as_path())
        );
        assert!(!sisr_setup_complete(&executable));

        std::fs::write(install_dir.join(".initial_setup_done"), []).unwrap();
        assert!(sisr_setup_complete(&executable));
    }
}
