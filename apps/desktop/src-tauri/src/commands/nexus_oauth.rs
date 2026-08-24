// OAuth2 + PKCE (RFC 7636) against users.nexusmods.com, mirroring the flow
// the first-party NexusMods.App uses: public client (no secret), S256
// challenge, custom-scheme redirect, form-encoded token exchange, and the
// refresh_token grant. Endpoints verified live via
// users.nexusmods.com/.well-known/openid-configuration.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::commands::api::{describe_request_error, http_client, user_agent};
use crate::commands::launchers::shell_open_external;
use crate::commands::secrets;
use crate::commands::settings::{read_settings, update_settings, NexusOAuthTokens};

const OAUTH_BASE: &str = "https://users.nexusmods.com/oauth";

// Credential-store keys for the two tokens. See commands::secrets.
const ACCESS_TOKEN_KEY: &str = "nexus_access_token";
const REFRESH_TOKEN_KEY: &str = "nexus_refresh_token";

// These values must remain aligned with the registered public OAuth client.
pub(crate) const CLIENT_ID: &str = "modrex";
pub(crate) const REDIRECT_URI: &str = "modrex://oauth/callback";

// The three scopes Nexus's registration offers (confirmed by support):
// public covers API access, openid the sign-in itself, and profile the user's
// display name and avatar for the settings page.
const SCOPE: &str = "public openid profile";

pub(crate) struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub(crate) fn generate_pkce() -> Pkce {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = s256_challenge(&verifier);
    Pkce {
        verifier,
        challenge,
    }
}

fn s256_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub(crate) fn authorize_url(challenge: &str, state: &str) -> String {
    let mut url =
        reqwest::Url::parse(&format!("{OAUTH_BASE}/authorize")).expect("static oauth url");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge_method", "S256")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("code_challenge", challenge)
        .append_pair("state", state);
    url.to_string()
}

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct TokenResponse {
    pub access_token: String,
    // Absent when the server does not rotate the refresh token on this grant. The caller
    // keeps the token it already holds in that case, so requiring the field here would
    // turn a successful refresh into a failed one.
    #[serde(default)]
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

/// Why a token grant failed. Only the authorization server rejecting the grant itself
/// justifies discarding a stored sign-in, so the two cases stay distinct up to the caller.
#[derive(Debug)]
pub(crate) enum TokenError {
    /// The presented grant is expired, revoked, or already consumed. No retry recovers
    /// it, only a new sign-in.
    Rejected(String),
    /// Network fault, timeout, or a server-side error. This says nothing about whether
    /// the grant is still good, so the sign-in must survive it.
    Transient(String),
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(message) | Self::Transient(message) => write!(f, "{message}"),
        }
    }
}

// RFC 6749 section 5.2 error body: {"error": "...", "error_description": "..."}.
// invalid_grant is deliberately the only code that ends the session. Its siblings
// (invalid_client, unsupported_grant_type) mean this client is misconfigured, where
// discarding the user's credentials would only produce a sign-in loop that fixes
// nothing, and an unparseable body is usually a proxy or captive-portal page.
pub(crate) fn classify_token_error(status: u16, body: &str) -> TokenError {
    let code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string));
    match code.as_deref() {
        Some("invalid_grant") => TokenError::Rejected("invalid_grant".to_string()),
        Some(other) => TokenError::Transient(format!("{status}: {other}")),
        None => TokenError::Transient(format!("{status}")),
    }
}

pub(crate) async fn exchange_code(
    app: &AppHandle,
    code: &str,
    verifier: &str,
) -> Result<TokenResponse, TokenError> {
    token_request(
        app,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT_URI),
            ("code", code),
            ("code_verifier", verifier),
        ],
    )
    .await
}

pub(crate) async fn refresh_tokens(
    app: &AppHandle,
    refresh_token: &str,
) -> Result<TokenResponse, TokenError> {
    token_request(
        app,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ],
    )
    .await
}

async fn token_request(
    app: &AppHandle,
    params: &[(&str, &str)],
) -> Result<TokenResponse, TokenError> {
    let res = http_client()
        .post(format!("{OAUTH_BASE}/token"))
        .header("User-Agent", user_agent(app))
        .form(params)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| TokenError::Transient(describe_request_error(&e)))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(classify_token_error(status.as_u16(), &body));
    }
    res.json()
        .await
        .map_err(|e| TokenError::Transient(e.to_string()))
}

struct PendingLogin {
    verifier: String,
    state: String,
}

// One login attempt at a time. A new "sign in" click replaces any stale
// attempt whose browser tab the user abandoned.
static PENDING_LOGIN: Mutex<Option<PendingLogin>> = Mutex::new(None);

