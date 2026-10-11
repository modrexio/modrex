import type { CatalogGames } from './catalog.js'
import type { Database } from './database.js'

const MODWORKSHOP_API_BASE = 'https://api.modworkshop.net'

export async function bootstrapCatalog(
    db: Pick<Database, 'query'>,
    games: CatalogGames
): Promise<void> {
    for (const [slug, game] of Object.entries(games)) {
        const rows = await db.query<{ id: string }>(
            `
            INSERT INTO games (name, slug)
            VALUES ($1, $2)
            ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
            `,
            [game.name, slug]
        )
        if (game.workshopId === undefined) continue
        const gameId = rows[0].id

        await db.query(
            `
            INSERT INTO sources (game_id, name, base_url, game_ref)
            VALUES ($1, 'modworkshop', $2, $3)
            ON CONFLICT (game_id, name) DO UPDATE SET
                base_url = EXCLUDED.base_url,
                game_ref = EXCLUDED.game_ref
            `,
            [gameId, MODWORKSHOP_API_BASE, String(game.workshopId)]
        )
    }
}
