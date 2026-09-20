import { GAME_IDS, GAMES } from '@modrex/games'
import { connectDatabase } from './database.js'
import { syncGameListings } from './listing-sync.js'
import { ModWorkshop } from './modworkshop.js'

const db = connectDatabase()
const api = new ModWorkshop()
const startedAt = new Date()

for (const slug of GAME_IDS) {
    const workshopId = GAMES[slug].workshopId
    if (workshopId === undefined) continue
    const result = await syncGameListings(db, api, slug, workshopId, startedAt)
    console.log(
        `Synced ${result.stored} ${slug} listings, ${result.pending} awaiting versions ` +
            `(${result.requests} API requests, ${result.versionBatches} version batches total)`
    )
}
