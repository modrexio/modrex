import { neon } from '@neondatabase/serverless'

import { extractContentEntries, type ContentEntry } from './content-archive.js'
import { extractMarkerEntry, extractPdmodEntry } from './marker-archive.js'

interface Listing {
    source_id: string
    remote_id: string
    name: string
    version: string
    updated_at: string
}

interface ModFile {
    id: number
    version: string
    download_url: string
    type: string
}

// A mod's download can be a link to another host instead of a file ModWorkshop stores.
interface ModLink {
    id: number
    url: string
}

interface Paginated<T> {
    data: T[]
    meta: { current_page: number; last_page: number }
}

class ModWorkshopApiError extends Error {
    constructor(
        readonly status: number,
        readonly path: string
    ) {
        super(`ModWorkshop API ${status}: ${path}`)
    }
}

const databaseUrl = process.env.INDEX_DATABASE_URL
if (!databaseUrl) throw new Error('INDEX_DATABASE_URL is required')

const game = process.argv.find((argument) => argument.startsWith('--game='))?.slice(7)
const supportedGames = ['pd3', 'pd2', 'pdth', 'cb', 'raid'] as const
if (!supportedGames.includes(game as (typeof supportedGames)[number])) {
    throw new Error(`--game must be one of ${supportedGames.join(', ')}`)
}

const limit = Number(
    process.argv.find((argument) => argument.startsWith('--limit='))?.slice(8) ?? '25'
)
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('--limit must be an integer from 1 through 1000')
}

// PD3 and Crime Boss index every content file in an archive. The Diesel games hash one
// representative marker file per mod instead.
const isUnrealGame = game === 'pd3' || game === 'cb'
const apiBase = process.env.MODWORKSHOP_API_BASE ?? 'https://api.modworkshop.net'
const sql = neon(databaseUrl)
const userAgent = 'modrex-index-builder'
const apiMinimumIntervalMs = 700
let nextApiSlot = 0

function shouldDownload(type: string): boolean {
    const normalized = type.toLowerCase()
    return (
        normalized.includes('pak') ||
        normalized.includes('zip') ||
        normalized.includes('7z') ||
        normalized.includes('rar') ||
        normalized === 'pdmod' ||
        normalized === 'application/octet-stream' ||
        normalized === 'application/zip' ||
        normalized === ''
    )
}

async function apiGet<T>(path: string): Promise<T> {
    const now = Date.now()
    const slot = Math.max(now, nextApiSlot)
    nextApiSlot = slot + apiMinimumIntervalMs
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now))

    const response = await fetch(`${apiBase}${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
        signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new ModWorkshopApiError(response.status, path)
    return (await response.json()) as T
}

async function listFiles(modId: string): Promise<ModFile[]> {
    const files: ModFile[] = []
    let page = 1
    let lastPage = 1
    do {
        const result = await apiGet<Paginated<ModFile>>(
            `/mods/${modId}/files?limit=50&page=${page}`
        )
        files.push(...result.data)
        lastPage = result.meta.last_page
        page++
    } while (page <= lastPage)
    return files
}

// A link's URL is whatever the author typed, so anything that is not a fetchable web address
// is dropped here rather than thrown at the extractor, where it would fail the whole run.
function isFetchableUrl(url: string): boolean {
    try {
        const { protocol } = new URL(url)
        return protocol === 'https:' || protocol === 'http:'
    } catch {
        return false
    }
}

async function listLinks(modId: string): Promise<ModLink[]> {
    const links = await apiGet<Paginated<ModLink>>(`/mods/${modId}/links?limit=50`)
    return links.data.filter((link) => isFetchableUrl(link.url))
}

const listings = (await sql`
    SELECT mod_listings.source_id, mod_listings.remote_id, mod_listings.name,
           mod_listings.version, mod_listings.updated_at
    FROM mod_listings
    JOIN sources ON sources.id = mod_listings.source_id
    JOIN games ON games.id = sources.game_id
    LEFT JOIN mod_checks ON mod_checks.source_id = mod_listings.source_id
                        AND mod_checks.remote_id = mod_listings.remote_id
    WHERE games.slug = ${game}
      AND mod_listings.has_download
      AND (mod_checks.remote_id IS NULL OR mod_checks.updated_at <> mod_listings.updated_at)
    ORDER BY mod_listings.bumped_at DESC
    LIMIT ${limit}
`) as Listing[]

async function extractEntries(url: string, type: string): Promise<ContentEntry[]> {
    if (!isUnrealGame) {
        const isPdmod =
            type.toLowerCase() === 'pdmod' || new URL(url).pathname.toLowerCase().endsWith('.pdmod')
        const entry = isPdmod ? await extractPdmodEntry(url) : await extractMarkerEntry(url, null)
        return entry ? [entry] : []
    }

    const response = await fetch(url, {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(120_000),
    })
    if (response.status === 404) return []
    if (!response.ok) throw new Error(`download ${response.status}`)
    const fallbackName = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return extractContentEntries(Buffer.from(await response.arrayBuffer()), fallbackName)
}

// downloadId is what files.remote_id holds: a positive ModWorkshop file id, or a negated
// ModWorkshop link id for content reached through an off-site link (see the link fallback
// below for why the two kinds must not share a range).
async function storeEntries(
    listing: Listing,
    downloadId: number,
    version: string,
    entries: ContentEntry[]
): Promise<void> {
    const indexedEntries: Array<{ sha256: string; entry_name: string }> = []
    const indexedHashes = new Set<string>()
    for (const entry of entries) {
        if (indexedHashes.has(entry.sha256)) continue
        indexedHashes.add(entry.sha256)
        indexedEntries.push({ sha256: entry.sha256, entry_name: entry.entryName })
    }

    await sql.query(
        `WITH indexed_mod AS (
            INSERT INTO mods (source_id, remote_id, name, url)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (source_id, remote_id) DO UPDATE SET
                name = EXCLUDED.name,
                url = EXCLUDED.url
            RETURNING id
        ), contents AS (
            INSERT INTO file_contents (sha256)
            SELECT sha256 FROM jsonb_to_recordset($5::jsonb) AS entry(sha256 TEXT, entry_name TEXT)
            ON CONFLICT DO NOTHING
        )
        INSERT INTO files (mod_id, sha256, remote_id, version, indexed_at, entry_name)
        SELECT indexed_mod.id, entry.sha256, $6, $7, $8, entry.entry_name
        FROM indexed_mod
        CROSS JOIN jsonb_to_recordset($5::jsonb) AS entry(sha256 TEXT, entry_name TEXT)
        ON CONFLICT (mod_id, sha256) DO UPDATE SET
            entry_name = CASE WHEN files.entry_name = '' THEN EXCLUDED.entry_name ELSE files.entry_name END`,
        [
            listing.source_id,
            listing.remote_id,
            listing.name,
            `https://modworkshop.net/mod/${listing.remote_id}`,
            JSON.stringify(indexedEntries),
            downloadId,
            version,
            new Date().toISOString(),
        ]
    )
}

