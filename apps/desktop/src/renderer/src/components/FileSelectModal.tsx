import { ScrollArea } from './ScrollArea'
import { useState } from 'react'
import { Button } from './ui/Button'
import {
    GAMES,
    type GameId,
    type ModFile,
    type InstalledMod,
    type Mod,
} from '../../../shared/types'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { NonPakConfirmModal } from './NonPakConfirmModal'
import { requestInstallChoice, useInstallChoiceOpen } from '../installChoices'
import {
    getModInstall,
    installLabel,
    installProgress,
    isInstallBusy,
    useInstallOperations,
} from '../installState'
import { isUnsupportedFormat } from '../formatCheck'
import { api } from '../api'
import { FileRow } from './FileRow'

interface Props {
    mod: Mod
    files: ModFile[]
    gamePath: string | null
    installedFiles: InstalledMod[]
    gameId: GameId
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
    const choiceOpen = useInstallChoiceOpen()
    const operations = useInstallOperations(gameId)
    const installation = getModInstall(operations, 'modworkshop', mod.id, installingId ?? undefined)
    const downloadProgress = installProgress(installation)

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
        if (
            toInstall.some((f) =>
                isUnsupportedFormat(GAMES[gameId], f.type, f.download_url, f.name)
            )
        ) {
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
                await requestInstallChoice(outcome, gameId, gamePath, installedFiles, null, mod.id)
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
    const isBusy = installingId !== null || isInstallBusy(installation)

    return (
        <>
            <Dialog
                open={!choiceOpen && !showFormatWarning}
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

                <ScrollArea
                    hostClassName="flex-1"
                    className="overflow-y-auto px-4 py-3 flex flex-col gap-2"
                >
                    {installError && (
                        <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text">
                            {installError}
                        </div>
                    )}
                    {files.map((file) => {
                        const isInstalled = installedFiles.some((m) => m.fileId === file.id)
                        const fileInstall = getModInstall(
                            operations,
                            'modworkshop',
                            mod.id,
                            file.id
                        )
                        return (
                            <FileRow
                                gameId={gameId}
                                key={file.id}
                                file={file}
                                checked={isInstalled || selectedIds.has(file.id)}
                                installed={isInstalled}
                                locked={isInstalled}
                                disabled={isBusy}
                                status={
                                    fileInstall
                                        ? installLabel(fileInstall)
                                        : installingId === file.id
                                          ? t('common.installing')
                                          : null
                                }
                                onToggle={() => toggleFile(file.id)}
                            />
                        )
                    })}
                </ScrollArea>

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
        </>
    )
}
