import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn'

const buttonVariants = cva(
    'inline-flex items-center justify-center gap-1.5 rounded transition-[color,background-color,border-color,scale] enabled:active:scale-press disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none',
    {
        variants: {
            variant: {
                accent: 'bg-accent-fill hover:bg-accent-fill-hover',
                secondary: 'border border-border bg-surface-hover hover:bg-surface-active',
                danger: 'bg-danger hover:bg-danger-hover',
                // For actions sitting inside a warning surface, where the accent fill
                // would put a second, unrelated orange next to the warning tint.
                warning: 'bg-warning/20 hover:bg-warning/30 text-warning',
                ghost: 'text-text-subtle hover:text-text hover:bg-surface-hover',
                'ghost-accent': 'text-accent hover:text-accent-bright hover:bg-surface-hover',
            },
            size: {
                sm: 'text-xs px-3 py-1',
                md: 'text-xs px-3 py-1.5',
                lg: 'text-xs px-4 py-1.5',
                icon: 'p-1',
                'icon-md': 'p-1.5',
            },
        },
        defaultVariants: { variant: 'secondary', size: 'sm' },
    }
)

export { buttonVariants }

export function Button({
    className,
    variant,
    size,
    ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
    return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
