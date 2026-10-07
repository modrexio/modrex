import { DisclosureSummary } from './ui/DisclosureSummary'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type EngineIniLocation } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import { SettingsSection } from './SettingsSection'
import { Button } from './ui/Button'
import { displayPath } from '../lib/displayPath'

export function EngineIniSettings({ activeGame }: { activeGame: GameId }) {
    const [location, setLocation] = useState<EngineIniLocation | null>(null)
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const request = useRef(0)

    const checkLocation = useCallback(async () => {
        const current = ++request.current
        setBusy(true)
        setLocation(null)
        setError(null)
        try {
            const result = await api.getEngineIniLocation(activeGame)
            if (current === request.current) setLocation(result)
        } catch (failure) {
            if (current === request.current) setError(String(failure))
        } finally {
            if (current === request.current) setBusy(false)
        }
    }, [activeGame])

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
                const path = await api.pickEngineIni(
                    activeGame,
                    t(folder ? 'resources.config.chooseFolder' : 'resources.config.chooseFile'),
                    folder
                )
                if (!path) return
            }
            if (current !== request.current) return
            setLocation(null)
            const result = await api.getEngineIniLocation(activeGame)
            if (current !== request.current) return
            setLocation(result)
            if (result.status !== 'found') return
            await api.openEngineIni(activeGame)
        } catch (failure) {
            if (current === request.current) setError(String(failure))
        } finally {
            if (current === request.current) setBusy(false)
        }
    }

    const choices = (
        <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void open(true)}>
                {t('resources.config.chooseFile')}
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
        <SettingsSection
            title={t('resources.config.title')}
            description={t('resources.config.description')}
        >
            <div className="text-xs text-text-muted">
                <p role="status">
                    {t(
                        location
                            ? `resources.config.${location.status}`
                            : error
                              ? 'resources.config.checkFailed'
                              : 'resources.config.checking'
                    )}
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
                        {t('resources.config.open')}
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
            <details className="text-xs text-text-muted">
                <DisclosureSummary className="cursor-pointer">
                    {t('resources.config.manualTools')}
                </DisclosureSummary>
                <div className="mt-3 flex flex-col gap-2">
                    {location?.status === 'found' && choices}
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                            void api.openDataFolder().catch((failure) => setError(String(failure)))
                        }}
                    >
                        {t('resources.recovery.openCopies')}
                    </Button>
                </div>
                <p className="mt-2">{t('resources.recovery.copiesLocation')}</p>
            </details>
            {error && (
                <p role="alert" className="text-xs text-danger-text">
                    {error}
                </p>
            )}
        </SettingsSection>
    )
}
