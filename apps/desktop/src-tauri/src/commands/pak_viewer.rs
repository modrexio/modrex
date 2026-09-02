use crate::commands::games::game_spec;
use crate::commands::mods::{get_state_path, read_state, resolve_pak_path, sidecar_path};
use crate::commands::settings::{game_settings, read_settings};
use aes::cipher::KeyInit;
use retoc::ser::ReadExt;
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PakAsset {
    pub path: String,
}

fn normalized_asset_path(path: &str) -> String {
    path.trim_start_matches("../")
        .trim_start_matches('/')
        .replace('\\', "/")
}

fn list_legacy_pak(pak_path: &Path, aes_key: &str) -> Result<Vec<PakAsset>, String> {
    let key_bytes = hex::decode(aes_key).map_err(|e| format!("invalid AES key: {e}"))?;
    let key = aes::Aes256::new_from_slice(&key_bytes)
        .map_err(|_| "invalid AES key length".to_string())?;
    let mut input = BufReader::new(
        File::open(pak_path).map_err(|e| format!("failed to open {}: {e}", pak_path.display()))?,
    );
    let pak = repak::PakBuilder::new()
        .key(key)
        .reader(&mut input)
        .map_err(|e| format!("failed to read {}: {e}", pak_path.display()))?;

    Ok(pak
        .files()
        .into_iter()
        .map(|path| PakAsset {
            path: normalized_asset_path(&path),
        })
        .collect())
}

fn list_iostore(utoc_path: &Path, aes_key: &str) -> Result<Vec<PakAsset>, String> {
    let mut config = retoc::Config::default();
    let key = retoc::AesKey::from_str(aes_key).map_err(|e| format!("invalid AES key: {e}"))?;
    config.aes_keys.insert(retoc::FGuid::default(), key);
    let mut input = BufReader::new(
        File::open(utoc_path)
            .map_err(|e| format!("failed to open {}: {e}", utoc_path.display()))?,
    );
    let toc: retoc::Toc = input.de_ctx(Arc::new(config)).map_err(|e| {
        format!(
            "failed to read {}; if it is encrypted, the AES key may be incorrect: {e}",
            utoc_path.display()
        )
    })?;
    let mut assets = toc
        .file_map
        .keys()
        .map(|path| PakAsset {
            path: normalized_asset_path(path),
        })
        .collect::<Vec<_>>();
    assets.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(assets)
}

fn list_unreal_assets(pak_path: &Path, aes_key: &str) -> Result<Vec<PakAsset>, String> {
    let utoc_path = sidecar_path(pak_path, "pak", "utoc")
        .ok_or_else(|| format!("pak path has no .pak extension: {}", pak_path.display()))?;
    if utoc_path
        .try_exists()
        .map_err(|e| format!("failed to inspect {}: {e}", utoc_path.display()))?
    {
        return list_iostore(&utoc_path, aes_key);
    }
    list_legacy_pak(pak_path, aes_key)
}

#[tauri::command]
#[specta::specta]
pub async fn list_pak_assets(
    app: AppHandle,
    game_id: String,
    uid: String,
) -> Result<Vec<PakAsset>, String> {
    let spec = game_spec(&game_id).ok_or_else(|| format!("unknown game '{game_id}'"))?;
    let package_reader = spec
        .unreal_package_reader
        .as_ref()
        .ok_or_else(|| format!("package viewer is not available for '{game_id}'"))?;
    let aes_key = package_reader.aes_key;
    let cfg = spec.engine;
    let settings = read_settings(&app);
    let Some(game_path) = game_settings(&settings, &game_id).and_then(|gs| gs.game_path.clone())
    else {
        return Err(format!("{game_id} has no configured game path"));
    };
    let state = read_state(&get_state_path(&game_path, cfg));
    let Some(m) = state.mods.iter().find(|m| m.uid == uid) else {
        return Err("installed mod not found".to_string());
    };
    let Some(pak) = resolve_pak_path(&game_path, cfg, &state.folders, m) else {
        return Err("this mod has no pak to inspect".to_string());
    };

    tokio::task::spawn_blocking(move || list_unreal_assets(&pak, aes_key))
        .await
        .map_err(|e| format!("pak reader task failed: {e}"))?
}
