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

fn sample_match(mod_id: u32, file_size: i64) -> NexusHashMatch {
    NexusHashMatch {
        mod_id,
        file_id: mod_id + 1000,
        name: format!("mod-{mod_id}"),
        version: "1.0".to_string(),
        file_name: "Foo.pak".to_string(),
        file_size,
    }
}

#[test]
fn resolve_archive_identity_finds_nothing() {
    let result = resolve_archive_identity(vec![], 100);
    assert!(matches!(result, NexusArchiveIdentity::NotFound));
}

#[test]
fn resolve_archive_identity_identifies_a_single_match() {
    let result = resolve_archive_identity(vec![sample_match(101, 468)], 468);
    match result {
        NexusArchiveIdentity::Identified(m) => assert_eq!(m.mod_id, 101),
        other => panic!("expected Identified, got {other:?}"),
    }
}

#[test]
fn resolve_archive_identity_disambiguates_by_local_file_size() {
    let matches = vec![sample_match(101, 468), sample_match(202, 900)];
    let result = resolve_archive_identity(matches, 468);
    match result {
        NexusArchiveIdentity::Identified(m) => assert_eq!(m.mod_id, 101),
        other => panic!("expected Identified, got {other:?}"),
    }
}

#[test]
fn resolve_archive_identity_stays_ambiguous_when_sizes_all_match_the_same_bytes() {
    // The realistic case: the same archive cross-posted to two different mods has
    // identical fileSize on both, so size cannot discriminate and a chooser is
    // the only correct outcome.
    let matches = vec![sample_match(101, 468), sample_match(202, 468)];
    let result = resolve_archive_identity(matches, 468);
    match result {
        NexusArchiveIdentity::Ambiguous(m) => assert_eq!(m.len(), 2),
        other => panic!("expected Ambiguous, got {other:?}"),
    }
}

#[test]
fn resolve_archive_identity_stays_ambiguous_when_size_matches_none() {
    let matches = vec![sample_match(101, 468), sample_match(202, 900)];
    let result = resolve_archive_identity(matches, 111);
    match result {
        NexusArchiveIdentity::Ambiguous(m) => assert_eq!(m.len(), 2),
        other => panic!("expected Ambiguous, got {other:?}"),
    }
}

#[test]
fn content_filter_json_sends_game_id_unquoted_and_file_size_quoted() {
    let filter = content_filter_json(
        648,
        &NexusContentQuery::FileNameAndSize {
            file_name: "Foo.pak".to_string(),
            file_size: 1234,
        },
    );
    assert_eq!(filter["gameId"][0]["value"], serde_json::json!(648));
    assert_eq!(filter["fileNameWildcard"][0]["value"], "Foo.pak");
    assert_eq!(filter["fileSize"][0]["value"], "1234");
}

#[test]
fn content_filter_json_folder_segment_uses_file_path_parts_exact() {
    let filter = content_filter_json(
        648,
        &NexusContentQuery::FolderSegment {
            segment: "Welrod".to_string(),
        },
    );
    assert_eq!(filter["filePathPartsExact"][0]["value"], "Welrod");
    assert!(filter.get("fileNameWildcard").is_none());
}

#[test]
fn parse_content_mod_ids_returns_distinct_sorted_ids() {
    let value = serde_json::json!({
        "data": { "modFileContents": { "totalCount": 3, "nodes": [
            { "modId": 101 }, { "modId": 202 }, { "modId": 101 }
        ] } }
    });
    assert_eq!(parse_content_mod_ids(&value).unwrap(), vec![101, 202]);
}

#[test]
fn parse_content_mod_ids_empty_is_not_an_error() {
    let value = serde_json::json!({
        "data": { "modFileContents": { "totalCount": 0, "nodes": [] } }
    });
    assert_eq!(parse_content_mod_ids(&value).unwrap(), Vec::<u32>::new());
}

#[test]
fn parse_content_mod_ids_surfaces_graphql_errors() {
    let value = serde_json::json!({ "errors": [{ "message": "boom" }] });
    let err = parse_content_mod_ids(&value).unwrap_err();
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
