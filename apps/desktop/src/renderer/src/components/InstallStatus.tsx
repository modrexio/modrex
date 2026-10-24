import { installLabel, installProgress, useModInstall } from '../installState'
import { ProgressLine } from './ui/ProgressLine'

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
    return <ProgressLine progress={progress} className="shrink-0" />
}
