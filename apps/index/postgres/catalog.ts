import type { GameSpec } from '@modrex/games'

export type CatalogGames = Readonly<Record<string, Pick<GameSpec, 'name' | 'workshopId'>>>

export interface ModWorkshopSource {
    slug: string
    name: string
    game_ref: string
}

export function verifyModWorkshopSources(
    rows: readonly ModWorkshopSource[],
    games: CatalogGames
): void {
    const expected = Object.entries(games).filter(([, game]) => game.workshopId !== undefined)
    if (rows.length !== expected.length) {
        throw new Error(`Expected ${expected.length} ModWorkshop sources, found ${rows.length}`)
    }

    for (const [slug, game] of expected) {
        const row = rows.find((candidate) => candidate.slug === slug)
        if (!row) throw new Error(`Missing ${slug} ModWorkshop source`)
        if (row.name !== game.name) throw new Error(`${slug} name does not match @modrex/games`)
        if (row.game_ref !== String(game.workshopId)) {
            throw new Error(`${slug} ModWorkshop ID does not match @modrex/games`)
        }
    }
}
