import { DisclosureSummary } from './ui/DisclosureSummary'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, type ResourceReview } from '../api'
import {
    finishResourceReview,
    getPendingResourceReview,
    resourceSelectionIssue,
    matchingMovieSlot,
    resourceConflicts,
    subscribeResourceReview,
} from '../resourceInstall'
import { t, useLocale } from '../i18n'
import { Dialog, DialogHeader } from './Dialog'
import { Button } from './ui/Button'
import { Select } from './Select'
import { ZipPickerModal, type ZipMultiPakPayload } from './ZipPickerModal'
import { refreshInstalled } from '../gameData'
import { GAMES, type InstalledMod } from '../../../shared/types'
import { displayPath } from '../lib/displayPath'

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
    const selectionIssue = review ? resourceSelectionIssue(review, selection) : null

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
            const slot = entry.kind === 'movie' ? matchingMovieSlot(review!, entry) : null
            next[entry.entryId] = slot && !Object.values(next).includes(slot) ? slot : null
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
            const path = await api.pickEngineIni(
                review!.gameId,
                t(folder ? 'resources.config.chooseFolder' : 'resources.config.chooseFile'),
                folder
            )
            if (!path) return
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

    function renderEntry(entry: ResourceReview['entries'][number]) {
        const selected = entry.entryId in selection
        return (
            <div
                key={entry.entryId}
                className={`flex flex-col gap-3 border rounded-lg p-3 ${selected ? 'border-accent/50 bg-accent/5' : 'border-border'}`}
            >
                <label className="flex items-start gap-2 text-sm">
                    <input
                        type={entry.kind === 'ini' ? 'radio' : 'checkbox'}
                        name={entry.kind === 'ini' ? 'resource-ini-variant' : undefined}
                        checked={selected}
                        disabled={
                            !entry.supported ||
                            busy ||
                            (entry.kind === 'movie' && review!.moviePackApplied)
                        }
                        onChange={(event) => toggle(entry, event.target.checked)}
                        className="accent-accent mt-1"
                    />
                    <span className="min-w-0 break-all font-mono">{entry.name}</span>
                </label>
                {entry.reason && (
                    <details className="text-xs text-warning">
                        <DisclosureSummary className="cursor-pointer">
                            {t(
                                entry.kind === 'ini' && !review!.configPath
                                    ? 'resources.install.needsConfig'
                                    : 'resources.install.unsupportedFile'
                            )}
                        </DisclosureSummary>
                        <p className="mt-2 whitespace-pre-wrap">{entry.reason}</p>
                    </details>
                )}
                {entry.kind === 'movie' && selected && (
                    <div className="flex flex-col gap-2 text-xs">
                        <span className="text-text-muted">
                            {t('resources.install.movieDestination')}
                        </span>
                        <Select
                            ariaLabel={t('resources.install.movieDestinationFor', {
                                name: entry.name,
                            })}
                            value={selection[entry.entryId] ?? ''}
                            onChange={(slot) =>
                                setSelection((current) => ({
                                    ...current,
                                    [entry.entryId]: slot || null,
                                }))
                            }
                            options={[
                                { value: '', label: t('resources.install.chooseSlot') },
                                ...review!.movieSlots.map((slot) => ({ value: slot, label: slot })),
                            ]}
                            disabled={busy}
                        />
                        <p className="text-text-subtle">{t('resources.install.slotHelp')}</p>
                    </div>
                )}
                {selected && entry.changes.length > 0 && (
                    <div className="flex flex-col gap-1 text-xs">
                        <p className="font-medium">{t('resources.install.settingsChanged')}</p>
                        {entry.changes.map((change) => (
                            <p
                                key={`${change.section}\n${change.key}`}
                                className="text-text-muted font-mono break-all"
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
                    </div>
                )}
                {!entry.supported && review!.configPath && entry.kind === 'ini' && (
                    <p className="text-xs text-text-muted">{t('resources.install.cannotApply')}</p>
                )}
            </div>
        )
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
                            <li key={path}>{displayPath(path)}</li>
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
                title={review?.modName ?? t('resources.install.title')}
                subtitle={review ? GAMES[review.gameId].name : undefined}
                onClose={() => void cancel()}
                closeDisabled={busy}
            />
            <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
                <p className="text-xs text-text-muted">{t('resources.install.description')}</p>
                {conflicts?.movies.map((pack) => (
                    <p key={pack.name} className="text-xs text-warning">
                        {pack.restoredSlots.length > 0
                            ? t('resources.install.movieConflict', {
                                  name: pack.name,
                                  slots: pack.restoredSlots.join(', '),
                              })
                            : t('resources.install.conflictOnly', { name: pack.name })}
                    </p>
                ))}
                {conflicts?.presets.map((preset) => (
                    <p key={preset.name} className="text-xs text-warning">
                        {preset.restoredKeys.length > 0
                            ? t('resources.install.iniConflict', {
                                  name: preset.name,
                                  keys: preset.restoredKeys
                                      .map(
                                          (change) =>
                                              `[${change.section}] ${change.key}=${change.before === null ? t('resources.install.absentKey') : JSON.stringify(change.before)}`
                                      )
                                      .join(', '),
                              })
                            : t('resources.install.conflictOnly', { name: preset.name })}
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
                {review?.entries.some((entry) => entry.kind === 'movie') && (
                    <fieldset className="flex flex-col gap-3">
                        <legend className="text-sm font-semibold mb-2">
                            {t('resources.install.movies')}
                        </legend>
                        <p className="text-xs text-text-muted">
                            {t('resources.install.moviesHelp')}
                        </p>
                        {review.entries.filter((entry) => entry.kind === 'movie').map(renderEntry)}
                    </fieldset>
                )}
                {review?.entries.some((entry) => entry.kind === 'ini') && (
                    <fieldset className="flex flex-col gap-3">
                        <legend className="text-sm font-semibold mb-2">
                            {t('resources.install.presets')}
                        </legend>
                        <p className="text-xs text-text-muted">
                            {t('resources.install.singleVariant')}
                        </p>
                        {!review.configPath ? (
                            <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs">
                                <p className="text-warning mb-3">
                                    {t('resources.install.configUnavailable')}
                                </p>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => void chooseConfig()}
                                >
                                    {t('resources.config.chooseFile')}
                                </Button>
                                <details className="mt-3 text-text-muted">
                                    <DisclosureSummary className="cursor-pointer">
                                        {t('resources.install.useConfigFolder')}
                                    </DisclosureSummary>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="mt-2"
                                        disabled={busy}
                                        onClick={() => void chooseConfig(true)}
                                    >
                                        {t('resources.config.chooseFolder')}
                                    </Button>
                                </details>
                            </div>
                        ) : (
                            <details className="text-xs text-text-muted">
                                <DisclosureSummary className="cursor-pointer">
                                    {t('resources.install.configTarget')}
                                </DisclosureSummary>
                                <p className="font-mono break-all mt-2">
                                    {displayPath(review.configPath)}
                                </p>
                                <div className="flex flex-wrap gap-2 mt-2">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => void chooseConfig()}
                                    >
                                        {t('resources.config.chooseFile')}
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => void chooseConfig(true)}
                                    >
                                        {t('resources.config.chooseFolder')}
                                    </Button>
                                </div>
                            </details>
                        )}
                        <label className="flex items-center gap-2 text-xs text-text-muted">
                            <input
                                type="radio"
                                name="resource-ini-variant"
                                className="accent-accent"
                                disabled={busy}
                                checked={
                                    !review.entries.some(
                                        (entry) =>
                                            entry.kind === 'ini' && entry.entryId in selection
                                    )
                                }
                                onChange={() =>
                                    setSelection((current) =>
                                        Object.fromEntries(
                                            Object.entries(current).filter(
                                                ([id]) =>
                                                    !review.entries.some(
                                                        (entry) =>
                                                            String(entry.entryId) === id &&
                                                            entry.kind === 'ini'
                                                    )
                                            )
                                        )
                                    )
                                }
                            />
                            {t('resources.install.skipPreset')}
                        </label>
                        {review.entries.filter((entry) => entry.kind === 'ini').map(renderEntry)}
                    </fieldset>
                )}
                {review?.entries.some((entry) => entry.kind === 'other') && (
                    <fieldset className="flex flex-col gap-3">
                        <legend className="text-sm font-semibold mb-2">
                            {t('resources.install.otherFiles')}
                        </legend>
                        <p className="text-xs text-text-muted">
                            {t('resources.install.otherFilesHelp')}
                        </p>
                        {review.entries.filter((entry) => entry.kind === 'other').map(renderEntry)}
                    </fieldset>
                )}
            </div>
            <div className="flex flex-col gap-3 p-4 border-t border-border shrink-0">
                <p className="text-xs text-text-muted">{t('resources.install.previousSetup')}</p>
                {selectionIssue && (
                    <p role="status" className="text-xs text-warning">
                        {t(`resources.install.next.${selectionIssue}`)}
                    </p>
                )}
                <div className="flex justify-end gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void cancel()}
                    >
                        {pakApplied || review?.moviePackApplied
                            ? t('resources.install.finish')
                            : t('common.cancel')}
                    </Button>
                    <Button
                        variant="accent"
                        size="sm"
                        disabled={busy || !review || selectionIssue !== null}
                        onClick={() => void install()}
                    >
                        {t('resources.install.apply')}
                    </Button>
                </div>
            </div>
        </Dialog>
    )
}

export function ResourceInstallDialog() {
    useLocale()
    const handle = useSyncExternalStore(subscribeResourceReview, getPendingResourceReview)
    return handle ? <Review key={handle} handle={handle} /> : null
}
