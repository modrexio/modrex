use crate::commands::launchers::types::{GameDef, Launcher};
use std::path::Path;

#[cfg(any(target_os = "windows", test))]
use std::collections::HashMap;
#[cfg(any(target_os = "windows", test))]
use std::fs;
#[cfg(any(target_os = "windows", test))]
use std::path::PathBuf;

#[cfg(target_os = "windows")]
const GAMING_APP: &str = "Microsoft.GamingApp_8wekyb3d8bbwe";

// Long enough to cover the startup burst, far short of any Store install.
#[cfg(target_os = "windows")]
const PACKAGE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

pub struct Xbox;

impl Launcher for Xbox {
    fn id(&self) -> &'static str {
        "xbox"
    }

    fn is_installed(&self) -> bool {
        #[cfg(not(target_os = "windows"))]
        return false;
        #[cfg(target_os = "windows")]
        {
            let local = std::env::var("LOCALAPPDATA")
                .unwrap_or_else(|_| "C:\\Users\\Default\\AppData\\Local".to_string());
            Path::new(&local).join("Packages").join(GAMING_APP).exists()
        }
    }

    #[cfg(target_os = "windows")]
    fn find_game(&self, game: &GameDef) -> Option<String> {
        static ENV: std::sync::OnceLock<PackageCache<WindowsEnvironment>> =
            std::sync::OnceLock::new();
        let env = ENV.get_or_init(|| PackageCache::new(WindowsEnvironment, PACKAGE_CACHE_TTL));
        find_game_in(env, game)
    }

    #[cfg(not(target_os = "windows"))]
    fn find_game(&self, _game: &GameDef) -> Option<String> {
        None
    }

    fn identify_path(&self, game_path: &str) -> bool {
        Path::new(game_path).join("MicrosoftGame.config").exists()
    }

    fn launch(&self, game: &GameDef, game_path: &str, _opts: Option<&str>) {
        let helper = Path::new(game_path).join("gamelaunchhelper.exe");
        if helper.exists() {
            if let Err(e) = std::process::Command::new(&helper).spawn() {
                log::warn!("xbox launch: spawn {helper:?}: {e}");
            }
        } else if let Some(def) = game.xbox.as_ref() {
            super::open_url(&format!("msxbox://game/?productId={}", def.product_id));
        }
    }
}

#[cfg(any(target_os = "windows", test))]
pub(super) trait XboxEnvironment {
    fn fixed_drive_roots(&self) -> Vec<PathBuf>;

    fn package_content_path(&self, product_id: &str) -> Option<PathBuf>;
}

#[cfg(any(target_os = "windows", test))]
pub(super) struct PackageCache<E> {
    pub(super) inner: E,
    ttl: std::time::Duration,
    answers: std::sync::Mutex<HashMap<String, (std::time::Instant, Option<PathBuf>)>>,
}

#[cfg(any(target_os = "windows", test))]
impl<E> PackageCache<E> {
    pub(super) fn new(inner: E, ttl: std::time::Duration) -> Self {
        Self {
            inner,
            ttl,
            answers: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

#[cfg(any(target_os = "windows", test))]
impl<E: XboxEnvironment> XboxEnvironment for PackageCache<E> {
    fn fixed_drive_roots(&self) -> Vec<PathBuf> {
        self.inner.fixed_drive_roots()
    }

    // The lock is held across the query so a probe arriving during one waits for its
    // answer instead of spawning a second PowerShell.
    fn package_content_path(&self, product_id: &str) -> Option<PathBuf> {
        let mut answers = self.answers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((asked, path)) = answers.get(product_id) {
            if asked.elapsed() < self.ttl {
                return path.clone();
            }
        }
        let path = self.inner.package_content_path(product_id);
        answers.insert(
            product_id.to_string(),
            (std::time::Instant::now(), path.clone()),
        );
        path
    }
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn find_game_in(env: &dyn XboxEnvironment, game: &GameDef) -> Option<String> {
    let def = game.xbox.as_ref()?;
    find_in_drives(env, game.name, def.executable)
        .or_else(|| find_via_package_manager(env, def.product_id, def.executable))
}

#[cfg(target_os = "windows")]
pub(super) struct WindowsEnvironment;

#[cfg(target_os = "windows")]
impl XboxEnvironment for WindowsEnvironment {
    // Neither call does volume or network I/O, so enumeration can't stall on a dead
    // drive. Non-fixed drives are excluded: stats on a disconnected network/VPN drive
    // block for the SMB timeout, and Xbox installs only ever live on fixed volumes.
    fn fixed_drive_roots(&self) -> Vec<PathBuf> {
        const DRIVE_FIXED: u32 = 3;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetLogicalDrives() -> u32;
            fn GetDriveTypeW(root_path_name: *const u16) -> u32;
        }
        let mask = unsafe { GetLogicalDrives() };
        (0..26)
            .filter(|i| mask & (1u32 << i) != 0)
            .map(|i| format!("{}:\\", (b'A' + i) as char))
            .filter(|root| {
                let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
                unsafe { GetDriveTypeW(wide.as_ptr()) == DRIVE_FIXED }
            })
            .map(PathBuf::from)
            .collect()
    }

    // The filter stays in the script because run_bounded reads stdout only after exit:
    // returning every install path instead of one line could fill the pipe and deadlock.
    fn package_content_path(&self, product_id: &str) -> Option<PathBuf> {
        let script = format!(
            "$p=Get-AppxPackage|?{{$c=Join-Path $_.InstallLocation 'Content\\MicrosoftGame.config';(Test-Path $c)-and((gc $c -Raw)-match '{}')}}|Select -First 1;if($p){{Join-Path $p.InstallLocation 'Content'}}",
            product_id
        );
        let mut cmd = std::process::Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ]);
        // Get-AppxPackage legitimately takes ~10s on slow machines, bound generously.
        let out = super::run_bounded(cmd, std::time::Duration::from_secs(15))?;
        let path = out.trim();
        (!path.is_empty()).then(|| PathBuf::from(path))
    }
}

// Windows compares paths case-insensitively, so a folder is found whatever its real
// spelling is and the name the search was built from is what ends up saved and shown.
// Reading the name back off disk is what makes the stored path match the user's folder.
// Runs only once a game has been found, so the scan itself costs no extra directory reads.
#[cfg(any(target_os = "windows", test))]
pub(super) fn dir_as_named_on_disk(parent: &Path, name: &str) -> PathBuf {
    fs::read_dir(parent)
        .ok()
        .and_then(|entries| {
            entries
                .flatten()
                .find(|entry| entry.file_name().eq_ignore_ascii_case(name))
        })
        .map(|entry| entry.path())
        .unwrap_or_else(|| parent.join(name))
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn find_in_drives(
    env: &dyn XboxEnvironment,
    game_name: &str,
    xbox_executable: &str,
) -> Option<String> {
    for drive_root in env.fixed_drive_roots() {
        let dirs = match fs::read_dir(&drive_root) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for entry in dirs.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let candidate = entry.path().join(game_name).join("Content");
            if candidate.join(xbox_executable).exists() {
                let found = dir_as_named_on_disk(&entry.path(), game_name).join("Content");
                return Some(found.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn find_via_package_manager(
    env: &dyn XboxEnvironment,
    product_id: &str,
    xbox_executable: &str,
) -> Option<String> {
    let path = env.package_content_path(product_id)?;
    path.join(xbox_executable)
        .exists()
        .then(|| path.to_string_lossy().into_owned())
}
