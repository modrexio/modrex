import { useEffect, useState } from 'react'
import type { GameId, InstalledMod } from '../../../shared/types'
import { api, type ResourceRecoveryReview } from '../api'
import { refreshInstalled } from '../gameData'
import { t } from '../i18n'
import { Dialog, DialogHeader } from './Dialog'
import { Select } from './Select'
import { Button } from './ui/Button'

export function ResourceRecoveryDialog({
    activeGame,
    onClose,
}: {
    activeGame: GameId
    onClose: () => void
}) {
    const [resources, setResources] = useState<InstalledMod[]>([])
    const [selected, setSelected] = useState('')
    const [review, setReview] = useState<ResourceRecoveryReview | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        let current = true
        api.getInstalled(activeGame)
            .then((response) => {
                if (!current) return
                setResources(response.mods.filter((mod) => mod.deployment))
                setError(response.resourceError ?? null)
            })
            .catch((failure) => {
                if (current) setError(String(failure))
            })
        return () => {
            current = false
        }
    }, [activeGame])

    async function prepare() {
        setBusy(true)
        setError(null)
        try {
            if (review) await api.cancelResourceRecovery(review.reviewHandle)
            setReview(
                await api.reviewResourceRecovery(
                    activeGame,
                    selected === 'pending' ? null : selected
                )
            )
        } catch (failure) {
            setReview(null)
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    async function close() {
        if (busy) return
        if (review) {
            try {
                await api.cancelResourceRecovery(review.reviewHandle)
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
            setReview(null)
            await refreshInstalled(activeGame)
            onClose()
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) void close()
            }}
            title={t('resources.recovery.title')}
            size="list"
            className="w-[38rem] max-w-[95vw]"
        >
            <DialogHeader
                title={t('resources.recovery.title')}
                onClose={() => void close()}
                closeDisabled={busy}
            />
            <div className="p-5 flex flex-col gap-3 overflow-y-auto text-sm">
                <p className="text-text-muted">{t('resources.recovery.description')}</p>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                        void api.openDataFolder().catch((failure) => setError(String(failure)))
                    }}
                >
                    {t('resources.recovery.openCopies')}
                </Button>
                <p className="text-xs text-text-muted">{t('resources.recovery.copiesLocation')}</p>
                <Select
                    value={selected}
                    onChange={(value) => {
                        setSelected(value)
                        setReview(null)
                    }}
                    disabled={busy || !!review}
                    placeholder={t('resources.recovery.choose')}
                    options={[
                        { value: 'pending', label: t('resources.recovery.pending') },
                        ...resources.map((mod) => ({ value: mod.uid, label: mod.name })),
                    ]}
                />
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || !selected}
                    onClick={() => void prepare()}
                >
                    {t('resources.recovery.review')}
                </Button>
                {review && (
                    <>
                        <p>{t('resources.recovery.affected')}</p>
                        <ul className="list-disc pl-5">
                            {review.deployments.map((name, index) => (
                                <li key={index}>{name}</li>
                            ))}
                        </ul>
                        {review.files.map((file) => (
                            <div
                                key={file.path}
                                className="border border-border rounded-lg p-3 text-xs"
                            >
                                <p className="font-mono break-all">{file.path}</p>
                                <p className="text-text-muted break-all">
                                    {file.current.state === 'absent'
                                        ? t('resources.recovery.absent')
                                        : t('resources.recovery.present', {
                                              hash: file.current.sha256,
                                              size: file.current.size,
                                          })}
                                </p>
                            </div>
                        ))}
                        <p className="text-text-muted">{t('resources.recovery.keepDescription')}</p>
                        <Button disabled={busy} onClick={() => void keepCurrent()}>
                            {t('resources.recovery.keep')}
                        </Button>
                    </>
                )}
                {error && (
                    <p role="alert" className="text-danger-text text-xs whitespace-pre-wrap">
                        {error}
                    </p>
                )}
            </div>
        </Dialog>
    )
}
