//! Anonymous, opt-in usage analytics via the GA4 Measurement Protocol.
//!
//! Events are sent from Rust rather than the webview, which keeps the consent gate
//! in one place, attaches reliable environment data (OS, arch, version), and cannot
//! be stripped by in-page ad blockers. Every send is fire-and-forget and failures
//! are swallowed, so analytics can never block or break the app.
//!
//! Requests go to https://modrex.net/api/collect, not Google directly. Sending from
//! Rust defeats only in-page blocking, whereas DNS-level and hosts-file blocklists
//! (Pi-hole, AdGuard Home, NextDNS, debloat-Windows scripts) and outbound firewalls
//! block google-analytics.com for every process on the machine, Rust included, and
//! this audience runs that tooling heavily. A Cloudflare Pages Function at
//! apps/site/functions/api/collect.ts forwards each request verbatim to GA4.
//!
//! Nothing is transmitted unless analytics_enabled is true in settings and the build
//! carries the GA credentials below. This module is the only place that knows the
//! backend is GA4, so swapping sinks is a change to send_event alone.

use crate::commands::api::{http_client, user_agent};
use crate::commands::settings;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

/// GA4 credentials, embedded at compile time. Absent in local and dev builds (and any
/// build without the CI secrets), which makes every send a no-op, so development never
/// pollutes production data. The API secret is write-only and rotatable, so shipping it
/// in the binary is low-risk.
fn measurement_id() -> Option<&'static str> {
    option_env!("MODREX_GA_MEASUREMENT_ID").filter(|s| !s.is_empty())
}

fn api_secret() -> Option<&'static str> {
    option_env!("MODREX_GA_API_SECRET").filter(|s| !s.is_empty())
}

/// Our own domain, not Google's, for the reason in the module doc. The Pages Function
/// behind this path forwards verbatim to GA4's mp/collect, so the query-string contract
/// (measurement_id, api_secret) is unchanged. Overridable at compile time for local
/// testing; release builds never set it and always get the production URL.
fn collect_url() -> &'static str {
    option_env!("MODREX_ANALYTICS_ENDPOINT")
        .filter(|s| !s.is_empty())
        .unwrap_or("https://modrex.net/api/collect")
}

/// One session id per app launch. GA4 needs session_id and engagement_time_msec on
/// events, or its session and realtime reports stay empty.
fn session_id() -> &'static str {
    static SID: OnceLock<String> = OnceLock::new();
    SID.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string())
    })
}

/// Fire-and-forget an event. Safe to call from synchronous code. The network send
/// happens on the async runtime and any error is logged, never propagated.
pub(crate) fn track(app: &AppHandle, name: &str, params: Value) {
    let app = app.clone();
    let name = name.to_string();
    tauri::async_runtime::spawn(async move {
        send_event(&app, &name, params).await;
    });
}

async fn send_event(app: &AppHandle, name: &str, mut params: Value) {
    // Consent gate, the single choke point. No opt-in, nothing leaves the device.
    if !settings::read_settings(app).analytics_enabled {
        return;
    }
    let (Some(measurement_id), Some(api_secret)) = (measurement_id(), api_secret()) else {
        return;
    };

    inject_defaults(app, &mut params);

    let body = json!({
        "client_id": settings::ensure_analytics_id(app),
        "events": [{ "name": name, "params": params }],
    });

    let url = format!(
        "{}?measurement_id={measurement_id}&api_secret={api_secret}",
        collect_url()
    );
    let res = http_client()
        .post(&url)
        .header("User-Agent", user_agent(app))
        .timeout(std::time::Duration::from_secs(10))
        .json(&body)
        .send()
        .await;
    if let Err(e) = res {
        log::warn!("analytics send failed: {e}");
    }
}

pub(crate) fn track_mod_installed(app: &AppHandle, game_id: &str, mod_id: i64, format: &str) {
    track(
        app,
        "mod_installed",
        json!({ "game": game_id, "mod_id": mod_id, "format": format }),
    );
}

/// Adds the properties every event carries. Callers can override any of them by
/// supplying the key themselves, since or_insert only fills what is missing.
fn inject_defaults(app: &AppHandle, params: &mut Value) {
    if !params.is_object() {
        *params = json!({});
    }
    let obj = params.as_object_mut().expect("params is an object");
    obj.entry("app_version")
        .or_insert_with(|| json!(app.package_info().version.to_string()));
    obj.entry("os")
        .or_insert_with(|| json!(std::env::consts::OS));
    obj.entry("arch")
        .or_insert_with(|| json!(std::env::consts::ARCH));
    obj.entry("session_id")
        .or_insert_with(|| json!(session_id()));
    obj.entry("engagement_time_msec")
        .or_insert_with(|| json!(100));
}

/// What the renderer is allowed to report, and the properties each event may carry.
/// TypeScript types are not a boundary: a compromised renderer can invoke the command with
/// anything, so an event name or property key that is not listed here is dropped rather
/// than forwarded. Without this the command is an arbitrary outbound channel, and one that
/// bypasses the page's own connect-src because the request is made from Rust.
const RENDERER_EVENTS: &[(&str, &[&str])] = &[
    (
        "search_performed",
        &["game", "query_length", "result_count"],
    ),
    ("feature_used", &["game", "feature"]),
    (
        "mod_identification",
        &["game", "total", "identified", "unidentified"],
    ),
];

