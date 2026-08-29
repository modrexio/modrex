import { useState } from 'react'
import { Button } from './ui/Button'
import type { GameId, InstalledMod } from '../../../shared/types'
import { Dialog, DialogHeader } from './Dialog'
import { t } from '../i18n'
import { api } from '../api'

export interface HostPackPayload {
    zipPath: string
    cleanupToken: string
    entries: string[]
    hostModId: number
    hostName: string
    hostSubpath: string
    modId: number
    modName: string
    fileId: number
    fileType: string
    modVersion: string
}

interface Props {
    payload: HostPackPayload
    gamePath: string
    installed: InstalledMod[]
    gameId: GameId
    onRefreshInstalled: () => Promise<void>
    onClose: () => void
}

function setName(entry: string): string {
    return entry.split('/').filter(Boolean).pop() ?? entry
}

/**
 * Confirms installing a content pack (e.g. Menu Backgrounds sets) into its host mod. When the
 * host mod isn't installed yet, offers to install it first; otherwise installs each set into the
 * host's folder via install_host_pack.
 */
export function HostPackModal({
    payload,
    gamePath,
    installed,
    gameId,
    onRefreshInstalled,
    onClose,
}: Props) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Host packs are a modworkshop-only concept; InstalledMod.id is an opaque local
    // key, so the real modworkshop id only ever lives in remoteId.
    const hostModIdStr = String(payload.hostModId)
    const hostInstalled = installed.some((m) => m.remoteId === hostModIdStr)

    async function handleInstallHost() {
        setBusy(true)
        setError(null)
        try {
            await api.installMod(payload.hostModId, gamePath, gameId)
            await onRefreshInstalled()
        } catch (e) {
            setError(String(e))
        } finally {
            setBusy(false)
        }
    }

    async function handleInstall() {
        setBusy(true)
        setError(null)
        try {
            for (const entry of payload.entries) {
                await api.installHostPack(
                    payload.zipPath,
                    entry,
                    payload.modId,
                    payload.modName,
                    payload.fileId,
                    payload.fileType,
                    payload.modVersion,
                    gamePath,
                    payload.hostModId,
                    payload.hostSubpath,
                    gameId
                )
            }
            await api.discardStagedArchive(payload.cleanupToken)
            await onRefreshInstalled()
            onClose()
        } catch (e) {
            setError(String(e))
            setBusy(false)
        }
    }

    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && !busy && onClose()}
            title={t('hostPack.title')}
            className="w-[460px]"
        >
            <DialogHeader
                title={t('hostPack.title')}
                subtitle={payload.modName}
                onClose={onClose}
                closeDisabled={busy}
            />

            <div className="px-5 py-4 flex flex-col gap-3">
                {error && (
                    <div className="px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text">
                        {error}
                    </div>
                )}
                {hostInstalled ? (
                    <>
                        <p className="text-sm text-text-muted">
                            {t('hostPack.intoHost', {
                                hostName: payload.hostName,
                                count: payload.entries.length,
                            })}
                        </p>
                        <div className="flex flex-col gap-1.5">
                            {payload.entries.map((entry) => (
                                <div
                                    key={entry}
                                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-hover text-sm"
                                >
                                    <span className="truncate">{setName(entry)}</span>
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <p className="text-sm text-text-muted">
                        {t('hostPack.requiresHost', { hostName: payload.hostName })}
                    </p>
                )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                <Button
                    variant="secondary"
                    size="md"
                    onClick={!busy ? onClose : undefined}
                    disabled={busy}
                >
                    {t('common.cancel')}
                </Button>
                <Button
                    variant="accent"
                    size="lg"
                    disabled={busy}
                    onClick={hostInstalled ? handleInstall : handleInstallHost}
                >
                    {busy
                        ? t('hostPack.installing')
                        : hostInstalled
                          ? t('hostPack.install', { count: payload.entries.length })
                          : t('hostPack.installHost', { hostName: payload.hostName })}
                </Button>
            </div>
        </Dialog>
    )
}
