import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConfigFileLocation } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import { displayPath } from '../lib/displayPath'
import { SettingsSection } from './SettingsSection'
import { Button } from './ui/Button'
import { DisclosureSummary } from './ui/DisclosureSummary'

type Messages = Record<
    | 'title'
    | 'description'
    | 'open'
    | 'chooseFile'
    | 'checking'
    | 'found'
    | 'missing'
    | 'needsLocation'
    | 'checkFailed'
    | 'manualTools',
    string
>

export function ConfigFileSettings({
    activeGame,
    getLocation,
    pickFile,
    openFile,
    messages,
    children,
}: {
    activeGame: GameId
    getLocation: (gameId: string) => Promise<ConfigFileLocation>
    pickFile: (gameId: string, title: string, folder: boolean) => Promise<string | null>
    openFile: (gameId: string) => Promise<null>
    messages: Messages
    children?: ReactNode
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
        void checkLocation()
        return () => {
            request.current += 1
        }
    }, [checkLocation])

    async function open(pick: boolean, folder = false) {
        const current = ++request.current
        setBusy(true)
        setError(null)
        try {
            if (pick) {
                const path = await pickFile(
                    activeGame,
                    folder ? t('resources.config.chooseFolder') : messages.chooseFile,
                    folder
                )
                if (!path) return
            }
            if (current !== request.current) return
            setLocation(null)
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

    const choices = (
        <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void open(true)}>
                {messages.chooseFile}
            </Button>
            <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void open(true, true)}
            >
                {t('resources.config.chooseFolder')}
            </Button>
        </div>
    )

    return (
        <SettingsSection title={messages.title} description={messages.description}>
            <div className="text-xs text-text-muted">
                <p role="status">
                    {location
                        ? messages[location.status]
                        : error
                          ? messages.checkFailed
                          : messages.checking}
                </p>
                {location && location.status !== 'needsLocation' && (
                    <p className="mt-1 font-mono break-all">{displayPath(location.path)}</p>
                )}
            </div>
            <div className="flex flex-wrap gap-2">
                {location?.status === 'found' && (
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void open(false)}
                    >
                        {messages.open}
                    </Button>
                )}
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void checkLocation()}
                >
                    {t('resources.config.checkAgain')}
                </Button>
            </div>
            {location?.status !== 'found' && choices}
            {(location?.status === 'found' || children) && (
                <details className="text-xs text-text-muted">
                    <DisclosureSummary className="cursor-pointer">
                        {messages.manualTools}
                    </DisclosureSummary>
                    <div className="mt-3 flex flex-col gap-2">
                        {location?.status === 'found' && choices}
                        {children}
                    </div>
                </details>
            )}
            {error && (
                <p role="alert" className="text-xs text-danger-text">
                    {error}
                </p>
            )}
        </SettingsSection>
    )
}
