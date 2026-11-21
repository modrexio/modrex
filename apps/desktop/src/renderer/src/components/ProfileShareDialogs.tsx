import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import {
    api,
    type PendingShareMember,
    type PreviewFile,
    type ProfileImportResult,
    type ProfileSharePreview,
    type ProfileSummary,
} from '../api'
import { GAMES, isGameId } from '../../../shared/types'
import type { Profiles } from '../hooks/useProfiles'
import { t } from '../i18n'
import { Dialog, DialogHeader } from './Dialog'
import { hasSource, SOURCE_LABELS } from '../sources'
import { formatBytes } from './modDetail/format'
import { Select } from './Select'
import { Tooltip } from './Tooltip'
import { Button } from './ui/Button'

type PreviewRow = ProfileSharePreview['rows'][number]

const errorBox =
    'px-4 py-3 rounded-lg bg-danger/30 border border-danger-hover text-sm text-danger-text'
// Styled as the launch options field in GameSettings.tsx.
const fieldClass =
    'w-full text-sm px-3 py-2 rounded-lg bg-surface-hover border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-accent disabled:opacity-50'

interface ShareProps {
    gameId: string
    gamePath: string
    profile: ProfileSummary
    onClose: () => void
}

export function ShareProfileDialog({ gameId, gamePath, profile, onClose }: ShareProps) {
    const [code, setCode] = useState<string | null>(null)
    const [leftOut, setLeftOut] = useState(0)
    const [error, setError] = useState<string | null>(null)
    const [done, setDone] = useState<'copied' | 'saved' | null>(null)
    const title = t('installed.profiles.share.title', { name: profile.name })

    useEffect(() => {
        let current = true
        api.exportProfileShare(gameId, gamePath, profile.id).then(
            (share) => {
                if (!current) return
                setCode(share.pasteCode)
                setLeftOut(share.leftOut)
            },
            (e) => {
                if (current) {
                    setError(
                        t('installed.profiles.share.failed', {
                            name: profile.name,
                            error: String(e),
                        })
                    )
                }
            }
        )
        return () => {
            current = false
        }
    }, [gameId, gamePath, profile.id, profile.name])

    async function copy() {
        if (code === null) return
        try {
            await navigator.clipboard.writeText(code)
            setDone('copied')
        } catch (e) {
            setError(String(e))
        }
    }

    async function save() {
        try {
            const saved = await api.saveProfileShareFile(
                gameId,
                gamePath,
                profile.id,
                t('installed.profiles.share.saveTitle')
            )
            if (saved !== null) setDone('saved')
        } catch (e) {
            setError(t('installed.profiles.share.failed', { name: profile.name, error: String(e) }))
        }
    }

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()} title={title} className="w-[460px]">
            <DialogHeader
                title={title}
                subtitle={t('installed.profiles.share.subtitle')}
                onClose={onClose}
                wrapSubtitle
            />
            <div className="px-5 py-4 flex flex-col gap-3">
                {error && <div className={errorBox}>{error}</div>}
                {/* The code itself, so what gets copied is never hidden. */}
                <textarea
                    readOnly
                    value={code ?? ''}
                    rows={4}
                    spellCheck={false}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label={t('installed.profiles.import.code')}
                    className={`${fieldClass} font-mono resize-none`}
                />
                {leftOut > 0 && (
                    <p className="text-sm text-text-muted">
                        {t(
                            leftOut === 1
                                ? 'installed.profiles.share.leftOutSingle'
                                : 'installed.profiles.share.leftOut',
                            { count: leftOut }
                        )}
                    </p>
                )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                <Button
                    variant="secondary"
                    size="md"
                    disabled={code === null}
                    onClick={() => void save()}
                >
                    {done === 'saved'
                        ? t('installed.profiles.share.saved')
                        : t('installed.profiles.share.save')}
                </Button>
                <Button
                    variant="accent"
                    size="lg"
                    disabled={code === null}
                    onClick={() => void copy()}
                >
                    {done === 'copied'
                        ? t('installed.profiles.share.copied')
                        : t('installed.profiles.share.copy')}
                </Button>
            </div>
        </Dialog>
    )
}

