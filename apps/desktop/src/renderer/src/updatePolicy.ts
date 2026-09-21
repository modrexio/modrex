import type { InstalledMod, Mod } from '../../shared/types'
import type { VersionState } from './modVersions'

export function updatableMods(
    installed: InstalledMod[],
    versions: ReadonlyMap<number, VersionState>
): InstalledMod[] {
    const groups = new Map<number, InstalledMod[]>()
    for (const mod of installed) {
        const group = groups.get(mod.id)
        if (group) group.push(mod)
        else groups.set(mod.id, [mod])
    }
    const updates: InstalledMod[] = []
    for (const [id, group] of groups) {
        const remote = versions.get(id)
        if (remote?.status !== 'known') continue
        const present = group.filter((mod) => !mod.missing)
        const confirmed = present.find((mod) => mod.updateStatus === 'outdated')
        if (confirmed) {
            updates.push(confirmed)
            continue
        }
        const comparable = present.filter((mod) => mod.updateStatus !== 'unknown' && mod.version)
        if (comparable.length && comparable.every((mod) => mod.version !== remote.version)) {
            updates.push(comparable[0])
        }
    }
    return updates
}

export type UpdateTarget =
    | { status: 'unchanged' }
    | { status: 'review' }
    | { status: 'ready'; download: NonNullable<Mod['download']> & { download_url: string } }

export function resolveUpdateTarget(installed: InstalledMod[], detail: Mod): UpdateTarget {
    const currentBytes = installed.filter((mod) => !mod.missing)
    const hasOutdatedBytes = currentBytes.some((mod) => mod.updateStatus === 'outdated')
    if (
        !detail.version ||
        (!hasOutdatedBytes && currentBytes.some((mod) => mod.version === detail.version))
    )
        return { status: 'unchanged' }
    const download = detail.download
    // Existing records do not prove default-following intent. A different file ID
    // requires review rather than replacing a deliberately selected variant.
    if (
        detail.disable_mod_managers ||
        !download?.download_url ||
        !installed.length ||
        installed.some((mod) => mod.fileId !== download.id || mod.missing)
    )
        return { status: 'review' }
    return { status: 'ready', download: { ...download, download_url: download.download_url } }
}
