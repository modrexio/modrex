import { useState } from 'react'
import { api } from '../api'
import { t } from '../i18n'
import { Button } from './ui/Button'

export function RecoveryFolderButton() {
    const [busy, setBusy] = useState(false)
    const [missing, setMissing] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function open() {
        setBusy(true)
        setMissing(false)
        setError(null)
        try {
            setMissing(!(await api.openResourceRecoveryFolder()))
        } catch (failure) {
            setError(String(failure))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="flex flex-col items-start gap-2 text-xs">
            <Button
                variant="secondary"
                size="sm"
                className="focus-visible:ring-2 focus-visible:ring-accent/60"
                disabled={busy}
                onClick={() => void open()}
            >
                {t('resources.recovery.openFolder')}
            </Button>
            {missing && <p role="status">{t('resources.recovery.noCopies')}</p>}
            {error && (
                <p role="alert" className="text-danger-text">
                    {error}
                </p>
            )}
        </div>
    )
}
