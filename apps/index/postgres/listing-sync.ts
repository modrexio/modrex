import type { Database, Statement } from './database.js'
import { ModWorkshop, parseListing, type ModListing, type VersionResult } from './modworkshop.js'

const overlapMs = 10 * 60 * 1000

interface PendingRow {
    listing: unknown
}

interface PendingAttemptRow {
    remote_id: string
    attempts: number
    listing: unknown
    next_retry_at: string
}

interface StoredBatch {
    stored: number
    pending: number
}

function sameListing(left: ModListing, right: ModListing): boolean {
    return (
        left.id === right.id &&
        left.name === right.name &&
        left.has_download === right.has_download &&
        left.bumped_at === right.bumped_at &&
        left.updated_at === right.updated_at &&
        left.download_id === right.download_id &&
        left.download_type === right.download_type
    )
}

export interface SyncResult {
    discovered: number
    stored: number
    pending: number
    requests: number
    versionBatches: number
}

function retryAt(now: Date, result: VersionResult, attempts: number): string {
    const base = result.status === 'missing' ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000
    const cap = result.status === 'missing' ? 7 * 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000
    return new Date(
        now.getTime() + Math.min(cap, base * 2 ** Math.min(attempts - 1, 8))
    ).toISOString()
}

function knownStatement(
    sourceId: string,
    rows: Array<ModListing & { version: string }>
): Statement {
    return {
        text: `INSERT INTO mod_listings (
                source_id, remote_id, name, version, has_download, bumped_at, updated_at, download_id, download_type
            )
            SELECT $1, listing.id, listing.name, listing.version, listing.has_download,
                listing.bumped_at, listing.updated_at, listing.download_id, listing.download_type
            FROM jsonb_to_recordset($2::jsonb) AS listing(
                id BIGINT, name TEXT, version TEXT, has_download BOOLEAN, bumped_at TEXT,
                updated_at TEXT, download_id BIGINT, download_type TEXT
            )
            ON CONFLICT (source_id, remote_id) DO UPDATE SET
                name = EXCLUDED.name, version = EXCLUDED.version,
                has_download = EXCLUDED.has_download, bumped_at = EXCLUDED.bumped_at,
                updated_at = EXCLUDED.updated_at, download_id = EXCLUDED.download_id,
                download_type = EXCLUDED.download_type`,
        values: [sourceId, JSON.stringify(rows)],
    }
}

function pendingStatement(
    sourceId: string,
    rows: Array<{
        listing: ModListing
        outcome: 'missing' | 'failed'
        attempts: number
        next_retry_at: string
        last_error: string | null
        at: string
    }>
): Statement {
    return {
        text: `INSERT INTO listing_version_pending (
                source_id, remote_id, listing, outcome, attempts, next_retry_at,
                last_error, first_seen_at, last_attempt_at
            )
            SELECT $1, pending.remote_id, pending.listing, pending.outcome,
                pending.attempts, pending.next_retry_at, pending.last_error,
                pending.at, pending.at
            FROM jsonb_to_recordset($2::jsonb) AS pending(
                remote_id BIGINT, listing JSONB, outcome TEXT, attempts INTEGER,
                next_retry_at TEXT, last_error TEXT, at TEXT
            )
            ON CONFLICT (source_id, remote_id) DO UPDATE SET
                listing = EXCLUDED.listing, outcome = EXCLUDED.outcome,
                attempts = EXCLUDED.attempts, next_retry_at = EXCLUDED.next_retry_at,
                last_error = EXCLUDED.last_error, last_attempt_at = EXCLUDED.last_attempt_at`,
        values: [
            sourceId,
            JSON.stringify(rows.map((row) => ({ ...row, remote_id: row.listing.id }))),
        ],
    }
}

