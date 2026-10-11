import { createHash } from 'node:crypto'

import { GAMES } from '@modrex/games'
import { neon } from '@neondatabase/serverless'

import { bootstrapCatalog } from './bootstrap.js'
import { migrations } from './schema.js'

const databaseUrl = process.env.INDEX_DATABASE_URL
if (!databaseUrl) throw new Error('INDEX_DATABASE_URL is required')

const sql = neon(databaseUrl)

await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
    )
`

for (const migration of migrations) {
    const checksum = createHash('sha256').update(migration.statements.join('\n')).digest('hex')
    const applied = (await sql`
        SELECT checksum
        FROM schema_migrations
        WHERE version = ${migration.version}
    `) as { checksum: string }[]

    if (applied.length === 1) {
        if (applied[0].checksum !== checksum) {
            throw new Error(`Migration ${migration.version} does not match its recorded checksum`)
        }
        console.log(`${migration.version} already applied`)
        continue
    }

    await sql.transaction([
        ...migration.statements.map((statement) => sql.query(statement)),
        sql.query(
            'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)',
            [migration.version, checksum, new Date().toISOString()]
        ),
    ])
    console.log(`Applied ${migration.version}`)
}

await bootstrapCatalog(
    {
        query: async <T>(text: string, values: unknown[] = []) =>
            (await sql.query(text, values)) as T[],
    },
    GAMES
)
console.log('Bootstrapped game catalog')
