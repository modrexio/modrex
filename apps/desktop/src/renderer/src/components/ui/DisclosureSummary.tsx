import { ChevronDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

export function DisclosureSummary({ children, className, ...props }: ComponentProps<'summary'>) {
    return (
        <summary
            className={cn(
                'flex cursor-pointer list-none items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden',
                className
            )}
            {...props}
        >
            {children}
            <ChevronDown
                aria-hidden="true"
                className="w-3 h-3 text-text-subtle shrink-0 transition-transform [details[open]>summary>&]:rotate-180"
            />
        </summary>
    )
}
