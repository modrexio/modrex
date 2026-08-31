//! The one table a mod loader registers in. A loader is a hook installed next to the game
//! (never tracked in state.json, never uninstallable through Modrex), so all five differ
//! only in how presence is detected and how the package lands on disk, and this captures
//! both as data. check_loader and install_loader dispatch over it and list_loaders hands
//! it to the renderer, so a new game's loader is one entry here and nothing else.

use tauri::AppHandle;

use crate::commands::download::download_file;
use crate::commands::mods::{extract_archive_flat, extract_entry};

/// How a loader's presence is detected. Both variants read the disk only: a loader is
/// never recorded in state.json, so the files themselves are the sole install signal.
pub enum DetectStrategy {
    /// Any one of these files sitting in the game root means the loader is installed.
    RootFiles(&'static [&'static str]),
    /// Any one of these files in a fixed subpath under the game root. Loaders that hook
    /// next to the executable (rather than the game root) use this — e.g. the Ultimate ASI
    /// Loader's proxy DLL, which sits in the game's Binaries folder, not the root.
    FilesInDir {
        subpath: &'static [&'static str],
        files: &'static [&'static str],
    },
    /// UE4SS resolves its proxy DLL and destination per (game, launcher) and lives in a
    /// nested Binaries dir, so detection delegates to ue4ss's verified descriptor table
    /// rather than flattening into a root-file list.
    Ue4ssProxy,
}

/// How a loader's package is installed. The URLs are stable redirect endpoints, verified
/// against the real downloads.
pub enum InstallStrategy {
    /// Pull exactly these entries out of the archive into the game root. Used when the
    /// archive carries more than the loader itself, or when only the DLLs are wanted.
    ExtractEntries {
        url: &'static str,
        entries: &'static [&'static str],
    },
    /// Same, but into a fixed subpath under the game root rather than the root itself
    /// (e.g. the ASI loader's proxy DLL into the game's Binaries folder).
    ExtractEntriesInto {
        url: &'static str,
        entries: &'static [&'static str],
        subpath: &'static [&'static str],
    },
    /// Extract the whole archive flat into the game root. Used when the package ships
    /// support files the loader needs (DAHM's framework modules, RAID's Lua basemod).
    ExtractAllFlat { url: &'static str },
    /// No canonical download host, since each release is somebody's modworkshop mod page,
    /// so installing goes through the normal mod-install flow instead (see zip.rs's
    /// UE4SS_LOADER sentinel).
    ViaModFlow,
}

pub struct LoaderSpec {
    pub id: &'static str,
    /// modworkshop mod ids this loader is published under. A dependency on one of these
    /// means "install the loader", not "install a mod". Empty for loaders hosted offsite
    /// (SuperBLT has no modworkshop page, so the renderer matches it by a name heuristic).
    pub modworkshop_ids: &'static [i64],
    /// Games whose mods can depend on this loader.
    pub games: &'static [&'static str],
    pub detect: DetectStrategy,
    pub install: InstallStrategy,
}

/// The registry as the renderer sees it, so loader ids and their games live in one
/// place instead of being restated in deps.ts.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoaderInfo {
    pub id: String,
    pub modworkshop_ids: Vec<i64>,
    pub games: Vec<String>,
    /// No direct download, so the renderer must route installs through the normal mod
    /// flow rather than calling install_loader.
    pub via_mod_flow: bool,
}

