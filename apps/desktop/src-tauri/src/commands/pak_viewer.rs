use crate::commands::mods::engine_for_game;
use crate::commands::mods::{get_state_path, read_state, resolve_pak_path};
use crate::commands::settings::{game_settings, read_settings, update_settings};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// One asset (file) listed out of a mod's pak. `class` is the resolved UObject export type
/// where the sidecar could load the package (typically the main export), None for non-pak
/// files and for packages whose load failed or that have no mapping.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PakAsset {
    pub path: String,
    pub size: i64,
    pub class: Option<String>,
}

/// What the renderer needs to build the pak-viewer settings UI. The AES key itself is
/// never sent back over IPC; only whether a user override exists is revealed.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PakViewerConfig {
    pub has_aes_override: bool,
    pub usmap_path: Option<String>,
}

/// The pak viewer only applies to Unreal-pak games: PAYDAY 3 and Crime Boss. The Diesel
/// games (PD2/PDTH/RAID) have no paks to inspect.
fn pak_viewer_game(game_id: &str) -> Result<(), String> {
    if matches!(game_id, "pd3" | "cb") {
        Ok(())
    } else {
        Err(format!(
            "the pak viewer is only available for PAYDAY 3 and Crime Boss, not '{game_id}'"
        ))
    }
}

/// The sidecar binary: the bundled copy beside the app in production, or the local
/// pakviewer/dist build under the repo in dev.
fn pakviewer_path(app: &AppHandle) -> Result<PathBuf, String> {
    let exe = if cfg!(windows) { "pakviewer.exe" } else { "pakviewer" };
    let bundled = app
        .path()
        .resource_dir()
        .map(|d| d.join("pakviewer").join(exe))
        .unwrap_or_default();
    if bundled.exists() {
        return Ok(bundled);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent directory")
        .join("pakviewer")
        .join("src-tauri")
        .join("resources")
        .join("pakviewer")
        .join(exe);
    if dev.exists() {
        return Ok(dev);
    }
    Err(format!(
        "pakviewer is not built; run `pnpm build:pakviewer` first (looked in {bundled:?} and {dev:?})"
    ))
}

/// A user-supplied AES key must be exactly the 64 hex characters Unreal stores keys as.
fn is_valid_aes_key(key: &str) -> bool {
    key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())
}

/// Lists the assets inside a tracked mod's pak by running the CUE4Parse sidecar. The
/// sidecar already applies the game's baked-in default key; --aes is only passed when the
/// user configured an override for this game.
#[tauri::command]
#[specta::specta]
pub async fn list_pak_assets(
    app: AppHandle,
    game_id: String,
    uid: String,
) -> Result<Vec<PakAsset>, String> {
    pak_viewer_game(&game_id)?;
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, &game_id)
        .and_then(|gs| gs.game_path.clone())
    else {
        return Err(format!("{game_id} has no configured game path"));
    };
    let cfg = engine_for_game(&game_id)?;
    let state = read_state(&get_state_path(&game_path, cfg));
    let Some(m) = state.mods.iter().find(|m| m.uid == uid) else {
        return Err("installed mod not found".to_string());
    };
    let Some(pak) = resolve_pak_path(&game_path, cfg, &state.folders, m) else {
        return Err("this mod has no pak to inspect".to_string());
    };

    let mut cmd = tokio::process::Command::new(pakviewer_path(&app)?);
    cmd.arg("--pak").arg(&pak).arg("--game").arg(&game_id);
    if let Some(key) = settings.pak_aes_overrides.get(&game_id) {
        cmd.arg("--aes").arg(key);
    }
    if let Some(usmap) = game_settings(&settings, &game_id)
        .and_then(|gs| gs.pak_usmap_path.clone())
        .filter(|p| Path::new(p).exists())
    {
        cmd.arg("--usmap").arg(&usmap);
    }

    let out = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("pakviewer failed to start: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(if stderr.trim().is_empty() {
            format!("pakviewer exited with {status}", status = out.status)
        } else {
            stderr.trim().to_string()
        });
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("pakviewer returned unparseable output: {e}"))
}

/// The per-game pak-viewer settings for the renderer. The AES override itself is stored
/// in settings.json but never crosses IPC; only its presence does.
#[tauri::command]
#[specta::specta]
pub fn get_pak_viewer_config(app: AppHandle, game_id: String) -> Result<PakViewerConfig, String> {
    pak_viewer_game(&game_id)?;
    let settings = read_settings(&app);
    let has_aes_override = settings.pak_aes_overrides.contains_key(&game_id);
    let usmap_path = game_settings(&settings, &game_id).and_then(|gs| gs.pak_usmap_path.clone());
    Ok(PakViewerConfig {
        has_aes_override,
        usmap_path,
    })
}

/// Stores (or, with an empty key, clears) a per-game AES override. Empty clears because
/// the game's baked-in default is what the sidecar uses when no override exists.
#[tauri::command]
#[specta::specta]
pub fn set_pak_aes_key(app: AppHandle, game_id: String, key: String) -> Result<(), String> {
    pak_viewer_game(&game_id)?;
    let key = key
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X")
        .to_string();
    if !key.is_empty() && !is_valid_aes_key(&key) {
        return Err("AES key must be 64 hexadecimal characters".to_string());
    }
    update_settings(&app, |s| {
        if key.is_empty() {
            s.pak_aes_overrides.remove(&game_id);
        } else {
            s.pak_aes_overrides.insert(game_id, key);
        }
    });
    Ok(())
}

/// Sets (or, with None, clears) the per-game .usmap mapping path used to decode asset
/// names when listing paks.
#[tauri::command]
#[specta::specta]
pub fn set_pak_usmap_path(
    app: AppHandle,
    game_id: String,
    path: Option<String>,
) -> Result<(), String> {
    pak_viewer_game(&game_id)?;
    update_settings(&app, |s| {
        s.games
            .get_or_insert_with(HashMap::new)
            .entry(game_id)
            .or_default()
            .pak_usmap_path = path;
    });
    Ok(())
}
