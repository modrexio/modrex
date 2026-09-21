import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import Sqlite from 'better-sqlite3'
import type { Database, Statement } from './postgres/database.js'
import { syncGameListings } from './postgres/listing-sync.js'
import { ModWorkshop, parseFile, parseVersions } from './postgres/modworkshop.js'
import { migrations } from './postgres/schema.js'
import {
    deferDownloadable,
    finishDiscovery,
    needsProcessing,
    recordHostedVersion,
    registerDownloadable,
    retireMissingDownloadables,
    settleDownloadable,
    type DownloadableInput,
    type Listing,
} from './postgres/downloadable-state.js'
import { refreshContentVersions, selectContentListings } from './postgres/content-selection.js'
import { writeSnapshot, type SnapshotRow, type SnapshotSource } from './postgres/snapshot.js'

const productionMigrationChecksums = new Map([
    ['001_initial', '40465f9f3018532f3caee2e76581d86ed4d9584639c44436a5dacbdc8e107b09'],
    ['002_mod_listings', 'c48042b9591611ad4ea1e4b3f7a2eb7fad07daba00a747597f56900132594879'],
    [
        '003_recheck_empty_listings',
        '066964471edae2dba12504729785a0e3ebaf13306881859e91cae88dda8311d2',
    ],
    [
        '004_recheck_markerless_picks',
        '0376948ad49c89fdfdd6db19a70da83b59b50bc63cc1f18acb1f02159d441873',
    ],
    [
        '005_recheck_rar4_listings',
        '20314514fa28194a54407d51ee7ff3e8a9a1b464d9ba95e04aecb9f5788fc38c',
    ],
])

for (const migration of migrations.slice(0, 5)) {
    const checksum = createHash('sha256').update(migration.statements.join('\n')).digest('hex')
    assert.equal(
        checksum,
        productionMigrationChecksums.get(migration.version),
        `${migration.version} must remain byte-compatible with its production checksum`
    )
}

function database(pg: PGlite): Database {
    return {
        query: async <T>(text: string, values: unknown[] = []) =>
            (await pg.query<T>(text, values)).rows,
        async transaction(statements: Statement[]) {
            await pg.transaction(async (tx) => {
                for (const statement of statements) await tx.query(statement.text, statement.values)
            })
        },
    }
}

async function catalog(): Promise<{ pg: PGlite; db: Database }> {
    const pg = new PGlite('memory://')
    for (const migration of migrations) {
        for (const statement of migration.statements) await pg.exec(statement)
    }
    await pg.exec(`
        INSERT INTO games (name, slug) VALUES ('PAYDAY 2', 'pd2');
        INSERT INTO sources (game_id, name, base_url, game_ref)
        SELECT id, 'modworkshop', 'https://modworkshop.net', '1' FROM games;
    `)
    return { pg, db: database(pg) }
}

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

function listing(id: number) {
    return {
        id,
        name: `Mod ${id}`,
        has_download: true,
        bumped_at: '2026-09-20T12:00:00.000Z',
        updated_at: '2026-09-20T12:00:00.000Z',
        download_id: null,
        download_type: null,
    }
}

assert.deepEqual([...parseVersions([], [1])], [[1, { status: 'missing' }]])
assert.deepEqual([...parseVersions({ 1: '' }, [1])], [[1, { status: 'known', version: '' }]])
assert.throws(() => parseVersions({ 2: 'unexpected' }, [1]))
assert.deepEqual(
    parseFile({ id: 1, file: '', size: 1, type: 'zip', version: '', download_url: '' }),
    { id: 1, file: '', size: 1, type: 'zip', version: '', download_url: '' }
)

{
    const batches: number[][] = []
    const api = new ModWorkshop(
        'https://api.test',
        async (request) => {
            const ids = new URL(String(request)).searchParams.getAll('mod_ids[]').map(Number)
            batches.push(ids)
            return response(Object.fromEntries(ids.map((id) => [id, `opaque-${id}`])))
        },
        async () => {},
        () => 0
    )
    assert.equal((await api.versions([])).size, 0)
    const versions = await api.versions([
        ...Array.from({ length: 101 }, (_, index) => index + 1),
        1,
    ])
    assert.deepEqual(
        batches.map((batch) => batch.length),
        [100, 1]
    )
    assert.equal(versions.get(101)?.status, 'known')
}

