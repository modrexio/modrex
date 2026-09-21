# Marketing and documentation site

## Architecture

Astro 6 site, static output — everything under `src/` is rendered at build time, no SSR adapter. Docs at `/docs/*` are rendered by the Starlight integration configured in `astro.config.mjs`; every other page uses `BaseLayout`. The one exception to "static" is `functions/`, a Cloudflare Pages Functions directory that sits alongside the static build (not part of Astro/Vite at all — Cloudflare's own build step picks it up).

```
src/pages/               ← routes (index, 404, privacy, terms; docs routes come from Starlight)
src/assets/screenshots/  ← app screenshots, imported (never public/) so astro:assets emits AVIF/WebP
src/components/          ← Astro components (marketing) + docs/ (MDX components) + starlight/ (Starlight overrides)
src/layouts/             ← BaseLayout (every non-docs page; docs pages use Starlight's shell)
src/content/docs/        ← MDX doc pages (the Starlight docs collection)
src/content.config.ts    ← content layer config: Starlight docsLoader + docsSchema (NOT src/content/config.ts)
src/data/docsGames.ts    ← typed per-game docs data; drives the docs table/facts components
src/lib/github.ts        ← GitHub Releases API (build-time only): getLatestRelease, getRecentReleases
src/lib/mod-index.ts     ← build-time recognized-mod count from the R2 catalog manifest (never a SQLite shard)
src/lib/mod-index-shared.ts ← R2 manifest URL + payload type, shared with the browser refresh in Features
src/lib/os-detect.ts     ← detectOs(): shared client-side OS detection for Hero/DownloadSection/Nav
src/lib/og-image.ts      ← getOgImage(): the shared 1200x630 og:image, derived from a screenshot at build time
src/styles/global.css    ← imports tokens + shared utilities + mobile breakpoints
src/styles/starlight.css ← docs-only styling layered over Starlight (loaded via customCss)
src/styles/tokens/       ← design tokens (fonts, colors, typography, spacing, base, components)
functions/api/collect.ts ← Cloudflare Pages Function, see "API (Cloudflare Pages Functions)" below
functions/api/downloads.ts ← Cloudflare Pages Function backing the README download badge, see below
functions/install.sh.ts  ← Cloudflare Pages Function serving modrex.net/install.sh, see below
```

### API (Cloudflare Pages Functions)

`functions/api/collect.ts` is a near-transparent proxy for the desktop app's analytics: it forwards `POST /api/collect` (query string + body) to GA4's Measurement Protocol `mp/collect` endpoint. It exists because DNS-level/hosts-file blocklists and outbound firewalls commonly block `google-analytics.com` itself, for every process on a machine — not just browsers — and modrex-main's audience runs that tooling heavily; routing through `modrex.net` means the request only has to survive being blocked by name, not by Google's domain. See `modrex-main/src-tauri/src/commands/analytics.rs` for the other half. File-based routing: a file at `functions/<path>.ts` maps to that route (`functions/api/collect.ts` → `/api/collect`); export `onRequestPost`/`onRequestGet`/etc. per HTTP method. Deploys automatically alongside the static site via the existing Cloudflare Pages Git integration — no separate build step, not part of `pnpm build`/`pnpm typecheck` (Astro's checker doesn't walk this directory, confirmed: `astro check` only reports on files under `src/`).

The function requires `measurement_id` + `api_secret` query params and an object-shaped JSON body (400 otherwise). It checks the measurement ID against `MODREX_GA_MEASUREMENT_ID` when configured, otherwise only its `G-[A-Z0-9]{4,}` shape (403 on mismatch). Configure the environment variable to restrict the relay to one property. **Fire-and-forget**: it returns 204 and performs the upstream fetch inside `waitUntil`, with a ten-second timeout. Upstream failures are recorded in Pages logs without request URLs, payloads or secrets. A 204 acknowledges proxy receipt, not acceptance into GA4 reports.

**Geolocation fix**: the one place this function isn't a pure byte passthrough. Since Google sees the request coming from this function's own outbound `fetch`, not the desktop app's connection, GA4 would otherwise geolocate every single user as wherever Cloudflare's network egresses from — not their real country. The function reads `CF-Connecting-IP` (set by Cloudflare's edge from the real TCP connection; not spoofable by the client) and injects it as a top-level `ip_override` field in the forwarded JSON body, which is GA4's documented mechanism for exactly this server-side-proxy scenario. Absent under local `wrangler pages dev` (no real edge involved) — forwards fine, just without geo correction in that case.

### Download badge (`functions/api/downloads.ts`)

Serves a [shields.io endpoint badge](https://shields.io/badges/endpoint-badge) at
`/api/downloads`, consumed by the repository README's Downloads badge. It exists because
shields' own `github/downloads/:user/:repo/total` counts **every** release asset, and for this
repo roughly 86% of that is the desktop app's updater polling `latest.json` (plus the
electron-era `latest.yml` and `.blockmap` sidecars) rather than anyone installing anything.
Shields has no wildcard or exclude syntax and pinning one exact asset name would drop Linux
plus every past naming era, so the filtering has to happen server-side.

- **Filter**: an allowlist of installer extensions (`INSTALLER_EXTENSIONS`), matched against the
  end of the asset name, deliberately not a blocklist of known metadata suffixes — a new sidecar
  format added to the release workflow would silently inflate the count under a blocklist,
  whereas a new installer format under-counts visibly until it is added. Suffix matching is also
  what keeps `X.exe.blockmap` and `X.exe.sig` from counting as `X.exe`.
- **Caching**: `Cache-Control` plus the `cacheSeconds` field shields honors (1 hour). Shields
  caches endpoint responses and GitHub's Camo proxy caches the rendered image again, which is
  what keeps the GitHub API calls to a trickle; `GITHUB_TOKEN` (same optional Pages env var
  `src/lib/github.ts` uses) is the margin for a cache miss against the 60/hour unauthenticated
  limit.
- **Failure shape**: an upstream failure renders `unavailable` with `isError: true` and a 5
  minute cache, never a number — a stale-looking count would misreport, and a short TTL keeps a
  GitHub outage from becoming a retry storm.

### Install script (`functions/install.sh.ts`)

Serves `modrex.net/install.sh`, the `curl -fsSL https://modrex.net/install.sh | sh` entry point for Linux installs (the mget engine also handles macOS, but Modrex ships no macOS build). It implements the "Worker integration" contract from `mget`'s README (`C:\local\modrexio\mget`): resolve an engine pin to a real mget tag, fetch the project config, concatenate, stream.

- **Engine pin**: `ENGINE_PIN = 'v1'` (bare major), resolved on every request to the newest `v1.x.x` tag via the GitHub **tags** API, never the Releases API (mget tags are not GitHub releases) and never `@main` (a bad mget push must not break every install instantly). An exact-tag pin (`v1.1.0`) skips the API call entirely; `latest` is supported but deliberately unused for modrex.
- **Config**: fetched from `https://raw.githubusercontent.com/modrexio/modrex/main/install.config.json` at request time, so `install.config.json` changes take effect on push to modrex-main with no site deploy.
- **Output**: a single `#!/bin/sh` script: the config flattened into `CFG_*` exports, then the engine body with its own shebang stripped (only one shebang may survive). The flattening is generic: every top-level key matching `^[a-z][a-z0-9_]*$` with a string/number/boolean value becomes `CFG_<KEY>` (booleans as `true`/`false`, `preferred_variant` flattened to `os:variant` pairs, anything else skipped). There is no field list here on purpose - the schema belongs to `mget`, the engine ignores names it does not know, and a new optional field works without touching this file. `shellQuote` single-quotes every config value, escaping embedded quotes with `'"'"'` - this is the injection barrier between config data and shell code; never simplify it.
- **Failure shape**: any fetch failure returns HTTP 502 whose body is itself a valid shell script (`# reason` then `exit 1`), so `curl | sh` fails cleanly instead of piping an error page into `sh`.
- Served with `Cache-Control: no-store` - the script is fetched once per install, so always serving the current engine/config beats caching. GitHub API calls send a `User-Agent` header (GitHub rejects unauthenticated requests without one).

### Data flow

`getLatestRelease()` in `src/lib/github.ts` is called in `src/pages/index.astro` at build time with a try/catch fallback to `null`. The `release` object is passed as a prop to `Nav`, `Hero`, and `DownloadSection` — all three must handle `release: Release | null`. `getRecentReleases(3)` feeds `Changelog.astro` the same way (fallback: empty array, which renders no changelog entries); it over-fetches and filters out drafts and prereleases.

GitHub API calls attach an optional `GITHUB_TOKEN` (Pages env var): unauthenticated builds share 60 requests/hour per IP, which shared CI build IPs can exhaust, silently degrading release data; the token raises the limit to 5000/hour, and API error messages state GitHub's own explanation plus whether a token was present.

The recognized-mod count uses `getModIndexStats()` at build time only as a fallback.
`Features.astro` refreshes the rendered number in the browser from the R2 catalog
manifest at `https://index.modrex.net/catalog/latest.json` (URL + payload type live in
`src/lib/mod-index-shared.ts`, shared by both sides); do not make visitors or the build
download a SQLite shard just to render the count.

### Styling rules

- All colors are CSS custom properties defined in `src/styles/tokens/colors.css` via Tailwind v4's `@theme`. Never use hardcoded Tailwind color classes (`zinc-*`, `red-*`, etc.). Token names: `surface`, `surface-raised`, `surface-hover`, `surface-active`, `surface-light`, `border`, `text`, `text-muted`, `text-subtle`, `accent`, `accent-bright`, `accent-fill-hover`, `danger`, `danger-hover`, `danger-text`, `success`, `success-text`, `warning`. Tint variables (raw CSS props, not Tailwind classes): `--accent-tint-10/20/30`, `--warning-tint-10/30`, `--scrim` (modal backdrop `rgba(0,0,0,0.6)`).
- Tailwind is loaded via `@tailwindcss/vite` plugin (not `@astrojs/tailwind`).
- `tokens/fonts.css` must be imported **before** `@import 'tailwindcss'` in `global.css` to avoid PostCSS ordering errors with Google Fonts `@import url()`.
- Shared layout utilities (`.wrap`, `.btn-lg`, `.sec-head`) live in `global.css`. Component-specific styles use Astro scoped `<style>` blocks. (`.doc-prose` in `global.css` is dead CSS from the pre-Starlight docs layout — nothing references it.)
- MDX-rendered content cannot receive scoped styles from parent components — use `:global()` or add styles to `global.css` (`starlight.css` for docs pages).

**Mobile breakpoints** (defined in `global.css` for shared utilities; in component `<style>` blocks for component-specific layout):

- `768px` — nav switches to hamburger, `.wrap` padding shrinks to `16px` (docs-layout responsiveness is Starlight's own plus `starlight.css` overrides, not these breakpoints)
- `860px` / `500px` — features grid: 3-col → 2-col → 1-col
- `640px` — hero inner padding/font size reductions, download section 2-col → 1-col, gallery nav buttons switch to absolute overlays on the card edges
- `480px` — section title font size floor (`32px`)

### OS detection

Client-side OS detection is shared: `detectOs()` in `src/lib/os-detect.ts` returns `{ isMobile, isLinux }` and is imported by the three components with download buttons — `Hero.astro`, `DownloadSection.astro`, `Nav.astro`. The `isMobile` check is two-part: a UA pattern for standard mobile devices plus a `maxTouchPoints` branch for iPadOS 13+, which reports its user agent as macOS.

On mobile: no OS highlight or badge is shown, and the hero button shows a generic "Download" label. On desktop Linux: switch to Linux assets (the install command is the one-liner served by `functions/install.sh.ts`). On desktop Windows/other: default to Windows assets. Change detection logic only in `os-detect.ts`.

### Analytics & consent

`BaseLayout.astro` includes GA4 (measurement ID `G-51PXP0HVZD`) with Consent Mode v2. Analytics tracking is **denied by default** and only enabled after the user accepts via `CookieBanner.astro`.

Key constraint: ESLint's `prefer-rest-params` rule fires inside `<script is:inline>` blocks, and each block is treated as an independent scope (`no-undef` fires on bare globals from another block). The gtag function uses rest params and `window.` prefix throughout:

```js
window.gtag = function (...args) {
    window.dataLayer.push(args)
}
```

`CookieBanner.astro` stores consent in `localStorage` (`cookie_consent = 'granted' | 'denied'`) and calls `window.gtag('consent', 'update', ...)` on accept. It renders at the bottom-left corner of every `BaseLayout` page.

GA4 and the consent banner exist only on `BaseLayout` pages (`index`, `privacy`, `terms`, `404`) — Starlight docs pages load neither; their `Head` override adds structured data only.

### SEO

`astro.config.mjs` sets `site: 'https://modrex.net'` — this powers `Astro.site` and `Astro.url` throughout the app. The sitemap integration auto-generates `/sitemap-index.xml` at build time from all static routes, excluding `/privacy` and `/terms` via its `filter`.

`BaseLayout.astro` emits: `<meta name="description">`, `<link rel="canonical">`, `<meta name="theme-color">` (`#131313`, matching `--color-surface`), Open Graph tags (`og:title/description/image/image:alt/url/type/site_name/locale`), Twitter card tags (including `twitter:image:alt`), `<link rel="manifest" href="/site.webmanifest">`, and a site-wide `Organization` JSON-LD block (duplicated in the Starlight `Head` override, since docs pages never render `BaseLayout`). The default `og:image` is `/logo.png` resolved to an absolute URL via `new URL('/logo.png', Astro.site)`; `og:image:alt`/`twitter:image:alt` share the `ogImageAlt` prop (default generic, overridden on `index.astro` for the screenshot). `og:image:type` is **derived from the `ogImage` URL's extension**, not passed in — an unrecognized extension emits no type tag rather than a wrong one. No `twitter:site`/`twitter:creator` — Modrex has no X account. `BaseLayout` has a `<slot name="head" />` inside `<head>` for page-specific injections.

The shared `og:image` is generated at build time by `getOgImage()` (`src/lib/og-image.ts`): a 1200x630 JPEG cut from `browse-mods-window.png`. Never point `og:image` at a raw screenshot — the sources are ~2MB and scrapers commonly give up at that size. JPEG rather than PNG because Astro's PNG encoder does not quantize (~780kB vs ~120kB), and scrapers are the one audience with no WebP/AVIF guarantee.

`src/pages/index.astro` injects a `SoftwareApplication` JSON-LD block via `<script type="application/ld+json" is:inline set:html={...} slot="head">`. The `is:inline` directive is required when using `set:html` on a script tag.

Docs pages get their structured data from the Starlight `Head` override (`src/components/starlight/Head.astro`): a `BreadcrumbList` per docs page (section labels for `games`/`concepts`) and a `HowTo` block on `/docs/getting-started`. The starlight config `head` array injects the shared site-wide head tags on docs pages: `google-site-verification`, `apple-touch-icon`, the web manifest link, and `theme-color` (Starlight emits none of these itself, so there is no duplicate).

`public/robots.txt` allows all crawlers and points to the sitemap URL. If the domain changes, update `site` in `astro.config.mjs`, the sitemap URL in `robots.txt`, the `url`/`downloadUrl` in the JSON-LD in `index.astro`, the `Organization` blocks in `BaseLayout.astro` and `starlight/Head.astro`, and the homepage URL match in the sitemap `serialize` — they must all match.

Only the homepage carries a sitemap `lastmod`, set in the sitemap `serialize` in `astro.config.mjs`. It renders live release and mod-index data so it genuinely changes every build; stamping the build date onto the static docs pages too is the pattern search engines learn to distrust.

### Images

Screenshots are imported from `src/assets/screenshots/`, never served from `public/`. `Hero.astro`
renders them through `<Picture>` with AVIF plus a WebP fallback at the widths in `SHOT_WIDTHS`; the
first real card is `loading="eager"` with `fetchpriority="high"` and is the site's LCP element.
There is deliberately **no** `<link rel="preload">` for it: a preload without a matching
`imagesrcset`/`imagesizes` would double-download now that a srcset is in play.

`.shot-card picture` and `.viewer-card picture` need `display: block` — `<picture>` is inline by
default, which leaves a baseline gap in the card and perturbs the width the carousel measures to
compute its step stride.

### Static assets

`public/icons/` contains SVG icons for platforms (`windows`, `linux`) and launchers (`steam`, `epicgames`, `xbox`) in normal and `-white` variants (e.g. `steam-white.svg`). Use the `-white` variants in the dark-only UI. In MDX files, always use self-closing `<img />` — bare `<img>` causes an MDX parse error.

### Icons

Lucide icons via the `lucide` package (not `lucide-react`). In each component that needs icons: import `createIcons` + the specific icons, call `createIcons({ icons: { ... } })` inside a `<script>` block. Use `<i data-lucide="icon-name">` in markup. Add `display: block` to both `i` and `svg` selectors to avoid inline-element alignment issues.

### Nav mobile menu

At `≤768px`, `.nav-links` and `.nav-right` are hidden and a hamburger button appears. Clicking it toggles `.open` on `#mobile-menu`, which drops down below the nav bar with all links plus a download button. The menu closes on any link click. The mobile download button mirrors the OS detection logic from the desktop button.

### Docs (Starlight)

- `/docs/*` is rendered by `@astrojs/starlight`, configured entirely in `astro.config.mjs` — sidebar structure, code theme, component overrides, and social links all live there, not in a layout file.
- Sidebar nav is the `sidebar` array in `astro.config.mjs`: the "Games" and "Concepts" groups autogenerate from `src/content/docs/docs/games/` and `.../concepts/`; the other entries are explicit slugs. Update the array when adding/removing pages outside the autogenerated directories.
- `/docs/` is a real page (`src/content/docs/docs/index.mdx`), not a redirect — it's the docs landing page; `/docs/getting-started` is the separate install guide it links to.
- Starlight renders `h1` from `title` and the lead paragraph from `description` frontmatter — don't repeat these inside the MDX body.
- Component overrides in `src/components/starlight/`: `Header` renders the site's own `Nav` (`activePage="docs"`); `Sidebar` injects the custom client-side docs filter (`Search.astro`, a `site-search` custom element) above Starlight's sidebar internals; `DarkThemeProvider` pins docs to dark (clears `starlight-theme` from localStorage and stubs the theme-picker API); `Head` adds the structured data described under SEO, then defers to Starlight's default Head.
- Fenced code blocks go through Expressive Code with the inline `modrexCodeTheme` in `astro.config.mjs` — its hex values are deliberately duplicated from `tokens/colors.css` because Shiki themes can't reference CSS variables; keep them in sync when tokens change.
- `disable404Route: true` — the site's own `src/pages/404.astro` handles 404s for docs URLs too.
- Custom MDX components live in `src/components/docs/`: `Callout` (default `type="info"`, or `type="warning"`) plus the game-docs family (`GameFacts`, `GameSupportTable`, `LauncherMatrix`, `LauncherSupportTable`, `ModTargetsTable`, `SupportBadge`, `OsIcon`, `LauncherIcon`). Starlight's own `CardGrid`/`LinkCard` are used too. Each must be imported at the top of the MDX file that uses it.
- Yes/no table cells render `SupportBadge`, which emits an `img.shields.io` badge image (lazy-loaded). This is deliberate; `img.shields.io` is whitelisted in the `public/_headers` CSP `img-src` for it.
- The game tables/facts are driven by `src/data/docsGames.ts` (typed, per-game) — add or change game data there, not inline in MDX.
- Docs-specific styling (including responsive layout) lives in `src/styles/starlight.css`, loaded via the starlight `customCss` option.

### Hero gallery

Infinite carousel in `Hero.astro`: slots carry **two clones per edge** (`CLONES` in the frontmatter) — a wrap step travels onto the first clone and the second keeps a neighbor sliver visible beyond it (one clone left a blank viewport edge during the wrap). The script derives the real range from which card the server marked `active`, so the clone count is stated once. One `createCarousel()` factory drives both the hero track and the fullscreen viewer track. Steps are animated with the **Web Animations API, not CSS transitions** (the tracks deliberately have no `transition: transform`): the committed `style.transform` is set to the step's final position up front and the animation only overlays the travel, so a canceled/interrupted step can never strand the track mid-flight, and completion is `anim.onfinish` — a guaranteed callback, unlike `transitionend`, which is silently lost when a transition is canceled (e.g. by the ResizeObserver repositioning mid-step) or never starts. That event loss froze the gallery in the old CSS-transition design; do not reintroduce a transition on the tracks or an `animating` lock flag. When a step lands on a clone, `onfinish` teleports to the real twin via `place()` (card transitions suppressed for two frames to avoid the highlight blink); a step _started_ from a not-yet-teleported clone folds the wrap into its start position (`from ± SPAN * stride()`). There is no step lock — rapid clicks retarget the animation from the current rendered position (`getComputedStyle` + `DOMMatrixReadOnly`). Card width is `74%` on desktop (`flex: 0 0 74%`) and `88%` on mobile (`flex: 0 0 88%`); the JS reads rendered width from the DOM (`cardEls[REAL_FIRST].offsetWidth`) so no ratio is hardcoded. On mobile (`≤640px`), the nav buttons are `position: absolute` overlays centered on the left/right edges of the active card (`left/right: 6%` — derived from `(100% - 88%) / 2`).

## Local Pages Function testing

```bash
pnpm build && npx wrangler pages dev dist   # serves /api/collect and /install.sh locally
curl -fsSL http://localhost:8788/install.sh | sh -n   # syntax-check the assembled script without running it
```

`astro check` and `pnpm typecheck` do not cover `functions/` — TypeScript errors there are only caught at deploy time or via manual `tsc` invocation.

## Rules

- The site is deployed on **Cloudflare Pages** (not GitHub Pages). If a Jekyll/GitHub Pages build failure appears in CI, it can be ignored or GitHub Pages can be disabled in repo settings.
