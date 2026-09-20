import { strict as assert } from 'node:assert'
import { PGlite } from '@electric-sql/pglite'
import type { Database, Statement } from './postgres/database.js'
import { syncGameListings } from './postgres/listing-sync.js'
import { ModWorkshop, parseVersions } from './postgres/modworkshop.js'
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
import { selectContentListings } from './postgres/content-selection.js'

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
    let versions = 0
    const fetcher: typeof fetch = async (request) => {
        const url = new URL(String(request))
        if (url.pathname.includes('/games/'))
            return response({ data: [listing(3)], meta: { current_page: 1, last_page: 1 } })
        versions++
        return response(versions <= 2 ? [] : { 3: 'recovered' })
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
        2,
        'a rediscovered listing keeps its retry history before the scheduled retry time'
    )
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
    const bad: Database = {
        ...db,
        async transaction(statements) {
            await pg.transaction(async (tx) => {
                await tx.query(statements[0].text, statements[0].values)
                throw new Error('simulated checkpoint failure')
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
        0,
        'page write rolls back with checkpoint'
    )
    assert.deepEqual(
        (await pg.query('SELECT * FROM files')).rows,
        before.rows,
        'historical identification rows survive recovery'
    )
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
    const weekLater = new Date('2026-09-27T12:00:00.000Z')
    const updatedLink = await registerDownloadable(
        db,
        mod,
        { ...link.input, version: 'release-two' },
        weekLater
    )
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

    await finishDiscovery(db, mod, [100, -5], at)
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
    await pg.close()
}

console.log('Postgres metadata architecture tests passed')
