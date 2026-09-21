# Rust backend

Paths are relative to `apps/desktop`.

**App startup sequence** (`src-tauri/src/lib.rs` setup hook, fires before the window shows): `migrate_from_old_identifier` runs synchronously first, then fire-and-forget: `cleanup_thumbnail_cache` and the `mod_index` snapshot refresh (`ensure_index`).

**Logging**: `tauri_plugin_log` writes to `Modrex.log` in the app's log dir (`%LOCALAPPDATA%\Modrex\logs\` on Windows — note this differs from `app_data_dir()`'s `%APPDATA%\Modrex\` used for `settings.json`/`mod-index.db`), level `Warn` globally and `Info` for the `modrex_lib` crate, 5 MB with one rotated backup kept. Reachable in-app via Settings > Logs ("Open log file", which copies it to `%TEMP%\modrex_log.txt` first). `install_mod`/`install_file` log every error path via `log::warn!` (not just the final install/state-write phase) so a failed install/update is always diagnosable from the log — when adding a new `?`-early-return inside either function, route it through the same log-then-return pattern rather than a bare `?`.

- **Error handling style**: prefer `.expect("reason")` over `.unwrap()` for paths that are infallible in practice (OnceLock init, app path resolution). Prefer `.unwrap_or_else(|e| e.into_inner())` for Mutex guards so a poisoned lock recovers rather than re-panicking. Reserve plain `.unwrap()` for tests only.

- **`windows_fullscreen.rs`** (Windows-only, installed on the main window in `lib.rs` setup): a comctl32 window subclass that consumes `WM_NCCALCSIZE` only while the window is borderless-fullscreen-with-`WS_MAXIMIZE`, because Tao 0.35 otherwise clamps a fullscreen window entered from the maximized state to the taskbar work area.

- Tauri `identifier` is `modrex` (changed from `io.github.shulhaoleh.pd3modmanager` in v0.10.0). `productName` is `Modrex` — Tauri uses this for `userData` path on Windows. The upgrade from the old Tauri identifier is handled by `nsis/installer-hooks.nsi` (removes the old install via its registry uninstall key) and `migrate_from_old_identifier()` in `settings.rs` (migrates app data on first launch). Electron-era compatibility is gone: the release workflow no longer publishes the `latest.yml`/`latest-linux.yml` manifests or the `pd3-mod-manager` package copies, and no app-data migration from `PD3 Mod Manager` runs.

**Tests**: Rust unit tests live in separate test files referenced from the module via `#[cfg(test)] mod tests;`, or inline in the module file itself; run with `cargo test` inside `src-tauri/`. `tempfile` and `filetime` crates are in `[dev-dependencies]` for filesystem tests; `tokio = { version = "1", features = ["rt", "macros"] }` is in `[dev-dependencies]` (in addition to the production dep) to enable `#[tokio::test]` for async filesystem tests.
