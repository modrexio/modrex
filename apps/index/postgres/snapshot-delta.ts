import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { ResourceRow, SnapshotRow, SnapshotSource } from './snapshot.js'

const columns = {
    mod_id: 'mods.id',
    mod_remote_id: 'mods.remote_id',
    mod_name: 'mods.name',
    mod_url: 'mods.url',
    file_id: 'files.id',
    file_sha256: 'files.sha256',
    file_remote_id: 'files.remote_id',
    file_version: 'files.version',
    file_indexed_at: 'files.indexed_at',
    file_entry_name: 'files.entry_name',
} satisfies Record<keyof SnapshotRow, string>
const fields = Object.keys(columns) as Array<keyof SnapshotRow>

const snapshotRowsQuery = `
    SELECT ${Object.entries(columns)
        .map(([field, column]) => `CAST(${column} AS TEXT) AS ${field}`)
        .join(', ')}
    FROM files
    JOIN mods ON mods.id = files.mod_id
    JOIN sources ON sources.id = mods.source_id
    JOIN games ON games.id = sources.game_id
    WHERE games.slug = $1
`

// Every complete observation, current or historical and including retired downloads, so bytes
// that were published once stay recognisable after the upload is replaced or withdrawn.
export const resourceRowsQuery = `
    SELECT DISTINCT CAST(mods.id AS TEXT) AS mod_id,
        CAST(mods.remote_id AS TEXT) AS mod_remote_id,
        mods.name AS mod_name, mods.url AS mod_url,
        entry.sha256 AS sha256, entry.resource_kind AS resource_kind,
        CAST(entry.byte_length AS TEXT) AS byte_length
    FROM downloadable_entries entry
    JOIN downloadable_observations observation ON observation.id = entry.observation_id
    JOIN remote_downloadables downloadable ON downloadable.id = observation.downloadable_id
    JOIN mods ON mods.source_id = downloadable.source_id
        AND mods.remote_id = downloadable.mod_remote_id
    JOIN sources ON sources.id = downloadable.source_id
    JOIN games ON games.id = sources.game_id
    WHERE games.slug = $1 AND observation.outcome = 'complete'
      AND entry.resource_kind IS NOT NULL
`

export const snapshotSourceQuery = `
    SELECT CAST(games.id AS TEXT) AS game_id, games.name AS game_name,
           games.slug AS game_slug, CAST(sources.id AS TEXT) AS source_id,
           sources.name AS source_name, sources.base_url AS source_base_url,
           sources.game_ref AS source_game_ref
    FROM sources
    JOIN games ON games.id = sources.game_id
    WHERE games.slug = $1 AND sources.name = 'modworkshop'
`

// test-snapshot-delta.ts enforces byte-length framing parity with PostgreSQL.
function framedDigestSql(alias: string, names: readonly string[]): string {
    return `encode(sha256(convert_to(
        ${names.map((name) => `octet_length(convert_to(${alias}.${name}, 'UTF8'))::TEXT || ':' || ${alias}.${name}`).join(' || ')}
    , 'UTF8')), 'base64')`
}

function framedDigest(values: string[]): string {
    const digest = createHash('sha256')
    for (const value of values) digest.update(String(Buffer.byteLength(value)) + ':').update(value)
    return digest.digest('base64')
}

export const snapshotDeltaQuery = `
    WITH export_rows AS (${snapshotRowsQuery}),
    previous_rows AS (
        SELECT key AS file_id, value AS fingerprint FROM jsonb_each_text($2::JSONB)
    )
    SELECT COALESCE(export_rows.file_id, previous_rows.file_id) AS file_id,
        CASE WHEN export_rows.file_id IS NOT NULL
            THEN jsonb_build_array(${fields.map((field) => `export_rows.${field}`).join(', ')})
        END AS record
    FROM export_rows
    FULL JOIN previous_rows USING (file_id)
    WHERE ${framedDigestSql('export_rows', fields)} IS DISTINCT FROM previous_rows.fingerprint
    ORDER BY COALESCE(export_rows.file_id, previous_rows.file_id)::BIGINT
`

export interface SnapshotDelta {
    file_id: string
    record: string[] | null
}

export interface PreviousSnapshot {
    source: SnapshotSource
    rows: SnapshotRow[]
}

export function snapshotFingerprints(rows: SnapshotRow[]): Record<string, string> {
    return Object.fromEntries(
        rows.map((row) => [row.file_id, framedDigest(fields.map((field) => row[field]))])
    )
}

function compareBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

// Byte order rather than a database collation, so shard bytes never depend on server locale.
export function compareResourceRows(left: ResourceRow, right: ResourceRow): number {
    const a = BigInt(left.mod_id)
    const b = BigInt(right.mod_id)
    if (a !== b) return a < b ? -1 : 1
    return (
        compareBytes(left.sha256, right.sha256) ||
        compareBytes(left.resource_kind, right.resource_kind)
    )
}

// Only files feed the delta, so any resource_entries shape in the previous shard is ignored.
export function readPreviousSnapshot(
    file: string,
    expectedSha256: string,
    game: string
): PreviousSnapshot {
    const bytes = readFileSync(file)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expectedSha256)
        throw new Error(`Snapshot checksum mismatch for ${game}: ${file}`)

    const db = new Database(bytes, { readonly: true })
    try {
        const sources = db
            .prepare(snapshotSourceQuery.replaceAll('$1', '?'))
            .all(game) as SnapshotSource[]
        if (sources.length !== 1) throw new Error(`Missing snapshot catalog source for ${game}`)
        const rows = db
            .prepare(snapshotRowsQuery.replaceAll('$1', '?') + ' ORDER BY files.id')
            .all(game) as SnapshotRow[]
        return { source: sources[0], rows }
    } finally {
        db.close()
    }
}

export function applySnapshotDelta(
    previous: SnapshotRow[],
    changes: SnapshotDelta[]
): SnapshotRow[] {
    const rows = new Map(previous.map((row) => [row.file_id, row]))
    for (const change of changes) {
        if (change.record === null) {
            rows.delete(change.file_id)
            continue
        }
        const values = change.record
        const row = {} as SnapshotRow
        for (const [i, field] of fields.entries()) row[field] = values[i]
        rows.set(change.file_id, row)
    }
    return [...rows.values()].sort((left, right) => {
        const a = BigInt(left.file_id)
        const b = BigInt(right.file_id)
        return a < b ? -1 : a > b ? 1 : 0
    })
}
