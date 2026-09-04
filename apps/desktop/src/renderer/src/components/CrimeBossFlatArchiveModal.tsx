import { useState } from 'react'
import { Button } from './ui/Button'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { api } from '../api'

export interface CbFlatArchivePayload {
    archiveHandle: string
    modId: number
    modName: string
    fileId: number
    fileType: string
    modVersion: string
}

interface Props {
    payload: CbFlatArchivePayload
    gamePath: string
    folderId?: string | null
    onRefreshInstalled: () => Promise<void>
    onClose: () => void
}

/**
 * Confirms installing a Crime Boss archive that has no enclosing folder (every entry sits at the
 * zip root). There is only one possible destination (the primary mods/ target), so this is a
 * yes/no confirmation rather than a picker.
 */
export function CrimeBossFlatArchiveModal({
    payload,
    gamePath,
    folderId,
    onRefreshInstalled,
    onClose,
}: Props) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function handleInstall() {
        setBusy(true)
        setError(null)
        try {
            await api.installCbFlatArchive(
                payload.archiveHandle,
                payload.modId,
                payload.modName,
                payload.fileId,
                payload.fileType,
                payload.modVersion,
                gamePath,
                folderId
            )
            await onRefreshInstalled()
            onClose()
        } catch (e) {
            setError(String(e))
            setBusy(false)
        }
    }

    async function handleCancel() {
        if (busy) return
        await api.discardStagedArchive(payload.archiveHandle)
        onClose()
    }

    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && handleCancel()}
            title={t('cbFlatArchive.title')}
            className="w-[460px]"
        >
            <DialogHeader
                title={t('cbFlatArchive.title')}
                subtitle={payload.modName}
                onClose={handleCancel}
                closeDisabled={busy}
            />

            <div className="px-5 py-4 flex flex-col gap-3">
                {error && (
                    <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text">
                        {error}
                    </div>
                )}
                <p className="text-sm text-text-muted">
                    {t('cbFlatArchive.body', { name: payload.modName })}
                </p>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                <Button
                    variant="secondary"
                    size="md"
                    onClick={!busy ? handleCancel : undefined}
                    disabled={busy}
                >
                    {t('common.cancel')}
                </Button>
                <Button variant="accent" size="lg" disabled={busy} onClick={handleInstall}>
                    {busy ? t('cbFlatArchive.installing') : t('cbFlatArchive.install')}
                </Button>
            </div>
        </Dialog>
    )
}
