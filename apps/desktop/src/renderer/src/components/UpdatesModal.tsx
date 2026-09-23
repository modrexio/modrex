import { useRef, useState } from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import { Image as ImageIcon } from 'lucide-react'
import { Button } from './ui/Button'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import type { GameId, InstalledMod, Mod, ModFile, ModSummary } from '../../../shared/types'
import { api } from '../api'
import { useThumbnail } from '../hooks/useThumbnail'
import NexusIcon from '../../../../assets/icons/nexusmods.svg?react'
import type { InstallOutcome } from '../api'
import {
    ZipPickerModal,
    computeAutoUpdateSelection,
    installZipPickerEntries,
} from './ZipPickerModal'
import type { ZipMultiPakPayload } from './ZipPickerModal'
import { HostPackModal } from './HostPackModal'
import type { HostPackPayload } from './HostPackModal'
import { CrimeBossFlatArchiveModal } from './CrimeBossFlatArchiveModal'
import type { CbFlatArchivePayload } from './CrimeBossFlatArchiveModal'
import { Ue4ssReplaceModal } from './Ue4ssReplaceModal'
import type { LoaderReplacePayload } from './Ue4ssReplaceModal'
import { UnrecognizedArchiveModal } from './UnrecognizedArchiveModal'
import { detailNavArgs, syntheticMod } from '../hooks/installedUtils'
import { nativeIdFor } from '../sources'
import { getCachedModFiles, refreshModDetail } from '../modCache'
import { resolveUpdateTarget } from '../updatePolicy'
import { modVersions } from '../modVersions'
import { UpdateFileModal } from './UpdateFileModal'

interface Props {
    updateVersions: ReadonlyMap<number, string>
    updatable: InstalledMod[]
    modData: Map<number, ModSummary>
    installed: InstalledMod[]
    gamePath: string | null
    gameId: string
    visible: boolean
    onRefreshInstalled: () => Promise<void>
    onClose: () => void
    onOpenDetail: (modId: number, source?: 'nexus') => void
}

// Nexus has no "install this exact version" call for a free account (see
// nexus_get_download_link's key and expires requirement), so its own site is the only
// place that can hand back a real nxm:// download, same as everywhere else Nexus
// installs originate from this app.
function nexusUpdateUrl(ins: InstalledMod, gameId: string): string | null {
    if (ins.source !== 'nexus') return null
    const domain = nativeIdFor(gameId as GameId, 'nexus')
    const [nexusModId] = detailNavArgs(ins)
    return domain ? `https://www.nexusmods.com/${domain}/mods/${nexusModId}?tab=files` : null
}

function UpdateModalRow({
    version,
    ins,
    mod,
    checked,
    isLoading,
    gamePath,
    onToggle,
    onOpenDetail,
    onUpdate,
}: {
    version: string
    ins: InstalledMod
    mod: ModSummary
    checked: boolean
    isLoading: boolean
    gamePath: string | null
    onToggle: () => void
    onOpenDetail: () => void
    onUpdate: () => void
}) {
    // useThumbnail passes an absolute URL (Nexus's picture_url) through untouched,
    // unlike a bare THUMBNAIL_BASE_URL concatenation, which would have doubled up
    // into a broken URL for any Nexus mod that actually has a picture.
    const thumbSrc = useThumbnail(mod.thumbnail?.file)
    return (
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
            <input
                type="checkbox"
                checked={checked}
                disabled={isLoading}
                onChange={onToggle}
                className="w-4 h-4 shrink-0 cursor-pointer disabled:cursor-not-allowed"
            />
            <button
                onClick={onOpenDetail}
                className="flex items-center gap-3 min-w-0 flex-1 text-left hover:opacity-80 transition-opacity"
            >
                {thumbSrc ? (
                    <img src={thumbSrc} alt="" className="w-9 h-9 rounded object-cover shrink-0" />
                ) : (
                    <div className="w-9 h-9 rounded bg-surface-active shrink-0 flex items-center justify-center">
                        {ins.source === 'nexus' ? (
                            <NexusIcon className="w-4 h-4 text-text-subtle" />
                        ) : (
                            <ImageIcon className="w-4 h-4 text-text-subtle" aria-hidden="true" />
                        )}
                    </div>
                )}
                <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{mod.name}</div>
                    <div className="text-xs text-text-subtle">
                        {ins.version
                            ? t('installed.updatesModal.versionChange', {
                                  from: ins.version,
                                  to: version,
                              })
                            : t('installed.updatesModal.versionAvailable', { version })}
                    </div>
                </div>
            </button>
            <button
                disabled={!gamePath || isLoading}
                onClick={onUpdate}
                className="text-xs px-3 py-1 rounded bg-surface-active hover:bg-surface-light disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            >
                {isLoading
                    ? t('installed.updatesModal.updating')
                    : ins.source === 'nexus'
                      ? t('detail.downloads.viaNexus')
                      : t('installed.updatesModal.update')}
            </button>
        </div>
    )
}

