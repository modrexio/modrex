import type { Mod, ModDependency, InstalledMod } from '../../shared/types'

// Every numeric id in this file is a modworkshop mod id, and every check applies to
// modworkshop dependency metadata only. Never feed ids from another source (Nexus,
// mod.io) into these tables: two sources collide on numbers. InstalledMod.id is an
// opaque, source-scoped local key (see sources::source_native_local_id on the Rust
// side), never a real modworkshop id even for a modworkshop-sourced entry, so matching
// against a real id here always goes through remoteId instead.

/**
 * Combines a mod's direct and instructs-template dependencies, keeping
 * modworkshop-hosted deps (mod set) and offsite deps (url set, e.g.
 * SuperBLT). Deps whose mod was deleted (neither set) are dropped.
 * Sorted by the author-defined order (id as tiebreak), matching modworkshop:
 * the sequence is meaningful install order, not arbitrary.
 */
export function collectDeps(mod: Mod | null | undefined): ModDependency[] {
    return [...(mod?.dependencies ?? []), ...(mod?.instructs_template?.dependencies ?? [])]
        .filter((d) => d.mod !== null || !!d.url)
        .sort((a, b) =>
            (a.order ?? 0) === (b.order ?? 0) ? a.id - b.id : (a.order ?? 0) - (b.order ?? 0)
        )
}

export function isOffsiteDep(d: ModDependency): boolean {
    return d.mod === null && !!d.url
}

/**
 * SuperBLT is declared on modworkshop as an offsite dependency (it has no mod page).
 * It lives in the game root as a loader DLL, so its install state comes from
 * api.checkSuperblt, not the installed-mods list. PD2 only: that check looks for PD2's
 * SuperBLT files, so every other caller leaves the loader state null rather than running
 * a check that cannot answer for its game.
 */
export function isLoaderDep(d: ModDependency): boolean {
    return isOffsiteDep(d) && `${d.name ?? ''} ${d.url ?? ''}`.toLowerCase().includes('blt')
}

/**
 * Required deps the user does not have. loaderInstalled is api.checkSuperblt's result,
 * where null means unknown: loader deps are only reported missing on a definitive negative,
 * so detection gaps never nag users who already have the loader. Non-loader offsite deps
 * cannot be verified and are always surfaced, with the per-mod dismissal handling false
 * positives. loaderModIds covers loaders hosted on modworkshop, checked against their
 * per-id presence rather than the installed-mods list.
 */
export function missingRequiredDeps(
    allDeps: ModDependency[],
    installed: InstalledMod[],
    loaderInstalled: boolean | null,
    loaderModIds: Record<number, boolean | null> = {}
): ModDependency[] {
    return allDeps.filter((d) => {
        if (d.optional) return false
        if (d.mod !== null) {
            const id = d.mod.id
            if (id in loaderModIds) return loaderModIds[id] === false
            const idStr = String(id)
            return !installed.some(
                (m) => (!m.source || m.source === 'modworkshop') && m.remoteId === idStr
            )
        }
        if (!d.url) return false
        if (isLoaderDep(d)) return loaderInstalled === false
        return true
    })
}

export function offsiteDepHost(url: string): string {
    try {
        return new URL(url).hostname
    } catch {
        return url
    }
}
