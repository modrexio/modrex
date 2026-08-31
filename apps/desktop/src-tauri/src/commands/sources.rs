//! The one table a mod source registers in: which games it serves and the id it knows
//! each game by. Sources differ per game (modworkshop covers all five, Nexus has no RAID
//! presence), and each names games in its own way (modworkshop by numeric game id, Nexus
//! by domain slug), so the mapping is data both sides need and neither should restate.
//! nexus_domain and its reverse derive from this.

pub struct SourceGame {
    pub game_id: &'static str,
    /// What this source calls the game: modworkshop's numeric game id, Nexus's
    /// domain slug. Stored as a string because the two are not the same kind of id.
    pub native_id: &'static str,
    /// Nexus's GraphQL content API (modFileContents) filters on a numeric game id,
    /// while its REST API and nxm:// links name the game by the domain slug in
    /// native_id. Only Nexus has two names for one game, so this is None for every
    /// other source.
    pub numeric_id: Option<u32>,
}

pub struct SourceSpec {
    pub id: &'static str,
    pub games: &'static [SourceGame],
}

pub static SOURCE_REGISTRY: &[SourceSpec] = &[
    SourceSpec {
        id: "modworkshop",
        games: &[
            SourceGame {
                game_id: "pd3",
                native_id: "853",
                numeric_id: None,
            },
            SourceGame {
                game_id: "pd2",
                native_id: "1",
                numeric_id: None,
            },
            SourceGame {
                game_id: "pdth",
                native_id: "2",
                numeric_id: None,
            },
            SourceGame {
                game_id: "cb",
                native_id: "857",
                numeric_id: None,
            },
            SourceGame {
                game_id: "raid",
                native_id: "543",
                numeric_id: None,
            },
        ],
    },
    SourceSpec {
        id: "nexus",
        games: &[
            SourceGame {
                game_id: "pd3",
                native_id: "payday3",
                numeric_id: Some(5717),
            },
            SourceGame {
                game_id: "pd2",
                native_id: "payday2",
                numeric_id: Some(648),
            },
            SourceGame {
                game_id: "pdth",
                native_id: "paydaytheheist",
                numeric_id: Some(4339),
            },
            SourceGame {
                game_id: "cb",
                native_id: "crimebossrockaycity",
                numeric_id: Some(6528),
            },
        ],
    },
];

/// A stable, source-scoped id for InstalledMod.id. Deliberately not a bare negation of
/// remote_id: two different sources can each assign the number 52 to different mods, and
/// negation alone folds both onto -52. Hashing the source id in makes that collision
/// unlikely rather than guaranteed. FNV-1a is a bucketing key, not security-sensitive.
///
/// The magnitude uses 63 bits and so routinely exceeds JS's 2^53 safe-integer range, while
/// ipc_builder casts i64 to a JS number. That is only sound because the renderer compares
/// this value against other copies of itself from the same payload: never recompute it in
/// TypeScript and never pass it back to a command. The real per-source id is remote_id.
pub fn source_native_local_id(source_id: &str, remote_id: &str) -> i64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for byte in source_id
        .bytes()
        .chain(std::iter::once(b':'))
        .chain(remote_id.bytes())
    {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    // Clear the top bit before converting so the negation below can never overflow
    // (i64::MIN has no positive counterpart), then floor at 1 so this is never the
    // literal value 0.
    let magnitude = ((hash >> 1) as i64).max(1);
    -magnitude
}

pub fn source_spec(source_id: &str) -> Option<&'static SourceSpec> {
    SOURCE_REGISTRY.iter().find(|s| s.id == source_id)
}

/// What the source calls this game, or None when the source does not serve it.
pub fn native_id(source_id: &str, game_id: &str) -> Option<&'static str> {
    source_spec(source_id)?
        .games
        .iter()
        .find(|g| g.game_id == game_id)
        .map(|g| g.native_id)
}

/// The reverse, for callbacks where a source hands us its own id (an nxm:// link
/// carries the Nexus domain) and the internal game id is what routes the work.
pub fn game_id_for_native(source_id: &str, native_id: &str) -> Option<&'static str> {
    source_spec(source_id)?
        .games
        .iter()
        .find(|g| g.native_id == native_id)
        .map(|g| g.game_id)
}

/// The registry as the renderer sees it, so the source list a game offers lives in one
/// place instead of being derived from a per-source field on the game spec.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    /// Games this source serves, paired with the id it knows each by. The renderer needs
    /// the native id to build links (a Nexus mod page URL is keyed by domain slug).
    pub games: Vec<SourceGameInfo>,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceGameInfo {
    pub game_id: String,
    pub native_id: String,
}