export function UpdatesModal({
    updateVersions,
    updatable,
    modData,
    installed,
    gamePath,
    gameId,
    visible,
    onRefreshInstalled,
    onClose,
    onOpenDetail,
}: Props) {
    const [selectedIds, setSelectedIds] = useState<Set<number>>(
        () => new Set(updatable.map((m) => m.id))
    )
    const [loadingMod, setLoadingMod] = useState<string | null>(null)
    const [updatingAll, setUpdatingAll] = useState(false)
    const [updateProgress, setUpdateProgress] = useState<{ done: number; total: number } | null>(
        null
    )
    const [updateError, setUpdateError] = useState<string | null>(null)
    const [zipPickerData, setZipPickerData] = useState<ZipMultiPakPayload | null>(null)
    const [hostPackData, setHostPackData] = useState<HostPackPayload | null>(null)
    const [cbFlatArchiveData, setCbFlatArchiveData] = useState<CbFlatArchivePayload | null>(null)
    const [loaderReplaceData, setLoaderReplaceData] = useState<LoaderReplacePayload | null>(null)
    const [unrecognizedModId, setUnrecognizedModId] = useState<number | null>(null)
    const [fileChoice, setFileChoice] = useState<{
        ins: InstalledMod
        mod: Mod
        files: ModFile[]
    } | null>(null)

    // Remaining mods for the in-progress batch update; lets processQueue resume after a
    // picker modal closes instead of abandoning the rest of the selection.
    const queueRef = useRef<InstalledMod[]>([])
    const skippedRef = useRef(false)

    function toggleSelected(id: number) {
        setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    // Only an exact prior archive-entry selection can be reapplied without review.
    async function resolveInstallPrompt(
        outcome: Exclude<InstallOutcome, 'installed'>,
        modId: number
    ): Promise<'resolved' | 'manual'> {
        if (outcome === 'unrecognized') {
            setUnrecognizedModId(modId)
            return 'manual'
        }
        if ('needsPicker' in outcome) {
            const zipData = outcome.needsPicker as unknown as ZipMultiPakPayload
            if (gamePath) {
                const autoEntries = computeAutoUpdateSelection(zipData, installed)
                if (!autoEntries) {
                    setZipPickerData(zipData)
                    return 'manual'
                }
                const entriesToInstall = autoEntries
                try {
                    await installZipPickerEntries(
                        zipData,
                        entriesToInstall,
                        gamePath,
                        gameId,
                        null,
                        onRefreshInstalled
                    )
                    return 'resolved'
                } catch (error) {
                    setUpdateError(String(error))
                }
            }
            setZipPickerData(zipData)
            return 'manual'
        }
        if ('needsHostChoice' in outcome) {
            setHostPackData(outcome.needsHostChoice as unknown as HostPackPayload)
            return 'manual'
        }
        if ('needsLoaderConfirm' in outcome) {
            setLoaderReplaceData(outcome.needsLoaderConfirm as unknown as LoaderReplacePayload)
            return 'manual'
        }
        setCbFlatArchiveData(outcome.needsCbFlatConfirm as unknown as CbFlatArchivePayload)
        return 'manual'
    }

    async function installUpdate(
        ins: InstalledMod,
        installPath: string
    ): Promise<InstallOutcome | 'unchanged' | 'unavailable' | 'choosing'> {
        const remoteId = Number(ins.remoteId)
        const [detail, files] = await Promise.all([
            refreshModDetail(remoteId),
            getCachedModFiles(remoteId),
        ])
        const target = resolveUpdateTarget(
            installed.filter((mod) => mod.id === ins.id),
            detail,
            files
        )
        if (target.status === 'unchanged') {
            modVersions.record(detail.id, detail.version)
            return 'unchanged'
        }
        if (target.status === 'unavailable') {
            skippedRef.current = true
            setUpdateError(t('installed.updatesModal.unavailable', { name: detail.name }))
            return 'unavailable'
        }
        if (target.status === 'choose') {
            setFileChoice({ ins, mod: detail, files })
            return 'choosing'
        }
        return api.installMod(remoteId, installPath, gameId)
    }

    async function handleUpdate(ins: InstalledMod) {
        if (!gamePath) return
        const nexusUrl = nexusUpdateUrl(ins, gameId)
        if (nexusUrl) {
            api.openExternal(nexusUrl)
            return
        }
        // Not a Nexus mod at this point, so the real modworkshop id, which is what
        // api.installMod needs, lives in remoteId, never InstalledMod.id
        // (an opaque local key).
        const remoteId = Number(ins.remoteId)
        if (!Number.isFinite(remoteId) || remoteId <= 0) return
        setLoadingMod(ins.uid)
        setUpdateError(null)
        try {
            const outcome = await installUpdate(ins, gamePath)
            if (outcome === 'installed') {
                await onRefreshInstalled()
                return
            }
            if (outcome === 'unchanged' || outcome === 'unavailable' || outcome === 'choosing')
                return
            await resolveInstallPrompt(outcome, remoteId)
        } catch (error) {
            reportFailure(error)
        } finally {
            setLoadingMod(null)
        }
    }

    function reportFailure(error: unknown) {
        void logError('Mod update failed: ' + String(error))
        setUpdateError(t('installed.updatesModal.error'))
    }

    function stopBatch() {
        setUpdatingAll(false)
        setUpdateProgress(null)
        queueRef.current = []
    }

    // Stops without finishing the batch when a sentinel needs a manual picker; the picker's
    // onClose calls this again to resume with the next mod.
    async function processQueue() {
        if (!gamePath) return
        while (queueRef.current.length > 0) {
            const ins = queueRef.current[0]
            queueRef.current = queueRef.current.slice(1)
            const nexusUrl = nexusUpdateUrl(ins, gameId)
            if (nexusUrl) {
                api.openExternal(nexusUrl)
                setUpdateProgress((prev) => prev && { done: prev.done + 1, total: prev.total })
                continue
            }
            const remoteId = Number(ins.remoteId)
            if (!Number.isFinite(remoteId) || remoteId <= 0) continue
            try {
                const outcome = await installUpdate(ins, gamePath)
                setUpdateProgress((prev) => prev && { done: prev.done + 1, total: prev.total })
                if (outcome === 'choosing') return
                if (
                    outcome !== 'installed' &&
                    outcome !== 'unchanged' &&
                    outcome !== 'unavailable'
                ) {
                    const resolution = await resolveInstallPrompt(outcome, remoteId)
                    // 'resolved' = auto-applied silently, continue with the next mod;
                    // 'manual' = picker handles this mod, pause until its onClose resumes.
                    if (resolution === 'manual') return
                }
            } catch (error) {
                reportFailure(error)
                stopBatch()
                return
            }
        }
        await onRefreshInstalled()
        stopBatch()
        if (!skippedRef.current) onClose()
    }

    async function installChosenFile(ins: InstalledMod, fileId: number) {
        setFileChoice(null)
        if (!gamePath) return
        const remoteId = Number(ins.remoteId)
        setLoadingMod(ins.uid)
        try {
            const outcome = await api.installMod(remoteId, gamePath, gameId, fileId)
            if (outcome === 'installed') await onRefreshInstalled()
            else if ((await resolveInstallPrompt(outcome, remoteId)) === 'manual') return
            resumeQueueIfBatch()
        } catch (error) {
            reportFailure(error)
            stopBatch()
        } finally {
            setLoadingMod(null)
        }
    }

    function resumeQueueIfBatch() {
        if (updatingAll) void processQueue()
    }

    async function handleUpdateSelected() {
        if (!gamePath) return
        setUpdateError(null)
        skippedRef.current = false
        setUpdatingAll(true)
        const queue = updatable.filter((m) => selectedIds.has(m.id))
        queueRef.current = queue
        setUpdateProgress({ done: 0, total: queue.length })
        await processQueue()
    }

    return (
        <>
            <Dialog
                open={
                    visible &&
                    !fileChoice &&
                    !zipPickerData &&
                    !hostPackData &&
                    !cbFlatArchiveData &&
                    !loaderReplaceData &&
                    unrecognizedModId === null
                }
                onOpenChange={(open) => !open && onClose()}
                title={t('installed.updatesModal.title', { count: updatable.length })}
                size="list"
                className="w-[32rem]"
            >
                <DialogHeader
                    title={t('installed.updatesModal.title', { count: updatable.length })}
                    onClose={onClose}
                />

                <div className="overflow-y-auto flex-1">
                    {updatable.map((ins) => (
                        <UpdateModalRow
                            version={updateVersions.get(ins.id)!}
                            key={ins.uid}
                            ins={ins}
                            mod={modData.get(ins.id) ?? syntheticMod(ins)}
                            checked={selectedIds.has(ins.id)}
                            isLoading={loadingMod === ins.uid || updatingAll}
                            gamePath={gamePath}
                            onToggle={() => toggleSelected(ins.id)}
                            onOpenDetail={() => onOpenDetail(...detailNavArgs(ins))}
                            onUpdate={() => handleUpdate(ins)}
                        />
                    ))}
                </div>

                <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                    {updateError && (
                        <span className="text-xs text-danger-text mr-auto">{updateError}</span>
                    )}
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        {t('common.close')}
                    </Button>
                    <Button
                        variant="accent"
                        size="sm"
                        disabled={!gamePath || updatingAll || selectedIds.size === 0}
                        onClick={handleUpdateSelected}
                    >
                        {updatingAll && updateProgress
                            ? t('installed.updatesModal.updatingProgress', {
                                  done: updateProgress.done,
                                  total: updateProgress.total,
                              })
                            : updatingAll
                              ? t('installed.updatesModal.updating')
                              : t('installed.updatesModal.updateSelected', {
                                    count: selectedIds.size,
                                })}
                    </Button>
                </div>
            </Dialog>
            {zipPickerData && gamePath && (
                <ZipPickerModal
                    payload={zipPickerData}
                    gamePath={gamePath}
                    installedFiles={installed}
                    gameId={gameId}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => {
                        setZipPickerData(null)
                        resumeQueueIfBatch()
                    }}
                />
            )}
            {hostPackData && gamePath && (
                <HostPackModal
                    payload={hostPackData}
                    gamePath={gamePath}
                    installed={installed}
                    gameId={gameId as GameId}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => {
                        setHostPackData(null)
                        resumeQueueIfBatch()
                    }}
                />
            )}
            {cbFlatArchiveData && gamePath && (
                <CrimeBossFlatArchiveModal
                    payload={cbFlatArchiveData}
                    gamePath={gamePath}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => {
                        setCbFlatArchiveData(null)
                        resumeQueueIfBatch()
                    }}
                />
            )}
            {loaderReplaceData && gamePath && (
                <Ue4ssReplaceModal
                    payload={loaderReplaceData}
                    gameId={gameId}
                    gamePath={gamePath}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => {
                        setLoaderReplaceData(null)
                        resumeQueueIfBatch()
                    }}
                />
            )}
            {fileChoice && (
                <UpdateFileModal
                    mod={fileChoice.mod}
                    files={fileChoice.files}
                    installed={installed.filter((mod) => mod.id === fileChoice.ins.id)}
                    onChoose={(fileId) => void installChosenFile(fileChoice.ins, fileId)}
                    onCancel={() => {
                        setFileChoice(null)
                        resumeQueueIfBatch()
                    }}
                />
            )}
            {unrecognizedModId !== null && (
                <UnrecognizedArchiveModal
                    modId={unrecognizedModId}
                    onClose={() => {
                        setUnrecognizedModId(null)
                        resumeQueueIfBatch()
                    }}
                />
            )}
        </>
    )
}