type ImportStage =
    | { kind: 'input' }
    | { kind: 'checking'; done: number; total: number }
    | { kind: 'preview'; preview: ProfileSharePreview }
    | { kind: 'installing'; preview: ProfileSharePreview; done: number; total: number }
    | { kind: 'done'; preview: ProfileSharePreview; result: ProfileImportResult }

// The order rows are listed in: what needs the user first, then what will download.
const STATUS_ORDER: PreviewRow['resolution']['status'][] = [
    'needsChoice',
    'ready',
    'nexusDownload',
    'nexusSignInRequired',
    'unavailable',
    'lookupFailed',
]

interface ImportProps {
    gameId: string
    gamePath: string
    profiles: Profiles
    onClose: () => void
}

export function ImportProfileDialog({ gameId, gamePath, profiles, onClose }: ImportProps) {
    const [input, setInput] = useState('')
    const [stage, setStage] = useState<ImportStage>({ kind: 'input' })
    const [name, setName] = useState('')
    const [choices, setChoices] = useState<Record<number, number>>({})
    const [includeNexus, setIncludeNexus] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const title = t('installed.profiles.import.title')
    const busy = stage.kind === 'checking' || stage.kind === 'installing'
    // A game whose only source is Nexus has nothing to download without it.
    const hasWorkshop = hasSource(gameId, 'modworkshop')

    useEffect(() => {
        if (stage.kind !== 'checking') return
        return api.onProfileShareProgress(({ done, total }) =>
            setStage((s) => (s.kind === 'checking' ? { kind: 'checking', done, total } : s))
        )
    }, [stage.kind])

    useEffect(() => {
        if (stage.kind !== 'installing') return
        return api.onProfileImportProgress(({ done, total }) =>
            setStage((s) => (s.kind === 'installing' ? { ...s, done, total } : s))
        )
    }, [stage.kind])

    async function openFile() {
        setError(null)
        try {
            const text = await api.openProfileShareFile(t('installed.profiles.import.openTitle'))
            if (text !== null) setInput(text)
        } catch (e) {
            setError(String(e))
        }
    }

    async function check() {
        setError(null)
        const text = input.trim()
        try {
            // Parsed first so a share for another game names that game instead of its id.
            const share = await api.parseProfileShare(text)
            if (share.gameId !== gameId) {
                const game = isGameId(share.gameId) ? GAMES[share.gameId].name : share.gameId
                setError(t('installed.profiles.import.wrongGame', { game }))
                return
            }
            setStage({ kind: 'checking', done: 0, total: share.members.length })
            const preview = await api.previewProfileShare(text, gameId, gamePath)
            setName(preview.profileName)
            setChoices({})
            setStage({ kind: 'preview', preview })
        } catch (e) {
            setError(t('installed.profiles.import.failed', { error: String(e) }))
            setStage({ kind: 'input' })
        }
    }

    async function download(preview: ProfileSharePreview) {
        setError(null)
        setStage({ kind: 'installing', preview, done: 0, total: preview.rows.length })
        try {
            const result = await api.importProfileShare(
                input.trim(),
                gameId,
                gamePath,
                name.trim(),
                choices
            )
            await profiles.refresh()
            setStage({ kind: 'done', preview, result })
        } catch (e) {
            setError(t('installed.profiles.import.failed', { error: String(e) }))
            setStage({ kind: 'preview', preview })
        }
    }

    return (
        <Dialog
            open
            onOpenChange={(o) => !o && !busy && onClose()}
            title={title}
            className="w-[520px]"
            size={stage.kind === 'preview' ? 'list' : 'auto'}
        >
            <DialogHeader
                title={
                    stage.kind === 'done'
                        ? t('installed.profiles.import.doneTitle', { name })
                        : title
                }
                subtitle={
                    stage.kind === 'input' ? t('installed.profiles.import.subtitle') : undefined
                }
                onClose={onClose}
                closeDisabled={busy}
                wrapSubtitle
            />
            <div className="px-5 py-4 flex flex-col gap-3 min-h-0 overflow-y-auto">
                {error && <div className={errorBox}>{error}</div>}
                {(stage.kind === 'input' || stage.kind === 'checking') && (
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        disabled={busy}
                        rows={5}
                        spellCheck={false}
                        aria-label={t('installed.profiles.import.code')}
                        placeholder={t('installed.profiles.import.code')}
                        className={`${fieldClass} font-mono resize-none`}
                    />
                )}
                {stage.kind === 'checking' && (
                    <p className="text-sm text-text-muted">
                        {t('installed.profiles.import.checking', {
                            done: stage.done,
                            total: stage.total,
                        })}
                    </p>
                )}
                {stage.kind === 'preview' && (
                    <PreviewBody
                        preview={stage.preview}
                        name={name}
                        onName={setName}
                        choices={choices}
                        onChoose={(key, file) => setChoices({ ...choices, [key]: file })}
                        includeNexus={includeNexus}
                        onIncludeNexus={setIncludeNexus}
                        showNexusChoice={hasWorkshop}
                    />
                )}
                {stage.kind === 'installing' && (
                    <p className="text-sm text-text-muted">
                        {t('installed.profiles.import.installing', {
                            done: stage.done,
                            total: stage.total,
                        })}
                    </p>
                )}
                {stage.kind === 'done' && (
                    <DoneBody
                        gameId={gameId}
                        result={stage.result}
                        pending={profiles.list?.pending ?? []}
                        walkNexus={includeNexus || !hasWorkshop}
                    />
                )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                {stage.kind === 'input' || stage.kind === 'checking' ? (
                    <>
                        <Button
                            variant="secondary"
                            size="md"
                            disabled={busy}
                            onClick={() => void openFile()}
                        >
                            {t('installed.profiles.import.openFile')}
                        </Button>
                        <Button
                            variant="accent"
                            size="lg"
                            disabled={busy || !input.trim()}
                            onClick={() => void check()}
                        >
                            {t('installed.profiles.import.check')}
                        </Button>
                    </>
                ) : stage.kind === 'done' ? (
                    <Button variant="accent" size="lg" onClick={onClose}>
                        {t('installed.profiles.import.done')}
                    </Button>
                ) : (
                    <>
                        <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            variant="accent"
                            size="lg"
                            disabled={busy || !name.trim()}
                            onClick={() => void download(stage.preview)}
                        >
                            {t('installed.profiles.import.download')}
                        </Button>
                    </>
                )}
            </div>
        </Dialog>
    )
}

interface PreviewBodyProps {
    preview: ProfileSharePreview
    name: string
    onName: (name: string) => void
    choices: Record<number, number>
    onChoose: (memberKey: number, fileId: number) => void
    includeNexus: boolean
    onIncludeNexus: (include: boolean) => void
    showNexusChoice: boolean
}

function PreviewBody({
    preview,
    name,
    onName,
    choices,
    onChoose,
    includeNexus,
    onIncludeNexus,
    showNexusChoice,
}: PreviewBodyProps) {
    const rows = [...preview.rows].sort(
        (a, b) =>
            STATUS_ORDER.indexOf(a.resolution.status) - STATUS_ORDER.indexOf(b.resolution.status)
    )
    const nexusCount = preview.totals.nexusDownloadsNeeded
    const toInstall = preview.loaders.filter((l) => !l.alreadyPresent).map((l) => l.name)
    const present = preview.loaders.filter((l) => l.alreadyPresent).map((l) => l.name)
    return (
        <>
            <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-text-muted">
                    {t('installed.profiles.import.name')}
                </span>
                <input
                    value={name}
                    maxLength={64}
                    onChange={(e) => onName(e.target.value)}
                    className={fieldClass}
                />
            </label>
            <div className="flex flex-col gap-1.5">
                {rows.map((row) => (
                    <PreviewRowItem
                        key={row.memberKey}
                        row={row}
                        choice={choices[row.memberKey]}
                        onChoose={(file) => onChoose(row.memberKey, file)}
                    />
                ))}
            </div>
            {toInstall.length > 0 && (
                <p className="text-sm text-text-muted">
                    {t('installed.profiles.import.loaders', { names: toInstall.join(', ') })}
                </p>
            )}
            {present.length > 0 && (
                <p className="text-sm text-text-muted">
                    {t('installed.profiles.import.loadersPresent', { names: present.join(', ') })}
                </p>
            )}
            {preview.totals.knownDownloadBytes > 0 && (
                <p className="text-sm text-text-muted">
                    {t('installed.profiles.import.size', {
                        size: formatBytes(preview.totals.knownDownloadBytes),
                    })}
                </p>
            )}
            {showNexusChoice && nexusCount > 0 && (
                <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={includeNexus}
                        onChange={(e) => onIncludeNexus(e.target.checked)}
                    />
                    <span className="text-sm text-text-muted">
                        {t(
                            nexusCount === 1
                                ? 'installed.profiles.import.includeNexusSingle'
                                : 'installed.profiles.import.includeNexus',
                            { count: nexusCount }
                        )}
                    </span>
                </label>
            )}
        </>
    )
}

function statusLabel(row: PreviewRow): string {
    switch (row.resolution.status) {
        case 'ready':
            return row.resolution.foundByName
                ? t('installed.profiles.import.foundByName')
                : t('installed.profiles.import.ready')
        case 'nexusDownload':
            return t('installed.profiles.import.nexus')
        case 'needsChoice':
            return t('installed.profiles.import.needsChoice')
        case 'nexusSignInRequired':
            return t('installed.profiles.import.signIn')
        case 'unavailable':
        case 'lookupFailed':
            return row.resolution.reason
    }
}

function PreviewRowItem({
    row,
    choice,
    onChoose,
}: {
    row: PreviewRow
    choice: number | undefined
    onChoose: (fileId: number) => void
}) {
    const { resolution } = row
    const muted = resolution.status !== 'ready' && resolution.status !== 'nexusDownload'
    const versions =
        row.sharedVersion && row.installVersion && row.sharedVersion !== row.installVersion
            ? t('installed.profiles.import.versions', {
                  shared: row.sharedVersion,
                  installs: row.installVersion,
              })
            : null
    return (
        <div className="flex flex-col gap-1.5 px-3 py-2 rounded-lg bg-surface-hover text-sm">
            <div className="flex items-center gap-2 min-w-0">
                <span className={`flex-1 min-w-0 truncate ${muted ? 'text-text-muted' : ''}`}>
                    {row.installedName}
                </span>
                <span className="shrink-0 text-xs text-text-subtle">
                    {SOURCE_LABELS[row.source]}
                </span>
            </div>
            <span className="text-xs text-text-subtle">
                {statusLabel(row)}
                {versions && ` · ${versions}`}
            </span>
            {resolution.status === 'needsChoice' && (
                <Select
                    value={choice === undefined ? '' : String(choice)}
                    onChange={(value) => onChoose(Number(value))}
                    placeholder={t('installed.profiles.import.choose')}
                    ariaLabel={t('installed.profiles.import.choose')}
                    options={resolution.candidates.map((file) => ({
                        value: String(file.id),
                        label: file.version ? `${file.name} ${file.version}` : file.name,
                    }))}
                />
            )}
        </div>
    )
}

function DoneBody({
    gameId,
    result,
    pending,
    walkNexus,
}: {
    gameId: string
    result: ProfileImportResult
    pending: PendingShareMember[]
    walkNexus: boolean
}) {
    const total = result.members.length
    const installed = result.members.filter((m) => m.outcome.status === 'installed').length
    const loaderNotes = Object.entries(result.loaders).flatMap(([name, outcome]) => {
        if (outcome.status === 'viaModFlow') {
            return [t('installed.profiles.import.loaderViaMod', { name })]
        }
        if (outcome.status === 'failed') {
            return [t('installed.profiles.import.loaderFailed', { name, error: outcome.error })]
        }
        return []
    })
    return (
        <>
            <p className="text-sm text-text-muted">
                {installed === total
                    ? t('installed.profiles.import.allInstalled', { total })
                    : t('installed.profiles.import.summary', { installed, total })}
            </p>
            {result.newerVersions > 0 && (
                <p className="text-sm text-text-muted">
                    {t(
                        result.newerVersions === 1
                            ? 'installed.profiles.import.newerSingle'
                            : 'installed.profiles.import.newer',
                        { count: result.newerVersions }
                    )}
                </p>
            )}
            {loaderNotes.map((note) => (
                <p key={note} className="text-sm text-warning">
                    {note}
                </p>
            ))}
            {walkNexus && <NexusQueue gameId={gameId} pending={pending} />}
        </>
    )
}

/**
 * Opens the pending Nexus downloads one at a time. Each opens its file's Mod Manager Download
 * on nexusmods.com, and the next opens once the profile stops waiting for the current one.
 */
function NexusQueue({ gameId, pending }: { gameId: string; pending: PendingShareMember[] }) {
    const queue = pending.filter((p) => p.source === 'nexus' && p.fileId !== null)
    const [stopped, setStopped] = useState(false)
    const [opened, setOpened] = useState<number | null>(null)
    const [error, setError] = useState<string | null>(null)
    const current = queue[0]

    useEffect(() => {
        if (stopped || !current || opened === current.memberKey) return
        setOpened(current.memberKey)
        api.requestNexusDownload(gameId, current.modId, current.url, current.fileId!).catch((e) => {
            setError(String(e))
            setStopped(true)
        })
    }, [stopped, current, opened, gameId])

    if (error) return <div className={errorBox}>{error}</div>
    if (stopped || !current) return null
    return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-hover text-sm">
            <span className="flex-1 min-w-0 text-text-muted">
                {t('installed.profiles.import.nexusWaiting', { name: current.installedName })}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setStopped(true)}>
                {t('installed.profiles.import.nexusStop')}
            </Button>
        </div>
    )
}

