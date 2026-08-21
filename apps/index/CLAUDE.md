# CLAUDE.md

Read the root `CLAUDE.md` before this file. This package is part of the Modrex monorepo.

## What this is

TypeScript build pipeline for PD2, PDTH, PD3, Crime Boss: Rockay City, and RAID: World
War II. The current production path syncs listings and extracted content into Neon
Postgres, exports immutable per-game SQLite snapshots, and publishes them to R2 at
`index.modrex.net`. The desktop app downloads those snapshots locally and queries them
offline.

`modrexio/modrex-index` permanently owns the separate legacy production pipeline and its
`latest-index` release for desktop versions through 0.12.2. It remains independent; this
workspace never publishes legacy assets.

## Commands

```bash
pnpm install
pnpm index:build                         # Build index.db for all games
pnpm index:build -- --concurrency=10    # Higher concurrency (careful: rate limits)
pnpm index:test                          # Checkpoint/recovery test with a local mock API
node check-pak.mjs <path>               # Inspect a single .pak file (reads local app DB, not index.db)
node check-index.mjs                    # Stats + duplicate summary (reads local app DB, not index.db)
node lookup-mod.mjs <name-or-id>        # Look up a mod by name or remote_id (reads local app DB)
```

> The three `*.mjs` dev utils hardcode a path to the installed app's cached DB (`C:/Users/oleh/AppData/…`). To query a freshly built `index.db` instead, edit the `APP_DB` constant at the top of each file.

`7z` must be on `PATH` — used for 7z and RAR extraction and `.pdmod` decryption. Windows: install from 7-zip.org. Ubuntu CI: `apps/index/scripts/install-7zip.sh`, run by both Postgres workflows before any archive work. Ubuntu's packaged 7-Zip 23.01 (what `p7zip-full`/`p7zip-rar` resolve to on Noble) segfaults decompressing valid RAR4 archives; RAR5/ZIP/7z are unaffected. The script pins upstream 7-Zip 26.02 instead, verifying its checksum and its resolved `--help` banner before adding it ahead of the distro binary on `PATH`. A RAR4 download that still fails extraction is a checked listing with no files; `markerFromFullArchive` logs each archive it could not open. `apps/index/test-archive-canaries.ts` (`pnpm test:archive-canaries`) proves the fix against two real ModWorkshop RAR4 archives that crash the distro binary; it needs network and the pinned extractor, so it runs on demand rather than as part of `index:test`.

## Architecture

```
build-index.ts    ← main build script (TypeScript, run via tsx)
check-pak.mjs     ← dev util: inspect a single .pak file
check-index.mjs   ← dev util: query the built index.db
lookup-mod.mjs    ← dev util: look up a mod by SHA256
```

### SQLite schema

```sql
games         (id, name, slug)                                      -- "PAYDAY 3"/"pd3", "PAYDAY 2"/"pd2", "PAYDAY: The Heist"/"pdth", "Crime Boss: Rockay City"/"cb", "RAID: World War II"/"raid"
sources       (id, game_id, name, base_url, game_ref)               -- modworkshop source per game
mods          (id, source_id, remote_id, name, url)                 -- one row per mod
file_contents (sha256)                                              -- deduplication; sha256 is PK
files         (id, mod_id, remote_id, version, sha256, entry_name)  -- one row per hashed file; sha256 FK → file_contents
metadata      (key, value)                                          -- last_run_at timestamp
```

`entry_name` is the file's path inside its archive (forward slashes; the download's filename for bare files). Rows indexed before the column existed hold `''` — run `pnpm build-index -- --backfill` once to fill them (it re-downloads only files whose rows lack names). `modrex-main` uses it to list a mod's full pak set for the reinstall-missing-files UI.

`modrex-main` queries via `files → mods → sources → games` filtered by `games.name`. Cross-game isolation is enforced: a PD2 SHA256 never matches a PD3 mod. The `games.name` string is load-bearing, not cosmetic — it must match `modrex-main`'s `ModEngineConfig.index_game_name` exactly (e.g. Crime Boss's row is `"Crime Boss: Rockay City"`, matching `CRIMEBOSS_ENGINE.index_game_name`).

### Legacy workflow

The legacy production workflow lives in the independent `modrexio/modrex-index` repository. Its five-minute scheduler remains responsible for the frozen legacy game set and release assets consumed by desktop versions through 0.12.2. Do not add a legacy release workflow to this workspace.

### Postgres and R2 workflow

