#!/usr/bin/env npx tsx
/**
 * Builds the PD3 + PD2 + PDTH + Crime Boss + RAID WW2 mod hash index from modworkshop
 * directly into SQLite.
 *
 * Run:   pnpm build-index
 * Output: index.db
 *
 * Resumable: already-indexed fileIds are skipped on re-run.
 * PD3 / Crime Boss: streams each download directly into SHA256, extracting .pak/.ucas/.utoc
 *      (UE5 IoStore content) and .lua (UE4SS Lua sub-mods). No temp files needed for ZIP.
 * PD2 / PDTH / RAID: uses HTTP Range requests on ZIP archives to fetch only the marker file
 *      (mod.txt / main.xml / supermod.xml / mod.xml / first alphabetical file) without
 *      downloading the full archive.
 *      RAR and 7z archives under 50 MB are fully downloaded and extracted via the 7z CLI.
 * Downloads CONCURRENCY files in parallel to cut total runtime.
 */

import Database, { type Database as DB } from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { createHash } from 'crypto'
import { inflateRawSync } from 'zlib'
import { join } from 'path'
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { GAME_IDS, GAMES, type GameId } from '@modrex/games'

const BASE = process.env.MODWORKSHOP_API_BASE ?? 'https://api.modworkshop.net'
const USER_AGENT = 'modrex-indexer/1.0'
const OUTPUT_DIR = process.env.MODREX_INDEX_OUTPUT_DIR ?? import.meta.dirname
const DB_PATH = join(OUTPUT_DIR, 'index.db')
const STATE_DB_PATH = join(OUTPUT_DIR, 'builder-state.db')
const STATS_PATH = join(OUTPUT_DIR, 'index-stats.json')
// Faster than full_rebuild when adding a new format: only unindexed files are downloaded.
const BACKFILL = process.argv.includes('--backfill')
// Patches only the version column on existing rows from the listings, with no downloads and no
// extraction. Lets a stale-version index be corrected in minutes instead of a full backfill.
const REPAIR_VERSIONS = process.argv.includes('--repair-versions')
// Ignores recorded per-mod check state, so every listed mod is re-examined (the pre-check-state
// backfill cost). Escape hatch for the cases a check can wrongly suppress: a corrupt download
// recorded as zero-yield, or a mod change that didn't touch its updated_at.
const RECHECK_ALL = process.argv.includes('--recheck-all')
const STAGED_REBUILD = process.argv.includes('--staged-rebuild')
const FINALIZE_REBUILD = process.argv.includes('--finalize-rebuild')
const SELECTED_GAME = process.argv.find((a) => a.startsWith('--game='))?.split('=')[1] ?? null
const VALID_GAMES = GAME_IDS
type GameSlug = GameId
const MAX_RUNTIME_MINUTES = parseFloat(
    process.argv.find((a) => a.startsWith('--max-runtime-minutes='))?.split('=')[1] ?? '0'
)
const CONCURRENCY = parseInt(
    process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ??
        (BACKFILL ? '10' : '5')
)
// modworkshop meters api.modworkshop.net at 90 req/min per IP (x-ratelimit-limit header).
// We reserve one slot every ~706 ms (~85/min) so all workers share a single safe pace and
// never trip a 429. storage.modworkshop.net is unmetered and bypasses this throttle.
const API_RATE_PER_MIN = 85
const API_MIN_INTERVAL_MS = Math.ceil(60_000 / API_RATE_PER_MIN)
let apiNextSlot = 0
// RAR and 7z archives larger than this are skipped for PD2: they have no efficient marker
// extraction (unlike ZIP's Range trick), so the whole archive must be downloaded. The cap bounds
// per-file CI cost; downloads are incremental so raising it drains the newly-eligible backlog
// over successive hourly runs. 50 MB covers most asset/background packs (e.g. menu backgrounds).
const PD2_MAX_FULL_DOWNLOAD_BYTES = 50 * 1_024 * 1_024

// --- run metrics ---

// Runtime is dominated by throttled API calls (~706 ms each, serialized across all
// workers), so the call count is the number that explains a slow run. Storage
// requests are unmetered and parallel, tracked to show where download time went.
const metrics = {
    apiCalls: 0,
    storageRequests: 0,
    storageBytes: 0,
    checkSkips: 0,
    phases: [] as { name: string; seconds: number }[],
}

function timePhase<T>(name: string, run: () => Promise<T>): Promise<T> {
    const start = Date.now()
    return run().finally(() => {
        metrics.phases.push({ name, seconds: Math.round((Date.now() - start) / 1000) })
    })
}

function writeRunSummary(
    mode: string,
    newFiles: number,
    filledNames: number,
    errorCount: number
): void {
    const phases = metrics.phases.map((p) => `${p.name} ${p.seconds}s`).join(', ')
    const mb = (metrics.storageBytes / 1_048_576).toFixed(0)
    const text =
        `Run summary (${mode}): ${metrics.apiCalls} API calls, ` +
        `${metrics.storageRequests} storage requests (${mb} MB), ` +
        `${metrics.checkSkips} mods skipped via check state, ` +
        `${newFiles} new files, ${filledNames} names filled, ${errorCount} errors\n` +
        `Phases: ${phases}`
    console.log(`\n${text}`)
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
            process.env.GITHUB_STEP_SUMMARY,
            `### Index build (${mode})\n\n` +
                `| API calls | Storage requests | Downloaded | Check skips | New files | Names filled | Errors |\n` +
                `|---|---|---|---|---|---|---|\n` +
                `| ${metrics.apiCalls} | ${metrics.storageRequests} | ${mb} MB | ${metrics.checkSkips} | ${newFiles} | ${filledNames} | ${errorCount} |\n\n` +
                `Phases: ${phases}\n`
        )
    }
}

// --- types ---

interface Mod {
    id: number
    name: string
    version: string
    has_download: boolean
    bumped_at: string
    // Touched by any edit to the mod, and more sensitive than bumped_at (verified live).
    // what a mod_checks row is keyed against to decide "nothing changed, skip".
    updated_at: string
    // The listing carries the primary download inline, so no per-mod /files call is needed.
    // download_type is 'file' (hosted), 'link' (external), or null (none).
    download_id: number | null
    download_type: string | null
}

interface ModFile {
    id: number
    version: string
    download_url: string
    type: string
    updated_at: string
}

interface Paginated<T> {
    data: T[]
    meta: { current_page: number; last_page: number }
}

interface IndexStats {
    supportedMods: number
    generatedAt: string
    // The incremental window, carried here because index-stats.json is uploaded on every
    // run, a no-op run skips the index.db upload and would otherwise lose the
    // advanced last_run_at written into the discarded DB, re-scanning the same window
    // (and re-downloading its zero-yield mods) until some other mod triggered an upload.
    lastRunAt: string | null
}

const SUPPORTED_MODS_SQL = `
    SELECT COUNT(DISTINCT m.id) AS supported_mods
    FROM mods m
    JOIN files f ON f.mod_id = m.id
`