pub static LOADER_REGISTRY: &[LoaderSpec] = &[
    LoaderSpec {
        id: "superblt",
        modworkshop_ids: &[],
        games: &["pd2"],
        // WSOCK32.dll (current), IPHLPAPI.dll (legacy), libsuperblt_loader.so (Linux
        // native). The loader never appears under mods/, so game-root presence is the
        // only reliable signal.
        detect: DetectStrategy::RootFiles(&[
            "WSOCK32.dll",
            "IPHLPAPI.dll",
            "libsuperblt_loader.so",
        ]),
        // Latest-release endpoint from superblt.znix.xyz, which 302s to a versioned zip
        // containing exactly WSOCK32.dll. The basemod (mods/base) is fetched by the
        // loader itself on next launch, which is why only the DLL is extracted.
        install: InstallStrategy::ExtractEntries {
            url: "https://sblt-update.znix.xyz/pd2update/download/get.php?src=modrex&id=payday2bltwsockdll",
            entries: &["WSOCK32.dll"],
        },
    },
    LoaderSpec {
        id: "pdth_overrides",
        modworkshop_ids: &[53474],
        games: &["pdth"],
        // DINPUT8.dll is the proxy loader and PDTHModOverrides.dll the payload. Only the
        // proxy's presence is the install signal, but both are extracted below.
        detect: DetectStrategy::RootFiles(&["DINPUT8.dll"]),
        install: InstallStrategy::ExtractEntries {
            url: "https://github.com/HW12Dev/PDTHModOverrides/releases/latest/download/PDTHModOverrides.zip",
            entries: &["DINPUT8.dll", "PDTHModOverrides.dll"],
        },
    },
    LoaderSpec {
        id: "dahm",
        modworkshop_ids: &[14267],
        games: &["pdth"],
        detect: DetectStrategy::RootFiles(&["lightfx.dll"]),
        // Stable redirect maintained by DAHM's author, which 302s to a versioned ZIP that
        // extracts flat to the game root (it ships ~40 framework modules alongside).
        install: InstallStrategy::ExtractAllFlat {
            url: "https://dahm.neonsynth.de/main.php",
        },
    },
    LoaderSpec {
        id: "raid_superblt",
        modworkshop_ids: &[49744],
        games: &["raid"],
        // IPHLPAPI.dll is also what the discontinued RaidBLT shipped, so its presence
        // means a BLT hook is installed, not necessarily the SuperBLT one. No Linux
        // variant, because RAID has no native Linux build.
        detect: DetectStrategy::RootFiles(&["WSOCK32.dll", "IPHLPAPI.dll"]),
        // Stable default-download endpoint of the modworkshop page. Unlike PD2's
        // SuperBLT the zip ships the Lua basemod (mods/base) and updater/ inside, so a
        // full extraction is the complete install.
        install: InstallStrategy::ExtractAllFlat {
            url: "https://api.modworkshop.net/mods/49744/download",
        },
    },
    LoaderSpec {
        id: "ue4ss",
        // Crime Boss (47749) plus PD3's two independently-maintained mod pages
        // (47771 newer, 44048 older). Both PD3 ids must be recognized.
        modworkshop_ids: &[47749, 47771, 44048],
        games: &["cb", "pd3"],
        detect: DetectStrategy::Ue4ssProxy,
        install: InstallStrategy::ViaModFlow,
    },
];

pub fn loader_spec(loader_id: &str) -> Option<&'static LoaderSpec> {
    LOADER_REGISTRY.iter().find(|s| s.id == loader_id)
}

fn spec_or_err(loader_id: &str) -> Result<&'static LoaderSpec, String> {
    loader_spec(loader_id).ok_or_else(|| format!("unknown loader id '{loader_id}'"))
}

/// The whole registry, for the renderer to map dependency ids to loaders without
/// restating the tables.
#[tauri::command]
#[specta::specta]
pub fn list_loaders() -> Vec<LoaderInfo> {
    LOADER_REGISTRY
        .iter()
        .map(|s| LoaderInfo {
            id: s.id.to_string(),
            modworkshop_ids: s.modworkshop_ids.to_vec(),
            games: s.games.iter().map(|g| g.to_string()).collect(),
            via_mod_flow: matches!(s.install, InstallStrategy::ViaModFlow),
        })
        .collect()
}

