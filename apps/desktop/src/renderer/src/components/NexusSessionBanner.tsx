import { TriangleAlert } from 'lucide-react'
import { Button } from './ui/Button'
import { useNexusSignIn } from '../hooks/useNexusSignIn'
import { nexusSignInStatusKeys } from './NexusSignInStatus'
import { t } from '../i18n'

// Shown when the backend discards a Nexus session that cannot be refreshed (see
// nexus_oauth.rs's end_session). Nothing in the app can recover it, since re-authorization
// happens in the browser, so this says so plainly instead of leaving every Nexus request
// to fail behind a UI that still reports the user as signed in.
export function NexusSessionBanner({ onDismiss }: { onDismiss: () => void }) {
    const { status, error, signIn } = useNexusSignIn()

    return (
        <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-warning/10 border-b border-warning/30 text-xs text-warning">
            <div className="flex items-center gap-2 min-w-0">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate" aria-live="polite">
                    {error
                        ? t('nexusSession.failed', { error })
                        : status !== 'idle'
                          ? t(nexusSignInStatusKeys[status])
                          : t('nexusSession.expired')}
                </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
                <Button variant="warning" size="sm" onClick={signIn}>
                    {t('nexusSession.signIn')}
                </Button>
                <Button variant="ghost" size="sm" onClick={onDismiss}>
                    {t('common.dismiss')}
                </Button>
            </div>
        </div>
    )
}
