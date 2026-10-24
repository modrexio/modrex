import { installLabel, installProgress, useModInstall } from '../installState'

interface Props {
    gameId: string
    source: string
    modId: number
    fileId?: number
}

export function InstallStatusLabel({ gameId, source, modId, fileId }: Props) {
    const operation = useModInstall(gameId, source, modId, fileId)
    return operation ? installLabel(operation) : null
}

export function InstallProgressBar({ gameId, source, modId, fileId }: Props) {
    const operation = useModInstall(gameId, source, modId, fileId)
    const progress = installProgress(operation)
    if (!progress) return null
    return (
        <div className="h-0.5 bg-surface-active shrink-0">
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
