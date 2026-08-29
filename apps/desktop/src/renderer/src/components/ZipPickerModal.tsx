import { useState, useMemo, useEffect } from 'react'
import { Button } from './ui/Button'
import { Folder } from 'lucide-react'
import type { GameId, InstalledMod } from '../../../shared/types'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { api } from '../api'
import { setArchiveEntries } from '../archiveEntriesCache'
import { entryFilename, stripPriorityPrefix } from '../hooks/installedUtils'

export interface ZipMultiPakPayload {
    archiveHandle: string
    entries: string[]
    entryIds: number[]
    modId: number
    modName: string
    fileId: number
    fileType: string
    modVersion: string
    targetTag?: string
    // Per-entry destination tag, parallel to entries. Sent by the backend only for archives
    // that span more than one scan target (e.g. a modpack with both mods/ and mod_overrides/
    // content). null = primary target. Absent for single-target archives.
    entryTags?: (string | null)[]
    // Set to 'dir' when entries are directory paths rather than .pak files, emitted only by
    // classify_archive_dirs's fallback (e.g. Crime Boss ue4ss_mods sub-mods or candidate mod
    // folders). Forwarded to install_from_zip_entry so Crime Boss doesn't wrap a directory entry
    // in its pak-only skeleton extractor.
    entryKind?: 'pak' | 'dir'
}

function computePrefix(entries: string[]): string {
    if (entries.length === 0) return ''
    let prefix = ''
    for (;;) {
        const next = entries[0].indexOf('/', prefix.length)
        if (next === -1) return prefix
        const candidate = entries[0].slice(0, next + 1)
        if (!entries.every((e) => e.startsWith(candidate))) return prefix
        prefix = candidate
    }
    // unreachable
}

function stripWrapperPrefix(entries: string[]): string {
    const raw = computePrefix(entries)
    if (!raw) return ''
    const stripped = entries.map((e) => e.slice(raw.length))
    // Flat-only wrappers become an app folder; only strip when entries mix root and subdirs.
    return stripped.some((e) => e.includes('/')) ? raw : ''
}

// Groups entry positions, not names: two entries can display the same name and must stay
// separately selectable.
function groupEntriesByDir(entries: string[], prefix: string): Map<string, number[]> {
    const map = new Map<string, number[]>()
    entries.forEach((entry, pos) => {
        const rel = entry.slice(prefix.length)
        const lastSlash = rel.lastIndexOf('/')
        const dir = lastSlash === -1 ? '' : rel.slice(0, lastSlash)
        if (!map.has(dir)) map.set(dir, [])
        map.get(dir)!.push(pos)
    })
    return map
}

