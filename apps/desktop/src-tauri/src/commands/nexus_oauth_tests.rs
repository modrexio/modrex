use super::*;

// RFC 7636 appendix B reference vector.
#[test]
fn s256_challenge_matches_rfc7636_vector() {
    assert_eq!(
        s256_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn generate_pkce_produces_valid_verifier() {
    let pkce = generate_pkce();
    // 32 random bytes base64url-encoded without padding is always 43 chars,
    // the RFC 7636 minimum verifier length.
    assert_eq!(pkce.verifier.len(), 43);
    assert!(pkce
        .verifier
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    assert_eq!(pkce.challenge, s256_challenge(&pkce.verifier));
}

#[test]
fn generate_pkce_is_random() {
    assert_ne!(generate_pkce().verifier, generate_pkce().verifier);
}

#[test]
fn authorize_url_carries_all_oauth_params() {
    let url = authorize_url("test-challenge", "test-state");
    let parsed = reqwest::Url::parse(&url).unwrap();
    assert_eq!(
        parsed.origin().ascii_serialization(),
        "https://users.nexusmods.com"
    );
    assert_eq!(parsed.path(), "/oauth/authorize");

    let params: std::collections::HashMap<String, String> =
        parsed.query_pairs().into_owned().collect();
    assert_eq!(params["response_type"], "code");
    assert_eq!(params["scope"], "public openid profile");
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["client_id"], CLIENT_ID);
    assert_eq!(params["redirect_uri"], REDIRECT_URI);
    assert_eq!(params["code_challenge"], "test-challenge");
    assert_eq!(params["state"], "test-state");
}

#[test]
fn parse_callback_extracts_code_and_state() {
    let (code, state) =
        parse_callback_url("modrex://oauth/callback?code=abc123&state=xyz").unwrap();
    assert_eq!(code, "abc123");
    assert_eq!(state, "xyz");
}

#[test]
fn parse_callback_rejects_other_schemes_and_paths() {
    assert!(parse_callback_url("nxm://oauth/callback?code=a&state=b").is_err());
    assert!(parse_callback_url("modrex://other/callback?code=a&state=b").is_err());
    assert!(parse_callback_url("modrex://oauth/other?code=a&state=b").is_err());
}

#[test]
fn parse_callback_requires_code_and_state() {
    assert!(parse_callback_url("modrex://oauth/callback?state=b").is_err());
    assert!(parse_callback_url("modrex://oauth/callback?code=a").is_err());
}

#[test]
fn needs_refresh_only_inside_expiry_margin() {
    let now = 1_000_000;
    assert!(!needs_refresh(now + EXPIRY_MARGIN_SECS + 1, now));
    assert!(needs_refresh(now + EXPIRY_MARGIN_SECS, now));
    assert!(needs_refresh(now, now));
    assert!(needs_refresh(now - 100, now));
}

// The whole point of the split: only these classify as Rejected, because only Rejected
// discards the user's stored sign-in.
#[test]
fn invalid_grant_is_the_only_rejected_token_error() {
    assert!(matches!(
        classify_token_error(
            400,
            r#"{"error":"invalid_grant","error_description":"expired"}"#
        ),
        TokenError::Rejected(_)
    ));
    assert!(matches!(
        classify_token_error(400, r#"{"error":"invalid_client"}"#),
        TokenError::Transient(_)
    ));
    assert!(matches!(
        classify_token_error(400, r#"{"error":"unsupported_grant_type"}"#),
        TokenError::Transient(_)
    ));
}

// A proxy or captive portal answering the token endpoint with HTML must never be read as
// a dead grant, since that would sign the user out over a network problem.
#[test]
fn an_unparseable_error_body_is_transient() {
    assert!(matches!(
        classify_token_error(502, "<!DOCTYPE html><title>Bad Gateway</title>"),
        TokenError::Transient(_)
    ));
    assert!(matches!(
        classify_token_error(500, ""),
        TokenError::Transient(_)
    ));
    // Valid JSON carrying no error field at all.
    assert!(matches!(
        classify_token_error(400, r#"{"message":"nope"}"#),
        TokenError::Transient(_)
    ));
}

#[test]
fn transient_token_errors_name_the_status() {
    assert_eq!(classify_token_error(503, "").to_string(), "503");
    assert_eq!(
        classify_token_error(400, r#"{"error":"invalid_request"}"#).to_string(),
        "400: invalid_request"
    );
}

// A refresh response that does not rotate the refresh token still deserializes, so the
// caller can keep the token it already holds instead of treating the refresh as failed.
#[test]
fn token_response_tolerates_a_missing_refresh_token() {
    let rotated: TokenResponse =
        serde_json::from_str(r#"{"access_token":"a","refresh_token":"r","expires_in":3600}"#)
            .unwrap();
    assert_eq!(rotated.refresh_token.as_deref(), Some("r"));

    let unrotated: TokenResponse =
        serde_json::from_str(r#"{"access_token":"a","expires_in":3600}"#).unwrap();
    assert_eq!(unrotated.refresh_token, None);
    assert_eq!(unrotated.access_token, "a");
}

#[test]
fn parse_callback_surfaces_oauth_error() {
    let err = parse_callback_url(
        "modrex://oauth/callback?error=access_denied&error_description=User+denied",
    )
    .unwrap_err();
    assert_eq!(err, "access was declined on Nexus Mods");
    assert_eq!(
        parse_callback_url("modrex://oauth/callback?error=access_denied").unwrap_err(),
        "access was declined on Nexus Mods"
    );
}

#[test]
fn parse_callback_preserves_other_oauth_errors() {
    assert_eq!(
        parse_callback_url(
            "modrex://oauth/callback?error=server_error&error_description=Try+again"
        )
        .unwrap_err(),
        "nexus oauth: server_error: Try again"
    );
}
