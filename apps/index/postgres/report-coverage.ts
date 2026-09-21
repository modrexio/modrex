import { GAME_IDS } from '@modrex/games'
import { neon } from '@neondatabase/serverless'

interface CoverageRow {
    slug: string
    listings: string
    downloadable: string
    pending: string
    version_pending: string
}

const databaseUrl = process.env.INDEX_DATABASE_URL
if (!databaseUrl) throw new Error('INDEX_DATABASE_URL is required')

const sql = neon(databaseUrl)
const reportedAt = new Date().toISOString()
const rows = (await sql`
    WITH version_backlog AS (
        SELECT games.slug, COUNT(*)::TEXT AS pending
        FROM listing_version_pending
        JOIN sources ON sources.id=listing_version_pending.source_id
        JOIN games ON games.id=sources.game_id
        GROUP BY games.slug
    )
    SELECT
        games.slug,
        COUNT(mod_listings.remote_id)::TEXT AS listings,
        COUNT(*) FILTER (WHERE mod_listings.has_download)::TEXT AS downloadable,
        COUNT(DISTINCT (mod_listings.source_id, mod_listings.remote_id)) FILTER (
            WHERE mod_listings.remote_id IS NOT NULL AND (
                  ((mod_checks.remote_id IS NULL OR
                      mod_checks.updated_at <> mod_listings.updated_at) AND (
                      mod_reconciliations.version_deferred_updated_at
                          IS DISTINCT FROM mod_listings.updated_at OR
                      mod_reconciliations.next_reconcile_at <= ${reportedAt}
                  )) OR
                  (mod_checks.updated_at = mod_listings.updated_at AND (
                      mod_reconciliations.remote_id IS NULL OR
                      mod_reconciliations.next_reconcile_at <= ${reportedAt} OR
                      EXISTS (
                          SELECT 1 FROM remote_downloadables
                          WHERE remote_downloadables.source_id=mod_listings.source_id
                            AND remote_downloadables.mod_remote_id=mod_listings.remote_id
                            AND remote_downloadables.retired_at IS NULL
                            AND (
                                remote_downloadables.status='pending' OR
                                (remote_downloadables.status='failed' AND
                                    remote_downloadables.retry_at <= ${reportedAt}) OR
                                (remote_downloadables.kind='link' AND
                                    remote_downloadables.next_revalidate_at <= ${reportedAt})
                            )
                      )
                  )
            )
        )::TEXT AS pending,
        COALESCE((SELECT pending FROM version_backlog WHERE version_backlog.slug=games.slug), '0')
            AS version_pending
    FROM games
    JOIN sources ON sources.game_id = games.id
    LEFT JOIN mod_listings ON mod_listings.source_id = sources.id
    LEFT JOIN mod_checks ON mod_checks.source_id = mod_listings.source_id
                        AND mod_checks.remote_id = mod_listings.remote_id
    LEFT JOIN mod_reconciliations ON mod_reconciliations.source_id = mod_listings.source_id
                                 AND mod_reconciliations.remote_id = mod_listings.remote_id
    GROUP BY games.slug
`) as CoverageRow[]

const coverageByGame = new Map(rows.map((row) => [row.slug, row]))

for (const game of GAME_IDS) {
    const coverage = coverageByGame.get(game)
    const listings = Number(coverage?.listings ?? 0)
    const downloadable = Number(coverage?.downloadable ?? 0)
    const pending = Number(coverage?.pending ?? 0)
    const versionPending = Number(coverage?.version_pending ?? 0)
    console.log(
        `${game}: ${pending} content checks pending of ${listings} listings ` +
            `(${downloadable} advertise downloads); ${versionPending} versions awaiting retry`
    )
}
