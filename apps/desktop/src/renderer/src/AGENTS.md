# Renderer (`src/renderer/src/`)

Paths are relative to `apps/desktop`.

**`api.ts`** — the only renderer file that talks to the IPC layer: it calls the generated `commands.*` functions from `src/shared/bindings.ts` (which owns the raw `invoke` strings) plus `listen`. All other renderer code imports from here — never from the bindings directly (check-commands enforces both). The bindings are generated from lib.rs's `ipc_builder()` registry by the `export_bindings` Rust test; never edit them by hand. Generated optional params are `T | null` — wrappers pass `x ?? null` and keep their public `?:` signatures. Mod data is typed end to end: `listMods`, `getMod`, `listModFiles`, `listModLinks` and `nexusSearchMods` are assigned to the hand-written types in `src/shared/types.ts` **without a cast**, so any drift from the generated shapes is a compile error in this file. Only the few genuinely untyped passthroughs still return `unknown` and are cast. `onEvent<T>` wraps `listen` with a cancellation-safe pattern (resolves the `UnlistenFn` async, cancels immediately if component unmounts first). Every game-scoped wrapper takes a **required** `gameId: string` — there is no pd3 default any more: an unknown or absent game id is a hard command error on the Rust side, per the game registry (`commands/games.rs`). Always pass `activeGame` from context. `installFromZipEntry(..., gamePath, gameId, folderId?, locationTag?, entryKind?)` and `installDroppedFile(path, gamePath, gameId, folderId?)` put the required `gameId` before their optional trailing params; pass `payload.targetTag` as `locationTag` from `ZipMultiPakPayload`.

**`App.tsx`** owns application settings, startup completion, update events, and the
application route. `navigation.ts` distinguishes the picker, global settings, and a game
workspace. Only the game route carries a game ID. It validates saved IDs at startup and
reads the older navigation keys when no scope has been saved. Global routes never mount
a workspace. `preview/navigation.test.tsx` covers navigation, restart, and scope isolation.

**`GameWorkspace.tsx`** owns game page navigation, the mod detail stack, source selection,
and focus refreshes. It mounts for one game and unmounts on returning to the picker.
Game panes stay mounted across tab switches with visibility-based hiding. Locale changes
remount its rendered pages while preserving workspace navigation and data subscriptions.
`GameTopBar` supplies game controls to the shared `TopBar`. `Sidebar` takes a typed
navigation object whose global variant contains no game ID or game navigation callback.

**`gameData.ts`** caches paths and installed state by game and exposes subscriptions used
by the workspace. Explicitly targeted install and launch operations can refresh the same
cache after a workspace closes. Request counters reject superseded results. Missing-path
detection is throttled for five minutes, and manual path selection clears the throttle.
Undefined path or installed data means loading, not a missing game or empty library.
See `gameData.test.ts` for response ordering and game isolation.

**`gameLaunch.ts`** owns process polling and pending vanilla-launch restoration by game.
`GameTopBar` subscribes while visible. Pending launches and restoration survive workspace
unmounts, while idle polling stops without subscribers. See `gameLaunch.test.ts`.

**`FileDropInstall.tsx`** owns the file-drop subscription and archive dialogs outside the
workspace. A mounted workspace registers its drop target through `useFileDropTarget`.
Every accepted drop captures its game, path, and installed files, and each follow-up
prompt carries that target. Global screens register no target.

**`SettingsPage.tsx`** renders application settings without game dependencies. The workspace
supplies `GameSettings` and `GameFolders` as game-only content. The game and global screens
keep separate saved settings tabs. `GameSettings` flushes pending launch-option edits when
it unmounts. Cache ownership remains in `settingsCache.ts`.

**`modCache.ts`** — 5-minute in-memory TTL cache for mods, files, and links; all three are persisted to localStorage (24-hour shelf life) under `modrex:mod-cache`, `modrex:files-cache`, `modrex:links-cache`. On module init, `loadFromStorage()` pre-warms all three Maps from localStorage. Writes are debounced 2 s via `scheduleStorage()` which flushes all three keys in one pass. Always use `getCachedMod` / `getCachedModFiles` / `getCachedModLinks` — never call `api.getMod`, `api.listModFiles`, or `api.listModLinks` directly. Three synchronous accessors return cached entries without fetching: `getModCacheEntry(id)` returns `{ mod, fetchedAt }`; `getFilesCacheEntry(id)` returns `{ files, fetchedAt }`; `getLinksCacheEntry(id)` returns `{ links, fetchedAt }`. These are used by `ModDetailPage` to sync-initialize state on mount, bypassing the loading spinner when data is already warm.