{
    let requests = 0
    const api = new ModWorkshop(
        'https://api.test',
        async (request) => {
            requests++
            const ids = new URL(String(request)).searchParams.getAll('mod_ids[]').map(Number)
            if (ids.includes(101)) return response({}, 503)
            return response(Object.fromEntries(ids.map((id) => [id, 'known'])))
        },
        async () => {},
        () => 0
    )
    const versions = await api.versions(Array.from({ length: 101 }, (_, index) => index + 1))
    assert.equal(versions.get(1)?.status, 'known')
    assert.equal(versions.get(101)?.status, 'failed')
    assert.equal(requests, 5, 'the failed chunk retries without discarding the successful chunk')
}

{
    const { pg, db } = await catalog()
    const fetcher: typeof fetch = async (request) => {
        const url = new URL(String(request))
        if (url.pathname === '/games/1/mods')
            return response({
                data: [listing(1), listing(2)],
                meta: { current_page: 1, last_page: 1 },
            })
        return response({ 1: '', 2: 'release train' })
    }
    const api = new ModWorkshop(
        'https://api.test',
        fetcher,
        async () => {},
        () => 0
    )
    const at = new Date('2026-09-20T12:05:00.000Z')
    const result = await syncGameListings(db, api, 'pd2', 1, at)
    assert.deepEqual({ stored: result.stored, pending: result.pending }, { stored: 2, pending: 0 })
    const stored = await pg.query<{ remote_id: string; version: string }>(
        'SELECT remote_id::TEXT, version FROM mod_listings ORDER BY remote_id'
    )
    assert.deepEqual(stored.rows, [
        { remote_id: '1', version: '' },
        { remote_id: '2', version: 'release train' },
    ])
    assert.equal(api.counts.requests, 2, 'one listing page plus one version batch')
    await pg.close()
}

{
    const { pg, db } = await catalog()
    const source = (await pg.query<{ id: string }>('SELECT id::TEXT FROM sources')).rows[0].id
    const at = new Date('2026-09-20T13:00:00.000Z')
    await pg.query(
        `INSERT INTO mod_listings (source_id, remote_id, name, version, has_download,
            bumped_at, updated_at, download_id, download_type)
         VALUES ($1,41,'Interrupted','v',TRUE,$2,$2,NULL,NULL)`,
        [source, at.toISOString()]
    )
    const listingRow: Listing = {
        source_id: source,
        remote_id: '41',
        name: 'Interrupted',
        version: 'v',
        updated_at: at.toISOString(),
    }
    await finishDiscovery(db, listingRow, [], true, at)
    await registerDownloadable(
        db,
        listingRow,
        {
            kind: 'file',
            remoteId: 410,
            url: 'https://storage.test/interrupted.zip',
            version: 'v',
            objectKey: 'interrupted.zip',
            size: 10,
            mediaType: 'zip',
        },
        at
    )
    assert.equal(
        (await selectContentListings(db, 'pd2', 1, at))[0].remote_id,
        '41',
        'a crash after registration leaves pending downloadable work immediately selectable'
    )
    await pg.close()
}

{
    const { pg, db } = await catalog()
    const source = (await pg.query<{ id: string }>('SELECT id::TEXT FROM sources')).rows[0].id
    await pg.query(
        `INSERT INTO mod_listings (source_id, remote_id, name, version, has_download,
            bumped_at, updated_at, download_id, download_type)
         VALUES ($1,40,'No download yet','v',FALSE,$2,$2,NULL,NULL)`,
        [source, '2026-09-20T12:00:00.000Z']
    )
    const selected = await selectContentListings(db, 'pd2', 1, new Date('2026-09-20T13:00:00.000Z'))
    assert.equal(
        selected[0].remote_id,
        '40',
        'a listing with no download still receives bounded discovery'
    )
    await finishDiscovery(db, selected[0], [], true, new Date('2026-09-20T13:00:00.000Z'))
    assert.equal(
        (
            await pg.query<{ has_download: boolean }>(
                'SELECT has_download FROM mod_listings WHERE remote_id=40'
            )
        ).rows[0].has_download,
        true,
        'file and link discovery can recover a listing that gained its first download without a bump'
    )
    await pg.close()
}

