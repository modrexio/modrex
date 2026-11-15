import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactElement } from 'react'

interface Props {
    content: string
    children: ReactElement
    side?: 'top' | 'right' | 'bottom' | 'left'
    disabled?: boolean
}

export function Tooltip({ content, children, side = 'top', disabled = false }: Props) {
    if (disabled) return children
    return (
        <RadixTooltip.Root>
            <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
            <RadixTooltip.Portal>
                <RadixTooltip.Content
                    side={side}
                    sideOffset={4}
                    className="z-50 px-2 py-1 rounded bg-surface-active border border-border text-xs text-text shadow-lg select-none origin-(--radix-tooltip-content-transform-origin) data-[state=delayed-open]:animate-overlay-in"
                >
                    {content}
                </RadixTooltip.Content>
            </RadixTooltip.Portal>
        </RadixTooltip.Root>
    )
}

export const TooltipProvider = RadixTooltip.Provider
