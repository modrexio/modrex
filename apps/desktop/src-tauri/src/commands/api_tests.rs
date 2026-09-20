use super::*;

#[test]
fn version_requests_are_bounded_and_deduplicated() {
    assert!(version_batches(vec![]).unwrap().is_empty());
    assert_eq!(version_batches(vec![2, 1, 2]).unwrap(), vec![vec![1, 2]]);
    assert_eq!(version_batches((1..=100).collect()).unwrap().len(), 1);
    let batches = version_batches((1..=101).collect()).unwrap();
    assert_eq!(
        batches.iter().map(Vec::len).collect::<Vec<_>>(),
        vec![100, 1]
    );
    assert!(version_batches(vec![0]).is_err());
}

#[test]
fn version_contract_preserves_empty_missing_and_opaque_values() {
    let results =
        parse_versions(serde_json::json!({"2": "", "1": "not semver"}), &[1, 2, 3]).unwrap();
    assert!(
        matches!(&results[0], ModVersionResult::Known { version, .. } if version == "not semver")
    );
    assert!(matches!(
        results[1],
        ModVersionResult::Unversioned { id: 2 }
    ));
    assert!(matches!(results[2], ModVersionResult::Missing { id: 3 }));
    assert!(matches!(
        parse_versions(serde_json::json!([]), &[1]).unwrap()[0],
        ModVersionResult::Missing { id: 1 }
    ));
    for invalid in [
        serde_json::json!(null),
        serde_json::json!([1]),
        serde_json::json!({"1": null}),
        serde_json::json!({"2":"x"}),
    ] {
        assert!(parse_versions(invalid, &[1]).is_err());
    }
}

#[test]
fn retries_only_transient_http_statuses() {
    for status in [
        StatusCode::REQUEST_TIMEOUT,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        assert!(retryable_status(status));
    }
    for status in [
        StatusCode::BAD_REQUEST,
        StatusCode::NOT_FOUND,
        StatusCode::UNAUTHORIZED,
    ] {
        assert!(!retryable_status(status));
    }
}

#[test]
fn retry_after_is_bounded() {
    let mut headers = HeaderMap::new();
    headers.insert("retry-after", "3600".parse().unwrap());
    assert_eq!(retry_delay(&headers, 0), Duration::from_secs(60));
}

#[test]
fn parses_present_header() {
    let mut headers = HeaderMap::new();
    headers.insert("x-ratelimit-remaining", "5".parse().unwrap());
    assert_eq!(parse_rate_limit_remaining(&headers), Some(5));
}

#[test]
fn parses_zero() {
    let mut headers = HeaderMap::new();
    headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
    assert_eq!(parse_rate_limit_remaining(&headers), Some(0));
}

#[test]
fn returns_none_when_absent() {
    let headers = HeaderMap::new();
    assert_eq!(parse_rate_limit_remaining(&headers), None);
}

#[test]
fn returns_none_when_malformed() {
    let mut headers = HeaderMap::new();
    headers.insert("x-ratelimit-remaining", "not-a-number".parse().unwrap());
    assert_eq!(parse_rate_limit_remaining(&headers), None);
}
