import Database from 'better-sqlite3'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface SnapshotSource {
    game_id: string
    game_name: string
    game_slug: string
    source_id: string
    source_name: string
    source_base_url: string
    source_game_ref: string
}

export interface SnapshotRow {
    mod_id: string
    mod_remote_id: string
    mod_name: string
    mod_url: string
    file_id: string
    file_sha256: string
    file_remote_id: string
    file_version: string
    file_indexed_at: string
    file_entry_name: string
}

// One published movie or config entry from a complete downloadable observation. Unlike files,
// nothing is deduplicated by (mod, sha256): identical bytes under several names, and the same
// hash across releases, are separate rows, because an intro pack replaces each named slot.
export interface ResourceRow {
    mod_id: string
    mod_remote_id: string
    mod_name: string
    mod_url: string
    observation_id: string
    download_kind: string
    download_remote_id: string
    version: string
    source_filename: string
    entry_name: string
    sha256: string
    resource_kind: string
    byte_length: string
    detected_format: string
    validation_status: string
}

// resource_entries is additive: readers that only know files ignore it. download_remote_id is
// the ModWorkshop file or link id itself, with download_kind saying which, rather than the
// negated link convention files.remote_id uses. source_filename is the sanitized hosted
// filename, or '' when none was recorded. validation_status restricts installation only.
// Exact recognition reads every row.
const schema = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE games (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE
    );
    CREATE TABLE sources (
        id INTEGER PRIMARY KEY,
        game_id INTEGER NOT NULL REFERENCES games(id),
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        game_ref TEXT NOT NULL
    );
    CREATE TABLE mods (
        id INTEGER PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES sources(id),
        remote_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        UNIQUE(source_id, remote_id)
    );
    CREATE TABLE file_contents (sha256 TEXT PRIMARY KEY);
    CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        mod_id INTEGER NOT NULL REFERENCES mods(id),
        sha256 TEXT NOT NULL REFERENCES file_contents(sha256),
        remote_id INTEGER NOT NULL,
        version TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        entry_name TEXT NOT NULL DEFAULT '',
        UNIQUE(mod_id, sha256)
    );
    CREATE INDEX idx_files_sha256 ON files(sha256);
    CREATE TABLE resource_entries (
        mod_id INTEGER NOT NULL REFERENCES mods(id),
        observation_id INTEGER NOT NULL,
        download_kind TEXT NOT NULL CHECK (download_kind IN ('file', 'link')),
        download_remote_id INTEGER NOT NULL,
        version TEXT NOT NULL,
        source_filename TEXT NOT NULL,
        entry_name TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES file_contents(sha256),
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('movie', 'config')),
        byte_length INTEGER NOT NULL,
        detected_format TEXT NOT NULL,
        validation_status TEXT NOT NULL
            CHECK (validation_status IN ('valid', 'unsupported', 'invalid')),
        PRIMARY KEY (observation_id, sha256, entry_name)
    );
    CREATE INDEX idx_resource_entries_sha256 ON resource_entries(sha256);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

// test-export-determinism.ts enforces stable snapshot bytes to avoid redundant shard downloads.
export function writeSnapshot(
    output: string,
    game: string,
    source: SnapshotSource,
    rows: SnapshotRow[],
    resources: ResourceRow[]
): string {
    const outputPath = resolve(output)
    const temporaryPath = `${outputPath}.tmp`
    rmSync(temporaryPath, { force: true })
    mkdirSync(dirname(outputPath), { recursive: true })

    const db = new Database(temporaryPath)
    try {
        db.exec(schema)
        const insertGame = db.prepare('INSERT INTO games VALUES (?, ?, ?)')
        const insertSource = db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?)')
        const insertMod = db.prepare('INSERT INTO mods VALUES (?, ?, ?, ?, ?)')
        const insertContent = db.prepare('INSERT INTO file_contents VALUES (?)')
        const insertFile = db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?)')
        const insertResource = db.prepare(
            'INSERT INTO resource_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        const insertMetadata = db.prepare('INSERT INTO metadata VALUES (?, ?)')
        const seen = { mods: new Set<string>(), contents: new Set<string>() }
        const insertModOnce = (row: SnapshotRow | ResourceRow) => {
            if (seen.mods.has(row.mod_id)) return
            insertMod.run(
                row.mod_id,
                source.source_id,
                row.mod_remote_id,
                row.mod_name,
                row.mod_url
            )
            seen.mods.add(row.mod_id)
        }
        const insertContentOnce = (sha256: string) => {
            if (seen.contents.has(sha256)) return
            insertContent.run(sha256)
            seen.contents.add(sha256)
        }

        db.transaction(() => {
            insertGame.run(source.game_id, source.game_name, source.game_slug)
            insertSource.run(
                source.source_id,
                source.game_id,
                source.source_name,
                source.source_base_url,
                source.source_game_ref
            )
            for (const row of rows) {
                insertModOnce(row)
                insertContentOnce(row.file_sha256)
                insertFile.run(
                    row.file_id,
                    row.mod_id,
                    row.file_sha256,
                    row.file_remote_id,
                    row.file_version,
                    row.file_indexed_at,
                    row.file_entry_name
                )
            }
            for (const row of resources) {
                insertModOnce(row)
                insertContentOnce(row.sha256)
                insertResource.run(
                    row.mod_id,
                    row.observation_id,
                    row.download_kind,
                    row.download_remote_id,
                    row.version,
                    row.source_filename,
                    row.entry_name,
                    row.sha256,
                    row.resource_kind,
                    row.byte_length,
                    row.detected_format,
                    row.validation_status
                )
            }
            insertMetadata.run('game', game)
        })()
        db.pragma('optimize')
        db.close()
        renameSync(temporaryPath, outputPath)
    } catch (error) {
        db.close()
        rmSync(temporaryPath, { force: true })
        throw error
    }
    return outputPath
}