// --- schema ---

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sources (
    id       INTEGER PRIMARY KEY,
    game_id  INTEGER NOT NULL REFERENCES games(id),
    name     TEXT NOT NULL,
    base_url TEXT NOT NULL,
    game_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mods (
    id        INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    remote_id INTEGER NOT NULL,
    name      TEXT NOT NULL,
    url       TEXT NOT NULL,
    UNIQUE(source_id, remote_id)
);

CREATE TABLE IF NOT EXISTS file_contents (
    sha256 TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS files (
    id         INTEGER PRIMARY KEY,
    mod_id     INTEGER NOT NULL REFERENCES mods(id),
    sha256     TEXT NOT NULL REFERENCES file_contents(sha256),
    remote_id  INTEGER NOT NULL,
    version    TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    entry_name TEXT NOT NULL DEFAULT '',
    UNIQUE(mod_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);

CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`

// --- db setup ---

function openDb(): {
    db: DB
    pd3SourceId: number
    pd2SourceId: number
    pdthSourceId: number
    cbSourceId: number
    raidSourceId: number
} {
    const db = new Database(DB_PATH)
    db.exec(SCHEMA)

    // CI builds are incremental over the previous release's db, so CREATE TABLE IF
    // NOT EXISTS won't add columns to it, so migrate explicitly.
    const fileColumns = db.prepare('PRAGMA table_info(files)').all() as { name: string }[]
    if (!fileColumns.some((c) => c.name === 'entry_name')) {
        db.exec("ALTER TABLE files ADD COLUMN entry_name TEXT NOT NULL DEFAULT ''")
    }

    const upsertGame = db.prepare('INSERT OR IGNORE INTO games (name, slug) VALUES (?, ?)')
    const getGame = db.prepare('SELECT id FROM games WHERE slug = ?')
    const upsertSource = db.prepare(
        'INSERT OR IGNORE INTO sources (game_id, name, base_url, game_ref) VALUES (?, ?, ?, ?)'
    )
    const getSource = db.prepare('SELECT id FROM sources WHERE game_id = ? AND name = ?')

    upsertGame.run(GAMES.pd3.name, 'pd3')
    const pd3Game = getGame.get('pd3') as { id: number }
    upsertSource.run(pd3Game.id, 'modworkshop', BASE, String(GAMES.pd3.workshopId))
    const pd3Source = getSource.get(pd3Game.id, 'modworkshop') as { id: number }

    upsertGame.run(GAMES.pd2.name, 'pd2')
    const pd2Game = getGame.get('pd2') as { id: number }
    upsertSource.run(pd2Game.id, 'modworkshop', BASE, String(GAMES.pd2.workshopId))
    const pd2Source = getSource.get(pd2Game.id, 'modworkshop') as { id: number }

    upsertGame.run(GAMES.pdth.name, 'pdth')
    const pdthGame = getGame.get('pdth') as { id: number }
    upsertSource.run(pdthGame.id, 'modworkshop', BASE, String(GAMES.pdth.workshopId))
    const pdthSource = getSource.get(pdthGame.id, 'modworkshop') as { id: number }

    // Slug and name match CRIMEBOSS_ENGINE.index_game_name exactly. The desktop app
    // joins files -> mods -> sources -> games filtered by games.name, so this string is load-
    // bearing, not cosmetic.
    upsertGame.run(GAMES.cb.name, 'cb')
    const cbGame = getGame.get('cb') as { id: number }
    upsertSource.run(cbGame.id, 'modworkshop', BASE, String(GAMES.cb.workshopId))
    const cbSource = getSource.get(cbGame.id, 'modworkshop') as { id: number }

    // Name matches RAID_ENGINE.index_game_name, which is load-bearing. See above.
    upsertGame.run(GAMES.raid.name, 'raid')
    const raidGame = getGame.get('raid') as { id: number }
    upsertSource.run(raidGame.id, 'modworkshop', BASE, String(GAMES.raid.workshopId))
    const raidSource = getSource.get(raidGame.id, 'modworkshop') as { id: number }

    return {
        db,
        pd3SourceId: pd3Source.id,
        pd2SourceId: pd2Source.id,
        pdthSourceId: pdthSource.id,
        cbSourceId: cbSource.id,
        raidSourceId: raidSource.id,
    }
}

// --- builder state (CI-only, published as its own release asset) ---
//
// Records, per mod, the listing updated_at it was last fully processed at and which file
// remote_ids that pass yielded. Lives outside index.db so the user-facing DB carries no
// CI bookkeeping, and so modrex-main's name-based identification (query_by_name, which
// requires exactly one LIKE match over mods) never sees rows for zero-yield mods.
// The state only ever accelerates a build: missing or stale state degrades to a full
// recheck, never to wrong index content.

interface ModCheck {
    updatedAt: string
    fileIds: number[]
}

function openStateDb(): DB {
    const db = new Database(STATE_DB_PATH)
    db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS mod_checks (
    source_id  INTEGER NOT NULL,
    remote_id  INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    file_ids   TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (source_id, remote_id)
);`)
    return db
}

function loadModChecks(stateDb: DB, sourceId: number): Map<number, ModCheck> {
    const rows = stateDb
        .prepare('SELECT remote_id, updated_at, file_ids FROM mod_checks WHERE source_id = ?')
        .all(sourceId) as { remote_id: number; updated_at: string; file_ids: string }[]
    return new Map(
        rows.map((r) => [r.remote_id, { updatedAt: r.updated_at, fileIds: JSON.parse(r.file_ids) }])
    )
}

// A check only suppresses re-processing while index.db still contains everything it yielded.
// If index.db was restored from an older copy than the state db (release CDN staleness), the
// yielded ids will not all be present and the mod is re-processed. index.db stays authoritative.
function checkIsCurrent(
    check: ModCheck | undefined,
    mod: Mod,
    indexedFileIds: Set<number>,
    missingNameFileIds: Set<number>
): boolean {
    if (!check || check.updatedAt !== mod.updated_at) return false
    return check.fileIds.every((id) => indexedFileIds.has(id) && !missingNameFileIds.has(id))
}

function writeIndexStats(db: DB, lastRunAt: string | null): IndexStats {
    const row = db.prepare(SUPPORTED_MODS_SQL).get() as { supported_mods: number }
    const stats: IndexStats = {
        supportedMods: row.supported_mods,
        generatedAt: new Date().toISOString(),
        lastRunAt,
    }
    writeFileSync(STATS_PATH, `${JSON.stringify(stats, null, 2)}\n`)
    return stats
}

function readPreviousLastRunAt(): Date | null {
    if (!existsSync(STATS_PATH)) return null
    try {
        const raw = JSON.parse(readFileSync(STATS_PATH, 'utf-8')) as { lastRunAt?: string | null }
        return raw.lastRunAt ? new Date(raw.lastRunAt) : null
    } catch (e) {
        console.warn(`  [stats] previous index-stats.json unreadable (${e}) — using DB last_run_at`)
        return null
    }
}

// Scope indexed file IDs to a specific source so PD2 and PD3 remote_ids never collide.
function getIndexedFileIds(db: DB, sourceId: number): Set<number> {
    const rows = db
        .prepare(
            'SELECT f.remote_id FROM files f JOIN mods m ON m.id = f.mod_id WHERE m.source_id = ?'
        )
        .all(sourceId) as { remote_id: number }[]
    return new Set(rows.map((r) => r.remote_id))
}

function getFileIdsMissingNames(db: DB, sourceId: number): Set<number> {
    const rows = db
        .prepare(
            "SELECT DISTINCT f.remote_id FROM files f JOIN mods m ON m.id = f.mod_id WHERE m.source_id = ? AND f.entry_name = ''"
        )
        .all(sourceId) as { remote_id: number }[]
    return new Set(rows.map((r) => r.remote_id))
}

// Remote mod IDs that already have at least one indexed file. Used to skip the
// /files fallback for mods whose listing carries no download_id on re-runs.
function getIndexedModIds(db: DB, sourceId: number): Set<number> {
    const rows = db
        .prepare(
            'SELECT DISTINCT m.remote_id FROM mods m JOIN files f ON f.mod_id = m.id WHERE m.source_id = ?'
        )
        .all(sourceId) as { remote_id: number }[]
    return new Set(rows.map((r) => r.remote_id))
}

// --- API ---

// Reserve the next api.modworkshop.net slot, spacing calls to stay under the 90/min cap.
async function apiThrottle(): Promise<void> {
    metrics.apiCalls++
    const now = Date.now()
    const slot = Math.max(now, apiNextSlot)
    apiNextSlot = slot + API_MIN_INTERVAL_MS
    if (slot > now) await delay(slot - now)
}

async function apiGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${BASE}${path}`)
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v != null) url.searchParams.set(k, String(v))
        }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
        await apiThrottle()
        let res: Response
        try {
            res = await fetch(url, {
                headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
                signal: AbortSignal.timeout(30_000),
            })
        } catch (e) {
            if (attempt < 4) {
                const wait = 2_000 * 2 ** attempt
                console.warn(`  [network error] ${path} — retrying in ${wait}ms`)
                await delay(wait)
                continue
            }
            throw e
        }
        if (res.status === 408 || res.status === 429 || res.status >= 500) {
            if (attempt < 4) {
                const retryAfter = Number(res.headers.get('retry-after'))
                const wait =
                    Number.isFinite(retryAfter) && retryAfter > 0
                        ? retryAfter * 1_000
                        : 2_000 * 2 ** attempt
                console.warn(`  [${res.status}] ${path} — retrying in ${wait}ms`)
                await delay(wait)
                continue
            }
            throw new Error(`API ${res.status}: ${path} (gave up after retries)`)
        }
        if (!res.ok) throw new Error(`API ${res.status}: ${path}`)
        return res.json() as T
    }
    throw new Error(`API request failed after retries: ${path}`)
}

// 10-minute overlap so mods bumped during the previous run aren't missed
const SINCE_BUFFER_MS = 10 * 60 * 1000

async function listModsSince(gameId: number, since: Date | null): Promise<Mod[]> {
    const threshold = since ? new Date(since.getTime() - SINCE_BUFFER_MS) : null
    const mods: Mod[] = []
    let page = 1
    let lastPage = 1
    do {
        const result = await apiGet<Paginated<Mod>>(`/games/${gameId}/mods`, {
            limit: 50,
            page,
            sort: 'bumped_at',
        })
        lastPage = result.meta.last_page
        const batch = result.data

        if (threshold) {
            mods.push(...batch.filter((m) => new Date(m.bumped_at) >= threshold))
            if (batch.length > 0 && new Date(batch[batch.length - 1].bumped_at) < threshold) break
        } else {
            mods.push(...batch)
        }

        console.log(`  page ${page}/${lastPage} (${mods.length} mods)`)
        page++
    } while (page <= lastPage)
    return mods
}

async function listModFiles(modId: number): Promise<ModFile[]> {
    const files: ModFile[] = []
    let page = 1
    let lastPage = 1
    do {
        const result = await apiGet<Paginated<ModFile>>(`/mods/${modId}/files`, {
            limit: 50,
            page,
        })
        lastPage = result.meta.last_page
        files.push(...result.data)

        page++
    } while (page <= lastPage)
    return files
}

// --- PD3 download + extraction ---

async function downloadBuffer(downloadUrl: string): Promise<Buffer> {
    metrics.storageRequests++
    const res = await fetch(downloadUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`download ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    metrics.storageBytes += buf.length
    return buf
}