interface PendingProps {
    gameId: string
    gamePath: string
    profiles: Profiles
    onOpenMod: (modId: number) => void
    onClose: () => void
}

export function PendingSharedDialog({
    gameId,
    gamePath,
    profiles,
    onOpenMod,
    onClose,
}: PendingProps) {
    const pending = profiles.list?.pending ?? []
    const title = t('installed.profiles.pending.title')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<number | null>(null)

    // Runs one entry's action, then reads both lists again, since an install changed them.
    async function run(member: PendingShareMember, action: () => Promise<void>) {
        setError(null)
        setBusy(member.memberKey)
        try {
            await action()
            await profiles.refresh()
        } catch (e) {
            setError(String(e))
        } finally {
            setBusy(null)
        }
    }

    async function install(member: PendingShareMember) {
        const outcome = await api.installPendingShareMember(gameId, gamePath, member.memberKey)
        if (outcome.status === 'failed') throw new Error(outcome.error)
    }

    async function choose(member: PendingShareMember, fileId: number) {
        const chosen = await api.choosePendingShareFile(gameId, gamePath, member.memberKey, fileId)
        if (chosen.source === 'nexus') {
            await api.requestNexusDownload(gameId, chosen.modId, chosen.url, fileId)
            return
        }
        await install(chosen)
    }

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()} title={title} className="w-[460px]">
            <DialogHeader
                title={title}
                subtitle={t('installed.profiles.pending.subtitle')}
                onClose={onClose}
                wrapSubtitle
            />
            <div className="px-5 py-4 flex flex-col gap-1.5 min-h-0 overflow-y-auto">
                {error && <div className={errorBox}>{error}</div>}
                {pending.map((member) => (
                    <div
                        key={member.memberKey}
                        className="flex flex-col gap-1.5 px-3 py-2 rounded-lg bg-surface-hover text-sm"
                    >
                        <div className="flex items-center gap-2">
                            <div className="flex-1 min-w-0 flex flex-col">
                                <span className="truncate">{member.installedName}</span>
                                <span className="text-xs text-text-subtle">{member.reason}</span>
                            </div>
                            <PendingAction
                                member={member}
                                disabled={busy !== null}
                                onNexus={() =>
                                    run(member, () =>
                                        api.requestNexusDownload(
                                            gameId,
                                            member.modId,
                                            member.url,
                                            member.fileId!
                                        )
                                    )
                                }
                                onTryAgain={() => run(member, () => install(member))}
                                onOpenMod={() => {
                                    onClose()
                                    onOpenMod(member.modId)
                                }}
                            />
                            <Tooltip content={t('installed.profiles.pending.dismiss')}>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={busy !== null}
                                    aria-label={t('installed.profiles.pending.dismissLabel', {
                                        name: member.installedName,
                                    })}
                                    onClick={() => void profiles.dismissPending(member.memberKey)}
                                >
                                    <X className="w-3.5 h-3.5" aria-hidden />
                                </Button>
                            </Tooltip>
                        </div>
                        {member.action === 'chooseFile' && (
                            <PendingFileChoice
                                gameId={gameId}
                                gamePath={gamePath}
                                member={member}
                                disabled={busy !== null}
                                onChoose={(fileId) => run(member, () => choose(member, fileId))}
                            />
                        )}
                    </div>
                ))}
            </div>
        </Dialog>
    )
}

