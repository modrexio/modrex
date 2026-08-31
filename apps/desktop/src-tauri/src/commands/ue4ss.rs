use std::path::{Path, PathBuf};

use crate::commands::mods::extract_archive_flat;

/// UE4SS is a community-forked Lua and native modding framework. Unlike SuperBLT and DAHM
/// (one maintainer, one stable build), each game's UE4SS build is a separately maintained
/// fork with its own proxy DLLs and destination. Every entry below was verified by
/// downloading and inspecting the real released archives rather than assumed.
///
/// Crime Boss ("UE4SS-CB", modworkshop id 47749): proxy dwmapi.dll, installs into
/// CrimeBoss/Binaries/Win64. Only Steam is verified, as Crime Boss has no Xbox or GamePass
/// release and no Epic build of this mod has been confirmed. One maintainer and one release
/// line, so no other proxy DLL has been seen for this game.
///
/// PAYDAY 3: installs into <game_path>/PAYDAY3/Binaries/Win64 for Steam and Epic. game_path
/// already ends in PAYDAY3 (the Steam installdir name), and this is the inner project
/// subfolder, not a second copy of it. PD3 has several independently maintained mod pages
/// distributing UE4SS, each with its own proxy DLL: id 44048 (Narknon) uses dxgi.dll, and
/// id 47771 (Shalashaska) uses xinput1_3.dll. Detection checks either, so which release a
/// user installed does not matter. The Xbox and GamePass build uses a different destination
/// (Binaries/WinGDK) and an unverified proxy DLL, so it is unsupported rather than guessed.
struct Ue4ssDescriptor {
    proxy_dlls: &'static [&'static str],
    binaries_subpath: &'static [&'static str],
}

/// Halo: Campaign Evolved (UE4SS distributed as Nexus mod 9, UE 5.5.x so the experimental
/// build is required): proxy dwmapi.dll into Meteorite/Binaries/Win64, the game's nested
/// binaries folder. Only Steam is verified; the Xbox Game Pass build uses WinGDK binaries
/// with an unverified proxy DLL, so it is unsupported rather than guessed.
fn descriptor_for(game_id: &str, launcher: Option<&str>) -> Option<Ue4ssDescriptor> {
    match (game_id, launcher) {
        ("cb", Some("steam")) => Some(Ue4ssDescriptor {
            proxy_dlls: &["dwmapi.dll"],
            binaries_subpath: &["CrimeBoss", "Binaries", "Win64"],
        }),
        ("pd3", Some("steam")) | ("pd3", Some("epic")) => Some(Ue4ssDescriptor {
            proxy_dlls: &["xinput1_3.dll", "dxgi.dll"],
            // game_path already ends in .../PAYDAY3 (the Steam installdir name), so this
            // adds the inner PAYDAY3 project subfolder, not a second copy of the installdir.
            // Verified against a real install: <game_path>/PAYDAY3/Binaries/Win64/.
            binaries_subpath: &["PAYDAY3", "Binaries", "Win64"],
        }),
        _ => None,
    }
}

fn binaries_dir(game_path: &str, descriptor: &Ue4ssDescriptor) -> PathBuf {
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
