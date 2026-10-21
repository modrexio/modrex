import { api } from '../api'
import { getCachedMod } from '../modCache'
import { collectDeps, missingRequiredDeps, offsiteDepHost } from '../deps'
import { buildLoaderModIds, loadersForGame, type LoaderState } from '../loaders'
import type { GameId, InstalledMod } from '../../../shared/types'

export interface MissingDepRef {
    id: number | null // null = offsite (SuperBLT etc.), no modworkshop page to navigate to
    name: string
}

export interface HealthItem {
    id: number
    uid: string
    name: string
    missingDeps?: MissingDepRef[]
}

/**
 * Presence-checks every loader the game has, up front: unlike the per-install path this
 * has no single mod's dep list to narrow by, since it reports across the whole pack.
 *
 * bltOk is separate because SuperBLT has no modworkshop page and is matched by the
 * offsite name heuristic instead of a dependency id. It applies to PD2 only: the check
 * looks for PD2's SuperBLT files, so elsewhere it would return a definitive false and flag
 * every blt-named offsite dep as missing. Left null for other games, which leaves those
 * deps unreported.
 */
async function checkLoaders(
    gamePath: string,
    gameId: GameId
): Promise<{ bltOk: boolean | null; loaderModIds: Record<number, boolean | null> }> {
    const loaders = loadersForGame(gameId)
    const states = await Promise.all(
        loaders.map(async (l) => [l.id, await api.checkLoader(l.id, gameId, gamePath)] as const)
    )
    const state: LoaderState = Object.fromEntries(states)
    return {
        bltOk: gameId === 'pd2' ? (state.superblt ?? null) : null,
        loaderModIds: buildLoaderModIds(gameId, state),
    }
}

// Same per-mod dependency check ModDetailPage runs at install time, run retroactively
// across the whole pack. Each id costs a getCachedMod fetch, so call it explicitly,
// never ambiently.
export async function checkMissingDependencies(
    installed: InstalledMod[],
    positiveIds: number[],
    gamePath: string,
    gameId: GameId,
    onProgress?: (checked: number, total: number) => void
): Promise<HealthItem[]> {
    if (positiveIds.length === 0) return []
    const { bltOk, loaderModIds } = await checkLoaders(gamePath, gameId)
    let checked = 0
    const total = positiveIds.length
    const results = await Promise.all(
        positiveIds.map(async (id): Promise<HealthItem | null> => {
            try {
                const mod = await getCachedMod(id)
                const allDeps = collectDeps(mod)
                const missing = missingRequiredDeps(allDeps, installed, bltOk, loaderModIds)
                if (missing.length === 0) return null
                const missingDeps: MissingDepRef[] = missing.map((d) => ({
                    id: d.mod?.id ?? null,
                    name: d.mod?.name ?? d.name ?? (d.url ? offsiteDepHost(d.url) : ''),
                }))
                return { id: mod.id, uid: `dep:${mod.id}`, name: mod.name, missingDeps }
            } catch {
                return null
            } finally {
                onProgress?.(++checked, total)
            }
        })
    )
    return results.filter((r): r is HealthItem => r !== null)
}
