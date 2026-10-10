import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import Sqlite from 'better-sqlite3'

import { migrations } from './postgres/schema.js'
import {
    writeSnapshot,
    type ResourceRow,
    type SnapshotRow,
    type SnapshotSource,
} from './postgres/snapshot.js'
import {
    applySnapshotDelta,
    compareResourceRows,
    readPreviousSnapshot,
    resourceRowsQuery,
    snapshotFingerprints,
    snapshotDeltaQuery,
    snapshotSourceQuery,
    type SnapshotDelta,
} from './postgres/snapshot-delta.js'

const fullQuery = `
    SELECT mods.id::TEXT AS mod_id, mods.remote_id::TEXT AS mod_remote_id,
        mods.name AS mod_name, mods.url AS mod_url, files.id::TEXT AS file_id,
        files.sha256 AS file_sha256, files.remote_id::TEXT AS file_remote_id,
        files.version AS file_version, files.indexed_at AS file_indexed_at,
        files.entry_name AS file_entry_name
    FROM files JOIN mods ON mods.id = files.mod_id
    JOIN sources ON sources.id = mods.source_id JOIN games ON games.id = sources.game_id
    WHERE games.slug = $1 ORDER BY files.id
`
const pg = new PGlite('memory://')
const workspace = mkdtempSync(join(tmpdir(), 'modrex-delta-'))
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
let checks = 0

async function fullResources(): Promise<ResourceRow[]> {
    return (await pg.query<ResourceRow>(resourceRowsQuery, ['pd2'])).rows.sort(compareResourceRows)
}

async function verify(previous: SnapshotRow[], label: string) {
    const { rows: changes } = await pg.query<SnapshotDelta>(snapshotDeltaQuery, [
        'pd2',
        JSON.stringify(snapshotFingerprints(previous)),
    ])
    const rows = applySnapshotDelta(previous, changes)
    const expected = (await pg.query<SnapshotRow>(fullQuery, ['pd2'])).rows
    assert.deepEqual(rows, expected, label)
    const source = (await pg.query<SnapshotSource>(snapshotSourceQuery, ['pd2'])).rows[0]
    const resources = await fullResources()
    const incremental = writeSnapshot(
        join(workspace, 'incremental.db'),
        'pd2',
        source,
        rows,
        resources
    )
    const full = writeSnapshot(join(workspace, 'full.db'), 'pd2', source, expected, resources)
    assert.equal(hash(incremental), hash(full), label + ' must match full export bytes')
    assert.deepEqual(readPreviousSnapshot(incremental, hash(incremental), 'pd2').rows, expected)
    checks++
    return { rows, changes, source, incremental }
}

async function exportResources(label: string) {
    const rows = (await pg.query<SnapshotRow>(fullQuery, ['pd2'])).rows
    const source = (await pg.query<SnapshotSource>(snapshotSourceQuery, ['pd2'])).rows[0]
    const queried = (await pg.query<ResourceRow>(resourceRowsQuery, ['pd2'])).rows
    const first = writeSnapshot(
        join(workspace, 'resources-first.db'),
        'pd2',
        source,
        rows,
        [...queried].sort(compareResourceRows)
    )
    const second = writeSnapshot(
        join(workspace, 'resources-second.db'),
        'pd2',
        source,
        rows,
        [...queried].reverse().sort(compareResourceRows)
    )
    assert.equal(hash(first), hash(second), label + ' must export identical bytes')
    const sqlite = new Sqlite(first, { readonly: true })
    try {
        assert.deepEqual(sqlite.pragma('foreign_key_check'), [], label + ' foreign keys')
        checks++
        return {
            shard: first,
            resources: sqlite
                .prepare(
                    `SELECT mod_id, sha256, resource_kind, byte_length FROM resource_entries
                     ORDER BY rowid`
                )
                .raw()
                .all(),
        }
    } finally {
        sqlite.close()
    }
}

// Rewrites a published shard in place so it looks like one written by another exporter version.
function reshapeShard(file: string, statements: string): string {
    const db = new Sqlite(file)
    try {
        db.exec(statements)
    } finally {
        db.close()
    }
    return hash(file)
}

