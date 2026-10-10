import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { SnapshotRow, SnapshotSource } from './snapshot.js'

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
    WHERE encode(sha256(convert_to(
        ${fields.map((field) => `octet_length(convert_to(export_rows.${field}, 'UTF8'))::TEXT || ':' || export_rows.${field}`).join(' || ')}
    , 'UTF8')), 'base64') IS DISTINCT FROM previous_rows.fingerprint
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
        rows.map((row) => {
            const digest = createHash('sha256')
            for (const field of fields) {
                const value = row[field]
                digest.update(String(Buffer.byteLength(value)) + ':').update(value)
            }
            return [row.file_id, digest.digest('base64')]
        })
    )
}

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
