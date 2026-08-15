import type { ModSummary, InstalledMod, ModFolder, ModFile } from '../../../shared/types'

export type ChildEntry =
    { type: 'folder'; folder: ModFolder } | { type: 'mod'; mods: InstalledMod[] }

export type ChildGroup =
    { type: 'folder'; folder: ModFolder } | { type: 'root-group'; groups: InstalledMod[][] }

// Filenames on disk carry a NNN_ priority prefix; archive entry names don't.
// Strip it when comparing the two.
export function stripPriorityPrefix(filename: string): string {
    return filename.replace(/^\d+_/, '')
}

export function entryFilename(entry: string): string {
    return entry.split('/').pop() ?? entry
}

// Filenames on disk carry a NNN_ priority prefix and .pak extension, which are disk-level
// noise for display purposes. Falls back to the raw name if stripping empties it.
export function displayFilename(filename: string): string {
    const stripped = stripPriorityPrefix(filename).replace(/\.pak$/i, '')
    return stripped || filename
}

// Do we know what this mod is? True for any mod whose identity was resolved from its own
// files or from a catalog, so a mod published only on its author's own updater is identified
// exactly as much as a ModWorkshop one. A Candidate is a guess and never counts.
export function isIdentified(m: InstalledMod): boolean {
    return m.identity?.confidence === 'exact' || m.identity?.confidence === 'strong'
}

// Do we have a catalog entry for it? This is what browsing, thumbnails, update checks,
// reinstall and "open mod page" need, and none of them work from local identity alone.
export function hasCatalogLink(m: InstalledMod): boolean {
    return !!m.remoteId
}

// The stable grouping key for one project: several installed files of the same mod belong
// together. Falls back to the installed record while a mod has no resolved identity.
export function identityKey(m: InstalledMod): string {
    const identity = m.identity
    if (identity && isIdentified(m)) return `identity:${identity.namespace}:${identity.key}`
    return hasCatalogLink(m) ? `id:${m.id}` : `uid:${m.uid}`
}

// A mod with no catalog entry has nothing else describing it, so what its own files declare
// is the best name, author and version Modrex has. Catalog-backed mods keep catalog
// presentation, which stays current when the author republishes.
export function withDeclaredMetadata(m: InstalledMod): InstalledMod {
    if (!m.declared || hasCatalogLink(m)) return m
    const { name, author, version } = m.declared
    return {
        ...m,
        name: name ?? m.name,
        author: author ?? m.author,
        version: version ?? m.version,
    }
}

// The real, deduplicated modworkshop ids among the installed list, for the handful of
// call sites (dependency checks) that need to fetch fresh data from modworkshop's own
// API, which only ever takes a real id, never InstalledMod's opaque local one.
export function modworkshopRemoteIds(mods: InstalledMod[]): number[] {
    const ids = new Set<number>()
    for (const m of mods) {
        if (m.source && m.source !== 'modworkshop') continue
        const remoteId = Number(m.remoteId)
        if (Number.isFinite(remoteId) && remoteId > 0) ids.add(remoteId)
    }
    return [...ids]
}

// An InstalledMod.id is always an opaque, source-scoped local key (see Rust's
// sources::source_native_local_id), never a real, callable id for any source, not even
// modworkshop. The in-app detail page needs the real remote id back (plus the 'nexus'
// source flag for Nexus, since ModDetailPage's source prop treats absent as modworkshop)
// to know what to actually fetch.
export function detailNavArgs(ins: InstalledMod): [modId: number, source: 'nexus' | undefined] {
    const remoteModId = Number(ins.remoteId)
    if (Number.isFinite(remoteModId) && remoteModId > 0) {
        return [remoteModId, ins.source === 'nexus' ? 'nexus' : undefined]
    }
    return [ins.id, undefined]
}

const SOURCE_LABELS: Record<string, string> = { nexus: 'Nexus Mods' }

export function syntheticMod(ins: InstalledMod): ModSummary {
    const source = ins.source
    const external = source !== undefined && source !== 'modworkshop'
    return {
        id: ins.id,
        name: ins.name,
        desc: '',
        short_desc: external
            ? `Installed from ${SOURCE_LABELS[source] ?? source}`
            : 'Manually installed — not on ModWorkshop',
        version: ins.version,
        downloads: 0,
        likes: 0,
        views: 0,
        published_at: ins.installedAt,
        bumped_at: ins.installedAt,
        category_id: 0,
        has_download: false,
        disable_mod_managers: null,
        // useThumbnail passes absolute URLs through untouched, so a recorded CDN
        // URL can ride the normal thumbnail field.
        thumbnail: ins.thumbnailUrl ? { file: ins.thumbnailUrl, has_thumb: null } : null,
        download: null,
        user: {
            id: null,
            // ins.author is recorded for non-modworkshop sources, and filled in from the
            // mod's own declaration by withDeclaredMetadata when no catalog describes it.
            name: ins.author ?? (external ? '' : 'Unknown'),
            donation_url: null,
            avatar: null,
            avatar_has_thumb: null,
        },
    }
}

