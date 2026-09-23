import type { InstalledMod, Mod, ModFile } from '../../shared/types'
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
    | { status: 'external'; url: string }
    | { status: 'install' }
    | { status: 'choose' }

export function resolveUpdateTarget(
    installed: InstalledMod[],
    detail: Mod,
    files: ModFile[]
): UpdateTarget {
    const present = installed.filter((mod) => !mod.missing)
    const hasOutdatedBytes = present.some((mod) => mod.updateStatus === 'outdated')
    if (
        !detail.version ||
        (!hasOutdatedBytes && present.some((mod) => mod.version === detail.version))
    )
        return { status: 'unchanged' }
    const download = detail.download
    if (
        detail.disable_mod_managers ||
        (download && !download.download_url) ||
        (!download && !files.length)
    )
        return {
            status: 'external',
            url: download?.url ?? `https://modworkshop.net/mod/${detail.id}`,
        }
    return defaultFileIsUnambiguous(present, detail, files)
        ? { status: 'install' }
        : { status: 'choose' }
}

// Other files can be variants or parts of the mod unless the author marks them as
// versions and pins none of them, or has removed every file that is installed.
export function defaultFileIsUnambiguous(
    installed: InstalledMod[],
    detail: Mod,
    files: ModFile[]
): boolean {
    const download = detail.download
    if (download && installed.length && installed.every((mod) => mod.fileId === download.id))
        return true
    const removed = (mod: InstalledMod) =>
        mod.fileId !== undefined && !files.some((file) => file.id === mod.fileId)
    if (download && installed.length && installed.every(removed)) return true
    if (detail.files_are_versions === true && detail.download_id === null) return true
    return files.length === 1
}
