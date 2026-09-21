import { useEffect, useMemo, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from './ui/Button'
import { api } from '../api'
import { t } from '../i18n'
import type { GameId } from '../../../shared/types'

export function GameFolders({
    activeGame,
    gamePath,
}: {
    activeGame: GameId
    gamePath: string | null
}) {
    const [modFolders, setModFolders] = useState<{ tag: string; labelKey: string }[]>([])

    const folderLabels: Record<string, string> = useMemo(
        () => ({
            mods: t('settings.folders.mods'),
            modkitMods: t('settings.folders.modkitMods'),
            legacyPaks: t('settings.folders.legacyPaks'),
            overrides: t('settings.folders.overrides'),
            ue4ssMods: t('settings.folders.ue4ssMods'),
        }),
        []
    )

    useEffect(() => {
        api.listModFolders(activeGame).then(setModFolders)
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
                    {t('settings.folders.open', {
                        name: folderLabels[f.labelKey] ?? f.labelKey,
                    })}
                </Button>
            ))}
        </>
    )
}