export function getAllModsInFolder(
    mods: InstalledMod[],
    folders: ModFolder[],
    folderId: string
): InstalledMod[] {
    const direct = mods.filter((m) => (m.folderId ?? null) === folderId)
    const childFolders = folders.filter((f) => f.parentId === folderId)
    return [...direct, ...childFolders.flatMap((f) => getAllModsInFolder(mods, folders, f.id))]
}

export function filterInstalled(
    mods: InstalledMod[],
    folders: ModFolder[],
    query: string
): { mods: InstalledMod[]; visibleFolderIds: Set<string> } {
    const lower = query.toLowerCase()
    const matching = mods.filter((m) => m.name.toLowerCase().includes(lower))
    const visibleFolderIds = new Set<string>()
    for (const m of matching) {
        let id = m.folderId ?? null
        while (id) {
            if (visibleFolderIds.has(id)) break
            visibleFolderIds.add(id)
            id = folders.find((f) => f.id === id)?.parentId ?? null
        }
    }
    return { mods: matching, visibleFolderIds }
}

export function normalizeModScopes(mods: InstalledMod[]): InstalledMod[] {
    const groups = new Map<number, InstalledMod[]>()
    for (const m of mods) {
        // Keyed on the installed record, so this is about catalog installs that split across
        // folders, not about which project a mod belongs to.
        if (!hasCatalogLink(m)) continue
        const g = groups.get(m.id)
        if (g) g.push(m)
        else groups.set(m.id, [m])
    }

    const overrides = new Map<string, string | null>()
    for (const [, group] of groups) {
        const scopes = group.map((m) => m.folderId ?? null)
        const distinct = new Set(scopes.map(String))
        if (distinct.size <= 1) continue
        // Only collapse when some files ended up at root, handling the split-install artifact
        // where reinstalling puts some paks at root. Leave intentional multi-folder layouts alone.
        if (!scopes.some((s) => s === null)) continue
        for (const m of group) {
            if ((m.folderId ?? null) !== null) overrides.set(m.uid, null)
        }
    }

    if (overrides.size === 0) return mods
    return mods.map((m) => (overrides.has(m.uid) ? { ...m, folderId: overrides.get(m.uid) } : m))
}

// Folders whose entire subtree was pulled to root by normalizeModScopes, where rendering
// would show an empty duplicate next to the mod's root card. Folders that were already
// empty before normalization (freshly created drop targets) stay visible.
export function foldersEmptiedByNormalize(
    raw: InstalledMod[],
    normalized: InstalledMod[],
    folders: ModFolder[]
): Set<string> {
    const emptied = new Set<string>()
    for (const f of folders) {
        if (getAllModsInFolder(raw, folders, f.id).length === 0) continue
        if (getAllModsInFolder(normalized, folders, f.id).length === 0) emptied.add(f.id)
    }
    return emptied
}

export interface InstalledGroup {
    key: string
    id: number
    mods: InstalledMod[]
}

export function groupInstalledByIdentity(mods: InstalledMod[]): InstalledGroup[] {
    const groups = new Map<string, InstalledGroup>()
    for (const m of mods) {
        const key = identityKey(m)
        const g = groups.get(key)
        if (g) g.mods.push(m)
        else groups.set(key, { key, id: m.id, mods: [m] })
    }
    return [...groups.values()]
}

export interface HealthSummary {
    missing: InstalledGroup[]
    archiveBroken: InstalledGroup[]
    outdated: InstalledGroup[]
    unidentified: InstalledGroup[]
}

// Free-tier health categories, purely local with no network.
export function computeHealthSummary(mods: InstalledMod[]): HealthSummary {
    const groups = groupInstalledByIdentity(mods)
    const suspectFileIds = new Set(findSuspectDuplicateGroups(mods).map((s) => s.fileId))
    return {
        missing: groups.filter((g) => g.mods.some((m) => m.missing)),
        archiveBroken: groups.filter((g) => g.mods.some((m) => m.archiveBroken)),
        outdated: groups.filter(
            (g) =>
                g.mods.some(hasCatalogLink) &&
                (g.mods.some((m) => m.updateStatus === 'outdated') ||
                    g.mods.some((m) => m.fileId != null && suspectFileIds.has(m.fileId)))
        ),
        // Mods whose identity could not be established from their own files or any catalog.
        // A mod published outside every supported catalog is not one of these: Modrex knows
        // what it is, it just cannot offer catalog features for it.
        unidentified: groups.filter((g) => g.mods.every((m) => !isIdentified(m))),
    }
}

