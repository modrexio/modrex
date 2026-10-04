# modrex-site

Marketing and documentation site for [Modrex](https://github.com/modrexio/modrex) at [modrex.net](https://modrex.net). Built with Astro 6, deployed automatically to Cloudflare Pages on every push to `main`.

## Development

```bash
bun install
bun dev        # Start dev server at localhost:4321
bun run build      # Static build to dist/
bun typecheck  # Type-check .astro and .ts files
bun lint       # ESLint
bun format     # Prettier
```

## Stack

Astro 6 · Tailwind CSS v4 · Cloudflare Pages

## Structure

```
src/pages/         ← routes
src/components/    ← Astro components
src/content/docs/  ← MDX documentation pages
src/lib/           ← Build-time data fetching (GitHub Releases API, mod index stats)
functions/         ← Cloudflare Pages Functions (analytics proxy at /api/collect)
```

## Deployment

Cloudflare Pages deploys automatically on every push to `main` — no manual step needed. The `functions/` directory is picked up by Cloudflare's own build step alongside the static output.
