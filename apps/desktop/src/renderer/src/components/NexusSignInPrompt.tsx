import NexusIcon from '../../../../assets/icons/nexusmods.svg?react'
import { useNexusSignIn } from '../hooks/useNexusSignIn'
import { t } from '../i18n'
import { EmptyState } from './ui/EmptyState'
import { Button } from './ui/Button'
import { NexusSignInStatus } from './NexusSignInStatus'

export function NexusSignInPrompt({ sessionExpired }: { sessionExpired: boolean }) {
    const { status, error, signIn } = useNexusSignIn()

    return (
        <div className="flex-1 grid">
            <EmptyState icon={NexusIcon}>
                {sessionExpired && <span>{t('nexus.sessionExpiredHint')}</span>}
                <Button variant="accent" size="md" className="text-text" onClick={signIn}>
                    {t(sessionExpired ? 'nexusSession.signIn' : 'settings.nexusAccount.signIn')}
                </Button>
                {error === null && <NexusSignInStatus status={status} />}
                {error !== null && (
                    <span className="text-xs text-danger-text">
                        {t('settings.nexusAccount.failed', { error })}
                    </span>
                )}
            </EmptyState>
        </div>
    )
}
