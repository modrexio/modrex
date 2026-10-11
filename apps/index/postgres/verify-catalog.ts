import { GAMES } from '@modrex/games'
import { neon } from '@neondatabase/serverless'
import { verifyModWorkshopSources, type ModWorkshopSource } from './catalog.js'

const databaseUrl = process.env.INDEX_DATABASE_URL
if (!databaseUrl) throw new Error('INDEX_DATABASE_URL is required')

const sql = neon(databaseUrl)
const rows = (await sql`
    SELECT games.slug, games.name, sources.game_ref
    FROM games
    JOIN sources ON sources.game_id = games.id
    WHERE sources.name = 'modworkshop'
    ORDER BY games.slug
`) as ModWorkshopSource[]

verifyModWorkshopSources(rows, GAMES)

console.log(`Verified ${rows.length} Postgres ModWorkshop sources`)