**`nexusModCache.ts`** — Nexus's own cache module, deliberately separate from `modCache.ts` rather than merged into it: Nexus mod ids are only unique within a game domain (they repeat across games) and can also collide numerically with a modworkshop id, so every entry is keyed `${gameId}:${modId}`. Session-only, no localStorage persistence. `getCachedNexusMod`/`getCachedNexusModFiles` (5-minute TTL) back the Nexus mod detail page, mirroring `modCache.ts`'s per-id accessors; `getNexusModCacheEntry`/`getNexusFilesCacheEntry` are the matching sync accessors. `fetchInstalledNexusModsMeta(gameId, modIds, onResult?)` is the Nexus half of `useModData`'s update check — Nexus has no batch metadata endpoint, so it fetches one mod at a time (`STAGGER_MS` = 2 s between requests, on top of `waitForForegroundClear()`) against an undocumented hourly quota, writing into its own `installedMetaCache` (same long TTL as modworkshop's, to stay in lockstep with `useModData`'s staleness check) rather than the 5-minute detail-page cache above. `onResult` fires after each mod resolves, not just once the whole trickle finishes, so the UI can update incrementally instead of waiting for a potentially large installed list to finish one at a time.

**A fourth, deliberately separate cache** — `installedMetaCache` (`INSTALLED_META_TTL_MS`, 30 min, persisted under `modrex:installed-meta-cache`) — backs display metadata for installed mods via the `ids[]` listing filter. It owns names, authors and thumbnails only; entries never reach the full-detail cache. Calls reuse fresh entries and share in-flight per-ID requests, while `useModData` periodically and on focus re-evaluates freshness even when the installed-ID set has not changed.

**`modVersions.ts`** — provider-global, session-only authoritative ModWorkshop version observations. It calls `/mods/versions` through Rust, deduplicates IDs, chunks at 100 on both sides of IPC, coalesces overlapping consumers, and keeps a separate 30-minute freshness lifecycle from display metadata. The state union distinguishes pending, known opaque string, explicit unversioned, stale, missing and failed; only fresh `known` is eligible for an update comparison. Failures back off per ID and a successful retry or fresh detail revalidation replaces obsolete failure state. An omitted ID and an explicit empty string are never conflated.

**`requestPriority.ts`** — lets background API work defer to foreground work so it doesn't sit queued behind silent background calls on the shared rate-limited connection to modworkshop. Installed display refreshes, version batches and hover prefetches all await the same quiet-window gate. It tracks recency rather than an in-flight counter so one missed completion cannot permanently starve background work.

**`thumbnailCache.ts`** — Persistent thumbnail cache bridge. Module-level `resolved: Map<filename, thumbUrl>` deduplicates IPC calls within a session. `getLocalThumbnail(filename)` invokes `get_thumbnail` (which ensures the file exists in the disk cache, downloading if missing), then builds the URL via `convertFileSrc(filename, 'thumb')` — the custom `thumb://` protocol registered in `lib.rs`, **not** Tauri's asset protocol. The thumb protocol serves files from the thumbnails cache dir with `Cache-Control: immutable` (CDN filenames are content-unique), so the webview reuses cached decoded images across page remounts — the asset protocol sends no cache headers, which made every game/tab switch re-decode the whole grid. The `thumb:`/`http://thumb.localhost` origins must stay in `img-src` in both `csp` and `devCsp`. `getCachedThumbnailUrl(filename)` is a synchronous accessor used by `useThumbnail` to initialize state without triggering an IPC call on second render. Never call `api.getThumbnail` directly — always go through `thumbnailCache.ts`. `useModData` pre-warms thumbnails for all installed mods as mod data becomes available (both the sync cache pass and the async fetch pass).

**`settingsCache.ts`** caches game settings and detected installs for `GameSettings`.
The workspace warms it on entry. Manual folder selection and launcher selection patch it
after the backend accepts the new copy. The game-specific launcher and path behavior lives
in `GameSettings.tsx`.

