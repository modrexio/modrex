import type { InstalledMod, Mod, ModFile, ModSummary } from '../../shared/types'
import type { NexusFileCheck } from './api'
import type { VersionState } from './modVersions'

export function updatableMods(
    installed: InstalledMod[],
    versions: ReadonlyMap<number, VersionState>,
    summaries: ReadonlyMap<number, ModSummary>,
    nexusFiles: ReadonlyMap<number, readonly NexusFileCheck[]>
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
        const summary = summaries.get(id)
        if (summary?.download_type === 'link' || summary?.disable_mod_managers) continue
        const present = group.filter((mod) => !mod.missing)
        // A page version bump alone does not outdate a file that is still the newest in
        // its Nexus update chain. Installs with no file id keep the version comparison.
        const checks = nexusFiles.get(id)
        if (checks) {
            const replaced = present.find((mod) =>
                checks.some(
                    (check) =>
                        check.fileId === nexusFileId(mod) && check.update.status !== 'current'
                )
            )
            if (replaced) updates.push(replaced)
            continue
        }
        const confirmed = present.find((mod) => mod.updateStatus === 'outdated')
        if (confirmed) {
            updates.push(confirmed)
            continue
        }
        const comparable = present.filter((mod) => mod.updateStatus !== 'unknown' && mod.version)
        if (comparable.length && comparable.every((mod) => mod.version !== remote.version)) {
            updates.push(comparable[0]!)
        }
    }
    return updates
}

export function nexusFileId(mod: InstalledMod): number | undefined {
    const id = Number(mod.fileRemoteId ?? mod.fileId)
    return Number.isInteger(id) && id > 0 && id <= 0xffff_ffff ? id : undefined
}

export type UpdateTarget =
    | { status: 'unchanged' }
    | { status: 'unavailable' }
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
        return { status: 'unavailable' }
    return defaultFileIsUnambiguous(present, detail, files)
        ? { status: 'install' }
        : { status: 'choose' }
}

// Any other listed file may be a variant the user picked.
export function defaultFileIsUnambiguous(
    installed: InstalledMod[],
    detail: Mod,
    files: ModFile[]
): boolean {
    const download = detail.download
    const replaceable = (mod: InstalledMod) =>
        mod.fileId === download?.id ||
        (mod.fileId !== undefined && !files.some((file) => file.id === mod.fileId))
    if (download && installed.length && installed.every(replaceable)) return true
    if (detail.files_are_versions === true && detail.download_id === null) return true
    return files.length === 1
}
