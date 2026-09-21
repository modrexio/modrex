import type { Database } from './database.js'
import type { Listing } from './downloadable-state.js'
import type { ModWorkshop } from './modworkshop.js'

export interface VersionRefreshResult {
    updated: number
    missing: number
    failed: number
    processable: Listing[]
}

export async function refreshContentVersions(
    db: Database,
    api: ModWorkshop,
    listings: Listing[],
    now = new Date()
): Promise<VersionRefreshResult> {
    const versions = await api.versions(listings.map((listing) => Number(listing.remote_id)))
    const updates: Array<{ source_id: string; remote_id: string; version: string }> = []
    let missing = 0
    let failed = 0
    const processable: Listing[] = []
    const deferred: Array<{
        source_id: string
        remote_id: string
        updated_at: string
        status: 'missing' | 'failed'
    }> = []
    for (const listing of listings) {
        const result = versions.get(Number(listing.remote_id))
        if (!result) throw new Error(`No version outcome for ${listing.remote_id}`)
        if (result.status === 'missing') {
            missing++
            deferred.push({ ...listing, status: 'missing' })
            continue
        }
        if (result.status === 'failed') {
            failed++
            deferred.push({ ...listing, status: 'failed' })
            continue
        }
        processable.push(listing)
        if (listing.version === result.version) continue
        listing.version = result.version
        updates.push({
            source_id: listing.source_id,
            remote_id: listing.remote_id,
            version: result.version,
        })
    }
    if (updates.length)
        await db.query(
            `UPDATE mod_listings AS listing SET version=remote.version
             FROM jsonb_to_recordset($1::jsonb)
                  AS remote(source_id BIGINT, remote_id BIGINT, version TEXT)
             WHERE listing.source_id=remote.source_id AND listing.remote_id=remote.remote_id`,
            [JSON.stringify(updates)]
        )
    if (deferred.length)
        await db.query(
            `INSERT INTO mod_reconciliations (
                source_id, remote_id, last_discovered_at, next_reconcile_at,
                version_deferred_updated_at
             )
             SELECT item.source_id, item.remote_id, $2,
                CASE WHEN item.status='missing' THEN $3 ELSE $4 END,
                item.updated_at
             FROM jsonb_to_recordset($1::jsonb)
                  AS item(source_id BIGINT, remote_id BIGINT, status TEXT, updated_at TEXT)
             ON CONFLICT (source_id, remote_id) DO UPDATE SET
                last_discovered_at=EXCLUDED.last_discovered_at,
                next_reconcile_at=EXCLUDED.next_reconcile_at,
                version_deferred_updated_at=EXCLUDED.version_deferred_updated_at`,
            [
                JSON.stringify(deferred),
                now.toISOString(),
                new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
            ]
        )
    return { updated: updates.length, missing, failed, processable }
}

export async function selectContentListings(
    db: Database,
    game: string,
    limit: number,
    now: Date
): Promise<Listing[]> {
    const dueQuota = Math.max(1, Math.floor(limit / 4))
    return db.query<Listing>(
        `WITH fresh AS (
            SELECT listing.source_id::TEXT, listing.remote_id::TEXT, listing.name,
                   listing.version, listing.updated_at, listing.bumped_at
            FROM mod_listings listing
            JOIN sources ON sources.id=listing.source_id
            JOIN games ON games.id=sources.game_id
            LEFT JOIN mod_checks check_state ON check_state.source_id=listing.source_id
                 AND check_state.remote_id=listing.remote_id
            LEFT JOIN mod_reconciliations reconciliation ON reconciliation.source_id=listing.source_id
                 AND reconciliation.remote_id=listing.remote_id
            WHERE games.slug=$1
              AND (
                (check_state.remote_id IS NULL OR check_state.updated_at<>listing.updated_at)
                AND (
                    reconciliation.version_deferred_updated_at IS DISTINCT FROM listing.updated_at
                    OR reconciliation.next_reconcile_at<=$2
                )
              )
        ), due AS (
            SELECT listing.source_id::TEXT, listing.remote_id::TEXT, listing.name,
                   listing.version, listing.updated_at, listing.bumped_at
            FROM mod_listings listing
            JOIN sources ON sources.id=listing.source_id
            JOIN games ON games.id=sources.game_id
            JOIN mod_checks check_state ON check_state.source_id=listing.source_id
                 AND check_state.remote_id=listing.remote_id
                 AND check_state.updated_at=listing.updated_at
            LEFT JOIN mod_reconciliations reconciliation ON reconciliation.source_id=listing.source_id
                 AND reconciliation.remote_id=listing.remote_id
            WHERE games.slug=$1
              AND (
                reconciliation.remote_id IS NULL OR reconciliation.next_reconcile_at<=$2 OR
                EXISTS (
                    SELECT 1 FROM remote_downloadables downloadable
                    WHERE downloadable.source_id=listing.source_id
                      AND downloadable.mod_remote_id=listing.remote_id
                      AND downloadable.retired_at IS NULL
                      AND (
                        downloadable.status='pending' OR
                        (downloadable.status='failed' AND downloadable.retry_at<=$2) OR
                        (downloadable.kind='link' AND downloadable.next_revalidate_at<=$2)
                      )
                )
              )
        ), reserved_due AS (
            SELECT due.* FROM due
            LEFT JOIN mod_reconciliations reconciliation
              ON reconciliation.source_id=due.source_id::BIGINT
             AND reconciliation.remote_id=due.remote_id::BIGINT
            ORDER BY reconciliation.next_reconcile_at NULLS FIRST, due.bumped_at
            LIMIT $3
        ), candidates AS (
            SELECT 0 AS priority, * FROM reserved_due
            UNION ALL
            SELECT 1 AS priority, fresh.* FROM fresh
            UNION ALL
            SELECT 2 AS priority, due.* FROM due
            WHERE NOT EXISTS (
                SELECT 1 FROM reserved_due
                WHERE reserved_due.source_id=due.source_id
                  AND reserved_due.remote_id=due.remote_id
            )
        ), deduplicated AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY source_id, remote_id ORDER BY priority, bumped_at DESC
            ) AS duplicate_rank
            FROM candidates
        )
        SELECT source_id, remote_id, name, version, updated_at
        FROM deduplicated WHERE duplicate_rank=1
        ORDER BY priority, bumped_at DESC, source_id, remote_id
        LIMIT $4`,
        [game, now.toISOString(), dueQuota, limit]
    )
}