function detectFormat(buf: Buffer): 'zip' | '7z' | 'rar' | 'pak' {
    if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
        return 'zip'
    if (
        buf.length >= 6 &&
        buf[0] === 0x37 &&
        buf[1] === 0x7a &&
        buf[2] === 0xbc &&
        buf[3] === 0xaf &&
        buf[4] === 0x27 &&
        buf[5] === 0x1c
    )
        return '7z'
    if (
        buf.length >= 6 &&
        buf[0] === 0x52 &&
        buf[1] === 0x61 &&
        buf[2] === 0x72 &&
        buf[3] === 0x21 &&
        buf[4] === 0x1a &&
        buf[5] === 0x07
    )
        return 'rar'
    return 'pak'
}

interface ContentEntry {
    sha256: string
    entryName: string
}

// .pak/.ucas/.utoc are UE5 IoStore's three pieces of a mod's cooked content (PD3, Crime
// Boss). .lua is a UE4SS Lua sub-mod's script entry point, see the desktop app's CLAUDE.md
// "UE4SS" section for why this is needed for sub-mod identification, and the known
// caveat (first_file_in_dir's alphabetical pick doesn't always agree with which .lua this
// hashes when a sub-mod has other root-level files).
const CONTENT_EXTENSIONS = ['.pak', '.ucas', '.utoc', '.lua']
const has7zMaskFor = (ext: string) => `*${ext}`
const matchesContentExtension = (name: string) => {
    const lower = name.toLowerCase()
    return CONTENT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

// Returns SHA256 + in-archive path of all hashable content in buf (see CONTENT_EXTENSIONS),
// extracting archives as needed. fallbackName names the buffer itself for bare files.
function extractContentEntries(buf: Buffer, fallbackName: string): ContentEntry[] {
    const fmt = detectFormat(buf)

    if (fmt === 'zip') {
        try {
            const zip = new AdmZip(buf)
            return zip
                .getEntries()
                .filter((e) => !e.isDirectory && matchesContentExtension(e.entryName))
                .map((e) => ({
                    sha256: createHash('sha256').update(e.getData()).digest('hex'),
                    entryName: e.entryName.replace(/\\/g, '/'),
                }))
        } catch {
            return []
        }
    }

    if (fmt === '7z') {
        const tmp = mkdtempSync(join(tmpdir(), 'modrex-idx-'))
        try {
            const archive = join(tmp, 'archive.7z')
            const out = join(tmp, 'out')
            writeFileSync(archive, buf)
            // x (not e) keeps directory structure so entry paths survive
            execFileSync(
                '7z',
                ['x', archive, '-o' + out, ...CONTENT_EXTENSIONS.map(has7zMaskFor), '-r', '-y'],
                { stdio: 'ignore' }
            )
            return (readdirSync(out, { recursive: true }) as string[])
                .filter(matchesContentExtension)
                .map((f) => ({
                    sha256: createHash('sha256')
                        .update(readFileSync(join(out, f)))
                        .digest('hex'),
                    entryName: f.replace(/\\/g, '/'),
                }))
        } catch {
            return []
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    }

    if (fmt === 'rar') {
        // 7z's RAR support doesn't take the same multi-mask filter reliably, so (matching
        // extractPd2FromFull's existing RAR handling) extract everything and filter in JS.
        const tmp = mkdtempSync(join(tmpdir(), 'modrex-idx-'))
        try {
            const archive = join(tmp, 'archive.rar')
            const out = join(tmp, 'out')
            writeFileSync(archive, buf)
            execFileSync('7z', ['x', archive, '-o' + out, '-y'], { stdio: 'ignore' })
            return (readdirSync(out, { recursive: true }) as string[])
                .filter((f) => {
                    try {
                        return matchesContentExtension(f) && statSync(join(out, f)).isFile()
                    } catch {
                        return false
                    }
                })
                .map((f) => ({
                    sha256: createHash('sha256')
                        .update(readFileSync(join(out, f)))
                        .digest('hex'),
                    entryName: f.replace(/\\/g, '/'),
                }))
        } catch {
            return []
        } finally {
            rmSync(tmp, { recursive: true, force: true })
        }
    }

    return [
        {
            sha256: createHash('sha256').update(buf).digest('hex'),
            entryName: fallbackName,
        },
    ]
}

// --- PD2 ZIP Range extraction ---

interface CdEntry {
    name: string
    localOffset: number
    compressedSize: number
    compressionMethod: number
}

async function headContentLength(url: string): Promise<number | null> {
    metrics.storageRequests++
    const res = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
    })
    if (!res.ok) return null
    const len = res.headers.get('content-length')
    const n = len ? parseInt(len, 10) : 0
    return n > 0 ? n : null
}