#[tauri::command]
#[specta::specta]
pub fn check_loader(
    app: AppHandle,
    loader_id: String,
    game_id: String,
    game_path: String,
) -> Result<bool, String> {
    let spec = spec_or_err(&loader_id)?;
    let settings = crate::commands::settings::read_settings(&app);
    let launcher = crate::commands::settings::game_settings(&settings, &game_id)
        .and_then(|gs| gs.launcher.clone());
    let installed = is_loader_installed(spec, &game_id, &game_path, launcher.as_deref());

    // PD2's Diesel 3.0 branch has no SuperBLT build, so the DLL being present does not mean
    // the loader works. Answering that here rather than at one call site keeps every
    // consumer consistent: if only the dep warning knew, a mod page would report SuperBLT
    // installed while installing the same mod reported it missing.
    // Temporary, remove with the Diesel 3.0 notice (.TODO: remove-diesel3-notice).
    if installed && spec.id == "superblt" && crate::commands::superblt::is_diesel3(&game_path) {
        return Ok(false);
    }
    Ok(installed)
}

#[tauri::command]
#[specta::specta]
pub async fn install_loader(
    app: AppHandle,
    loader_id: String,
    game_path: String,
) -> Result<(), String> {
    install_loader_package(spec_or_err(&loader_id)?, &app, &game_path).await
}

/// Whether the loader's files are on disk. The launcher is only consulted by the UE4SS
/// descriptor table, and root-file loaders ignore it.
pub fn is_loader_installed(
    spec: &LoaderSpec,
    game_id: &str,
    game_path: &str,
    launcher: Option<&str>,
) -> bool {
    match spec.detect {
        DetectStrategy::RootFiles(files) => {
            let dir = std::path::Path::new(game_path);
            files.iter().any(|f| dir.join(f).is_file())
        }
        DetectStrategy::FilesInDir { subpath, files } => {
            let dir = subpath.iter().fold(
                std::path::Path::new(game_path).to_path_buf(),
                |acc, part| acc.join(part),
            );
            files.iter().any(|f| dir.join(f).is_file())
        }
        DetectStrategy::Ue4ssProxy => {
            crate::commands::ue4ss::is_installed(game_id, game_path, launcher)
        }
    }
}