`.github/workflows/refresh-postgres-index.yml` is externally dispatched every 30 minutes.
It applies idempotent migrations, syncs listings, processes pending archive content,
exports only changed per-game SQLite shards, uploads immutable generation keys to R2, and
atomically updates `catalog/latest.json`. The manual migration, sync, process, export,
and publish workflows remain available for recovery and diagnosis. They need
`INDEX_DATABASE_URL` plus the R2 credentials configured as repository secrets.

**Which game a `game: auto` run processes** is decided by `postgres/select-game.ts` over the pure rule in `postgres/game-schedule.ts`; `report-coverage.ts` only reports. A run processes one game, so this decides which games stay indexable at all. Candidates (`pending > 0`) rank in three tiers: never selected, then gone `SERVICE_CEILING` turns without service, then largest raw `pending`. The middle tier is the point — `pending` counts deferred listings, so a game whose off-site links are permanently dead ranks high forever, and a plain largest-pending rule pins the scheduler to it (production, 2026-08-16: pd2's 27 dead links held the selector for 19 consecutive runs while a new PD3 listing went unprocessed). What the ceiling guarantees is a **processing opportunity within `SERVICE_CEILING + GAME_IDS.length - 1` auto-selection runs** — not successful indexing, and not a wall-clock bound, since the 30-minute cadence comes from an external dispatcher. A game keeps `1 - (GAME_IDS.length - 1) / (SERVICE_CEILING + 1)` of the turns only for as long as it stays the largest pending count; comparable backlogs self-balance through the greedy tier instead. `pnpm test:game-schedule` asserts both.

Each selection persists `content_last_turn:<slug>` in `metadata` **before** processing, so a failed run spends the turn it was granted rather than letting a game whose processing keeps failing hold the queue. Only `game: auto` writes it: explicit `game:` dispatches and the standalone `Process Postgres index content` workflow do not, which at worst costs a later redundant auto turn. Making `pending` exclude not-yet-due deferrals is a separate change and is not what this scheduler does.

**Legacy builder run modes** (CLI flags):

- _default_ — incremental and **time-windowed**: `listModsSince(lastRunAt)` only examines mods updated since the previous run, and skips files already in `files`.
- `--backfill` — scans **all** mods (`since = null`), skipping already-indexed files and mods whose `mod_checks` state is current (see builder state below). Cheap to re-run: a backfill where nothing changed costs roughly the listing pages (~10 min), not the historical ~2 h.
- `--recheck-all` — ignores `mod_checks` entirely; every listed mod is re-examined (the pre-check-state backfill cost). **Required after a coverage change to an existing game** (a new archive format or raising `PD2_MAX_FULL_DOWNLOAD_BYTES`): a plain backfill skips checked mods, so previously-skipped files only get picked up by `--backfill --recheck-all`. Also the escape hatch if a mod was wrongly memoized (corrupt download recorded as zero-yield, or a mod change that didn't touch its `updated_at`).
- `--backfill --game=<id>` — scans every historical listing for one game only.
- `--repair-versions` — rewrites the `version` column from the listings; no downloads.

The `--staged-rebuild`, `--max-runtime-minutes`, and `--finalize-rebuild` flags are
legacy workflow plumbing. Do not use them for an ordinary local build.

### Builder state (`builder-state.db`)

A second SQLite DB published as its own asset on the same `latest-index` release — CI bookkeeping only, never downloaded by the app. One table: `mod_checks(source_id, remote_id, updated_at, file_ids, checked_at)` — per mod, the listing `updated_at` it was last fully processed at and which file remote_ids that pass yielded. A mod is skipped (zero API calls, zero downloads) when its listing `updated_at` matches the recorded one **and** every recorded file id is still present in `files` — the second condition means a stale `index.db` restored from the release CDN can never be masked by newer check state (state only accelerates; `index.db` stays authoritative). Checks are recorded only for mods that processed without errors, so failures stay retryable. Kept out of `index.db` deliberately: zero-yield mods must never become `mods` rows, because `modrex-main`'s `query_by_name` identifies a mod only when exactly one `LIKE` match exists — bloating `mods` with unindexable entries would silently break name-based identification in the app. The workflow's download of it is best-effort (missing/corrupt state degrades to a full recheck, never a failed job) and it's uploaded on exit 0 and 2 alike, so check state advances even on no-new-files runs.

PD3 and Crime Boss are both UE pak-based with no marker-file shortcut available, so they share one extraction path (`buildContentTasks`, parameterized per game): the whole archive is downloaded and `extractContentEntries` pulls out every entry matching `CONTENT_EXTENSIONS` (`.pak`, `.ucas`, `.utoc`, `.lua`) — not just `.pak`. `.ucas`/`.utoc` are UE IoStore's other two pieces of a mod's cooked content (present for nearly every Crime Boss mod, less often for PD3); `.lua` is a UE4SS Lua sub-mod's script entry point, added so `modrex-main`'s ambient scan can eventually identify standalone UE4SS sub-mods by SHA256 the same way it identifies `.pak` mods. **Known caveat**: this path indexes only entries matching `CONTENT_EXTENSIONS`, while `modrex-main`'s `hashable_file_for_mod_dir` hashes whichever file its own rule selects. For a UE4SS sub-mod shaped exactly like `Scripts/main.lua` with nothing else at the root the two agree, but a sub-mod carrying a root-level file that sorts before `Scripts` and is not an indexed extension gets hashed on that file and matches nothing here. The ordering halves of the two rules agree (see the marker contract below); the extension filter is what still differs.

`detectFormat` also recognizes RAR by magic bytes (`Rar!\x1a\x07`) for this path — found missing after a live backfill showed several real Crime Boss mods (e.g. character cosmetic mods distributed as `.rar`) silently produced zero indexed files: `shouldDownload` didn't recognize the `"rar"` modworkshop file type at all, so the file was skipped before download ever started. Both gaps are fixed (`shouldDownload` now includes `rar`; the RAR branch shells out to the same `7z` CLI `extractPd2FromFull` already uses for PD2/PDTH, extracting everything and filtering by `CONTENT_EXTENSIONS` in JS rather than relying on 7z's RAR mask support, which is less reliable than for zip/7z). **Verify after the next backfill**: a real RAR-only mod (e.g. modworkshop id `56889`, "Hideo Kojima") should go from 0 indexed files to its expected count.

PD2/PDTH/RAID mods aren't `.pak` — for them the indexer hashes one representative marker file per mod (`mod.txt` / `main.xml` / `supermod.xml` / `mod.xml` / wrapper-relative first file via `chooseMarker`, chosen to match `modrex-main`'s `hashable_file_for_mod_dir`). **The marker-less fallback is a cross-language contract**: both sides take the path whose UTF-8 bytes sort first, never a locale-aware comparison and never directory-walk order, and both run the vectors in `marker-contract.json` as a test (`pnpm test:marker-contract` here, `marker_contract_tests.rs` there). Changing the ordering on one side alone makes a class of mods unidentifiable, and migration `004_recheck_markerless_picks` is what re-processes rows chosen under the old order. `supermod.xml` (RAID-SuperBLT) and `mod.xml` (legacy RaidBLT) are RAID's markers — the RAID BLT fork has no `mod.txt`; they sit below the PD2/PDTH markers in the preference order so archives shipping both keep their existing pick. ZIPs use HTTP Range to fetch only that file; RAR/7z have no such trick, so they're fully downloaded and gated by `PD2_MAX_FULL_DOWNLOAD_BYTES` (50 MB) — larger ones are skipped. This is what lets `modrex-main` identify marker-less asset/background packs (incl. recovered host packs) by SHA256.

