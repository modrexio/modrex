# Public contracts

Five things outside this repository resolve URLs or artifacts that this repository produces. Each
one below has clients that cannot be updated, so the commitment is permanent rather than a
current convention.

## Installed desktop clients

**Bare `vX.Y.Z` tags are desktop releases, and the updater manifest stays reachable at
`https://github.com/modrexio/modrex/releases/latest/download/latest.json`.**

Every installed copy of Modrex polls that URL and verifies what it downloads against a key
compiled into the application. A tag scheme change, a repository move or a release-asset rename
strands every client that cannot reach the new location, because the old one is the only address
they have.

## Desktop versions through 0.12.2

**`modrexio/modrex-index` stays an independent producer of the `latest-index` release, with its
game set and exported schema frozen.**

Those versions fetch
`https://github.com/modrexio/modrex-index/releases/download/latest-index/index.db` and understand
only the schema they shipped with. The current pipeline is separate: it builds in Neon, publishes
per-game SQLite snapshots to R2 at `index.modrex.net`, and the site reads aggregate figures from
`catalog/latest.json`. This repository never publishes a legacy index asset, and the legacy
release never changes shape.

## The Linux install script

**`install.config.json` stays at the repository root**, so
`https://raw.githubusercontent.com/modrexio/modrex/main/install.config.json` keeps resolving.

**`modrexio/mget` stays an independent repository and tag host.** It is a general install engine
used by projects other than Modrex, and `modrex.net/install.sh` is assembled from a pinned `mget`
tag plus that configuration file. Absorbing `mget` here would break the projects that pin it.

## The site's runtime routes

**`modrex.net`, `modrex.net/install.sh` and `modrex.net/api/collect` stay available.**

The first two are how Linux users install and reinstall. The third is the proxy the desktop
application posts opt-in analytics through, and a client that cannot reach it has no fallback
path, so removing the route would fail silently in every installed copy.

These are Cloudflare Pages Functions served from `apps/site/functions/`, which requires the Pages
project root to stay `apps/site`.

## Changing any of this

Adding a new address is free. Moving or removing an existing one is not, because the clients that
depend on it are already installed and will not learn about the change. Treat a change to
anything above as a compatibility break that needs its own plan, not as a refactor.