/// Downloads a loader package and lays it out per its install strategy. ViaModFlow
/// loaders have no canonical URL and never reach this path.
pub async fn install_loader_package(
    spec: &'static LoaderSpec,
    app: &AppHandle,
    game_path: &str,
) -> Result<(), String> {
    let (url, entries, dest_subpath) = match spec.install {
        InstallStrategy::ExtractEntries { url, entries } => (url, Some(entries), &[][..]),
        InstallStrategy::ExtractEntriesInto {
            url,
            entries,
            subpath,
        } => (url, Some(entries), subpath),
        InstallStrategy::ExtractAllFlat { url } => (url, None, &[][..]),
        InstallStrategy::ViaModFlow => {
            return Err(format!(
                "loader '{}' installs through the normal mod flow, not a direct download",
                spec.id
            ))
        }
    };

    let download_id = format!("loader:{}", spec.id);
    let zip_path = download_file(app, url, "zip", &download_id).await?;
    let mut dest_dir = std::path::Path::new(game_path).to_path_buf();
    for part in dest_subpath {
        dest_dir = dest_dir.join(part);
    }
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let result = match entries {
        Some(entries) => {
            let mut outcome = Ok(());
            for name in entries {
                let zip = zip_path.clone();
                let dest = dest_dir.join(name);
                let entry = name.to_string();
                outcome = tokio::task::spawn_blocking(move || extract_entry(&zip, &entry, &dest))
                    .await
                    .map_err(|e| e.to_string())?;
                if outcome.is_err() {
                    break;
                }
            }
            outcome
        }
        None => {
            let zip = zip_path.clone();
            tokio::task::spawn_blocking(move || extract_archive_flat(&zip, &dest_dir))
                .await
                .map_err(|e| e.to_string())?
        }
    };

    let _ = tokio::fs::remove_file(&zip_path).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn loader_ids_are_unique() {
        let mut ids: Vec<&str> = LOADER_REGISTRY.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), LOADER_REGISTRY.len());
    }

    /// The renderer resolves loaders by these ids, so a renamed or dropped entry must
    /// fail here rather than at the user's first click.
    #[test]
    fn every_known_loader_id_resolves() {
        for id in [
            "superblt",
            "pdth_overrides",
            "dahm",
            "raid_superblt",
            "ue4ss",
        ] {
            assert!(loader_spec(id).is_some(), "{id} is not in LOADER_REGISTRY");
        }
    }

    /// A modworkshop id must map to exactly one loader, because the renderer turns a
    /// dependency id straight into a loader without disambiguating.
    #[test]
    fn modworkshop_ids_do_not_collide_across_loaders() {
        let mut seen: Vec<i64> = LOADER_REGISTRY
            .iter()
            .flat_map(|s| s.modworkshop_ids.iter().copied())
            .collect();
        let total = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), total);
    }

    #[test]
    fn every_loader_targets_registered_games() {
        for spec in LOADER_REGISTRY {
            assert!(!spec.games.is_empty(), "{} lists no games", spec.id);
            for game in spec.games {
                assert!(
                    crate::commands::games::game_spec(game).is_some(),
                    "{} targets unknown game '{game}'",
                    spec.id
                );
            }
        }
    }

    fn detects(loader_id: &str, files: &[&str]) -> bool {
        let tmp = TempDir::new().unwrap();
        for f in files {
            fs::write(tmp.path().join(f), b"").unwrap();
        }
        is_loader_installed(
            loader_spec(loader_id).unwrap(),
            "pd2",
            tmp.path().to_str().unwrap(),
            None,
        )
    }

    #[test]
    fn superblt_detects_current_legacy_and_linux_loaders() {
        assert!(detects("superblt", &["WSOCK32.dll"]));
        assert!(detects("superblt", &["IPHLPAPI.dll"]));
        assert!(detects("superblt", &["libsuperblt_loader.so"]));
        assert!(!detects("superblt", &[]));
    }

    #[test]
    fn raid_superblt_detects_either_hook_but_has_no_linux_variant() {
        assert!(detects("raid_superblt", &["WSOCK32.dll"]));
        assert!(detects("raid_superblt", &["IPHLPAPI.dll"]));
        assert!(!detects("raid_superblt", &["libsuperblt_loader.so"]));
    }

    /// DINPUT8.dll is the proxy and the only install signal.
    /// The payload DLL alone means the loader is not hooked in.
    #[test]
    fn pdth_overrides_requires_the_proxy_dll() {
        assert!(detects("pdth_overrides", &["DINPUT8.dll"]));
        assert!(!detects("pdth_overrides", &["PDTHModOverrides.dll"]));
    }

    #[test]
    fn dahm_detects_its_hook() {
        assert!(detects("dahm", &["lightfx.dll"]));
        assert!(!detects("dahm", &["WSOCK32.dll"]));
    }


    #[test]
    fn a_directory_named_like_the_loader_does_not_count() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("WSOCK32.dll")).unwrap();
        assert!(!is_loader_installed(
            loader_spec("superblt").unwrap(),
            "pd2",
            tmp.path().to_str().unwrap(),
            None
        ));
    }

    /// The Diesel 3.0 carve-out lives in check_loader, which needs an AppHandle. This
    /// asserts raw detection stays pure so the override has exactly one home: applied in
    /// only one consumer, a mod page would report SuperBLT installed while installing the
    /// same mod reported it missing.
    #[test]
    fn raw_superblt_detection_ignores_the_diesel3_marker() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("WSOCK32.dll"), b"").unwrap();
        fs::write(tmp.path().join("PAYDAY2.exe"), b"").unwrap();
        let path = tmp.path().to_str().unwrap();
        assert!(is_loader_installed(
            loader_spec("superblt").unwrap(),
            "pd2",
            path,
            None
        ));
        assert!(crate::commands::superblt::is_diesel3(path));
    }

    #[test]
    fn nonexistent_game_path_is_not_installed() {
        assert!(!is_loader_installed(
            loader_spec("superblt").unwrap(),
            "pd2",
            "Z:/does/not/exist",
            None
        ));
    }
}
