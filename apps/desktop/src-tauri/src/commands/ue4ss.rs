use std::path::{Path, PathBuf};

use crate::commands::mods::extract_archive_flat;
use crate::game_package::{LoaderBinding, Storefront};

fn storefront(launcher: Option<&str>) -> Option<Storefront> {
    match launcher? {
        "steam" => Some(Storefront::Steam),
        "epic" => Some(Storefront::Epic),
        "xbox" => Some(Storefront::Xbox),
        _ => None,
    }
}

/// The build this game ships for one storefront: where it installs and what proves it is
/// already there.
struct Ue4ssBuild {
    proxy_dlls: &'static [String],
    binaries: &'static [String],
}

fn descriptor_for(game_id: &str, launcher: Option<&str>) -> Option<Ue4ssBuild> {
    let storefront = storefront(launcher)?;
    let (_, pkg) = crate::games::discovered()
        .iter()
        .find(|(id, _)| *id == game_id)?;
    pkg.loaders.iter().find_map(|binding| match binding {
        LoaderBinding::Ue4ss {
            storefronts,
            proxy_dlls,
            install_into,
            ..
        } if storefronts.contains(&storefront) => Some(Ue4ssBuild {
            proxy_dlls,
            binaries: install_into,
        }),
        _ => None,
    })
}

fn binaries_dir(game_path: &str, descriptor: &Ue4ssBuild) -> PathBuf {
    descriptor
        .binaries
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
    let dir = binaries_dir(game_path, &descriptor);
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
    let dest = binaries_dir(game_path, &descriptor);
    extract_archive_flat(zip_path, &dest)
}

#[cfg(test)]
#[path = "ue4ss_tests.rs"]
mod tests;
