import type { GameId } from '@modrex/games'
import type {
    InstalledMod_Serialize,
    InstalledResponse_Serialize,
    ModDetail,
    ModFolder,
    TopLevelItem,
} from '../../shared/bindings'
import { emit } from './tauri/event'
import { previewState, type LibraryProfile } from './previewState'

type Mod = InstalledMod_Serialize
export type WorkshopFile = { id: number; version: string; type: string | null }
type InstallTemplate = { detail: ModDetail; file: WorkshopFile }

const DOWNLOAD_STEPS = 12
const DOWNLOAD_STEP_MS = 120
const DEFAULT_SIZE = 2_500_000
export const LARGE_LIBRARY_SIZE = 120

export class Library {
    mods: Mod[] = []
    folders: ModFolder[] = []
    seeded = false
    private nextFolder = 1

    response(): InstalledResponse_Serialize {
        return { mods: this.mods, folders: this.folders, modsHidden: false, stateUnreadable: false }
    }

    mod(uid: string): Mod {
        const found = this.mods.find((m) => m.uid === uid)
        if (!found) throw new Error(`preview: no installed mod ${uid}`)
        return found
    }

    folder(id: string): ModFolder {
        const found = this.folders.find((f) => f.id === id)
        if (!found) throw new Error(`preview: no folder ${id}`)
        return found
    }

    install(entry: Mod) {
        this.mods = this.mods.filter((m) => m.uid !== entry.uid)
        const scope = this.scopedMods(entry.folderId ?? null)
        scope.unshift(entry)
        this.mods.push(entry)
        this.assignPriorities(scope)
    }

    uninstall(uid: string) {
        this.mods = this.mods.filter((m) => m.uid !== uid)
    }

    setEnabled(uid: string, enabled: boolean) {
        this.mod(uid).enabled = enabled
    }

    toggleCrimeBossTarget(uid: string) {
        const mod = this.mod(uid)
        mod.location = mod.location === 'paks' ? null : 'paks'
    }

    createFolder(displayName: string, parentId: string | null): ModFolder {
        const folder = {
            id: `folder-${this.nextFolder++}`,
            diskName: displayName,
            displayName,
            priority: this.folders.length + 1,
            parentId,
        }
        this.folders.push(folder)
        return folder
    }

    renameFolder(id: string, displayName: string) {
        const folder = this.folder(id)
        folder.displayName = displayName
        folder.diskName = displayName
    }

    deleteFolder(id: string) {
        const parentId = this.folder(id).parentId
        for (const m of this.mods) if (m.folderId === id) m.folderId = parentId
        for (const f of this.folders) if (f.parentId === id) f.parentId = parentId
        this.folders = this.folders.filter((f) => f.id !== id)
    }

    moveFolder(id: string, parentId: string | null) {
        this.folder(id).parentId = parentId
    }

    moveToFolder(uid: string, folderId: string | null, position: number) {
        const mod = this.mod(uid)
        mod.folderId = folderId
        const scope = this.scopedMods(folderId).filter((m) => m.uid !== uid)
        scope.splice(Math.min(position, scope.length), 0, mod)
        this.assignPriorities(scope)
    }

    reorderInFolder(folderId: string | null, orderedUids: string[]) {
        const total = orderedUids.length
        for (const m of this.scopedMods(folderId)) {
            const pos = orderedUids.indexOf(m.uid)
            if (pos !== -1) m.priority = total - pos
        }
    }

    reorderChildren(items: TopLevelItem[]) {
        const total = items.length
        items.forEach((item, pos) => {
            const priority = total - pos
            if (item.type === 'folder') this.folder(item.id).priority = priority
            else this.mod(item.id).priority = priority
        })
    }

