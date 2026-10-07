import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, type ResourceReview } from '../api'
import {
    finishResourceReview,
    getPendingResourceReview,
    resourceSelectionValid,
    resourceConflicts,
    subscribeResourceReview,
} from '../resourceInstall'
import { t, useLocale } from '../i18n'
import { Dialog, DialogHeader } from './Dialog'
import { Button } from './ui/Button'
import { Select } from './Select'
import { ZipPickerModal, type ZipMultiPakPayload } from './ZipPickerModal'
import { refreshInstalled } from '../gameData'
import type { InstalledMod } from '../../../shared/types'
import { showIniEditor } from '../iniEditor'

function Review({ handle }: { handle: string }) {
    const [review, setReview] = useState<ResourceReview | null>(null)
    const [selection, setSelection] = useState<Record<string, string | null>>({})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [pakChoice, setPakChoice] = useState<InstalledMod[] | null>(null)
    const [pakApplied, setPakApplied] = useState(false)
    const [completion, setCompletion] = useState<Awaited<
        ReturnType<typeof api.installReviewedResources>
    > | null>(null)
    const conflicts = review ? resourceConflicts(review, selection) : null

    useEffect(() => {
        let cancelled = false
        api.getResourceReview(handle).then(
            (value) => {
                if (!cancelled) setReview(value)
            },
            (failure) => {
                if (!cancelled) setError(String(failure))
            }
        )
        return () => {
            cancelled = true
        }
    }, [handle])

    function toggle(entry: ResourceReview['entries'][number], checked: boolean) {
        setSelection((current) => {
            const next = { ...current }
            if (!checked) {
                delete next[entry.entryId]
                return next
            }
            if (entry.kind === 'ini') {
                for (const other of review!.entries) {
                    if (other.kind === 'ini') delete next[other.entryId]
                }
            }
            next[entry.entryId] = null
            return next
        })
    }

    async function cancel() {
        if (busy) return
        if (completion) {
            finishResourceReview(handle, pakApplied || completion.installed)
            return
        }
        setBusy(true)
        try {
            await api.cancelResourceReview(handle)
            finishResourceReview(handle, pakApplied || !!review?.moviePackApplied)
        } catch (failure) {
            setError(String(failure))
            setBusy(false)
        }
    }

    async function chooseConfig(folder = false) {
        setBusy(true)
        setError(null)
        try {
            const session = await api.pickEngineIni(
                review!.gameId,
                t(folder ? 'resources.editor.chooseFolder' : 'resources.editor.chooseFile'),
                folder
            )
            if (!session) return
            await api.closeEngineIni(session.sessionHandle)
            setReview(await api.getResourceReview(handle))
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    async function reviewIni(entry: ResourceReview['entries'][number]) {
        setBusy(true)
        setError(null)
        try {
            const text = await api.readResourceIni(handle, entry.entryId)
            const session = await api.openEngineIni(review!.gameId)
            try {
                showIniEditor(session, { name: entry.name, text }, () => void closeEditor())
            } catch (failure) {
                await api.closeEngineIni(session.sessionHandle)
                throw failure
            }
        } catch (failure) {
            setError(String(failure))
            setBusy(false)
        }
    }

    async function closeEditor() {
        setSelection({})
        try {
            setReview(await api.getResourceReview(handle))
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    async function install() {
        setBusy(true)
        setError(null)
        try {
            const result = await api.installReviewedResources(
                handle,
                Object.entries(selection).map(([entryId, slot]) => ({
                    entryId: Number(entryId),
                    slot,
                }))
            )
            if (result.alreadyCurrentMovies.length > 0) {
                setCompletion(result)
                setBusy(false)
                return
            }
            finishResourceReview(handle, pakApplied || result.installed)
        } catch (failure) {
            setError(String(failure))
            setBusy(false)
            try {
                const current = await api.getResourceReview(handle)
                setReview(current)
                if (current.moviePackApplied)
                    setSelection((previous) =>
                        Object.fromEntries(
                            Object.entries(previous).filter(([id]) =>
                                current.entries.some(
                                    (entry) => String(entry.entryId) === id && entry.kind === 'ini'
                                )
                            )
                        )
                    )
            } catch (reviewFailure) {
                setError(`${String(failure)}\n${String(reviewFailure)}`)
            }
        }
    }

    // A Nexus review's packages carry Nexus identity, so only Nexus records can match them.
    function pakCandidates(mods: InstalledMod[]) {
        const nexus = review?.source === 'nexus'
        return mods.filter((mod) => !mod.deployment && (!nexus || mod.source === 'nexus'))
    }

    async function choosePaks() {
        setBusy(true)
        setError(null)
        try {
            const installed = await api.getInstalled(review!.gameId)
            setPakChoice(pakCandidates(installed.mods))
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    if (completion) {
        return (
            <Dialog
                open
                onOpenChange={(open) => !open && void cancel()}
                title={t('resources.install.title')}
                className="w-[calc(100%-2rem)] max-w-xl"
            >
                <DialogHeader title={t('resources.install.title')} onClose={() => void cancel()} />
                <div className="p-5 flex flex-col gap-3 text-sm">
                    <p role="status">{t('resources.install.alreadyCurrent')}</p>
                    <ul className="list-disc pl-5 text-xs text-text-muted break-all">
                        {completion.alreadyCurrentMovies.map((path) => (
                            <li key={path}>{path}</li>
                        ))}
                    </ul>
                    <Button variant="accent" onClick={() => void cancel()}>
                        {t('common.close')}
                    </Button>
                </div>
            </Dialog>
        )
    }

    if (pakChoice && review?.pakPicker) {
        // A Nexus review's own command takes the target and identity from the review, so the
        // picker's location tag is not forwarded to it.
        const picker: ZipMultiPakPayload = {
            ...(review.pakPicker as ZipMultiPakPayload),
            source: review.source === 'nexus' ? 'nexus' : 'modworkshop',
        }
        return (
            <ZipPickerModal
                payload={picker}
                gamePath={review.gamePath}
                installedFiles={pakChoice}
                gameId={review.gameId}
                onRefreshInstalled={async () => {
                    await refreshInstalled(review.gameId)
                    setPakChoice(pakCandidates((await api.getInstalled(review.gameId)).mods))
                }}
                onInstalled={() => setPakApplied(true)}
                onClose={() => setPakChoice(null)}
                installEntry={
                    review.source === 'nexus'
                        ? (pos, folderId) =>
                              api.installNexusReviewPak(handle, picker.entryIds[pos], folderId)
                        : undefined
                }
            />
        )
    }

    return (
        <Dialog
            open
            onOpenChange={(open) => !open && void cancel()}
            title={t('resources.install.title')}
            className="w-[calc(100%-2rem)] max-w-xl"
            size="list"
        >
            <DialogHeader
                title={t('resources.install.title')}
                subtitle={review?.gamePath}
                onClose={() => void cancel()}
                closeDisabled={busy}
            />
            <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
                <p className="text-xs text-text-muted">{t('resources.install.description')}</p>
                <p className="text-xs text-warning">{t('resources.install.previousSetup')}</p>
                {conflicts?.movies.map((pack) => (
                    <p key={pack.name} className="text-xs text-warning">
                        {t('resources.install.movieConflict', {
                            name: pack.name,
                            slots:
                                pack.restoredSlots.join(', ') ||
                                t('resources.install.noOtherSlots'),
                        })}
                    </p>
                ))}
                {conflicts?.presets.map((preset) => (
                    <p key={preset.name} className="text-xs text-warning">
                        {t('resources.install.iniConflict', {
                            name: preset.name,
                            keys:
                                preset.restoredKeys
                                    .map(
                                        (change) =>
                                            `[${change.section}] ${change.key}=${change.before === null ? t('resources.install.absentKey') : JSON.stringify(change.before)}`
                                    )
                                    .join(', ') || t('resources.install.noOtherSlots'),
                        })}
                    </p>
                ))}
                {review?.moviePackApplied && (
                    <p role="status" className="text-xs text-success-text">
                        {t('resources.install.moviesApplied')}
                    </p>
                )}
                {review?.pakPicker && (
                    <div className="flex flex-col gap-2">
                        <p className="text-xs text-text-muted">
                            {t('resources.install.mixedComponents')}
                        </p>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy || pakApplied}
                            onClick={() => void choosePaks()}
                        >
                            {pakApplied
                                ? t('resources.install.packagesApplied')
                                : t('resources.install.choosePackages')}
                        </Button>
                    </div>
                )}
                {error && (
                    <p role="alert" className="text-xs text-danger-text">
                        {error}
                    </p>
                )}
                {!review && !error && (
                    <p className="text-sm text-text-muted">{t('common.loading')}</p>
                )}
                {review?.entries.map((entry) => (
                    <div
                        key={entry.entryId}
                        className="flex flex-col gap-2 border border-border rounded-lg p-3"
                    >
                        <label className="flex items-start gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={entry.entryId in selection}
                                disabled={
                                    !entry.supported ||
                                    busy ||
                                    (entry.kind === 'movie' && review.moviePackApplied)
                                }
                                onChange={(event) => toggle(entry, event.target.checked)}
                                className="accent-accent mt-1"
                            />
                            <span className="min-w-0 break-all font-mono">{entry.name}</span>
                        </label>
                        {entry.reason && <p className="text-xs text-warning">{entry.reason}</p>}
                        {entry.entryId in selection &&
                            entry.changes.map((change) => (
                                <p
                                    key={`${change.section}\n${change.key}`}
                                    className="text-xs text-text-muted font-mono break-all"
                                >
                                    {t('resources.install.keyChange', {
                                        section: change.section,
                                        key: change.key,
                                        before:
                                            change.before === null
                                                ? t('resources.install.absentKey')
                                                : JSON.stringify(change.before),
                                        after: JSON.stringify(change.applied),
                                    })}
                                </p>
                            ))}
                        {entry.kind === 'ini' &&
                            entry.name.split(/[\\/]/).at(-1)?.toLowerCase() === 'engine.ini' && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={busy || !review.configPath}
                                    onClick={() => void reviewIni(entry)}
                                >
                                    {t('resources.editor.reviewPreset')}
                                </Button>
                            )}
                        {entry.kind === 'movie' && entry.entryId in selection && (
                            <Select
                                value={selection[entry.entryId] ?? ''}
                                onChange={(slot) =>
                                    setSelection((current) => ({
                                        ...current,
                                        [entry.entryId]: slot || null,
                                    }))
                                }
                                options={[
                                    { value: '', label: t('resources.install.chooseSlot') },
                                    ...review.movieSlots.map((slot) => ({
                                        value: slot,
                                        label: slot,
                                    })),
                                ]}
                                disabled={busy}
                            />
                        )}
                    </div>
                ))}
                {review?.entries.some((entry) => entry.kind === 'ini') && (
                    <div className="flex flex-col gap-2">
                        <p className="text-xs text-text-muted">
                            {t('resources.install.configTarget')}
                        </p>
                        <p className="text-xs font-mono break-all">
                            {review.configPath ?? t('resources.install.configUnavailable')}
                        </p>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => void chooseConfig()}
                        >
                            {t('resources.editor.chooseFile')}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => void chooseConfig(true)}
                        >
                            {t('resources.editor.chooseFolder')}
                        </Button>
                        <p className="text-xs text-text-subtle">
                            {t('resources.install.singleVariant')}
                        </p>
                    </div>
                )}
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border shrink-0">
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void cancel()}>
                    {pakApplied || review?.moviePackApplied
                        ? t('resources.install.finish')
                        : t('common.cancel')}
                </Button>
                <Button
                    variant="accent"
                    size="sm"
                    disabled={
                        busy ||
                        !review ||
                        !resourceSelectionValid(review, selection) ||
                        (review.entries.some(
                            (entry) => entry.kind === 'ini' && entry.entryId in selection
                        ) &&
                            !review.configPath)
                    }
                    onClick={() => void install()}
                >
                    {t('resources.install.apply')}
                </Button>
            </div>
        </Dialog>
    )
}

export function ResourceInstallDialog() {
    useLocale()
    const handle = useSyncExternalStore(subscribeResourceReview, getPendingResourceReview)
    return handle ? <Review key={handle} handle={handle} /> : null
}
