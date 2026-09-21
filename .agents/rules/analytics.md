## Usage analytics (opt-in telemetry)

The desktop sends GA4 Measurement Protocol events from Rust through
`apps/site/functions/api/collect.ts`. `commands/analytics.rs` owns payload construction,
environment fields, foreground engagement, sessions and delivery. The proxy supplies
the visitor IP for country attribution and logs upstream failures without credentials.

- Rust call sites use `analytics::track`; renderer call sites use the typed catalog in
  `src/renderer/src/lib/analytics/events.ts`, through the allowlisted `track_event` command.
- `lib.rs` starts the tracker before the main window is shown. Activity is reported every
  minute while focused and on focus loss, including when browsing cached content.
  `Activity` measures elapsed foreground time once per event and excludes long heartbeat
  gaps. This measures foreground presence, not keyboard/mouse activity.
- Session IDs renew after 30 minutes without an event. Events retain their creation
  timestamp when queued. Delivery is best effort: no retry queue and no guaranteed final
  flush on process exit.
- Consent remains opt-in. `track` checks before building an event; `send_event` checks
  again before sending. `set_analytics_consent` resets accumulated activity when consent
  changes and emits `consent_granted` on opt-in. Pre-consent time is discarded. The existing
  random per-install `analyticsId` remains the client ID.
- Release credentials come from `MODREX_GA_MEASUREMENT_ID` and `MODREX_GA_API_SECRET`.
  Builds without them send nothing. `MODREX_ANALYTICS_ENDPOINT` overrides the proxy URL
  for local testing. Never print request URLs with API secrets.

## GA4 reports

Use **Active users** with **Last 7 days** for weekly usage. Users are anonymous opted-in
installations, not a count of downloads or all installations. GA4's date picker allows
longer comparisons. The report date selection is separate from its saved card layout.

Event-scoped custom definitions must match these parameters:

| Report dimension        | Event parameter |
| ----------------------- | --------------- |
| App version             | `app_version`   |
| Modrex operating system | `os`            |
| CPU architecture        | `arch`          |
| Game                    | `game`          |
| Game launcher           | `launcher`      |
| Mod format              | `format`        |

Version, OS and architecture accompany every event. Game, launcher and format only apply
to events supplying them. The desktop also sends GA4's standard `device.category` and
`device.operating_system`, enabling the built-in OS dimension in releases with this
implementation. Keep the custom `os` dimension for older releases.

New custom definitions need processing time (typically 24-48 hours) and do not backfill
older dates. Version means the version used during the selected period: an installation
that upgrades can appear in two rows. Neither event nor user-scoped dimensions provide
a retrospective, exact inventory of everyone's currently installed version.

## Verification

- `cargo test commands::analytics::tests --lib` in `apps/desktop/src-tauri` covers timing,
  session expiry, consent reset, environment fields and the renderer allowlist.
- `pnpm exec vitest run functions/api/collect.test.ts` in `apps/site` covers forwarding,
  country attribution and failures. `pnpm typecheck:functions` checks the proxy types.
- Point `MODREX_ANALYTICS_ENDPOINT` at a local receiver with dummy credentials to inspect
  requests without sending production events.
- GA4's `/debug/mp/collect` validates payloads without collecting them. Production
  `/mp/collect` returning 2xx only proves receipt, not successful processing. Setting
  `debug_mode` alone does not guarantee exclusion from production reports.

Protocol reference: <https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference>.