{
    const { pg, db } = await catalog()
    const source = (await pg.query<{ id: string }>('SELECT id::TEXT FROM sources')).rows[0].id
    await pg.query(
        `INSERT INTO mod_listings (source_id, remote_id, name, version, has_download,
            bumped_at, updated_at, download_id, download_type)
         VALUES ($1,1,'One','stale',TRUE,$2,$2,NULL,NULL),
                ($1,2,'Two','kept',TRUE,$2,$2,NULL,NULL),
                ($1,3,'Three','also-kept',TRUE,$2,$2,NULL,NULL)`,
        [source, '2026-09-20T12:00:00.000Z']
    )
    await pg.query(
        `INSERT INTO mod_checks (source_id, remote_id, updated_at, file_ids, checked_at)
         VALUES ($1,2,'2026-09-19T12:00:00.000Z','[]','2026-09-19T13:00:00.000Z')`,
        [source]
    )
    await pg.query(
        `INSERT INTO mod_reconciliations (
            source_id, remote_id, last_discovered_at, next_reconcile_at
         ) VALUES ($1,2,'2026-09-19T13:00:00.000Z','2026-09-26T13:00:00.000Z')`,
        [source]
    )
    const api = new ModWorkshop(
        'https://api.test',
        async (request) => {
            const ids = new URL(String(request)).searchParams.getAll('mod_ids[]').map(Number)
            assert.deepEqual(ids, [1, 2, 3])
            return response({ 1: '', 3: 'not semver' })
        },
        async () => {},
        () => 0
    )
    const listings = await db.query<Listing>(
        `SELECT source_id::TEXT, remote_id::TEXT, name, version, updated_at
         FROM mod_listings ORDER BY remote_id`
    )
    const refreshed = await refreshContentVersions(
        db,
        api,
        listings,
        new Date('2026-09-20T13:00:00.000Z')
    )
    assert.deepEqual(
        {
            updated: refreshed.updated,
            missing: refreshed.missing,
            failed: refreshed.failed,
            processable: refreshed.processable.map((listing) => listing.remote_id),
        },
        { updated: 2, missing: 1, failed: 0, processable: ['1', '3'] }
    )
    assert.deepEqual(
        (
            await pg.query<{ remote_id: string; version: string }>(
                'SELECT remote_id::TEXT, version FROM mod_listings ORDER BY remote_id'
            )
        ).rows,
        [
            { remote_id: '1', version: '' },
            { remote_id: '2', version: 'kept' },
            { remote_id: '3', version: 'not semver' },
        ],
        'bounded content reconciliation refreshes authoritative versions without fabricating missing values'
    )
    assert.equal(
        (
            await pg.query<{ next_reconcile_at: string }>(
                'SELECT next_reconcile_at FROM mod_reconciliations WHERE remote_id=2'
            )
        ).rows[0].next_reconcile_at,
        '2026-09-27T13:00:00.000Z',
        'content with an omitted authoritative version is deferred instead of mislabeled'
    )
    assert.equal(
        (await selectContentListings(db, 'pd2', 10, new Date('2026-09-20T14:00:00.000Z'))).some(
            (listing) => listing.remote_id === '2'
        ),
        false,
        'a changed listing with a deferred version check does not retry every refresh'
    )
    await pg.close()
}