    seed(
        records: Record<string, { detail: ModDetail; files: { data: WorkshopFile[] } }>,
        profile: Exclude<LibraryProfile, 'empty'>
    ) {
        const templates = Object.values(records).flatMap(({ detail, files }) => {
            const file = detail.download ?? files.data[0]
            return file ? [{ detail, file }] : []
        })
        if (templates.length === 0)
            throw new Error('preview: library fixture has no installable mods')

        switch (profile) {
            case 'demo':
                this.seedDemo(templates)
                break
            case 'large':
                this.seedLarge(templates)
                break
        }
        this.seeded = true
    }

    private seedDemo(templates: InstallTemplate[]) {
        if (templates.length < 6) {
            throw new Error('preview: demo library fixture requires six installable mods')
        }
        const folder = this.createFolder('Cosmetics', null)
        templates.slice(0, 6).forEach(({ detail, file }, index) => {
            const mod = installedFromWorkshop(detail, file, index < 2 ? folder.id : null)
            if (index === 2) mod.enabled = false
            if (index === 3) mod.missing = true
            if (index === 4) {
                mod.version = '0.9'
                mod.updateStatus = 'outdated'
            }
            this.install(mod)
        })
    }

    private seedLarge(templates: InstallTemplate[]) {
        const folders = ['Cosmetics', 'Gameplay', 'Audio', 'Interface', 'Utilities'].map((name) =>
            this.createFolder(name, null)
        )
        for (let index = 0; index < LARGE_LIBRARY_SIZE; index++) {
            const { detail, file } = templates[index % templates.length]
            const variant = Math.floor(index / templates.length) + 1
            const folderId =
                index % (folders.length + 1) === 0 ? null : folders[index % folders.length].id
            const mod = installedFromWorkshop(detail, file, folderId)
            mod.uid = `preview-large-${index + 1}`
            // The volume profile represents separate projects. Unique identities prevent the
            // installed page from folding repeated fixture templates into one multi-file card.
            mod.identity = {
                namespace: 'preview-volume',
                key: String(index + 1),
                evidence: 'installProvenance',
                confidence: 'exact',
            }
            if (variant > 1) mod.name = `${mod.name} Variant ${variant}`
            this.install(mod)
        }
    }

    private scopedMods(folderId: string | null): Mod[] {
        return this.mods
            .filter((m) => (m.folderId ?? null) === folderId)
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    }

    private assignPriorities(ordered: Mod[]) {
        ordered.forEach((m, pos) => {
            m.priority = ordered.length - pos
        })
    }
}

const libraries = new Map<GameId, Library>()

export function library(gameId: GameId): Library {
    const existing = libraries.get(gameId)
    if (existing) return existing
    const created = new Library()
    libraries.set(gameId, created)
    return created
}

export async function simulateDownload(downloadId: string, size: number | null) {
    const total = size ?? DEFAULT_SIZE
    const stepMs = previewState.network === 'slow' ? DOWNLOAD_STEP_MS * 8 : DOWNLOAD_STEP_MS
    for (let step = 1; step <= DOWNLOAD_STEPS; step++) {
        await new Promise((resolve) => setTimeout(resolve, stepMs))
        const downloaded = Math.round((total * step) / DOWNLOAD_STEPS)
        await emit('download:progress', { download_id: downloadId, downloaded, total })
    }
}

// InstalledMod.id is an opaque source-scoped key (sources::source_native_local_id in Rust)
// and is never compared with the modworkshop id, so any unique negative number serves.
export function installedFromWorkshop(
    detail: ModDetail,
    file: WorkshopFile,
    folderId: string | null
): Mod {
    const remoteId = String(detail.id)
    const fileType = file.type ?? 'pak'
    return {
        uid: String(file.id),
        id: -detail.id,
        name: detail.name,
        version: file.version || detail.version,
        filename: `${detail.name}.${fileType}`,
        enabled: true,
        installedAt: new Date().toISOString(),
        source: 'modworkshop',
        remoteId,
        fileId: file.id,
        fileType,
        folderId,
        identity: {
            namespace: 'modworkshop',
            key: remoteId,
            evidence: 'installProvenance',
            confidence: 'exact',
        },
    }
}