/// The whole registry, so the renderer can ask which sources a game offers rather than
/// restating the mapping.
#[tauri::command]
#[specta::specta]
pub fn list_sources() -> Vec<SourceInfo> {
    SOURCE_REGISTRY
        .iter()
        .map(|s| SourceInfo {
            id: s.id.to_string(),
            games: s
                .games
                .iter()
                .map(|g| SourceGameInfo {
                    game_id: g.game_id.to_string(),
                    native_id: g.native_id.to_string(),
                })
                .collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::games::GAME_REGISTRY;

    #[test]
    fn source_ids_are_unique() {
        let mut ids: Vec<&str> = SOURCE_REGISTRY.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), SOURCE_REGISTRY.len());
    }

    #[test]
    fn every_source_serves_only_registered_games() {
        for source in SOURCE_REGISTRY {
            assert!(
                !source.games.is_empty(),
                "source {} serves no game",
                source.id
            );
            for game in source.games {
                assert!(
                    GAME_REGISTRY.iter().any(|s| s.id == game.game_id),
                    "source {} names game '{}', which is not in GAME_REGISTRY",
                    source.id,
                    game.game_id
                );
            }
        }
    }

    #[test]
    fn a_source_names_each_game_once() {
        for source in SOURCE_REGISTRY {
            let mut ids: Vec<&str> = source.games.iter().map(|g| g.game_id).collect();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(
                ids.len(),
                source.games.len(),
                "source {} lists a game twice, so native_id would never reach the second",
                source.id
            );
        }
    }

    #[test]
    fn native_ids_are_unique_within_a_source() {
        for source in SOURCE_REGISTRY {
            let mut ids: Vec<&str> = source.games.iter().map(|g| g.native_id).collect();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(
                ids.len(),
                source.games.len(),
                "source {} reuses a native id, so game_id_for_native is ambiguous",
                source.id
            );
        }
    }

    #[test]
    fn native_id_round_trips_for_every_registered_pair() {
        for source in SOURCE_REGISTRY {
            for game in source.games {
                let native = native_id(source.id, game.game_id).expect("native id");
                assert_eq!(native, game.native_id);
                assert_eq!(
                    game_id_for_native(source.id, native),
                    Some(game.game_id),
                    "{}:{} does not round trip",
                    source.id,
                    game.game_id
                );
            }
        }
    }

    #[test]
    fn source_native_local_id_is_deterministic() {
        assert_eq!(
            source_native_local_id("nexus", "52"),
            source_native_local_id("nexus", "52")
        );
    }

    #[test]
    fn source_native_local_id_is_always_negative() {
        for (source, remote) in [("nexus", "1"), ("nexus", "52"), ("modio", "52"), ("x", "")] {
            assert!(
                source_native_local_id(source, remote) < 0,
                "{source}:{remote} produced a non-negative id"
            );
        }
    }

    #[test]
    fn source_native_local_id_does_not_collide_across_sources_sharing_a_remote_id() {
        // The whole point: two different sources both handing out the number 52 must not
        // fold onto the same local id the way bare negation would.
        assert_ne!(
            source_native_local_id("nexus", "52"),
            source_native_local_id("modio", "52")
        );
    }

    #[test]
    fn unknown_source_or_game_resolves_to_nothing() {
        assert_eq!(native_id("no-such-source", "pd3"), None);
        assert_eq!(native_id("nexus", "no-such-game"), None);
        // Nexus has no RAID presence, so that must not resolve.
        assert_eq!(native_id("nexus", "raid"), None);
    }

    #[test]
    fn every_nexus_game_has_a_numeric_id() {
        let nexus = source_spec("nexus").expect("nexus registered");
        for game in nexus.games {
            assert!(
                game.numeric_id.is_some(),
                "nexus:{} has no numeric_id, so modFileContents lookups can't filter on it",
                game.game_id
            );
        }
    }

    #[test]
    fn every_modworkshop_game_has_no_numeric_id() {
        let modworkshop = source_spec("modworkshop").expect("modworkshop registered");
        for game in modworkshop.games {
            assert!(
                game.numeric_id.is_none(),
                "modworkshop:{} has a numeric_id, but only nexus has two names for one game",
                game.game_id
            );
        }
    }

    #[test]
    fn nexus_numeric_ids_are_unique() {
        let nexus = source_spec("nexus").expect("nexus registered");
        let mut ids: Vec<u32> = nexus.games.iter().filter_map(|g| g.numeric_id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), nexus.games.len());
    }
}
