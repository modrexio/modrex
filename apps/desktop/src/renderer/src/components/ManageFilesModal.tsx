import { useEffect, useState } from 'react'
import { Button } from './ui/Button'
import { SearchClearButton } from './ui/SearchClearButton'
import { Trash2, ChevronDown, ChevronRight, Search, Download } from 'lucide-react'
import type { InstalledMod, ModFolder } from '../../../shared/types'
import { Toggle } from './Toggle'
import { Dialog, DialogHeader } from './Dialog'
import { Tooltip } from './Tooltip'
import { t } from '../i18n'
import { api } from '../api'
import {
    displayFilename,
    entryFilename,
    stripPriorityPrefix,
    findSuspectDuplicateGroups,
    resolveStaleDuplicates,
    hasCatalogLink,
} from '../hooks/installedUtils'
import { getCachedModFiles } from '../modCache'
import { getArchiveEntries, mergeArchiveEntries, setArchiveEntries } from '../archiveEntriesCache'
import type { ZipMultiPakPayload } from './ZipPickerModal'
import { useInstalledContext } from './InstalledContext'

interface Props {
    mods: InstalledMod[]
    modName: string
    onClose: () => void
}

function getFolderPath(folders: ModFolder[], folderId: string | null): string | null {
    if (!folderId) return null
    const folder = folders.find((f) => f.id === folderId)
    if (!folder) return null
    const parent = getFolderPath(folders, folder.parentId)
    return parent ? `${parent}/${folder.diskName}` : folder.diskName
}

function entryDir(entry: string): string {
    const i = entry.lastIndexOf('/')
    return i === -1 ? '' : entry.slice(0, i)
}

function getFolderDisplayPath(folders: ModFolder[], folderId: string | null): string | null {
    if (!folderId) return null
    const folder = folders.find((f) => f.id === folderId)
    if (!folder) return null
    const parent = getFolderDisplayPath(folders, folder.parentId)
    return parent ? `${parent}/${folder.displayName}` : folder.displayName
}

interface GhostFile {
    entry: string
    fileId: number
    folderId: string | null
}