async function storeBatch(
    db: Database,
    api: ModWorkshop,
    sourceId: string,
    listings: ModListing[],
    startedAt: Date
): Promise<StoredBatch> {
    if (!listings.length) return { stored: 0, pending: 0 }
    const listingIds = listings.map((listing) => listing.id)
    const existing = await db.query<PendingAttemptRow>(
        `SELECT remote_id::TEXT, attempts, listing, next_retry_at FROM listing_version_pending
         WHERE source_id = $1 AND remote_id = ANY($2::BIGINT[])`,
        [sourceId, listingIds]
    )
    const prior = new Map(existing.map((row) => [Number(row.remote_id), row]))
    const candidates = listings.filter((listing) => {
        const pending = prior.get(listing.id)
        return (
            !pending ||
            pending.next_retry_at <= startedAt.toISOString() ||
            !sameListing(parseListing(pending.listing), listing)
        )
    })
    if (!candidates.length) return { stored: 0, pending: 0 }
    const versions = await api.versions(candidates.map((listing) => listing.id))
    const known: Array<ModListing & { version: string }> = []
    const pending: Parameters<typeof pendingStatement>[1] = []
    const resolved: number[] = []
    const at = startedAt.toISOString()

    for (const listing of candidates) {
        const result = versions.get(listing.id)
        if (!result) throw new Error(`No version outcome for ${listing.id}`)
        if (result.status === 'known') {
            known.push({ ...listing, version: result.version })
            resolved.push(listing.id)
            continue
        }
        const attempts = (prior.get(listing.id)?.attempts ?? 0) + 1
        pending.push({
            listing,
            outcome: result.status,
            attempts,
            next_retry_at: retryAt(startedAt, result, attempts),
            last_error: result.status === 'failed' ? result.error : null,
            at,
        })
    }

    const statements: Statement[] = []
    if (known.length) statements.push(knownStatement(sourceId, known))
    if (pending.length) statements.push(pendingStatement(sourceId, pending))
    if (resolved.length)
        statements.push({
            text: 'DELETE FROM listing_version_pending WHERE source_id = $1 AND remote_id = ANY($2::BIGINT[])',
            values: [sourceId, resolved],
        })
    await db.transaction(statements)
    return { stored: known.length, pending: pending.length }
}

export async function syncGameListings(
    db: Database,
    api: ModWorkshop,
    slug: string,
    workshopId: number,
    startedAt = new Date()
): Promise<SyncResult> {
    const sources = await db.query<{ id: string }>(
        `SELECT sources.id::TEXT AS id FROM sources JOIN games ON games.id = sources.game_id
         WHERE games.slug = $1 AND sources.name = 'modworkshop'`,
        [slug]
    )
    if (sources.length !== 1) throw new Error(`Missing ModWorkshop source for ${slug}`)
    const sourceId = sources[0].id
    const checkpoints = await db.query<{ value: string }>(
        'SELECT value FROM metadata WHERE key = $1',
        [`listings_last_run_at:${slug}`]
    )
    const checkpoint = checkpoints.length ? new Date(checkpoints[0].value) : null
    if (checkpoint && !Number.isFinite(checkpoint.getTime()))
        throw new Error(`Invalid listings checkpoint for ${slug}`)
    const threshold = checkpoint ? new Date(checkpoint.getTime() - overlapMs) : null

    const due = await db.query<PendingRow>(
        `SELECT listing FROM listing_version_pending
         WHERE source_id = $1 AND next_retry_at <= $2 ORDER BY next_retry_at LIMIT 1000`,
        [sourceId, startedAt.toISOString()]
    )
    const dueListings = new Map<number, ModListing>()
    for (const row of due) {
        const listing = parseListing(row.listing)
        dueListings.set(listing.id, listing)
    }

    const discoveredIds = new Set<number>()
    let stored = 0
    let pending = 0
    let page = 1
    let batch: ModListing[] = []
    while (true) {
        const result = await api.listings(workshopId, page)
        for (const listing of result.data) {
            const retrying = dueListings.delete(listing.id)
            if (threshold && new Date(listing.bumped_at) < threshold && !retrying) continue
            if (discoveredIds.has(listing.id)) continue
            discoveredIds.add(listing.id)
            batch.push(listing)
        }
        while (batch.length >= 100) {
            const batchResult = await storeBatch(db, api, sourceId, batch.splice(0, 100), startedAt)
            stored += batchResult.stored
            pending += batchResult.pending
        }
        const oldest = result.data.at(-1)?.bumped_at
        const finished =
            page === result.meta.last_page ||
            Boolean(threshold && oldest && new Date(oldest) < threshold)
        if (finished) {
            const batchResult = await storeBatch(db, api, sourceId, batch, startedAt)
            stored += batchResult.stored
            pending += batchResult.pending
            break
        }
        page++
    }

    const retryResult = await storeBatch(db, api, sourceId, [...dueListings.values()], startedAt)
    stored += retryResult.stored
    pending += retryResult.pending
    for (const id of dueListings.keys()) discoveredIds.add(id)

    await db.transaction([
        {
            text: `INSERT INTO metadata (key, value) VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            values: [`listings_last_run_at:${slug}`, startedAt.toISOString()],
        },
    ])
    return {
        discovered: discoveredIds.size,
        stored,
        pending,
        requests: api.counts.requests,
        versionBatches: api.counts.versionBatches,
    }
}