**Link-hosted downloads** (marker games only, `process-content.ts`): a ModWorkshop mod can publish its download as a link to another host — GitHub source or release archives, GitLab raw, the author's own update server — instead of a file ModWorkshop stores, and then `/mods/{id}/files` comes back **empty**. That is ~8% of PD2's downloadable listings, and without a `mods` row `modrex-main` can never identify a copy of one on disk (neither SHA256 nor name, since `query_by_name` joins `files`). When a listing's hosted files yield nothing, the processor falls back to `/mods/{id}/links` and extracts through the same marker path.

`files.remote_id` therefore holds **either a ModWorkshop file id (positive) or a negated ModWorkshop link id**. The negation is load-bearing, not cosmetic: ModWorkshop numbers links in their own sequence, so a link id can equal an unrelated mod's file id, and `modrex-main`'s `findSuspectDuplicateGroups` (`installedUtils.ts`) groups installed mods by file id **game-wide**, which only holds while the ids are unique across the game. Disjoint ranges keep that true and mark the row as "no downloadable ModWorkshop file" at the same time.

**An off-site link is optional content, and the processor's exit code says so.** Every download ends either with an answer or without one, and `marker-archive.ts` reports which through two exported errors: `UnusableDownloadError` for an answer the file itself produced and that cannot become an entry (a blocked address, 400/401/404/405/410/415/416/451, a redirect loop, a `text/html` page where an archive should be, an archive holding no marker) and `TransientFetchError` for everything else. The transient side is deliberately wide: 408/425/429/5xx, every transport failure including DNS and certificate errors, and 403 and 406, which are what an anti-abuse layer in front of a host says while it is throttling — GitLab answers archive requests with 406 once an address has pulled enough of them and serves the same URL to the same client minutes later. Only a status the file itself produces settles a listing, because recording an empty check on a throttle would lose the mod until a migration re-opened it. `process-content.ts` records the listing's check once every download has been answered — including when the answer is that there is nothing to index — and leaves it unrecorded only when something is still pending, so a permanently unreadable link stops being selected instead of being retried forever. Neither kind fails the run. What still does is a Postgres error, a ModWorkshop API error other than a 404 on `/files` (every listing goes through that API before any download, so a real outage surfaces there), and any error that is neither of the two classes. `test-process-failure.ts` holds that exit-code contract and `test-marker-archive.ts` holds the classification.