export function ManageFilesModal({ mods, modName, onClose }: Props) {
    const {
        handleEnable,
        handleDisable,
        handleUninstall,
        loadingMod,
        gamePath,
        activeGame,
        folders,
        installed,
        onRefreshInstalled,
    } = useInstalledContext()
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
    const [query, setQuery] = useState('')
    const [installingEntry, setInstallingEntry] = useState<string | null>(null)
    const [installError, setInstallError] = useState<string | null>(null)
    // Bumped when the SHA256 index lands in the cache so ghosts recompute
    const [, setIndexSynced] = useState(0)
    const [staleUids, setStaleUids] = useState<Set<string>>(new Set())

    const rawById = new Map(installed.map((m) => [m.uid, m]))

    // Resolves suspect bare and archive uid collisions against the mod's live file list. The
    // current file "type" (pak vs zip/7z/rar) says definitively which side is the leftover,
    // rather than guessing from install timestamps. See findSuspectDuplicateGroups in
    // installedUtils.ts for why a structural collision is required before this even runs.
    useEffect(() => {
        const suspects = findSuspectDuplicateGroups(mods)
        const remoteId = Number(mods[0].remoteId)
        if (suspects.length === 0 || !Number.isFinite(remoteId) || remoteId <= 0) {
            setStaleUids(new Set())
            return
        }
        let cancelled = false
        getCachedModFiles(remoteId)
            .then((files) => {
                if (!cancelled) setStaleUids(resolveStaleDuplicates(suspects, files))
            })
            .catch(() => {
                // best-effort: leave staleUids empty rather than guess
            })
        return () => {
            cancelled = true
        }
    }, [mods])

    // Seed the cache from what's installed right now, so deletions show up as
    // installable rows even for mods installed before the cache existed.
    useEffect(() => {
        if (!hasCatalogLink(mods[0])) return
        const byId = new Map(installed.map((m) => [m.uid, m]))
        const byFileId = new Map<number, string[]>()
        for (const m of mods) {
            if (m.fileId == null || m.uid === String(m.fileId)) continue
            const dir = getFolderDisplayPath(folders, byId.get(m.uid)?.folderId ?? null)
            const name = stripPriorityPrefix(m.filename)
            const paths = byFileId.get(m.fileId) ?? []
            paths.push(dir ? `${dir}/${name}` : name)
            byFileId.set(m.fileId, paths)
        }
        for (const [fileId, paths] of byFileId) mergeArchiveEntries(activeGame, fileId, paths)
    }, [mods, installed, folders, activeGame])

    // The SHA256 index knows every pak a mod's archives ship, so merge it in and
    // files deleted before Modrex ever saw the archive still show up as ghosts.
    // Only archives the user actually installed from count: other remote files
    // (alternate downloads, old versions) were never theirs, and bare-file
    // installs (uid === fileId) cannot match, since the app renames them on disk and
    // the index only has the CDN blob name for them, not a real filename.
    // The real modworkshop id (api.getIndexModFiles/getCachedModFiles/installModFile all
    // need this). InstalledMod.id is an opaque local key, never that, even here.
    const modRemoteId = Number(mods[0].remoteId)
    useEffect(() => {
        if (!Number.isFinite(modRemoteId) || modRemoteId <= 0) return
        const archiveFileIds = new Set(
            mods.filter((m) => m.fileId != null && m.uid !== String(m.fileId)).map((m) => m.fileId)
        )
        if (archiveFileIds.size === 0) return
        let cancelled = false
        api.getIndexModFiles(modRemoteId, activeGame)
            .then((rows) => {
                if (cancelled) return
                const byFileId = new Map<number, string[]>()
                for (const r of rows) {
                    if (!archiveFileIds.has(r.fileRemoteId)) continue
                    if (!r.entryName.toLowerCase().endsWith('.pak')) continue
                    const arr = byFileId.get(r.fileRemoteId) ?? []
                    arr.push(r.entryName)
                    byFileId.set(r.fileRemoteId, arr)
                }
                if (byFileId.size === 0) return
                for (const [fileId, entries] of byFileId) {
                    mergeArchiveEntries(activeGame, fileId, entries)
                }
                setIndexSynced((v) => v + 1)
            })
            .catch(() => {
                // index lookup is best-effort; ghosts fall back to local knowledge
            })
        return () => {
            cancelled = true
        }
    }, [modRemoteId, mods, activeGame])

    function toggleCollapse(folderId: string) {
        setCollapsed((prev) => {
            const next = new Set(prev)
            if (next.has(folderId)) next.delete(folderId)
            else next.add(folderId)
            return next
        })
    }

    async function handleToggleMod(mod: InstalledMod) {
        if (loadingMod) return
        if (mod.enabled) await handleDisable([mod])
        else await handleEnable([mod])
    }

    async function handleToggleGroup(groupMods: InstalledMod[]) {
        if (loadingMod) return
        const anyEnabled = groupMods.some((m) => m.enabled)
        if (anyEnabled) await handleDisable(groupMods)
        else await handleEnable(groupMods)
    }

    async function handleRemove(targets: InstalledMod[]) {
        if (loadingMod) return
        await handleUninstall(targets)
        if (mods.length <= targets.length) onClose()
    }

    async function handleInstallEntry(ghost: GhostFile) {
        if (!gamePath || loadingMod || installingEntry) return
        if (!Number.isFinite(modRemoteId) || modRemoteId <= 0) return
        setInstallError(null)
        setInstallingEntry(ghost.entry)
        try {
            const files = await getCachedModFiles(modRemoteId)
            const file = files.find((f) => f.id === ghost.fileId)
            if (!file?.download_url) {
                setInstallError(t('installed.manageFiles.fileUnavailable'))
                return
            }
            const outcome = await api.installModFile(
                modRemoteId,
                modName,
                file.id,
                file.download_url,
                file.type ?? '',
                mods[0].version,
                gamePath,
                activeGame
            )
            if (typeof outcome !== 'string' && 'needsPicker' in outcome) {
                const zip = outcome.needsPicker as unknown as ZipMultiPakPayload
                // The archive is authoritative, so heal the cache and resolve the
                // real entry path (cached ghosts may carry a reconstructed one).
                setArchiveEntries(activeGame, zip.fileId, zip.entries)
                const realEntry = zip.entries.find(
                    (en) => entryFilename(en) === entryFilename(ghost.entry)
                )
                if (!realEntry) {
                    await api.deleteTempFile(zip.zipPath)
                    setInstallError(t('installed.manageFiles.fileUnavailable'))
                    return
                }
                // Mixed-target archives carry a per-entry tag; fall back to the single targetTag.
                const realIdx = zip.entries.indexOf(realEntry)
                const locationTag = zip.entryTags?.[realIdx] ?? zip.targetTag ?? undefined
                await api.installFromZipEntry(
                    zip.zipPath,
                    realEntry,
                    zip.modId,
                    zip.modName,
                    zip.fileId,
                    zip.fileType,
                    zip.modVersion,
                    gamePath,
                    activeGame,
                    ghost.folderId,
                    locationTag
                )
                await api.deleteTempFile(zip.zipPath)
            }
            await onRefreshInstalled()
        } catch (e) {
            setInstallError(String(e))
        } finally {
            setInstallingEntry(null)
        }
    }

    const groupMap = new Map<string | null, InstalledMod[]>()
    for (const mod of mods) {
        const key = rawById.get(mod.uid)?.folderId ?? null
        const arr = groupMap.get(key) ?? []
        arr.push(mod)
        groupMap.set(key, arr)
    }
    for (const arr of groupMap.values()) {
        arr.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    }

    const rootMods = groupMap.get(null) ?? []
    const folderGroups = [...groupMap.entries()]
        .filter(([k]) => k !== null)
        .map(([k, ms]) => ({
            folderId: k!,
            folder: folders.find((f) => f.id === k),
            path: getFolderPath(folders, k),
            priority: folders.find((f) => f.id === k)?.priority ?? 0,
            mods: ms,
        }))
        .sort((a, b) => a.priority - b.priority)

    const q = query.trim().toLowerCase()
    const matchesQuery = (mod: InstalledMod) =>
        displayFilename(mod.filename).toLowerCase().includes(q) ||
        mod.filename.toLowerCase().includes(q)
    const visibleRootMods = q ? rootMods.filter(matchesQuery) : rootMods
    const visibleGroups = q
        ? folderGroups
              .map((g) => {
                  const folderName = g.folder?.displayName ?? g.path ?? ''
                  // A matching folder name keeps the whole group visible
                  return folderName.toLowerCase().includes(q)
                      ? g
                      : { ...g, mods: g.mods.filter(matchesQuery) }
              })
              .filter((g) => g.mods.length > 0)
        : folderGroups
    const visibleMods = [...visibleRootMods, ...visibleGroups.flatMap((g) => g.mods)]
    const anyVisibleEnabled = visibleMods.some((m) => m.enabled)

    // Archive entries not currently installed, shown as rows with an install action.
    // Installed filenames carry the NNN_ disk prefix; archive entry names don't.
    // Each ghost lands in the folder where its archive-directory siblings live.
    // Bare-file installs (uid === fileId) contribute no ghosts: their only
    // entry is the installed file itself, under an app-constructed disk name.
    const fileIds = hasCatalogLink(mods[0])
        ? [
              ...new Set(
                  mods
                      .filter((m) => m.uid !== String(m.fileId))
                      .map((m) => m.fileId)
                      .filter((id): id is number => id != null)
              ),
          ]
        : []
    const installedNames = new Set(mods.map((m) => stripPriorityPrefix(m.filename)))
    const ghostFiles: GhostFile[] = []
    for (const fileId of fileIds) {
        const entries = getArchiveEntries(activeGame, fileId)
        if (!entries) continue
        const dirFolder = new Map<string, string | null>()
        for (const entry of entries) {
            const m = mods.find((x) => stripPriorityPrefix(x.filename) === entryFilename(entry))
            if (m) dirFolder.set(entryDir(entry), rawById.get(m.uid)?.folderId ?? null)
        }
        for (const entry of entries) {
            if (installedNames.has(entryFilename(entry))) continue
            ghostFiles.push({ entry, fileId, folderId: dirFolder.get(entryDir(entry)) ?? null })
        }
    }
    const matchesGhost = (g: GhostFile) =>
        displayFilename(entryFilename(g.entry)).toLowerCase().includes(q) ||
        entryFilename(g.entry).toLowerCase().includes(q)
    const visibleGhosts = q ? ghostFiles.filter(matchesGhost) : ghostFiles
    const visibleGroupIds = new Set(visibleGroups.map((g) => g.folderId))
    const rootGhosts = visibleGhosts.filter(
        (g) => g.folderId === null || !visibleGroupIds.has(g.folderId)
    )

    // A deleted file keeps its slot in the list: each ghost sorts by a priority
    // interpolated from its archive-sequence neighbours that are still installed.
    const ghostKeys = new Map<string, number>()
    for (const fileId of fileIds) {
        const seq = getArchiveEntries(activeGame, fileId) ?? []
        const prios = seq.map((e) => {
            const m = mods.find((x) => stripPriorityPrefix(x.filename) === entryFilename(e))
            return m ? (m.priority ?? 0) : null
        })
        for (let i = 0; i < seq.length; i++) {
            if (prios[i] !== null) continue
            const prev =
                prios
                    .slice(0, i)
                    .reverse()
                    .find((p) => p !== null) ?? null
            const next = prios.slice(i + 1).find((p) => p !== null) ?? null
            const key =
                prev !== null && next !== null
                    ? (prev + next) / 2
                    : prev !== null
                      ? prev + 0.5
                      : next !== null
                        ? next - 0.5
                        : Number.MAX_SAFE_INTEGER
            ghostKeys.set(entryFilename(seq[i]).toLowerCase(), key)
        }
    }
    type Row = { kind: 'file'; mod: InstalledMod } | { kind: 'ghost'; ghost: GhostFile }
    const rowKey = (r: Row) =>
        r.kind === 'file'
            ? (r.mod.priority ?? 0)
            : (ghostKeys.get(entryFilename(r.ghost.entry).toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
    const mergeRows = (ms: InstalledMod[], ghosts: GhostFile[]): Row[] =>
        [
            ...ms.map((mod): Row => ({ kind: 'file', mod })),
            ...ghosts.map((ghost): Row => ({ kind: 'ghost', ghost })),
        ].sort((a, b) => rowKey(a) - rowKey(b))

    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && onClose()}
            title={modName}
            size="list"
            className="w-[32rem] text-text"
            onOpenAutoFocus={(e) => e.preventDefault()}
        >
            <DialogHeader
                title={modName}
                subtitle={t('installed.fileCount', { count: mods.length })}
                onClose={onClose}
            />

            <div className="flex items-center gap-2 px-3 pt-3 shrink-0">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-subtle pointer-events-none" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t('installed.manageFiles.searchPlaceholder')}
                        className={`w-full text-xs pl-8 py-1.5 rounded bg-surface-hover border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-accent transition-colors ${query ? 'pr-7' : 'pr-3'}`}
                    />
                    {query && <SearchClearButton onClick={() => setQuery('')} />}
                </div>
                <Toggle
                    checked={anyVisibleEnabled}
                    disabled={!!loadingMod || visibleMods.length === 0}
                    onChange={() => handleToggleGroup(visibleMods)}
                    title={t(
                        anyVisibleEnabled
                            ? 'installed.manageFiles.disableAll'
                            : 'installed.manageFiles.enableAll'
                    )}
                />
            </div>

            <div className="overflow-y-auto flex-1 p-3 flex flex-col gap-1">
                {installError && (
                    <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text">
                        {installError}
                    </div>
                )}
                {q && visibleMods.length === 0 && visibleGhosts.length === 0 && (
                    <div className="flex items-center justify-center py-8 text-text-subtle text-sm">
                        {t('installed.manageFiles.noMatches', { query: query.trim() })}
                    </div>
                )}
                {mergeRows(visibleRootMods, rootGhosts).map((row) =>
                    row.kind === 'file' ? (
                        <FileRow
                            key={row.mod.uid}
                            mod={row.mod}
                            loadingMod={loadingMod}
                            stale={staleUids.has(row.mod.uid)}
                            onToggle={() => handleToggleMod(row.mod)}
                            onRemove={() => handleRemove([row.mod])}
                        />
                    ) : (
                        <GhostRow
                            key={row.ghost.entry}
                            name={entryFilename(row.ghost.entry)}
                            installing={installingEntry === row.ghost.entry}
                            disabled={!!loadingMod || installingEntry !== null || !gamePath}
                            onInstall={() => handleInstallEntry(row.ghost)}
                        />
                    )
                )}

                {visibleGroups.map(({ folderId, folder, path, mods: groupMods }) => {
                    // While searching, collapsed folders stay open so matches are visible
                    const isCollapsed = !q && collapsed.has(folderId)
                    const anyEnabled = groupMods.some((m) => m.enabled)
                    const folderName = folder?.displayName ?? path ?? folderId
                    return (
                        <div key={folderId}>
                            <div className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors">
                                <button
                                    onClick={() => toggleCollapse(folderId)}
                                    className="text-text-subtle hover:text-text transition-colors shrink-0"
                                >
                                    {isCollapsed ? (
                                        <ChevronRight className="w-3.5 h-3.5" />
                                    ) : (
                                        <ChevronDown className="w-3.5 h-3.5" />
                                    )}
                                </button>
                                <span className="text-sm font-medium truncate flex-1 min-w-0">
                                    {folderName}
                                </span>
                                <span className="text-xs text-text-muted shrink-0">
                                    {groupMods.length}
                                </span>
                                <div
                                    className="flex items-center gap-2 shrink-0"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <Toggle
                                        checked={anyEnabled}
                                        disabled={!!loadingMod}
                                        onChange={() => handleToggleGroup(groupMods)}
                                    />
                                    <Tooltip content={t('common.remove')}>
                                        <Button
                                            variant="danger"
                                            size="icon-md"
                                            onClick={() => handleRemove(groupMods)}
                                            disabled={!!loadingMod}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                    </Tooltip>
                                </div>
                            </div>

                            {!isCollapsed && (
                                <div className="ml-4 flex flex-col gap-0.5">
                                    {mergeRows(
                                        groupMods,
                                        visibleGhosts.filter((g) => g.folderId === folderId)
                                    ).map((row) =>
                                        row.kind === 'file' ? (
                                            <FileRow
                                                key={row.mod.uid}
                                                mod={row.mod}
                                                loadingMod={loadingMod}
                                                stale={staleUids.has(row.mod.uid)}
                                                onToggle={() => handleToggleMod(row.mod)}
                                                onRemove={() => handleRemove([row.mod])}
                                            />
                                        ) : (
                                            <GhostRow
                                                key={row.ghost.entry}
                                                name={entryFilename(row.ghost.entry)}
                                                installing={installingEntry === row.ghost.entry}
                                                disabled={
                                                    !!loadingMod ||
                                                    installingEntry !== null ||
                                                    !gamePath
                                                }
                                                onInstall={() => handleInstallEntry(row.ghost)}
                                            />
                                        )
                                    )}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            <div className="flex justify-end px-5 py-4 border-t border-border shrink-0">
                <Button variant="secondary" size="sm" onClick={onClose}>
                    {t('common.close')}
                </Button>
            </div>
        </Dialog>
    )
}

function GhostRow({
    name,
    installing,
    disabled,
    onInstall,
}: {
    name: string
    installing: boolean
    disabled: boolean
    onInstall: () => void
}) {
    return (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors">
            <span className="text-xs flex-1 min-w-0 truncate text-text-subtle" title={name}>
                {name}
            </span>
            <div className="flex items-center gap-2 shrink-0">
                {installing ? (
                    <span className="text-xs text-text-muted">{t('common.installing')}</span>
                ) : (
                    <Tooltip content={t('common.install')}>
                        <button
                            onClick={onInstall}
                            disabled={disabled}
                            className="p-1.5 rounded bg-accent-fill hover:bg-accent-fill-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            <Download className="w-3.5 h-3.5" />
                        </button>
                    </Tooltip>
                )}
            </div>
        </div>
    )
}

function FileRow({
    mod,
    loadingMod,
    stale,
    onToggle,
    onRemove,
}: {
    mod: InstalledMod
    loadingMod: string | null
    stale: boolean
    onToggle: () => void
    onRemove: () => void
}) {
    return (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors">
            <span
                className={`text-xs flex-1 min-w-0 truncate ${loadingMod === mod.uid ? 'text-text-muted' : 'text-text'}`}
                title={mod.filename}
            >
                {mod.filename}
            </span>
            {stale && (
                <Tooltip content={t('installed.manageFiles.staleDuplicateHint')}>
                    <span className="px-1.5 py-0.5 rounded bg-warning/20 border border-warning/40 text-[10px] text-warning shrink-0">
                        {t('installed.manageFiles.staleDuplicateBadge')}
                    </span>
                </Tooltip>
            )}
            <div className="flex items-center gap-2 shrink-0">
                <Toggle checked={mod.enabled} disabled={!!loadingMod} onChange={onToggle} />
                <Tooltip content={t('common.remove')}>
                    <button
                        onClick={onRemove}
                        disabled={!!loadingMod}
                        className="p-1.5 rounded bg-danger hover:bg-danger-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </Tooltip>
            </div>
        </div>
    )
}