async function rangeGet(url: string, start: number, end: number): Promise<Buffer> {
    metrics.storageRequests++
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(60_000),
        redirect: 'follow',
    })
    // 200 means the server ignored Range and returned everything (still usable)
    if (res.status !== 206 && res.status !== 200) throw new Error(`rangeGet ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    metrics.storageBytes += buf.length
    return buf
}

function findEocd(buf: Buffer): { cdOffset: number; cdSize: number } | null {
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
            const cdSize = buf.readUInt32LE(i + 12)
            const cdOffset = buf.readUInt32LE(i + 16)
            // 0xFFFFFFFF means ZIP64, which is not supported here.
            if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null
            return { cdOffset, cdSize }
        }
    }
    return null
}

function parseCd(cd: Buffer): CdEntry[] {
    const entries: CdEntry[] = []
    let pos = 0
    while (pos + 46 <= cd.length) {
        if (cd.readUInt32LE(pos) !== 0x02014b50) break
        const compressionMethod = cd.readUInt16LE(pos + 10)
        const compressedSize = cd.readUInt32LE(pos + 20)
        const fnLen = cd.readUInt16LE(pos + 28)
        const exLen = cd.readUInt16LE(pos + 30)
        const cmtLen = cd.readUInt16LE(pos + 32)
        const localOffset = cd.readUInt32LE(pos + 42)
        const name = cd.slice(pos + 46, pos + 46 + fnLen).toString('utf8')
        entries.push({ name, localOffset, compressedSize, compressionMethod })
        pos += 46 + fnLen + exLen + cmtLen
    }
    return entries
}

function selectMarkerPath(paths: string[]): string | null {
    const files = paths.filter((p) => !p.endsWith('/'))
    if (files.length === 0) return null

    const depth = (p: string) => p.split('/').length - 1

    const modTxt = files.find((p) => {
        const l = p.toLowerCase()
        return (l === 'mod.txt' || l.endsWith('/mod.txt')) && depth(p) <= 1
    })
    if (modTxt) return modTxt

    // DAHM sub-mods (PDTH) use base.lua as their entry point instead of mod.txt
    const baseLua = files.find((p) => {
        const l = p.toLowerCase()
        return (l === 'base.lua' || l.endsWith('/base.lua')) && depth(p) <= 1
    })
    if (baseLua) return baseLua

    const mainXml = files.find((p) => {
        const l = p.toLowerCase()
        return (l === 'main.xml' || l.endsWith('/main.xml')) && depth(p) <= 1
    })
    if (mainXml) return mainXml

    // RAID BLT markers: supermod.xml (RAID-SuperBLT) or mod.xml (legacy RaidBLT). The RAID
    // fork has no mod.txt. Checked after the PD2/PDTH markers so archives shipping both keep
    // their existing pick; the same order is mirrored in modrex-main's
    // hashable_file_for_mod_dir so both sides hash the same representative file.
    const supermodXml = files.find((p) => {
        const l = p.toLowerCase()
        return (l === 'supermod.xml' || l.endsWith('/supermod.xml')) && depth(p) <= 1
    })
    if (supermodXml) return supermodXml

    const modXml = files.find((p) => {
        const l = p.toLowerCase()
        return (l === 'mod.xml' || l.endsWith('/mod.xml')) && depth(p) <= 1
    })
    if (modXml) return modXml

    // A single top-level folder means a wrapper, so sort relative to it to match
    const sorted = [...files].sort((a, b) => a.localeCompare(b))
    const roots = [...new Set(files.map((p) => p.split('/')[0]))]
    if (roots.length === 1 && roots[0] !== '') {
        const prefix = roots[0] + '/'
        const rel = sorted
            .filter((p) => p.startsWith(prefix))
            .map((p) => ({ path: p, rel: p.slice(prefix.length) }))
            .sort((a, b) => a.rel.localeCompare(b.rel))
        return rel[0]?.path ?? null
    }

    return sorted[0] ?? null
}

// Typically fetches only ~100 KB regardless of archive size.
async function extractPd2FromZip(
    url: string,
    knownSize: number | null
): Promise<ContentEntry | null> {
    const size = knownSize ?? (await headContentLength(url))
    if (!size || size < 22) return null

    // EOCD is within the last 65535 + 22 bytes (max ZIP comment size + EOCD fixed size)
    const tailStart = Math.max(0, size - 65_557)
    const tail = await rangeGet(url, tailStart, size - 1)

    const eocd = findEocd(tail)
    if (!eocd) return null

    const { cdOffset, cdSize } = eocd
    const cd = await rangeGet(url, cdOffset, cdOffset + cdSize - 1)
    const entries = parseCd(cd)

    const chosen = selectMarkerPath(entries.map((e) => e.name))
    const marker = chosen ? (entries.find((e) => e.name === chosen) ?? null) : null
    if (!marker) return null

    // Files stored with a data descriptor (bit 3 of flags) may report compressedSize=0
    // in the Central Directory; we can't range those without reading the data descriptor.
    if (marker.compressedSize === 0) return null

    const localHeader = await rangeGet(url, marker.localOffset, marker.localOffset + 29)
    if (localHeader.readUInt32LE(0) !== 0x04034b50) return null
    const lfnLen = localHeader.readUInt16LE(26)
    const lexLen = localHeader.readUInt16LE(28)
    const dataStart = marker.localOffset + 30 + lfnLen + lexLen

    const compressed = await rangeGet(url, dataStart, dataStart + marker.compressedSize - 1)

    let content: Buffer
    if (marker.compressionMethod === 0) {
        content = compressed
    } else if (marker.compressionMethod === 8) {
        try {
            content = inflateRawSync(compressed)
        } catch {
            return null
        }
    } else {
        return null
    }

    return {
        sha256: createHash('sha256').update(content).digest('hex'),
        entryName: marker.name,
    }
}

// p7zip-full required for RAR support on Ubuntu CI runners.
async function extractPd2FromFull(url: string, type: string): Promise<ContentEntry | null> {
    const buf = await downloadBuffer(url)
    const ext = type === 'rar' ? '.rar' : '.7z'
    const tmp = mkdtempSync(join(tmpdir(), 'modrex-pd2-'))
    try {
        const archive = join(tmp, 'archive' + ext)
        const outDir = join(tmp, 'out')
        writeFileSync(archive, buf)
        try {
            execFileSync('7z', ['x', archive, '-o' + outDir, '-y'], { stdio: 'ignore' })
        } catch {
            return null
        }

        // readdirSync(recursive) lists directories too, and they carry no trailing
        // slash, so stat each one and selectMarkerPath never picks a dir (readFileSync EISDIR).
        const allFiles = (readdirSync(outDir, { recursive: true }) as string[])
            .filter((f) => {
                try {
                    return statSync(join(outDir, f)).isFile()
                } catch {
                    return false
                }
            })
            .map((f) => f.replace(/\\/g, '/'))

        const chosen = selectMarkerPath(allFiles)
        if (!chosen) return null

        const content = readFileSync(join(outDir, chosen))
        return {
            sha256: createHash('sha256').update(content).digest('hex'),
            entryName: chosen,
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true })
    }
}

// --- pdmod support ---

const PDMOD_PASSWORD = `0$45'5))66S2ixF51a<6}L2UK`
const PDMOD_HASHLIST_PATH = join(import.meta.dirname, 'pdmod_hashlist.txt')

// Bob Jenkins lookup8, port of hash.cpp from HW12Dev/PDModExtractor (MIT).
function mix64(a: bigint, b: bigint, c: bigint): [bigint, bigint, bigint] {
    const M = 0xffffffffffffffffn
    a = ((a - b - c) ^ (c >> 43n)) & M
    b = ((b - c - a) ^ (a << 9n)) & M
    c = ((c - a - b) ^ (b >> 8n)) & M
    a = ((a - b - c) ^ (c >> 38n)) & M
    b = ((b - c - a) ^ (a << 23n)) & M
    c = ((c - a - b) ^ (b >> 5n)) & M
    a = ((a - b - c) ^ (c >> 35n)) & M
    b = ((b - c - a) ^ (a << 49n)) & M
    c = ((c - a - b) ^ (b >> 11n)) & M
    a = ((a - b - c) ^ (c >> 12n)) & M
    b = ((b - c - a) ^ (a << 18n)) & M
    c = ((c - a - b) ^ (b >> 22n)) & M
    return [a, b, c]
}

function hash64(s: string): bigint {
    const k = Buffer.from(s, 'utf-8')
    const M = 0xffffffffffffffffn
    const length = BigInt(k.length)
    let a = 0n,
        b = 0n,
        c = 0x9e3779b97f4a7c13n
    let pos = 0
    while (pos + 24 <= k.length) {
        a = (a + k.readBigUInt64LE(pos + 0)) & M
        b = (b + k.readBigUInt64LE(pos + 8)) & M
        c = (c + k.readBigUInt64LE(pos + 16)) & M
        ;[a, b, c] = mix64(a, b, c)
        pos += 24
    }
    const g = (i: number): bigint => (pos + i < k.length ? BigInt(k[pos + i]) : 0n)
    c = (c + length) & M
    a =
        (a +
            (g(0) |
                (g(1) << 8n) |
                (g(2) << 16n) |
                (g(3) << 24n) |
                (g(4) << 32n) |
                (g(5) << 40n) |
                (g(6) << 48n) |
                (g(7) << 56n))) &
        M
    b =
        (b +
            (g(8) |
                (g(9) << 8n) |
                (g(10) << 16n) |
                (g(11) << 24n) |
                (g(12) << 32n) |
                (g(13) << 40n) |
                (g(14) << 48n) |
                (g(15) << 56n))) &
        M
    c =
        (c +
            (g(16) |
                (g(17) << 8n) |
                (g(18) << 16n) |
                (g(19) << 24n) |
                (g(20) << 32n) |
                (g(21) << 40n) |
                (g(22) << 56n))) &
        M
    ;[, , c] = mix64(a, b, c)
    return c
}

let pdmodHashlistCache: Map<bigint, string> | null = null

function pdmodHashlist(): Map<bigint, string> {
    if (!pdmodHashlistCache) {
        pdmodHashlistCache = new Map()
        for (const line of readFileSync(PDMOD_HASHLIST_PATH, 'utf-8').split('\n')) {
            const s = line.trim()
            if (s) pdmodHashlistCache.set(hash64(s), s)
        }
    }
    return pdmodHashlistCache
}

interface PdmodItem {
    // Stored as strings after large-integer-safe JSON parsing (see parsePdmodManifest).
    BundlePath: string
    BundleExtension: string
    ReplacementFile: string
}

async function extractPdmodEntry(url: string): Promise<ContentEntry | null> {
    const buf = await downloadBuffer(url)
    const tmp = mkdtempSync(join(tmpdir(), 'modrex-pdmod-'))
    try {
        const archive = join(tmp, 'archive.pdmod')
        const outDir = join(tmp, 'out')
        mkdirSync(outDir)
        writeFileSync(archive, buf)

        try {
            execFileSync('7z', ['x', archive, `-p${PDMOD_PASSWORD}`, '-o' + outDir, '-y'], {
                stdio: 'ignore',
            })
        } catch {
            return null
        }

        const manifestPath = join(outDir, 'pdmod.json')
        if (!existsSync(manifestPath)) return null

        // BundlePath and BundleExtension are uint64, so quote them before JSON.parse to avoid
        // float64 truncation (values exceed Number.MAX_SAFE_INTEGER = 2^53 − 1).
        const raw = readFileSync(manifestPath, 'utf-8').replace(
            /("BundlePath"|"BundleExtension"):\s*(\d+)/g,
            (_m, key: string, num: string) => `${key}: "${num}"`
        )
        const manifest = JSON.parse(raw) as { ItemQueue: PdmodItem[] }

        const hl = pdmodHashlist()
        const resolved: Array<{ path: string; repl: string }> = []
        for (const item of manifest.ItemQueue) {
            const name = hl.get(BigInt(item.BundlePath))
            const ext = hl.get(BigInt(item.BundleExtension))
            if (name && ext) resolved.push({ path: `${name}.${ext}`, repl: item.ReplacementFile })
        }
        if (resolved.length === 0) return null

        // Sort alphabetically, matching first_file_in_dir's representative-file pick.
        resolved.sort((a, b) => a.path.localeCompare(b.path))

        const first = resolved[0]
        const replPath = join(outDir, first.repl)
        if (!existsSync(replPath)) return null

        const content = readFileSync(replPath)
        return {
            sha256: createHash('sha256').update(content).digest('hex'),
            entryName: first.path,
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true })
    }
}