{
    const { pg, db } = await catalog()
    let versions = 0
    const fetcher: typeof fetch = async (request) => {
        const url = new URL(String(request))
        if (url.pathname.includes('/games/'))
            return response({
                data: [listing(3), listing(3)],
                meta: { current_page: 1, last_page: 1 },
            })
        versions++
        return response(versions === 1 ? [] : { 3: 'recovered' })
    }
    const api = new ModWorkshop(
        'https://api.test',
        fetcher,
        async () => {},
        () => 0
    )
    await syncGameListings(db, api, 'pd2', 1, new Date('2026-09-20T12:00:00.000Z'))
    assert.equal((await pg.query('SELECT * FROM mod_listings')).rows.length, 0)
    assert.equal((await pg.query('SELECT * FROM listing_version_pending')).rows.length, 1)
    await syncGameListings(db, api, 'pd2', 1, new Date('2026-09-20T12:00:30.000Z'))
    assert.equal(
        (await pg.query<{ attempts: number }>('SELECT attempts FROM listing_version_pending'))
            .rows[0].attempts,
        1,
        'the listing overlap does not bypass a scheduled version retry'
    )
    assert.equal(versions, 1, 'no version request is made before the retry is due')
    await pg.exec("UPDATE listing_version_pending SET next_retry_at = '2026-09-20T12:01:00.000Z'")
    await syncGameListings(db, api, 'pd2', 1, new Date('2026-09-20T12:02:00.000Z'))
    assert.equal((await pg.query('SELECT * FROM listing_version_pending')).rows.length, 0)
    assert.equal(
        (await pg.query("SELECT * FROM mod_listings WHERE version = 'recovered'")).rows.length,
        1
    )
    await pg.close()
}

{
    const { pg, db } = await catalog()
    await pg.exec(`INSERT INTO file_contents (sha256) VALUES ('historical');
        INSERT INTO mods (source_id, remote_id, name, url) SELECT id, 99, 'History', 'u' FROM sources;
        INSERT INTO files (mod_id, sha256, remote_id, version, indexed_at, entry_name)
        SELECT id, 'historical', 9, 'old', '2020-01-01', 'mod.txt' FROM mods;`)
    const before = await pg.query('SELECT * FROM files')
    let transactions = 0
    const bad: Database = {
        ...db,
        async transaction(statements) {
            transactions++
            if (transactions === 2) throw new Error('simulated checkpoint failure')
            await pg.transaction(async (tx) => {
                for (const statement of statements) await tx.query(statement.text, statement.values)
            })
        },
    }
    const api = new ModWorkshop(
        'https://api.test',
        async (request) => {
            const url = new URL(String(request))
            return url.pathname.includes('/games/')
                ? response({ data: [listing(4)], meta: { current_page: 1, last_page: 1 } })
                : response({ 4: 'new' })
        },
        async () => {},
        () => 0
    )
    await assert.rejects(syncGameListings(bad, api, 'pd2', 1), /simulated checkpoint failure/)
    assert.equal(
        (await pg.query('SELECT * FROM mod_listings')).rows.length,
        1,
        'completed pages remain durable when the final checkpoint write fails'
    )
    assert.equal(
        (await pg.query("SELECT * FROM metadata WHERE key='listings_last_run_at:pd2'")).rows.length,
        0,
        'the checkpoint never advances past a failed run'
    )
    assert.deepEqual(
        (await pg.query('SELECT * FROM files')).rows,
        before.rows,
        'historical identification rows survive recovery'
    )
    await syncGameListings(db, api, 'pd2', 1)
    assert.equal(
        (await pg.query('SELECT * FROM mod_listings')).rows.length,
        1,
        'replaying the committed page is idempotent'
    )
    await pg.close()
}

