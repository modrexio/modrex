import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { t } from '../i18n'
import { Button } from './ui/Button'

// Height envelopes keep content-variable modals from resizing (and re-centering)
// as their content changes. 'panel' is a fixed height for tabbed modals whose body
// swaps in place; 'list' is a floor+ceiling band for single scrolling lists; 'auto'
// leaves the height content-driven for static confirm dialogs.
const sizeClasses = {
    auto: '',
    list: 'min-h-[20rem] max-h-[75vh]',
    panel: 'h-[34rem] max-h-[80vh]',
} as const

interface Props {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    children: ReactNode
    className?: string
    size?: keyof typeof sizeClasses
    onOpenAutoFocus?: (event: Event) => void
    onPointerDownOutside?: ComponentProps<typeof RadixDialog.Content>['onPointerDownOutside']
}

export function Dialog({
    open,
    onOpenChange,
    title,
    children,
    className,
    size = 'auto',
    onOpenAutoFocus,
    onPointerDownOutside,
}: Props) {
    return (
        <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
                <RadixDialog.Content
                    onOpenAutoFocus={onOpenAutoFocus}
                    onPointerDownOutside={onPointerDownOutside}
                    className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 bg-surface-raised border border-border rounded-xl shadow-xl flex flex-col overflow-hidden focus:outline-none text-text ${sizeClasses[size]} ${className ?? ''}`}
                >
                    <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
                    {children}
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    )
}

interface DialogHeaderProps {
    title: ReactNode
    subtitle?: ReactNode
    icon?: ReactNode
    onClose?: () => void
    // Busy states dim the close control the same way each modal already guarded it.
    closeDisabled?: boolean
    // Forced dialogs (analytics consent) opt out of a close affordance entirely.
    showClose?: boolean
    // Subtitles are truncated by default (single-line mod names); confirm dialogs
    // whose subtitle is a full sentence set this so the text wraps instead of clipping.
    wrapSubtitle?: boolean
}

// Standard modal header: title (optional icon + subtitle) and a top-right close X.
// Every modal renders this instead of hand-rolling its own header row.
export function DialogHeader({
    title,
    subtitle,
    icon,
    onClose,
    closeDisabled = false,
    showClose = true,
    wrapSubtitle = false,
}: DialogHeaderProps) {
    return (
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
            <div className="min-w-0">
                <h2 className="text-sm font-semibold flex items-center gap-2 min-w-0">
                    {icon}
                    <span className="truncate">{title}</span>
                </h2>
                {subtitle && (
                    <p
                        className={`text-xs text-text-muted mt-0.5 ${wrapSubtitle ? '' : 'truncate'}`}
                    >
                        {subtitle}
                    </p>
                )}
            </div>
            {showClose && (
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={closeDisabled ? undefined : onClose}
                    disabled={closeDisabled}
                    aria-label={t('common.close')}
                    className="-mr-1 shrink-0"
                >
                    <X className="w-4 h-4" />
                </Button>
            )}
        </div>
    )
}
