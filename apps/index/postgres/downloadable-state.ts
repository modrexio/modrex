import { createHash } from 'node:crypto'
import type { ContentEntry } from './content-archive.js'
import type { Database, Statement } from './database.js'

export const EXTRACTION_POLICY = 'markers-v4-content-v1'
const revalidateMs = 7 * 24 * 60 * 60 * 1000

export interface Listing {
    source_id: string
    remote_id: string
    name: string
    version: string
    updated_at: string
}

export interface DownloadableInput {
    kind: 'file' | 'link'
    remoteId: number
    url: string
    version: string | null
    objectKey: string | null
    size: number | null
    mediaType: string | null
}

interface DownloadableRow {
    id: string
    status: 'pending' | 'complete' | 'empty' | 'unusable' | 'failed'
    attempts: number
    retry_at: string | null
    next_revalidate_at: string | null
    metadata_fingerprint: string
    has_entries: boolean
    version_observed: boolean
}

export interface DownloadableState extends DownloadableRow {
    input: DownloadableInput
}

function fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function metadataFingerprint(input: DownloadableInput): string {
    const locator =
        input.kind === 'file'
            ? { objectKey: input.objectKey, size: input.size, mediaType: input.mediaType }
            : { url: input.url, version: input.version }
    return fingerprint({
        policy: EXTRACTION_POLICY,
        kind: input.kind,
        remoteId: input.remoteId,
        ...locator,
    })
}

export async function registerDownloadable(
    db: Database,
    listing: Listing,
    input: DownloadableInput,
    now: Date
): Promise<DownloadableState> {
    const metadata = metadataFingerprint(input)
    const rows = await db.query<DownloadableRow>(
        `INSERT INTO remote_downloadables (
            source_id, mod_remote_id, kind, remote_id, metadata_fingerprint,
            url, object_key, size, media_type, status, first_seen_at, last_seen_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$10)
         ON CONFLICT (source_id, mod_remote_id, kind, remote_id) DO UPDATE SET
            url = EXCLUDED.url, object_key = EXCLUDED.object_key,
            size = EXCLUDED.size, media_type = EXCLUDED.media_type,
            status = CASE WHEN remote_downloadables.metadata_fingerprint <> EXCLUDED.metadata_fingerprint
                THEN 'pending' ELSE remote_downloadables.status END,
            attempts = CASE WHEN remote_downloadables.metadata_fingerprint <> EXCLUDED.metadata_fingerprint
                THEN 0 ELSE remote_downloadables.attempts END,
            retry_at = CASE WHEN remote_downloadables.metadata_fingerprint <> EXCLUDED.metadata_fingerprint
                THEN NULL ELSE remote_downloadables.retry_at END,
            metadata_fingerprint = EXCLUDED.metadata_fingerprint, last_seen_at = EXCLUDED.last_seen_at,
            retired_at = NULL
         RETURNING id::TEXT, status, attempts, retry_at, next_revalidate_at,
            metadata_fingerprint,
            EXISTS (SELECT 1 FROM downloadable_observations observation
                    JOIN downloadable_entries entry ON entry.observation_id = observation.id
                    WHERE observation.downloadable_id = remote_downloadables.id
                      AND observation.metadata_fingerprint = $5) AS has_entries,
            EXISTS (SELECT 1 FROM downloadable_observations observation
                    WHERE observation.downloadable_id = remote_downloadables.id
                      AND observation.metadata_fingerprint = $5
                      AND observation.version = COALESCE(NULLIF($11, ''), $12)) AS version_observed`,
        [
            listing.source_id,
            listing.remote_id,
            input.kind,
            input.remoteId,
            metadata,
            input.url,
            input.objectKey,
            input.size,
            input.mediaType,
            now.toISOString(),
            input.version,
            listing.version,
        ]
    )
    if (rows.length !== 1) throw new Error(`Failed to register ${input.kind} ${input.remoteId}`)
    return { ...rows[0], input }
}

export function needsProcessing(state: DownloadableState, now: Date): boolean {
    if (state.status === 'pending') return true
    if (state.status === 'failed')
        return state.retry_at !== null && state.retry_at <= now.toISOString()
    return (
        state.input.kind === 'link' &&
        state.next_revalidate_at !== null &&
        state.next_revalidate_at <= now.toISOString()
    )
}

