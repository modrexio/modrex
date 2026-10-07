import { DisclosureSummary } from './ui/DisclosureSummary'
import { useEffect, useRef, useState } from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import { GAMES, type GameId, type InstalledMod } from '../../../shared/types'
import { api, type ResourceRecoveryReview } from '../api'
import { refreshInstalled } from '../gameData'
import { t } from '../i18n'
import { Dialog, DialogHeader } from './Dialog'
import { Button } from './ui/Button'
import { formatBytes } from './modDetail/format'
import { displayPath } from '../lib/displayPath'

export function ResourceRecoveryDialog({
    activeGame,
    resource,
    onClose,
}: {
    activeGame: GameId
    resource?: Pick<InstalledMod, 'uid' | 'name'>
    onClose: () => void
}) {
    const [review, setReview] = useState<ResourceRecoveryReview | null>(null)
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [kept, setKept] = useState(false)
    const reviewHandle = useRef<string | null>(null)
    const uid = resource?.uid ?? null

    useEffect(() => {
        let current = true
        setBusy(true)
        setReview(null)
        setError(null)
        api.reviewResourceRecovery(activeGame, uid)
            .then(async (value) => {
                if (!current) {
                    await api.cancelResourceRecovery(value.reviewHandle)
                    return
                }
                reviewHandle.current = value.reviewHandle
                setReview(value)
            })
            .catch((failure) => {
                if (current) setError(String(failure))
                else
                    void logError(
                        'Resource recovery failed after the dialog closed: ' + String(failure)
                    )
            })
            .finally(() => {
                if (current) setBusy(false)
            })
        return () => {
            current = false
            const handle = reviewHandle.current
            reviewHandle.current = null
            if (handle) {
                void api.cancelResourceRecovery(handle).catch((failure) => {
                    void logError('Resource recovery review cleanup failed: ' + String(failure))
                })
            }
        }
    }, [activeGame, uid, attempt])

    async function close() {
        if (busy) return
        if (reviewHandle.current) {
            try {
                await api.cancelResourceRecovery(reviewHandle.current)
                reviewHandle.current = null
            } catch (failure) {
                setError(String(failure))
                return
            }
        }
        onClose()
    }

    async function keepCurrent() {
        if (!review) return
        setBusy(true)
        setError(null)
        try {
            await api.keepCurrentResources(review.reviewHandle)
            reviewHandle.current = null
            setReview(null)
            setKept(true)
            await reloadInstalled()
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    async function reloadInstalled() {
        setBusy(true)
        setError(null)
        try {
            await refreshInstalled(activeGame)
            onClose()
        } catch (failure) {
            setError(t('resources.recovery.refreshFailed') + '\n' + String(failure))
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog
            open
            onOpenChange={(open) => !open && void close()}
            title={t('resources.recovery.title')}
            size="list"
            className="w-[38rem] max-w-[95vw]"
        >
            <DialogHeader
                title={resource?.name ?? t('resources.recovery.pending')}
                subtitle={GAMES[activeGame].name}
                onClose={() => void close()}
                closeDisabled={busy}
            />
            <div className="p-5 flex flex-col gap-4 overflow-y-auto text-sm">
                <p className="text-text-muted">
                    {t(kept ? 'resources.recovery.kept' : 'resources.recovery.description')}
                </p>
                {busy && !review && <p role="status">{t('common.loading')}</p>}
                {review && (
                    <>
                        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
                            <p>{t('resources.recovery.keepDescription')}</p>
                            <p className="mt-3 text-xs text-text-muted">
                                {t('resources.recovery.affected')}
                            </p>
                            <ul className="list-disc pl-5 mt-1">
                                {review.deployments.map((name, index) => (
                                    <li key={index}>{name}</li>
                                ))}
                            </ul>
                        </div>
                        <div className="flex flex-col gap-2">
                            <h3 className="font-medium">{t('resources.recovery.currentFiles')}</h3>
                            {review.files.map((file) => (
                                <div
                                    key={file.path}
                                    className="border border-border rounded-lg p-3 text-xs"
                                >
                                    <p className="font-mono break-all">
                                        {file.path.split(/[\\/]/).at(-1)}
                                    </p>
                                    <p className="mt-1 text-text-muted">
                                        {file.current.state === 'absent'
                                            ? t('resources.recovery.absent')
                                            : t('resources.recovery.fileSize', {
                                                  size: formatBytes(file.current.size),
                                              })}
                                    </p>
                                </div>
                            ))}
                        </div>
                        <details className="text-xs text-text-muted">
                            <DisclosureSummary className="cursor-pointer">
                                {t('resources.details')}
                            </DisclosureSummary>
                            {review.files.map((file) => (
                                <div key={file.path} className="mt-3 font-mono break-all">
                                    <p>{displayPath(file.path)}</p>
                                    {file.current.state === 'present' && (
                                        <p>{file.current.sha256}</p>
                                    )}
                                </div>
                            ))}
                            <Button
                                variant="secondary"
                                size="sm"
                                className="mt-3"
                                onClick={() => {
                                    void api
                                        .openDataFolder()
                                        .catch((failure) => setError(String(failure)))
                                }}
                            >
                                {t('resources.recovery.openCopies')}
                            </Button>
                            <p className="mt-2">{t('resources.recovery.copiesLocation')}</p>
                        </details>
                    </>
                )}
                {error && (
                    <div role="alert" className="text-danger-text text-xs whitespace-pre-wrap">
                        <p>{error}</p>
                        {!review && (
                            <Button
                                variant="secondary"
                                size="sm"
                                className="mt-2"
                                disabled={busy}
                                onClick={() =>
                                    kept ? void reloadInstalled() : setAttempt((value) => value + 1)
                                }
                            >
                                {t('resources.recovery.retry')}
                            </Button>
                        )}
                    </div>
                )}
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border shrink-0">
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void close()}>
                    {t(kept ? 'common.close' : 'common.cancel')}
                </Button>
                <Button
                    variant="accent"
                    size="sm"
                    disabled={busy || !review}
                    onClick={() => void keepCurrent()}
                >
                    {t('resources.recovery.keep')}
                </Button>
            </div>
        </Dialog>
    )
}
