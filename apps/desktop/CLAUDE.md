# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start Tauri app (launches Vite dev server then Tauri)
pnpm build        # Local production build, unsigned (tauri.local.conf.json disables updater artifacts) — exits 0, installer in src-tauri/target/release/bundle/nsis/
pnpm build:signed # CI production build with updater artifacts — requires TAURI_SIGNING_PRIVATE_KEY (release.yml only; exits 1 without the key)
pnpm dist:win     # Same as build but with explicit --target x86_64-pc-windows-msvc
pnpm dist:linux   # Package Linux AppImage + .deb (unsigned, like build)
pnpm typecheck    # Type-check renderer without emitting (same as: pnpm tsc --noEmit)
pnpm check-version # Verify package, Tauri, Cargo, and lockfile versions agree
pnpm check-commands # Verify api.ts uses every command registered in collect_commands! in lib.rs, that the generated bindings are not stale, and that the invoke API stays api.ts-only (also runs in pre-commit and CI)
pnpm check-csp    # Verify csp and devCsp in tauri.conf.json agree on all external origins (also runs in pre-commit and CI)
pnpm check-games  # Verify the Rust GAME_REGISTRY and the TypeScript GAMES record list the same game ids (CI)
pnpm check-sources # Verify the Rust SOURCE_REGISTRY and @modrex/games agree on each game's modworkshop id (CI)
pnpm check-updater # Verify release.yml's latest.json generation matches the updater config in tauri.conf.json (CI only)
pnpm check-i18n   # Validate each locale's translated subset and {var} interpolation against en.json, and report coverage (pre-commit + CI)
pnpm i18n:help    # List translator-facing commands
pnpm i18n:status  # List available languages and key coverage
pnpm i18n:missing de # List German's missing keys and their English source text
pnpm i18n:check   # Validate every locale
pnpm i18n:check de # Validate one locale with actionable translator-facing errors
pnpm i18n:fill de # Fill missing keys with marked English fallbacks for IDE editing
pnpm i18n:translate de # Interactively continue an existing locale
pnpm i18n:create uk # Create an IDE-ready locale with marked English text
pnpm checks       # Run the full CI gate locally: all check-* scripts, format:check, lint, typecheck, tests
pnpm format       # Format all files with prettier
pnpm format:check # Check formatting without writing
pnpm lint         # ESLint on renderer source (src/renderer/src/)
pnpm lint:fix     # ESLint with auto-fix
pnpm test         # Run all tests: Rust (cargo test) then renderer (vitest)
pnpm test:renderer # Run only renderer TypeScript tests (vitest)
pnpm generate-licenses # Regenerate THIRD_PARTY_LICENSES.md (run after adding/updating deps)
cargo clippy      # Rust lints (run from src-tauri/); the tree is clippy-clean and CI enforces it with -D warnings — any warning is signal. Deliberate exceptions carry #[allow] at the site (too_many_arguments on the four archive-install commands, dead_code on the unwired ue4ss_modstxt read helpers)
cargo fmt         # Format Rust code (run from src-tauri/)
```

Run a single Rust test by name filter:

```bash
cd src-tauri && cargo test strip_priority
```

Run a single renderer test file or filter by name:

```bash
pnpm test:renderer -- src/renderer/src/browseCache.test.ts
pnpm test:renderer -- -t "returns stale"
```

Optional dev tooling (machine setup, not required by any script or CI): `cargo nextest run` (inside `src-tauri/`) is a faster drop-in test runner with the same name-filter syntax (`cargo nextest run strip_priority`); CI stays on `cargo test`. `sccache` is configured machine-wide as the rustc wrapper (`~/.cargo/config.toml`: `[build] rustc-wrapper = "sccache"`) so dependency compiles are cached across clones (`modrex-main`, `modrex-main-nexus`); delete that line to disable it if a toolchain issue is ever suspected.

In `pnpm dev`, renderer changes (`src/renderer/`) apply instantly via Vite HMR — no restart needed. Rust changes (`src-tauri/`) trigger an automatic `cargo` recompile via Tauri's file watcher; the window reloads when done.

**Pre-commit hooks** (`.husky/pre-commit`): runs the root format and lint gates (desktop plus site), then desktop command and CSP checks. Run `pnpm format` and `pnpm lint:fix` from the repository root to fix the first two. When dep files (`Cargo.toml`/`Cargo.lock`/`package.json`/`pnpm-lock.yaml`) are staged it also regenerates `THIRD_PARTY_LICENSES.md` (~15 s) and stages it. `commit-msg` runs `commitlint` to enforce the conventional commit format.

## Architecture

Tauri v2 app: **Rust backend** + **React renderer**, communicating via Tauri's `invoke` / `emit`.

```
src-tauri/src/commands/   ← all backend logic (Rust)
src/renderer/src/         ← React UI
src/renderer/src/api.ts   ← renderer-side IPC surface
src/shared/types.ts       ← TypeScript types shared by renderer and api.ts
```

### Adding a new command

1. Implement `#[tauri::command] #[specta::specta] pub fn my_cmd(...)` in the appropriate `src-tauri/src/commands/*.rs` file (both attributes, in that order)
2. Register it in `src-tauri/src/lib.rs` inside `ipc_builder()`'s `tauri_specta::collect_commands![...]`
3. Regenerate `src/shared/bindings.ts`: `cd src-tauri && cargo test --test export_bindings` (any `cargo test` run does it too)
4. Add a wrapper in `src/renderer/src/api.ts` calling the generated `commands.myCmd(...)` from the bindings

Mod data from an external site does NOT cross IPC as raw JSON any more. `commands/domain.rs`
owns the neutral shapes (`ModSummary`, `ModDetail`, `ModFile`, `ModLink`, `ModPage`) and both
ModWorkshop and Nexus translate into them there; see the backend rules for why it is two
structs per shape. `api::Json` remains only for the handful of passthroughs that are still
untyped.

