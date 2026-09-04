import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GAME_IDS, GAMES } from '@modrex/games'
import { describe, expect, it } from 'vitest'
import { docsGames } from './docsGames'

const gameDocsDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../content/docs/docs/games'
)

describe('documentation game registry', () => {
    it('lists every game known to the app', () => {
        expect(docsGames.map((game) => game.id).sort()).toEqual([...GAME_IDS].sort())
    })

    it('has exactly one MDX page for every game with authored documentation', () => {
        const pageSlugs = readdirSync(gameDocsDirectory)
            .filter((name) => name.endsWith('.mdx') && name !== 'index.mdx')
            .map((name) => name.slice(0, -'.mdx'.length))
            .sort()
        const authoredSlugs = docsGames
            .filter((game) => game.hasPage)
            .map((game) => game.slug)
            .sort()

        expect(pageSlugs).toEqual(authoredSlugs)
        expect(new Set(authoredSlugs).size).toBe(authoredSlugs.length)
    })

    it('uses canonical mod target IDs from each game specification', () => {
        for (const game of docsGames) {
            const canonicalTargetIds = GAMES[game.id].modTargets.map((target) => target.id)
            for (const target of game.targets) {
                if ('targetId' in target) {
                    expect(canonicalTargetIds).toContain(target.targetId)
                }
            }
        }
    })

    it('describes a game with no authored documentation from its generated targets', () => {
        for (const game of docsGames.filter((candidate) => !candidate.hasPage)) {
            expect(game.slug).toBe(game.id)
            expect(game.targets.map((target) => 'targetId' in target && target.targetId)).toEqual(
                GAMES[game.id].modTargets.map((target) => target.id)
            )
        }
    })
})
