import { ScrollArea } from './ScrollArea'
import { useState, type ComponentProps } from 'react'
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
import { installLabel, useModInstall, useModInstallBusy } from '../installState'
import { isUnsupportedFormat } from '../formatCheck'
import { api } from '../api'
import { FileRow } from './FileRow'
import { InstallProgressBar } from './InstallStatus'

function SelectableInstallFile({
    gameId,
    modId,
    file,
    installing,
    ...props
}: Omit<ComponentProps<typeof FileRow>, 'status'> & { modId: number; installing: boolean }) {
    const operation = useModInstall(gameId, 'modworkshop', modId, file.id)
    return (
        <FileRow
            {...props}
            gameId={gameId}
            file={file}
            status={
                operation ? installLabel(operation) : installing ? t('common.installing') : null
            }
        />
    )
}

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
    const installBusy = useModInstallBusy(gameId, 'modworkshop', mod.id, installingId ?? undefined)

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
    const isBusy = installingId !== null || installBusy

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

                <InstallProgressBar
                    gameId={gameId}
                    source="modworkshop"
                    modId={mod.id}
                    fileId={installingId ?? undefined}
                />

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
                        return (
                            <SelectableInstallFile
                                modId={mod.id}
                                installing={installingId === file.id}
                                gameId={gameId}
                                key={file.id}
                                file={file}
                                checked={isInstalled || selectedIds.has(file.id)}
                                installed={isInstalled}
                                locked={isInstalled}
                                disabled={isBusy}
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
