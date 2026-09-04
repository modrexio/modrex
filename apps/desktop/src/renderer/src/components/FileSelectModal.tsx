import { useState, useEffect, useRef } from 'react'
import { Button } from './ui/Button'
import { Tag, Download, Clock, AlertTriangle } from 'lucide-react'
import type { ModFile, InstalledMod, ModSummary } from '../../../shared/types'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { MarkdownContent } from './MarkdownContent'
import { NonPakConfirmModal } from './NonPakConfirmModal'
import { ZipPickerModal } from './ZipPickerModal'
import type { ZipMultiPakPayload } from './ZipPickerModal'
import { isUnsupportedFormat } from '../formatCheck'
import { api } from '../api'

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${parseFloat((bytes / 1024 / 1024).toFixed(1))} MB`
}

interface Props {
    mod: ModSummary
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
                        const isInstalling = installingId === file.id
                        const isSelected = selectedIds.has(file.id)
                        return (
                            <div
                                key={file.id}
                                onClick={() => !isInstalled && !isBusy && toggleFile(file.id)}
                                className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                                    isInstalled
                                        ? 'bg-surface-hover border-border opacity-60'
                                        : isSelected
                                          ? 'bg-accent/5 border-accent/40 cursor-pointer'
                                          : 'bg-surface-hover border-border cursor-pointer'
                                }`}
                            >
                                <input
                                    type="checkbox"
                                    checked={isInstalled || isSelected}
                                    disabled={isInstalled || isBusy}
                                    onChange={() => toggleFile(file.id)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="w-4 h-4 shrink-0 cursor-pointer disabled:cursor-not-allowed"
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        {file.label && (
                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 border border-accent/30 text-accent font-medium uppercase tracking-wide shrink-0">
                                                {file.label}
                                            </span>
                                        )}
                                        <span className="text-sm font-semibold truncate">
                                            {file.name}
                                        </span>
                                        {isInstalling ? (
                                            <span className="text-xs text-text-muted shrink-0">
                                                {downloadProgress
                                                    ? downloadProgress.total > 0
                                                        ? `${Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)}%`
                                                        : t('common.downloading')
                                                    : t('common.installing')}
                                            </span>
                                        ) : isInstalled ? (
                                            <span className="text-xs text-success-text shrink-0">
                                                {t('common.installed')}
                                            </span>
                                        ) : null}
                                    </div>
                                    {file.desc && (
                                        <div className="text-xs text-text-muted mt-1 [&_a]:text-accent-bright [&_a]:hover:underline">
                                            <MarkdownContent text={file.desc} />
                                        </div>
                                    )}
                                    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-text-subtle">
                                        <span className="uppercase">{file.type}</span>
                                        <span>{formatBytes(file.size)}</span>
                                        {isUnsupportedFormat(file.type, file.download_url) && (
                                            <span className="flex items-center gap-1 text-warning">
                                                <AlertTriangle className="w-3 h-3 shrink-0" />
                                                {t('common.nonPakWarning')}
                                            </span>
                                        )}
                                        {file.version && (
                                            <span className="flex items-center gap-1">
                                                <Tag className="w-3 h-3 shrink-0" />
                                                {file.version}
                                            </span>
                                        )}
                                        {file.downloads != null && (
                                            <span className="flex items-center gap-1">
                                                <Download className="w-3 h-3 shrink-0" />
                                                {file.downloads.toLocaleString()}
                                            </span>
                                        )}
                                        {file.created_at && (
                                            <span className="flex items-center gap-1">
                                                <Clock className="w-3 h-3 shrink-0" />
                                                {new Date(file.created_at).toLocaleDateString(
                                                    undefined,
                                                    {
                                                        year: 'numeric',
                                                        month: 'short',
                                                        day: 'numeric',
                                                    }
                                                )}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
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