async function recordCheck(listing: Listing, fileIds: number[]): Promise<void> {
    await sql`
        INSERT INTO mod_checks (source_id, remote_id, updated_at, file_ids, checked_at)
        VALUES (${listing.source_id}, ${listing.remote_id}, ${listing.updated_at}, ${JSON.stringify(fileIds)}::jsonb, ${new Date().toISOString()})
        ON CONFLICT (source_id, remote_id) DO UPDATE SET
            updated_at = EXCLUDED.updated_at,
            file_ids = EXCLUDED.file_ids,
            checked_at = EXCLUDED.checked_at
    `
}

const failures: string[] = []
for (const listing of listings) {
    try {
        let files: ModFile[]
        try {
            files = await listFiles(listing.remote_id)
        } catch (error) {
            if (error instanceof ModWorkshopApiError && error.status === 404) {
                await recordCheck(listing, [])
                continue
            }
            throw error
        }
        const indexedFileIds: number[] = []
        let failed = false

        for (const file of files) {
            if (!shouldDownload(file.type)) continue
            try {
                const entries = await extractEntries(file.download_url, file.type)
                if (entries.length === 0) continue
                await storeEntries(listing, file.id, file.version || listing.version, entries)
                indexedFileIds.push(file.id)
            } catch (error) {
                failed = true
                failures.push(
                    `${game} mod ${listing.remote_id} file ${file.id}: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        // A mod can publish its download as a link to another host, and then the files endpoint
        // above is empty and nothing about the mod is recorded at all. Marker games only: their
        // extractor reads a few hundred kilobytes over Range and gives up on anything that is
        // not an archive, so an author-supplied URL stays bounded and self-validating, which
        // the whole-archive path the Unreal games use is not.
        if (!isUnrealGame && !failed && indexedFileIds.length === 0) {
            for (const link of await listLinks(listing.remote_id)) {
                try {
                    const entries = await extractEntries(link.url, '')
                    if (entries.length === 0) continue
                    // Negated, because modrex-main groups installed mods by file id across
                    // the whole install (installedUtils.ts findSuspectDuplicateGroups) and
                    // that only holds while ids are unique game-wide. ModWorkshop numbers
                    // links in their own sequence, so a link id can equal some other mod's
                    // file id; negating keeps the two kinds in disjoint ranges and marks a
                    // row as "no downloadable ModWorkshop file" at the same time.
                    await storeEntries(listing, -link.id, listing.version, entries)
                    indexedFileIds.push(-link.id)
                } catch (error) {
                    failed = true
                    failures.push(
                        `${game} mod ${listing.remote_id} link ${link.id}: ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }
        }

        if (!failed) {
            await recordCheck(listing, indexedFileIds)
        }
    } catch (error) {
        failures.push(
            `${game} mod ${listing.remote_id}: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

console.log(`Processed ${listings.length} ${game} listings`)
if (failures.length > 0) throw new Error(failures.join('\n'))
