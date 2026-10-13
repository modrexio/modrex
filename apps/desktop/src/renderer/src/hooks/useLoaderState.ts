import { useCallback, useState } from 'react'
import type { GameId } from '../../../shared/types'
import { api } from '../api'
import { requestInstallChoice } from '../installChoices'
import {
    buildLoaderModIds,
    loaderForModId,
    loaderPageInstalled as pageInstalled,
    type LoaderState,
} from '../loaders'

/**
 * Per-loader presence state plus the install dispatch, shared by BrowsePage and
 * ModDetailPage. Both need the same three things: a keyed state map, a re-check after
 * installing, and the registry-driven choice between a direct loader install and the
 * normal mod flow.
 *
 * The presence-check effects stay in the components: BrowsePage checks every loader
 * with a mod page when browse becomes active, while ModDetailPage checks only the
 * loaders the open mod actually depends on.
 */
export function useLoaderState(activeGame: GameId, gamePath: string | null) {
    const [loaderState, setLoaderState] = useState<LoaderState>({})
    // Which UE4SS page the installed files are attributable to. Several pages distribute the
    // same loader, so one presence flag cannot say which of them is on disk; null means
    // present but unattributable, and no page may claim it then.
    const [ue4ssPageId, setUe4ssPageId] = useState<number | null>(null)

    const setLoaderFlag = useCallback(
        (id: string, value: boolean | null) => setLoaderState((prev) => ({ ...prev, [id]: value })),
        []
    )

    /**
     * Re-reads presence rather than assuming an install succeeded: a loader can be on
     * disk and still unusable (SuperBLT on PD2's Diesel 3.0 branch), and an optimistic
     * true would make the UI claim Installed while the install flow reports it missing.
     */
    const refreshLoader = useCallback(
        async (id: string): Promise<boolean | null> => {
            if (!gamePath) return null
            const ok = await api.checkLoader(id, activeGame, gamePath)
            setLoaderFlag(id, ok)
            return ok
        },
        [activeGame, gamePath, setLoaderFlag]
    )

    /**
     * Installs the loader behind a dependency and returns its presence afterwards.
     * loaderModId is the dependency's modworkshop id, or null for an offsite BLT dep
     * (SuperBLT has no mod page). A viaModFlow loader has no canonical download host and
     * is routed server-side via the UE4SS_LOADER sentinel, so it rides the normal mod
     * install instead.
     */
    const installLoader = useCallback(
        async (loaderModId: number | null): Promise<boolean | null> => {
            if (!gamePath) return null
            const loader =
                loaderModId === null ? undefined : loaderForModId(activeGame, loaderModId)
            if (loader?.viaModFlow) {
                const outcome = await api.installMod(loaderModId!, gamePath, activeGame)
                await requestInstallChoice(outcome, activeGame, gamePath, [], null, loaderModId!)
                return refreshLoader(loader.id)
            }
            const id = loader?.id ?? 'superblt'
            await api.installLoader(id, gamePath)
            return refreshLoader(id)
        },
        [activeGame, gamePath, refreshLoader]
    )

    const refreshUe4ssPage = useCallback(async () => {
        if (!gamePath) return
        const presence = await api.ue4ssPresence(activeGame, gamePath)
        setUe4ssPageId(presence.modworkshopId ?? null)
    }, [activeGame, gamePath])

    const loaderPageInstalled = useCallback(
        (modId: number): boolean | null =>
            pageInstalled(activeGame, modId, loaderState, ue4ssPageId),
        [activeGame, loaderState, ue4ssPageId]
    )

    return {
        loaderState,
        ue4ssPageId,
        refreshUe4ssPage,
        loaderPageInstalled,
        setLoaderState,
        setLoaderFlag,
        refreshLoader,
        installLoader,
        loaderModIds: buildLoaderModIds(activeGame, loaderState),
    }
}
