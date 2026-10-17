import { api, type LoaderInfo } from './api'

// Mirrors the Rust loader registry (src-tauri/src/commands/loaders.rs), which owns which
// loaders exist, the modworkshop ids they are published under, and the games they serve.
// Loaded once at startup so the lookups below can stay synchronous: they run inside
// render paths (ModDetailPage computes its dep warning while rendering).
let registry: LoaderInfo[] = []
let loading: Promise<void> | null = null

// Shared by every caller, so a consumer that must not read the registry before it lands can
// await the same request startup made. A failed load is forgotten so the next caller retries.
export function loadLoaderRegistry(): Promise<void> {
    loading ??= api.listLoaders().then(
        (loaded) => {
            registry = loaded
        },
        (error: unknown) => {
            loading = null
            throw error
        }
    )
    return loading
}

export function loadersForGame(gameId: string): LoaderInfo[] {
    return registry.filter((l) => l.games.includes(gameId))
}

/** The loader a modworkshop dependency id refers to, if any. */
export function loaderForModId(gameId: string, modId: number): LoaderInfo | undefined {
    return loadersForGame(gameId).find((l) => l.modworkshopIds.includes(modId))
}

/**
 * Per-loader install state, keyed by loader id. null = not checked yet; loader deps are
 * only reported missing on a definitive false, so an unchecked loader never nags.
 */
export type LoaderState = Record<string, boolean | null>

/**
 * Per-modworkshop-id install state in the shape missingRequiredDeps expects, expanding
 * each loader's state across every id it is published under (UE4SS has three).
 */
export function buildLoaderModIds(
    gameId: string,
    state: LoaderState
): Record<number, boolean | null> {
    const byId: Record<number, boolean | null> = {}
    for (const loader of loadersForGame(gameId)) {
        for (const modId of loader.modworkshopIds) {
            byId[modId] = state[loader.id] ?? null
        }
    }
    return byId
}

/**
 * Whether the release a given mod page distributes is the one installed.
 *
 * Deliberately not the same question as buildLoaderModIds, which asks whether any loader is
 * present. UE4SS ships from several pages, and answering the page's own question with the
 * general one leaves every page but the installed one claiming to be installed, so there is
 * no way to switch between them. A loader nothing can attribute reads as not installed from
 * every page, which is what makes it replaceable rather than stuck.
 *
 * Dependency rows keep asking the general question: a Lua mod needs a loader, not a
 * particular page's build of one.
 *
 * ue4ssPageId is the page the installed files are attributable to, or null when nothing can
 * attribute them. It is meaningless for every other loader, each of which has one page.
 */
export function loaderPageInstalled(
    gameId: string,
    modId: number,
    state: LoaderState,
    ue4ssPageId: number | null
): boolean | null {
    const loader = loaderForModId(gameId, modId)
    if (!loader) return null
    const present = state[loader.id] ?? null
    if (loader.id !== 'ue4ss' || present !== true) return present
    return ue4ssPageId === modId
}

/**
 * Checks every loader for a game whose state is still unknown and that the mod actually
 * depends on, so a dep warning is decided from definitive values. neededIds are the
 * dependency mod ids in play; a loader is only probed when one of its ids appears there.
 */
export async function resolveLoaderState(
    gameId: string,
    gamePath: string,
    neededIds: number[],
    known: LoaderState
): Promise<LoaderState> {
    const resolved: LoaderState = { ...known }
    await Promise.all(
        loadersForGame(gameId).map(async (loader) => {
            if (resolved[loader.id] != null) return
            if (!loader.modworkshopIds.some((id) => neededIds.includes(id))) return
            resolved[loader.id] = await api.checkLoader(loader.id, gameId, gamePath)
        })
    )
    return resolved
}