export interface SuspectFileGroup {
    fileId: number
    bareUid: string
    archiveUids: string[]
}

// A bare single-file install (install_mod/install_file in mod.rs) uses uid === String(fileId).
// An archive-entry install (install_from_zip_entry/install_cb_flat_archive) uses a uid prefixed
// with "{fileId}_". These two schemes coexisting for the same fileId can only happen when that
// exact file's packaging changed between a plain .pak and an archive at some point, orphaning
// whichever side is not current. See install_from_zip_entry's pre-removal in mod.rs.
// This does NOT fire for legitimate multi-pak archives (several wanted paks sharing one fileId,
// all archive-scheme) or ambient multi-pak discovery (identify.rs's filename-uid fallback,
// which never collides with the "{fileId}_" prefix). Both are real, common, and intentional.
export function findSuspectDuplicateGroups(mods: InstalledMod[]): SuspectFileGroup[] {
    const byFileId = new Map<number, InstalledMod[]>()
    for (const m of mods) {
        // The uid/fileId convention this whole function reasons about is specific to
        // modworkshop's own install paths (install_mod/install_file/install_from_zip_entry
        // in mod.rs). It has no meaning for a Nexus-sourced entry's uid scheme.
        const isModworkshop = !m.source || m.source === 'modworkshop'
        if (!isModworkshop || !hasCatalogLink(m) || m.location || m.fileId == null) continue
        const g = byFileId.get(m.fileId)
        if (g) g.push(m)
        else byFileId.set(m.fileId, [m])
    }
    const suspects: SuspectFileGroup[] = []
    for (const [fileId, group] of byFileId) {
        if (group.length < 2) continue
        const bareUid = String(fileId)
        if (!group.some((m) => m.uid === bareUid)) continue
        const archiveUids = group
            .filter((m) => m.uid !== bareUid && m.uid.startsWith(`${fileId}_`))
            .map((m) => m.uid)
        if (archiveUids.length > 0) suspects.push({ fileId, bareUid, archiveUids })
    }
    return suspects
}

// Resolves which side of a suspect group is actually stale using the mod's live file list.
// the live "type" field (e.g. "pak" vs "zip"/"7z"/"rar") says definitively whether that fileId is
// presently a bare file or an archive, rather than guessing from install timestamps. A fileId no
// longer present in the live list (file deleted upstream) can't be resolved, so it's left unflagged.
export function resolveStaleDuplicates(
    suspects: SuspectFileGroup[],
    files: Pick<ModFile, 'id' | 'type'>[]
): Set<string> {
    const stale = new Set<string>()
    for (const s of suspects) {
        const file = files.find((f) => f.id === s.fileId)
        if (!file) continue
        if (file.type != null && file.type !== 'pak') {
            stale.add(s.bareUid)
            continue
        }
        for (const uid of s.archiveUids) stale.add(uid)
    }
    return stale
}

export function computeChildren(
    mods: InstalledMod[],
    folders: ModFolder[],
    parentId: string | null,
    visibleFolderIds?: Set<string>,
    hiddenFolderIds?: Set<string>
): ChildEntry[] {
    const scopedMods = mods.filter((m) => (m.folderId ?? null) === parentId)
    const groupMap = new Map<number, InstalledMod[]>()
    for (const m of scopedMods) {
        if (!groupMap.has(m.id)) groupMap.set(m.id, [])
        groupMap.get(m.id)!.push(m)
    }
    const items: ChildEntry[] = []
    for (const groupMods of groupMap.values()) {
        groupMods.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        items.push({ type: 'mod', mods: groupMods })
    }
    for (const folder of folders.filter(
        (f) =>
            f.parentId === parentId &&
            (!visibleFolderIds || visibleFolderIds.has(f.id)) &&
            !hiddenFolderIds?.has(f.id)
    )) {
        items.push({ type: 'folder', folder })
    }
    items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'mod' ? -1 : 1
        const pa = a.type === 'folder' ? a.folder.priority : (a.mods[0].priority ?? 0)
        const pb = b.type === 'folder' ? b.folder.priority : (b.mods[0].priority ?? 0)
        return pb - pa
    })
    return items
}

export function groupChildren(entries: ChildEntry[]): ChildGroup[] {
    const groups: ChildGroup[] = []
    let run: InstalledMod[][] = []
    for (const entry of entries) {
        if (entry.type !== 'folder') {
            run.push(entry.mods)
            continue
        }
        if (run.length > 0) {
            groups.push({ type: 'root-group', groups: run })
            run = []
        }
        groups.push({ type: 'folder', folder: entry.folder })
    }
    if (run.length > 0) groups.push({ type: 'root-group', groups: run })
    return groups
}