function PendingAction({
    member,
    disabled,
    onNexus,
    onTryAgain,
    onOpenMod,
}: {
    member: PendingShareMember
    disabled: boolean
    onNexus: () => Promise<void>
    onTryAgain: () => Promise<void>
    onOpenMod: () => void
}) {
    switch (member.action) {
        case 'nexusDownload':
            return (
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void onNexus()}
                >
                    {t('installed.profiles.pending.openNexus')}
                </Button>
            )
        case 'tryAgain':
            return (
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void onTryAgain()}
                >
                    {t('installed.profiles.pending.tryAgain')}
                </Button>
            )
        case 'openMod':
            return (
                <Button variant="secondary" size="sm" disabled={disabled} onClick={onOpenMod}>
                    {t('installed.profiles.pending.open')}
                </Button>
            )
        case 'chooseFile':
            return null
    }
}

/** The file picker for a waiting mod whose file has to be chosen, as in the import preview. */
function PendingFileChoice({
    gameId,
    gamePath,
    member,
    disabled,
    onChoose,
}: {
    gameId: string
    gamePath: string
    member: PendingShareMember
    disabled: boolean
    onChoose: (fileId: number) => Promise<void>
}) {
    const [files, setFiles] = useState<PreviewFile[] | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let current = true
        api.pendingShareMemberFiles(gameId, gamePath, member.memberKey).then(
            (list) => {
                if (current) setFiles(list)
            },
            (e) => {
                if (current) setError(String(e))
            }
        )
        return () => {
            current = false
        }
    }, [gameId, gamePath, member.memberKey])

    if (error) return <span className="text-xs text-danger-text">{error}</span>
    return (
        <Select
            value=""
            onChange={(value) => void onChoose(Number(value))}
            disabled={disabled || files === null}
            placeholder={
                files === null
                    ? t('installed.profiles.pending.loadingFiles')
                    : t('installed.profiles.import.choose')
            }
            ariaLabel={t('installed.profiles.import.choose')}
            options={(files ?? []).map((file) => ({
                value: String(file.id),
                label: file.version ? `${file.name} ${file.version}` : file.name,
            }))}
        />
    )
}
