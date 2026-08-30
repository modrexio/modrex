//! The one table a game registers in: id to engine config plus storefront definition.
//! engine_for_game and game_def_for_id derive from it, so a family-conforming new game
//! is one GameSpec line here plus its launchers/games/<id>.rs file and engine config.

use crate::commands::launchers::{GameDef, CRIMEBOSS, PD2, PD3, PDTH, RAID};
use crate::commands::mods::{
    ModEngineConfig, CRIMEBOSS_ENGINE, PD2_ENGINE, PD3_ENGINE, PDTH_ENGINE, RAID_ENGINE,
};

pub struct GameSpec {
    pub id: &'static str,
    pub engine: &'static ModEngineConfig,
    pub def: &'static GameDef,
}

pub static GAME_REGISTRY: &[GameSpec] = &[
    GameSpec {
        id: "pd3",
        engine: &PD3_ENGINE,
        def: &PD3,
    },
    GameSpec {
        id: "pd2",
        engine: &PD2_ENGINE,
        def: &PD2,
    },
    GameSpec {
        id: "pdth",
        engine: &PDTH_ENGINE,
        def: &PDTH,
    },
    GameSpec {
        id: "cb",
        engine: &CRIMEBOSS_ENGINE,
        def: &CRIMEBOSS,
    },
    GameSpec {
        id: "raid",
        engine: &RAID_ENGINE,
        def: &RAID,
    },
];

// Representation experiment. Registers no game and is not a production location.
#[cfg(test)]
mod package;

#[cfg(test)]
mod package_tests;

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
}
