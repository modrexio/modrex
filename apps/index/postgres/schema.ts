export interface Migration {
    version: string
    statements: string[]
}

export const migrations: Migration[] = [
    {
        version: '001_initial',
        statements: [
            `CREATE TABLE games (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE
            )`,
            `CREATE TABLE sources (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                game_id BIGINT NOT NULL REFERENCES games(id),
                name TEXT NOT NULL,
                base_url TEXT NOT NULL,
                game_ref TEXT NOT NULL,
                UNIQUE(game_id, name)
            )`,
            `CREATE TABLE mods (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                source_id BIGINT NOT NULL REFERENCES sources(id),
                remote_id BIGINT NOT NULL,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                UNIQUE(source_id, remote_id)
            )`,
            `CREATE TABLE file_contents (
                sha256 TEXT PRIMARY KEY
            )`,
            `CREATE TABLE files (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                mod_id BIGINT NOT NULL REFERENCES mods(id),
                sha256 TEXT NOT NULL REFERENCES file_contents(sha256),
                remote_id BIGINT NOT NULL,
                version TEXT NOT NULL,
                indexed_at TEXT NOT NULL,
                entry_name TEXT NOT NULL DEFAULT '',
                UNIQUE(mod_id, sha256)
            )`,
            'CREATE INDEX files_sha256_idx ON files(sha256)',
            `CREATE TABLE metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )`,
            `CREATE TABLE mod_checks (
                source_id BIGINT NOT NULL REFERENCES sources(id),
                remote_id BIGINT NOT NULL,
                updated_at TEXT NOT NULL,
                file_ids JSONB NOT NULL,
                checked_at TEXT NOT NULL,
                PRIMARY KEY(source_id, remote_id)
            )`,
        ],
    },
    {
        version: '002_mod_listings',
        statements: [
            `CREATE TABLE mod_listings (
                source_id BIGINT NOT NULL REFERENCES sources(id),
                remote_id BIGINT NOT NULL,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                has_download BOOLEAN NOT NULL,
                bumped_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                download_id BIGINT,
                download_type TEXT,
                PRIMARY KEY(source_id, remote_id)
            )`,
            'CREATE INDEX mod_listings_source_bumped_at_idx ON mod_listings(source_id, bumped_at)',
        ],
    },
    {
        // A recorded check means "this listing was processed and yielded these files", so a
        // listing whose pass yielded nothing is skipped until ModWorkshop bumps its updated_at
        // again. Mods that publish their download as an off-site link were all recorded that
        // way before the content processor knew to follow links, so dropping the empty checks
        // is what lets them be picked up. Checks that did yield files are left alone, and a
        // listing that still yields nothing simply records an empty check again.
        version: '003_recheck_empty_listings',
        statements: [`DELETE FROM mod_checks WHERE file_ids = '[]'::jsonb`],
    },
]
