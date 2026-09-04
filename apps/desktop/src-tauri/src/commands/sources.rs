//! Resolves the id a mod source knows a game by. Each game declares its own source
//! bindings, and sources name games their own way: modworkshop by numeric game id, Nexus by
//! domain slug plus a separate numeric id its content API filters on.

use crate::game_package::{GamePackage, SourceBinding};

/// The sources Modrex implements a connector for. A game reaches one by declaring a binding,
/// never by being listed here.
pub const SOURCE_IDS: &[&str] = &["modworkshop", "nexus"];

fn package(game_id: &str) -> Option<&'static GamePackage> {
    crate::games::discovered()
        .iter()
        .find(|(id, _)| *id == game_id)
        .map(|(_, pkg)| pkg)
}

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

/// What the source calls this game, or None when the game declares no binding for it.
pub fn native_id(source_id: &str, game_id: &str) -> Option<String> {
    package(game_id)?
        .sources
        .iter()
        .find_map(|binding| match (source_id, binding) {
            ("modworkshop", SourceBinding::ModWorkshop { game_id }) => Some(game_id.clone()),
            ("nexus", SourceBinding::Nexus { domain, .. }) => Some(domain.clone()),
            _ => None,
        })
}

/// The reverse, for callbacks where a source hands us its own id (an nxm:// link carries the
/// Nexus domain) and the internal game id is what routes the work.
pub fn game_id_for_native(source_id: &str, native_id: &str) -> Option<&'static str> {
    crate::games::discovered()
        .iter()
        .find(|(id, _)| self::native_id(source_id, id).as_deref() == Some(native_id))
        .map(|(id, _)| *id)
}

/// The numeric id Nexus's GraphQL content API filters on, which is a different id than the
/// domain slug native_id returns. Both name the same game.
pub fn nexus_numeric_id(game_id: &str) -> Option<u32> {
    package(game_id)?
        .sources
        .iter()
        .find_map(|binding| match binding {
            SourceBinding::Nexus { numeric_id, .. } => Some(*numeric_id),
            SourceBinding::ModWorkshop { .. } => None,
        })
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
    SOURCE_IDS
        .iter()
        .map(|source_id| SourceInfo {
            id: source_id.to_string(),
            games: crate::games::discovered()
                .iter()
                .filter_map(|(game_id, _)| {
                    native_id(source_id, game_id).map(|native_id| SourceGameInfo {
                        game_id: game_id.to_string(),
                        native_id,
                    })
                })
                .collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bound_games(source_id: &str) -> Vec<(&'static str, String)> {
        crate::games::discovered()
            .iter()
            .filter_map(|(game_id, _)| native_id(source_id, game_id).map(|n| (*game_id, n)))
            .collect()
    }

    #[test]
    fn every_source_binding_names_a_source_with_a_connector() {
        for (game_id, pkg) in crate::games::discovered() {
            for binding in &pkg.sources {
                assert!(SOURCE_IDS.contains(&binding.provider()), "{game_id}");
            }
        }
    }

    #[test]
    fn a_native_id_round_trips_for_every_binding() {
        for source_id in SOURCE_IDS {
            for (game_id, native) in bound_games(source_id) {
                assert_eq!(
                    game_id_for_native(source_id, &native),
                    Some(game_id),
                    "{source_id}:{game_id} does not round trip"
                );
            }
        }
    }

    #[test]
    fn native_ids_are_unique_within_a_source() {
        for source_id in SOURCE_IDS {
            let mut ids: Vec<String> = bound_games(source_id).into_iter().map(|(_, n)| n).collect();
            let total = ids.len();
            ids.sort();
            ids.dedup();
            assert_eq!(
                ids.len(),
                total,
                "{source_id} reuses a native id, so game_id_for_native is ambiguous"
            );
        }
    }

    #[test]
    fn a_native_id_is_never_empty() {
        for source_id in SOURCE_IDS {
            for (game_id, native) in bound_games(source_id) {
                assert!(
                    !native.is_empty(),
                    "{source_id}:{game_id} has an empty native id"
                );
            }
        }
    }

    #[test]
    fn every_nexus_binding_carries_a_unique_numeric_id() {
        let mut ids: Vec<u32> = bound_games("nexus")
            .into_iter()
            .map(|(game_id, _)| nexus_numeric_id(game_id).expect("nexus binding has a numeric id"))
            .collect();
        let total = ids.len();
        assert!(total > 0);
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total);
    }

    #[test]
    fn an_unbound_source_or_game_resolves_to_nothing() {
        assert_eq!(native_id("no-such-source", "pd3"), None);
        assert_eq!(native_id("nexus", "no-such-game"), None);
        // Nexus has no RAID presence, so that must not resolve.
        assert_eq!(native_id("nexus", "raid"), None);
        assert_eq!(nexus_numeric_id("raid"), None);
        assert_eq!(game_id_for_native("nexus", "no-such-domain"), None);
    }

    #[test]
    fn listed_sources_carry_only_the_games_bound_to_them() {
        let listed = list_sources();
        assert_eq!(listed.len(), SOURCE_IDS.len());
        for info in listed {
            let expected = bound_games(&info.id);
            assert_eq!(info.games.len(), expected.len(), "{}", info.id);
            for (game_id, native) in expected {
                assert!(
                    info.games
                        .iter()
                        .any(|g| g.game_id == game_id && g.native_id == native),
                    "{} is missing {game_id}",
                    info.id
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
}
