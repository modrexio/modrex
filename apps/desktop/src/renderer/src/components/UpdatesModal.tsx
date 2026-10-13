import { ScrollArea } from './ScrollArea'
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
import { computeAutoUpdateSelection, installZipPickerEntries } from './ZipPickerModal'
import type { ZipMultiPakPayload } from './ZipPickerModal'
import { requestInstallChoice, useInstallChoiceOpen } from '../installChoices'
import { getModInstall, installLabel, isInstallBusy, useInstallOperations } from '../installState'
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
    gameId: GameId
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
    gameId,
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
    gameId: GameId
    gamePath: string | null
    onToggle: () => void
    onOpenDetail: () => void
    onUpdate: () => void
}) {
    // useThumbnail passes an absolute URL (Nexus's picture_url) through untouched,
    // unlike a bare THUMBNAIL_BASE_URL concatenation, which would have doubled up
    // into a broken URL for any Nexus mod that actually has a picture.
    const thumbSrc = useThumbnail(mod.thumbnail?.file)
    const operations = useInstallOperations(gameId)
    const installation = getModInstall(
        operations,
        ins.source === 'nexus' ? 'nexus' : 'modworkshop',
        Number(ins.remoteId)
    )
    const busy = isLoading || isInstallBusy(installation)
    return (
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0">
            <input
                type="checkbox"
                checked={checked}
                disabled={busy}
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
                disabled={!gamePath || busy}
                onClick={onUpdate}
                className="text-xs px-3 py-1 rounded bg-surface-active hover:bg-surface-light disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            >
                {installation
                    ? installLabel(installation)
                    : isLoading
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
    const [fileChoice, setFileChoice] = useState<{
        ins: InstalledMod
        mod: Mod
        files: ModFile[]
        resolve: (fileId: number | null) => void
    } | null>(null)
    const choiceOpen = useInstallChoiceOpen()
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
    ): Promise<void> {
        if (!gamePath) return
        if (typeof outcome !== 'string' && 'needsPicker' in outcome) {
            const zipData = outcome.needsPicker as unknown as ZipMultiPakPayload
            const autoEntries = computeAutoUpdateSelection(zipData, installed)
            if (autoEntries) {
                try {
                    await installZipPickerEntries(
                        zipData,
                        autoEntries,
                        gamePath,
                        gameId,
                        null,
                        onRefreshInstalled
                    )
                    return
                } catch (error) {
                    setUpdateError(String(error))
                }
            }
        }
        await requestInstallChoice(outcome, gameId, gamePath, installed, null, modId)
    }

    async function installUpdate(
        ins: InstalledMod,
        installPath: string
    ): Promise<InstallOutcome | 'unchanged' | 'unavailable'> {
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
            const fileId = await new Promise<number | null>((resolve) =>
                setFileChoice({ ins, mod: detail, files, resolve })
            )
            setFileChoice(null)
            if (fileId === null) return 'cancelled'
            return api.installMod(remoteId, installPath, gameId, fileId)
        }
        return api.installMod(remoteId, installPath, gameId)
    }

    async function handleUpdate(ins: InstalledMod) {
        if (!gamePath) return
        const nexusUrl = nexusUpdateUrl(ins, gameId)
        const remoteId = Number(ins.remoteId)
        if (!Number.isFinite(remoteId) || remoteId <= 0) return
        setLoadingMod(ins.uid)
        setUpdateError(null)
        try {
            if (nexusUrl) {
                await api.requestNexusDownload(gameId, remoteId, nexusUrl)
                return
            }
            const outcome = await installUpdate(ins, gamePath)
            if (outcome === 'installed') {
                await onRefreshInstalled()
                return
            }
            if (outcome === 'unchanged' || outcome === 'unavailable') return
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
    }

    async function processQueue(queue: InstalledMod[]) {
        if (!gamePath) return
        for (const ins of queue) {
            const nexusUrl = nexusUpdateUrl(ins, gameId)
            const remoteId = Number(ins.remoteId)
            if (!Number.isFinite(remoteId) || remoteId <= 0) continue
            try {
                if (nexusUrl) {
                    await api.requestNexusDownload(gameId, remoteId, nexusUrl)
                    setUpdateProgress((prev) => prev && { done: prev.done + 1, total: prev.total })
                    continue
                }
                const outcome = await installUpdate(ins, gamePath)
                setUpdateProgress((prev) => prev && { done: prev.done + 1, total: prev.total })
                if (
                    outcome !== 'installed' &&
                    outcome !== 'unchanged' &&
                    outcome !== 'unavailable'
                ) {
                    await resolveInstallPrompt(outcome, remoteId)
                }
            } catch (error) {
                reportFailure(error)
                stopBatch()
                return
            }
        }
        try {
            await onRefreshInstalled()
            if (!skippedRef.current) onClose()
        } catch (error) {
            reportFailure(error)
        } finally {
            stopBatch()
        }
    }

    async function handleUpdateSelected() {
        if (!gamePath) return
        setUpdateError(null)
        skippedRef.current = false
        setUpdatingAll(true)
        const queue = updatable.filter((m) => selectedIds.has(m.id))
        setUpdateProgress({ done: 0, total: queue.length })
        await processQueue(queue)
    }

    return (
        <>
            <Dialog
                open={visible && !fileChoice && !choiceOpen}
                onOpenChange={(open) => !open && onClose()}
                title={t('installed.updatesModal.title', { count: updatable.length })}
                size="list"
                className="w-[32rem]"
            >
                <DialogHeader
                    title={t('installed.updatesModal.title', { count: updatable.length })}
                    onClose={onClose}
                />

                <ScrollArea hostClassName="flex-1" className="overflow-y-auto">
                    {updatable.map((ins) => (
                        <UpdateModalRow
                            version={updateVersions.get(ins.id)!}
                            key={ins.uid}
                            ins={ins}
                            mod={modData.get(ins.id) ?? syntheticMod(ins)}
                            checked={selectedIds.has(ins.id)}
                            isLoading={loadingMod === ins.uid || updatingAll}
                            gameId={gameId}
                            gamePath={gamePath}
                            onToggle={() => toggleSelected(ins.id)}
                            onOpenDetail={() => onOpenDetail(...detailNavArgs(ins))}
                            onUpdate={() => handleUpdate(ins)}
                        />
                    ))}
                </ScrollArea>

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
            {fileChoice && (
                <UpdateFileModal
                    gameId={gameId}
                    mod={fileChoice.mod}
                    files={fileChoice.files}
                    installed={installed.filter((mod) => mod.id === fileChoice.ins.id)}
                    onChoose={fileChoice.resolve}
                    onCancel={() => fileChoice.resolve(null)}
                />
            )}
        </>
    )
}
