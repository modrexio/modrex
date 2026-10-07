import { useState } from 'react'
import { api, type MovieRecognitionScan } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'
import { SettingsSection } from './SettingsSection'
import { Button } from './ui/Button'
import { ResourceRecognition } from './ResourceRecognition'
import { ResourceRecoveryDialog } from './ResourceRecoveryDialog'

export function MovieResourceSettings({ activeGame }: { activeGame: GameId }) {
    const [scan, setScan] = useState<MovieRecognitionScan | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [recoveryOpen, setRecoveryOpen] = useState(false)
    async function inspect() {
        setBusy(true)
        setError(null)
        try {
            setScan(await api.inspectMovieResources(activeGame))
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }
    return (
        <SettingsSection
            title={t('resources.recognition.movies')}
            description={t('resources.recognition.description')}
        >
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void inspect()}>
                {t('resources.recognition.check')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setRecoveryOpen(true)}>
                {t('resources.recovery.title')}
            </Button>
            {recoveryOpen && (
                <ResourceRecoveryDialog
                    activeGame={activeGame}
                    onClose={() => setRecoveryOpen(false)}
                />
            )}
            {error && (
                <p role="alert" className="text-xs text-danger-text">
                    {error}
                </p>
            )}
            {scan && (
                <div className="flex flex-col gap-2 text-xs">
                    <p className="text-text-subtle">
                        {t('resources.recognition.checked', {
                            time: new Date(scan.checkedAt).toLocaleString(),
                        })}
                    </p>
                    {scan.movies.length === 0 && <p>{t('resources.recognition.empty')}</p>}
                    {scan.movies.map((movie) => (
                        <div
                            key={movie.path}
                            className="border border-border rounded-lg p-3 flex flex-col gap-1"
                        >
                            <span className="font-mono break-all text-text-muted">
                                {movie.path}
                            </span>
                            <ResourceRecognition recognition={movie.recognition} />
                        </div>
                    ))}
                </div>
            )}
        </SettingsSection>
    )
}
