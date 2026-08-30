use std::path::{Path, PathBuf};

use crate::commands::mods::extract_archive_flat;
use crate::game_package::{LoaderConfig, Storefront, Ue4ssConfig};

/// UE4SS is a community-forked Lua and native modding framework. Unlike SuperBLT and DAHM
/// (one maintainer, one stable build), each game's UE4SS build is a separately maintained
/// fork with its own proxy DLLs and destination, so both are declared per game rather than
/// shared here.
const LOADER_ID: &str = "ue4ss";

fn storefront(launcher: Option<&str>) -> Option<Storefront> {
    match launcher? {
        "steam" => Some(Storefront::Steam),
        "epic" => Some(Storefront::Epic),
        "xbox" => Some(Storefront::Xbox),
        _ => None,
    }
}

fn descriptor_for(game_id: &str, launcher: Option<&str>) -> Option<&'static Ue4ssConfig> {
    let storefront = storefront(launcher)?;
    let (_, pkg) = crate::games::discovered()
        .iter()
        .find(|(id, _)| *id == game_id)?;
    let config = pkg.loaders.iter().find_map(|binding| {
        match (binding.loader_id.as_str(), binding.config.as_ref()?) {
            (LOADER_ID, LoaderConfig::Ue4ss(config)) => Some(config),
            _ => None,
        }
    })?;
    config.storefronts.contains(&storefront).then_some(config)
}

fn binaries_dir(game_path: &str, descriptor: &Ue4ssConfig) -> PathBuf {
    descriptor
        .binaries_subpath
        .iter()
        .fold(Path::new(game_path).to_path_buf(), |acc, part| {
            acc.join(part)
        })
}

/// Pure presence check, kept free of AppHandle so it is directly unit-testable. The caller
/// must have resolved the launcher already, mirroring crimeboss_settings::sync_enabled.
pub(crate) fn is_installed(game_id: &str, game_path: &str, launcher: Option<&str>) -> bool {
    let Some(descriptor) = descriptor_for(game_id, launcher) else {
        return false;
    };
    let dir = binaries_dir(game_path, descriptor);
    descriptor
        .proxy_dlls
        .iter()
        .any(|dll| dir.join(dll).is_file())
}

/// Extracts a downloaded UE4SS loader package flat into the game's Binaries directory.
/// Unlike a normal mod install this is never recorded in state.json, mirroring superblt
/// and dahm: presence-detected via is_installed, not tracked or uninstallable through
/// Modrex.
pub(crate) fn install_loader(
    game_id: &str,
    game_path: &str,
    launcher: Option<&str>,
    zip_path: &Path,
) -> Result<(), String> {
    let Some(descriptor) = descriptor_for(game_id, launcher) else {
        return Err(
            "UE4SS isn't supported yet for this game and launcher combination.".to_string(),
        );
    };
    let dest = binaries_dir(game_path, descriptor);
    extract_archive_flat(zip_path, &dest)
}

#[cfg(test)]
#[path = "ue4ss_tests.rs"]
mod tests;