function getRequiredDirs(normalizedEntries: string[]): string[] {
    const dirs = new Set<string>()
    for (const entry of normalizedEntries) {
        const lastSlash = entry.lastIndexOf('/')
        if (lastSlash === -1) continue
        const dir = entry.slice(0, lastSlash)
        const parts = dir.split('/')
        for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
    return [...dirs].sort((a, b) => {
        const d = a.split('/').length - b.split('/').length
        return d !== 0 ? d : a.localeCompare(b)
    })
}

function entryStem(entry: string): string {
    const name = entryFilename(entry)
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(0, dot) : name
}

function targetLabel(tag: string | null): string {
    return tag === 'mod_overrides' ? t('zipPicker.targetOverrides') : t('zipPicker.targetMods')
}

// Entries already installed from this archive (uid is {fileId}_{stem}; the prefix-stripped
// filename match covers entries whose uid was reassigned by SHA256 reconciliation, where
// filenames carry the NNN_ disk prefix).
function computeInstalledEntries(
    payload: ZipMultiPakPayload,
    installedFiles: InstalledMod[]
): Set<number> {
    const set = new Set<number>()
    payload.entries.forEach((entry, pos) => {
        const uid = `${payload.fileId}_${entryStem(entry)}`
        const filename = entryFilename(entry)
        const isInstalled = installedFiles.some(
            (m) =>
                !m.missing &&
                (m.uid === uid ||
                    (m.fileId === payload.fileId && stripPriorityPrefix(m.filename) === filename))
        )
        if (isInstalled) set.add(pos)
    })
    return set
}

// Matches this archive's entries against an existing install's filenames (the new file's id
// never matches the old install) so an update can silently re-apply the prior selection.
// Returns null when there is no prior install or nothing matched, and the caller shows the
// picker in that case.
export function computeAutoUpdateSelection(
    payload: ZipMultiPakPayload,
    installedFiles: InstalledMod[]
): number[] | null {
    const installedEntries = computeInstalledEntries(payload, installedFiles)
    // Archive picker prompts never reach the Nexus install flow (it cannot forward them,
    // see install_nexus_download), so payload.modId is always a real modworkshop id;
    // InstalledMod.id is an opaque local key, so match against remoteId instead.
    const modIdStr = String(payload.modId)
    const priorEntriesForMod = installedFiles.filter((m) => m.remoteId === modIdStr && !m.missing)
    if (priorEntriesForMod.length === 0) return null
    const matched: number[] = []
    payload.entries.forEach((entry, pos) => {
        if (installedEntries.has(pos)) return
        const filename = entryFilename(entry)
        if (priorEntriesForMod.some((m) => stripPriorityPrefix(m.filename) === filename)) {
            matched.push(pos)
        }
    })
    return matched.length > 0 ? matched : null
}

// Shared install loop for a resolved set of archive entries, used both by the picker's own
// confirm button and by callers (e.g. computeAutoUpdateSelection's auto-resolve path) that
// already know what to install and never show the picker UI at all.
export async function installZipPickerEntries(
    payload: ZipMultiPakPayload,
    toInstall: number[],
    gamePath: string,
    gameId: string,
    folderId: string | null | undefined,
    onRefreshInstalled: () => Promise<void>,
    onProgress?: (entry: string | null) => void
): Promise<void> {
    const tagByPos = new Map<number, string | null>()
    if (payload.entryTags && payload.entryTags.length === payload.entries.length) {
        payload.entries.forEach((_, i) => tagByPos.set(i, payload.entryTags![i] ?? null))
    }
    const multiTarget = tagByPos.size > 0 && new Set(tagByPos.values()).size > 1

    if (multiTarget) {
        for (const pos of toInstall) {
            onProgress?.(payload.entries[pos])
            await api.installFromZipEntry(
                payload.archiveHandle,
                payload.entryIds[pos],
                payload.modId,
                payload.modName,
                payload.fileId,
                payload.fileType,
                payload.modVersion,
                gamePath,
                gameId,
                null,
                tagByPos.get(pos) ?? undefined,
                payload.entryKind
            )
            await onRefreshInstalled()
        }
        onProgress?.(null)
        await api.discardStagedArchive(payload.archiveHandle)
        return
    }

    const prefix = stripWrapperPrefix(payload.entries)
    const isCrimeBossPakArchive = gameId === 'cb' && payload.entryKind !== 'dir'
    const grouped = groupEntriesByDir(payload.entries, prefix)
    const isStructured =
        !isCrimeBossPakArchive && (grouped.size > 1 || (grouped.size === 1 && !grouped.has('')))

    const folderIdMap = new Map<string, string | null>([
        ['', payload.targetTag ? null : (folderId ?? null)],
    ])

    if (isStructured && !payload.targetTag) {
        const normalizedToInstall = toInstall.map((pos) =>
            payload.entries[pos].slice(prefix.length)
        )
        for (const dir of getRequiredDirs(normalizedToInstall)) {
            const lastSlash = dir.lastIndexOf('/')
            const parentDir = lastSlash === -1 ? '' : dir.slice(0, lastSlash)
            const dirName = lastSlash === -1 ? dir : dir.slice(lastSlash + 1)
            const folder = await api.createFolder(
                dirName,
                folderIdMap.get(parentDir) ?? null,
                gamePath,
                gameId
            )
            folderIdMap.set(dir, folder.id)
        }
        await onRefreshInstalled()
    }

    for (const pos of toInstall) {
        const rel = payload.entries[pos].slice(prefix.length)
        const lastSlash = rel.lastIndexOf('/')
        const dir = lastSlash === -1 ? '' : rel.slice(0, lastSlash)
        onProgress?.(payload.entries[pos])
        await api.installFromZipEntry(
            payload.archiveHandle,
            payload.entryIds[pos],
            payload.modId,
            payload.modName,
            payload.fileId,
            payload.fileType,
            payload.modVersion,
            gamePath,
            gameId,
            folderIdMap.get(dir) ?? null,
            payload.targetTag,
            payload.entryKind
        )
        await onRefreshInstalled()
    }
    onProgress?.(null)
    await api.discardStagedArchive(payload.archiveHandle)
}

interface Props {
    payload: ZipMultiPakPayload
    gamePath: string
    installedFiles: InstalledMod[]
    folderId?: string | null
    gameId: string
    onRefreshInstalled: () => Promise<void>
    onClose: () => void
}

export function ZipPickerModal({
    payload,
    gamePath,
    installedFiles,
    folderId,
    gameId,
    onRefreshInstalled,
    onClose,
}: Props) {
    const installedEntries = useMemo(
        () => computeInstalledEntries(payload, installedFiles),
        [payload, installedFiles]
    )

    const selectable = payload.entries
        .map((_, pos) => pos)
        .filter((pos) => !installedEntries.has(pos))

    // Defaults the picker to "what you already have" across a version bump (matched by
    // filename, since the new file's id never matches the old install) instead of re-selecting
    // every variant and making the user re-pick from scratch each time.
    const matchedPriorSelection = useMemo(
        () => computeAutoUpdateSelection(payload, installedFiles),
        [payload, installedFiles]
    )

    const [selected, setSelected] = useState<Set<number>>(() => {
        if (matchedPriorSelection && matchedPriorSelection.length > 0) {
            return new Set(matchedPriorSelection)
        }
        return new Set(
            payload.entries.map((_, pos) => pos).filter((pos) => !installedEntries.has(pos))
        )
    })
    const [installingEntry, setInstallingEntry] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const isBusy = installingEntry !== null
    const pendingCount = selected.size

    const { prefix, grouped } = useMemo(() => {
        const p = stripWrapperPrefix(payload.entries)
        return { prefix: p, grouped: groupEntriesByDir(payload.entries, p) }
    }, [payload.entries])

    // Crime Boss pak entries are always re-wrapped in a fresh Content/Paks/WindowsNoEditor
    // skeleton by extract_entry_into_crimeboss_skeleton regardless of their path inside the zip
    // (see install_from_zip_entry), so any wrapper folder the zip ships (typically the
    // ModKit's own <name>/Content/Paks/WindowsNoEditor/ packaging shape) is never real structure
    // worth recreating as app folders. Treating it as structured double-wraps the skeleton.
    const isCrimeBossPakArchive = gameId === 'cb' && payload.entryKind !== 'dir'
    const isStructured =
        !isCrimeBossPakArchive && (grouped.size > 1 || (grouped.size === 1 && !grouped.has('')))

    const rootEntries = grouped.get('') ?? []
    const subdirSections = useMemo(
        () =>
            [...grouped.entries()]
                .filter(([dir]) => dir !== '')
                .sort(([a], [b]) => a.localeCompare(b)),
        [grouped]
    )

    // Per-entry target routing: present only when the archive spans more than one scan target.
    const tagByPos = useMemo(() => {
        const map = new Map<number, string | null>()
        const tags = payload.entryTags
        if (tags && tags.length === payload.entries.length) {
            payload.entries.forEach((_, i) => map.set(i, tags[i] ?? null))
        }
        return map
    }, [payload.entries, payload.entryTags])

    const multiTarget = useMemo(
        () => tagByPos.size > 0 && new Set(tagByPos.values()).size > 1,
        [tagByPos]
    )

    // Entries grouped by destination target, primary (null) first.
    const targetSections = useMemo(() => {
        const groups = new Map<string | null, number[]>()
        payload.entries.forEach((_, pos) => {
            const tag = tagByPos.get(pos) ?? null
            if (!groups.has(tag)) groups.set(tag, [])
            groups.get(tag)!.push(pos)
        })
        return [...groups.entries()].sort(([a], [b]) =>
            a === null ? -1 : b === null ? 1 : a.localeCompare(b)
        )
    }, [payload.entries, tagByPos])

    useEffect(() => {
        setArchiveEntries((gameId ?? 'pd3') as GameId, payload.fileId, payload.entries)
    }, [payload, gameId])

    function toggle(pos: number) {
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(pos)) next.delete(pos)
            else next.add(pos)
            return next
        })
    }

    function toggleAll() {
        setSelected((prev) => (prev.size === selectable.length ? new Set() : new Set(selectable)))
    }

    function toggleGroup(positions: number[]) {
        const groupSelectable = positions.filter((pos) => !installedEntries.has(pos))
        setSelected((prev) => {
            const allSelected = groupSelectable.every((pos) => prev.has(pos))
            const next = new Set(prev)
            if (allSelected) groupSelectable.forEach((pos) => next.delete(pos))
            else groupSelectable.forEach((pos) => next.add(pos))
            return next
        })
    }

    async function handleInstall() {
        if (selected.size === 0) return
        setError(null)
        const toInstall = payload.entries.map((_, pos) => pos).filter((pos) => selected.has(pos))
        try {
            await installZipPickerEntries(
                payload,
                toInstall,
                gamePath,
                gameId,
                folderId,
                onRefreshInstalled,
                setInstallingEntry
            )
        } catch (e) {
            setInstallingEntry(null)
            setError(String(e))
            return
        }
        setInstallingEntry(null)
        onClose()
    }

    function renderEntry(pos: number, indented = false) {
        const entry = payload.entries[pos]
        const isInstalling = installingEntry === entry
        const isInstalled = installedEntries.has(pos)
        const name = entry.slice(prefix.length).split('/').pop() ?? entry
        return (
            <div
                key={payload.entryIds[pos]}
                onClick={() => !isInstalled && !isBusy && toggle(pos)}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                    isInstalled
                        ? 'bg-surface-hover border-border opacity-60'
                        : selected.has(pos)
                          ? 'bg-accent/5 border-accent/40 cursor-pointer'
                          : 'bg-surface-hover border-border cursor-pointer'
                } ${isBusy ? 'cursor-not-allowed opacity-60' : isInstalled ? '' : 'hover:bg-surface-active'} ${
                    indented ? 'ml-4' : ''
                }`}
            >
                <input
                    type="checkbox"
                    checked={isInstalled || selected.has(pos)}
                    onChange={() => toggle(pos)}
                    disabled={isInstalled || isBusy}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-accent w-4 h-4 shrink-0"
                />
                <span className="text-sm font-medium truncate flex-1">{name}</span>
                {isInstalling ? (
                    <span className="text-xs text-text-muted shrink-0">
                        {t('common.installing')}
                    </span>
                ) : isInstalled ? (
                    <span className="text-xs text-success-text shrink-0">
                        {t('common.installed')}
                    </span>
                ) : null}
            </div>
        )
    }

    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && !isBusy && onClose()}
            title={t('zipPicker.title')}
            size="list"
            className="w-[520px]"
        >
            <DialogHeader
                title={t('zipPicker.title')}
                subtitle={t('zipPicker.subtitle', { modName: payload.modName })}
                onClose={onClose}
                closeDisabled={isBusy}
            />

            <div className="overflow-y-auto flex-1 px-4 py-3 flex flex-col gap-2">
                {error && (
                    <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text">
                        {error}
                    </div>
                )}

                <div
                    onClick={() => !isBusy && selectable.length > 0 && toggleAll()}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-hover cursor-pointer hover:bg-surface-active transition-colors"
                >
                    <input
                        type="checkbox"
                        checked={selectable.length > 0 && selected.size === selectable.length}
                        ref={(el) => {
                            if (el)
                                el.indeterminate =
                                    selected.size > 0 && selected.size < selectable.length
                        }}
                        onChange={toggleAll}
                        disabled={isBusy || selectable.length === 0}
                        onClick={(e) => e.stopPropagation()}
                        className="accent-accent w-4 h-4 shrink-0"
                    />
                    <span className="text-xs font-medium text-text-muted">
                        {selectable.length > 0 && selected.size === selectable.length
                            ? t('zipPicker.deselectAll')
                            : t('zipPicker.selectAll', { count: selectable.length })}
                    </span>
                </div>

                {multiTarget ? (
                    targetSections.map(([tag, dirEntries]) => {
                        const groupSelectable = dirEntries.filter((e) => !installedEntries.has(e))
                        const allInGroup =
                            groupSelectable.length > 0 &&
                            groupSelectable.every((e) => selected.has(e))
                        const someInGroup = groupSelectable.some((e) => selected.has(e))
                        return (
                            <div key={tag ?? '__primary__'} className="flex flex-col gap-1.5">
                                <div
                                    onClick={() =>
                                        !isBusy &&
                                        groupSelectable.length > 0 &&
                                        toggleGroup(dirEntries)
                                    }
                                    className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none"
                                >
                                    <input
                                        type="checkbox"
                                        checked={allInGroup}
                                        ref={(el) => {
                                            if (el) el.indeterminate = !allInGroup && someInGroup
                                        }}
                                        onChange={() => toggleGroup(dirEntries)}
                                        disabled={isBusy || groupSelectable.length === 0}
                                        onClick={(e) => e.stopPropagation()}
                                        className="accent-accent w-4 h-4 shrink-0"
                                    />
                                    <Folder className="w-3.5 h-3.5 text-text-muted shrink-0" />
                                    <span className="text-xs font-medium text-text-muted">
                                        {targetLabel(tag)}
                                    </span>
                                    <span className="text-xs text-text-subtle">
                                        ({dirEntries.length})
                                    </span>
                                </div>
                                {dirEntries.map((entry) => renderEntry(entry, true))}
                            </div>
                        )
                    })
                ) : isStructured ? (
                    <>
                        {rootEntries.map((entry) => renderEntry(entry))}
                        {subdirSections.map(([dir, dirEntries]) => {
                            const dirName = dir.split('/').pop() ?? dir
                            const groupSelectable = dirEntries.filter(
                                (e) => !installedEntries.has(e)
                            )
                            const allInGroup =
                                groupSelectable.length > 0 &&
                                groupSelectable.every((e) => selected.has(e))
                            const someInGroup = groupSelectable.some((e) => selected.has(e))
                            return (
                                <div key={dir} className="flex flex-col gap-1.5">
                                    <div
                                        onClick={() =>
                                            !isBusy &&
                                            groupSelectable.length > 0 &&
                                            toggleGroup(dirEntries)
                                        }
                                        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={allInGroup}
                                            ref={(el) => {
                                                if (el)
                                                    el.indeterminate = !allInGroup && someInGroup
                                            }}
                                            onChange={() => toggleGroup(dirEntries)}
                                            disabled={isBusy || groupSelectable.length === 0}
                                            onClick={(e) => e.stopPropagation()}
                                            className="accent-accent w-4 h-4 shrink-0"
                                        />
                                        <Folder className="w-3.5 h-3.5 text-text-muted shrink-0" />
                                        <span className="text-xs font-medium text-text-muted">
                                            {dirName}
                                        </span>
                                        <span className="text-xs text-text-subtle">
                                            ({dirEntries.length})
                                        </span>
                                    </div>
                                    {dirEntries.map((entry) => renderEntry(entry, true))}
                                </div>
                            )
                        })}
                    </>
                ) : (
                    payload.entries.map((_, pos) => renderEntry(pos))
                )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                <Button
                    variant="secondary"
                    size="md"
                    onClick={!isBusy ? onClose : undefined}
                    disabled={isBusy}
                >
                    {t('common.cancel')}
                </Button>
                <Button
                    variant="accent"
                    size="lg"
                    disabled={pendingCount === 0 || isBusy}
                    onClick={handleInstall}
                >
                    {isBusy
                        ? t('common.installing')
                        : t('zipPicker.installSelected', { count: pendingCount })}
                </Button>
            </div>
        </Dialog>
    )
}
