import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Button } from './ui/Button'
import { TITLE_ROW_H } from './pageHeader'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
    active: boolean
    compact?: boolean
    label: ReactNode
    count: ReactNode
    action?: ReactNode
}

export function HeaderTab({
    active,
    compact = false,
    label,
    count,
    action,
    className,
    ...props
}: Props) {
    return (
        <div className={`relative shrink-0 ${TITLE_ROW_H}`}>
            <Button
                variant="ghost"
                {...props}
                className={cn(
                    "relative h-full flex-col items-stretch justify-center gap-0 rounded-none py-0 border-b-2 text-left hover:bg-transparent before:content-[''] before:absolute before:inset-x-1 before:inset-y-0.5 before:rounded before:transition-colors",
                    compact ? 'px-1.5' : 'px-4',
                    active
                        ? 'border-accent text-accent hover:text-accent'
                        : 'border-transparent text-text-subtle hover:text-text-muted hover:before:bg-surface-hover',
                    className
                )}
            >
                <span
                    className={cn(
                        'relative flex items-center gap-1.5 whitespace-nowrap text-sm font-medium leading-tight',
                        action && 'pr-6'
                    )}
                >
                    {label}
                </span>
                <span className="relative flex h-3.5 items-center text-[11px] leading-none text-text-subtle">
                    {count}
                </span>
            </Button>
            {action && <div className="absolute right-1.5 top-0.5">{action}</div>}
        </div>
    )
}
