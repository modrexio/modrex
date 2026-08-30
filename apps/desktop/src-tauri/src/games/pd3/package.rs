use crate::game_package::{EnabledStateMechanism, EpicStore, GamePackage, Installation, LoaderBinding, LoaderConfig, ModWorkshopBinding, NewsBinding, NexusBinding, SignalSource, Sources, SteamStore, Storefront, Target, Ue4ssConfig, Unit, XboxStore, UE4SS_BUNDLED_SUBMODS};

fn owned(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

pub fn package() -> GamePackage {
    GamePackage {
        id: "pd3".to_string(),
        display_name: "PAYDAY 3".to_string(),
        short_name: "PD3".to_string(),
        index_game_name: "PAYDAY 3".to_string(),
        state_filename: ".modrex.json".to_string(),
        signals: SignalSource::None,
        installation: Installation {
            executables: owned(&["PAYDAY3.exe"]),
            required_launch_flag: Some("-fileopenlog".to_string()),
            process_names: owned(&["PAYDAY3-Win64-Shipping"]),
            steam: Some(SteamStore {
                app_id: 1272080,
                folder_name: "PAYDAY3".to_string(),
            }),
            epic: Some(EpicStore {
                display_name: "PAYDAY 3".to_string(),
            }),
            xbox: Some(XboxStore {
                product_id: "9NPZVDCH73SX".to_string(),
                executable: "PAYDAY3/Binaries/WinGDK/PAYDAY3-WinGDK-Shipping.exe".to_string(),
            }),
        },
        sources: Sources {
            modworkshop: Some(ModWorkshopBinding {
                game_id: "853".to_string(),
            }),
            nexus: Some(NexusBinding {
                domain: "payday3".to_string(),
                numeric_id: 5717,
            }),
        },
        news: Some(NewsBinding {
            category_slug: "payday3".to_string(),
        }),
        loaders: vec![LoaderBinding {
            loader_id: "ue4ss".to_string(),
            // Two independently maintained mod pages distribute UE4SS for this game, each
            // with its own proxy DLL: 44048 (Narknon) ships dxgi.dll and 47771
            // (Shalashaska) ships xinput1_3.dll, so either presence counts. The Xbox and
            // GamePass build stages under Binaries/WinGDK with an unverified proxy DLL,
            // which is why it is absent from storefronts.
            modworkshop_ids: vec![47771, 44048],
            config: Some(LoaderConfig::Ue4ss(Ue4ssConfig {
                storefronts: vec![Storefront::Steam, Storefront::Epic],
                proxy_dlls: owned(&["xinput1_3.dll", "dxgi.dll"]),
                // As with the ue4ss_mods target below, game_path already ends in PAYDAY3,
                // so this names the inner project subfolder, not a second copy of it.
                binaries_subpath: owned(&["PAYDAY3", "Binaries", "Win64"]),
            })),
        }],
        targets: vec![
            Target {
                tag: "paks".to_string(),
                label_key: "mods".to_string(),
                unit: Unit::File {
                    extension: "pak".to_string(),
                    disabled_suffix: ".disabled".to_string(),
                    priority_prefix: true,
                },
                enabled_state: EnabledStateMechanism::Filesystem,
                mods_subpath: owned(&["PAYDAY3", "Content", "Paks", "~mods"]),
                disabled_subpath: owned(&["PAYDAY3", "Content", "Paks", "~mods", "disabled"]),
                backup_subpath: owned(&["PAYDAY3", "Content", "~mods.bak"]),
            },
            // game_path already ends in PAYDAY3, the Steam installdir name, so this names
            // the inner project subfolder rather than repeating the installdir. Verified
            // against a real install.
            Target {
                tag: "ue4ss_mods".to_string(),
                label_key: "ue4ssMods".to_string(),
                unit: Unit::Directory {
                    entry_markers: owned(&["Scripts/main.lua"]),
                    scan_markers: owned(&["Scripts/main.lua"]),
                    index_gated_markers: Vec::new(),
                    excluded_names: owned(UE4SS_BUNDLED_SUBMODS),
                    priority_prefix: false,
                },
                enabled_state: EnabledStateMechanism::Ue4ssModsTxt,
                mods_subpath: owned(&["PAYDAY3", "Binaries", "Win64", "Mods"]),
                disabled_subpath: owned(&["PAYDAY3", "Binaries", "Win64", "Mods", "disabled"]),
                backup_subpath: owned(&["PAYDAY3", "Binaries", "Win64", "Mods.bak"]),
            },
        ],
    }
}
