import { cn } from '../../lib/cn'

interface Props {
    progress: { downloaded: number; total: number }
    className?: string
}

/** A download's progress line. It pulses when the server sent no size. */
export function ProgressLine({ progress, className }: Props) {
    return (
        <div className={cn('h-0.5 bg-surface-active', className)}>
            {progress.total > 0 ? (
                <div
                    className="h-full bg-accent transition-[width] duration-100"
                    style={{
                        width: `${Math.round((progress.downloaded / progress.total) * 100)}%`,
                    }}
                />
            ) : (
                <div className="h-full bg-accent animate-pulse w-full" />
            )}
        </div>
    )
}
