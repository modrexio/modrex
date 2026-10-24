import type { NexusSignInStatus as SignInStatus } from '../hooks/useNexusSignIn'
import { t } from '../i18n'
import { cn } from '../lib/cn'

export const nexusSignInStatusKeys = {
    awaiting: 'settings.nexusAccount.awaitingBrowser',
    finishing: 'settings.nexusAccount.finishing',
    interrupted: 'settings.nexusAccount.interrupted',
} as const

export function NexusSignInStatus({
    status,
    className,
}: {
    status: SignInStatus
    className?: string
}) {
    if (status === 'idle') return null

    return (
        <span
            className={cn(
                'text-xs',
                status === 'interrupted' ? 'text-warning' : 'text-text-subtle',
                className
            )}
            aria-live="polite"
        >
            {t(nexusSignInStatusKeys[status])}
        </span>
    )
}
