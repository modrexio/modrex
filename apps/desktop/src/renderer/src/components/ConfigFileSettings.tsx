import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, Loader } from 'lucide-react'
import type { ConfigFileLocation } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import { displayPath } from '../lib/displayPath'
import { SettingsSection } from './SettingsSection'
import { Button } from './ui/Button'

type Messages = Record<
    | 'title'
    | 'description'
    | 'open'
    | 'chooseFile'
    | 'checking'
    | 'found'
    | 'missing'
    | 'missingHint'
    | 'needsLocation'
    | 'checkFailed',
    string
>

export function ConfigFileSettings({
    activeGame,
    gamePath,
    onOpenGameSettings,
    getLocation,
    pickFile,
    openFile,
    messages,
}: {
    activeGame: GameId
    gamePath: string | null | undefined
    onOpenGameSettings: () => void
    getLocation: (gameId: string) => Promise<ConfigFileLocation>
    pickFile: (gameId: string, title: string) => Promise<string | null>
    openFile: (gameId: string) => Promise<null>
    messages: Messages
}) {
    const [location, setLocation] = useState<ConfigFileLocation | null>(null)
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const request = useRef(0)

    const checkLocation = useCallback(async () => {
        const current = ++request.current
        setBusy(true)
        setLocation(null)
        setError(null)
        try {
            const result = await getLocation(activeGame)
            if (current === request.current) setLocation(result)
        } catch (failure) {
            if (current === request.current) setError(String(failure))
        } finally {
            if (current === request.current) setBusy(false)
        }
    }, [activeGame, getLocation])

    useEffect(() => {
        if (gamePath != null) void checkLocation()
        return () => {
            request.current += 1
        }
    }, [checkLocation, gamePath])

    async function open(pick: boolean) {
        const current = ++request.current
        setBusy(true)
        setError(null)
        try {
            if (pick) {
                const path = await pickFile(activeGame, messages.chooseFile)
                if (!path) return
                if (current !== request.current) return
                setLocation(null)
            }
            if (current !== request.current) return
            const result = await getLocation(activeGame)
            if (current !== request.current) return
            setLocation(result)
            if (result.status !== 'found') return
            await openFile(activeGame)
        } catch (failure) {
            if (current === request.current) setError(String(failure))
        } finally {
            if (current === request.current) setBusy(false)
        }
    }

    const focusRing = 'focus-visible:ring-2 focus-visible:ring-accent/60'
    const status =
        gamePath === undefined
            ? 'checkingGameFolder'
            : gamePath === null
              ? 'noGameFolder'
              : (location?.status ?? (error ? 'checkFailed' : 'checking'))
    const statusText =
        status === 'checkingGameFolder' || status === 'noGameFolder'
            ? t(`resources.config.${status}`)
            : messages[status]
    const checking = status === 'checking' || status === 'checkingGameFolder'
    const path =
        gamePath != null && location && location.status !== 'needsLocation'
            ? displayPath(location.path)
            : t('resources.config.locationNotSet')

    return (
        <SettingsSection title={messages.title} description={messages.description}>
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-surface-hover border border-border mt-1">
                {checking ? (
                    <span
                        role="status"
                        className="text-sm flex-1 min-w-0 text-text-muted flex items-center gap-2"
                    >
                        <Loader aria-hidden="true" className="w-3.5 h-3.5 animate-spin shrink-0" />
                        {statusText}
                    </span>
                ) : (
                    <span className="text-sm font-mono truncate flex-1 min-w-0 text-text-muted">
                        {path}
                    </span>
                )}
                <div className="flex gap-2 shrink-0">
                    {status === 'found' && (
                        <Button
                            variant="accent"
                            size="md"
                            className={focusRing}
                            disabled={busy}
                            onClick={() => void open(false)}
                        >
                            {messages.open}
                        </Button>
                    )}
                    {gamePath != null && (
                        <Button
                            variant={status === 'found' ? 'secondary' : 'accent'}
                            size="md"
                            className={focusRing}
                            disabled={busy}
                            onClick={() => void open(true)}
                        >
                            <FolderOpen aria-hidden="true" className="w-3.5 h-3.5" />
                            {t('resources.config.browse')}
                        </Button>
                    )}
                    {status === 'noGameFolder' && (
                        <Button
                            variant="accent"
                            size="md"
                            className={focusRing}
                            onClick={onOpenGameSettings}
                        >
                            {t('resources.config.openGameSettings')}
                        </Button>
                    )}
                </div>
            </div>
            {!checking && (
                <p
                    role="status"
                    className={`text-xs ${status === 'found' ? 'text-success-text' : status === 'needsLocation' ? 'text-text-subtle' : 'text-danger-text'}`}
                >
                    {statusText}
                </p>
            )}
            {status === 'missing' && (
                <p className="text-xs text-text-subtle">{messages.missingHint}</p>
            )}
            {status === 'noGameFolder' && (
                <p className="text-xs text-text-subtle">{t('resources.config.noGameFolderHint')}</p>
            )}
            {(status === 'missing' || status === 'checkFailed') && (
                <Button
                    variant="secondary"
                    size="sm"
                    className={`self-start ${focusRing}`}
                    disabled={busy}
                    onClick={() => void checkLocation()}
                >
                    {t('resources.config.checkAgain')}
                </Button>
            )}
            {error && (
                <p role="alert" className="text-xs text-danger-text">
                    {error}
                </p>
            )}
        </SettingsSection>
    )
}