/// Long enough for every identifier the catalog actually sends, short enough that no
/// meaningful secret or path fits.
const MAX_VALUE_LEN: usize = 64;

/// Rejects anything that looks like a path, a URL, or a credential rather than the short
/// identifiers these events are made of.
fn value_is_reportable(value: &Value) -> bool {
    match value {
        Value::Bool(_) => true,
        Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
        Value::String(s) => {
            s.len() <= MAX_VALUE_LEN
                && !s.contains(['/', '\\', ':'])
                && !s.chars().any(char::is_control)
        }
        // Nested shapes carry unbounded content and GA4 has no use for them.
        Value::Null | Value::Array(_) | Value::Object(_) => false,
    }
}

/// Checks one renderer event against the catalog, returning the params to send.
fn vet_renderer_event(name: &str, params: Value) -> Result<Value, &'static str> {
    let allowed = RENDERER_EVENTS
        .iter()
        .find(|(event, _)| *event == name)
        .map(|(_, keys)| *keys)
        .ok_or("unknown event")?;
    let Value::Object(map) = params else {
        return Err("params must be an object");
    };
    if map.len() > allowed.len() {
        return Err("too many properties");
    }
    for (key, value) in &map {
        if !allowed.contains(&key.as_str()) {
            return Err("unknown property");
        }
        if !value_is_reportable(value) {
            return Err("property value is not reportable");
        }
    }
    Ok(Value::Object(map))
}

/// Renderer-origin events route through here. Rust-native events call track
/// directly. Both share the consent gate in send_event.
#[tauri::command]
#[specta::specta]
pub fn track_event(app: AppHandle, name: String, params: Option<crate::commands::api::Json>) {
    let params = params.map(|p| p.0).unwrap_or_else(|| json!({}));
    match vet_renderer_event(&name, params) {
        // The reason is logged, never the payload that failed it.
        Err(reason) => log::warn!("analytics: dropped renderer event '{name}': {reason}"),
        Ok(params) => track(&app, &name, params),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vet(name: &str, params: Value) -> Result<Value, &'static str> {
        vet_renderer_event(name, params)
    }

    #[test]
    fn the_catalogs_own_events_are_accepted() {
        assert!(vet(
            "search_performed",
            json!({ "game": "pd3", "query_length": 4, "result_count": 12 })
        )
        .is_ok());
        assert!(vet(
            "feature_used",
            json!({ "game": "cb", "feature": "docs_opened" })
        )
        .is_ok());
        assert!(vet(
            "mod_identification",
            json!({ "game": "pd2", "total": 9, "identified": 7, "unidentified": 2 })
        )
        .is_ok());
        assert!(vet("feature_used", json!({})).is_ok(), "no params is fine");
    }

    #[test]
    fn an_unlisted_event_name_is_rejected() {
        for name in ["", "exfiltrate", "mod_installed", "SEARCH_PERFORMED"] {
            assert_eq!(vet(name, json!({})), Err("unknown event"), "{name}");
        }
    }

    #[test]
    fn an_unlisted_property_is_rejected() {
        assert_eq!(
            vet("feature_used", json!({ "game": "pd3", "secret": "x" })),
            Err("unknown property")
        );
        // A listed key belonging to a different event does not carry over.
        assert_eq!(
            vet("feature_used", json!({ "query_length": 3 })),
            Err("unknown property")
        );
    }

    /// The values these events carry are short identifiers, so anything shaped like a path,
    /// a URL, or a token cannot be smuggled through a legitimate key.
    #[test]
    fn path_url_and_token_shaped_values_are_rejected() {
        for value in [
            "C:/Users/someone/secret.txt",
            "https://attacker.example/x",
            "nexus_access_token:abcdef",
            "a\nb",
        ] {
            assert_eq!(
                vet("feature_used", json!({ "feature": value })),
                Err("property value is not reportable"),
                "{value}"
            );
        }
        let long = "x".repeat(MAX_VALUE_LEN + 1);
        assert_eq!(
            vet("feature_used", json!({ "feature": long })),
            Err("property value is not reportable")
        );
    }

    #[test]
    fn nested_and_non_object_payloads_are_rejected() {
        assert_eq!(
            vet("feature_used", json!({ "feature": { "nested": 1 } })),
            Err("property value is not reportable")
        );
        assert_eq!(
            vet("feature_used", json!({ "feature": ["a", "b"] })),
            Err("property value is not reportable")
        );
        assert_eq!(
            vet("feature_used", json!({ "feature": null })),
            Err("property value is not reportable")
        );
        assert_eq!(
            vet("feature_used", json!("hi")),
            Err("params must be an object")
        );
    }

    #[test]
    fn a_payload_with_more_properties_than_the_event_allows_is_rejected() {
        assert_eq!(
            vet(
                "feature_used",
                json!({ "game": "pd3", "feature": "a", "extra": "b" })
            ),
            Err("too many properties")
        );
    }
}