{
    const pg = new PGlite('memory://')
    for (const migration of migrations.slice(0, 5)) {
        for (const statement of migration.statements) await pg.exec(statement)
    }
    const db = database(pg)
    await pg.exec(`
        INSERT INTO games (name, slug) VALUES ('PAYDAY 2', 'pd2');
        INSERT INTO sources (game_id, name, base_url, game_ref)
            SELECT id, 'modworkshop', 'https://modworkshop.net', '1' FROM games;
        INSERT INTO mod_listings (
            source_id, remote_id, name, version, has_download, bumped_at, updated_at,
            download_id, download_type
        ) SELECT id, 1, 'Existing', 'old', TRUE,
            '2026-09-18T15:00:00.000Z', '2026-09-18T15:00:00.000Z', 10, 'file'
          FROM sources;
        INSERT INTO mod_listings (
            source_id, remote_id, name, version, has_download, bumped_at, updated_at,
            download_id, download_type
        ) SELECT id, 2, 'Partially refreshed', 'partial', TRUE,
            '2026-09-19T14:00:00.000Z', '2026-09-19T14:00:00.000Z', 20, 'file'
          FROM sources;
        INSERT INTO metadata (key, value)
            VALUES ('listings_last_run_at:pd2', '2026-09-18T15:00:17.000Z');
        INSERT INTO mods (source_id, remote_id, name, url)
            SELECT id, 1, 'Existing', 'https://modworkshop.net/mod/1' FROM sources;
        INSERT INTO file_contents (sha256) VALUES ('historical-hash');
        INSERT INTO files (mod_id, sha256, remote_id, version, indexed_at, entry_name)
            SELECT id, 'historical-hash', 10, 'old', '2026-09-18T15:00:00.000Z', 'mod.txt'
            FROM mods;
        INSERT INTO mod_checks (source_id, remote_id, updated_at, file_ids, checked_at)
            SELECT id, 1, '2026-09-18T15:00:00.000Z', '[10]', '2026-09-18T15:00:00.000Z'
            FROM sources;
    `)
    const before = await pg.query('SELECT * FROM files')
    await assert.rejects(
        pg.transaction(async (tx) => {
            await tx.exec(migrations[5].statements[0])
            await tx.exec(migrations[5].statements[1])
            throw new Error('simulated migration interruption')
        }),
        /simulated migration interruption/
    )
    assert.equal(
        (
            await pg.query<{ name: string }>(
                "SELECT table_name AS name FROM information_schema.tables WHERE table_name='listing_version_pending'"
            )
        ).rows.length,
        0,
        'an interrupted migration leaves none of its schema behind'
    )
    await db.transaction(
        migrations[5].statements.map((text) => ({
            text,
            values: [],
        }))
    )

    let failAfterFirstPage = true
    const fetcher: typeof fetch = async (request) => {
        const url = new URL(String(request))
        if (url.pathname === '/games/1/mods') {
            const page = Number(url.searchParams.get('page'))
            if (page === 2 && failAfterFirstPage) throw new Error('simulated interrupted refresh')
            return response({
                data:
                    page === 1
                        ? [
                              {
                                  ...listing(2),
                                  bumped_at: '2026-09-20T14:00:00.000Z',
                                  updated_at: '2026-09-20T14:00:00.000Z',
                              },
                          ]
                        : [
                              {
                                  ...listing(1),
                                  bumped_at: '2026-09-19T14:00:00.000Z',
                                  updated_at: '2026-09-19T14:00:00.000Z',
                              },
                          ],
                meta: { current_page: page, last_page: 2 },
            })
        }
        const ids = url.searchParams.getAll('mod_ids[]').map(Number)
        return response(Object.fromEntries(ids.map((id) => [id, id === 1 ? 'current' : 'new'])))
    }
    const api = new ModWorkshop(
        'https://api.test',
        fetcher,
        async () => {},
        () => 0
    )
    const recoveredAt = new Date('2026-09-20T15:00:00.000Z')
    await assert.rejects(
        syncGameListings(db, api, 'pd2', 1, recoveredAt),
        /simulated interrupted refresh/
    )
    assert.equal(
        (await pg.query("SELECT * FROM mod_listings WHERE remote_id=2 AND version='partial'")).rows
            .length,
        1,
        'an interrupted refresh leaves an earlier partial row recoverable'
    )
    assert.equal(
        (
            await pg.query<{ value: string }>(
                "SELECT value FROM metadata WHERE key='listings_last_run_at:pd2'"
            )
        ).rows[0].value,
        '2026-09-18T15:00:17.000Z',
        'an interrupted run leaves the production checkpoint at its last success'
    )

    failAfterFirstPage = false
    await syncGameListings(db, api, 'pd2', 1, recoveredAt)
    assert.deepEqual(
        (
            await pg.query<{ remote_id: string; version: string }>(
                'SELECT remote_id::TEXT, version FROM mod_listings ORDER BY remote_id'
            )
        ).rows,
        [
            { remote_id: '1', version: 'current' },
            { remote_id: '2', version: 'new' },
        ],
        'the next normal run recovers both outage days without a checkpoint rewind'
    )
    assert.equal(
        (
            await pg.query<{ value: string }>(
                "SELECT value FROM metadata WHERE key='listings_last_run_at:pd2'"
            )
        ).rows[0].value,
        recoveredAt.toISOString()
    )
    assert.deepEqual(
        (await pg.query('SELECT * FROM files')).rows,
        before.rows,
        'the additive migration and listing recovery preserve historical hashes'
    )
    const recovered = (await selectContentListings(db, 'pd2', 1, recoveredAt))[0]
    assert.equal(
        recovered.remote_id,
        '2',
        'a newly recovered listing immediately enters bounded content processing'
    )
    const downloadable = await registerDownloadable(
        db,
        recovered,
        {
            kind: 'file',
            remoteId: 20,
            url: 'https://storage.test/new.zip',
            version: 'new',
            objectKey: 'new-object.zip',
            size: 100,
            mediaType: 'zip',
        },
        recoveredAt
    )
    await settleDownloadable(
        db,
        recovered,
        downloadable,
        'complete',
        [{ sha256: 'recovered-hash', entryName: 'mod.txt' }],
        recoveredAt
    )
    await finishDiscovery(db, recovered, [20], true, recoveredAt)

    const rows = (
        await pg.query<SnapshotRow>(`SELECT mods.id::TEXT AS mod_id,
            mods.remote_id::TEXT AS mod_remote_id, mods.name AS mod_name, mods.url AS mod_url,
            files.id::TEXT AS file_id, files.sha256 AS file_sha256,
            files.remote_id::TEXT AS file_remote_id, files.version AS file_version,
            files.indexed_at AS file_indexed_at, files.entry_name AS file_entry_name
          FROM files JOIN mods ON mods.id=files.mod_id ORDER BY files.id`)
    ).rows
    const source = (
        await pg.query<SnapshotSource>(`SELECT games.id::TEXT AS game_id, games.name AS game_name,
            games.slug AS game_slug, sources.id::TEXT AS source_id, sources.name AS source_name,
            sources.base_url AS source_base_url, sources.game_ref AS source_game_ref
          FROM sources JOIN games ON games.id=sources.game_id`)
    ).rows[0]
    const output = mkdtempSync(join(tmpdir(), 'modrex-recovery-'))
    try {
        const snapshot = writeSnapshot(join(output, 'pd2.db'), 'pd2', source, rows)
        const sqlite = new Sqlite(snapshot, { readonly: true })
        try {
            assert.deepEqual(
                sqlite.prepare('SELECT sha256 FROM files ORDER BY id').pluck().all(),
                ['historical-hash', 'recovered-hash'],
                'the first complete export after recovery contains old and newly reconciled hashes'
            )
        } finally {
            sqlite.close()
        }
    } finally {
        rmSync(output, { recursive: true, force: true })
    }
    await pg.close()
}

