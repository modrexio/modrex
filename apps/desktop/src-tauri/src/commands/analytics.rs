//! Anonymous, opt-in usage analytics via the GA4 Measurement Protocol.
//!
//! Events are sent from Rust rather than the webview, which keeps the consent gate
//! in one place, attaches reliable environment data (OS, arch, version), and cannot
//! be stripped by in-page ad blockers. Every send is fire-and-forget and failures
//! are logged without interrupting the app.
//!
//! Requests go to https://modrex.net/api/collect, not Google directly. Sending from
//! Rust defeats only in-page blocking, whereas DNS-level and hosts-file blocklists
//! (Pi-hole, AdGuard Home, NextDNS, debloat-Windows scripts) and outbound firewalls
//! block google-analytics.com for every process on the machine, Rust included, and
//! this audience runs that tooling heavily. A Cloudflare Pages Function at
//! apps/site/functions/api/collect.ts forwards each request verbatim to GA4.
//!
//! Nothing is transmitted unless analytics_enabled is true in settings and the build
//! carries the measurement id below. The GA4 API secret lives only on the proxy. This
//! module is the only place that knows the backend is GA4, so swapping sinks is a
//! change to send_event alone.

use crate::commands::api::{http_client, user_agent};
use crate::commands::settings;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

/// GA4 measurement id, embedded at compile time. Absent in local and dev builds (and any
/// build without the CI secret), which makes every send a no-op, so development never
/// pollutes production data.
fn measurement_id() -> Option<&'static str> {
    option_env!("MODREX_GA_MEASUREMENT_ID").filter(|s| !s.is_empty())
}

/// Our own domain, not Google's, for the reason in the module doc. The Pages Function
/// behind this path adds the API secret and forwards to GA4's mp/collect. Overridable
/// at compile time for local testing; release builds never set it and always get the
/// production URL.
fn collect_url() -> &'static str {
    option_env!("MODREX_ANALYTICS_ENDPOINT")
        .filter(|s| !s.is_empty())
        .unwrap_or("https://modrex.net/api/collect")
}

const ACTIVITY_INTERVAL: Duration = Duration::from_secs(60);
const SESSION_TIMEOUT: Duration = Duration::from_secs(30 * 60);

struct Activity {
    focused: bool,
    updated_at: Instant,
    engagement: Duration,
    last_event: Option<Instant>,
    session_id: u64,
}

impl Activity {
    fn new(now: Instant, focused: bool) -> Self {
        Self {
            focused,
            updated_at: now,
            engagement: Duration::ZERO,
            last_event: None,
            session_id: 0,
        }
    }

    fn advance(&mut self, now: Instant) {
        let elapsed = now.duration_since(self.updated_at);
        // A delayed heartbeat after system sleep must not count the suspended hours.
        if self.focused && elapsed <= ACTIVITY_INTERVAL * 2 {
            self.engagement += elapsed;
        }
        self.updated_at = now;
    }

    fn take_event(&mut self, now: Instant, unix_seconds: u64) -> (u64, u64) {
        self.advance(now);
        if self
            .last_event
            .is_none_or(|last| now.duration_since(last) >= SESSION_TIMEOUT)
        {
            self.session_id = unix_seconds;
        }
        self.last_event = Some(now);
        let engagement = std::mem::take(&mut self.engagement).as_millis() as u64;
        (self.session_id, engagement)
    }
}

fn activity() -> &'static Mutex<Activity> {
    static ACTIVITY: OnceLock<Mutex<Activity>> = OnceLock::new();
    ACTIVITY.get_or_init(|| Mutex::new(Activity::new(Instant::now(), false)))
}

pub(crate) fn reset_activity() {
    let mut state = activity().lock().unwrap_or_else(|e| e.into_inner());
    *state = Activity::new(Instant::now(), state.focused);
}

/// Takes a focus change on the app window as the start or end of foreground time.
///
/// Reached from the builder's window-event hook rather than from a handle to the window,
/// because there is no window to take a handle to when analytics starts: both are declared
/// hidden and are created and shown as their pages load. The splash is filtered out here, so
/// the seconds it is up are not counted as the user using the app.
pub(crate) fn window_focus_changed(app: &AppHandle, label: &str, focused: bool) {
    if label != "main" {
        return;
    }
    {
        let mut state = activity().lock().unwrap_or_else(|e| e.into_inner());
        state.advance(Instant::now());
        state.focused = focused;
    }
    if !focused {
        track(app, "app_activity", json!({}));
    }
}

/// Records foreground time even when the user is only reading or browsing cached data.
pub(crate) fn start(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(ACTIVITY_INTERVAL).await;
            let focused = activity().lock().unwrap_or_else(|e| e.into_inner()).focused;
            if focused {
                track(&handle, "app_activity", json!({}));
            }
        }
    });
}

