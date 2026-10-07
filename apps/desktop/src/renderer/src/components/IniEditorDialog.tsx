import { useState, useEffect, useSyncExternalStore } from 'react'
import { FilePenLine } from 'lucide-react'
import { api, type IniEditorSession } from '../api'
import { discardIniDraft, iniDraftRevision, readIniDraft, writeIniDraft } from '../iniDrafts'
import { t } from '../i18n'
import { Dialog, DialogHeader } from './Dialog'
import { Button } from './ui/Button'
import { ResourceRecognition } from './ResourceRecognition'
import type { ResourceRecognition as Recognition } from '../api'
import { refreshInstalled } from '../gameData'
import { finishIniEditor, getIniEditor, subscribeIniEditor } from '../iniEditor'

export function EngineIniEditor() {
    const editor = useSyncExternalStore(subscribeIniEditor, getIniEditor)
    return editor ? (
        <IniEditorDialog
            key={editor.session.sessionHandle}
            session={editor.session}
            reference={editor.reference}
            onClose={() => finishIniEditor(editor.session.sessionHandle)}
        />
    ) : null
}

export function IniEditorDialog({
    session: initialSession,
    onClose,
    reference,
}: {
    session: IniEditorSession
    onClose: () => void
    reference?: { name: string; text: string }
}) {
    const [session, setSession] = useState(initialSession)
    const [draft] = useState(() => {
        try {
            return { value: readIniDraft(initialSession), error: null }
        } catch (error) {
            return { value: null, error: String(error) }
        }
    })
    const [text, setText] = useState(draft.value?.text ?? session.text)
    const [reviewed, setReviewed] = useState(
        !draft.value || draft.value.sha256 === iniDraftRevision(session)
    )
    const [releasePreset, setReleasePreset] = useState(false)
    const [draftRevision, setDraftRevision] = useState(
        draft.value?.sha256 ?? iniDraftRevision(session)
    )
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(draft.error)
    const [draftStored, setDraftStored] = useState(true)
    const [recognition, setRecognition] = useState<Recognition | null>(null)
    const dirty = text !== session.text

    useEffect(() => {
        let cancelled = false
        let unlisten: (() => void) | undefined
        api.guardWindowClose(() => {
            if (busy) return true
            if (!dirty || draftStored) return false
            setError(t('resources.editor.retainFailed'))
            return true
        }).then(
            (stop) => {
                if (cancelled) stop()
                else unlisten = stop
            },
            (failure) => {
                if (!cancelled) setError(String(failure))
            }
        )
        return () => {
            cancelled = true
            unlisten?.()
        }
    }, [busy, dirty, draftStored])

    useEffect(() => {
        let cancelled = false
        if (!session.exists) return
        api.recognizeResourceHash(session.gameId, session.sha256, 'config').then(
            (result) => {
                if (!cancelled) setRecognition(result)
            },
            (failure) => {
                if (!cancelled) setError(String(failure))
            }
        )
        return () => {
            cancelled = true
        }
    }, [session])

    function changeText(value: string) {
        setText(value)
        try {
            writeIniDraft(session, {
                sha256: draftRevision,
                text: value,
            })
            setDraftStored(true)
            setError(null)
        } catch (failure) {
            setDraftStored(false)
            setError(String(failure))
        }
    }

    async function close(discard: boolean) {
        if (busy || (!discard && dirty && !draftStored)) return
        setBusy(true)
        try {
            await api.closeEngineIni(session.sessionHandle)
            if (discard) discardIniDraft(session)
            onClose()
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    async function save() {
        setBusy(true)
        setError(null)
        try {
            const saved = await api.saveEngineIni(session.sessionHandle, text, releasePreset)
            setSession(saved)
            setText(saved.text)
            discardIniDraft(session)
            setDraftRevision(iniDraftRevision(saved))
            setReviewed(true)
            setReleasePreset(false)
            await refreshInstalled(saved.gameId)
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog
            open
            onOpenChange={(open) => !open && void close(false)}
            title={t('resources.editor.title')}
            className="w-[calc(100%-2rem)] max-w-3xl"
            size="panel"
        >
            <DialogHeader
                title={t('resources.editor.title')}
                subtitle={session.path}
                icon={<FilePenLine className="w-4 h-4" />}
                onClose={() => void close(false)}
                closeDisabled={busy || (dirty && !draftStored)}
            />
            <div className="p-5 flex flex-col gap-3 min-h-0 flex-1 overflow-y-auto">
                <p className="text-xs text-text-muted">{t('resources.editor.description')}</p>
                {!session.exists && (
                    <p className="text-xs text-text-muted">{t('resources.editor.newFile')}</p>
                )}
                {reference && (
                    <details className="text-xs">
                        <summary className="cursor-pointer">{reference.name}</summary>
                        <p className="py-2 text-text-muted">
                            {t('resources.editor.referenceDescription')}
                        </p>
                        <textarea
                            readOnly
                            aria-label={t('resources.editor.reference')}
                            value={reference.text}
                            className="w-full h-40 p-3 font-mono bg-surface border border-border rounded-lg"
                        />
                    </details>
                )}
                {recognition && (
                    <p className="text-xs">
                        <ResourceRecognition recognition={recognition} />
                    </p>
                )}
                {session.readOnly && (
                    <p className="text-xs text-warning">
                        {session.readOnlyReason ?? t('resources.editor.readOnly')}
                    </p>
                )}
                {!reviewed && (
                    <div className="text-xs flex flex-col gap-2 text-warning">
                        <p>{t('resources.editor.changedDraft')}</p>
                        <details>
                            <summary className="cursor-pointer">
                                {t('resources.editor.currentFile')}
                            </summary>
                            <pre className="font-mono whitespace-pre-wrap max-h-40 overflow-auto p-3 bg-surface text-text">
                                {session.text}
                            </pre>
                        </details>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                                try {
                                    writeIniDraft(session, {
                                        sha256: iniDraftRevision(session),
                                        text,
                                    })
                                    setDraftRevision(iniDraftRevision(session))
                                    setReviewed(true)
                                    setDraftStored(true)
                                } catch (failure) {
                                    setError(String(failure))
                                    setDraftStored(false)
                                }
                            }}
                        >
                            {t('resources.editor.useDraft')}
                        </Button>
                    </div>
                )}
                {error && (
                    <p role="alert" className="text-xs text-danger-text">
                        {error}
                    </p>
                )}
                <textarea
                    aria-label={t('resources.editor.title')}
                    value={text}
                    onChange={(event) => changeText(event.target.value)}
                    readOnly={session.readOnly || busy || draft.error !== null}
                    spellCheck={false}
                    className="font-mono text-xs leading-5 flex-1 min-h-40 resize-none rounded-lg bg-surface border border-border p-3 text-text focus:outline-none focus:border-accent"
                />
                <label className="flex items-start gap-2 text-xs text-text-muted">
                    <input
                        type="checkbox"
                        checked={releasePreset}
                        disabled={session.readOnly || busy}
                        onChange={(event) => setReleasePreset(event.target.checked)}
                        className="accent-accent mt-0.5"
                    />
                    {t('resources.editor.releasePreset')}
                </label>
                <p className="text-xs text-text-subtle">{t('resources.editor.draftKept')}</p>
            </div>
            <div className="p-4 border-t border-border flex justify-between gap-2 shrink-0">
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void close(true)}>
                    {t('resources.editor.discard')}
                </Button>
                <div className="flex gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || (dirty && !draftStored)}
                        onClick={() => void close(false)}
                    >
                        {t('common.close')}
                    </Button>
                    <Button
                        variant="accent"
                        size="sm"
                        disabled={busy || session.readOnly || !reviewed || draft.error !== null}
                        onClick={() => void save()}
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </div>
        </Dialog>
    )
}
