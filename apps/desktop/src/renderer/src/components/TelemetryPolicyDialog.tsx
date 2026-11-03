import { Dialog } from './Dialog'
import { Button } from './ui/Button'
import { t } from '../i18n'
import { api } from '../api'
import { MODREX_PRIVACY_URL } from '../lib/analytics/constants'

interface Props {
    open: boolean
    onChoice: (accepted: boolean) => void
}

/**
 * Shown once to a user who opted in under an earlier privacy policy. Nothing is sent until
 * they answer, so Escape and overlay clicks do nothing, and nothing is focused on open so
 * Enter cannot accept unread.
 */
export function TelemetryPolicyDialog({ open, onChoice }: Props) {
    return (
        <Dialog
            open={open}
            onOpenChange={() => {}}
            onOpenAutoFocus={(event) => event.preventDefault()}
            title={t('telemetry.policyChangedTitle')}
            className="w-[420px] max-w-[90vw]"
        >
            <div className="p-6 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                    <h2 className="text-lg font-semibold">{t('telemetry.policyChangedTitle')}</h2>
                    <p className="text-sm text-text-muted">{t('telemetry.policyChangedBody')}</p>
                </div>
                <Button
                    variant="ghost-accent"
                    onClick={() => api.openExternal(MODREX_PRIVACY_URL)}
                    className="self-start p-0 text-sm hover:bg-transparent hover:underline"
                >
                    {t('telemetry.policyChangedLink')}
                </Button>
                <div className="flex gap-2 justify-end mt-1">
                    <Button
                        onClick={() => onChoice(false)}
                        className="px-4 py-2 rounded-lg text-sm"
                    >
                        {t('telemetry.policyDecline')}
                    </Button>
                    <Button
                        variant="accent"
                        onClick={() => onChoice(true)}
                        className="px-4 py-2 rounded-lg text-sm font-medium"
                    >
                        {t('telemetry.policyAccept')}
                    </Button>
                </div>
            </div>
        </Dialog>
    )
}
