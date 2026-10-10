import { useState } from 'react'
import { Button } from './ui/Button'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { api } from '../api'
import { ScrollArea } from './ScrollArea'

export interface LoaderReplacePayload {
    archiveHandle: string
    modName: string
    page: { source: string; remoteId: string; fileId: number | null; version: string } | null
    replaced: string[]
    preserved: string[]
}

interface Props {
    payload: LoaderReplacePayload
    gameId: string
    gamePath: string
    onRefreshInstalled: () => Promise<void>
    onClose: () => void
}

/**
 * A short, scrollable list of paths, shared with the removal dialog so both name what they
 * touch the same way.
 */
export function FileList({ heading, paths }: { heading: string; paths: string[] }) {
    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
                {heading}
            </div>
            <ScrollArea
                hostClassName="max-h-40 rounded-lg border border-border bg-surface-2"
                className="overflow-y-auto px-3 py-2 text-sm"
            >
                <ul>
                    {paths.map((path) => (
                        <li key={path} className="truncate" title={path}>
                            {path}
                        </li>
                    ))}
                </ul>
            </ScrollArea>
        </div>
    )
}

/**
 * Confirms replacing an installed UE4SS with another release.
 *
 * The loader is not tracked like a mod, so a replacement removes files nothing in the mod list
 * describes, and which files those are depends on which release is installed. Naming them is
 * the only way the user can tell an update apart from losing their setup.
 */
export function Ue4ssReplaceModal({
    payload,
    gameId,
    gamePath,
    onRefreshInstalled,
    onClose,
}: Props) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function handleReplace() {
        setBusy(true)
        setError(null)
        try {
            await api.installConfirmedLoader(payload.archiveHandle, gameId, gamePath, payload.page)
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
            title={t('ue4ssReplace.title')}
            className="w-[520px]"
        >
            <DialogHeader
                title={t('ue4ssReplace.title')}
                subtitle={payload.modName}
                onClose={handleCancel}
                closeDisabled={busy}
            />

            <div className="px-5 py-4 flex flex-col gap-4">
                {error && (
                    <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text">
                        {error}
                    </div>
                )}
                <p className="text-sm text-text-muted">
                    {t('ue4ssReplace.body', { name: payload.modName })}
                </p>
                {payload.replaced.length > 0 && (
                    <FileList heading={t('ue4ssReplace.removed')} paths={payload.replaced} />
                )}
                {payload.preserved.length > 0 ? (
                    <FileList heading={t('ue4ssReplace.kept')} paths={payload.preserved} />
                ) : (
                    <p className="text-sm text-text-muted">{t('ue4ssReplace.nothingOfYours')}</p>
                )}
                <p className="text-sm text-text-muted">{t('ue4ssReplace.modsListNote')}</p>
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
                <Button variant="accent" size="lg" disabled={busy} onClick={handleReplace}>
                    {busy ? t('ue4ssReplace.replacing') : t('ue4ssReplace.replace')}
                </Button>
            </div>
        </Dialog>
    )
}
