use crate::commands::launchers::types::{GameDef, Launcher};
use std::fs;
use std::path::{Path, PathBuf};

pub struct Epic;

impl Launcher for Epic {
    fn id(&self) -> &'static str {
        "epic"
    }

    fn is_installed(&self) -> bool {
        epic_manifest_dir().exists()
    }

    // A manifest outlives the install it describes, so the folder is checked the way
    // Steam and Xbox check theirs. Without it a leftover manifest wins the probe order
    // over a store that really has the game and hands back a path with nothing in it.
    fn find_game(&self, game: &GameDef) -> Option<String> {
        let def = game.epic.as_ref()?;
        records_named(&epic_manifest_dir(), def.display_name)
            .into_iter()
            .map(|record| record.location)
            .find(|location| game.is_installation(location))
    }

    fn identify_path(&self, game_path: &str) -> bool {
        Path::new(game_path).join(".egstore").exists()
    }

    fn launch(&self, game: &GameDef, game_path: &str, _opts: Option<&str>) -> Result<(), String> {
        let def = game
            .epic
            .as_ref()
            .ok_or("This game has no Epic launch definition")?;
        let record = record_for_install(&epic_manifest_dir(), def.display_name, game_path)?;
        if record.app_name.is_empty() {
            return Err("The Epic launcher installation record has no application name".into());
        }
        super::open_url(&format!(
            "com.epicgames.launcher://apps/{}?action=launch&silent=true",
            record.app_name
        ))
    }
}

pub(crate) struct EpicRecord {
    pub location: String,
    pub app_name: String,
}

fn epic_manifest_dir() -> PathBuf {
    let prog_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
    PathBuf::from(prog_data)
        .join("Epic")
        .join("EpicGamesLauncher")
        .join("Data")
        .join("Manifests")
}

// The directory holds every Epic game's record, and the launcher leaves empty or
// zero-filled ones behind, so an unreadable record of some other game cannot block this one.
fn records_named(manifest_dir: &Path, display_name: &str) -> Vec<EpicRecord> {
    let Ok(entries) = fs::read_dir(manifest_dir) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("item") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        if v["DisplayName"].as_str() != Some(display_name) {
            continue;
        }
        let Some(location) = v["InstallLocation"].as_str() else {
            continue;
        };
        records.push(EpicRecord {
            location: location.to_string(),
            app_name: v["AppName"].as_str().unwrap_or("").to_string(),
        });
    }
    records
}

/// The record describing the copy in game_path. Two copies can share a display name, so
/// matching on the name alone could launch the other one.
pub(crate) fn record_for_install(
    manifest_dir: &Path,
    display_name: &str,
    game_path: &str,
) -> Result<EpicRecord, String> {
    let selected = fs::canonicalize(game_path)
        .map_err(|e| format!("Could not resolve the selected Epic game folder: {e}"))?;
    let mut matching = records_named(manifest_dir, display_name)
        .into_iter()
        .filter(|record| fs::canonicalize(&record.location).is_ok_and(|root| root == selected));
    let record = matching.next().ok_or(
        "The Epic launcher installation record for the selected game folder could not be found",
    )?;
    if matching.next().is_some() {
        return Err(
            "More than one Epic launcher installation record names the selected game folder".into(),
        );
    }
    Ok(record)
}

#[cfg(test)]
#[path = "epic_tests.rs"]
mod tests;
