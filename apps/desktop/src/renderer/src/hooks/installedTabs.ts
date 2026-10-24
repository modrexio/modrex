import type { InstalledMod, ModFolder } from '../../../shared/types'
import type { LoaderInfo } from '../api'
import { hasCatalogLink, identityKey, isLoader } from './installedUtils'

export const GAME_FILES_TAB = 'game_files'

export function installedTabKey(
    mod: InstalledMod,
    hosts: ReadonlyMap<string, InstalledMod>,
    primaryTag: string,
    loaders: LoaderInfo[],
    targetTags: string[]
): string {
    if (mod.deployment) return GAME_FILES_TAB
    if (!mod.location) return primaryTag
    if (mod.location.startsWith('loader:')) {
        const loaderId = mod.location.slice('loader:'.length)
        return loaders.find((loader) => loader.id === loaderId)?.target ?? primaryTag
    }
    if (mod.location.startsWith('host:')) {
        const hostId = mod.location.split(':')[1]
        // Host locations carry a ModWorkshop page ID, not an installed record ID.
        const host = hosts.get(hostId!)
        return host ? installedTabKey(host, hosts, primaryTag, loaders, targetTags) : primaryTag
    }
    return targetTags.includes(mod.location) ? mod.location : primaryTag
}

/**
 * The tabs to show, in target order with game files last. Empty while fewer than two
 * locations hold mods, which renders the page without tabs. Once tabs show, the primary
 * target always has one, since its app folders and New folder live there.
 */
export function orderedTabKeys(targetTags: string[], present: Iterable<string>): string[] {
    const keys = new Set(present)
    const holding = targetTags.filter((tag) => keys.has(tag))
    if (keys.has(GAME_FILES_TAB)) holding.push(GAME_FILES_TAB)
    if (holding.length < 2) return []
    if (holding[0] === targetTags[0]) return holding
    return [targetTags[0]!, ...holding]
}

/** The remembered tab when it is still shown, else the first tab, or null without tabs. */
export function activeTabKey(tabKeys: string[], saved: string | null): string | null {
    if (saved !== null && tabKeys.includes(saved)) return saved
    return tabKeys[0] ?? null
}

/** Whether a mod puts the problem dot on its tab, matching what the cards flag for review. */
export function needsAttention(mod: InstalledMod): boolean {
    return (
        !!mod.missing ||
        !!mod.containerMissing ||
        !!mod.archiveBroken ||
        mod.resourceStatus === 'diverged' ||
        mod.resourceStatus === 'blocked'
    )
}

/** The folders that hold any of these mods, with every ancestor, in the given folder order. */
export function foldersHoldingMods(mods: InstalledMod[], folders: ModFolder[]): ModFolder[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    const holding = new Set<string>()
    for (const mod of mods) {
        let id = mod.folderId ?? null
        while (id !== null && !holding.has(id)) {
            holding.add(id)
            id = byId.get(id)?.parentId ?? null
        }
    }
    return folders.filter((folder) => holding.has(folder.id))
}

/**
 * Only catalog projects share files across tabs. Local names can collide, game resources
 * are reviewed separately, and loaders are detected rather than tracked.
 */
export function joinsFileSet(mod: InstalledMod): boolean {
    return hasCatalogLink(mod) && !mod.deployment && !isLoader(mod)
}

export interface OtherTabFiles {
    files: InstalledMod[]
    tabKeys: string[]
}

/**
 * The files each mod has on tabs other than the active one, keyed by project identity. One mod
 * can span locations, a pak with its Lua half or a BLT mod with its asset overrides, so an
 * action on one tab's card has to reach these too or the other half keeps loading.
 */
export function filesOnOtherTabs(
    installed: InstalledMod[],
    tabOf: Map<string, string>,
    activeTab: string
): Map<string, OtherTabFiles> {
    const byIdentity = new Map<string, OtherTabFiles>()
    for (const mod of installed) {
        const tab = tabOf.get(mod.uid)!
        if (tab === activeTab || !joinsFileSet(mod)) continue
        const key = identityKey(mod)
        const entry = byIdentity.get(key) ?? { files: [], tabKeys: [] }
        entry.files.push(mod)
        if (!entry.tabKeys.includes(tab)) entry.tabKeys.push(tab)
        byIdentity.set(key, entry)
    }
    return byIdentity
}
