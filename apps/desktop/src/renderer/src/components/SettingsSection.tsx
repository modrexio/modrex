import type { ReactNode } from 'react'

export function SettingsSection({
    title,
    icon,
    badge,
    description,
    children,
}: {
    title: string
    icon?: ReactNode
    badge?: ReactNode
    description?: ReactNode
    children: ReactNode
}) {
    return (
        <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                {icon}
                <h2 className="text-sm font-semibold">{title}</h2>
                {badge}
            </div>
            {description && <p className="text-xs text-text-subtle">{description}</p>}
            {children}
        </section>
    )
}
