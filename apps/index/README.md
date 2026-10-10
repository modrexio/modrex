# modrex-index

SHA256 hash index of mods on [modworkshop](https://modworkshop.net) for PAYDAY 3, PAYDAY 2, PAYDAY: The Heist, Crime Boss: Rockay City, and RAID: World War II, used by [modrex](https://github.com/modrexio/modrex) to identify manually placed mod files.

## How it works

The current production workflow uses Neon Postgres as its resumable source of truth. It
syncs listings for all five games, downloads and hashes relevant content
(`.pak`/`.ucas`/`.utoc` for PD3/Crime Boss, `.lua` for UE4SS sub-mods, a marker file for
PD2/PDTH/RAID, and the first resolved asset for PDTH `.pdmod` files), then exports
per-game SQLite snapshots.

Changed snapshots are uploaded under immutable generation keys in the `modrex-index` R2
bucket. `https://index.modrex.net/catalog/latest.json` is atomically updated last and
tells the site and new desktop versions which snapshot belongs to each game. SQLite is
never committed to git, and clients still query it locally and offline.

The independent [modrex-index](https://github.com/modrexio/modrex-index) repository
continues to publish its monolithic GitHub Release database only for desktop versions
through 0.12.2. It is not fed by this pipeline and does not receive new games.

## Running locally

```bash
bun install
bun index:build
bun index:build --concurrency=10
bun index:test
```
