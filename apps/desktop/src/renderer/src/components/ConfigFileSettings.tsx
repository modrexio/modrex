import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, Loader } from 'lucide-react'
import type { ConfigFileLocation } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import { displayPath } from '../lib/displayPath'
import { SettingsSection } from './SettingsSection'
import { Button } from './ui/Button'

export function ConfigFileSettings({
    activeGame,
    isActive,
    gamePath,
    onOpenGameSettings,
    getLocation,
    pickFile,
    openFile,
    filename,
    title,
}: {
    activeGame: GameId
    isActive: boolean
    gamePath: string | null | undefined
    onOpenGameSettings: () => void
    getLocation: (gameId: string) => Promise<ConfigFileLocation>
    pickFile: (gameId: string, title: string) => Promise<string | null>
    openFile: (gameId: string) => Promise<null>
    filename: string
    title: string
}) {
    const [location, setLocation] = useState<ConfigFileLocation | null>(null)
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const request = useRef(0)
    const opening = useRef(false)

    const checkLocation = useCallback(async () => {
        const current = ++request.current
        setBusy(true)
        setError(null)
        try {
            const result = await getLocation(activeGame)
            if (current === request.current) setLocation(result)
        } catch (failure) {
            if (current === request.current) {
                setLocation(null)
                setError(String(failure))
            }
        } finally {
            if (current === request.current) setBusy(false)
        }
    }, [activeGame, getLocation])

    useEffect(() => {
        setLocation(null)
        setError(null)
        setBusy(true)
        opening.current = false
        return () => {
            request.current += 1
        }
    }, [checkLocation, gamePath])

    useEffect(() => {
        if (isActive && gamePath != null && !opening.current) void checkLocation()
    }, [isActive, checkLocation, gamePath])

    async function open(pick: boolean) {
        const current = ++request.current
        opening.current = true
        setBusy(true)
        if (!pick) setError(null)
        try {
            if (pick) {
                const path = await pickFile(
                    activeGame,
                    t('resources.config.chooseFile', { filename })
                )
                if (!path) return
                if (current !== request.current) return
                setError(null)
                setLocation(null)
            }
            if (current !== request.current) return
            const result = await getLocation(activeGame).catch((failure) => {
                if (current === request.current) setLocation(null)
                throw failure
            })
            if (current !== request.current) return
            setLocation(result)
            if (result.status !== 'found') return
            await openFile(activeGame)
        } catch (failure) {
            if (current === request.current) setError(String(failure))
        } finally {
            if (current === request.current) {
                opening.current = false
                setBusy(false)
            }
        }
    }

    const focusRing = 'focus-visible:ring-2 focus-visible:ring-accent/60'
    const status =
        gamePath === undefined
            ? 'checkingGameFolder'
            : gamePath === null
              ? 'noGameFolder'
              : (location?.status ?? (error ? 'checkFailed' : 'checking'))
    const statusText = t(`resources.config.${status}`, { filename })
    const checking = status === 'checking' || status === 'checkingGameFolder'
    const path =
        gamePath != null && location && location.status !== 'needsLocation'
            ? displayPath(location.path)
            : t('resources.config.locationNotSet')

    return (
        <SettingsSection title={title} description={t('resources.config.description')}>
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-surface-hover border border-border mt-1">
                {checking ? (
                    <span className="text-sm flex-1 min-w-0 text-text-muted flex items-center gap-2">
                        <Loader aria-hidden="true" className="w-3.5 h-3.5 animate-spin shrink-0" />
                        <span className="truncate">{statusText}</span>
                    </span>
                ) : (
                    <span className="text-sm font-mono truncate flex-1 min-w-0 text-text-muted">
                        {path}
                    </span>
                )}
                <div className="flex gap-2 shrink-0">
                    {(status === 'found' || status === 'checking') && (
                        <Button
                            variant="accent"
                            size="md"
                            className={`${focusRing} ${status === 'checking' ? 'invisible' : ''}`}
                            aria-hidden={status === 'checking' ? true : undefined}
                            disabled={busy}
                            onClick={() => void open(false)}
                        >
                            {t('resources.config.open')}
                        </Button>
                    )}
                    {gamePath != null && (
                        <Button
                            variant={
                                status === 'found' || status === 'checking' ? 'secondary' : 'accent'
                            }
                            size="md"
                            className={focusRing}
                            disabled={busy}
                            onClick={() => void open(true)}
                        >
                            <FolderOpen aria-hidden="true" className="w-3.5 h-3.5" />
                            {t('settings.gamePath.browse')}
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
            <p
                role="status"
                className={`min-h-4 text-xs ${status === 'found' ? 'text-success-text' : status === 'needsLocation' ? 'text-text-subtle' : 'text-danger-text'}`}
            >
                <span className={checking ? 'sr-only' : undefined}>{statusText}</span>
            </p>
            {status === 'missing' && (
                <p className="text-xs text-text-subtle">{t('resources.config.missingHint')}</p>
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
                    {t('common.checkAgain')}
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
