use super::*;

#[test]
fn parses_present_header() {
    let mut headers = HeaderMap::new();
    headers.insert("x-rl-hourly-remaining", "42".parse().unwrap());
    assert_eq!(parse_hourly_remaining(&headers), Some(42));
}

#[test]
fn returns_none_when_absent() {
    let headers = HeaderMap::new();
    assert_eq!(parse_hourly_remaining(&headers), None);
}

#[test]
fn returns_none_when_malformed() {
    let mut headers = HeaderMap::new();
    headers.insert("x-rl-hourly-remaining", "not-a-number".parse().unwrap());
    assert_eq!(parse_hourly_remaining(&headers), None);
}

#[test]
fn domain_maps_supported_games() {
    assert_eq!(nexus_domain("pd3"), Ok("payday3"));
    assert_eq!(nexus_domain("pd2"), Ok("payday2"));
    assert_eq!(nexus_domain("pdth"), Ok("paydaytheheist"));
    assert_eq!(nexus_domain("cb"), Ok("crimebossrockaycity"));
}

#[test]
fn domain_rejects_unsupported_games() {
    assert!(nexus_domain("raid").is_err());
    assert!(nexus_domain("made_up").is_err());
}

#[test]
fn sort_field_accepts_known_values() {
    for field in ["relevance", "downloads", "endorsements", "updatedAt"] {
        assert_eq!(validate_sort_field(field), Ok(field));
    }
}

#[test]
fn sort_field_rejects_unknown_values() {
    assert!(validate_sort_field("name").is_err());
    assert!(validate_sort_field("").is_err());
}

fn sample_hash_response() -> serde_json::Value {
    serde_json::json!({
        "data": {
            "fileHashes": [
                {
                    "md5": "abc123",
                    "fileName": "Welrod.pak",
                    "fileSize": "468",
                    "gameId": 648,
                    "modFileId": 111,
                    "modFile": {
                        "modId": 101,
                        "fileId": 222,
                        "name": "Welrod",
                        "version": "1.0"
                    }
                },
                {
                    "md5": "def456",
                    "fileName": "OtherGame.pak",
                    "fileSize": "999",
                    "gameId": 5717,
                    "modFileId": 333,
                    "modFile": {
                        "modId": 900,
                        "fileId": 901,
                        "name": "Wrong Game Mod",
                        "version": "2.0"
                    }
                }
            ]
        }
    })
}

#[test]
fn parse_hash_matches_keeps_only_the_requested_game() {
    let matches = parse_hash_matches(&sample_hash_response(), 648).unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].mod_id, 101);
    assert_eq!(matches[0].file_id, 222);
    assert_eq!(matches[0].name, "Welrod");
    assert_eq!(matches[0].version, "1.0");
    assert_eq!(matches[0].file_size, 468);
}

#[test]
fn parse_hash_matches_returns_empty_for_a_game_with_no_hits() {
    let matches = parse_hash_matches(&sample_hash_response(), 4339).unwrap();
    assert!(matches.is_empty());
}

#[test]
fn parse_hash_matches_surfaces_graphql_errors() {
    let value = serde_json::json!({ "errors": [{ "message": "boom" }] });
    let err = parse_hash_matches(&value, 648).unwrap_err();
    assert!(err.contains("boom"));
}

#[test]
fn parse_hash_matches_drops_hashes_with_no_associated_mod_file() {
    let value = serde_json::json!({
        "data": {
            "fileHashes": [
                {
                    "md5": "abc123",
                    "fileName": "Unknown.pak",
                    "fileSize": "1",
                    "gameId": 648,
                    "modFileId": null,
                    "modFile": null
                }
            ]
        }
    });
    let matches = parse_hash_matches(&value, 648).unwrap();
    assert!(matches.is_empty());
}