{
    const { pg, db } = await catalog()
    const source = (await pg.query<{ id: string }>('SELECT id::TEXT FROM sources')).rows[0].id
    const mod: Listing = {
        source_id: source,
        remote_id: '10',
        name: 'History',
        version: 'current',
        updated_at: '2026-09-20T12:00:00.000Z',
    }
    const file: DownloadableInput = {
        kind: 'file',
        remoteId: 100,
        url: 'https://storage.test/a',
        version: 'one',
        objectKey: 'object-a.zip',
        size: 100,
        mediaType: 'zip',
    }
    const at = new Date('2026-09-20T12:00:00.000Z')
    const first = await registerDownloadable(db, mod, file, at)
    assert.equal(needsProcessing(first, at), true)
    await settleDownloadable(
        db,
        mod,
        first,
        'complete',
        [{ sha256: 'same-marker', entryName: 'mod.txt' }],
        at
    )

    const metadataOnly = await registerDownloadable(db, mod, { ...file, version: 'two' }, at)
    assert.equal(
        needsProcessing(metadataOnly, at),
        false,
        'version metadata alone does not redownload bytes'
    )
    await recordHostedVersion(db, mod, metadataOnly, at)
    assert.equal(
        (await pg.query("SELECT * FROM downloadable_observations WHERE version IN ('one', 'two')"))
            .rows.length,
        2,
        'a metadata-only release keeps the proven hash relationship without extraction'
    )
    const alreadyObserved = await registerDownloadable(db, mod, { ...file, version: 'two' }, at)
    assert.equal(alreadyObserved.version_observed, true)
    await recordHostedVersion(db, mod, alreadyObserved, at)
    assert.equal(
        (await pg.query('SELECT * FROM downloadable_observations')).rows.length,
        2,
        'an already observed release costs no additional history row'
    )
    const replacementInput = { ...file, objectKey: 'object-b.zip' }
    const replacement = await registerDownloadable(db, mod, replacementInput, at)
    assert.equal(
        needsProcessing(replacement, at),
        true,
        'same file ID with a new storage object is a new revision'
    )
    assert.equal(
        replacement.has_entries,
        false,
        'a new revision does not inherit older revision entries'
    )
    await settleDownloadable(
        db,
        mod,
        replacement,
        'complete',
        [{ sha256: 'same-marker', entryName: 'mod.txt' }],
        at
    )
    assert.equal(
        (await pg.query('SELECT * FROM files')).rows.length,
        1,
        'legacy hash identity stays deduplicated'
    )
    assert.equal(
        (await pg.query('SELECT * FROM downloadable_observations')).rows.length,
        3,
        'remote revisions and release labels retain observations when their marker hash is identical'
    )
    await retireMissingDownloadables(db, mod, 'file', [], at)
    assert.equal(
        (await pg.query('SELECT * FROM remote_downloadables WHERE retired_at IS NOT NULL')).rows
            .length,
        1,
        'removed upstream downloads are retired without deleting their history'
    )
    await registerDownloadable(db, mod, replacementInput, at)
    assert.equal(
        (await pg.query('SELECT * FROM remote_downloadables WHERE retired_at IS NULL')).rows.length,
        1,
        'a reappearing ID becomes current again'
    )

    const empty = await registerDownloadable(
        db,
        mod,
        { ...file, remoteId: 101, objectKey: 'empty.zip' },
        at
    )
    await settleDownloadable(db, mod, empty, 'empty', [], at)
    const emptyAgain = await registerDownloadable(
        db,
        mod,
        { ...file, remoteId: 101, objectKey: 'empty.zip' },
        at
    )
    assert.equal(needsProcessing(emptyAgain, at), false, 'successful empty is a settled result')

    const duplicated = await registerDownloadable(
        db,
        mod,
        { ...file, remoteId: 103, objectKey: 'duplicated.zip' },
        at
    )
    await settleDownloadable(
        db,
        mod,
        duplicated,
        'complete',
        [
            { sha256: 'shared-content', entryName: 'a/mod.txt' },
            { sha256: 'shared-content', entryName: 'b/mod.txt' },
        ],
        at
    )
    assert.deepEqual(
        (
            await pg.query<{ entry_name: string }>(
                "SELECT entry_name FROM files WHERE sha256='shared-content'"
            )
        ).rows,
        [{ entry_name: 'a/mod.txt' }],
        'one archive shipping the same content under two names stores one files row'
    )
    assert.equal(
        (await pg.query("SELECT * FROM downloadable_entries WHERE sha256='shared-content'")).rows
            .length,
        2,
        'the observation keeps every entry name'
    )

    const sibling = await registerDownloadable(
        db,
        mod,
        { ...file, remoteId: 102, objectKey: 'failed.zip' },
        at
    )
    await deferDownloadable(db, sibling, at, 'temporary host failure')
    const completedAgain = await registerDownloadable(db, mod, replacementInput, at)
    assert.equal(
        needsProcessing(completedAgain, at),
        false,
        'a failed sibling does not reopen successful files'
    )
    assert.equal(
        needsProcessing(
            await registerDownloadable(
                db,
                mod,
                { ...file, remoteId: 102, objectKey: 'failed.zip' },
                at
            ),
            at
        ),
        false,
        'retry waits for its due time'
    )

    const link = await registerDownloadable(
        db,
        mod,
        {
            kind: 'link',
            remoteId: 5,
            url: 'https://mutable.test/archive.zip',
            version: null,
            objectKey: null,
            size: null,
            mediaType: null,
        },
        at
    )
    await settleDownloadable(
        db,
        mod,
        link,
        'complete',
        [{ sha256: 'link-marker', entryName: 'mod.txt' }],
        at
    )
    const versionChangedAt = new Date('2026-09-20T12:01:00.000Z')
    const versionedLink = await registerDownloadable(
        db,
        mod,
        { ...link.input, version: 'release-two' },
        versionChangedAt
    )
    assert.equal(
        needsProcessing(versionedLink, versionChangedAt),
        true,
        'an explicit external-link version change is a new revision'
    )
    await settleDownloadable(
        db,
        mod,
        versionedLink,
        'complete',
        [{ sha256: 'link-marker', entryName: 'mod.txt' }],
        versionChangedAt
    )
    const weekLater = new Date('2026-09-27T12:01:00.000Z')
    const updatedLink = await registerDownloadable(db, mod, versionedLink.input, weekLater)
    assert.equal(
        needsProcessing(updatedLink, weekLater),
        true,
        'mutable links are revalidated on a bounded schedule'
    )
    await settleDownloadable(
        db,
        mod,
        updatedLink,
        'complete',
        [{ sha256: 'link-marker', entryName: 'mod.txt' }],
        weekLater
    )
    assert.equal(
        (
            await pg.query(
                "SELECT * FROM downloadable_observations WHERE version IN ('current', 'release-two')"
            )
        ).rows.length,
        2,
        'the same marker hash can remain associated with multiple advertised releases'
    )
    const movedLink = await registerDownloadable(
        db,
        mod,
        { ...updatedLink.input, url: 'https://mutable.test/replaced.zip' },
        weekLater
    )
    assert.equal(
        needsProcessing(movedLink, weekLater),
        true,
        'an external URL change is a new revision'
    )

    await finishDiscovery(db, mod, [100, -5], true, at)
    assert.equal((await pg.query('SELECT * FROM mod_reconciliations')).rows.length, 1)
    await pg.close()
}

