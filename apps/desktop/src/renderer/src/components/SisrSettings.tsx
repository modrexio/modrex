import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { api, type SisrStatus } from '../api'
import { t } from '../i18n'
import { Button } from './ui/Button'
import { Toggle } from './Toggle'
import { SkeletonBar } from './Skeleton'

const SISR_SETUP_URL = 'https://alia5.github.io/SISR/stable/getting-started/installation/'
const SISR_STATUS_POLL_INTERVAL_MS = 3000
let cachedSisrStatus: SisrStatus | null = null

export function SisrSettings({ isActive }: { isActive: boolean }) {
    const [status, setStatus] = useState<SisrStatus | null>(cachedSisrStatus)
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (!isActive || saving) return
        let cancelled = false
        let pollTimer: ReturnType<typeof setTimeout> | null = null

        async function refreshStatus() {
            try {
                const result = await api.getSisrStatus()
                if (cancelled) return
                cachedSisrStatus = result
                setStatus(result)
                setError(null)
            } catch (loadError) {
                if (cancelled) return
                setError(String(loadError))
            }
            pollTimer = setTimeout(refreshStatus, SISR_STATUS_POLL_INTERVAL_MS)
        }

        void refreshStatus()
        return () => {
            cancelled = true
            if (pollTimer !== null) clearTimeout(pollTimer)
        }
    }, [isActive, saving])

    if (status === null) {
        if (error === null) {
            return (
                <section className="flex flex-col gap-2" aria-hidden="true">
                    <h2 className="text-sm font-semibold">{t('settings.sisr.title')}</h2>
                    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border mt-1">
                        <span className="text-sm text-text-muted pr-4">
                            {t('settings.sisr.description')}
                        </span>
                        <SkeletonBar className="h-7 w-24 shrink-0 animate-pulse" />
                    </div>
                </section>
            )
        }
        return (
            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold">{t('settings.sisr.title')}</h2>
                <p className="text-xs text-danger-text">{t('settings.sisr.failed', { error })}</p>
            </section>
        )
    }
    if (!status.supported) return null
    const loadedStatus = status

    async function setAutoLaunch(enabled: boolean) {
        setSaving(true)
        setError(null)
        try {
            await api.setAutoLaunchSisr(enabled)
            const nextStatus = { ...loadedStatus, autoLaunch: enabled }
            cachedSisrStatus = nextStatus
            setStatus(nextStatus)
        } catch (saveError) {
            setError(String(saveError))
        } finally {
            setSaving(false)
        }
    }

    const needsSetup = !status.installed || !status.setupComplete
    const enabledWithoutSetup = status.autoLaunch && needsSetup
    const setupActionKey = status.installed ? 'settings.sisr.finishSetup' : 'settings.sisr.setup'

    return (
        <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">{t('settings.sisr.title')}</h2>
            <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border mt-1">
                <span className="text-sm text-text-muted pr-4">
                    {t('settings.sisr.description')}
                </span>
                {needsSetup && !enabledWithoutSetup ? (
                    <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        onClick={() => api.openExternal(SISR_SETUP_URL)}
                    >
                        {t(setupActionKey)}
                    </Button>
                ) : (
                    <Toggle
                        checked={status.autoLaunch}
                        onChange={setAutoLaunch}
                        disabled={saving}
                        title={t('settings.sisr.title')}
                    />
                )}
            </div>
            {status.autoLaunch && (
                <p className={`text-xs ${status.running ? 'text-success-text' : 'text-warning'}`}>
                    {t(status.running ? 'settings.sisr.running' : 'settings.sisr.notRunning')}
                </p>
            )}
            {enabledWithoutSetup && (
                <div className="flex items-center justify-between gap-3 px-3 py-2 bg-warning/10 border border-warning/30 rounded">
                    <span className="flex items-start gap-2 text-xs text-warning">
                        <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        {t(
                            status.installed
                                ? 'settings.sisr.setupRequired'
                                : 'settings.sisr.notInstalled'
                        )}
                    </span>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => api.openExternal(SISR_SETUP_URL)}
                    >
                        {t(setupActionKey)}
                    </Button>
                </div>
            )}
            {error !== null && (
                <p className="text-xs text-danger-text">{t('settings.sisr.failed', { error })}</p>
            )}
        </section>
    )
}