**`browseCache.ts`** — in-memory SWR cache for the Browse page. Keyed by `(workshopId, page, query, sort, categoryId, includeTags, excludeTags)` — the two tag-id sets are sorted and joined into the key so a tag-filtered page never collides with the same unfiltered page; the `workshopId` prefix is load-bearing: without it, switching games pollutes the other game's cache. `getBrowseCache`/`setBrowseCache` take the include/exclude tag arrays as trailing params (default `[]`). All exported functions (`getBrowseCache`, `setBrowseCache`, `getCategoriesCache`, `setCategoriesCache`, `getTagsCache`, `setTagsCache`) take `workshopId: number` as their first argument. 5-minute TTL for mod list pages; 1-hour TTL for categories and tags. `getBrowseCache` returns `{ result, stale }` or `null` — callers show the cached result immediately and skip or background-fetch based on `stale`. `categoriesCache` and `tagsCache` are each a `Map<workshopId, {..., fetchedAt}>` — one entry per game, not a singleton. Not persisted to localStorage (lives only for the process lifetime). `BrowsePage` reads the initial cache synchronously during component init so the first render already has data on return visits.

**localStorage key convention** — Two scopes:

- App-level (same across games): `modrex:<key>` — e.g. `modrex:active-view`, `modrex:active-game`, `modrex:sidebar-collapsed`, `modrex:mod-cache`, `modrex:files-cache`, `modrex:links-cache`
- Game-scoped (per game): `` `modrex:${GAMES[activeGame].storageKey}:<key>` `` — e.g. `modrex:pd3:installed-view`, `modrex:pd3:browse-sort`, `modrex:pd3:collapsed-folders`

`GAMES` from `@modrex/games` is the renderer's game registry, re-exported through `src/shared/types.ts`. It is generated from the Rust packages into `packages/games/catalog.generated.ts`, so **adding a game is one `package.toml`**, never an entry here; `GameId`, the `isGameId` guard, `WelcomeScreen`'s picker, and `navigation.ts`'s valid-id check all follow automatically. `GameSpec` fields: `workshopId` drives modworkshop API calls and is absent for a game not listed there; `nexusDomain` is absent for a game with no Nexus presence; `storageKey` scopes localStorage keys; `hasNews` gates the News nav view; `supportsPackageViewer` gates the pak contents action, and the key it would use never leaves the backend; `requiredLaunchFlag` is the launch argument a game needs for mods to load (PD3's `-fileopenlog`; absent = none), consumed by `TopBar`'s pre-launch warning and `GameSettings`'s launch-options hint. CI fails when the committed catalogue differs from what the packages generate. Never hardcode `'pd3'` or `853` where `activeGame` is available, use `GAMES[activeGame].*`. `BrowsePage` remounts on game change inside the keyed `GameWorkspace`, browse cache and sort preference are both scoped per game.

**`deps.ts`**, dependency-warning logic shared by `ModDetailPage.tsx` and `BrowsePage.tsx` (the loader half of the surrounding state now lives in `hooks/useLoaderState.ts`, see `src/renderer/src/hooks/AGENTS.md`; the deps-warning modal state is still per-component by design). `collectDeps`/`isOffsiteDep`/`isLoaderDep`/`missingRequiredDeps`/`offsiteDepHost` are generic and game-agnostic. `collectDeps` sorts by the author-defined `order` field (id as tiebreak, matching modworkshop's mod-tabs sort), the result's sequence is the author's intended install order, and `DepsTab` numbers rows from it, so never re-sort or re-group downstream. **Two different ways a "loader" dependency is represented**: SuperBLT is hosted _externally_ (no modworkshop mod page), so it's an offsite dependency detected by a `blt` substring heuristic (`isLoaderDep`) and checked via `loaderInstalled: boolean | null`, **PD2 only**, since the check looks for `WSOCK32.dll`/`IPHLPAPI.dll`/`libsuperblt_loader.so` and PDTH's loaders are `DINPUT8.dll` and `lightfx.dll`; every other game leaves that state null. Every other loader is _hosted_ on modworkshop, so it's checked via the `loaderModIds: Record<number, boolean | null>` param, `missingRequiredDeps` looks the dependency's `mod.id` up there before falling back to the normal installed-list check.

**`ModSummary` vs `Mod` (`src/shared/types.ts`)**, a list entry and a full mod are different enforced contracts. `ModSummary` is browse/display data and intentionally has no version or default download. `Mod` adds required computed version/default-download plus the richer `/mods/{id}` fields. Both stay structurally identical to generated Rust bindings; `api.ts` assigns command results without casts so drift is a compile error.

**`sources.ts`** — the renderer half of the source registry, mirroring Rust's `SOURCE_REGISTRY` (`commands/sources.rs`), which owns which sources exist, the games each serves, and the id each knows a game by. `loadSourceRegistry()` runs once at startup (`App.tsx`) so lookups stay synchronous inside render paths. `sourcesForGame(gameId)`, `hasSource(gameId, sourceId)` and `nativeIdFor(gameId, sourceId)` replaced the scattered `GAMES[activeGame].nexusDomain !== undefined` checks; **`nexusDomain` no longer exists on `GAME_SPECS`**. RAID has no Nexus entry, so `sourcesForGame` returns one source for that game only.

**`loaders.ts`** — the renderer half of the loader registry, mirroring Rust's `LOADER_REGISTRY` (`commands/loaders.rs`), which owns which loaders exist, the modworkshop ids each is published under, and the games each serves. `loadLoaderRegistry()` runs once at startup (`App.tsx`) so the lookups can be synchronous inside render paths. `loadersForGame(gameId)`, `loaderForModId(gameId, modId)` (a dependency id → its loader), `buildLoaderModIds(gameId, state)` (expands per-loader state across every id it's published under — UE4SS has three), and `resolveLoaderState(...)` (presence-checks only the loaders a mod actually depends on) replace the old hardcoded id tables. `LoaderState` is `Record<loaderId, boolean | null>`; `null` means unchecked, and loader deps are only reported missing on a definitive `false`. Install dispatch reads `viaModFlow`: false → `api.installLoader(id, gamePath)`, true (UE4SS) → the normal `api.installMod` flow. **Adding a game's loader is one Rust registry entry with no renderer edit.**

