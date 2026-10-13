import { useRef, useState, useSyncExternalStore } from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import { api } from '../api'
import { getGameData, refreshInstalled, subscribeGameData } from '../gameData'
import {
    finishInstallChoice,
    getPendingInstallChoice,
    subscribeInstallChoices,
    reportInstallChoiceCleanupError,
    type InstallChoice,
} from '../installChoices'
import { archiveHandleForOutcome, getArchiveInstall } from '../installState'
import { getPendingResourceReview, subscribeResourceReview } from '../resourceInstall'
import { ZipPickerModal, type ZipMultiPakPayload } from './ZipPickerModal'
import { HostPackModal, type HostPackPayload } from './HostPackModal'
import { CrimeBossFlatArchiveModal, type CbFlatArchivePayload } from './CrimeBossFlatArchiveModal'
import { Ue4ssReplaceModal, type LoaderReplacePayload } from './Ue4ssReplaceModal'
import { UnrecognizedArchiveModal } from './UnrecognizedArchiveModal'
import { Dialog, DialogHeader } from './Dialog'
import { Button } from './ui/Button'
import { t } from '../i18n'

function ArchiveChoice({ choice, visible }: { choice: InstallChoice; visible: boolean }) {
    const data = useSyncExternalStore(
        (listener) => subscribeGameData(choice.gameId, listener),
        () => getGameData(choice.gameId)
    )
    const installed = data.installed?.mods ?? choice.installedFiles
    const refresh = () => refreshInstalled(choice.gameId)
    const { outcome, gameId, gamePath, folderId } = choice
    const closing = useRef(false)
    const [cleanupPending, setCleanupPending] = useState(false)
    const archiveHandle = archiveHandleForOutcome(outcome)

    async function close() {
        if (closing.current) return
        closing.current = true
        setCleanupPending(true)
        try {
            if (archiveHandle && getArchiveInstall(archiveHandle)) {
                await api.discardStagedArchive(archiveHandle)
            }
        } catch (error) {
            void logError('Archive choice cleanup failed: ' + String(error))
            closing.current = false
            setCleanupPending(false)
            reportInstallChoiceCleanupError(choice, String(error))
            return
        }
        finishInstallChoice(choice)
    }

    if (choice.cleanupError)
        return (
            <Dialog
                open={visible}
                onOpenChange={(open) => !open && close()}
                title={t('common.archiveCleanupFailed')}
                className="w-[460px]"
            >
                <DialogHeader
                    title={t('common.archiveCleanupFailed')}
                    onClose={close}
                    closeDisabled={cleanupPending}
                />
                <p role="alert" className="px-5 py-4 text-sm text-danger-text">
                    {choice.cleanupError}
                </p>
                <div className="px-5 py-4 border-t border-border flex justify-end">
                    <Button variant="accent" disabled={cleanupPending} onClick={close}>
                        {t('resources.recovery.retry')}
                    </Button>
                </div>
            </Dialog>
        )

    if (outcome === 'unrecognized')
        return <UnrecognizedArchiveModal visible={visible} modId={choice.modId!} onClose={close} />
    if (outcome.needsPicker)
        return (
            <ZipPickerModal
                visible={visible}
                payload={outcome.needsPicker as ZipMultiPakPayload}
                gameId={gameId}
                gamePath={gamePath}
                folderId={folderId}
                installedFiles={installed}
                onRefreshInstalled={refresh}
                onClose={close}
            />
        )
    if (outcome.needsHostChoice)
        return (
            <HostPackModal
                visible={visible}
                payload={outcome.needsHostChoice as HostPackPayload}
                gameId={gameId}
                gamePath={gamePath}
                installed={installed}
                onRefreshInstalled={refresh}
                onClose={close}
            />
        )
    if (outcome.needsLoaderConfirm)
        return (
            <Ue4ssReplaceModal
                visible={visible}
                payload={outcome.needsLoaderConfirm as LoaderReplacePayload}
                gameId={gameId}
                gamePath={gamePath}
                onRefreshInstalled={refresh}
                onClose={close}
            />
        )
    return (
        <CrimeBossFlatArchiveModal
            visible={visible}
            payload={outcome.needsCbFlatConfirm as CbFlatArchivePayload}
            gamePath={gamePath}
            folderId={folderId}
            onRefreshInstalled={refresh}
            onClose={close}
        />
    )
}

export function InstallChoiceDialog() {
    const choice = useSyncExternalStore(subscribeInstallChoices, getPendingInstallChoice)
    const resource = useSyncExternalStore(subscribeResourceReview, getPendingResourceReview)
    if (!choice) return null
    return <ArchiveChoice key={choice.id} choice={choice} visible={resource === null} />
}
