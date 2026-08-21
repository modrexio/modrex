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
    {
        // An archive with no recognised marker has its representative file chosen by sort
        // order, and two things about that choice changed: the order is a byte comparison
        // rather than JavaScript localeCompare, so it matches modrex-main's picker exactly,
        // and files the OS regenerates (Thumbs.db, desktop.ini, .DS_Store) are not eligible.
        // Rows written under the earlier rules can name a file no installed copy will ever
        // hash, and a recorded check keeps them that way for as long as ModWorkshop leaves the
        // listing alone. Dropping the check re-processes exactly those listings; marker-bearing
        // ones are untouched because their pick is unaffected.
        //
        // Marker games only. PAYDAY 3 and Crime Boss index every content entry in an archive
        // rather than one representative file, so none of their rows came from this rule, and
        // every one of them would otherwise match the name filter and be re-downloaded whole.
        version: '004_recheck_markerless_picks',
        statements: [
            `DELETE FROM mod_checks
             WHERE (source_id, remote_id) IN (
                 SELECT mods.source_id, mods.remote_id
                 FROM mods
                 JOIN files ON files.mod_id = mods.id
                 JOIN sources ON sources.id = mods.source_id
                 JOIN games ON games.id = sources.game_id
                 WHERE games.slug IN ('pd2', 'pdth', 'raid')
                   AND files.entry_name <> ''
                   AND lower(split_part(files.entry_name, '/', -1))
                       NOT IN ('mod.txt', 'main.xml', 'supermod.xml', 'mod.xml', 'base.lua')
             )`,
        ],
    },
    {
        // Reopen verified RAR4 false-negative checks only while they are still
        // settled and the listing remains downloadable.
        version: '005_recheck_rar4_listings',
        statements: [
            `DELETE FROM mod_checks
             WHERE (source_id, remote_id) IN (
                 SELECT mod_checks.source_id, mod_checks.remote_id
                 FROM mod_checks
                 JOIN mod_listings
                     ON mod_listings.source_id = mod_checks.source_id
                    AND mod_listings.remote_id = mod_checks.remote_id
                 JOIN sources ON sources.id = mod_checks.source_id
                 JOIN games ON games.id = sources.game_id
                 WHERE games.slug = 'pd2'
                   AND sources.name = 'modworkshop'
                   AND mod_listings.has_download
                   AND mod_checks.file_ids = '[]'::jsonb
                   AND mod_checks.updated_at = mod_listings.updated_at
                   AND mod_checks.remote_id IN (
                     37, 182, 207, 224, 228, 264, 266, 329, 331, 364, 406, 411,
                     420, 422, 423, 442, 574, 575, 576, 636, 637, 638, 639, 640,
                     644, 645, 646, 649, 651, 652, 653, 654, 655, 659, 665, 666,
                     678, 1287, 1409, 1410, 1518, 12354, 12373, 12379, 12390, 12395, 12397, 12421,
                     12424, 12425, 12429, 12430, 12432, 12456, 12495, 12505, 12523, 12526, 12527, 12528,
                     12532, 12534, 12535, 12536, 12544, 12549, 12552, 12553, 12570, 12571, 12575, 12583,
                     12591, 12598, 12599, 12634, 12636, 12637, 12645, 12648, 12653, 12657, 12676, 12686,
                     12695, 12700, 12719, 12745, 12760, 12782, 12809, 12812, 12814, 12815, 12818, 12820,
                     12828, 12835, 12838, 12862, 12863, 12872, 12873, 12877, 12885, 12889, 12895, 12898,
                     12915, 12918, 12933, 12936, 12939, 12955, 12957, 12963, 12978, 12985, 12987, 12989,
                     12990, 12991, 12998, 13011, 13014, 13020, 13033, 13046, 13051, 13053, 13054, 13068,
                     13074, 13084, 13090, 13095, 13107, 13111, 13114, 13115, 13117, 13121, 13123, 13137,
                     13157, 13162, 13174, 13190, 13195, 13201, 13205, 13213, 13215, 13230, 13234, 13237,
                     13238, 13239, 13268, 13285, 13326, 13350, 13351, 13362, 13397, 13402, 13411, 13430,
                     13459, 13461, 13462, 13475, 13499, 13503, 13514, 13522, 13540, 13547, 13553, 13560,
                     13565, 13570, 13576, 13579, 13593, 13602, 13604, 13605, 13607, 13612, 13621, 13640,
                     13681, 13692, 13700, 13705, 13706, 13707, 13711, 13712, 13713, 13719, 13726, 13727,
                     13728, 13738, 13739, 13750, 13751, 13752, 13756, 13757, 13766, 13767, 13769, 13775,
                     13788, 13789, 13792, 13804
                   )
             )`,
        ],
    },
]