// ModWorkshop changes a hosted file's object key on replacement. An unchanged hosted
// fingerprint can reuse its observed hashes for a new release label; mutable links cannot.
export async function recordHostedVersion(
    db: Database,
    listing: Listing,
    state: DownloadableState,
    now: Date
): Promise<void> {
    if (
        state.input.kind !== 'file' ||
        state.version_observed ||
        state.status === 'pending' ||
        state.status === 'failed'
    )
        return
    const version = state.input.version || listing.version
    await db.query(
        `WITH source_observation AS MATERIALIZED (
            SELECT observation.* FROM downloadable_observations observation
            WHERE observation.downloadable_id=$1 AND observation.metadata_fingerprint=$2
            ORDER BY observation.observed_at DESC, observation.id DESC LIMIT 1
         ), inserted AS (
            INSERT INTO downloadable_observations (
                downloadable_id, metadata_fingerprint, content_fingerprint,
                version, outcome, observed_at, error
            )
            SELECT downloadable_id, metadata_fingerprint, content_fingerprint,
                $3, outcome, $4, error FROM source_observation
            ON CONFLICT DO NOTHING RETURNING id
         ), target AS (
            SELECT id FROM inserted
            UNION ALL
            SELECT observation.id FROM downloadable_observations observation
            JOIN source_observation source ON source.downloadable_id=observation.downloadable_id
                AND source.metadata_fingerprint=observation.metadata_fingerprint
                AND source.content_fingerprint=observation.content_fingerprint
                AND source.outcome=observation.outcome
            WHERE observation.version=$3
            LIMIT 1
         )
         INSERT INTO downloadable_entries (observation_id, sha256, entry_name)
         SELECT target.id, entry.sha256, entry.entry_name
         FROM target CROSS JOIN source_observation source
         JOIN downloadable_entries entry ON entry.observation_id=source.id
         ON CONFLICT DO NOTHING`,
        [state.id, state.metadata_fingerprint, version, now.toISOString()]
    )
}

function legacyStatements(
    listing: Listing,
    state: DownloadableState,
    entries: ContentEntry[],
    now: Date
): Statement[] {
    if (!entries.length) return []
    const unique = [
        ...new Map(entries.map((entry) => [`${entry.sha256}:${entry.entryName}`, entry])).values(),
    ]
    const downloadId = state.input.kind === 'file' ? state.input.remoteId : -state.input.remoteId
    return [
        {
            text: `INSERT INTO mods (source_id, remote_id, name, url) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (source_id, remote_id) DO UPDATE SET name=EXCLUDED.name, url=EXCLUDED.url`,
            values: [
                listing.source_id,
                listing.remote_id,
                listing.name,
                `https://modworkshop.net/mod/${listing.remote_id}`,
            ],
        },
        {
            text: `INSERT INTO file_contents (sha256)
                 SELECT sha256 FROM jsonb_to_recordset($1::jsonb) entry(sha256 TEXT, entry_name TEXT)
                 ON CONFLICT DO NOTHING`,
            values: [
                JSON.stringify(
                    unique.map((entry) => ({ sha256: entry.sha256, entry_name: entry.entryName }))
                ),
            ],
        },
        {
            text: `INSERT INTO files (mod_id, sha256, remote_id, version, indexed_at, entry_name)
                 SELECT mods.id, entry.sha256, $3, $4, $5, entry.entry_name
                 FROM mods CROSS JOIN jsonb_to_recordset($6::jsonb) entry(sha256 TEXT, entry_name TEXT)
                 WHERE mods.source_id=$1 AND mods.remote_id=$2
                 ON CONFLICT (mod_id, sha256) DO UPDATE SET
                    entry_name=CASE WHEN files.entry_name='' THEN EXCLUDED.entry_name ELSE files.entry_name END`,
            values: [
                listing.source_id,
                listing.remote_id,
                downloadId,
                state.input.version || listing.version,
                now.toISOString(),
                JSON.stringify(
                    unique.map((entry) => ({ sha256: entry.sha256, entry_name: entry.entryName }))
                ),
            ],
        },
    ]
}