**`formatCheck.ts`** — `SUPPORTED_FORMATS = new Set(['pak', 'zip', '7z', 'rar'])` is the single source of truth for installable formats. `.tar.gz` and `.tar.xz` are handled as a special double-extension case in the URL fallback path. `isUnsupportedFormat(type, downloadUrl?)` returns `true` when a file should show a warning before installing: checks `type` first; if undefined, infers from the URL path's file extension. Every install entry point (`BrowsePage.handleInstall`, `ModDetailPage.handleInstall`, `DownloadsTab.handleInstallFile`, `FileSelectModal.handleInstallSelected`) must call this before proceeding. When adding support for a new file format, add it to `SUPPORTED_FORMATS` here.

**New install entry points** must handle the typed `InstallOutcome` that `installMod`/`installModFile`/`installDroppedFile` resolve with (`installed`, `needsPicker`, `needsHostChoice`, `needsCbFlatConfirm`, `unrecognized`), normally by passing it to `handleInstallOutcome` (`src/renderer/src/installSentinels.ts`), whose required-in-full handlers object makes a missed prompt a compile error. See the archive install flow in `src/renderer/src/components/AGENTS.md`.

### Strings (i18n)

All user-visible strings live in `src/renderer/src/i18n/en.json`. Use the typed helper:

```ts
import { t } from '../i18n'
t('common.install')
t('browse.modCount', { total: 42 })
```

`t(key, vars?)` is fully type-safe — TypeScript errors on unknown keys. Never hardcode a
string in a component. The `i18n/` folder holds only locale JSON files (industry
convention); the logic that reads them (`i18n.ts`, `locales.ts`) lives one level up,
alongside the other renderer modules.

**No manual locale registry.** `locales.ts` discovers every file in `i18n/*.json` at build
time via `import.meta.glob` — a locale exists the moment its JSON file exists, nothing else
declares it. Its display name comes from `Intl.DisplayNames` (a language's name in its own
language, e.g. `uk` → "українська"), so there's no hand-maintained label either. Adding a
language is exactly one new file — see `CONTRIBUTING.md` for the contributor-facing steps.
`en.json` is the canonical key set; every other locale is a `DeepPartial` of it, and a key
missing from a translation falls back to English at runtime, and to the raw key only when
English lacks it too.

`useLocale()` (a `useSyncExternalStore` hook) drives the `key={locale}` on `App` and
`GameWorkspace`'s page containers — switching language remounts translated content so every
`t()` call re-evaluates, while application state, workspace navigation and data
subscriptions live above the remounted subtree and survive it. Module-scope `t()` calls are
blocked by an ESLint rule (`eslint.config.js`) since they'd freeze at import time and never
react to a switch — call `t()` inside a component, typically via `useMemo`. `pnpm check-i18n`
validates translated keys and interpolation parameters against English; the translation
workflow itself is described in `apps/desktop/AGENTS.md`.

### Styling

All colors are semantic tokens in `src/renderer/src/index.css` via Tailwind v4's `@theme` block — never use hardcoded Tailwind color classes like `zinc-*` or `red-*`. Token names: `surface`, `surface-raised`, `surface-hover`, `surface-active`, `surface-light`, `border`, `text`, `text-muted`, `text-subtle`, `accent`, `accent-bright`, `danger`, `danger-hover`, `danger-text`, `success`, `success-text`, `warning`.

