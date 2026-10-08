import { GAME_IDS, isGameId } from '@modrex/games'
import { neon } from '@neondatabase/serverless'

import { writeSnapshot, type ResourceRow, type SnapshotSource } from './snapshot.js'
import {
    applySnapshotDelta,
    compareResourceRows,
    readPreviousSnapshot,
    resourceRowsQuery,
    snapshotFingerprints,
    snapshotDeltaQuery,
    snapshotSourceQuery,
    type SnapshotDelta,
} from './snapshot-delta.js'

const databaseUrl = process.env.INDEX_DATABASE_URL
if (!databaseUrl) throw new Error('INDEX_DATABASE_URL is required')

const game = process.argv.find((argument) => argument.startsWith('--game='))?.slice(7) ?? null
if (!isGameId(game)) throw new Error(`--game must be one of ${GAME_IDS.join(', ')}`)

const output = process.argv.find((argument) => argument.startsWith('--output='))?.slice(9)
if (!output) throw new Error('--output is required')
const requireFiles = process.argv.includes('--require-files')
const previousPath = process.argv.find((argument) => argument.startsWith('--previous='))?.slice(11)
const previousSha256 = process.argv
    .find((argument) => argument.startsWith('--previous-sha256='))
    ?.slice(18)
if (Boolean(previousPath) !== Boolean(previousSha256))
    throw new Error('--previous and --previous-sha256 must be supplied together')

const previous =
    previousPath && previousSha256
        ? readPreviousSnapshot(previousPath, previousSha256, game)
        : { rows: [] }
const sql = neon(databaseUrl)

// All three queries must observe the same database snapshot, including concurrent catalog edits.
const [catalog, changes, resourceRows] = (await sql.transaction(
    [
        sql.query(snapshotSourceQuery, [game]),
        sql.query(snapshotDeltaQuery, [game, JSON.stringify(snapshotFingerprints(previous.rows))]),
        sql.query(resourceRowsQuery, [game]),
    ],
    { isolationLevel: 'RepeatableRead', readOnly: true }
)) as [SnapshotSource[], SnapshotDelta[], ResourceRow[]]
if (catalog.length !== 1) throw new Error(`missing ModWorkshop catalog source for ${game}`)
const rows = applySnapshotDelta(previous.rows, changes)
const resources = resourceRows.sort(compareResourceRows)
// A game whose only published content is movies or configs still has a catalog to publish.
if (requireFiles && rows.length === 0 && resources.length === 0)
    throw new Error(`no indexed file or resource records exist for ${game}`)

const outputPath = writeSnapshot(output, game, catalog[0], rows, resources)
const transferred = changes.filter((change) => change.record !== null).length
console.log(
    `Exported ${rows.length} file records for ${game} to ${outputPath}; fetched ${transferred} records, removed ${changes.length - transferred} records`
)
console.log(`Exported ${resources.length} resource records`)
