import { GAMES, type GameId } from '@modrex/games'
import type {
    InstalledMod_Serialize,
    ResourceRecoveryReview,
    ResourceReview_Serialize,
    ResourceSelection,
} from '../../shared/bindings'
import { library } from './library'
import { resourceSelectionValid } from '../src/resourceInstall'

const reviews = new Map<string, ResourceReview_Serialize & { gameId: GameId }>()
const recoveries = new Map<string, { gameId: GameId; uid: string }>()

export function seedResourceLibrary(gameId: GameId) {
    const lib = library(gameId)
    const game = GAMES[gameId]
    const entries: InstalledMod_Serialize[] = []
    if (game.movieReplacement) {
        entries.push(
            {
                uid: 'resource:movie:intro',
                id: -9001,
                source: 'local',
                name: 'Skip startup movies',
                filename: 'Intro.bk2',
                deployment: 'movie',
                enabled: true,
                resourceStatus: 'applied',
                version: '1.0',
                installedAt: '2026-10-06T12:00:00Z',
            },
            {
                uid: 'resource:movie:changed',
                id: -9003,
                source: 'local',
                name: 'Custom intro movie',
                filename: 'Background.bk2',
                deployment: 'movie',
                enabled: true,
                resourceStatus: 'diverged',
                version: '1.0',
                installedAt: '2026-10-06T12:00:00Z',
            }
        )
    }
    if (game.configPresets)
        entries.push({
            uid: 'resource:ini:scale',
            id: -9002,
            source: 'local',
            name: 'Small UI',
            filename: game.configPresets.filename,
            deployment: 'ini',
            enabled: false,
            resourceStatus: 'disabled',
            version: '1.0',
            installedAt: '2026-10-06T12:00:00Z',
        })
    entries.forEach((entry) => lib.install(entry))
    lib.seeded = true
}

export function createResourceReview(gameId: GameId, gamePath: string): string {
    const game = GAMES[gameId]
    if (!game.movieReplacement && !game.configPresets)
        throw new Error('This game declares no movie or config support')
    const handle = crypto.randomUUID()
    const slot = 'Intro.bk2'
    const configPath =
        gameId === 'pd3'
            ? 'C:/Users/Preview/AppData/Local/PAYDAY3/Saved/Config/WindowsClient/Engine.ini'
            : 'C:/Preview/chosen-config/Engine.ini'
    reviews.set(handle, {
        reviewHandle: handle,
        gameId,
        gamePath,
        modName: 'Resource presets',
        entries: [
            ...(game.movieReplacement
                ? [
                      {
                          entryId: 0,
                          name: slot,
                          kind: 'movie' as const,
                          supported: true,
                          reason: null,
                          changes: [],
                          keys: [],
                      },
                  ]
                : []),
            ...(game.configPresets
                ? [6, 8].map((scale, index) => ({
                      entryId: index + 1,
                      name: `${scale}/Engine.ini`,
                      kind: 'ini' as const,
                      supported: true,
                      reason: null,
                      keys: [
                          {
                              section: '/Script/Engine.UserInterfaceSettings',
                              key: 'ApplicationScale',
                          },
                      ],
                      changes: [
                          {
                              section: '/Script/Engine.UserInterfaceSettings',
                              key: 'ApplicationScale',
                              before: '1.0',
                              applied: String(scale / 10),
                          },
                      ],
                  }))
                : []),
        ],
        movieSlots: game.movieReplacement ? [slot] : [],
        configPath: game.configPresets ? configPath : null,
        pakPicker: null,
        source: null,
        moviePackApplied: false,
        movieConflicts: game.movieReplacement
            ? [{ name: 'Skip startup movies', slots: [slot], replacing: false }]
            : [],
        iniConflicts: [],
    })
    return handle
}

export function getResourceReview(handle: string) {
    const review = reviews.get(handle)
    if (!review) throw new Error('Preview install review has ended')
    return review
}

export function cancelResourceReview(handle: string) {
    reviews.delete(handle)
}

export function installResources(handle: string, selection: ResourceSelection[]) {
    const review = getResourceReview(handle)
    const selected = Object.fromEntries(selection.map((entry) => [entry.entryId, entry.slot]))
    if (!resourceSelectionValid(review, selected))
        throw new Error('Complete the resource choices before installing')
    const lib = library(review.gameId)
    if (
        selection.some(
            (entry) =>
                review.entries.find((candidate) => candidate.entryId === entry.entryId)?.kind ===
                'movie'
        )
    ) {
        lib.uninstall('resource:movie:intro')
    }
    for (const entry of review.entries.filter((entry) => entry.entryId in selected)) {
        lib.install({
            uid: `resource:preview:${entry.kind}`,
            id: entry.kind === 'movie' ? -9010 : -9011,
            source: 'local',
            name:
                entry.kind === 'movie'
                    ? 'Movie replacement'
                    : `Small UI (${entry.name.split('/')[0]}0%)`,
            filename: entry.kind === 'movie' ? selected[entry.entryId]! : 'Engine.ini',
            deployment: entry.kind === 'movie' ? 'movie' : 'ini',
            enabled: true,
            resourceStatus: 'applied',
            version: '1.0',
            installedAt: new Date().toISOString(),
        })
    }
    reviews.delete(handle)
    return { installed: true, alreadyCurrentMovies: [] }
}

export function reviewRecovery(
    gameId: GameId,
    uid: string | null,
    gamePath: string
): ResourceRecoveryReview {
    if (!uid) throw new Error('There are no interrupted changes in this preview')
    const mod = library(gameId).mod(uid)
    const handle = crypto.randomUUID()
    recoveries.set(handle, { gameId, uid })
    const path =
        mod.deployment === 'ini'
            ? 'C:/Preview/chosen-config/Engine.ini'
            : `${gamePath}/PreviewMovies/${mod.filename}`
    return {
        reviewHandle: handle,
        gameId,
        deployments: [mod.name],
        files: [
            {
                path,
                current: { state: 'present', size: 2048, sha256: 'a'.repeat(64) },
            },
        ],
    }
}

export function cancelRecovery(handle: string) {
    recoveries.delete(handle)
}

export function keepCurrent(handle: string) {
    const review = recoveries.get(handle)
    if (!review) throw new Error('Preview recovery review has ended')
    library(review.gameId).uninstall(review.uid)
    recoveries.delete(handle)
}
