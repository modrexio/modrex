// The refresh workflow only uploads a new immutable generation when the exported snapshot's
// SHA256 differs from the one in catalog/latest.json. That guard is only meaningful while the
// export is a function of the catalog alone, so this asserts both halves of it: identical rows
// produce an identical file, and a changed row produces a different one.

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Sqlite from 'better-sqlite3'

import {
    writeSnapshot,
    type ResourceRow,
    type SnapshotRow,
    type SnapshotSource,
} from './postgres/snapshot.js'

const source: SnapshotSource = {
    game_id: '2',
    game_name: 'PAYDAY 2',
    game_slug: 'pd2',
    source_id: '7',
    source_name: 'modworkshop',
    source_base_url: 'https://api.modworkshop.net',
    source_game_ref: '1',
}

const row = (id: string, modId: string, sha256: string, entryName: string): SnapshotRow => ({
    mod_id: modId,
    mod_remote_id: `10${modId}`,
    mod_name: `Test Mod ${modId}`,
    mod_url: `https://modworkshop.net/mod/10${modId}`,
    file_id: id,
    file_sha256: sha256,
    file_remote_id: `20${id}`,
    file_version: '1.0',
    file_indexed_at: '2026-08-16T00:00:00.000Z',
    file_entry_name: entryName,
})

const rows: SnapshotRow[] = [
    row('1', '1', 'a'.repeat(64), 'Test Mod/mod.txt'),
    row('2', '1', 'b'.repeat(64), 'Test Mod/lua/init.lua'),
    // A second mod sharing the first mod's content, so the deduplicating writes are exercised.
    row('3', '2', 'a'.repeat(64), 'Other Mod/mod.txt'),
]

const resource = (
    observationId: string,
    modId: string,
    sha256: string,
    entryName: string,
    validationStatus = 'valid'
): ResourceRow => ({
    mod_id: modId,
    mod_remote_id: `10${modId}`,
    mod_name: `Test Mod ${modId}`,
    mod_url: `https://modworkshop.net/mod/10${modId}`,
    observation_id: observationId,
    download_kind: 'file',
    download_remote_id: `30${observationId}`,
    version: '1.0',
    source_filename: 'Skip Intro.zip',
    entry_name: entryName,
    sha256,
    resource_kind: 'movie',
    byte_length: '64',
    detected_format: 'bink1',
    validation_status: validationStatus,
})

// One blank movie under three slot names, plus a resource-only mod with no files row.
const resources: ResourceRow[] = [
    resource('5', '1', 'e'.repeat(64), 'Movies/StartUp_DeepSilver.bk2'),
    resource('5', '1', 'e'.repeat(64), 'Movies/StartUp_SBZ.bk2'),
    resource('5', '1', 'e'.repeat(64), 'Movies/StartUp_Unreal.bk2'),
    resource('6', '4', 'a'.repeat(64), 'Movies/Shared.bk2'),
]

const workspace = mkdtempSync(join(tmpdir(), 'modrex-export-'))
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

try {
    const first = digest(writeSnapshot(join(workspace, 'first.db'), 'pd2', source, rows, []))
    // Far enough apart that any clock reading baked into the file would differ between the two.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const second = digest(writeSnapshot(join(workspace, 'second.db'), 'pd2', source, rows, []))

    assert.equal(first, second, 'the same catalog rows must export to a byte-identical snapshot')

    const rewritten = [...rows]
    rewritten[1] = row('2', '1', 'c'.repeat(64), 'Test Mod/lua/init.lua')
    const changed = digest(
        writeSnapshot(join(workspace, 'changed.db'), 'pd2', source, rewritten, [])
    )
    assert.notEqual(first, changed, 'a changed file hash must change the snapshot')

    const added = digest(
        writeSnapshot(
            join(workspace, 'added.db'),
            'pd2',
            source,
            [...rows, row('4', '3', 'd'.repeat(64), 'Third Mod/mod.txt')],
            []
        )
    )
    assert.notEqual(first, added, 'an added mod must change the snapshot')

    const renamed = digest(
        writeSnapshot(
            join(workspace, 'renamed.db'),
            'pd2',
            source,
            [
                row('1', '1', 'a'.repeat(64), 'Test Mod/mod.txt'),
                row('2', '1', 'b'.repeat(64), 'Test Mod/lua/other.lua'),
                row('3', '2', 'a'.repeat(64), 'Other Mod/mod.txt'),
            ],
            []
        )
    )
    assert.notEqual(first, renamed, 'a changed entry name must change the snapshot')

    const withResources = writeSnapshot(
        join(workspace, 'resources.db'),
        'pd2',
        source,
        rows,
        resources
    )
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(
        digest(withResources),
        digest(
            writeSnapshot(join(workspace, 'resources-again.db'), 'pd2', source, rows, resources)
        ),
        'the same resource rows must export to a byte-identical snapshot'
    )
    assert.notEqual(first, digest(withResources), 'added resource rows must change the snapshot')
    const resourceOnlyChange = [...resources]
    resourceOnlyChange[3] = resource('6', '4', 'a'.repeat(64), 'Movies/Shared.bk2', 'invalid')
    assert.notEqual(
        digest(withResources),
        digest(
            writeSnapshot(
                join(workspace, 'resource-change.db'),
                'pd2',
                source,
                rows,
                resourceOnlyChange
            )
        ),
        'a resource-only change publishes a new snapshot while files are unchanged'
    )

    const sqlite = new Sqlite(withResources, { readonly: true })
    try {
        assert.deepEqual(sqlite.pragma('foreign_key_check'), [], 'shared file_contents FKs hold')
        assert.deepEqual(
            sqlite
                .prepare('SELECT entry_name FROM resource_entries WHERE sha256 = ? ORDER BY rowid')
                .pluck()
                .all('e'.repeat(64)),
            [
                'Movies/StartUp_DeepSilver.bk2',
                'Movies/StartUp_SBZ.bk2',
                'Movies/StartUp_Unreal.bk2',
            ],
            'identical bytes keep every slot name'
        )
        assert.equal(
            sqlite.prepare('SELECT COUNT(*) FROM file_contents').pluck().get(),
            3,
            'a hash shared by files and resources has one file_contents row'
        )
        assert.deepEqual(
            sqlite
                .prepare(
                    `SELECT DISTINCT m.remote_id FROM mods m JOIN files f ON f.mod_id = m.id
                     WHERE m.name LIKE '%Test Mod 4%'`
                )
                .all(),
            [],
            'a resource-only mod does not enter the files-joined name lookup'
        )
        assert.equal(sqlite.prepare('SELECT COUNT(*) FROM mods').pluck().get(), 3)
    } finally {
        sqlite.close()
    }

    const resourceOnly = writeSnapshot(
        join(workspace, 'resource-only.db'),
        'cb',
        { ...source, game_slug: 'cb' },
        [],
        resources
    )
    const resourceOnlyDb = new Sqlite(resourceOnly, { readonly: true })
    try {
        assert.deepEqual(resourceOnlyDb.pragma('foreign_key_check'), [])
        assert.equal(resourceOnlyDb.prepare('SELECT COUNT(*) FROM files').pluck().get(), 0)
        assert.equal(
            resourceOnlyDb.prepare('SELECT COUNT(*) FROM resource_entries').pluck().get(),
            4
        )
    } finally {
        resourceOnlyDb.close()
    }

    console.log('export determinism test passed')
} finally {
    rmSync(workspace, { recursive: true, force: true })
}
