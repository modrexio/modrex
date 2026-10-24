import type { ComponentType, SVGProps } from 'react'

interface Props {
    icon: ComponentType<SVGProps<SVGSVGElement>>
    children: React.ReactNode
}

export function EmptyState({ icon: Icon, children }: Props) {
    return (
        <div className="flex flex-col items-center justify-center gap-3 h-full text-text-subtle text-sm text-center">
            <Icon className="w-10 h-10 text-text-muted" strokeWidth={1.5} />
            {children}
        </div>
    )
}