Links are followed only for the marker games: that extractor reads a few hundred kilobytes over Range and gives up on anything that isn't an archive, so an author-supplied URL stays bounded and self-validating — the whole-archive path PD3/Crime Boss use is not, so a link on those games is still skipped. `extractMarkerEntry` falls back to reading the whole archive for hosts that build it per request (GitHub's `archive/refs/heads/*.zip` sends neither a length nor byte ranges), capped by the same 50 MB limit and abandoned mid-stream once it's passed.

**A link URL is attacker-chosen input** and this worker runs in CI beside the index database and R2 credentials, so `marker-archive.ts` owns the network boundary: `request` follows redirects itself and runs `assertFetchableUrl` on the original URL **and every hop** (https only outside loopback, so a redirect from `https:` to `http:` is refused at the hop that would downgrade it; loopback, RFC1918, unique-local, link-local and the metadata address refused, by literal and by one DNS resolution), capped at 5 hops. What it deliberately does not do is pin the resolved address, so a name that resolves public here and private inside `fetch` is still possible — worth revisiting only if this ever moves to a self-hosted runner. Inflating a marker entry is capped at the same 50 MB (deflate reaches ~1000x on repetitive data, so an uncapped entry turns a few hundred KB of download into tens of GB of heap). A blocked URL, including a plain `http:` one, yields nothing rather than throwing, so one hostile mod page cannot fail the run. `MODREX_INDEX_ALLOW_LOOPBACK_FETCH=1` lifts **only** the loopback range, including its scheme, and exists so `test-marker-archive.ts` can serve fixtures from 127.0.0.1; nothing in CI or the workflow sets it. Covered by `test-marker-archive.ts` (`pnpm test:marker-archive`), which asserts the blocked ranges and the https-only policy in a second process that does not set the variable.

Migration `003_recheck_empty_listings` deletes `mod_checks` rows whose pass yielded no files, which is what lets the already-checked backlog of link-hosted mods be picked up — checks are otherwise skipped until ModWorkshop bumps a listing's `updated_at`. It re-checks a few thousand listings once, at `--limit` per run; dispatch the workflow with a high limit to drain it faster. A listing that reaches the same empty result again is recorded empty again, so any later widening of what this pipeline can read needs its own migration to re-open that set, the way 003 and 004 did.

PDTH additionally handles `.pdmod` files: decrypted via `7z` with a hardcoded password, then the `pdmod.json` manifest's `BundlePath`/`BundleExtension` uint64 fields are resolved against `pdmod_hashlist.txt` (committed, 130k entries, Bob Jenkins lookup8) to recover asset paths — the alphabetically-first resolved path's replacement file is hashed. `pdmod_hashlist.txt` must stay committed; without it all `.pdmod` mods produce zero indexed files.

## Agent skills

Reusable skills live in `.agents/skills/` at the workspace root (`C:\local\modrexio`).

- `/commit modrex-main` — read the current diff and propose a conventional commit message; waits for confirmation before committing.
- `/deslop modrex-main` — audit the diff for AI-generated slop and fix each issue found.

## Rules

- Commit messages must follow conventional commits: `type(scope): subject`
- Never run any git command that touches the remote. Write out the commands for the user to run.
- Never run `git commit` unless explicitly asked.