// Resolves a listing download_id to its CDN URL (+ size) with a single throttled api
// hit; the 302 follows through to unmetered storage.modworkshop.net for the actual bytes.
async function resolveDownload(
    downloadId: number
): Promise<{ url: string; size: number | null } | null> {
    await apiThrottle()
    const res = await fetch(`${BASE}/files/${downloadId}/download`, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
    })
    if (!res.ok) return null
    const len = res.headers.get('content-length')
    const size = len ? parseInt(len, 10) : 0
    // res.url is the final storage URL after the redirect.
    return { url: res.url, size: size > 0 ? size : null }
}

// url is a resolved storage.modworkshop.net URL; archive format comes from its extension.
async function extractPd2Entries(url: string, size: number | null): Promise<ContentEntry[]> {
    const path = url.split('?')[0].toLowerCase()

    if (path.endsWith('.rar') || path.endsWith('.7z')) {
        const sz = size ?? (await headContentLength(url))
        if (sz === null || sz > PD2_MAX_FULL_DOWNLOAD_BYTES) return []
        const entry = await extractPd2FromFull(url, path.endsWith('.rar') ? 'rar' : '7z')
        return entry ? [entry] : []
    }

    // zip, also the fallback for unknown extensions (findEocd returns null on non-zip)
    const entry = await extractPd2FromZip(url, size)
    return entry ? [entry] : []
}

// --- concurrency pool ---

type Task = () => Promise<void>

async function runPool(
    tasks: Task[],
    concurrency: number,
    deadline: number | null = null
): Promise<boolean> {
    const queue = [...tasks]
    let stoppedAtDeadline = false
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (queue.length > 0) {
            if (deadline !== null && Date.now() >= deadline) {
                stoppedAtDeadline = true
                return
            }
            const task = queue.shift()!
            await task()
        }
    })
    await Promise.all(workers)
    return !stoppedAtDeadline && queue.length === 0
}

// --- helpers ---

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

function shouldDownload(type: string): boolean {
    const t = type.toLowerCase()
    return (
        t.includes('pak') ||
        t.includes('zip') ||
        t.includes('7z') ||
        t.includes('rar') ||
        t === 'pdmod' ||
        t === 'application/octet-stream' ||
        t === 'application/zip' ||
        t === ''
    )
}

// --- main ---

