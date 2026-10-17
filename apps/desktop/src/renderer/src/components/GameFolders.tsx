import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from './ui/Button'
import { api, type ModFolderInfo } from '../api'
import { t } from '../i18n'
import { folderLabel } from './folderLabel'
import type { GameId } from '../../../shared/types'

export function GameFolders({
    activeGame,
    gamePath,
}: {
    activeGame: GameId
    gamePath: string | null
}) {
    const [modFolders, setModFolders] = useState<ModFolderInfo[]>([])
    const [loadError, setLoadError] = useState<string | null>(null)

    useEffect(() => {
        api.listModFolders(activeGame).then(setModFolders, (error: unknown) =>
            setLoadError(String(error))
        )
    }, [activeGame])

    if (!gamePath) return null
    return (
        <>
            <Button variant="secondary" size="md" onClick={() => api.openGameFolder(activeGame)}>
                <FolderOpen className="w-3.5 h-3.5" />
                {t('settings.folders.gameFolder')}
            </Button>
            {modFolders.map((f) => (
                <Button
                    key={f.tag}
                    variant="secondary"
                    size="md"
                    onClick={() => api.openModFolder(activeGame, f.tag)}
                >
                    <FolderOpen className="w-3.5 h-3.5" />
                    {t('settings.folders.open', { name: folderLabel(f) })}
                </Button>
            ))}
            {loadError && (
                <p role="alert" className="text-xs text-danger-text">
                    {t('installed.tabs.loadFailed', { error: loadError })}
                </p>
            )}
        </>
    )
}
