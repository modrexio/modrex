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
        let root = Path::new(game_path);
        if root.join("steam_appid.txt").exists() {
            return true;
        }
        crate::commands::games::GAME_REGISTRY
            .iter()
            .filter_map(|game| game.def.steam.as_ref())
            .any(|steam| {
                super::steam_manifest::matches_installation(root, steam.app_id).unwrap_or_else(
                    |error| {
                        log::warn!("Could not recognize Steam app {}: {error}", steam.app_id);
                        false
                    },
                )
            })
    }

    fn launch(&self, game: &GameDef, _game_path: &str, opts: Option<&str>) -> Result<(), String> {
        let def = game
            .steam
            .as_ref()
            .ok_or("This game has no Steam launch definition")?;
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
            return super::outside_bundle(std::process::Command::new(&exe).args(&args))
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Could not launch the game through Steam: {e}"));
        }
        #[cfg(target_os = "windows")]
        {
            let verified_argument = crate::games::discovered().iter().find_map(|(_, package)| {
                if !matches!(
                    package.install.store(crate::game_package::Storefront::Steam),
                    Some(crate::game_package::StoreBinding::Steam { app_id, .. }) if *app_id == def.app_id
                ) {
                    return None;
                }
                package.install.steam_windows_no_mods_argument.as_deref()
            });
            verify_uri_fallback(trimmed, verified_argument)?;
        }
        super::open_url(&format!("steam://rungameid/{}", def.app_id))
    }
}

#[cfg(any(target_os = "windows", test))]
fn verify_uri_fallback(
    options: Option<&str>,
    verified_no_mods_argument: Option<&str>,
) -> Result<(), String> {
    let Some(argument) = verified_no_mods_argument else {
        return Ok(());
    };
    if options.is_some_and(|options| options.split_whitespace().any(|option| option == argument)) {
        return Err("Steam's executable could not be located, so the verified no-mods launch option cannot be passed. Open Steam and retry.".into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn steam_install_path() -> Option<String> {
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
pub(crate) fn steam_install_path() -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::verify_uri_fallback;

    #[test]
    fn uri_fallback_refuses_to_drop_a_verified_no_mods_option() {
        assert!(verify_uri_fallback(
            Some("-windowed -synthetic-no-mods"),
            Some("-synthetic-no-mods")
        )
        .is_err());
        assert!(verify_uri_fallback(Some("-windowed"), Some("-synthetic-no-mods")).is_ok());
        assert!(verify_uri_fallback(None, Some("-synthetic-no-mods")).is_ok());
        assert!(verify_uri_fallback(Some("-windowed"), None).is_ok());
    }
}