#[tauri::command]
#[specta::specta]
pub fn nexus_oauth_start() {
    let pkce = generate_pkce();
    let state = uuid::Uuid::new_v4().to_string();
    let url = authorize_url(&pkce.challenge, &state);
    *PENDING_LOGIN.lock().unwrap_or_else(|e| e.into_inner()) = Some(PendingLogin {
        verifier: pkce.verifier,
        state,
    });
    shell_open_external(url);
}

// Callback shape: modrex://oauth/callback?code=...&state=..., or an
// error/error_description pair when the user denies the request.
pub(crate) fn parse_callback_url(url: &str) -> Result<(String, String), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|e| format!("nexus oauth: invalid callback: {e}"))?;
    let full = format!(
        "{}://{}{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or(""),
        parsed.path()
    );
    if full != REDIRECT_URI {
        return Err(format!("nexus oauth: unexpected callback '{full}'"));
    }

    let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    if let Some(error) = pairs.get("error") {
        let description = pairs
            .get("error_description")
            .map(|d| format!(": {d}"))
            .unwrap_or_default();
        return Err(format!("nexus oauth: {error}{description}"));
    }
    let code = pairs
        .get("code")
        .cloned()
        .ok_or("nexus oauth: missing code param")?;
    let state = pairs
        .get("state")
        .cloned()
        .ok_or("nexus oauth: missing state param")?;
    Ok((code, state))
}

pub fn spawn_handle_oauth_callback(app: &AppHandle, url: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = handle_oauth_callback(&app, &url).await {
            log::warn!("nexus oauth sign-in failed: {e}");
            let _ = app.emit("nexus-oauth:failed", e);
        }
    });
}

async fn handle_oauth_callback(app: &AppHandle, url: &str) -> Result<(), String> {
    let (code, state) = parse_callback_url(url)?;
    let pending = PENDING_LOGIN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or("nexus oauth: no sign-in in progress")?;
    if pending.state != state {
        return Err("nexus oauth: state mismatch".to_string());
    }

    let tokens = exchange_code(app, &code, &pending.verifier)
        .await
        .map_err(|e| format!("nexus oauth: token exchange failed ({e})"))?;
    // The authorization_code grant always issues one, unlike a refresh (see TokenResponse):
    // without it the session would die at the first expiry with nothing to refresh from.
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or("nexus oauth: sign-in response carried no refresh token")?;
    store_tokens(app, &tokens, &refresh_token).await?;
    log::info!("nexus oauth: signed in");
    app.emit("nexus-oauth:signed-in", ())
        .map_err(|e| e.to_string())
}

// Refresh a minute early so a token never expires mid-request.
const EXPIRY_MARGIN_SECS: i64 = 60;

fn needs_refresh(expires_at: i64, now: i64) -> bool {
    now + EXPIRY_MARGIN_SECS >= expires_at
}

