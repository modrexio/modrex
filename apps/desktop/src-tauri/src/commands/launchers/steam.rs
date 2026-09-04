use crate::commands::launchers::types::{GameDef, Launcher};
use std::fs;
use std::path::Path;

pub struct Steam;

impl Launcher for Steam {
    fn id(&self) -> &'static str {
        "steam"
    }

    fn is_installed(&self) -> bool {
        steam_install_path().is_some()
    }

    fn find_game(&self, game: &GameDef) -> Option<String> {
        let def = game.steam.as_ref()?;
        let steam_path = steam_install_path()?;
        for lib in steam_libraries(&steam_path) {
            let candidate = Path::new(&lib)
                .join("steamapps")
                .join("common")
                .join(def.folder_name);
            if game.is_installation(&candidate.to_string_lossy()) {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    }

    fn identify_path(&self, game_path: &str) -> bool {
        Path::new(game_path).join("steam_appid.txt").exists()
    }

    fn launch(&self, game: &GameDef, _game_path: &str, opts: Option<&str>) {
        let Some(def) = game.steam.as_ref() else {
            return;
        };
        let trimmed = opts.map(|o| o.trim()).filter(|o| !o.is_empty());
        if let (Some(opts_str), Some(steam_path)) = (trimmed, steam_install_path()) {
            #[cfg(target_os = "windows")]
            let exe = Path::new(&steam_path)
                .join("steam.exe")
                .to_string_lossy()
                .into_owned();
            #[cfg(not(target_os = "windows"))]
            let exe = {
                let sh = Path::new(&steam_path).join("steam.sh");
                if sh.exists() {
                    sh.to_string_lossy().into_owned()
                } else {
                    "steam".to_string()
                }
            };
            let mut args = vec!["-applaunch".to_string(), def.app_id.to_string()];
            args.extend(opts_str.split_whitespace().map(String::from));
            if let Err(e) =
                super::outside_bundle(std::process::Command::new(&exe).args(&args)).spawn()
            {
                log::warn!("steam launch: spawn failed: {e}");
            }
        } else {
            super::open_url(&format!("steam://rungameid/{}", def.app_id));
        }
    }
}

#[cfg(target_os = "windows")]
fn steam_install_path() -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut cmd = std::process::Command::new("reg");
            cmd.args([
                "query",
                "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam",
                "/v",
                "InstallPath",
            ]);
            let text = super::run_bounded(cmd, std::time::Duration::from_secs(5))?;
            let line = text
                .lines()
                .find(|l| l.contains("InstallPath") && l.contains("REG_SZ"))?;
            let value = line.split("REG_SZ").nth(1)?.trim().to_string();
            (!value.is_empty()).then_some(value)
        })
        .clone()
}

#[cfg(not(target_os = "windows"))]
fn steam_install_path() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let xdg = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| format!("{}/.local/share", home));
    let steam_dir = std::env::var("STEAM_DIR").ok();
    let candidates: Vec<String> = [
        steam_dir,
        Some(format!("{}/Steam", xdg)),
        Some(format!("{}/.steam/steam", home)),
        Some(format!("{}/.steam/Steam", home)),
        Some(format!("{}/snap/steam/common/.local/share/Steam", home)),
        Some(format!(
            "{}/.var/app/com.valvesoftware.Steam/.local/share/Steam",
            home
        )),
    ]
    .into_iter()
    .flatten()
    .collect();
    candidates
        .into_iter()
        .find(|p| Path::new(p).join("steamapps").exists())
}

pub(super) fn steam_libraries(steam_path: &str) -> Vec<String> {
    let vdf = Path::new(steam_path)
        .join("steamapps")
        .join("libraryfolders.vdf");
    let mut paths = vec![steam_path.to_string()];
    if let Ok(content) = fs::read_to_string(vdf) {
        for line in content.lines() {
            let line = line.trim();
            if line.contains("\"path\"") {
                if let Some(p) = line.split('"').nth(3) {
                    paths.push(p.replace("\\\\", "\\"));
                }
            }
        }
    }
    paths
}
