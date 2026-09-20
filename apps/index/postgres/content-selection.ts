import type { Database } from './database.js'
import type { Listing } from './downloadable-state.js'

export async function selectContentListings(
    db: Database,
    game: string,
    limit: number,
    now: Date
): Promise<Listing[]> {
    const dueQuota = Math.floor(limit / 4)
    return db.query<Listing>(
        `WITH fresh AS (
            SELECT listing.source_id::TEXT, listing.remote_id::TEXT, listing.name,
                   listing.version, listing.updated_at, listing.bumped_at
            FROM mod_listings listing
            JOIN sources ON sources.id=listing.source_id
            JOIN games ON games.id=sources.game_id
            LEFT JOIN mod_checks check_state ON check_state.source_id=listing.source_id
                 AND check_state.remote_id=listing.remote_id
            WHERE games.slug=$1 AND listing.has_download
              AND (check_state.remote_id IS NULL OR check_state.updated_at<>listing.updated_at)
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
            WHERE games.slug=$1 AND listing.has_download
              AND (
                reconciliation.remote_id IS NULL OR reconciliation.next_reconcile_at<=$2 OR
                EXISTS (
                    SELECT 1 FROM remote_downloadables downloadable
                    WHERE downloadable.source_id=listing.source_id
                      AND downloadable.mod_remote_id=listing.remote_id
                      AND downloadable.retired_at IS NULL
                      AND (
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