// Serializes refreshes: concurrent requests (e.g. the nxm flow's joined pair)
// would otherwise both send the same refresh token, and if Nexus rotates
// refresh tokens the losing request would invalidate the winner's grant.
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct LoadedTokens {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

const SIGN_IN_REQUIRED: &str = "nexus oauth: sign in required";
const SESSION_EXPIRED: &str = "nexus oauth: session expired, sign in again";

// Emitted whenever a stored sign-in is discarded without the user asking for it, so the
// UI can stop reporting a session that no longer works and offer re-authorization.
// Signing out deliberately does not emit it: the user already knows.
const EXPIRED_EVENT: &str = "nexus-oauth:expired";

// settings.json's nexus_oauth record is the sign-in marker either way. The two token
// values live either inline (the credential store was unavailable at write time) or in
// the OS credential store on the normal path. See store_tokens.
//
// A record whose credential-store entries have gone missing is not recoverable by
// retrying, so it ends the session rather than failing every request forever behind a UI
// that still claims to be signed in.
async fn require_tokens(app: &AppHandle) -> Result<LoadedTokens, String> {
    let Some(saved) = read_settings(app).nexus_oauth else {
        return Err(SIGN_IN_REQUIRED.to_string());
    };
    if let (Some(access_token), Some(refresh_token)) =
        (saved.access_token.clone(), saved.refresh_token.clone())
    {
        return Ok(LoadedTokens {
            access_token,
            refresh_token,
            expires_at: saved.expires_at,
        });
    }
    // A read failure here is the store being unreadable right now, which is transient and
    // must not end the session; only a confirmed absence below does.
    let access_token = secrets::get_secret(ACCESS_TOKEN_KEY).await?;
    let refresh_token = secrets::get_secret(REFRESH_TOKEN_KEY).await?;
    let (Some(access_token), Some(refresh_token)) = (access_token, refresh_token) else {
        end_session(app, "credentials missing from the credential store").await;
        return Err(SIGN_IN_REQUIRED.to_string());
    };
    Ok(LoadedTokens {
        access_token,
        refresh_token,
        expires_at: saved.expires_at,
    })
}

pub(crate) async fn access_token(app: &AppHandle) -> Result<String, String> {
    let tokens = require_tokens(app).await?;
    if !needs_refresh(tokens.expires_at, chrono::Utc::now().timestamp()) {
        return Ok(tokens.access_token);
    }

    let _guard = REFRESH_LOCK.lock().await;
    // Another request may have refreshed while this one waited on the lock.
    let tokens = require_tokens(app).await?;
    if !needs_refresh(tokens.expires_at, chrono::Utc::now().timestamp()) {
        return Ok(tokens.access_token);
    }
    refresh_and_store(app, &tokens.refresh_token).await
}

/// Refreshes regardless of the stored expiry, for a request that was rejected as
/// unauthorized while its token still looked valid. Nexus can retire an access token
/// before expires_at says so (the user revoked the app or changed their password, or the
/// local clock is wrong), and the expiry-driven path above would then never refresh,
/// leaving every request to fail permanently.
///
/// stale is the token that was rejected. Concurrent callers hitting the same rejection
/// must not each spend a refresh: Nexus consumes the refresh token it is given, so the
/// second call would present one the server has already retired and read the rejection as
/// an expired session.
pub(crate) async fn force_refresh(app: &AppHandle, stale: &str) -> Result<String, String> {
    let _guard = REFRESH_LOCK.lock().await;
    let tokens = require_tokens(app).await?;
    if tokens.access_token != stale {
        return Ok(tokens.access_token);
    }
    refresh_and_store(app, &tokens.refresh_token).await
}

// Callers must hold REFRESH_LOCK, for the reason given on force_refresh.
async fn refresh_and_store(app: &AppHandle, refresh_token: &str) -> Result<String, String> {
    let fresh = match refresh_tokens(app, refresh_token).await {
        Ok(fresh) => fresh,
        Err(rejected @ TokenError::Rejected(_)) => {
            end_session(app, &rejected.to_string()).await;
            return Err(SESSION_EXPIRED.to_string());
        }
        Err(transient) => {
            return Err(format!("nexus oauth: token refresh failed ({transient})"));
        }
    };
    let rotated = fresh
        .refresh_token
        .clone()
        .unwrap_or_else(|| refresh_token.to_string());
    // The fresh token is still returned below even if persisting it fails: it is valid
    // for this call regardless, and the only consequence of a failed persist is the user
    // signing in again next launch, not a broken current request.
    if let Err(e) = store_tokens(app, &fresh, &rotated).await {
        log::warn!("nexus oauth: token refreshed but failed to persist ({e})");
    }
    Ok(fresh.access_token)
}

async fn end_session(app: &AppHandle, reason: &str) {
    log::warn!("nexus oauth: session ended ({reason})");
    clear_stored_tokens(app).await;
    let _ = app.emit(EXPIRED_EVENT, ());
}

async fn clear_stored_tokens(app: &AppHandle) {
    // Attempted unconditionally: a sign-in stored under the settings.json fallback
    // never touched the credential store, so these are no-ops for it (delete_secret
    // treats a missing entry as success), and a sign-in stored securely is fully
    // cleared either way.
    if let Err(e) = secrets::delete_secret(ACCESS_TOKEN_KEY).await {
        log::warn!("nexus oauth: clearing stored access token: {e}");
    }
    if let Err(e) = secrets::delete_secret(REFRESH_TOKEN_KEY).await {
        log::warn!("nexus oauth: clearing stored refresh token: {e}");
    }
    update_settings(app, |s| s.nexus_oauth = None);
}

/// refresh_token is passed separately from tokens because a refresh response may omit it
/// (see TokenResponse), in which case the caller passes the one it already holds.
pub(crate) async fn store_tokens(
    app: &AppHandle,
    tokens: &TokenResponse,
    refresh_token: &str,
) -> Result<(), String> {
    let expires_at = chrono::Utc::now().timestamp() + tokens.expires_in as i64;
    let record = if secrets::store_status().await == secrets::SecretStoreStatus::Available {
        secrets::store_secret(ACCESS_TOKEN_KEY, tokens.access_token.clone()).await?;
        secrets::store_secret(REFRESH_TOKEN_KEY, refresh_token.to_string()).await?;
        NexusOAuthTokens {
            access_token: None,
            refresh_token: None,
            expires_at,
        }
    } else {
        log::warn!("nexus oauth: credential store unavailable, storing tokens in settings.json");
        NexusOAuthTokens {
            access_token: Some(tokens.access_token.clone()),
            refresh_token: Some(refresh_token.to_string()),
            expires_at,
        }
    };
    update_settings(app, |s| s.nexus_oauth = Some(record));
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn nexus_oauth_signed_in(app: AppHandle) -> bool {
    read_settings(&app).nexus_oauth.is_some()
}

#[tauri::command]
#[specta::specta]
pub async fn nexus_oauth_sign_out(app: AppHandle) {
    clear_stored_tokens(&app).await;
}

#[cfg(test)]
#[path = "nexus_oauth_tests.rs"]
mod tests;