/// Fire-and-forget an event. Safe to call from synchronous code. The network send
/// happens on the async runtime and any error is logged, never propagated.
pub(crate) fn track(app: &AppHandle, name: &str, mut params: Value) {
    if measurement_id().is_none() {
        return;
    }
    if !settings::read_settings(app).analytics_enabled {
        reset_activity();
        return;
    }
    let timestamp = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(timestamp) if timestamp.as_secs() > 0 => timestamp,
        _ => {
            log::warn!("analytics: cannot timestamp event with invalid system clock");
            return;
        }
    };
    let (session_id, engagement) = activity()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take_event(Instant::now(), timestamp.as_secs());
    if name == "app_activity" && engagement == 0 {
        return;
    }
    inject_defaults(&app.package_info().version.to_string(), &mut params);
    params["session_id"] = json!(session_id);
    if engagement > 0 {
        params["engagement_time_msec"] = json!(engagement);
    }
    let app = app.clone();
    let name = name.to_string();
    tauri::async_runtime::spawn(async move {
        send_event(&app, &name, params, timestamp.as_micros() as u64).await;
    });
}

async fn send_event(app: &AppHandle, name: &str, params: Value, timestamp_micros: u64) {
    // Recheck consent because it may have changed while this task was queued.
    if !settings::read_settings(app).analytics_enabled {
        return;
    }
    let Some(measurement_id) = measurement_id() else {
        return;
    };

    let body = json!({
        "client_id": settings::ensure_analytics_id(app),
        "timestamp_micros": timestamp_micros,
        "device": { "category": "desktop", "operating_system": operating_system(std::env::consts::OS) },
        "events": [{ "name": name, "params": params }],
    });

    let url = format!("{}?measurement_id={measurement_id}", collect_url());
    let res = http_client()
        .post(&url)
        .header("User-Agent", user_agent(app))
        .timeout(std::time::Duration::from_secs(10))
        .json(&body)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status);
    if let Err(e) = res {
        log::warn!("analytics send failed: {}", e.without_url());
    }
}

pub(crate) fn track_mod_installed(app: &AppHandle, game_id: &str, mod_id: i64, format: &str) {
    track(
        app,
        "mod_installed",
        json!({ "game": game_id, "mod_id": mod_id, "format": format }),
    );
}

fn operating_system(os: &str) -> &str {
    match os {
        "windows" => "Windows",
        "linux" => "Linux",
        "macos" => "MacOS",
        other => other,
    }
}

fn inject_defaults(version: &str, params: &mut Value) {
    let obj = params
        .as_object_mut()
        .expect("analytics params must be an object");
    obj.insert("app_version".into(), json!(version));
    obj.insert("os".into(), json!(std::env::consts::OS));
    obj.insert("arch".into(), json!(std::env::consts::ARCH));
    obj.remove("engagement_time_msec");
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

    #[test]
    fn engagement_counts_foreground_time_once_and_excludes_background_time() {
        let now = Instant::now();
        let mut state = Activity::new(now, true);
        assert_eq!(
            state.take_event(now + Duration::from_secs(10), 100),
            (100, 10_000)
        );
        state.advance(now + Duration::from_secs(15));
        state.focused = false;
        assert_eq!(
            state.take_event(now + Duration::from_secs(30), 120),
            (100, 5_000)
        );
        assert_eq!(
            state.take_event(now + Duration::from_secs(40), 130),
            (100, 0)
        );
    }

    #[test]
    fn sessions_expire_after_thirty_minutes_and_sleep_is_not_engagement() {
        let now = Instant::now();
        let mut state = Activity::new(now, true);
        assert_eq!(state.take_event(now, 100), (100, 0));
        assert_eq!(state.take_event(now + SESSION_TIMEOUT, 1900), (1900, 0));
        assert_eq!(
            state.take_event(now + SESSION_TIMEOUT + ACTIVITY_INTERVAL, 1960),
            (1900, 60_000)
        );
    }

    #[test]
    fn consent_reset_discards_pre_consent_engagement_and_session() {
        let now = Instant::now();
        let mut state = Activity::new(now, true);
        state.take_event(now + Duration::from_secs(10), 100);
        state = Activity::new(now + Duration::from_secs(30), state.focused);
        assert_eq!(
            state.take_event(now + Duration::from_secs(35), 125),
            (125, 5_000)
        );
    }

    #[test]
    fn environment_fields_cannot_be_overridden_by_callers() {
        let mut params = json!({ "app_version": "wrong", "os": "wrong", "arch": "wrong", "engagement_time_msec": 100, "game": "pd3" });
        inject_defaults("0.14.0", &mut params);
        assert_eq!(params["app_version"], "0.14.0");
        assert_eq!(params["os"], std::env::consts::OS);
        assert_eq!(params["arch"], std::env::consts::ARCH);
        assert_eq!(params["game"], "pd3");
        assert!(params.get("engagement_time_msec").is_none());
        assert_eq!(operating_system("windows"), "Windows");
        assert_eq!(operating_system("linux"), "Linux");
        assert_eq!(operating_system("macos"), "MacOS");
    }

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