{
    const { pg, db } = await catalog()
    const source = (await pg.query<{ id: string }>('SELECT id::TEXT FROM sources')).rows[0].id
    for (let id = 1; id <= 12; id++) {
        await pg.query(
            `INSERT INTO mod_listings (source_id, remote_id, name, version, has_download,
                bumped_at, updated_at, download_id, download_type)
             VALUES ($1,$2,$3,'v',TRUE,$4,$4,NULL,NULL)`,
            [source, id, `Mod ${id}`, `2026-09-20T12:${String(id).padStart(2, '0')}:00.000Z`]
        )
        if (id >= 9)
            await pg.query(
                `INSERT INTO mod_checks (source_id, remote_id, updated_at, file_ids, checked_at)
             VALUES ($1,$2,$3,'[]','2026-09-19')`,
                [source, id, `2026-09-20T12:${String(id).padStart(2, '0')}:00.000Z`]
            )
    }
    const selected = await selectContentListings(db, 'pd2', 8, new Date('2026-09-20T13:00:00.000Z'))
    assert.equal(selected.length, 8)
    assert.equal(
        selected.filter((row) => Number(row.remote_id) >= 9).length,
        2,
        'one quarter of each ordinary run is reserved for bounded reconciliation'
    )
    assert.deepEqual(
        selected.slice(2).map((row) => Number(row.remote_id)),
        [8, 7, 6, 5, 4, 3],
        'fresh discoveries fill the remaining budget newest first'
    )
    const one = await selectContentListings(db, 'pd2', 1, new Date('2026-09-20T13:00:00.000Z'))
    assert.equal(
        Number(one[0].remote_id) >= 9,
        true,
        'small manual runs still reserve one slot for overdue reconciliation'
    )
    await pg.close()
}

console.log('Postgres metadata architecture tests passed')