The payload shapes are typed end to end by tauri-specta: renaming or retyping a field on the Rust side changes the generated bindings and becomes a renderer compile error instead of a silent runtime break. Optional Rust params export as `T | null` (pass `x ?? null` in wrappers). Types crossing IPC derive `specta::Type`; `serde_json::Value` passthroughs use `api::Json` (specta's own Value impl recurses infinitely at export). `pnpm check-commands` (pre-commit + CI) still enforces usage in both directions (a command called in api.ts but unregistered, or registered but never called, both fail) plus bindings freshness by name; CI's bindings-diff check catches shape-only drift.

### Startup: two hidden windows, phased splash

`tauri.conf.json` defines two windows, both starting hidden: `main` (the app) and `splash` (`splash.html`, its own non-React entry `src/renderer/src/splash.ts`). `lib.rs`'s `on_page_load` hook shows the splash when its page finishes loading (skipped if startup already completed). The main renderer reports progress through `report_startup_phase` (`prepare → interface → game → mods → ready`, plus `error`; tracked in `commands/startup.rs` and re-emitted to the splash as `startup:progress`). On `ready` the splash calls `finish_startup`, which shows + focuses `main` and closes the splash; the splash's recovery button (surfaced on the `error` state) invokes the same command, so a failed startup still lets the user into the app.

### Per-module details (load on demand)

Deep per-file architecture and invariants live in path-scoped rule files under
`.claude/rules/` that load automatically when Claude opens the matching code:

- **`.claude/rules/backend.md`** (`src-tauri/**`) — Rust backend modules: the `mods/` engine, launchers, loaders (SuperBLT/DAHM/PDTHModOverrides/UE4SS), `settings`, `api`, `mod_index`, `thumbnails`, `news`.
- **`.claude/rules/renderer.md`** (`src/renderer/**`) — React renderer: `api.ts`, the `App.tsx` state model, the caches, `BrowsePage`/`ModDetailPage`/`InstalledPage` families, styling, i18n, and the archive-install flow.
- **`.claude/rules/analytics.md`** (`analytics.rs`, `src/renderer/src/lib/analytics/**`, TelemetryConsent components) — GA4 telemetry design and local proxy-testing steps.
- **`.claude/rules/code-style.md`** (no path filter — applies to every code edit) — the five blocker-level AI patterns and the final-pass audit checklist; the detailed pattern catalog lives in `AI_DANGER_PATTERNS.md`.

## Key domain facts

- **modworkshop game IDs**: PD3 = `853`, PD2 = `1`, PDTH = `2`, Crime Boss: Rockay City = `857`, RAID: World War II = `543` — stored in `packages/games` and used by `BrowsePage` via `GAMES[activeGame].workshopId`. The Rust `api.rs` no longer hardcodes a game ID for list calls; it receives the ID as a parameter.
- **Crime Boss: Rockay City** (`game_id: "cb"`) is UE4. Steam app id `2933080`, install folder `CrimeBossRockayCity`, launcher exe `CrimeBoss.exe`, running process `CrimeBoss-Win64-Shipping`. Available on Steam and Epic Games Store on PC (also on PS5/Xbox Series X|S, but those are console releases — out of scope for a desktop app). Mods install into `{gamePath}/CrimeBoss/Mods/<name>/Content/Paks/WindowsNoEditor/<name>-WindowsNoEditor.{pak,ucas,utoc}` (the official ModKit's "Package Mod" output location) — **not** the legacy `~mods` File-unit convention PD3 uses, even though both games are UE pak-based. Reason: the official UGC mod-loader, which enumerates `Mods/<name>/` folders, additively merges multiple mods' Data Table Extensions (e.g. several mods each adding rows to the jobs/weapons tables); plain `~mods` is generic Unreal pak-mounting with no merge semantics, so two mods that both extend the same table silently conflict there (last-loaded wins) — confirmed by user reports, not just isolated single-mod testing. `zip.rs::resolve_crimeboss_archive` (gated by `cfg.game_id == "cb"`) always synthesizes the `Content/Paks/WindowsNoEditor/` skeleton itself around the found `.pak` + `.ucas`/`.utoc` siblings, regardless of whether the source archive shipped a loose triplet or the ModKit's already-wrapped folder — Modrex never copies an archive's wrapper folder as-is for this game. This applies identically to the multi-pak path: `install_from_zip_entry` calls the same `extract_entry_into_crimeboss_skeleton` for every CB pak entry, which is why `ZipPickerModal` must never recreate a CB pak archive's internal wrapper directory as real app folders — see `isCrimeBossPakArchive` in the Archive install flow section above. A zip whose multiple pak entries all sit inside one ModKit-wrapped directory (e.g. several variants packaged together) is a real, observed shape, not a hypothetical. `naming.rs::mod_folder_name` derives the `Mods/<name>/` folder name from the mod's display name. UE IoStore's `.ucas`/`.utoc` sidecars (present for nearly every real Crime Boss mod, unlike PD3 where most mods ship a bare `.pak`) are carried alongside the `.pak` through every File-unit op via `naming.rs::sidecar_path`/`zip.rs::extract_entry_with_sidecars` — `Path::with_extension` is unsafe for this since a disabled mod's filename is `Foo.pak.disabled`. **Safety invariant**: the Directory-unit temp-cleanup path in `install_mod`/`install_file` assumes PD2/PDTH's two-level temp scheme (`{uuid_dir}/{dir_name}`, where `tmp.parent()` is safe to `remove_dir_all`) — Crime Boss's synthesized skeleton root _is_ `tmp` itself, one level under the OS temp dir, so both functions have an explicit `cfg.game_id == "cb"` branch that removes `tmp` directly instead of `tmp.parent()`.

**Manual target override** (`install.rs::move_crimeboss_mod_target_op`, command `move_crimeboss_mod_target`): there's no file-content signal that tells Modrex whether a `.pak` was built by the official ModKit (belongs in `Mods/`, gets the Data Table merge above) or is a pre-ModKit-era loose pak (belongs in `~mods`, no merge) — `resolve_crimeboss_archive` always assumes the former for new installs. This op is the user-initiated escape hatch: it toggles a tracked mod between the two targets by unwrapping the skeleton into a flat prefixed pak (`Mods/` → `~mods`) or wrapping a flat pak into a fresh skeleton (`~mods` → `Mods/`), reusing `install_mod_from_path` for the actual write/state update — but that function's own stale-entry cleanup computes the old path inside the _new_ target's directory, which never matches on a cross-target move, so the op removes the real old location itself afterward. Since `install_mod_from_path` always installs as enabled, the op re-runs `disable_mod_op` afterward if the mod was disabled before the move, to restore that state (and resync `crimeboss_settings`). Renderer: `InstalledModItem` shows a persistent "ModKit"/"Legacy" badge plus a `FolderSymlink` icon button (gated on `activeGame === 'cb'` and `location` being `undefined`/`"paks"` — never shown for `ue4ss_mods`/host packs) — the move is otherwise silent, so the badge is what tells the user which target a mod is currently in. Either direction confirms first via `MoveCrimeBossTargetModal`'s `toLegacy` prop, which only changes the wording (the merge-tradeoff explanation for `Mods/` → `~mods`, a plain confirmation for the reverse) — both directions need a confirm step since neither has any other feedback.

**Per-install target choice** (`GameSettings.crimeboss_install_mode`, `"auto"` default or `"ask"`, set via `set_crimeboss_install_mode` — always writes to the `"cb"` game entry regardless of `activeGame`, since the setting is meaningless elsewhere): lets the user decide the destination up front instead of relying on the move op after the fact. `src/renderer/src/hooks/useCrimeBossInstallTarget.ts` is the single place this is implemented — `runInstall(modId, modName, install)` checks `getSettingsCache('cb')?.settings.crimebossInstallMode` and, when `"ask"`, defers `install` until the user picks in `CrimeBossInstallTargetModal` instead of calling it immediately. There is still no install path that writes directly into `~mods` — choosing "legacy" runs the normal install (always `Mods/`) via `confirmChoice`, then fetches a fresh `get_installed` (not the caller's possibly-stale `installed` prop) to find the entries whose `id` matches and whose `location` is still unset, and relocates each via `moveCrimeBossModTarget`. Wired into all three install entry points that can trigger a _new_ Crime Boss install — `BrowsePage`, `ModDetailPage`'s header, and `DownloadsTab` — but deliberately not reinstall/update, which keep installing wherever the existing tracked entry already lives.

**Enable/disable does not work by moving files** — `commands/mods/crimeboss_settings.rs`. Reverse-engineered against real installs: the game's UGC mod-loader tracks each mod's active state in its own JSON file at `%USERPROFILE%\Saved Games\CrimeBoss\<platform>\Saved\ModSettings\<id>.json` (outside the game install dir entirely — the game redirects its UE `Saved/` folder there), read/written directly by the in-game Options > Mods screen. Moving a mod's files (to a `disabled` subfolder, or anywhere else) has zero effect on this — confirmed live: a mod Modrex moved to `Mods/disabled/<name>/` kept reading `"enabled": "true"` in its settings file indefinitely. The file's `<id>` is **not** derivable from the mod's display name — it's `lowercase(pak_filename without the "CrimeBoss-WindowsNoEditor" suffix)`, e.g. `DallasPDCrimeBoss-WindowsNoEditor.pak` maps to `dallaspd.json` (verified against 10+ real installed mods). Schema: a JSON array of `{"name": ..., "value": ...}` objects (values are strings, even for booleans — `"value": "true"`, not `true`); mods with author-defined custom settings have more entries in the same array that must survive untouched. `crimeboss_settings::sync_enabled` (called from `install.rs`'s `enable_mod_op`/`disable_mod_op`, gated by `cfg.game_id == "cb"`) finds the `enabled` entry and flips its value, leaving everything else alone. Two things this can't do anything about: (1) **the settings file doesn't exist until the game has launched with the mod present at least once** (created lazily, not at install time) — `sync_enabled` no-ops rather than synthesize a guessed schema for a fresh mod; (2) **the platform subfolder name is only verified for Steam** (`"steam"` maps to `"Steam"`) — anything else no-ops rather than guess at an unverified path. Mods built outside the ModKit's standard pipeline (pak doesn't end in `CrimeBoss-WindowsNoEditor`, e.g. older loose `~mods`-only mods like "Total Mission Value") have no UGC object and thus no settings file to sync at all — this is expected, not a bug. Resolved via the `USERPROFILE` env var, matching this codebase's existing pattern for OS-specific paths elsewhere (`epic.rs`'s `PROGRAMDATA` lookup) rather than the Windows known-folder API.

**UE4SS** (Lua scripting/native modding framework, supported on both Crime Boss and PD3) splits into two layers that are handled completely differently, and conflating them is the easiest way to get this wrong:

1. **The loader itself** (`commands/ue4ss.rs`) — modeled like SuperBLT/DAHM (presence-detected, one-shot install, never tracked in state), but parameterized per `(game_id, launcher)` instead of hardcoded to one game, because detection genuinely varies: Crime Boss has one maintained release (proxy `dwmapi.dll`); PD3 has **two independently-maintained mod pages** distributing it over time with **different proxy DLLs** (`xinput1_3.dll` for the newer one, `dxgi.dll` for the older one still in real use — e.g. DebugMenuMod, a live PD3 mod, depends on the older page specifically) — both verified against their real downloaded archives, and detection checks every known name per game so it doesn't matter which release a user has. There is no canonical download URL the way SuperBLT/DAHM have (each release is just somebody's modworkshop mod page, no guaranteed long-term host), so install goes through the _normal_ mod-install flow rather than a dedicated fetch — see `zip.rs`'s `UE4SS_LOADER` sentinel above.
2. **UE4SS sub-mods** (Lua mods other authors publish separately, dropped into the loader's `Mods/` folder) — these _are_ tracked, via the `ue4ss_mods` `ScanTarget` (Directory-unit, marker `Scripts/main.lua`, added to both `PD3_ENGINE` and `CRIMEBOSS_ENGINE`) and a `mods.txt`-file sync (`mods/ue4ss_modstxt.rs`) instead of file-move for enable/disable.

**The hard part is telling the loader, its own bundled framework sub-mods, and a real third-party sub-mod apart — all three can look identical.** Verified against both real downloaded releases: the full loader zip contains a top-level `UE4SS-settings.ini` _and_ ships ~9-10 bundled framework sub-mods (`ActorDumperMod`, `BPModLoaderMod`, `ConsoleCommandsMod`, etc.) inside its own `Mods/` folder, each with the exact same `Scripts/main.lua` shape a genuine standalone sub-mod has. So: `has_ue4ss_loader_signature`'s top-level-`UE4SS-settings.ini` check is what distinguishes "this download is the whole loader" from "this download is one sub-mod" (a sub-mod never carries that file); and `ModUnit::Directory`'s `excluded_names` list (the verified bundled-module names) is what stops those 9-10 internal modules from being ambient-scanned into Modrex's Installed list as if a user had downloaded them — `index_gated_markers` (the mechanism that solves the equivalent DAHM problem) can't apply here, because `modrex-index` only ever hashes `.pak` files and these are plain `.lua` scripts it never sees. `reconcile_state`'s framework-only purge checks `excluded_names` too, so entries that got ambient-scanned into `state.json` _before_ `excluded_names` existed self-heal on the next load rather than needing a manual fix.

- The modworkshop API at `api.modworkshop.net` requires a `User-Agent` header or returns 403.
- PD3 mods are `.pak` files. Active: `{gamePath}/PAYDAY3/Content/Paks/~mods/`. Disabled: `~mods/disabled/foo.pak.disabled`. `gamePath` is the game install root. State: `.modrex.json` inside `~mods/` (was `.pd3mm.json`; migrated transparently on first launch after upgrade; travels with the game folder on dual-boot setups).
- PDTH supports a fourth mod format: `.pdmod` — a ZipCrypto-encrypted ZIP (password `0$45'5))66S2ixF51a<6}L2UK`) containing `pdmod.json` (an `ItemQueue` manifest) plus replacement asset files. `BundlePath` and `BundleExtension` fields in the manifest are Bob Jenkins lookup8 hashes; `commands/mods/pdmod.rs` resolves them via an embedded 130k-entry hashlist (`pdmod_hashlist.txt`, sourced from HW12Dev/PDModExtractor) and writes each asset to `assets/mod_overrides/<mod_name>/<resolved_path>.<resolved_ext>`. `zip.rs::resolve_archive_download` intercepts `.pdmod` files before `detect_archive` (since they are valid ZIPs by magic bytes and would otherwise fall through to the Directory-unit path). Location tag is `"mod_overrides"`.
- PD2 mods come in three flavors: BLT mods (`mod.txt`) and BeardLib mods (`main.xml`) both live in `{gamePath}/mods/` — Modrex scans for either marker (`entry_markers: &["mod.txt", "main.xml"]`); asset-replacement mods (any directory) live in `{gamePath}/assets/mod_overrides/` (`entry_markers: &[]`). Disabled mods of any flavor move to their respective `disabled/` subdirectories. State: `.modrex.json` inside `{gamePath}/mods/`. No numeric priority prefix — BLT/BeardLib load alphabetically. Disabling moves the whole folder; no extension rename. PDTH has BLT mods (`mods/` + `mod.txt`) and DAHM sub-mods (`mods/` + `base.lua`); it also has `mod_overrides` like PD2. PDTH has two loader mods handled as hardcoded exceptions: PDTHModOverrides (id 53474, `DINPUT8.dll` + `PDTHModOverrides.dll`) and DAHM (id 14267, `lightfx.dll`) — both are detected by DLL presence in the game root and installed via dedicated commands rather than the normal mod-install flow. BeardLib mods declare their modworkshop id in `main.xml` (`<AssetUpdates provider="modworkshop" id="N">`); `get_installed` uses this to identify them when the SHA256 hash misses — see the `get_installed` identification pipeline.
- **RAID: World War II** (`game_id: "raid"`) is Diesel-engine like PD2/PDTH. Steam-only on PC: app id `414740`, install folder `RAID World War II`, exe `raid_win64_release.exe`, process `raid_win64_release`; no Epic/Xbox release and no native Linux build (unlike PD2, so no `.so` loader variant). **Unlike PD2/PDTH, RAID has a single blanket-accept `mods` target (`RAID_ENGINE`), not a `mods` + `assets/mod_overrides` pair.** The modern loader (RAID-SuperBLT + RAIDWW2-BeardLib, mod 49760) reads BLT script mods (`supermod.xml` for SuperBLT, `mod.xml` for legacy RaidBLT — `mod.txt` does not exist in RAID's fork) **and** asset override packs (textures, `soundbanks/` sound replacements, etc.) from one `{gamePath}/mods/<name>/` folder: the older `assets/mod_overrides` mount was removed (current builds show a "MOD OVERRIDES IS NO LONGER USED" migration dialog, and BeardLib's `FindOverrides` scans each `mods/<name>/` folder for override subfolders instead — verified against a real install). So the target has no markers; any folder in `mods/` is a user mod unless its name is on `RAID_INFRA_FOLDERS` (`base`/`downloads`/`logs`/`saves` — mirrors BeardLib's own `_ignore_folders`, minus BeardLib itself, which is a normal installable mod tracked like any other). State: `.modrex.json` inside `{gamePath}/mods/`. The top-level `base` skip in `find_untracked_paks` also covers `mods/base/supermod.xml`, which a blanket scan would otherwise treat as a user mod. Loader: **RAID-SuperBLT** (modworkshop id 49744) is detected by `WSOCK32.dll` or `IPHLPAPI.dll` in the game root and installed as a full-zip extraction to the game root, DAHM-style, because the zip ships the Lua basemod `mods/base/` inside (unlike PD2's DLL-only SuperBLT zip); `IPHLPAPI.dll` may also be the discontinued RaidBLT. Its detection markers and download endpoint live in the loader registry (`commands/loaders.rs`). RAID mods declare the loader as an instructs-template dependency on 49744, resolved to the loader via the registry and routed to `install_loader`, never the normal mod flow. Both BLT marker formats embed the mod's own modworkshop id — `supermod.xml`: update element with an `identifier` attribute, version on the root mod element; `mod.xml`: `auto_updates` element with `id` + `version` attributes — parsed by `embedded_modworkshop_id` as an identification fallback (asset packs carry no marker and identify by SHA256/name); both repos hash the marker file itself (`hashable_file_for_mod_dir` / modrex-index's `selectMarkerPath` agree on `main.xml` then `supermod.xml` then `mod.xml`).
- **Host-mod content packs** (PD2): some add-ons (e.g. Menu Backgrounds background sets) carry no marker and no asset structure — they install _inside another mod's_ folder, which the scan-target model can't infer. `host_mods.rs` recognizes them by content signature and routes them via `install_host_pack`; they're tracked with a `host:<id>:<subpath>` `location`. A flat folder of loose files matching no host falls back to `UNRECOGNIZED_ARCHIVE` (the UI shows the author's instructions) rather than being silently dropped into `mod_overrides`. The manager places files and stops: it never writes a host mod's runtime/in-game settings to "activate" a pack (selecting it inside the host mod is the user's job).
- "Launch without mods" for PD3 renames `~mods` → `PAYDAY3/Content/~mods.bak` (one level above `Paks/`) — must be outside `Paks/` because Unreal scans all subdirectories there (PD3 is UE 4.27, not UE5, but the pak-mount behavior is the same). For BLT/BeardLib games, `do_restore` and `launch_without_mods` iterate `cfg.targets` — each target gets its own backup (`mods.bak/`, `assets/mod_overrides.bak/`); a target is skipped if its backup doesn't exist. Only user mod subdirectories are moved; `base/` is excluded from the primary target only (BLT recreates it if missing, showing a "base mod missing" dialog). `fs::remove_dir` (not `remove_dir_all`) on cleanup so failed renames are never silently deleted.
- **Mod priority**: Unreal loads `.pak` files alphabetically, so higher prefix number = loads later = overrides earlier mods. Top of `InstalledPage` = highest priority.
- `InstalledMod.uid` is the stable per-file identity for all commands and DnD. `id` is an opaque, source-scoped local key for every source (including modworkshop) — never a real callable id and never sign-meaningful, derived via `sources::source_native_local_id` (FNV-1a hash of `"{source}:{remote_id}"`, always negative) once a mod is identified, or a local hash/sentinel otherwise. The real remote id for any source lives only in `InstalledMod.remoteId: Option<String>`; "identified" means `remoteId.is_some()` (renderer: `isIdentified()` in `installedUtils.ts`), never `id`'s sign. Every call site that needs to call a source's real API must read `remoteId`, not `id`. Use `installedMod?.fileId === file.id` to identify installed variant — version string comparison is unreliable.
- `Mod.download` is `| null` even when `mod.has_download` is true — this happens when a mod has files but no default download set. `Mod.download.type` and `ModFile.type` are typed `string | undefined` — the API omits the field for some mods even when the parent object is present. Use `isUnsupportedFormat(type, downloadUrl)` from `src/renderer/src/formatCheck.ts` rather than comparing `.toLowerCase()` directly — it guards both the `type` field and falls back to the URL path extension when `type` is absent.
- **`Mod.download.url` vs `download_url`**: modworkshop has two distinct download object shapes. File-hosted mods: `download.download_url` (CDN URL), `download.type`, `download.size` present, no `url`. External-link mods: `download.url` (third-party site), no `download_url`/`type`/`size`. Detect link-type with `download.url && !download.download_url`. Links also have a separate endpoint `/mods/{id}/links` (→ `ModLink[]`) for a mod's associated external links list — distinct from the default download object.`ModLink` has `url` but no `download_url`, `type`, or `size`.
- `ModDependency.mod` is `Mod | null` — the modworkshop API returns `null` when a dependency mod has been deleted. Always guard with `d.mod !== null` before accessing any field. `allDeps` arrays must be filtered with `.filter((d) => d.mod !== null)` at the source before being passed downstream.
- **modworkshop has two distinct version fields**: `/mods/{id}` returns a `version` field (e.g. `"2.11"`) and `/mods/{id}/files/latest` returns its own `version` field (e.g. `"1.9.4"`). `InstalledMod.version` must store the **mod-level** value so it matches what `getCachedMod` returns and `useModData` can compare them. Never store the file-level version.
- **Mod folders**: arbitrary nesting. `ModFolder.parentId` is `string | null` (null = root). Disk paths built by `get_folder_path` walking the `parentId` chain. Priority scoped to siblings within the same parent.
- **Discord Rich Presence** (`commands/discord.rs`): a dedicated worker thread owns the Discord IPC client (connect retry 15 s, keepalive 30 s); `lib.rs` starts it with the persisted `discord_rich_presence_enabled` setting (default on). The renderer sets the displayed game via `update_discord_presence` (an mpsc send to the worker); the Settings toggle calls `set_discord_presence_enabled`, which flips the worker's shared `AtomicBool` and persists the setting — disabling clears the presence on the next worker wake, no restart needed.
- **`windows_fullscreen.rs`** (Windows-only, installed on the main window in `lib.rs` setup): a comctl32 window subclass that consumes `WM_NCCALCSIZE` only while the window is borderless-fullscreen-with-`WS_MAXIMIZE`, because Tao 0.35 otherwise clamps a fullscreen window entered from the maximized state to the taskbar work area.
- Tauri `identifier` is `modrex` (changed from `io.github.shulhaoleh.pd3modmanager` in v0.10.0). `productName` is `Modrex` — Tauri uses this for `userData` path on Windows. The full upgrade chain (Electron → old Tauri identifier → current) is handled by `nsis/installer-hooks.nsi` (removes the old install via its registry uninstall key) and `migrate_from_old_identifier()` / `migrate_from_electron()` in `settings.rs` (migrates app data on first launch).
- **`install.config.json`** (repo root) is live install infrastructure, not local config: the modrex-site Pages Function behind `modrex.net/install.sh` fetches it from this repo's **`main` branch on every request** and prepends it (flattened to `CFG_*` shell exports) to the pinned mget install engine — a push to `main` that touches it changes the live Linux installer immediately, with no release or site deploy involved. Field meanings are defined by mget's config schema (`mget/README.md`).

### Mod-identification index

The live pipeline is `apps/index` in this monorepo (see its CLAUDE.md): Neon Postgres is the source of truth, exported as per-game SQLite snapshots and published to R2 at `index.modrex.net`, with the catalog manifest at `catalog/latest.json`. The desktop app downloads each configured game's snapshot to `app_data_dir()/indexes/<game_id>.db`, verified by sha256 against the manifest (`mod_index.rs`, detailed in the backend rules). Snapshots keep the schema `games`, `sources`, `mods`, `files`, so identification queries are unchanged. The standalone `modrexio/modrex-index` repo only maintains the frozen `latest-index` release (monolithic `index.db`) for desktop versions through 0.12.2. This monorepo never publishes legacy index assets.

## Usage analytics (opt-in telemetry)

Anonymous, opt-in GA4 usage analytics sent from Rust (`commands/analytics.rs`), proxied
through `modrex.net`. Full design + local proxy-testing steps live in
**`.claude/rules/analytics.md`** (loads when you open the analytics code).

## Localization

All user-visible renderer strings live in `src/renderer/src/i18n/en.json`, accessed through the
typed `t()` helper (`src/renderer/src/i18n.ts`) — never hardcode a string in a component. The
`i18n/` folder holds only locale JSON files (industry convention); the logic that reads them
(`i18n.ts`, `locales.ts`) lives one level up, alongside the other renderer modules. `en.json` is
the canonical key set; every other locale is a `DeepPartial` of it, and a key missing from a
translation falls back to English at runtime rather than rendering blank or a raw key.
`useLocale()` (a `useSyncExternalStore` hook) drives `App.tsx`'s `key={locale}` on the root
element — switching language remounts the whole tree so every `t()` call re-evaluates, without
re-detecting the game path or re-fetching the installed list (that state lives in `App`, above the
returned JSX, and survives the remount). Module-scope `t()` calls are blocked by an ESLint rule
(`eslint.config.js`) since they'd freeze at import time and never react to a switch — call `t()`
inside a component, typically via `useMemo`.

**No manual locale registry.** `locales.ts` discovers every file in `i18n/*.json` at build time
via `import.meta.glob` — a locale exists the moment its JSON file exists, nothing else declares it.
Its display name comes from `Intl.DisplayNames` (a language's name in its own language, e.g. `uk`
→ "українська"), so there's no hand-maintained label either. This means adding a language is
**exactly one new file** — see `CONTRIBUTING.md` for the contributor-facing steps.

The root `CLAUDE.md` owns the AI translation policy. Missing keys are valid and use the English
fallback. `pnpm check-i18n` rejects unknown keys, empty or non-string values, incomplete
singular/plural pairs, and mismatched `{var}` interpolation, then reports each locale's key
coverage. `pnpm i18n:missing <locale>` lists untranslated keys with their English source text.
`pnpm i18n:fill <locale>` writes missing keys as `! `-prefixed English fallbacks into the locale
file for IDE editing; marked values remain untranslated and fall back to English at runtime.
`pnpm i18n:translate <locale>` continues an existing locale interactively.
`pnpm i18n:create <locale>` creates a new IDE-ready locale containing marked English text, while
`pnpm i18n:fill <locale>` adds or refreshes marked text only in an existing locale. `pnpm
i18n:presentation-check` reports whether the README translation table and per-locale status SVGs
(`assets/i18n/status/`) still match current locale state without writing anything; `pnpm
i18n:presentation-write` materializes them. The `translation-status` workflow runs the writer
after locale changes reach `main`, so manual edits inside the generated README block or to a
status SVG are overwritten on the next run.

## Testing

Rust unit tests live in separate test files referenced from the module via `#[cfg(test)] mod tests;`, or inline in the module file itself. 332 tests across 14 modules — run with `cargo test` inside `src-tauri/`. `tempfile` and `filetime` crates are in `[dev-dependencies]` for filesystem tests; `tokio = { version = "1", features = ["rt", "macros"] }` is in `[dev-dependencies]` (in addition to the production dep) to enable `#[tokio::test]` for async filesystem tests.

- `commands/domain.rs` (inline `#[cfg(test)] mod tests`) — the external-API parsers, which are the one place a bad response can empty a whole page. Covers a real ModWorkshop listing shape, a link-type download carrying no `download_url`/`type`/`size`, a mod missing nearly every field, an empty page, unknown fields being ignored, file and link listings, mod details (including that `serde(flatten)` still merges the summary half, and that a dependency keeps its nested summary and its offsite form), and the Nexus mapping plus its offset-to-page-count conversion. Four tests specifically assert that **explicit nulls** fall back to defaults: `serde(default)` covers an absent field but not a present `null`, and a live response with `"category_id": null` used to fail the entire request.
- `commands/conformance_tests.rs` — the cross-game conformance suite: every check is written once and run for **every** entry in `GAME_REGISTRY`, so a family-conforming new game gets coverage by existing in the registry. Covers engine/def completeness (index game name, state filename, at least one executable/process/store), target-tag uniqueness, `target_for` routing (untagged → primary, every tag → its own target, unknown → primary), `disabled_suffix` consistency with the `ModUnit` kind, the disabled-dir-inside / backup-dir-outside path invariants, per-target mods/backup dir distinctness, and a state save/read round trip per game and target. Game-specific behaviour tests stay in their own files, and the loader registry's own invariants stay in `loaders.rs` — this suite covers the uniform contract, not the novel 20%.
- `mods/tests.rs` — pure functions + state I/O (naming, paths, zip, state); multi-target engine routing; `InstalledMod.location` round-trip; four async `find_untracked_paks` filesystem tests (primary=None location, secondary location tag, known-set cross-target isolation, backup-skip per target)
- `launchers/mod_tests.rs` — VDF parser + launcher identification
- `settings_tests.rs` — JSON roundtrip; analytics consent tri-state + anonymous-ID generation
- `mod_index_tests.rs` — in-memory SQLite queries; two-game setup (PAYDAY 3 + PAYDAY 2); cross-game isolation tests verify a PD2 hash never matches PD3 and vice versa
- `thumbnails_tests.rs` — `cleanup_dir` eviction logic (uses `filetime` to set mtime on temp files)
- `loaders.rs` (inline `#[cfg(test)] mod tests`) — registry invariants (unique loader ids, every `games` entry registered in `GAME_REGISTRY`, no modworkshop id claimed by two loaders, every id resolves) plus per-loader presence detection driven through `check_loader`: SuperBLT's three filenames, RAID-SuperBLT's two hooks and absent Linux variant, PDTHModOverrides requiring the `DINPUT8.dll` proxy, DAHM's hook, the directory-named-like-the-loader edge case, the missing-game-path case, and that raw detection ignores the Diesel 3.0 marker (that carve-out lives in `check_loader`, not in detection)
- `api_tests.rs` — `parse_rate_limit_remaining` header parsing (present/zero/absent/malformed)
- `news_tests.rs` — `parse_news_html` against a saved fixture; `extract_total_pages` against inline WP-PageNavi HTML (both the `.last`-link case and the last-page case where that link is absent); `category_url`/`category_slug` page-segment and game-mapping logic
- `ue4ss_tests.rs` — loader presence detection per game/launcher (including both PD3 proxy DLL variants), unverified-launcher no-ops, directory-named-like-the-proxy-file edge case
- `commands/mods/pdmod.rs` (inline `#[cfg(test)] mod tests`) — `hash64` determinism and known-value round-trip against the embedded hashlist, `safe_output` path-traversal rejection and backslash normalisation, `extract_pdmod` full ZipCrypto round-trip (builds a real encrypted archive in memory, extracts, verifies output path and bytes), unknown-hash skip returning the correct error string

Renderer tests use Vitest (`pnpm test:renderer`). The default environment is `node` (`vitest.config.ts`, matching `src/**/*.test.{ts,tsx}`) — pure-logic test files need no browser APIs. Eleven test files, 193 tests:

- `src/renderer/src/formatCheck.test.ts` — `isUnsupportedFormat`: type field, URL extension fallback, tar double-extensions, invalid URLs
- `src/renderer/src/installSentinels.test.ts` — `handleInstallOutcome` routing: each of the four prompt outcomes reaches only its own handler and returns true; a completed install returns false and calls nothing
- `src/renderer/src/hooks/installedUtils.test.ts` — all eight exports: `syntheticMod`, `getAllModsInFolder`, `filterInstalled`, `normalizeModScopes`, `computeChildren`, `groupChildren`, `groupInstalledByIdentity`, `computeHealthSummary`
- `src/renderer/src/browseCache.test.ts` — TTL/stale logic, cache key isolation (including game isolation via workshopId), categories TTL and per-game independence; uses `vi.resetModules()` + dynamic import for per-test state isolation
- `src/renderer/src/modCache.test.ts` — TTL/expiry for mod/files/links caches, `loadFromStorage` pre-warming and expiry, `scheduleStorage` debounce; `fetchInstalledModsMeta` chunking/partial-failure and its isolation from `modCache`; uses `vi.doMock('./api', ...)` + `vi.stubGlobal('localStorage', ...)` before each dynamic import
- `src/renderer/src/loaders.test.ts` — the renderer half of the loader registry against a stubbed `list_loaders`: `loadersForGame` (per-game filtering, a loader shared by several games, unknown game), `loaderForModId` (all three PD3 UE4SS mod pages resolving to one loader, PDTH's two pages, a loader id not resolving under a game that doesn't use it, an ordinary mod id), `buildLoaderModIds` (one loader state spread across every id it's published under; unchecked reported as `null`, not omitted; empty for a loader with no mod page), and `resolveLoaderState` (checks only the loaders a mod depends on, keeps already-known state)
- `src/renderer/src/deps.test.ts` — `collectDeps` (direct + template dependency merging, author-defined `order` sorting with id tiebreak), `isLoaderDep`/`isOffsiteDep` classification, `missingRequiredDeps`, `offsiteDepHost`, `isUe4ssLoaderId`/`ue4ssLoaderIdsFor` (both PD3 mod pages recognized, Crime Boss's single one, undefined/unknown-game fallthrough)
- `src/renderer/src/requestPriority.test.ts` — `waitForForegroundClear` recency-window behavior (immediate resolution when idle, waits out the quiet window after `markForegroundActivity`, extends on a repeated mark mid-wait) using fake timers; fresh module per test (`vi.resetModules()`) to avoid cross-test state bleed
- `src/renderer/src/components/ZipPickerModal.test.ts` — `computeAutoUpdateSelection` filename-matching against prior installs (matched/excluded/missing/no-match cases) and `installZipPickerEntries`'s install loop, with `../api` mocked via `vi.doMock`
- `src/renderer/src/components/MarkdownContent.test.tsx` — hostile-payload tests for the mod-description renderer (`@testing-library/react` + per-file `// @vitest-environment jsdom` pragma): script/style/object/embed stripping, event-handler removal, `javascript:` link neutralization, gated external-link opening, embed-host iframe allowlisting, plus regressions for the two sanitizer carve-outs (color-tag spans, highlight classes surviving plugin order)
- `src/renderer/src/components/UpdatesModal.test.tsx` — component-rendering test using `@testing-library/react` with a per-file `// @vitest-environment jsdom` pragma (rather than switching the global default, so the rest of the suite stays on the faster `node` environment). Verifies the batch "Update All" queue resumes the remaining selected mods on its own after a picker modal (e.g. `ZipPickerModal`) closes, instead of stalling until the user clicks "Update Selected" again

`mods/` submodule uses `#[cfg(test)] pub(crate) use` to re-export private helpers so `tests.rs` can reach them via `use super::*`. The `::zip::` prefix is required in `tests.rs` to reference the external crate (not the local `mod zip` submodule).

## Rules

- **Never run any git command that touches the remote** (push, push tag, delete tag, force push) or is destructive locally (tag -d, reset --hard). Always write out the commands and let the user run them.
- **When adding or updating dependencies** (Cargo.toml or package.json), remind the user to run `pnpm generate-licenses` to update `THIRD_PARTY_LICENSES.md`. The pre-commit hook does this automatically when dep files are staged. CI enforces it via the `check-licenses` job in `ci.yml`.
- **Commit messages must follow conventional commits** — `type(scope): subject` — enforced by `commitlint.config.ts` at commit time. Common types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`.
- **Prefer `.expect("reason")` over `.unwrap()`** for paths that are infallible in practice (OnceLock init, app path resolution). Prefer `.unwrap_or_else(|e| e.into_inner())` for Mutex guards so a poisoned lock recovers rather than re-panicking. Reserve plain `.unwrap()` for tests only.
- **Never break the in-app update pipeline.** The updater endpoint is `https://github.com/modrexio/modrex/releases/latest/download/latest.json`. Any change to draft/publish behavior, `latest.json` generation, or the startup update check can silently stop all users on the current release from ever receiving future updates. Verify the full pipeline end-to-end when touching anything updater-related.
- **Content Security Policy** lives in `tauri.conf.json` as `csp` (production) + `devCsp` (dev, relaxed with `'unsafe-inline'`/`'unsafe-eval'` and localhost ws/http for Vite HMR). When adding any external resource — image host, iframe/embed provider, web font, or a renderer `fetch` — add its origin to the matching directive in **both** `csp` and `devCsp`. `dangerousDisableAssetCspModification: ["style-src"]` stops Tauri injecting style hashes (which would void `'unsafe-inline'` and break Tailwind/Radix/`createDragImage` inline styles); scripts still get Tauri's nonce injection, so `script-src` stays `'self'`. Mod descriptions render untrusted HTML via `rehypeRaw`, sanitized by `rehype-sanitize` (explicit schema in `MarkdownContent.tsx`; hostile-payload tests in `MarkdownContent.test.tsx`), with the CSP as defense-in-depth behind it — keep both tight.
- **New install entry points** must handle the typed `InstallOutcome` that `installMod`/`installModFile`/`installDroppedFile` resolve with (`installed`, `needsPicker`, `needsHostChoice`, `needsCbFlatConfirm`, `unrecognized`), normally by passing it to `handleInstallOutcome` (`src/renderer/src/installSentinels.ts`), whose required-in-full handlers object makes a missed prompt a compile error. Genuine failures still arrive as thrown errors. See `BrowsePage`'s `doInstall` for the canonical pattern.
- **External URL opening is gated.** Every renderer call site funnels through the `shell_open_external` command, which runs `sanitize_external_url` (allow `http`/`https`/`mailto` only; reject `cmd`-breakout chars) before shelling out. Mod-description links are attacker-controlled — never bypass this command or pass untrusted URLs to a shell directly. The markdown link handler in `MarkdownContent.tsx` mirrors the scheme allowlist so disallowed links render as plain text.

## Agent skills

Reusable skills live in `.agents/skills/` and are listed in `AGENTS.md`. Available as Claude Code slash commands:

- `/commit` — read the current diff and propose a conventional commit message; waits for confirmation before committing.
- `/deslop` — audit the branch diff for AI-generated slop (unnecessary comments, defensive checks, wrong abstractions, project convention violations) and fix each issue found.
- `/changelog` — add user-facing entries (Keep a Changelog categories: Added/Changed/Fixed/Security) to the root `../../CHANGELOG.md` file's `## Unreleased` section for recent commits or uncommitted changes. Run this after any user-facing change, not just at release time — it's what keeps release notes from requiring a re-read of every commit.
- `/danger-audit`, `/control-flow`, `/comment-audit`, `/ai-review` — the audit passes from `.claude/rules/code-style.md`'s final-pass checklist (dangerous-pattern scan, branching flatten, comment cleanup, pre-PR review); `AGENTS.md` describes when each applies.

**Deferred work**: tracked in `.TODO`. Do NOT act on anything in it unless the user explicitly says "do the TODO: <name>" — never infer intent from the file on your own.

**Releasing**: with a clean tracked tree, run `pnpm version patch|minor|major` from
the repository root. Running it from this directory is blocked.
The command bumps `package.json`, commits as `chore(release): X.Y.Z`, and creates an
annotated `vX.Y.Z` tag. It also stamps the root `CHANGELOG.md` file's
`## Unreleased` section into `## X.Y.Z` and stages it in the release commit.

`git push --follow-tags` pushes the release commit and annotated tag. The release
workflow waits for CI to pass on that exact commit, builds the signed updater artifacts,
and creates a draft GitHub Release named `vX.Y.Z`. Publishing that draft makes its
`latest.json` available to installed clients and triggers
`.github/workflows/site-deploy-hook.yml` to rebuild modrex.net.