try {
    for (const migration of migrations) {
        for (const statement of migration.statements) await pg.exec(statement)
    }
    await pg.exec(`
        INSERT INTO games (name, slug) VALUES ('PAYDAY 2', 'pd2'), ('PAYDAY 3', 'pd3');
        INSERT INTO sources (game_id, name, base_url, game_ref)
        SELECT id, 'modworkshop', 'https://modworkshop.net', id::TEXT FROM games;
        INSERT INTO mods (source_id, remote_id, name, url) VALUES
            (1, 11, 'Первый 🦆 :12:', 'https://modworkshop.net/mod/11'),
            (1, 12, 'Second', 'https://modworkshop.net/mod/12'),
            (2, 21, 'Other game', 'https://modworkshop.net/mod/21');
        INSERT INTO file_contents SELECT 'hash-' || id FROM generate_series(1, 300) id;
        INSERT INTO files (id, mod_id, sha256, remote_id, version, indexed_at, entry_name)
        OVERRIDING SYSTEM VALUE
        SELECT id, 1, 'hash-' || id, -id, '', '2026-09-01', 'folder/mod.txt'
        FROM generate_series(1, 150) id;
        INSERT INTO files (id, mod_id, sha256, remote_id, version, indexed_at, entry_name)
        OVERRIDING SYSTEM VALUE VALUES
            (9007199254740993, 2, 'hash-151', -9007199254740993, 'large', '2026-09-01', 'large.txt'),
            (9223372036854775807, 2, 'hash-152', 9223372036854775807, 'max', '2026-09-01', 'max.txt'),
            (1000, 3, 'hash-153', 1000, 'other', '2026-09-01', 'other.txt');
        INSERT INTO mods (source_id, remote_id, name, url) VALUES
            (1, 13, 'Skip Startup', 'https://modworkshop.net/mod/13'),
            (1, 14, 'Small UI', 'https://modworkshop.net/mod/14');
        INSERT INTO remote_downloadables (
            id, source_id, mod_remote_id, kind, remote_id, metadata_fingerprint, url, status,
            first_seen_at, last_seen_at, retired_at
        ) OVERRIDING SYSTEM VALUE VALUES
            (1, 1, 13, 'file', 501, 'm', 'u', 'complete', 't', 't', NULL),
            (2, 1, 14, 'file', 502, 'm', 'u', 'complete', 't', 't', '2026-09-02'),
            (3, 2, 21, 'file', 503, 'm', 'u', 'complete', 't', 't', NULL);
        INSERT INTO downloadable_observations (
            id, downloadable_id, metadata_fingerprint, content_fingerprint, version, outcome,
            observed_at, source_filename
        ) OVERRIDING SYSTEM VALUE VALUES
            (1, 1, 'm', 'c1', 'one', 'complete', 't', 'Skip Startup.rar'),
            (2, 1, 'm', 'c2', 'two', 'complete', 't', NULL),
            (3, 2, 'm', 'c3', 'one', 'complete', 't', 'Small UI.zip'),
            (4, 1, 'm', 'c4', 'three', 'unusable', 't', NULL),
            (5, 3, 'm', 'c5', 'one', 'complete', 't', NULL);
        INSERT INTO downloadable_entries (
            observation_id, sha256, entry_name, resource_kind, byte_length
        ) VALUES
            (1, 'hash-1', 'Movies/StartUp_Unreal.bk2', 'movie', 64),
            (1, 'hash-1', 'Movies/StartUp_SBZ.bk2', 'movie', 64),
            (1, 'hash-1', 'Movies/StartUp_DeepSilver.bk2', 'movie', 64),
            (1, 'hash-2', 'Paks/Mod_P.pak', NULL, NULL),
            (2, 'hash-1', 'Movies/StartUp_SBZ.bk2', 'movie', 64),
            (3, 'hash-3', '6/Engine.ini', 'config', 66),
            (3, 'hash-4', '7/Engine.ini', 'config', 0),
            (4, 'hash-5', 'Unusable.bk2', 'movie', 1),
            (5, 'hash-6', 'Other game.bk2', 'movie', 1);
    `)
    let baseline = (await verify([], 'first export without a previous snapshot')).rows
    assert.equal((await verify(baseline, 'unchanged export')).changes.length, 0)
    const source = (await pg.query<SnapshotSource>(snapshotSourceQuery, ['pd2'])).rows[0]
    const original = writeSnapshot(
        join(workspace, 'original.db'),
        'pd2',
        source,
        baseline,
        await fullResources()
    )
    const originalHash = hash(original)
    assert.throws(() => readPreviousSnapshot(original, '0'.repeat(64), 'pd2'), /checksum mismatch/)
    assert.throws(
        () => readPreviousSnapshot(original, originalHash, 'pd3'),
        /Missing snapshot catalog/
    )
    assert.throws(
        () => readPreviousSnapshot(join(workspace, 'missing.db'), originalHash, 'pd2'),
        /ENOENT/
    )
    writeFileSync(join(workspace, 'corrupt.db'), 'invalid sqlite')
    assert.throws(() =>
        readPreviousSnapshot(
            join(workspace, 'corrupt.db'),
            hash(join(workspace, 'corrupt.db')),
            'pd2'
        )
    )

    // Published shards may predate resource_entries or carry its observation-level shape. Only
    // their files rows feed the delta, so both stay usable previous snapshots.
    const oldShapes: Array<[string, string]> = [
        ['shard without resource_entries', 'DROP TABLE resource_entries'],
        [
            'shard with observation-level resource_entries',
            `DROP TABLE resource_entries;
             CREATE TABLE resource_entries (
                 mod_id INTEGER NOT NULL REFERENCES mods(id),
                 observation_id INTEGER NOT NULL,
                 download_kind TEXT NOT NULL,
                 download_remote_id INTEGER NOT NULL,
                 version TEXT NOT NULL,
                 source_filename TEXT NOT NULL,
                 entry_name TEXT NOT NULL,
                 sha256 TEXT NOT NULL REFERENCES file_contents(sha256),
                 resource_kind TEXT NOT NULL,
                 byte_length INTEGER NOT NULL,
                 detected_format TEXT NOT NULL,
                 validation_status TEXT NOT NULL,
                 PRIMARY KEY (observation_id, sha256, entry_name)
             );
             INSERT INTO resource_entries VALUES
                 (1, 1, 'file', 501, 'one', '', 'Movies/A.bk2', 'hash-1', 'movie', 64, 'bink1', 'valid')`,
        ],
    ]
    for (const [label, statements] of oldShapes) {
        const shard = writeSnapshot(
            join(workspace, 'old-shard.db'),
            'pd2',
            source,
            baseline,
            await fullResources()
        )
        const previous = readPreviousSnapshot(shard, reshapeShard(shard, statements), 'pd2')
        assert.deepEqual(previous.rows, baseline, label + ' keeps its files rows')
        assert.equal((await verify(previous.rows, label)).changes.length, 0, label)
    }

    const edits: Array<[string, string]> = [
        ['parent mod', 'UPDATE files SET mod_id=2 WHERE id=1'],
        ['mod remote id', 'UPDATE mods SET remote_id=1011 WHERE id=1'],
        ['mod name', "UPDATE mods SET name='Changed:12:🦆' WHERE id=1"],
        ['mod URL', "UPDATE mods SET url='https://example.com/changed' WHERE id=1"],
        [
            'file id replacement',
            `WITH removed AS (DELETE FROM files WHERE id=2 RETURNING *)
            INSERT INTO files (id, mod_id, sha256, remote_id, version, indexed_at, entry_name)
            OVERRIDING SYSTEM VALUE SELECT 2000, mod_id, sha256, remote_id, version, indexed_at, entry_name FROM removed`,
        ],
        ['file hash', "UPDATE files SET sha256='hash-200' WHERE id=3"],
        ['download id', 'UPDATE files SET remote_id=-9007199254740995 WHERE id=4'],
        ['version', "UPDATE files SET version='1:2:3' WHERE id=5"],
        ['indexed time', "UPDATE files SET indexed_at='2026-09-02' WHERE id=6"],
        ['entry name', "UPDATE files SET entry_name='über/🦆.txt' WHERE id=7"],
        ['game name', "UPDATE games SET name='PAYDAY 2 Updated' WHERE id=1"],
        ['source URL', "UPDATE sources SET base_url='https://example.com/catalog' WHERE id=1"],
        ['source game ref', "UPDATE sources SET game_ref='42' WHERE id=1"],
    ]
    for (const [label, statement] of edits) {
        await pg.exec(statement)
        const result = await verify(baseline, label)
        if (label === 'version') {
            assert.equal(result.changes.length, 1)
            assert.equal(result.changes[0].file_id, '5')
        }
        baseline = result.rows
    }
    const textCases = [
        '',
        ':',
        '12:3',
        'é',
        'e\u0301',
        '漢字 🦆',
        'line\nnext\tvalue',
        'quote"slash\\end',
    ]
    for (const value of textCases) {
        await pg.query('UPDATE files SET entry_name=$1 WHERE id=8', [value])
        baseline = (await verify(baseline, 'UTF-8 length framing')).rows
        assert.equal((await verify(baseline, 'text fingerprint parity')).changes.length, 0)
    }

    await pg.exec("INSERT INTO metadata VALUES ('content_last_turn:pd2', '100')")
    assert.equal((await verify(baseline, 'scheduler bookkeeping')).changes.length, 0)
    await pg.exec("UPDATE mods SET name='Other game changed' WHERE id=3")
    assert.equal((await verify(baseline, 'cross-game isolation')).changes.length, 0)

    await pg.exec('DELETE FROM files WHERE id BETWEEN 64 AND 127')
    const deleted = await verify(baseline, 'multiple files deleted')
    assert.ok(deleted.changes.some((change) => change.file_id === '64' && change.record === null))
    const retry = await verify(baseline, 'retry after publication failed')
    assert.deepEqual(retry.changes, deleted.changes)
    baseline = deleted.rows
    await pg.exec(`
        INSERT INTO files (id, mod_id, sha256, remote_id, version, indexed_at, entry_name)
        OVERRIDING SYSTEM VALUE VALUES (64, 1, 'hash-250', -64, 'new', '2026-09-03', 'new.txt')
    `)
    baseline = (await verify(baseline, 'deleted file ID reappears')).rows

    let seed = 123456789
    for (let i = 0; i < 40; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const id = 9 + (seed % 50)
        await pg.query('UPDATE files SET version=$1 WHERE id=$2', [String(seed), id])
        const result = await verify(baseline, 'replayed mixed edits ' + i)
        if (i % 3 !== 0) baseline = result.rows
    }
    await pg.exec('DELETE FROM files WHERE mod_id IN (1, 2)')
    const empty = await verify(baseline, 'all files deleted')
    assert.equal(empty.rows.length, 0)
    assert.equal((await verify(empty.rows, 'empty snapshot repeat')).changes.length, 0)

    // Resource identities come from every complete observation, including historical releases
    // and retired downloads. Unusable observations, other games and ordinary entries never
    // appear. Every files row is gone by now, so this is also the resource-only shard.
    const initial = await exportResources('first resource export')
    assert.deepEqual(
        initial.resources,
        [
            [4, 'hash-1', 'movie', 64],
            [5, 'hash-3', 'config', 66],
            [5, 'hash-4', 'config', 0],
        ],
        'names and releases of one hash collapse to one identity per project'
    )
    const resourceShard = new Sqlite(initial.shard, { readonly: true })
    try {
        assert.equal(
            resourceShard.prepare('SELECT COUNT(*) FROM files').pluck().get(),
            0,
            'resources never enter the files projection'
        )
        assert.deepEqual(
            resourceShard
                .prepare(
                    `SELECT DISTINCT m.remote_id FROM mods m JOIN files f ON f.mod_id = m.id
                     WHERE m.name LIKE '%Skip Startup%'`
                )
                .all(),
            [],
            'a resource-only mod is not an ordinary name match'
        )
    } finally {
        resourceShard.close()
    }

    const resourceEdits: Array<[string, string, unknown[][]]> = [
        [
            'replaced and retired release',
            `INSERT INTO downloadable_observations (
                id, downloadable_id, metadata_fingerprint, content_fingerprint, version, outcome,
                observed_at
             ) OVERRIDING SYSTEM VALUE VALUES (6, 1, 'm2', 'c6', 'four', 'complete', 't');
             INSERT INTO downloadable_entries (
                observation_id, sha256, entry_name, resource_kind, byte_length
             ) VALUES (6, 'hash-7', 'Movies/StartUp_SBZ.bk2', 'movie', 1);
             UPDATE remote_downloadables SET retired_at='2026-09-03' WHERE id=1`,
            [
                [4, 'hash-1', 'movie', 64],
                [4, 'hash-7', 'movie', 1],
                [5, 'hash-3', 'config', 66],
                [5, 'hash-4', 'config', 0],
            ],
        ],
        [
            'bytes shared across projects',
            `INSERT INTO downloadable_entries (
                observation_id, sha256, entry_name, resource_kind, byte_length
             ) VALUES (3, 'hash-1', 'Movies/Intro.bk2', 'movie', 64)`,
            [
                [4, 'hash-1', 'movie', 64],
                [4, 'hash-7', 'movie', 1],
                [5, 'hash-1', 'movie', 64],
                [5, 'hash-3', 'config', 66],
                [5, 'hash-4', 'config', 0],
            ],
        ],
        [
            'same bytes under another kind',
            `INSERT INTO downloadable_entries (
                observation_id, sha256, entry_name, resource_kind, byte_length
             ) VALUES (3, 'hash-3', 'Movies/Odd.bk2', 'movie', 66)`,
            [
                [4, 'hash-1', 'movie', 64],
                [4, 'hash-7', 'movie', 1],
                [5, 'hash-1', 'movie', 64],
                [5, 'hash-3', 'config', 66],
                [5, 'hash-3', 'movie', 66],
                [5, 'hash-4', 'config', 0],
            ],
        ],
    ]
    for (const [label, statement, expected] of resourceEdits) {
        await pg.exec(statement)
        assert.deepEqual((await exportResources(label)).resources, expected, label)
    }

    console.log(`Snapshot delta tests passed (${checks} full-export equivalence checks)`)
} finally {
    await pg.close()
    const target = resolve(workspace)
    assert.ok(target.startsWith(resolve(tmpdir()) + (target.includes('\\') ? '\\' : '/')))
    rmSync(target, { recursive: true, force: true })
}
