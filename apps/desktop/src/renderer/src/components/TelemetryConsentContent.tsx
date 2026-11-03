import { BarChart3, ShieldCheck } from 'lucide-react'
import { t } from '../i18n'
import { api } from '../api'
import { GOOGLE_PRIVACY_URL } from '../lib/analytics/constants'

/**
 * The "what we collect / what we don't" cards plus the Google privacy link.
 * Shown inside the consent pop-up (first-run, and when reopened from Settings).
 */
export function TelemetryConsentContent() {
    return (
        <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-border bg-surface-hover p-3 flex gap-3">
                <BarChart3 className="w-4 h-4 mt-0.5 shrink-0 text-accent" />
                <div>
                    <p className="text-sm font-medium">{t('telemetry.collectTitle')}</p>
                    <ul className="list-disc pl-4 mt-1.5 text-xs text-text-muted flex flex-col gap-1">
                        <li>{t('telemetry.collect1')}</li>
                        <li>{t('telemetry.collect2')}</li>
                        <li>{t('telemetry.collect3')}</li>
                    </ul>
                </div>
            </div>

            <div className="rounded-lg border border-border bg-surface-hover p-3 flex gap-3">
                <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-success" />
                <div>
                    <p className="text-sm font-medium">{t('telemetry.dontCollectTitle')}</p>
                    <ul className="list-disc pl-4 mt-1.5 text-xs text-text-muted flex flex-col gap-1">
                        <li>{t('telemetry.dontCollect1')}</li>
                        <li>{t('telemetry.dontCollect2')}</li>
                    </ul>
                </div>
            </div>

            <p className="text-xs text-text-subtle">
                {t('telemetry.privacyPrefix')}{' '}
                <button
                    onClick={() => api.openExternal(GOOGLE_PRIVACY_URL)}
                    className="text-accent hover:underline"
                >
                    {t('telemetry.privacyLink')}
                </button>
            </p>
        </div>
    )
}
