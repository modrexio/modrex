//! Backend game registry: mod engine, storefront definition, and optional package reader.

use crate::commands::launchers::{GameDef, CRIMEBOSS, PD2, PD3, PDTH, RAID};
use crate::commands::mods::{
    ModEngineConfig, CRIMEBOSS_ENGINE, PD2_ENGINE, PD3_ENGINE, PDTH_ENGINE, RAID_ENGINE,
};

pub struct UnrealPackageReaderConfig {
    pub aes_key: &'static str,
}

pub struct GameSpec {
    pub id: &'static str,
    pub engine: &'static ModEngineConfig,
    pub def: &'static GameDef,
    pub unreal_package_reader: Option<UnrealPackageReaderConfig>,
}

pub static GAME_REGISTRY: &[GameSpec] = &[
    GameSpec {
        id: "pd3",
        engine: &PD3_ENGINE,
        def: &PD3,
        unreal_package_reader: Some(UnrealPackageReaderConfig {
            aes_key: "27DFBADBB537388ACDE27A7C5F3EBC3721AF0AE0A7602D2D7F8A16548F37D394",
        }),
    },
    GameSpec {
        id: "pd2",
        engine: &PD2_ENGINE,
        def: &PD2,
        unreal_package_reader: None,
    },
    GameSpec {
        id: "pdth",
        engine: &PDTH_ENGINE,
        def: &PDTH,
        unreal_package_reader: None,
    },
    GameSpec {
        id: "cb",
        engine: &CRIMEBOSS_ENGINE,
        def: &CRIMEBOSS,
        unreal_package_reader: Some(UnrealPackageReaderConfig {
            aes_key: "40A34FBE5D5DC4BF94ECDCF042816C7C57AA11FAEE07FDB71E908E97A2F28FA6",
        }),
    },
    GameSpec {
        id: "raid",
        engine: &RAID_ENGINE,
        def: &RAID,
        unreal_package_reader: None,
    },
];

pub fn game_spec(game_id: &str) -> Option<&'static GameSpec> {
    GAME_REGISTRY.iter().find(|s| s.id == game_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_ids_match_their_engine_game_ids() {
        for spec in GAME_REGISTRY {
            assert_eq!(spec.id, spec.engine.game_id);
        }
    }

    #[test]
    fn spec_ids_are_unique() {
        let mut ids: Vec<&str> = GAME_REGISTRY.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), GAME_REGISTRY.len());
    }

    #[test]
    fn package_reader_keys_are_aes_256_hex() {
        for config in GAME_REGISTRY
            .iter()
            .filter_map(|spec| spec.unreal_package_reader.as_ref())
        {
            assert_eq!(config.aes_key.len(), 64);
            assert!(config.aes_key.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
    }
}