**Button component** (`components/ui/Button.tsx`): all interactive buttons must use `<Button>` instead of a raw `<button>` with inline Tailwind classes. Backed by `class-variance-authority`; the `cn()` utility (`lib/cn.ts`, combines clsx + tailwind-merge) is used internally and available for any conditional className construction elsewhere in the renderer.

Non-standard padding, `rounded-lg`, or layout classes (`shrink-0`, `-mx-2`, `ml-auto`) go in the `className` prop — twMerge resolves them against the variant base without conflict. Never hand-roll button styles inline.

The drag-image builders in `useDragDrop.ts` (`buildModDragImage`/`buildFolderDragImage`) build DOM nodes outside React's render tree — use CSS custom properties in inline styles (`var(--color-surface-raised)` etc.), not Tailwind classes.

**Page header height** — `components/pageHeader.ts` exports `TITLE_ROW_H` and `TITLE_ROW_MIN_H`, and **they must stay the same number**. Browse's source switcher is the tallest thing that sits on a title row; its height used to be derived from its own contents, which made it depend on font metrics AND on whether a mod count had loaded (a skeleton is not the height of the text it replaces). Both made Browse's header a few pixels taller or shorter than the other pages, so the search bar under it drifted when moving between Browse, Installed, News and the game picker. `TITLE_ROW_H` fixes the switcher's height; every other page's title row reserves `TITLE_ROW_MIN_H`. Any new page with a title row should use it.

**Radix UI primitives** in use — always prefer these over hand-rolled equivalents:

- `components/Dialog.tsx` — wraps `@radix-ui/react-dialog`; see Confirm dialogs in `src/renderer/src/components/AGENTS.md`.
- `components/Select.tsx` — wraps `@radix-ui/react-select`. **Sentinel invariant**: Radix `Select.Item` forbids empty-string `value`; `Select.tsx` maps `''` ↔ internal `'__empty__'` sentinel automatically, so callers can pass `value: ''` freely.
- `components/Tooltip.tsx` + `TooltipProvider` — wraps `@radix-ui/react-tooltip`. `TooltipProvider` is mounted once in `App.tsx`. Use `<Tooltip content="...">` around icon-only buttons; pass `disabled={true}` to suppress it conditionally. Do not put `title` attributes on interactive elements — use `<Tooltip>` instead.
- Tabs — `@radix-ui/react-tabs` used directly in `ModDetailPage.tsx` (no wrapper component).

Icons: `lucide-react`. Platform SVGs (Steam, Epic, Xbox, Windows, Linux) live in `assets/icons/` — import as React components via `import FooIcon from '...svg?react'` (powered by `vite-plugin-svgr`); use `fill="currentColor"` or the `fill-current` Tailwind class so they inherit text color. The same files are referenced in `README.md` as static `<img>` tags with `#gh-light-mode-only` / `#gh-dark-mode-only` URL fragments for GitHub theme switching. Custom dropdowns: `components/Select.tsx` — its `Option` type accepts an optional `icon?: ReactNode` rendered before the label in both the trigger and the list. Toggles: `components/Toggle.tsx`. Markdown: `components/MarkdownContent.tsx` — never inline `ReactMarkdown` directly. Nexus descriptions are BBCode, not markdown: `components/NexusDescription.tsx` parses Nexus's own markup (bold/italic/color/size/lists/urls) into React elements — used in place of `MarkdownContent` wherever `isNexus` is true (`ModDetailPage`'s description tab), never fed through the markdown renderer. Skeleton loading: `components/SkeletonCard.tsx` (grid) and `components/SkeletonListRow.tsx` (list). `ModCard` accepts `installedCount?: number` — when > 1, shows a "N files" badge over the thumbnail (same style as `InstalledPage`); `BrowsePage` builds `installedByModId: Map<number, InstalledMod[]>` via `useMemo` and passes `installedByModId.get(mod.id)?.length || undefined` for O(1) lookup per card. `ModCard` also accepts `onPrefetch?: () => void` called on `onMouseEnter` — `BrowsePage` wires this with a 150 ms debounce that fire-and-forgets `getCachedMod`, `getCachedModFiles`, `getCachedModLinks` so the detail page loads from cache on click.

### Tests

Renderer tests use Vitest (`pnpm test:renderer`). The default environment is `node` (`vitest.config.ts`, matching `src/**/*.test.{ts,tsx}`) — pure-logic test files need no browser APIs. A component test opts into `jsdom` with a per-file `// @vitest-environment jsdom` pragma rather than switching the global default, so the rest of the suite stays on the faster `node` environment; `@testing-library/react` is the render harness for those.