async function main(): Promise<void> {
    if (STAGED_REBUILD) {
        if (!SELECTED_GAME || !VALID_GAMES.includes(SELECTED_GAME as GameSlug)) {
            throw new Error(`--staged-rebuild requires --game=${VALID_GAMES.join('|')}`)
        }
        if (BACKFILL || REPAIR_VERSIONS || RECHECK_ALL) {
            throw new Error(
                '--staged-rebuild cannot be combined with backfill, repair, or recheck modes'
            )
        }
    } else if (FINALIZE_REBUILD || MAX_RUNTIME_MINUTES > 0) {
        throw new Error('--finalize-rebuild and --max-runtime-minutes require --staged-rebuild')
    }
    if (!STAGED_REBUILD && SELECTED_GAME) {
        if (!VALID_GAMES.includes(SELECTED_GAME as GameSlug)) {
            throw new Error(`--game must be one of ${VALID_GAMES.join('|')}`)
        }
        if (!BACKFILL) {
            throw new Error('--game requires --backfill outside a staged rebuild')
        }
    }
    if (FINALIZE_REBUILD && SELECTED_GAME !== 'raid') {
        throw new Error('--finalize-rebuild is only valid for the final RAID stage')
    }
    if (!Number.isFinite(MAX_RUNTIME_MINUTES) || MAX_RUNTIME_MINUTES < 0) {
        throw new Error('--max-runtime-minutes must be a non-negative number')
    }

    console.log('Opening database...')
    const runStartedAt = new Date()
    const { db, pd3SourceId, pd2SourceId, pdthSourceId, cbSourceId, raidSourceId } = openDb()
    const stateDb = openStateDb()
    const rebuildStartedKey = 'staged_rebuild_started_at'
    const rebuildCompletedKey = 'staged_rebuild_completed_games'
    let rebuildStartedAt: string | null = null
    let completedGames = new Set<GameSlug>()
    if (STAGED_REBUILD) {
        const startedRow = db
            .prepare('SELECT value FROM metadata WHERE key = ?')
            .get(rebuildStartedKey) as { value: string } | undefined
        rebuildStartedAt = startedRow?.value ?? runStartedAt.toISOString()
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
            rebuildStartedKey,
            rebuildStartedAt
        )
        const completedRow = db
            .prepare('SELECT value FROM metadata WHERE key = ?')
            .get(rebuildCompletedKey) as { value: string } | undefined
        if (completedRow) {
            completedGames = new Set(JSON.parse(completedRow.value) as GameSlug[])
        }
        console.log(`  Staged full rebuild: ${SELECTED_GAME} (started ${rebuildStartedAt})`)
    }
    const pd3Checks = loadModChecks(stateDb, pd3SourceId)
    const pd2Checks = loadModChecks(stateDb, pd2SourceId)
    const pdthChecks = loadModChecks(stateDb, pdthSourceId)
    const cbChecks = loadModChecks(stateDb, cbSourceId)
    const raidChecks = loadModChecks(stateDb, raidSourceId)
    const putCheckStmt = stateDb.prepare(
        `INSERT INTO mod_checks (source_id, remote_id, updated_at, file_ids, checked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id, remote_id) DO UPDATE SET
             updated_at = excluded.updated_at,
             file_ids = excluded.file_ids,
             checked_at = excluded.checked_at`
    )
    const putCheck = (
        sourceId: number,
        modRemoteId: number,
        updatedAt: string,
        fileIds: number[]
    ) =>
        putCheckStmt.run(
            sourceId,
            modRemoteId,
            updatedAt,
            JSON.stringify(fileIds),
            new Date().toISOString()
        )
    const indexedPd3FileIds = getIndexedFileIds(db, pd3SourceId)
    const indexedPd2FileIds = getIndexedFileIds(db, pd2SourceId)
    const indexedPdthFileIds = getIndexedFileIds(db, pdthSourceId)
    const indexedCbFileIds = getIndexedFileIds(db, cbSourceId)
    const indexedRaidFileIds = getIndexedFileIds(db, raidSourceId)
    const indexedPd2ModIds = getIndexedModIds(db, pd2SourceId)
    const indexedPdthModIds = getIndexedModIds(db, pdthSourceId)
    const indexedRaidModIds = getIndexedModIds(db, raidSourceId)
    const missingNamePd3FileIds = BACKFILL
        ? getFileIdsMissingNames(db, pd3SourceId)
        : new Set<number>()
    const missingNamePd2FileIds = BACKFILL
        ? getFileIdsMissingNames(db, pd2SourceId)
        : new Set<number>()
    const missingNamePdthFileIds = BACKFILL
        ? getFileIdsMissingNames(db, pdthSourceId)
        : new Set<number>()
    const missingNameCbFileIds = BACKFILL
        ? getFileIdsMissingNames(db, cbSourceId)
        : new Set<number>()
    const missingNameRaidFileIds = BACKFILL
        ? getFileIdsMissingNames(db, raidSourceId)
        : new Set<number>()
    console.log(
        `  ${indexedPd3FileIds.size} PD3 + ${indexedPd2FileIds.size} PD2 + ${indexedPdthFileIds.size} PDTH + ${indexedCbFileIds.size} CB + ${indexedRaidFileIds.size} RAID files already indexed`
    )
    if (
        BACKFILL &&
        (missingNamePd3FileIds.size > 0 ||
            missingNamePd2FileIds.size > 0 ||
            missingNamePdthFileIds.size > 0 ||
            missingNameCbFileIds.size > 0 ||
            missingNameRaidFileIds.size > 0)
    ) {
        console.log(
            `  ${missingNamePd3FileIds.size} PD3 + ${missingNamePd2FileIds.size} PD2 + ${missingNamePdthFileIds.size} PDTH + ${missingNameCbFileIds.size} CB + ${missingNameRaidFileIds.size} RAID files missing entry names — will re-download`
        )
    }

    const lastRunRow = db.prepare('SELECT value FROM metadata WHERE key = ?').get('last_run_at') as
        { value: string } | undefined
    const dbLastRunAt = lastRunRow ? new Date(lastRunRow.value) : null
    // The stats copy is newer whenever the previous run exited 2 (its index.db upload was
    // skipped, so the DB's metadata is stale). Take whichever timestamp is later.
    const statsLastRunAt = readPreviousLastRunAt()
    const lastRunAt =
        dbLastRunAt && statsLastRunAt
            ? dbLastRunAt > statsLastRunAt
                ? dbLastRunAt
                : statsLastRunAt
            : (dbLastRunAt ?? statsLastRunAt)

    if (BACKFILL) {
        console.log('  Backfill mode — scanning all mods, skipping already-indexed files\n')
    } else {
        console.log(
            lastRunAt
                ? `  Last run: ${lastRunAt.toISOString()} — incremental update\n`
                : '  No previous run — full index build\n'
        )
    }

    const insertMod = db.prepare(
        'INSERT OR IGNORE INTO mods (source_id, remote_id, name, url) VALUES (?, ?, ?, ?)'
    )
    const getModId = db.prepare('SELECT id FROM mods WHERE source_id = ? AND remote_id = ?')
    const insertContent = db.prepare('INSERT OR IGNORE INTO file_contents (sha256) VALUES (?)')
    const insertFile = db.prepare(
        'INSERT OR IGNORE INTO files (mod_id, sha256, remote_id, version, indexed_at, entry_name) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const fillEntryName = db.prepare(
        "UPDATE files SET entry_name = ? WHERE mod_id = ? AND sha256 = ? AND entry_name = ''"
    )

    const errors: string[] = []
    let newFiles = 0
    let filledNames = 0

    // Fetch both mod lists before building tasks so closures can reference both lengths.
    // Repair scans every mod (since = null) so it can correct any stale version.
    const since = STAGED_REBUILD || BACKFILL || REPAIR_VERSIONS ? null : lastRunAt
    const { pd3Mods, pd2Mods, pdthMods, cbMods, raidMods } = await timePhase(
        'listing',
        async () => {
            const selected = (game: GameSlug) => !SELECTED_GAME || SELECTED_GAME === game
            const list = async (
                game: GameSlug,
                gameId: number | undefined,
                label: string
            ): Promise<Mod[]> => {
                // A game reaches modworkshop only by declaring a binding, and this builder
                // indexes modworkshop, so one without an id contributes nothing here.
                if (!selected(game) || gameId === undefined) return []
                console.log(`Fetching ${label} mod list...`)
                const mods = await listModsSince(gameId, since)
                console.log(`  ${mods.length} ${label} mods to process\n`)
                return mods
            }
            const pd3Mods = await list('pd3', GAMES.pd3.workshopId, 'PD3')
            const pd2Mods = await list('pd2', GAMES.pd2.workshopId, 'PD2')
            const pdthMods = await list('pdth', GAMES.pdth.workshopId, 'PDTH')
            const cbMods = await list('cb', GAMES.cb.workshopId, 'Crime Boss')
            const raidMods = await list('raid', GAMES.raid.workshopId, 'RAID')
            return { pd3Mods, pd2Mods, pdthMods, cbMods, raidMods }
        }
    )

    // Version-only repair: rewrite the version column on already-indexed files from the
    // listing's mod.version, then exit. No downloads, which turns a 3-hour backfill into minutes.
    if (REPAIR_VERSIONS) {
        const updateVer = db.prepare(
            'UPDATE files SET version = ? WHERE mod_id = ? AND version != ?'
        )
        let fixed = 0
        const repair = (mods: Mod[], sourceId: number) =>
            db.transaction(() => {
                for (const mod of mods) {
                    if (!mod.version) continue
                    const m = getModId.get(sourceId, mod.id) as { id: number } | undefined
                    if (m) fixed += updateVer.run(mod.version, m.id, mod.version).changes
                }
            })()
        repair(pd3Mods, pd3SourceId)
        repair(pd2Mods, pd2SourceId)
        repair(pdthMods, pdthSourceId)
        repair(cbMods, cbSourceId)
        repair(raidMods, raidSourceId)
        console.log(`\nVersion repair: rewrote ${fixed} file version(s).`)
        // Repair scans with since = null and must not move the incremental window.
        const stats = writeIndexStats(db, lastRunAt?.toISOString() ?? null)
        console.log(`Wrote index-stats.json (${stats.supportedMods} supported mods).`)
        writeRunSummary('repair-versions', 0, 0, 0)
        db.close()
        stateDb.close()
        process.exit(fixed > 0 ? 0 : 2)
    }

    const progress = { pd3: 0, pd2: 0, pdth: 0, cb: 0, raid: 0 }
    const printProgress = () => {
        const total = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n
        console.log(
            `  [PD3: ${progress.pd3}/${pd3Mods.length} — PD2: ${progress.pd2}/${pd2Mods.length} — PDTH: ${progress.pdth}/${pdthMods.length} — CB: ${progress.cb}/${cbMods.length} — RAID: ${progress.raid}/${raidMods.length} — ${total} files indexed]`
        )
    }

    // --- PD3 / Crime Boss tasks (both UE pak-based, full-archive-download extraction) ---

    function buildContentTasks(
        mods: Mod[],
        sourceId: number,
        label: keyof typeof progress,
        indexedFileIds: Set<number>,
        missingNameFileIds: Set<number>,
        checks: Map<number, ModCheck>
    ): Task[] {
        return mods.map((mod) => async () => {
            if (!mod.has_download) {
                progress[label]++
                return
            }
            // Primary download already indexed: skip the per-mod /files call. A real file
            // update gets a new download_id (so it won't be in the set and is re-fetched);
            // an unchanged mod costs zero API calls instead of a throttled /files request.
            if (
                mod.download_id != null &&
                indexedFileIds.has(mod.download_id) &&
                !missingNameFileIds.has(mod.download_id)
            ) {
                progress[label]++
                return
            }
            // Mods whose listing carries no download_id (most of them) would otherwise pay
            // a throttled /files call every backfill even when fully indexed or known
            // zero-yield. The recorded check is what makes them cost zero API calls.
            if (
                !RECHECK_ALL &&
                checkIsCurrent(checks.get(mod.id), mod, indexedFileIds, missingNameFileIds)
            ) {
                metrics.checkSkips++
                progress[label]++
                return
            }
            let files: ModFile[] = []
            try {
                files = await listModFiles(mod.id)
            } catch (e) {
                errors.push(`${label} mod ${mod.id}: failed to list files — ${e}`)
                progress[label]++
                return
            }

            const modUrl = `https://modworkshop.net/mod/${mod.id}`
            // Insert the mods row lazily, only once a file is actually about to be
            // written (ensureModId). A mod that yields no indexable content must never
            // become a childless mods row: modrex-main's query_by_name matches mods
            // without joining files, so a childless row corrupts name-based
            // identification (a false match, or a false ambiguity that hides a real one).
            let modIdCache: number | null =
                (getModId.get(sourceId, mod.id) as { id: number } | undefined)?.id ?? null
            const ensureModId = (): number => {
                if (modIdCache === null) {
                    insertMod.run(sourceId, mod.id, mod.name, modUrl)
                    modIdCache = (getModId.get(sourceId, mod.id) as { id: number }).id
                }
                return modIdCache
            }

            // Backfill re-stamps existing files' versions from the listing; only runs when
            // the mod already has a row (a brand-new mod has no files to re-stamp yet).
            if (BACKFILL && mod.version && modIdCache !== null) {
                db.prepare('UPDATE files SET version = ? WHERE mod_id = ? AND version != ?').run(
                    mod.version,
                    modIdCache,
                    mod.version
                )
            }

            let failed = false
            const yieldedIds: number[] = []
            for (const file of files) {
                if (!shouldDownload(file.type)) continue

                if (
                    indexedFileIds.has(file.id) &&
                    !missingNameFileIds.has(file.id) &&
                    (!lastRunAt ||
                        new Date(file.updated_at) < new Date(lastRunAt.getTime() - SINCE_BUFFER_MS))
                ) {
                    yieldedIds.push(file.id)
                    continue
                }

                try {
                    const buf = await downloadBuffer(file.download_url)
                    const fallbackName = decodeURIComponent(
                        new URL(file.download_url).pathname.split('/').pop() ?? ''
                    )
                    const entries = extractContentEntries(buf, fallbackName)
                    if (entries.length === 0) continue
                    const modId = ensureModId()
                    db.transaction(() => {
                        for (const { sha256, entryName } of entries) {
                            insertContent.run(sha256)
                            const { changes } = insertFile.run(
                                modId,
                                sha256,
                                file.id,
                                mod.version,
                                new Date().toISOString(),
                                entryName
                            )
                            if (changes > 0) newFiles++
                            else if (fillEntryName.run(entryName, modId, sha256).changes > 0)
                                filledNames++
                        }
                    })()
                    indexedFileIds.add(file.id)
                    missingNameFileIds.delete(file.id)
                    yieldedIds.push(file.id)
                } catch (e) {
                    errors.push(`${label} mod ${mod.id} file ${file.id}: ${e}`)
                    failed = true
                }
            }
            // Errors keep the mod retryable on the next run, since its check is not advanced.
            if (!failed) putCheck(sourceId, mod.id, mod.updated_at, yieldedIds)

            progress[label]++
            if (progress[label] % 50 === 0) printProgress()
        })
    }

    const pd3Tasks = buildContentTasks(
        pd3Mods,
        pd3SourceId,
        'pd3',
        indexedPd3FileIds,
        missingNamePd3FileIds,
        pd3Checks
    )
    const cbTasks = buildContentTasks(
        cbMods,
        cbSourceId,
        'cb',
        indexedCbFileIds,
        missingNameCbFileIds,
        cbChecks
    )

    // --- PD2 tasks ---

    // Writes one PD2 file's entries into the DB. Returns true if anything was stored.
    const storePd2 = (modId: number, fileId: number, version: string, entries: ContentEntry[]) => {
        if (entries.length === 0) return
        db.transaction(() => {
            for (const { sha256, entryName } of entries) {
                insertContent.run(sha256)
                const { changes } = insertFile.run(
                    modId,
                    sha256,
                    fileId,
                    version,
                    new Date().toISOString(),
                    entryName
                )
                if (changes > 0) newFiles++
                else if (fillEntryName.run(entryName, modId, sha256).changes > 0) filledNames++
            }
        })()
        indexedPd2FileIds.add(fileId)
        missingNamePd2FileIds.delete(fileId)
    }

    const pd2Tasks: Task[] = pd2Mods.map((mod) => async () => {
        if (!mod.has_download) {
            progress.pd2++
            return
        }
        // Zero-yield mods (link-only, >50 MB archives, no marker) would otherwise be
        // re-listed and re-downloaded every backfill. The recorded check memoizes that.
        if (
            !RECHECK_ALL &&
            checkIsCurrent(pd2Checks.get(mod.id), mod, indexedPd2FileIds, missingNamePd2FileIds)
        ) {
            metrics.checkSkips++
            progress.pd2++
            return
        }

        const modUrl = `https://modworkshop.net/mod/${mod.id}`

        // Fast path: the listing surfaced a hosted primary download. download_id is the
        // file's remote_id, so already-indexed files cost zero API calls.
        if (mod.download_type === 'file' && mod.download_id != null) {
            const fileId = mod.download_id
            if (indexedPd2FileIds.has(fileId) && !missingNamePd2FileIds.has(fileId)) {
                progress.pd2++
                return
            }
            try {
                const resolved = await resolveDownload(fileId)
                if (resolved) {
                    const entries = await extractPd2Entries(resolved.url, resolved.size)
                    // Insert the mods row only when there's content to store, so a resolved
                    // download that yields no marker file doesn't leave a childless row.
                    if (entries.length > 0) {
                        insertMod.run(pd2SourceId, mod.id, mod.name, modUrl)
                        const { id: modId } = getModId.get(pd2SourceId, mod.id) as { id: number }
                        storePd2(modId, fileId, mod.version, entries)
                    }
                    putCheck(
                        pd2SourceId,
                        mod.id,
                        mod.updated_at,
                        entries.length > 0 ? [fileId] : []
                    )
                }
            } catch (e) {
                errors.push(`pd2 mod ${mod.id} file ${fileId}: ${e}`)
            }
        } else if (!indexedPd2ModIds.has(mod.id)) {
            // Fallback: has_download but the listing carried no download_id (download_type
            // null/link). The /files endpoint still lists the real archive(s).
            let files: ModFile[] = []
            try {
                files = await listModFiles(mod.id)
            } catch (e) {
                errors.push(`pd2 mod ${mod.id}: failed to list files — ${e}`)
                progress.pd2++
                return
            }
            let failed = false
            const yieldedIds: number[] = []
            // Insert the mods row lazily on the first stored file, so a mod whose files
            // all yield nothing doesn't become a childless mods row (see buildContentTasks).
            let modIdCache: number | null =
                (getModId.get(pd2SourceId, mod.id) as { id: number } | undefined)?.id ?? null
            const ensureModId = (): number => {
                if (modIdCache === null) {
                    insertMod.run(pd2SourceId, mod.id, mod.name, modUrl)
                    modIdCache = (getModId.get(pd2SourceId, mod.id) as { id: number }).id
                }
                return modIdCache
            }
            for (const file of files) {
                if (indexedPd2FileIds.has(file.id) && !missingNamePd2FileIds.has(file.id)) {
                    yieldedIds.push(file.id)
                    continue
                }
                try {
                    // file.download_url is already a storage URL, extract directly.
                    // Use the mod-level version (the per-file one is usually blank for PD2);
                    // modrex-main compares installs against the mod version for updates.
                    const entries = await extractPd2Entries(file.download_url, null)
                    if (entries.length > 0) {
                        storePd2(ensureModId(), file.id, file.version || mod.version, entries)
                        yieldedIds.push(file.id)
                    }
                } catch (e) {
                    errors.push(`pd2 mod ${mod.id} file ${file.id}: ${e}`)
                    failed = true
                }
            }
            if (!failed) putCheck(pd2SourceId, mod.id, mod.updated_at, yieldedIds)
        }

        progress.pd2++
        if (progress.pd2 % 200 === 0) printProgress()
    })

    // --- PDTH tasks (same extraction strategy as PD2) ---

    const storePdth = (modId: number, fileId: number, version: string, entries: ContentEntry[]) => {
        if (entries.length === 0) return
        db.transaction(() => {
            for (const { sha256, entryName } of entries) {
                insertContent.run(sha256)
                const { changes } = insertFile.run(
                    modId,
                    sha256,
                    fileId,
                    version,
                    new Date().toISOString(),
                    entryName
                )
                if (changes > 0) newFiles++
                else if (fillEntryName.run(entryName, modId, sha256).changes > 0) filledNames++
            }
        })()
        indexedPdthFileIds.add(fileId)
        missingNamePdthFileIds.delete(fileId)
    }

    const pdthTasks: Task[] = pdthMods.map((mod) => async () => {
        if (!mod.has_download) {
            progress.pdth++
            return
        }
        if (
            !RECHECK_ALL &&
            checkIsCurrent(pdthChecks.get(mod.id), mod, indexedPdthFileIds, missingNamePdthFileIds)
        ) {
            metrics.checkSkips++
            progress.pdth++
            return
        }

        const modUrl = `https://modworkshop.net/mod/${mod.id}`

        if (mod.download_type === 'file' && mod.download_id != null) {
            const fileId = mod.download_id
            if (indexedPdthFileIds.has(fileId) && !missingNamePdthFileIds.has(fileId)) {
                progress.pdth++
                return
            }
            try {
                const resolved = await resolveDownload(fileId)
                if (resolved) {
                    const isPdmod = resolved.url.split('?')[0].toLowerCase().endsWith('.pdmod')
                    const entries = isPdmod
                        ? await extractPdmodEntry(resolved.url).then((e) => (e ? [e] : []))
                        : await extractPd2Entries(resolved.url, resolved.size)
                    // Insert the mods row only when there's content to store, so a resolved
                    // download that yields nothing doesn't leave a childless row.
                    if (entries.length > 0) {
                        insertMod.run(pdthSourceId, mod.id, mod.name, modUrl)
                        const { id: modId } = getModId.get(pdthSourceId, mod.id) as { id: number }
                        storePdth(modId, fileId, mod.version, entries)
                    }
                    putCheck(
                        pdthSourceId,
                        mod.id,
                        mod.updated_at,
                        entries.length > 0 ? [fileId] : []
                    )
                }
            } catch (e) {
                errors.push(`pdth mod ${mod.id} file ${fileId}: ${e}`)
            }
        } else if (!indexedPdthModIds.has(mod.id)) {
            let files: ModFile[] = []
            try {
                files = await listModFiles(mod.id)
            } catch (e) {
                errors.push(`pdth mod ${mod.id}: failed to list files — ${e}`)
                progress.pdth++
                return
            }
            let failed = false
            const yieldedIds: number[] = []
            // Insert the mods row lazily on the first stored file, so a mod whose files
            // all yield nothing doesn't become a childless mods row (see buildContentTasks).
            let modIdCache: number | null =
                (getModId.get(pdthSourceId, mod.id) as { id: number } | undefined)?.id ?? null
            const ensureModId = (): number => {
                if (modIdCache === null) {
                    insertMod.run(pdthSourceId, mod.id, mod.name, modUrl)
                    modIdCache = (getModId.get(pdthSourceId, mod.id) as { id: number }).id
                }
                return modIdCache
            }
            for (const file of files) {
                if (indexedPdthFileIds.has(file.id) && !missingNamePdthFileIds.has(file.id)) {
                    yieldedIds.push(file.id)
                    continue
                }
                try {
                    const entries =
                        file.type === 'pdmod'
                            ? await extractPdmodEntry(file.download_url).then((e) => (e ? [e] : []))
                            : await extractPd2Entries(file.download_url, null)
                    if (entries.length > 0) {
                        storePdth(ensureModId(), file.id, file.version || mod.version, entries)
                        yieldedIds.push(file.id)
                    }
                } catch (e) {
                    errors.push(`pdth mod ${mod.id} file ${file.id}: ${e}`)
                    failed = true
                }
            }
            if (!failed) putCheck(pdthSourceId, mod.id, mod.updated_at, yieldedIds)
        }

        progress.pdth++
        if (progress.pdth % 50 === 0) printProgress()
    })

    // --- RAID tasks (same extraction strategy as PD2; markers are supermod.xml / mod.xml) ---

    const storeRaid = (modId: number, fileId: number, version: string, entries: ContentEntry[]) => {
        if (entries.length === 0) return
        db.transaction(() => {
            for (const { sha256, entryName } of entries) {
                insertContent.run(sha256)
                const { changes } = insertFile.run(
                    modId,
                    sha256,
                    fileId,
                    version,
                    new Date().toISOString(),
                    entryName
                )
                if (changes > 0) newFiles++
                else if (fillEntryName.run(entryName, modId, sha256).changes > 0) filledNames++
            }
        })()
        indexedRaidFileIds.add(fileId)
        missingNameRaidFileIds.delete(fileId)
    }

    const raidTasks: Task[] = raidMods.map((mod) => async () => {
        if (!mod.has_download) {
            progress.raid++
            return
        }
        if (
            !RECHECK_ALL &&
            checkIsCurrent(raidChecks.get(mod.id), mod, indexedRaidFileIds, missingNameRaidFileIds)
        ) {
            metrics.checkSkips++
            progress.raid++
            return
        }

        const modUrl = `https://modworkshop.net/mod/${mod.id}`

        if (mod.download_type === 'file' && mod.download_id != null) {
            const fileId = mod.download_id
            if (indexedRaidFileIds.has(fileId) && !missingNameRaidFileIds.has(fileId)) {
                progress.raid++
                return
            }
            try {
                const resolved = await resolveDownload(fileId)
                if (resolved) {
                    const entries = await extractPd2Entries(resolved.url, resolved.size)
                    // Insert the mods row only when there's content to store, so a resolved
                    // download that yields nothing doesn't leave a childless row.
                    if (entries.length > 0) {
                        insertMod.run(raidSourceId, mod.id, mod.name, modUrl)
                        const { id: modId } = getModId.get(raidSourceId, mod.id) as { id: number }
                        storeRaid(modId, fileId, mod.version, entries)
                    }
                    putCheck(
                        raidSourceId,
                        mod.id,
                        mod.updated_at,
                        entries.length > 0 ? [fileId] : []
                    )
                }
            } catch (e) {
                errors.push(`raid mod ${mod.id} file ${fileId}: ${e}`)
            }
        } else if (!indexedRaidModIds.has(mod.id)) {
            let files: ModFile[] = []
            try {
                files = await listModFiles(mod.id)
            } catch (e) {
                errors.push(`raid mod ${mod.id}: failed to list files — ${e}`)
                progress.raid++
                return
            }
            let failed = false
            const yieldedIds: number[] = []
            // Insert the mods row lazily on the first stored file, so a mod whose files
            // all yield nothing doesn't become a childless mods row (see buildContentTasks).
            let modIdCache: number | null =
                (getModId.get(raidSourceId, mod.id) as { id: number } | undefined)?.id ?? null
            const ensureModId = (): number => {
                if (modIdCache === null) {
                    insertMod.run(raidSourceId, mod.id, mod.name, modUrl)
                    modIdCache = (getModId.get(raidSourceId, mod.id) as { id: number }).id
                }
                return modIdCache
            }
            for (const file of files) {
                if (indexedRaidFileIds.has(file.id) && !missingNameRaidFileIds.has(file.id)) {
                    yieldedIds.push(file.id)
                    continue
                }
                try {
                    const entries = await extractPd2Entries(file.download_url, null)
                    if (entries.length > 0) {
                        storeRaid(ensureModId(), file.id, file.version || mod.version, entries)
                        yieldedIds.push(file.id)
                    }
                } catch (e) {
                    errors.push(`raid mod ${mod.id} file ${file.id}: ${e}`)
                    failed = true
                }
            }
            if (!failed) putCheck(raidSourceId, mod.id, mod.updated_at, yieldedIds)
        }

        progress.raid++
        if (progress.raid % 50 === 0) printProgress()
    })

    console.log(
        `Processing ${pd3Mods.length} PD3 + ${pd2Mods.length} PD2 + ${pdthMods.length} PDTH + ${cbMods.length} CB + ${raidMods.length} RAID mods with ${CONCURRENCY} workers...\n`
    )
    const deadline =
        MAX_RUNTIME_MINUTES > 0 ? runStartedAt.getTime() + MAX_RUNTIME_MINUTES * 60_000 : null
    const processingComplete = await timePhase('processing', () =>
        runPool(
            [...pd3Tasks, ...pd2Tasks, ...pdthTasks, ...cbTasks, ...raidTasks],
            CONCURRENCY,
            deadline
        )
    )

    // Prune childless mods rows left by older builds (a mod inserted before the
    // lazy-insert fix whose files never yielded). query_by_name in modrex-main matches
    // mods without joining files, so these keep corrupting name-based identification.
    // Safe because this indexer never deletes files: a zero-file mod is always a genuine
    // zero-yield leftover, not a transient state.
    const prunedChildless = db
        .prepare(
            'DELETE FROM mods WHERE NOT EXISTS (SELECT 1 FROM files WHERE files.mod_id = mods.id)'
        )
        .run().changes
    if (prunedChildless > 0) console.log(`  Pruned ${prunedChildless} childless mod row(s).`)

    const total = (db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number }).n
    console.log(
        `\nDone. ${total} files in index.db (${newFiles} new, ${filledNames} names filled this run)`
    )

    if (errors.length > 0) {
        console.log(`\n${errors.length} errors:`)
        errors.forEach((e) => console.log(`  - ${e}`))
    }

    if (STAGED_REBUILD) {
        if (!processingComplete) {
            console.log(
                `Reached the ${MAX_RUNTIME_MINUTES}-minute stage limit — checkpointing for the next job.`
            )
            writeRunSummary(
                `staged-rebuild-${SELECTED_GAME}-checkpoint`,
                newFiles,
                filledNames,
                errors.length
            )
            db.pragma('wal_checkpoint(TRUNCATE)')
            stateDb.pragma('wal_checkpoint(TRUNCATE)')
            db.close()
            stateDb.close()
            process.exit(3)
        }

        completedGames.add(SELECTED_GAME as GameSlug)
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
            rebuildCompletedKey,
            JSON.stringify([...completedGames])
        )

        if (FINALIZE_REBUILD) {
            const missingGames = VALID_GAMES.filter((game) => !completedGames.has(game))
            if (missingGames.length > 0) {
                throw new Error(
                    `Cannot finalize staged rebuild; missing completed stages: ${missingGames.join(', ')}`
                )
            }
            db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
                'last_run_at',
                rebuildStartedAt
            )
            db.prepare('DELETE FROM metadata WHERE key IN (?, ?)').run(
                rebuildStartedKey,
                rebuildCompletedKey
            )
            const stats = writeIndexStats(db, rebuildStartedAt)
            console.log(`Wrote index-stats.json (${stats.supportedMods} supported mods).`)
        }

        writeRunSummary(`staged-rebuild-${SELECTED_GAME}`, newFiles, filledNames, errors.length)
        db.pragma('wal_checkpoint(TRUNCATE)')
        stateDb.pragma('wal_checkpoint(TRUNCATE)')
        db.close()
        stateDb.close()
        return
    }

    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        'last_run_at',
        runStartedAt.toISOString()
    )
    const stats = writeIndexStats(db, runStartedAt.toISOString())
    console.log(`Wrote index-stats.json (${stats.supportedMods} supported mods).`)
    writeRunSummary(
        BACKFILL ? `backfill${SELECTED_GAME ? `-${SELECTED_GAME}` : ''}` : 'incremental',
        newFiles,
        filledNames,
        errors.length
    )

    db.close()
    stateDb.close()

    if (newFiles === 0 && filledNames === 0 && prunedChildless === 0) {
        console.log('No new files — skipping upload.')
        process.exit(2)
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
