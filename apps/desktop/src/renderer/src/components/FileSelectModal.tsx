import { useState, useEffect, useRef } from 'react'
import { Button } from './ui/Button'
import type { ModFile, InstalledMod, Mod } from '../../../shared/types'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { NonPakConfirmModal } from './NonPakConfirmModal'
import { ZipPickerModal } from './ZipPickerModal'
import type { ZipMultiPakPayload } from './ZipPickerModal'
import { isUnsupportedFormat } from '../formatCheck'
import { api } from '../api'
import { FileRow } from './FileRow'

interface Props {
    mod: Mod
    files: ModFile[]
    gamePath: string | null
    installedFiles: InstalledMod[]
    gameId: string
    onRefreshInstalled: () => Promise<void>
    onClose: () => void
}

export function FileSelectModal({
    mod,
    files,
    gamePath,
    installedFiles,
    gameId,
    onRefreshInstalled,
    onClose,
}: Props) {
    const uninstalledIds = files
        .filter((f) => !installedFiles.some((m) => m.fileId === f.id))
        .map((f) => f.id)

    const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set(uninstalledIds))
    const [installingId, setInstallingId] = useState<number | null>(null)
    const [installError, setInstallError] = useState<string | null>(null)
    const [showFormatWarning, setShowFormatWarning] = useState(false)
    const [zipPayload, setZipPayload] = useState<ZipMultiPakPayload | null>(null)
    const zipResolveRef = useRef<(() => void) | null>(null)
    const [downloadProgress, setDownloadProgress] = useState<{
        downloaded: number
        total: number
    } | null>(null)
    const installingIdRef = useRef<number | null>(null)

    useEffect(() => {
        return api.onDownloadProgress(({ download_id, downloaded, total }) => {
            const id = installingIdRef.current
            if (id !== null && download_id === `file:${mod.id}:${id}`) {
                setDownloadProgress({ downloaded, total })
            }
        })
    }, [mod.id])

    function toggleFile(fileId: number) {
        setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(fileId)) next.delete(fileId)
            else next.add(fileId)
            return next
        })
    }

    function handleInstallSelected() {
        if (!gamePath) return
        const toInstall = files.filter(
            (f) => selectedIds.has(f.id) && !installedFiles.some((m) => m.fileId === f.id)
        )
        if (toInstall.some((f) => isUnsupportedFormat(f.type, f.download_url))) {
            setShowFormatWarning(true)
            return
        }
        doInstallSelected()
    }

    async function doInstallSelected() {
        if (!gamePath) return
        setInstallError(null)
        const toInstall = files.filter(
            (f) => selectedIds.has(f.id) && !installedFiles.some((m) => m.fileId === f.id)
        )
        for (const file of toInstall) {
            setInstallingId(file.id)
            installingIdRef.current = file.id
            setDownloadProgress(null)
            try {
                const outcome = await api.installModFile(
                    mod.id,
                    mod.name,
                    file.id,
                    file.download_url,
                    file.type ?? '',
                    mod.version,
                    gamePath,
                    gameId
                )
                if (typeof outcome !== 'string' && 'needsPicker' in outcome) {
                    setZipPayload(outcome.needsPicker as unknown as ZipMultiPakPayload)
                    await new Promise<void>((resolve) => {
                        zipResolveRef.current = resolve
                    })
                    setZipPayload(null)
                    setSelectedIds((prev) => {
                        const next = new Set(prev)
                        next.delete(file.id)
                        return next
                    })
                    continue
                }
                if (outcome !== 'installed') {
                    // Host-pack / CB-flat / unrecognized prompts have no inline UI in this
                    // modal (they never did); surface the kind instead of installing wrong.
                    setInstallError(typeof outcome === 'string' ? outcome : Object.keys(outcome)[0])
                    setInstallingId(null)
                    return
                }
                await onRefreshInstalled()
                setSelectedIds((prev) => {
                    const next = new Set(prev)
                    next.delete(file.id)
                    return next
                })
            } catch (e) {
                setInstallError(String(e))
                setInstallingId(null)
                return
            }
        }
        setInstallingId(null)
        onClose()
    }

    const pendingCount = [...selectedIds].filter(
        (id) => !installedFiles.some((m) => m.fileId === id)
    ).length
    const isBusy = installingId !== null

    return (
        <>
            <Dialog
                open={true}
                onOpenChange={(open) => !open && onClose()}
                title={t('fileSelect.title')}
                size="list"
                className="w-[540px]"
            >
                <DialogHeader
                    title={t('fileSelect.title')}
                    subtitle={t('fileSelect.subtitle', { modName: mod.name })}
                    onClose={onClose}
                />

                {downloadProgress !== null && (
                    <div className="h-0.5 bg-surface-active shrink-0">
                        {downloadProgress.total > 0 ? (
                            <div
                                className="h-full bg-accent transition-[width] duration-100"
                                style={{
                                    width: `${Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)}%`,
                                }}
                            />
                        ) : (
                            <div className="h-full bg-accent animate-pulse w-full" />
                        )}
                    </div>
                )}

                <div className="overflow-y-auto flex-1 px-4 py-3 flex flex-col gap-2">
                    {installError && (
                        <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text">
                            {installError}
                        </div>
                    )}
                    {files.map((file) => {
                        const isInstalled = installedFiles.some((m) => m.fileId === file.id)
                        return (
                            <FileRow
                                key={file.id}
                                file={file}
                                checked={isInstalled || selectedIds.has(file.id)}
                                installed={isInstalled}
                                locked={isInstalled}
                                disabled={isBusy}
                                status={
                                    installingId !== file.id
                                        ? null
                                        : downloadProgress
                                          ? downloadProgress.total > 0
                                              ? `${Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)}%`
                                              : t('common.downloading')
                                          : t('common.installing')
                                }
                                onToggle={() => toggleFile(file.id)}
                            />
                        )
                    })}
                </div>

                <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                    <Button variant="secondary" size="md" onClick={onClose} disabled={isBusy}>
                        {t('common.close')}
                    </Button>
                    {mod.disable_mod_managers ? (
                        <span className="text-xs text-text-muted">
                            {t('common.modManagerDisabled')}
                        </span>
                    ) : (
                        <Button
                            variant="accent"
                            size="lg"
                            disabled={!gamePath || isBusy || pendingCount === 0}
                            onClick={handleInstallSelected}
                        >
                            {t('fileSelect.installSelected', { count: pendingCount })}
                        </Button>
                    )}
                </div>
            </Dialog>
            {showFormatWarning && (
                <NonPakConfirmModal
                    onConfirm={() => {
                        setShowFormatWarning(false)
                        doInstallSelected()
                    }}
                    onCancel={() => setShowFormatWarning(false)}
                />
            )}
            {zipPayload && gamePath && (
                <ZipPickerModal
                    payload={zipPayload}
                    gamePath={gamePath}
                    installedFiles={installedFiles}
                    gameId={gameId}
                    onRefreshInstalled={onRefreshInstalled}
                    onClose={() => {
                        zipResolveRef.current?.()
                        zipResolveRef.current = null
                    }}
                />
            )}
        </>
    )
}