export async function settleDownloadable(
    db: Database,
    listing: Listing,
    state: DownloadableState,
    outcome: 'complete' | 'empty' | 'unusable',
    entries: ContentEntry[],
    now: Date,
    error: string | null = null
): Promise<void> {
    const unique = [
        ...new Map(entries.map((entry) => [`${entry.sha256}:${entry.entryName}`, entry])).values(),
    ]
    const content = fingerprint(unique.map((entry) => [entry.sha256, entry.entryName]).sort())
    const observationVersion = state.input.version || listing.version
    const statements = legacyStatements(listing, state, unique, now)
    statements.push(
        {
            text: `INSERT INTO downloadable_observations (
                    downloadable_id, metadata_fingerprint, content_fingerprint, version, outcome, observed_at, error
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            values: [
                state.id,
                state.metadata_fingerprint,
                content,
                observationVersion,
                outcome,
                now.toISOString(),
                error,
            ],
        },
        {
            text: `INSERT INTO downloadable_entries (observation_id, sha256, entry_name)
                 SELECT observation.id, entry.sha256, entry.entry_name
                 FROM downloadable_observations observation
                 CROSS JOIN jsonb_to_recordset($5::jsonb) entry(sha256 TEXT, entry_name TEXT)
                 WHERE observation.downloadable_id=$1 AND observation.metadata_fingerprint=$2
                   AND observation.content_fingerprint=$3 AND observation.version=$4
                 ON CONFLICT DO NOTHING`,
            values: [
                state.id,
                state.metadata_fingerprint,
                content,
                observationVersion,
                JSON.stringify(
                    unique.map((entry) => ({ sha256: entry.sha256, entry_name: entry.entryName }))
                ),
            ],
        },
        {
            text: `UPDATE remote_downloadables SET status=$2, attempts=0, retry_at=NULL,
                    next_revalidate_at=$3, last_processed_at=$4
                 WHERE id=$1`,
            values: [
                state.id,
                outcome,
                state.input.kind === 'link'
                    ? new Date(now.getTime() + revalidateMs).toISOString()
                    : null,
                now.toISOString(),
            ],
        }
    )
    await db.transaction(statements)
}

export async function deferDownloadable(
    db: Database,
    state: DownloadableState,
    now: Date,
    error: string
): Promise<void> {
    const attempts = state.attempts + 1
    const delay = Math.min(24 * 60 * 60 * 1000, 15 * 60 * 1000 * 2 ** Math.min(attempts - 1, 7))
    await db.query(
        `UPDATE remote_downloadables SET status='failed', attempts=$2, retry_at=$3,
            last_processed_at=$4 WHERE id=$1`,
        [state.id, attempts, new Date(now.getTime() + delay).toISOString(), now.toISOString()]
    )
}

export async function finishDiscovery(
    db: Database,
    listing: Listing,
    fileIds: number[],
    hasDownload: boolean,
    now: Date
): Promise<void> {
    await db.transaction([
        {
            text: `UPDATE mod_listings SET has_download=$3 WHERE source_id=$1 AND remote_id=$2`,
            values: [listing.source_id, listing.remote_id, hasDownload],
        },
        {
            text: `INSERT INTO mod_checks (source_id, remote_id, updated_at, file_ids, checked_at)
                 VALUES ($1,$2,$3,$4::jsonb,$5)
                 ON CONFLICT (source_id, remote_id) DO UPDATE SET
                    updated_at=EXCLUDED.updated_at, file_ids=EXCLUDED.file_ids, checked_at=EXCLUDED.checked_at`,
            values: [
                listing.source_id,
                listing.remote_id,
                listing.updated_at,
                JSON.stringify(fileIds),
                now.toISOString(),
            ],
        },
        {
            text: `INSERT INTO mod_reconciliations (
                    source_id, remote_id, last_discovered_at, next_reconcile_at,
                    version_deferred_updated_at
                 ) VALUES ($1,$2,$3,$4,NULL) ON CONFLICT (source_id, remote_id) DO UPDATE SET
                    last_discovered_at=EXCLUDED.last_discovered_at,
                    next_reconcile_at=EXCLUDED.next_reconcile_at,
                    version_deferred_updated_at=NULL`,
            values: [
                listing.source_id,
                listing.remote_id,
                now.toISOString(),
                new Date(now.getTime() + revalidateMs).toISOString(),
            ],
        },
    ])
}

export async function retireMissingDownloadables(
    db: Database,
    listing: Listing,
    kind: DownloadableInput['kind'],
    seenIds: number[],
    now: Date
): Promise<void> {
    await db.query(
        `UPDATE remote_downloadables SET retired_at=$4
         WHERE source_id=$1 AND mod_remote_id=$2 AND kind=$3
           AND NOT (remote_id=ANY($5::BIGINT[])) AND retired_at IS NULL`,
        [listing.source_id, listing.remote_id, kind, now.toISOString(), seenIds]
    )
}
