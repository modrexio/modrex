import { useEffect, useState } from 'react'
import { error as logError } from '@tauri-apps/plugin-log'
import { Download } from 'lucide-react'
import { api } from '../api'
import { t } from '../i18n'
import { Dialog, DialogHeader } from './Dialog'
import { Button } from './ui/Button'

type Phase = 'confirm' | 'installing' | 'none' | 'failed'

export function InstallNightlyDialog({ onClose }: { onClose: () => void }) {
    const [phase, setPhase] = useState<Phase>('confirm')
    const [percent, setPercent] = useState(0)
    const installing = phase === 'installing'

    useEffect(() => api.onUpdateProgress(setPercent), [])

    async function install() {
        setPercent(0)
        setPhase('installing')
        try {
            // A dev build must not run the installer over a real install.
            const found = !import.meta.env.DEV && (await api.installNightly())
            if (!found) setPhase('none')
        } catch (error) {
            void logError('Nightly install failed: ' + String(error))
            setPhase('failed')
        }
    }

    return (
        <Dialog
            open={true}
            onOpenChange={(open) => !open && !installing && onClose()}
            title={t('settings.updates.installNightlyTitle')}
            className="w-[28rem]"
        >
            <DialogHeader
                title={t('settings.updates.installNightlyTitle')}
                onClose={onClose}
                closeDisabled={installing}
            />
            <div className="flex flex-col gap-3 px-5 py-4 text-sm text-text-muted">
                <p>{t('settings.updates.installNightlyIntro')}</p>
                <p>{t('settings.updates.installNightlyRisk')}</p>
                <p>{t('settings.updates.installNightlyRestart')}</p>
                {phase === 'none' && (
                    <p className="text-xs text-warning">
                        {t('settings.updates.installNightlyNone')}
                    </p>
                )}
                {phase === 'failed' && (
                    <p className="text-xs text-danger-text">
                        {t('settings.updates.installNightlyFailed')}
                    </p>
                )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
                {installing ? (
                    <div className="flex flex-1 items-center gap-3">
                        <span className="text-xs text-text-muted shrink-0">
                            {t('settings.updates.installNightlyProgress')}
                        </span>
                        <div
                            role="progressbar"
                            aria-label={t('settings.updates.installNightlyProgress')}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percent}
                            className="flex-1 h-1 rounded-full overflow-hidden bg-surface-active"
                        >
                            <div
                                className="h-full bg-accent transition-[width] duration-100"
                                style={{ width: `${percent}%` }}
                            />
                        </div>
                        <span className="text-xs text-text-muted tabular-nums shrink-0">
                            {percent}%
                        </span>
                    </div>
                ) : (
                    <>
                        <Button variant="secondary" size="sm" onClick={onClose}>
                            {phase === 'none' ? t('common.close') : t('common.cancel')}
                        </Button>
                        {phase !== 'none' && (
                            <Button variant="accent" size="sm" onClick={install}>
                                <Download className="w-3.5 h-3.5" />
                                {t('settings.updates.installNightlyAction')}
                            </Button>
                        )}
                    </>
                )}
            </div>
        </Dialog>
    )
}
